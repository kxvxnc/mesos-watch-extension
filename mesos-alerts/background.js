importScripts('util.js');

const getState = () => chrome.storage.local.get({
  watch: [], settings: MWA_DEFAULTS, latest: null, alerted: {}, inbox: [], errors: []
});
const settingsOf = s => ({ ...MWA_DEFAULTS, ...(s || {}) });

// Everything that reads, changes and writes the stored state runs one at a time, so a check finishing while you
// dismiss an alert can't write back an older copy over it.
let queue = Promise.resolve();
const serial = fn => (queue = queue.then(fn, fn));

/* ---------- error log (settings page) ---------- */
// Newest first. The same error again (same source, item, message and code, among the last few) bumps its count and
// moves to the top instead of adding a row, so a failure every minute stays one line.
const ERRORS_CAP = 100;
function addError(list, e) {
  const now = Date.now();
  const entry = { source: e.source, item: e.item || null, itemId: e.itemId || null, message: e.message || 'Unknown error',
    code: e.code || null, userMessage: e.userMessage || null, name: e.name || null };
  const same = list.slice(0, 10).findIndex(x => x.source === entry.source && x.itemId === entry.itemId && x.message === entry.message && x.code === entry.code);
  if (same >= 0) {
    const x = list[same];
    return [{ ...x, count: (x.count || 1) + 1, lastAt: now }, ...list.filter((_, i) => i !== same)];
  }
  return [{ at: now, lastAt: now, count: 1, ...entry }, ...list].slice(0, ERRORS_CAP);
}
const logErrors = entries => serial(async () => {
  let { errors } = await getState();
  for (const e of entries) errors = addError(errors, e);
  await chrome.storage.local.set({ errors });
});

/* ---------- one checking tab at a time ---------- */
// The first tab to ask becomes the leader; another tab takes over only if the leader stops checking.
async function claim(tabId, force) {
  const { leader } = await chrome.storage.session.get('leader');
  const { settings } = await getState();
  const ivl = settingsOf(settings).intervalSec * 1000;
  const now = Date.now();
  if (force || !leader || leader.tabId === tabId || now - leader.at > ivl * 1.5) {
    await chrome.storage.session.set({ leader: { tabId, at: now } });
    return true;
  }
  return false;
}
chrome.tabs.onRemoved.addListener(async tabId => {
  const { leader } = await chrome.storage.session.get('leader');
  if (leader && leader.tabId === tabId) await chrome.storage.session.remove('leader');
});

/* ---------- results ---------- */
// a listing missing from a scan or two and back again isn't new: remember the ones seen for this long
const SEEN_KEEP_MS = 6 * 3600 * 1000;

// data: the summary per item; hits: the listings at or under the max per item (missing = none, null = that check failed);
// checked: each item the tab checked, with its alertCfg then (null: a tab from before this was sent, taken as current)
async function onResult(data, hits, checked) {
  const st = await getState();
  const settings = settingsOf(st.settings);
  const now = Date.now();
  const items = {};
  const alerts = [];
  const names = {};

  for (const w of st.watch) {
    const x = data[w.id] || null;
    if (x && x.name && x.name !== w.name) names[w.id] = x.name;
    const name = (x && x.name) || w.name || `Item ${w.id}`;
    const max = alertMax(w.target, x && x.typical, settings.dealPct);
    const prevItem = st.latest && st.latest.items && st.latest.items[w.id];
    const cfg = alertCfg(w, settings.dealPct);
    // This check ran before the item was added, or before its target, filter or the deal % changed, or it was resumed:
    // what it read can't say which listings were already up. Keep what's known (or "waiting for the first check")
    // until a check made with the current settings comes in.
    if (checked && checked[w.id] !== cfg) {
      if (prevItem) items[w.id] = { ...prevItem, name, paused: !!w.paused };
      continue;
    }

    let rows = hits[w.id];
    let hitsError = null, hitsAt = now;
    if (w.paused) {
      // paused: no listings, no alerts; forget what was seen, so resuming notes what's up then, silently
      rows = [];
      hitsAt = null;
      delete st.alerted[w.id];
    } else if (rows === null || (rows && !Array.isArray(rows))) {
      // this item's listings couldn't be read this time: keep the last ones and say so; no new alerts
      hitsError = (rows && rows.error) || 'Could not read the listings';
      st.errors = addError(st.errors, { source: 'listings', item: name, itemId: w.id, ...((rows && rows.detail) || { message: hitsError }) });
      hitsAt = prevItem ? prevItem.hitsAt || null : null;
      rows = ((prevItem && prevItem.hits) || []).filter(r => r.unit <= max && statsOk(r.stats, w.minStats));
    } else {
      rows = (rows || []).filter(r => r.unit <= max);
      // Alert only on listings that show up after the item was added or its target, stat filter or the deal % last
      // changed: the first check after that just notes what's already up, silently.
      // An offer is a shop + price; it alerts when it first shows up, and again when that shop lists a newer stack at
      // that price (a restock). seen[offer] = {t: last seen, listed: its newest stack's listed time}.
      const prev = st.alerted[w.id];
      const base = prev && prev.cfg === cfg && prev.seen ? prev : null;
      const seen = base ? { ...base.seen } : {};
      for (const r of rows) {
        const k = listingKey(r);
        const s = seen[k];
        const before = s && typeof s === 'object' ? s.listed || 0 : null; // null: noted before listed times were kept
        const restock = before !== null && r.listed && r.listed > before;
        if (base && (!s || restock)) alerts.push({ id: w.id, name, r, target: w.target, typical: x && x.typical });
        seen[k] = { t: now, listed: Math.max(before || 0, r.listed || 0) };
      }
      for (const k in seen) if (now - (typeof seen[k] === 'object' ? seen[k].t : seen[k]) > SEEN_KEEP_MS) delete seen[k];
      st.alerted[w.id] = { cfg, seen };
    }
    items[w.id] = x
      ? { ...x, name, paused: !!w.paused, under: rows.length > 0, hits: rows.slice(0, 200), hitCount: rows.length, hitsError, hitsAt }
      : { name, paused: !!w.paused, cheapest: null, listings: 0, under: false, hits: [], hitCount: 0, hitsError, hitsAt };

  }
  for (const id in st.alerted) if (!st.watch.some(w => String(w.id) === id)) delete st.alerted[id]; // removed items

  // new alerts go on top of the inbox; the same offer alerting again replaces its old entry
  if (alerts.length) {
    const fresh = alerts.map(a => ({
      key: `${a.id}|${listingKey(a.r)}`, at: now, id: a.id, name: a.name,
      unit: a.r.unit, price: a.r.price, per: a.r.per, stacks: a.r.stacks || 1,
      ch: a.r.ch, r: a.r.r, owner: a.r.owner, title: a.r.title || null, listed: a.r.listed, stats: a.r.stats || null, why: alertWhy(a, settings.dealPct),
      tag: a.target > 0 && a.r.unit <= a.target ? `≤ ${fmtMesos(a.target)}` : `${settings.dealPct}% under typical`
    }));
    const keys = new Set(fresh.map(e => e.key));
    st.inbox = fresh.concat(st.inbox.filter(e => !keys.has(e.key))).slice(0, MWA_INBOX_CAP);
  }

  const save = { latest: { at: now, items, error: null }, alerted: st.alerted, inbox: st.inbox, errors: st.errors };
  // only the names change here: anything else in the watchlist (a target typed meanwhile) is left as it is
  if (Object.keys(names).length) save.watch = st.watch.map(w => (names[w.id] ? { ...w, name: names[w.id] } : w));
  await chrome.storage.local.set(save);

  if (settings.notify) notify(alerts, settings.dealPct);
  if (alerts.length && settings.discordOn && isWebhookUrl(settings.webhook)) {
    postWebhook(settings.webhook, alerts.map(a => webhookEmbed(a, settings.dealPct))).catch(() => {});
  }
}

async function onError(error) {
  const { latest, errors } = await getState();
  const message = (error && (error.userMessage || error.message)) || 'Unknown error';
  await chrome.storage.local.set({
    latest: { ...(latest || { items: {} }), error: { message, at: Date.now() } },
    errors: addError(errors, { source: 'check', ...(error || {}), message: (error && error.message) || message })
  });
}

const dismiss = async (key, at) => {
  const { inbox } = await getState();
  await chrome.storage.local.set({ inbox: inbox.filter(e => !(e.key === key && e.at === at)) });
};
const clearInbox = () => chrome.storage.local.set({ inbox: [] });

/* ---------- badge: new alerts, or why it isn't checking ---------- */
async function setBadge(text, color, title) {
  await chrome.action.setBadgeText({ text });
  if (color) await chrome.action.setBadgeBackgroundColor({ color });
  if (title) await chrome.action.setTitle({ title });
}
async function updateBadge() {
  const { watch, settings, latest, inbox } = await getState();
  if (settingsOf(settings).paused) return setBadge('||', '#6b7280', 'Mesos Watch Alerts: all alerts paused');
  if (latest && latest.error && (!latest.at || latest.error.at >= latest.at)) {
    return setBadge('!', '#d97706', 'Mesos Watch Alerts: ' + latest.error.message);
  }
  const limit = Math.max(3 * 60000, 3 * settingsOf(settings).intervalSec * 1000);
  if (watch.length && (!latest || !latest.at || Date.now() - latest.at > limit)) {
    const tabs = await chrome.tabs.query({ url: 'https://mesos.watch/*' });
    return setBadge('off', '#6b7280', tabs.length ? 'Mesos Watch Alerts: tab open but not checking (reload it?)' : 'Mesos Watch Alerts: open mesos.watch to start checking');
  }
  const failing = Object.values((latest && latest.items) || {}).filter(x => x.hitsError);
  if (failing.length) return setBadge('!', '#d97706', `Mesos Watch Alerts: couldn't read the listings for ${failing.map(x => x.name).join(', ')} (${failing[0].hitsError})`);
  if (inbox.length) return setBadge(inbox.length > 99 ? '99+' : String(inbox.length), '#1f9d55', `${inbox.length} new alert${inbox.length > 1 ? 's' : ''}`);
  return setBadge('', null, watch.length ? 'Mesos Watch Alerts: watching' : 'Mesos Watch Alerts');
}
chrome.storage.onChanged.addListener((c, area) => {
  if (area !== 'local') return;
  if (c.inbox || c.watch || c.latest || c.settings) updateBadge();
  // all alerts paused or resumed: forget what was seen, so the first check after resuming notes what's up, silently
  // (on resume too: a check already running when you paused may have saved it again)
  if (c.settings && !!(c.settings.oldValue || {}).paused !== !!(c.settings.newValue || {}).paused) {
    serial(() => chrome.storage.local.set({ alerted: {} }));
  }
});
chrome.alarms.create('stale', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'stale') updateBadge(); });

/* ---------- notifications ---------- */
// why an offer alerted, in words
function alertWhy(a, dealPct) {
  return a.target > 0 && a.r.unit <= a.target
    ? `Under your target of ${fmtMesos(a.target)}`
    : `${dealPct}%+ under typical (${fmtMesos(a.typical)})`;
}

// one notification per new listing, up to 3; past that, one more that sums up the rest
// (not a 'list' notification: macOS shows only its first line)
let noteSeq = 0;
function notify(alerts, dealPct) {
  if (!alerts.length) return;
  const each = r => fmtMesos(r.unit) + (r.per > 1 ? ' each' : '');
  const place = r => `Ch ${r.ch} · Room ${r.r}${r.owner ? ' · ' + r.owner : ''}${r.title ? ` · “${r.title}”` : ''}`;
  const create = opts => chrome.notifications.create(`mwa:${Date.now()}:${++noteSeq}`, { type: 'basic', iconUrl: 'icons/128.png', priority: 2, ...opts });

  for (const a of alerts.slice(0, 3)) {
    const bundle = (a.r.per > 1 ? `${a.r.per} for ${fmtMesos(a.r.price)} · ` : '') + (a.r.stacks > 1 ? `${a.r.stacks} stacks · ` : '');
    const when = a.r.listed ? ` · listed ${agoS(a.r.listed)}` : '';
    const st = statsText(a.r.stats);
    create({ title: `${a.name}: ${each(a.r)}`, message: `${st ? st + '\n' : ''}${bundle}${place(a.r)}\n${alertWhy(a, dealPct)}${when}` });
  }
  const rest = alerts.slice(3);
  if (rest.length) {
    create({
      title: `${rest.length} more listing${rest.length > 1 ? 's' : ''} under your targets`,
      message: rest.slice(0, 4).map(a => `${a.name} ${each(a.r)} · Ch ${a.r.ch}`).join('\n') + (rest.length > 4 ? '\nOpen the extension for the rest.' : '')
    });
  }
}

/* ---------- Discord webhook (optional) ---------- */
// one card per alert; its title links to the item on mesos.watch (the site opens #item=<id> links)
function webhookEmbed(a, dealPct) {
  const r = a.r;
  const bundle = (r.per > 1 ? `${r.per} for ${fmtMesos(r.price)} · ` : '') + (r.stacks > 1 ? `${r.stacks} stacks · ` : '');
  const st = statsText(r.stats);
  // the shop's title is typed by its owner: escape Discord markdown so it shows as written
  const shop = r.title ? ` · “${String(r.title).replace(/[\\*_~`|>]/g, '\\$&')}”` : '';
  return {
    title: `${a.name}: ${fmtMesos(r.unit)}${r.per > 1 ? ' each' : ''}`,
    url: `${MWA_SITE}#item=${a.id}`,
    description: `${st ? st + '\n' : ''}${bundle}**Ch ${r.ch} · Room ${r.r}**${r.owner ? ' · ' + r.owner : ''}${shop}\n${alertWhy(a, dealPct)}`,
    color: 0x2fbf71,
    timestamp: new Date(r.listed ? r.listed * 1000 : Date.now()).toISOString(),
    footer: { text: r.listed ? 'Listed' : 'Seen' }
  };
}

// Discord takes up to 10 cards a message, and about 5 messages per 2 seconds per webhook: send in tens, a short
// pause between, and wait once if Discord says to slow down. The outcome is kept for the settings page.
async function postWebhook(url, embeds, content) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let error = null;
  try {
    for (let i = 0; i < Math.max(1, embeds.length) && i < 50; i += 10) {
      const body = JSON.stringify({ username: 'Mesos Watch Alerts', content: i === 0 ? content : undefined, embeds: embeds.slice(i, i + 10) });
      const send = () => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      let res = await send();
      if (res.status === 429) {
        const j = await res.json().catch(() => ({}));
        await sleep(Math.min(10, Number(j.retry_after) || 2) * 1000);
        res = await send();
      }
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(`Discord answered ${res.status}${j.message ? ': ' + j.message : ''}`);
      }
      if (i + 10 < embeds.length) await sleep(500);
    }
    if (embeds.length > 50) await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'Mesos Watch Alerts', content: `…and ${embeds.length - 50} more. Open the extension for the rest.` }) });
  } catch (err) {
    error = String((err && err.message) || err);
    if (/Failed to fetch/i.test(error)) error = 'Could not reach Discord (no permission, or offline)';
  }
  await chrome.storage.local.set({ webhookStatus: { at: Date.now(), ok: !error, error } });
  if (error) logErrors([{ source: 'discord', message: error }]);
  return { ok: !error, error };
}

const testWebhook = url => postWebhook(url, [{
  title: 'Test alert: Red Potion: 140',
  url: MWA_SITE,
  description: '**Ch 18 · Room 9** · SomeSeller · “Cheap pots!”\nThis is a test from Mesos Watch Alerts. Real alerts look like this.',
  color: 0x2fbf71,
  timestamp: new Date().toISOString()
}]);

async function focusSite() {
  const tabs = await chrome.tabs.query({ url: 'https://mesos.watch/*' });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: MWA_SITE });
  }
}
chrome.notifications.onClicked.addListener(id => { chrome.notifications.clear(id); focusSite(); });

/* ---------- messages ---------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const reply = p => { p.then(r => sendResponse(r === undefined ? true : r), () => sendResponse(false)); return true; };
  if (msg.type === 'claim') return reply(claim(sender.tab ? sender.tab.id : -1, !!msg.force));
  if (msg.type === 'result') return reply(serial(() => onResult(msg.data, msg.hits || {}, msg.checked || null)));
  if (msg.type === 'error') return reply(serial(() => onError(msg.error)));
  if (msg.type === 'dismiss') return reply(serial(() => dismiss(msg.key, msg.at)));
  if (msg.type === 'clearInbox') return reply(serial(clearInbox));
  if (msg.type === 'focusSite') return reply(focusSite());
  if (msg.type === 'logError') return reply(logErrors([msg.entry || {}]));
  if (msg.type === 'clearErrors') return reply(serial(() => chrome.storage.local.set({ errors: [] })));
  if (msg.type === 'testWebhook') return reply(isWebhookUrl(msg.url) ? testWebhook(msg.url.trim()) : Promise.resolve({ ok: false, error: 'Not a Discord webhook URL' }));
  return false;
});

updateBadge();
chrome.storage.local.remove('history'); // the price log this extension used to keep (up to ~2 MB)

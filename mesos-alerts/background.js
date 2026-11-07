importScripts('util.js');

const getState = () => chrome.storage.local.get({
  watch: [], settings: MWA_DEFAULTS, latest: null, alerted: {}, history: [], inbox: []
});
const settingsOf = s => ({ ...MWA_DEFAULTS, ...(s || {}) });

// Everything that reads, changes and writes the stored state runs one at a time, so a check finishing while you
// dismiss an alert can't write back an older copy over it.
let queue = Promise.resolve();
const serial = fn => (queue = queue.then(fn, fn));

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

// data: the summary per item; hits: the listings at or under the max per item (missing = none, null = that check failed)
async function onResult(data, hits) {
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

    let rows = hits[w.id];
    let hitsError = null, hitsAt = now;
    if (rows === null || (rows && !Array.isArray(rows))) {
      // this item's listings couldn't be read this time: keep the last ones and say so; no new alerts
      hitsError = (rows && rows.error) || 'Could not read the listings';
      hitsAt = prevItem ? prevItem.hitsAt || null : null;
      rows = ((prevItem && prevItem.hits) || []).filter(r => r.unit <= max);
    } else {
      rows = (rows || []).filter(r => r.unit <= max);
      // Alert only on listings that show up after the item was added or its target (or the deal %) last changed:
      // the first check after that just notes what's already up, silently.
      // An offer is a shop + price; it alerts when it first shows up, and again when that shop lists a newer stack at
      // that price (a restock). seen[offer] = {t: last seen, listed: its newest stack's listed time}.
      const cfg = `${w.target}|${settings.dealPct}`;
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
      ? { ...x, name, under: rows.length > 0, hits: rows.slice(0, 200), hitCount: rows.length, hitsError, hitsAt }
      : { name, cheapest: null, listings: 0, under: false, hits: [], hitCount: 0, hitsError, hitsAt };

    // history: one row whenever an item's cheapest price changes
    const prevCheapest = prevItem ? prevItem.cheapest : undefined;
    const cheapest = x ? x.cheapest : null;
    if (prevCheapest === undefined || prevCheapest !== cheapest) {
      st.history.push([
        now, w.id, name, cheapest ?? '', x && x.typical != null ? x.typical : '', x ? x.listings ?? 0 : 0,
        x && x.where ? x.where.ch : '', x && x.where ? x.where.r : '', x && x.where ? x.where.owner : ''
      ]);
    }
  }
  for (const id in st.alerted) if (!st.watch.some(w => String(w.id) === id)) delete st.alerted[id]; // removed items
  if (st.history.length > MWA_HISTORY_CAP) st.history.splice(0, st.history.length - MWA_HISTORY_CAP);

  // new alerts go on top of the inbox; the same offer alerting again replaces its old entry
  if (alerts.length) {
    const fresh = alerts.map(a => ({
      key: `${a.id}|${listingKey(a.r)}`, at: now, id: a.id, name: a.name,
      unit: a.r.unit, price: a.r.price, per: a.r.per, stacks: a.r.stacks || 1,
      ch: a.r.ch, r: a.r.r, owner: a.r.owner, listed: a.r.listed, why: alertWhy(a, settings.dealPct),
      tag: a.target > 0 && a.r.unit <= a.target ? `≤ ${fmtMesos(a.target)}` : `${settings.dealPct}% under typical`
    }));
    const keys = new Set(fresh.map(e => e.key));
    st.inbox = fresh.concat(st.inbox.filter(e => !keys.has(e.key))).slice(0, MWA_INBOX_CAP);
  }

  const save = { latest: { at: now, items, error: null }, alerted: st.alerted, history: st.history, inbox: st.inbox };
  // only the names change here: anything else in the watchlist (a target typed meanwhile) is left as it is
  if (Object.keys(names).length) save.watch = st.watch.map(w => (names[w.id] ? { ...w, name: names[w.id] } : w));
  await chrome.storage.local.set(save);

  if (settings.notify) notify(alerts, settings.dealPct);
}

async function onError(error) {
  const { latest } = await getState();
  const message = (error && (error.userMessage || error.message)) || 'Unknown error';
  await chrome.storage.local.set({ latest: { ...(latest || { items: {} }), error: { message, at: Date.now() } } });
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
  if (area === 'local' && (c.inbox || c.watch || c.latest || c.settings)) updateBadge();
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
  const place = r => `Ch ${r.ch} · Room ${r.r}${r.owner ? ' · ' + r.owner : ''}`;
  const create = opts => chrome.notifications.create(`mwa:${Date.now()}:${++noteSeq}`, { type: 'basic', iconUrl: 'icons/128.png', priority: 2, ...opts });

  for (const a of alerts.slice(0, 3)) {
    const bundle = (a.r.per > 1 ? `${a.r.per} for ${fmtMesos(a.r.price)} · ` : '') + (a.r.stacks > 1 ? `${a.r.stacks} stacks · ` : '');
    const when = a.r.listed ? ` · listed ${agoS(a.r.listed)}` : '';
    create({ title: `${a.name}: ${each(a.r)}`, message: `${bundle}${place(a.r)}\n${alertWhy(a, dealPct)}${when}` });
  }
  const rest = alerts.slice(3);
  if (rest.length) {
    create({
      title: `${rest.length} more listing${rest.length > 1 ? 's' : ''} under your targets`,
      message: rest.slice(0, 4).map(a => `${a.name} ${each(a.r)} · Ch ${a.r.ch}`).join('\n') + (rest.length > 4 ? '\nOpen the extension for the rest.' : '')
    });
  }
}

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
  if (msg.type === 'result') return reply(serial(() => onResult(msg.data, msg.hits || {})));
  if (msg.type === 'error') return reply(serial(() => onError(msg.error)));
  if (msg.type === 'dismiss') return reply(serial(() => dismiss(msg.key, msg.at)));
  if (msg.type === 'clearInbox') return reply(serial(clearInbox));
  if (msg.type === 'focusSite') return reply(focusSite());
  return false;
});

updateBadge();

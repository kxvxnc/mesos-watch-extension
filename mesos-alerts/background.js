importScripts('util.js');

const getState = () => chrome.storage.local.get({
  watch: [], settings: MWA_DEFAULTS, latest: null, alerted: {}, history: []
});
const settingsOf = s => ({ ...MWA_DEFAULTS, ...(s || {}) });

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
// one offer: the same shop, price and bundle size (its stacks are folded into one row)
const listingKey = r => `${r.store}|${r.price}|${r.per}`;
// a listing missing from a scan or two and back again isn't new: remember the ones seen for this long
const SEEN_KEEP_MS = 6 * 3600 * 1000;

// data: the summary per item; hits: the listings at or under the max per item (missing = none, null = that check failed)
async function onResult(data, hits) {
  const st = await getState();
  const settings = settingsOf(st.settings);
  const now = Date.now();
  const items = {};
  const alerts = [];
  let underItems = 0, watchChanged = false;

  for (const w of st.watch) {
    const x = data[w.id] || null;
    if (x && x.name && x.name !== w.name) { w.name = x.name; watchChanged = true; }
    const name = w.name || `Item ${w.id}`;
    const max = alertMax(w.target, x && x.typical, settings.dealPct);
    const prevItem = st.latest && st.latest.items && st.latest.items[w.id];

    let rows = hits[w.id];
    if (rows === null) {
      // this item's listings couldn't be read this time: keep the last ones, no new alerts
      rows = ((prevItem && prevItem.hits) || []).filter(r => r.unit <= max);
    } else {
      rows = (rows || []).filter(r => r.unit <= max);
      // Alert only on listings that show up after the item was added or its target (or the deal %) last changed:
      // the first check after that just notes what's already up, silently.
      const cfg = `${w.target}|${settings.dealPct}`;
      const prev = st.alerted[w.id];
      const base = prev && prev.cfg === cfg && prev.seen ? prev : null;
      const seen = base ? { ...base.seen } : {};
      for (const r of rows) {
        const k = listingKey(r);
        if (base && !seen[k]) alerts.push({ id: w.id, name, r, target: w.target, typical: x && x.typical });
        seen[k] = now;
      }
      for (const k in seen) if (now - seen[k] > SEEN_KEEP_MS) delete seen[k];
      st.alerted[w.id] = { cfg, seen };
    }
    const under = rows.length > 0;
    if (under) underItems++;
    items[w.id] = x
      ? { ...x, name, under, hits: rows.slice(0, 50), hitCount: rows.length }
      : { name, cheapest: null, listings: 0, under: false, hits: [], hitCount: 0 };

    // history: one row whenever an item's cheapest price changes
    const prevCheapest = st.latest && st.latest.items && st.latest.items[w.id] ? st.latest.items[w.id].cheapest : undefined;
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

  const save = { latest: { at: now, items, error: null }, alerted: st.alerted, history: st.history };
  if (watchChanged) save.watch = st.watch;
  await chrome.storage.local.set(save);

  await setBadge(underItems ? String(underItems) : '', '#1f9d55', underItems ? `${underItems} item${underItems > 1 ? 's' : ''} at or under target` : 'Mesos Watch Alerts: checking');
  if (settings.notify) notify(alerts, settings.dealPct);
}

async function onError(error) {
  const { latest } = await getState();
  const message = (error && (error.userMessage || error.message)) || 'Unknown error';
  await chrome.storage.local.set({ latest: { ...(latest || { items: {} }), error: { message, at: Date.now() } } });
  await setBadge('!', '#d97706', 'Mesos Watch Alerts: ' + message);
}

async function setBadge(text, color, title) {
  await chrome.action.setBadgeText({ text });
  if (color) await chrome.action.setBadgeBackgroundColor({ color });
  if (title) await chrome.action.setTitle({ title });
}

/* ---------- notifications ---------- */
// one notification per new listing, up to 3; past that, one more that sums up the rest
// (not a 'list' notification: macOS shows only its first line)
let noteSeq = 0;
function notify(alerts, dealPct) {
  if (!alerts.length) return;
  const each = r => fmtMesos(r.unit) + (r.per > 1 ? ' each' : '');
  const place = r => `Ch ${r.ch} · Room ${r.r}${r.owner ? ' · ' + r.owner : ''}`;
  const create = opts => chrome.notifications.create(`mwa:${Date.now()}:${++noteSeq}`, { type: 'basic', iconUrl: 'icons/128.png', priority: 2, ...opts });

  for (const a of alerts.slice(0, 3)) {
    const why = a.target > 0 && a.r.unit <= a.target
      ? `Under your target of ${fmtMesos(a.target)}`
      : `${dealPct}%+ under typical (${fmtMesos(a.typical)})`;
    const bundle = (a.r.per > 1 ? `${a.r.per} for ${fmtMesos(a.r.price)} · ` : '') + (a.r.stacks > 1 ? `${a.r.stacks} stacks · ` : '');
    const when = a.r.listed ? ` · listed ${agoS(a.r.listed)}` : '';
    create({ title: `${a.name}: ${each(a.r)}`, message: `${bundle}${place(a.r)}\n${why}${when}` });
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

/* ---------- staleness: no tab checking any more ---------- */
chrome.alarms.create('stale', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async a => {
  if (a.name !== 'stale') return;
  const { watch, settings, latest } = await getState();
  if (!watch.length) return setBadge('', null, 'Mesos Watch Alerts');
  const limit = Math.max(3 * 60000, 3 * settingsOf(settings).intervalSec * 1000);
  if (!latest || Date.now() - latest.at > limit) {
    const tabs = await chrome.tabs.query({ url: 'https://mesos.watch/*' });
    await setBadge('off', '#6b7280', tabs.length ? 'Mesos Watch Alerts: tab open but not checking (reload it?)' : 'Mesos Watch Alerts: open mesos.watch to start checking');
  }
});

/* ---------- messages ---------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'claim') { claim(sender.tab ? sender.tab.id : -1, !!msg.force).then(sendResponse); return true; }
  if (msg.type === 'result') { onResult(msg.data, msg.hits || {}).then(() => sendResponse(true)); return true; }
  if (msg.type === 'error') { onError(msg.error).then(() => sendResponse(true)); return true; }
  if (msg.type === 'focusSite') { focusSite().then(() => sendResponse(true)); return true; }
  return false;
});

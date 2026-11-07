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
async function onResult(data) {
  const st = await getState();
  const settings = settingsOf(st.settings);
  const now = Date.now();
  const items = {};
  const alerts = [];
  let hits = 0, watchChanged = false;

  for (const w of st.watch) {
    const x = data[w.id] || null;
    if (x && x.name && x.name !== w.name) { w.name = x.name; watchChanged = true; }
    const name = w.name || `Item ${w.id}`;
    const under = isUnder(x, w.target, settings.dealPct);
    items[w.id] = x ? { ...x, name, under } : { name, cheapest: null, listings: 0, under: false };

    if (under) {
      hits++;
      const store = x.where ? x.where.store : null;
      const prev = st.alerted[w.id];
      // alert on a new deal, a lower price, or a different shop at the same price or less
      if (!prev || x.cheapest < prev.price || (store !== prev.store && x.cheapest <= prev.price)) {
        alerts.push({ id: w.id, name, x, target: w.target });
      }
      st.alerted[w.id] = { price: x.cheapest, store };
    } else {
      delete st.alerted[w.id];
    }

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
  if (st.history.length > MWA_HISTORY_CAP) st.history.splice(0, st.history.length - MWA_HISTORY_CAP);

  const save = { latest: { at: now, items, error: null }, alerted: st.alerted, history: st.history };
  if (watchChanged) save.watch = st.watch;
  await chrome.storage.local.set(save);

  await setBadge(hits ? String(hits) : '', '#1f9d55', hits ? `${hits} item${hits > 1 ? 's' : ''} at or under target` : 'Mesos Watch Alerts: checking');
  if (settings.notify) notify(alerts);
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
function notify(alerts) {
  if (!alerts.length) return;
  const line = a => {
    const w = a.x.where;
    return `${fmtMesos(a.x.cheapest)}${w ? ` · ch ${w.ch}, room ${w.r}${w.owner ? ` (${w.owner})` : ''}` : ''}`;
  };
  if (alerts.length <= 3) {
    for (const a of alerts) {
      const why = a.target > 0 && a.x.cheapest <= a.target ? `target ${fmtMesos(a.target)}` : `typical ${fmtMesos(a.x.typical)}`;
      chrome.notifications.create(`mwa:${a.id}:${Date.now()}`, {
        type: 'basic', iconUrl: 'icons/128.png', priority: 2,
        title: `${a.name}: ${fmtMesos(a.x.cheapest)}`,
        message: `${line(a)}\n${why}`
      });
    }
  } else {
    chrome.notifications.create(`mwa:many:${Date.now()}`, {
      type: 'list', iconUrl: 'icons/128.png', priority: 2,
      title: `${alerts.length} items hit your targets`, message: '',
      items: alerts.slice(0, 8).map(a => ({ title: a.name, message: line(a) }))
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
  if (msg.type === 'result') { onResult(msg.data).then(() => sendResponse(true)); return true; }
  if (msg.type === 'error') { onError(msg.error).then(() => sendResponse(true)); return true; }
  if (msg.type === 'focusSite') { focusSite().then(() => sendResponse(true)); return true; }
  return false;
});

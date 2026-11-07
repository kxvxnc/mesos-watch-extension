// The popup: new alerts, newest first, each dismissable, and a way into the settings page.
let state = { watch: [], settings: { ...MWA_DEFAULTS }, latest: null, inbox: [] };

async function load() {
  const s = await chrome.storage.local.get({ watch: [], settings: MWA_DEFAULTS, latest: null, inbox: [] });
  state = { ...s, settings: { ...MWA_DEFAULTS, ...s.settings } };
}

// the offer is no longer up: a check since the alert didn't find it among the item's offers under target
function isGone(a) {
  const L = state.latest;
  const x = L && L.items && L.items[a.id];
  if (!x || !L.at || L.at <= a.at || !x.hits || x.hitCount > x.hits.length) return false;
  const k = a.key.slice(String(a.id).length + 1);
  return !x.hits.some(r => listingKey(r) === k);
}

function renderInbox() {
  const list = $('alerts');
  list.textContent = '';
  const n = state.inbox.length;
  $('count').textContent = n ? `${n} new alert${n > 1 ? 's' : ''}` : 'New alerts';
  $('clearAll').hidden = !n;
  $('empty').hidden = n > 0;
  const w = state.watch.length;
  $('emptyText').textContent = w
    ? `Nothing new. Watching ${w} item${w > 1 ? 's' : ''}: new listings at or under your targets show up here.`
    : 'No items watched yet. Add some and set a target price to get alerts.';
  $('setup').textContent = w ? 'Edit alerts' : 'Set up alerts';

  for (const a of state.inbox) {
    const gone = isGone(a);
    const li = el('li', 'alert' + (gone ? ' gone' : ''));
    li.title = `${a.why}. Click to open the mesos.watch tab.`;
    const price = el('span', 'price', priceOf(a));
    price.title = priceTitle(a);
    const x = el('button', 'icon x', '×');
    x.title = 'Dismiss';
    x.addEventListener('click', e => { e.stopPropagation(); dismiss(a); });
    const listed = a.listed ? ` · listed ${agoS(a.listed)}` : '';
    li.append(
      el('span', 'name', a.name),
      price,
      x,
      el('span', 'where', placeOf(a)),
      el('span', 'why', `${gone ? 'No longer listed · ' : ''}${a.tag || a.why} · alerted ${ago(Date.now() - a.at)}${listed}`)
    );
    li.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'focusSite' }).then(() => window.close()));
    list.append(li);
  }
}

// the background writes the inbox, so a check landing meanwhile can't bring a dismissed alert back
function dismiss(a) {
  state.inbox = state.inbox.filter(e => !(e.key === a.key && e.at === a.at));
  renderInbox();
  chrome.runtime.sendMessage({ type: 'dismiss', key: a.key, at: a.at });
}
$('clearAll').addEventListener('click', () => {
  state.inbox = [];
  renderInbox();
  chrome.runtime.sendMessage({ type: 'clearInbox' });
});

const openSettings = () => { chrome.runtime.openOptionsPage(); window.close(); };
$('settings').addEventListener('click', openSettings);
$('setup').addEventListener('click', openSettings);

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  await load();
  if (changes.inbox || changes.latest || changes.watch) renderInbox();
  if (changes.latest || changes.watch || changes.settings) renderStatus(state);
});
setInterval(() => { renderStatus(state); renderInbox(); }, 15000); // keeps the "Xm ago" times fresh
wireHeader(() => state, true);

(async () => {
  await load();
  renderInbox();
  renderStatus(state);
})();

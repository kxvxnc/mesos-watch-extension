// Shared by the popup and the settings page: the header status, the banner and talking to the mesos.watch tab.
const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

const siteTabs = () => chrome.tabs.query({ url: 'https://mesos.watch/*' });

// ask a mesos.watch tab something; null if none answers
async function askTab(msg) {
  for (const t of await siteTabs()) {
    try { return await chrome.tabs.sendMessage(t.id, msg); } catch { /* tab not ready or older than the extension */ }
  }
  return null;
}

const ago = ms => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};

// the status dot and text, and the banner when nothing is checking. st: {watch, settings, latest}
async function renderStatus(st) {
  const tabs = await siteTabs();
  const L = st.latest;
  const dot = $('dot'), status = $('status'), banner = $('banner');
  dot.className = 'dot';
  banner.hidden = true;
  const show = text => { banner.hidden = false; $('bannerText').textContent = text; };

  if (!tabs.length) {
    status.textContent = 'not checking';
    return show('Alerts only run while a mesos.watch tab is open. Pin it so it stays.');
  }
  if (L && L.error && (!L.at || L.error.at >= L.at)) {
    dot.classList.add('bad');
    status.textContent = 'error';
    return show(L.error.message);
  }
  if (!st.watch.length) { status.textContent = 'idle'; return; }
  if (!L || !L.at) { dot.classList.add('warn'); status.textContent = 'starting…'; return; }
  const age = Date.now() - L.at;
  const stale = age > Math.max(180000, 3 * st.settings.intervalSec * 1000);
  const failing = listingsFailing(L);
  dot.classList.add(stale || failing.length ? 'warn' : 'ok');
  status.textContent = (stale ? 'stalled · ' : failing.length ? 'listings failing · ' : '') + 'checked ' + ago(age);
  if (stale) show('The mesos.watch tab stopped checking. Reload it, or make sure Chrome isn\'t putting it to sleep.');
  else if (failing.length) show(`Couldn't read the listings for ${failing.map(x => x.name).join(', ')}: ${failing[0].hitsError}. Their alerts are paused until it works again.`);
}

// watched items whose listings couldn't be read on the last check
const listingsFailing = L => Object.values((L && L.items) || {}).filter(x => x.hitsError);

// "Check now" and "Open mesos.watch". getState: () => the page's current state; closeAfter: the popup closes itself
function wireHeader(getState, closeAfter) {
  $('refresh').addEventListener('click', async () => {
    $('status').textContent = 'checking…';
    const r = await askTab({ type: 'pollNow' });
    if (!r) renderStatus(getState());
  });
  $('openSite').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'focusSite' });
    if (closeAfter) window.close();
  });
}

// one offer as words: "Ch 18 · Room 9 · KenZy"
const placeOf = r => `Ch ${r.ch} · Room ${r.r}${r.owner ? ' · ' + r.owner : ''}`;
// its price: "140", "950 ea", "140 ×5"
const priceOf = r => fmtMesos(r.unit) + (r.per > 1 ? ' ea' : '') + (r.stacks > 1 ? ` ×${r.stacks}` : '');
const priceTitle = r => (r.per > 1 ? `${r.per} for ` : '') + `${Number(r.price).toLocaleString('en-US')} mesos` + (r.stacks > 1 ? ` · ${r.stacks} stacks` : '');

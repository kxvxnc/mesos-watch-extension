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
  // text: a string, or nodes for the banner; button: show "Open mesos.watch"
  const show = (text, button = true) => {
    banner.hidden = false;
    $('bannerText').replaceChildren(...[].concat(text));
    $('openSite').hidden = !button;
  };

  if (st.settings.paused) { status.textContent = 'all alerts paused'; return; }

  if (!tabs.length) {
    status.textContent = 'not checking';
    return show('Alerts only run while a mesos.watch tab is open. Pin it so it stays.');
  }
  if (L && L.error && (!L.at || L.error.at >= L.at)) {
    dot.classList.add('bad');
    status.textContent = 'error';
    return show(L.error.message);
  }
  const running = runningIntervals(st.settings, st.watch);
  if (!running.length) { status.textContent = 'idle'; return; }
  if (!L || !L.at) { dot.classList.add('warn'); status.textContent = 'starting…'; return; }
  const age = Date.now() - L.at;
  const stale = age > Math.max(180000, 3 * Math.max(...running) * 1000);
  const failing = watchOn(st.settings, st.watch) ? listingsFailing(L) : [];
  dot.classList.add(stale || failing.length ? 'warn' : 'ok');
  status.textContent = (stale ? 'stalled · ' : failing.length ? 'listings failing · ' : '') + 'checked ' + ago(age);
  if (stale) show('The mesos.watch tab stopped checking. Reload it, or make sure Chrome isn\'t putting it to sleep.');
  else if (failing.length) show(failingBanner(failing, !!$('errors')), false); // the settings page has the Error log
}

// An error as a person reads it: the request path dropped, the HTTP status in words.
// "/browse?item=2040506&pmax=15000: HTTP 500" -> "mesos.watch's server had an error (HTTP 500)"
function friendlyError(msg) {
  msg = String(msg || 'Unknown error');
  const m = msg.match(/HTTP (\d{3})/);
  if (m) {
    const c = Number(m[1]);
    if (c >= 500) return `mesos.watch's server had an error (HTTP ${c})`;
    if (c === 429) return 'mesos.watch asked to slow down (HTTP 429)';
    if (c === 401 || c === 403) return `mesos.watch refused the request (HTTP ${c}). Reloading the mesos.watch tab usually fixes it`;
    return `mesos.watch answered HTTP ${c}`;
  }
  return msg.replace(/^\/\S*:\s*/, '');
}

// the banner when some items' listings couldn't be read: a headline, the items, then why in words
function failingBanner(failing, onSettingsPage) {
  const n = failing.length;
  const reasons = [...new Set(failing.map(x => friendlyError(x.hitsError)))];
  const ul = el('ul');
  const SHOW = 5;
  for (const x of failing.slice(0, SHOW)) ul.append(el('li', null, x.name + (reasons.length > 1 ? `: ${friendlyError(x.hitsError)}` : '')));
  if (n > SHOW) ul.append(el('li', null, `and ${n - SHOW} more`));
  const why = (reasons.length === 1 ? reasons[0] + '. ' : '') +
    `${n > 1 ? 'These items' : 'This item'} won't alert until it works again; it retries every check. ` +
    (onSettingsPage ? 'Full details in the Error log below.' : 'Full details on the settings page (⚙).');
  return [el('b', null, `Couldn't read the listings for ${n} item${n > 1 ? 's' : ''}`), ul, el('p', null, why)];
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
const placeOf = r => `Ch ${r.ch} · Room ${r.r}${r.owner ? ' · ' + r.owner : ''}${r.title ? ` · “${r.title}”` : ''}`;
// its price: "140", "950 ea", "140 ×5"
const priceOf = r => fmtMesos(r.unit) + (r.per > 1 ? ' ea' : '') + (r.stacks > 1 ? ` ×${r.stacks}` : '');
const priceTitle = r => (r.per > 1 ? `${r.per} for ` : '') + `${Number(r.price).toLocaleString('en-US')} mesos` + (r.stacks > 1 ? ` · ${r.stacks} stacks` : '') +
  (r.qty > 1 ? ` · ${r.qty.toLocaleString('en-US')} pcs in all` : '');

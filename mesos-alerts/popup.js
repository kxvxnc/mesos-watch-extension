const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

let state = { watch: [], settings: { ...MWA_DEFAULTS }, latest: null, history: [] };

async function load() {
  const s = await chrome.storage.local.get({ watch: [], settings: MWA_DEFAULTS, latest: null, history: [] });
  state = { ...s, settings: { ...MWA_DEFAULTS, ...s.settings } };
}
const saveWatch = () => chrome.storage.local.set({ watch: state.watch });
const saveSettings = () => chrome.storage.local.set({ settings: state.settings });

async function siteTabs() {
  return chrome.tabs.query({ url: 'https://mesos.watch/*' });
}
// ask a mesos.watch tab (the one most likely to be ready) something; null if none answers
async function askTab(msg) {
  for (const t of await siteTabs()) {
    try { return await chrome.tabs.sendMessage(t.id, msg); } catch { /* tab not ready or older than the extension */ }
  }
  return null;
}

/* ---------- status ---------- */
const ago = ms => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};

async function renderStatus() {
  const tabs = await siteTabs();
  const L = state.latest;
  const dot = $('dot'), status = $('status'), banner = $('banner');
  dot.className = 'dot';
  banner.hidden = true;

  if (!tabs.length) {
    status.textContent = 'not checking';
    banner.hidden = false;
    $('bannerText').textContent = 'Alerts only run while a mesos.watch tab is open. Pin it so it stays.';
    $('openSite').hidden = false;
    return;
  }
  if (L && L.error && (!L.at || L.error.at > L.at)) {
    dot.classList.add('bad');
    status.textContent = 'error';
    banner.hidden = false;
    $('bannerText').textContent = L.error.message;
    $('openSite').hidden = false;
    return;
  }
  if (!state.watch.length) { status.textContent = 'idle'; return; }
  if (!L || !L.at) { dot.classList.add('warn'); status.textContent = 'starting…'; return; }
  const age = Date.now() - L.at;
  const stale = age > Math.max(180000, 3 * state.settings.intervalSec * 1000);
  dot.classList.add(stale ? 'warn' : 'ok');
  status.textContent = (stale ? 'stalled · ' : '') + 'checked ' + ago(age);
  if (stale) {
    banner.hidden = false;
    $('bannerText').textContent = 'The mesos.watch tab stopped checking. Reload it, or make sure Chrome isn\'t putting it to sleep.';
    $('openSite').hidden = false;
  }
}

/* ---------- watchlist ---------- */
function renderList() {
  const list = $('list');
  list.textContent = '';
  $('empty').hidden = state.watch.length > 0;
  const items = (state.latest && state.latest.items) || {};

  for (const w of state.watch) {
    const x = items[w.id];
    const under = x ? (x.hits ? x.hitCount > 0 : isUnder(x, w.target, state.settings.dealPct)) : false;
    const li = el('li', 'item' + (under ? ' under' : ''));

    const name = el('div', 'name', w.name || `Item ${w.id}`);
    name.title = `${w.name || ''} (ID ${w.id})`;
    name.append(el('small', null, `#${w.id}`));

    const price = el('div', 'price', x ? (x.cheapest != null ? fmtMesos(x.cheapest) : 'none listed') : '…');
    if (x && x.cheapest != null) price.title = Number(x.cheapest).toLocaleString('en-US') + ' mesos';

    let metaText = 'waiting for the first check';
    if (x) {
      const parts = [];
      if (x.typical) parts.push(`typical ${fmtMesos(x.typical)}`);
      if (x.listings != null) parts.push(`${x.listings} listed`);
      metaText = parts.join(' · ') || 'no listings right now';
    }
    const meta = el('div', 'meta', metaText);
    meta.title = metaText;

    const ctl = el('div', 'ctl');
    const lab = el('label', null, 'alert ≤');
    const input = el('input');
    input.type = 'text';
    input.placeholder = 'target';
    input.value = w.target > 0 ? fmtMesos(w.target) : '';
    input.title = 'Alert when the cheapest listing is at or under this. Accepts 500k, 1.2m, 2b.';
    input.addEventListener('change', () => {
      const v = parseMesos(input.value);
      if (isNaN(v)) { input.classList.add('err'); return; }
      input.classList.remove('err');
      w.target = v;
      input.value = v > 0 ? fmtMesos(v) : '';
      saveWatch();
    });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });
    const rm = el('button', 'icon', '×');
    rm.title = 'Remove';
    rm.addEventListener('click', () => {
      state.watch = state.watch.filter(o => o.id !== w.id);
      // drop its last results too, so adding it back starts clean
      const latest = state.latest;
      if (latest && latest.items) delete latest.items[w.id];
      chrome.storage.local.set({ watch: state.watch, latest });
      renderList();
    });
    ctl.append(lab, input, rm);

    li.append(name, price, meta, ctl);

    // every listing at or under the target, newest first
    if (x && x.hitCount) {
      const ul = el('ul', 'hits');
      for (const r of x.hits.slice(0, 5)) {
        const row = el('li');
        row.append(
          el('b', null, fmtMesos(r.unit) + (r.per > 1 ? ' ea' : '') + (r.stacks > 1 ? ` ×${r.stacks}` : '')),
          el('span', null, `Ch ${r.ch} · Room ${r.r}${r.owner ? ' · ' + r.owner : ''}`),
          el('i', null, r.listed ? agoS(r.listed) : ''));
        row.title = r.per > 1 ? `${r.per} for ${Number(r.price).toLocaleString('en-US')} mesos` : `${Number(r.price).toLocaleString('en-US')} mesos`;
        ul.append(row);
      }
      if (x.hitCount > 5) ul.append(el('li', 'more', `+${x.hitCount - 5} more under target`));
      li.append(ul);
    }
    list.append(li);
  }
}

function addItem(id, name) {
  id = Number(id);
  $('search').value = '';
  hideResults();
  if (!state.watch.some(w => w.id === id)) {
    state.watch.push({ id, name: name || null, target: 0 });
    saveWatch();
  }
  renderList();
  const idx = state.watch.findIndex(w => w.id === id);
  const input = $('list').children[idx] && $('list').children[idx].querySelector('input');
  if (input) input.focus();
}

/* ---------- search ---------- */
let searchSeq = 0, sel = -1, current = [];
function hideResults() { $('results').hidden = true; sel = -1; current = []; }
function showResults(rows, note) {
  const ul = $('results');
  ul.textContent = '';
  current = rows;
  sel = rows.length ? 0 : -1;
  rows.forEach(([id, name], i) => {
    const li = el('li', i === 0 ? 'sel' : '');
    li.append(el('span', null, name), el('span', 'id', `#${id}`));
    li.addEventListener('mousedown', e => { e.preventDefault(); addItem(id, name); });
    ul.append(li);
  });
  if (note) ul.append(el('li', 'note', note));
  ul.hidden = !rows.length && !note;
}
function moveSel(d) {
  const lis = [...$('results').querySelectorAll('li:not(.note)')];
  if (!lis.length) return;
  sel = (sel + d + lis.length) % lis.length;
  lis.forEach((li, i) => li.classList.toggle('sel', i === sel));
  lis[sel].scrollIntoView({ block: 'nearest' });
}

let debounce = null;
$('search').addEventListener('input', () => {
  clearTimeout(debounce);
  const q = $('search').value.trim();
  if (!q) return hideResults();
  debounce = setTimeout(async () => {
    const my = ++searchSeq;
    showResults([], 'Searching…');
    const r = await askTab({ type: 'search', q });
    if (my !== searchSeq) return;
    const rows = r && r.ok ? r.items : [];
    if (/^\d{7}$/.test(q) && !rows.some(([id]) => String(id) === q)) rows.unshift([Number(q), `Item ${q}`]);
    if (rows.length) showResults(rows);
    else if (!r) showResults([], 'Open mesos.watch to search by name (or type a 7-digit item ID).');
    else if (!r.ok) showResults([], 'Search failed: ' + ((r.error && r.error.message) || 'unknown error'));
    else showResults([], 'No items match.');
  }, 250);
});
$('search').addEventListener('keydown', e => {
  if ($('results').hidden) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); moveSel(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveSel(-1); }
  else if (e.key === 'Enter' && sel >= 0 && current[sel]) { e.preventDefault(); addItem(...current[sel]); }
  else if (e.key === 'Escape') hideResults();
});
$('search').addEventListener('blur', () => setTimeout(hideResults, 100));

/* ---------- header buttons ---------- */
$('refresh').addEventListener('click', async () => {
  $('status').textContent = 'checking…';
  const r = await askTab({ type: 'pollNow' });
  if (!r) renderStatus();
});
$('openSite').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'focusSite' }).then(() => window.close()));

/* ---------- settings & export ---------- */
function renderSettings() {
  $('interval').value = state.settings.intervalSec;
  $('deal').value = state.settings.dealPct;
  $('notify').checked = state.settings.notify;
  const n = state.history.length;
  $('logInfo').textContent = n ? `${n.toLocaleString('en-US')} price changes logged since ${new Date(state.history[0][0]).toLocaleString()}.` : 'The log fills as prices change.';
}
$('interval').addEventListener('change', () => {
  state.settings.intervalSec = Math.max(30, Math.round(Number($('interval').value) || 60));
  $('interval').value = state.settings.intervalSec;
  saveSettings();
});
$('deal').addEventListener('change', () => {
  state.settings.dealPct = Math.min(90, Math.max(0, Number($('deal').value) || 0));
  $('deal').value = state.settings.dealPct;
  saveSettings();
  renderList();
});
$('notify').addEventListener('change', () => { state.settings.notify = $('notify').checked; saveSettings(); });

$('export').addEventListener('click', () => {
  const head = ['time', 'item_id', 'item', 'cheapest', 'typical', 'listings', 'channel', 'room', 'owner'];
  const q = v => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
  const lines = [head.join(',')].concat(state.history.map(r => [new Date(r[0]).toISOString(), ...r.slice(1)].map(q).join(',')));
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  const a = el('a');
  a.href = url;
  a.download = `mesos-prices-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});
$('clearLog').addEventListener('click', async () => {
  if (!confirm('Clear the whole price log?')) return;
  await chrome.storage.local.set({ history: [] });
});

/* ---------- live updates while the popup is open ---------- */
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  await load();
  // don't redraw under someone typing a target; it redraws on the next update
  const editing = document.activeElement && $('list').contains(document.activeElement);
  if ((changes.latest || changes.watch) && !editing) renderList();
  if (changes.latest || changes.watch) renderStatus();
  if (changes.history || changes.settings) renderSettings();
});
setInterval(renderStatus, 5000);

(async () => {
  await load();
  renderList();
  renderSettings();
  renderStatus();
  $('search').focus();
})();

// The settings page (opens in its own tab): add items, set targets, see what's under them now, settings, the price log.
let state = { watch: [], settings: { ...MWA_DEFAULTS }, latest: null, history: [] };
const expanded = new Set(); // items whose full list of offers is open

async function load() {
  const s = await chrome.storage.local.get({ watch: [], settings: MWA_DEFAULTS, latest: null, history: [] });
  state = { ...s, settings: { ...MWA_DEFAULTS, ...s.settings } };
}
const saveSettings = () => chrome.storage.local.set({ settings: state.settings });

/* ---------- watchlist ---------- */
function renderList() {
  const list = $('list');
  list.textContent = '';
  $('empty').hidden = state.watch.length > 0;
  const nPaused = state.watch.filter(w => w.paused).length;
  $('watchCount').textContent = state.watch.length ? `(${state.watch.length}${nPaused ? ` · ${nPaused} paused` : ''})` : '';
  const items = (state.latest && state.latest.items) || {};

  for (const w of state.watch) {
    const x = items[w.id];
    const li = el('li', 'item' + (w.paused ? ' paused' : x && x.hitCount ? ' under' : ''));

    const name = el('div', 'name', w.name || `Item ${w.id}`);
    name.title = `${w.name || ''} (ID ${w.id})`;
    name.append(el('small', null, `#${w.id}`));

    const price = el('div', 'price');
    if (x && x.cheapest != null) {
      price.append(el('small', null, 'cheapest'), fmtMesos(x.cheapest));
      price.title = Number(x.cheapest).toLocaleString('en-US') + ' mesos';
    } else price.textContent = x ? 'none listed' : '…';

    let metaText = 'waiting for the first check';
    if (x) {
      const parts = [];
      if (x.typical) parts.push(`typical ${fmtMesos(x.typical)}`);
      if (x.listings != null) parts.push(`${x.listings} listed on every channel`);
      metaText = parts.join(' · ') || 'no listings right now';
    }
    const meta = el('div', 'meta', metaText);
    if (x && x.hitsError) {
      const last = x.hitsAt ? ` Last read ${ago(Date.now() - x.hitsAt)}.` : '';
      meta.append(el('div', 'err', `Listings not updating: ${friendlyError(x.hitsError)}.${last} No alerts for it until this clears.`));
    }

    const ctl = el('div', 'ctl');
    const lab = el('label', null, 'alert at or under');
    const input = el('input');
    input.type = 'text';
    input.placeholder = 'target';
    input.value = w.target > 0 ? fmtMesos(w.target) : '';
    input.title = 'Alert for each new listing at or under this price each. Accepts 500k, 1.2m, 2b.';
    input.addEventListener('change', () => {
      const v = parseMesos(input.value);
      if (isNaN(v)) { input.classList.add('err'); return; }
      input.classList.remove('err');
      input.value = v > 0 ? fmtMesos(v) : '';
      setWatch(list => list.map(o => (o.id === w.id ? { ...o, target: v } : o)));
    });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });
    const rm = el('button', 'icon', '×');
    rm.title = 'Stop watching';
    rm.addEventListener('click', () => removeItem(w.id));
    // this item's own on/off: paused keeps the target for later
    const sw = el('label', 'switch');
    sw.title = w.paused ? 'Paused: no alerts for this item. Turn on to resume.' : 'On: alerts for this item. Turn off to pause it.';
    const on = el('input');
    on.type = 'checkbox';
    on.checked = !w.paused;
    on.addEventListener('change', () => setWatch(list => list.map(o => (o.id === w.id ? { ...o, paused: !on.checked } : o))));
    sw.append(on, el('span', 'slider'), el('span', null, w.paused ? 'paused' : 'on'));
    ctl.append(sw, lab, input, rm);

    li.append(name, price, meta, ctl);
    if (isEquip(w.id)) li.append(statFilter(w));

    if (w.paused) meta.append(el('div', null, 'Paused: no alerts until you turn it back on. Its target is kept.'));

    // what's at or under the target right now, newest first
    if (!w.paused && x && x.hitCount) {
      const ul = el('ul', 'hits');
      ul.append(el('li', 'head', `${x.hitCount} offer${x.hitCount > 1 ? 's' : ''} at or under target now`));
      const open = expanded.has(w.id);
      for (const r of x.hits.slice(0, open ? x.hits.length : 5)) {
        const row = el('li');
        const st = statsText(r.stats);
        row.append(el('b', null, priceOf(r)), el('span', null, (st ? st + ' · ' : '') + placeOf(r)), el('i', null, r.listed ? agoS(r.listed) : ''));
        row.title = priceTitle(r) + (st ? '\n' + st : '');
        ul.append(row);
      }
      if (x.hitCount > 5) {
        const more = el('li', 'more', open ? '' : `+${x.hitCount - 5} more`);
        const b = el('button', 'ghost', open ? 'Show fewer' : 'Show all');
        b.addEventListener('click', () => { open ? expanded.delete(w.id) : expanded.add(w.id); renderList(); });
        more.append(b);
        ul.append(more);
      }
      li.append(ul);
    }
    list.append(li);
  }
}

// an equip's stat minimums: chips you can remove, and a stat + number to add one
function statFilter(w) {
  const box = el('div', 'statf');
  const min = w.minStats || {};
  const setMin = fn => setWatch(list => list.map(o => {
    if (o.id !== w.id) return o;
    const m = fn({ ...(o.minStats || {}) });
    const { minStats, ...rest } = o;
    return Object.keys(m).length ? { ...rest, minStats: m } : rest;
  }));
  box.append(el('span', 'lab', hasMinStats(min) ? 'Only alert with' : 'Any stats'));
  for (const [k, l] of MWA_STATS) {
    if (min[k] == null) continue;
    const chip = el('span', 'chip', `${l} ≥ ${min[k]}`);
    const x = el('button', 'icon', '×');
    x.title = `Remove the ${l} minimum`;
    x.addEventListener('click', () => setMin(m => { delete m[k]; return m; }));
    chip.append(x);
    box.append(chip);
  }
  const sel = el('select');
  sel.title = 'Stat';
  for (const [k, l] of MWA_STATS) if (min[k] == null) { const o = el('option', null, l); o.value = k; sel.append(o); }
  if (!sel.options.length) return box; // every stat has a minimum already
  const val = el('input');
  val.type = 'text';
  val.inputMode = 'numeric';
  val.placeholder = 'min';
  val.title = 'Only listings with at least this much of the stat alert';
  const add = el('button', 'ghost', 'Add');
  const doAdd = () => {
    const v = Number(val.value.trim());
    if (!val.value.trim() || !Number.isInteger(v) || v < 0 || v > 99999) { val.classList.add('err'); val.focus(); return; }
    const k = sel.value;
    val.blur(); // let the list redraw (it holds off while a box has focus)
    setMin(m => ({ ...m, [k]: v }));
  };
  add.addEventListener('click', doAdd);
  val.addEventListener('keydown', e => { if (e.key === 'Enter') doAdd(); });
  box.append(sel, val, add);
  return box;
}

// change the watchlist from what's stored now (the background may have just filled in a name)
async function setWatch(fn) {
  const { watch = [] } = await chrome.storage.local.get('watch');
  state.watch = fn(watch);
  await chrome.storage.local.set({ watch: state.watch });
}

async function removeItem(id) {
  await setWatch(list => list.filter(o => o.id !== id));
  // drop its last results too, so adding it back starts clean
  const { latest } = await chrome.storage.local.get('latest');
  if (latest && latest.items && latest.items[id]) { delete latest.items[id]; await chrome.storage.local.set({ latest }); }
}

async function addItem(id, name) {
  id = Number(id);
  $('search').value = '';
  hideResults();
  if (!state.watch.some(w => w.id === id)) await setWatch(list => list.concat({ id, name: name || null, target: 0 }));
  renderList();
  const idx = state.watch.findIndex(w => w.id === id);
  const card = $('list').children[idx];
  if (card) { card.scrollIntoView({ block: 'nearest' }); const input = card.querySelector('input'); if (input) input.focus(); }
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
    const watched = state.watch.some(w => w.id === Number(id));
    li.append(el('span', null, name + (watched ? '  (watching)' : '')), el('span', 'id', `#${id}`));
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
    else if (!r) showResults([], 'Open (or reload) a mesos.watch tab to search by name, or type a 7-digit item ID.');
    else if (!r.ok) {
      showResults([], 'Search failed: ' + ((r.error && (r.error.userMessage || r.error.message)) || 'unknown error') + ' (details in the Error log below)');
      chrome.runtime.sendMessage({ type: 'logError', entry: { source: 'search', ...(r.error || {}), message: (r.error && r.error.message) || 'unknown error' } });
    }
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

/* ---------- settings & export ---------- */
function renderPause() {
  const paused = !!state.settings.paused;
  $('allOn').checked = !paused;
  $('allOnText').textContent = paused ? 'All paused' : 'Alerts on';
  $('pausedNote').hidden = !paused;
}
$('allOn').addEventListener('change', () => { state.settings.paused = !$('allOn').checked; renderPause(); saveSettings(); });

function renderSettings() {
  $('interval').value = state.settings.intervalSec;
  $('deal').value = state.settings.dealPct;
  $('notify').checked = state.settings.notify;
  const n = state.history.length;
  $('logInfo').textContent = n
    ? `${n.toLocaleString('en-US')} price change${n > 1 ? 's' : ''} logged since ${new Date(state.history[0][0]).toLocaleString()}. One row each time an item's cheapest price changes.`
    : 'The log fills as prices change: one row each time an item\'s cheapest price changes.';
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
});
$('notify').addEventListener('change', () => { state.settings.notify = $('notify').checked; saveSettings(); });

/* ---------- error log ---------- */
const SOURCE = { check: 'Check', listings: 'Listings', discord: 'Discord', search: 'Search' };
const when = t => new Date(t).toLocaleString();
const errText = e => [
  `${when(e.at)}${e.count > 1 ? ` (×${e.count}, last ${when(e.lastAt)})` : ''} · ${SOURCE[e.source] || e.source}${e.item ? ' · ' + e.item + (e.itemId ? ` #${e.itemId}` : '') : ''}`,
  e.message,
  e.code ? `code: ${e.code}` : '',
  e.userMessage && e.userMessage !== e.message ? `site says: ${e.userMessage}` : '',
  e.name ? `type: ${e.name}` : ''
].filter(Boolean).join('\n');

async function renderErrors() {
  const { errors = [] } = await chrome.storage.local.get('errors');
  const ul = $('errors');
  ul.textContent = '';
  $('errCount').textContent = errors.length ? `(${errors.length})` : '';
  $('copyErrors').disabled = $('clearErrors').disabled = !errors.length;
  if (!errors.length) { ul.append(el('li', 'none', 'No errors logged.')); return; }
  for (const e of errors) {
    const li = el('li');
    const top = el('div', 'top');
    top.append(el('span', 'src', SOURCE[e.source] || e.source));
    if (e.item) top.append(el('b', null, e.item));
    top.append(el('span', 'when', `${when(e.lastAt || e.at)}${e.count > 1 ? ` · ×${e.count} since ${when(e.at)}` : ''}`));
    li.append(top, el('div', 'msg', e.message));
    const extra = [e.code && `code: ${e.code}`, e.userMessage && e.userMessage !== e.message && `site says: ${e.userMessage}`, e.name && `type: ${e.name}`].filter(Boolean);
    if (extra.length) li.append(el('div', 'extra', extra.join(' · ')));
    ul.append(li);
  }
}
$('copyErrors').addEventListener('click', async () => {
  const { errors = [] } = await chrome.storage.local.get('errors');
  await navigator.clipboard.writeText(errors.map(errText).join('\n\n'));
  $('copyErrors').textContent = 'Copied';
  setTimeout(() => { $('copyErrors').textContent = 'Copy all'; }, 1500);
});
$('clearErrors').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'clearErrors' }));

/* ---------- Discord webhook ---------- */
let webhookNote = null; // a message from Save/Test, shown until the next storage update
async function renderWebhook() {
  const { webhookStatus: ws } = await chrome.storage.local.get('webhookStatus');
  const info = $('webhookInfo'), on = isWebhookUrl(state.settings.webhook);
  if (document.activeElement !== $('webhook')) $('webhook').value = state.settings.webhook || '';
  $('webhookTest').disabled = !on;
  info.className = 'hint';
  if (webhookNote) { info.textContent = webhookNote.text; info.classList.add(webhookNote.ok ? 'ok' : 'bad'); return; }
  if (!on) { info.textContent = 'Off.'; return; }
  if (ws && !ws.ok) { info.textContent = `Last post failed ${ago(Date.now() - ws.at)}: ${ws.error}`; info.classList.add('bad'); return; }
  info.textContent = 'On: new alerts are posted to this webhook.' + (ws && ws.ok ? ` Last posted ${ago(Date.now() - ws.at)}.` : '');
}
const note = (text, ok) => { webhookNote = { text, ok }; renderWebhook(); setTimeout(() => { webhookNote = null; renderWebhook(); }, 8000); };

$('webhookSave').addEventListener('click', async () => {
  const url = $('webhook').value.trim();
  if (!url) {
    state.settings.webhook = '';
    await saveSettings();
    chrome.permissions.remove({ origins: MWA_WEBHOOK_ORIGINS }).catch(() => {});
    return note('Discord alerts turned off.', true);
  }
  if (!isWebhookUrl(url)) { $('webhook').classList.add('err'); return note('That isn\'t a Discord webhook URL. It looks like https://discord.com/api/webhooks/123…/abc…', false); }
  $('webhook').classList.remove('err');
  // Chrome asks once whether the extension may post to Discord
  const granted = await chrome.permissions.request({ origins: MWA_WEBHOOK_ORIGINS }).catch(() => false);
  if (!granted) return note('Chrome permission to post to Discord is needed. Click Save again and allow it.', false);
  state.settings.webhook = url;
  await saveSettings();
  note('Saved. Use "Send test" to check it posts.', true);
});
$('webhook').addEventListener('keydown', e => { if (e.key === 'Enter') $('webhookSave').click(); });

$('webhookTest').addEventListener('click', async () => {
  $('webhookTest').disabled = true;
  const r = await chrome.runtime.sendMessage({ type: 'testWebhook', url: state.settings.webhook });
  $('webhookTest').disabled = false;
  note(r && r.ok ? 'Test sent: check the Discord channel.' : `Test failed: ${(r && r.error) || 'no answer'}`, !!(r && r.ok));
});

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

/* ---------- share: export / import the watchlist ---------- */
const flash = (btn, text) => { const t = btn.textContent; btn.textContent = text; setTimeout(() => { btn.textContent = t; }, 1500); };
$('shareCopy').addEventListener('click', async () => {
  if (!state.watch.length) return flash($('shareCopy'), 'Nothing to copy');
  await navigator.clipboard.writeText(exportWatch(state.watch));
  flash($('shareCopy'), `Copied ${state.watch.length} item${state.watch.length > 1 ? 's' : ''}`);
});
$('shareDownload').addEventListener('click', () => {
  if (!state.watch.length) return flash($('shareDownload'), 'Nothing to save');
  const url = URL.createObjectURL(new Blob([exportWatch(state.watch)], { type: 'application/json' }));
  const a = el('a');
  a.href = url;
  a.download = `mesos-alerts-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

let pending = null; // the parsed list in the import box
function renderImport(doneText) {
  const info = $('importInfo');
  info.className = 'hint';
  $('importAdd').disabled = $('importReplace').disabled = !pending;
  if (doneText) { info.textContent = doneText; info.classList.add('ok'); return; }
  const text = $('importText').value.trim();
  pending = null;
  if (!text) { info.textContent = ''; $('importAdd').disabled = $('importReplace').disabled = true; return; }
  try { pending = parseWatchImport(text); } catch (e) {
    info.textContent = e.message; info.classList.add('bad');
    $('importAdd').disabled = $('importReplace').disabled = true;
    return;
  }
  $('importAdd').disabled = $('importReplace').disabled = false;
  const n = pending.items.length, add = importPlan(state.watch, pending.items, false);
  const rep = importPlan(state.watch, pending.items, true);
  const parts = [`${add.added} new`];
  if (add.changed) parts.push(`${add.changed} with a different target`);
  if (add.same) parts.push(`${add.same} already watched`);
  info.textContent = `${n} item${n > 1 ? 's' : ''}: ${parts.join(', ')}.` +
    (pending.skipped ? ` ${pending.skipped} unreadable entr${pending.skipped > 1 ? 'ies' : 'y'} skipped.` : '') +
    (rep.removed ? ` Replacing would remove ${rep.removed} of yours.` : '');
}
$('importText').addEventListener('input', () => renderImport());
$('importChoose').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async () => {
  const f = $('importFile').files[0];
  $('importFile').value = '';
  if (!f) return;
  if (f.size > 1e6) { $('importText').value = ''; renderImport(); $('importInfo').textContent = 'That file is too big to be an alert list.'; $('importInfo').classList.add('bad'); return; }
  $('importText').value = await f.text();
  renderImport();
});

async function doImport(replace) {
  if (!pending) return;
  const { items } = pending;
  const { watch = [] } = await chrome.storage.local.get('watch');
  const plan = importPlan(watch, items, replace);
  if (replace && plan.removed && !confirm(`Replace your list? ${plan.removed} item${plan.removed > 1 ? 's' : ''} you watch now will be removed.`)) return;
  const dropped = replace ? watch.filter(w => !items.some(i => i.id === w.id)).map(w => w.id) : [];
  pending = null;
  $('importText').value = '';
  await setWatch(list => applyImport(list, items, replace));
  if (dropped.length) {
    // same as removing them by hand: forget their last results
    const { latest } = await chrome.storage.local.get('latest');
    if (latest && latest.items) { for (const id of dropped) delete latest.items[id]; await chrome.storage.local.set({ latest }); }
  }
  const bits = [`${plan.added} added`];
  if (plan.changed) bits.push(`${plan.changed} updated`);
  if (plan.removed) bits.push(`${plan.removed} removed`);
  renderImport(`Imported: ${bits.join(', ')}. Listings already up don't alert; new ones at or under the targets will.`);
}
$('importAdd').addEventListener('click', () => doImport(false));
$('importReplace').addEventListener('click', () => doImport(true));

/* ---------- live updates ---------- */
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  await load();
  // don't redraw under someone typing a target; it redraws on the next update.
  // Only a text box or a stat picker counts: a clicked button or switch also takes focus, and that must still redraw.
  const a = document.activeElement;
  const editing = a && a.matches('input[type=text], select') && $('list').contains(a);
  if ((changes.latest || changes.watch) && !editing) renderList();
  if (changes.latest || changes.watch || changes.settings) renderStatus(state);
  if (changes.history || changes.settings) renderSettings();
  if (changes.settings) renderPause();
  if (changes.settings || changes.webhookStatus) renderWebhook();
  if (changes.errors) renderErrors();
  if (changes.watch && pending) renderImport(); // the preview counts depend on the current list
});
setInterval(() => renderStatus(state), 5000);
wireHeader(() => state, false);

(async () => {
  await load();
  renderList();
  renderSettings();
  renderWebhook();
  renderErrors();
  renderPause();
  renderStatus(state);
  $('search').focus();
})();

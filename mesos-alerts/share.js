// Watchlist export/import (settings page). The format is JSON, so it can be pasted in Discord or saved as a file:
// {"app":"mesos-watch-alerts","v":1,"items":[{"id":1302000,"name":"Item","target":500000,"minStats":{"watk":20},"paused":true}]}
// Only items, targets and stat filters travel: never the Discord webhook or alerts.
const SHARE_APP = 'mesos-watch-alerts';

function exportWatch(watch) {
  const items = watch.map(w => {
    const o = { id: w.id, name: w.name || null, target: w.target > 0 ? w.target : 0 };
    if (hasMinStats(w.minStats)) o.minStats = w.minStats;
    if (w.paused) o.paused = true;
    return o;
  });
  return JSON.stringify({ app: SHARE_APP, v: 1, items });
}

// text -> {items, skipped} or throws an Error whose message is for the user.
// Lenient: tolerates text around the JSON (a Discord code block), a bare array, and targets like "500k".
function parseWatchImport(text) {
  text = String(text || '').trim();
  if (!text) throw new Error('Nothing to import.');
  const a = text.search(/[[{]/), b = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  let data;
  try { data = JSON.parse(a >= 0 && b > a ? text.slice(a, b + 1) : text); } catch { throw new Error('That isn\'t an exported alert list.'); }
  const rows = Array.isArray(data) ? data : data && Array.isArray(data.items) ? data.items : null;
  if (!rows) throw new Error('That isn\'t an exported alert list.');
  if (data.app && data.app !== SHARE_APP) throw new Error('That list is from a different app.');

  const byId = new Map();
  let skipped = 0;
  for (const r of rows) {
    const id = Number(r && typeof r === 'object' ? r.id : r);
    if (!/^\d{7}$/.test(String(id))) { skipped++; continue; }
    let target = r && typeof r === 'object' ? r.target : 0;
    target = typeof target === 'number' ? Math.round(target) : parseMesos(target);
    if (!(target >= 0)) target = 0;
    const name = r && typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 100) : null;
    const item = { id, name, target, paused: !!(r && r.paused === true) };
    // stat minimums: equips only, known stats, whole numbers; anything else is dropped
    const ms = r && typeof r.minStats === 'object' && r.minStats && isEquip(id) ? r.minStats : null;
    const min = {};
    if (ms) for (const [k] of MWA_STATS) { const v = Number(ms[k]); if (ms[k] != null && Number.isInteger(v) && v >= 0 && v <= 99999) min[k] = v; }
    if (hasMinStats(min)) item.minStats = min;
    byId.set(id, item); // a repeated ID: the last one wins
  }
  if (!byId.size) throw new Error('No items found in that list.');
  return { items: [...byId.values()], skipped };
}

// what importing would do to the current list
function importPlan(watch, items, replace) {
  const mine = new Map(watch.map(w => [w.id, w]));
  const theirs = new Set(items.map(i => i.id));
  let added = 0, changed = 0, same = 0;
  for (const i of items) {
    const w = mine.get(i.id);
    if (!w) added++;
    else if (replace ? (w.target !== i.target || !!w.paused !== i.paused || minStatsSig(w.minStats) !== minStatsSig(i.minStats))
      : i.target > 0 && (w.target !== i.target || (hasMinStats(i.minStats) && minStatsSig(w.minStats) !== minStatsSig(i.minStats)))) changed++;
    else same++;
  }
  const removed = replace ? watch.filter(w => !theirs.has(w.id)).length : 0;
  return { added, changed, same, removed };
}

// Add: new items are appended; an item you already watch takes the imported target (if it has one) and its stat
// filter (if it has one), and keeps your own on/off and name. Replace: the list becomes the imported one.
function applyImport(watch, items, replace) {
  if (replace) {
    const mine = new Map(watch.map(w => [w.id, w]));
    return items.map(i => ({ ...i, name: i.name || (mine.get(i.id) || {}).name || null }));
  }
  const byId = new Map(items.map(i => [i.id, i]));
  const out = watch.map(w => {
    const i = byId.get(w.id);
    if (!i || !(i.target > 0)) return w;
    const o = { ...w, target: i.target, name: w.name || i.name };
    if (hasMinStats(i.minStats)) o.minStats = i.minStats;
    return o;
  });
  const have = new Set(watch.map(w => w.id));
  return out.concat(items.filter(i => !have.has(i.id)));
}

if (typeof module !== 'undefined') module.exports = { exportWatch, parseWatchImport, importPlan, applyImport };

// Runs in the extension's isolated world on mesos.watch. Owns the timer, asks the background whether this tab
// should check (so several open tabs don't all poll), relays requests to page.js and results to the background.
(() => {
  const TO_PAGE = 'mwa:to-page';
  const FROM_PAGE = 'mwa:from-page';
  const DEFAULT_INTERVAL = 60;

  let seq = 0;
  const pending = new Map();
  window.addEventListener('message', e => {
    if (e.source !== window || !e.data || e.data.tag !== FROM_PAGE || !pending.has(e.data.id)) return;
    const p = pending.get(e.data.id);
    pending.delete(e.data.id);
    e.data.ok ? p.res(e.data.data) : p.rej(e.data.data);
  });
  const ask = (type, payload, timeout = 45000) => new Promise((res, rej) => {
    const id = 'mwa' + (++seq);
    pending.set(id, { res, rej });
    window.postMessage({ tag: TO_PAGE, id, type, payload }, location.origin);
    setTimeout(() => { if (pending.delete(id)) rej({ message: 'The page took too long to answer.' }); }, timeout);
  });

  // After the extension is reloaded or updated, Chrome leaves this old copy running in the tab, cut off from it:
  // every chrome.* call then throws "Extension context invalidated". Stop quietly at the first sign of it;
  // the reloaded tab gets a fresh copy.
  let dead = false;
  const alive = () => { try { return !!(chrome.runtime && chrome.runtime.id); } catch { return false; } };
  const stop = () => { dead = true; clearInterval(timer); };
  const send = async msg => {
    if (dead) return undefined;
    try { return await chrome.runtime.sendMessage(msg); }
    catch (err) {
      if (!alive()) stop();
      return undefined;
    }
  };
  // storage, or null once cut off
  const getStored = async keys => {
    if (dead || !alive()) { stop(); return null; }
    try { return await chrome.storage.local.get(keys); }
    catch (err) { if (!alive()) { stop(); return null; } throw err; }
  };

  let ready = false, busy = false, timer = null;

  // a check asked for now (an item added, changed or resumed) while one is running: run it right after
  let again = false;

  async function tick(force = false) {
    if (!ready || dead) return;
    if (busy) { if (force) again = true; return; }
    busy = true;
    try {
      const stored = await getStored(['watch', 'settings']);
      if (!stored) return;
      const { watch = [], settings = {} } = stored;
      if ((!watch.length && !nxOn(settings)) || settings.paused) return; // all alerts paused: no requests at all
      if (!(await send({ type: 'claim', force }))) return;
      try {
        // NX equips first, before the watched items (on every check, like them; the site's Live feed widget reads them
        // every 30 s): {max, rows, truncated} or {max, error}; left out when off
        let nx;
        const cmax = Number(settings.nxMax) || 0;
        if (cmax > 0) {
          try { nx = { max: cmax, ...(await ask('nx', { max: cmax })) }; }
          catch (err) { nx = { max: cmax, error: err }; }
        }
        const data = watch.length ? await ask('poll', { ids: watch.map(w => Number(w.id)) }) : {};
        // fetch the full listings only for items that can have one under the max: the summary's cheapest says so,
        // or the item can come in bundles (the summary's cheapest may be a bundle's price, not the price each)
        const dealPct = Number(settings.dealPct) || 0;
        const need = [];
        for (const w of watch) {
          if (w.paused) continue; // paused item: its price still updates (summary), no listings or alerts
          const x = data[w.id];
          const max = alertMax(w.target, x && x.typical, dealPct);
          if (x && max > 0 && (mayBundle(w.id) || x.cheapest <= max)) need.push({ id: Number(w.id), max, min: hasMinStats(w.minStats) ? w.minStats : null, minQty: hasMinQty(w.minQty) ? Number(w.minQty) : 0 });
        }
        const hits = need.length ? await ask('listings', { items: need }, 30000 + 15000 * need.length) : {};
        const checked = Object.fromEntries(watch.map(w => [w.id, alertCfg(w, dealPct)]));
        await send({ type: 'result', data, hits, checked, nx });
      } catch (err) {
        await send({ type: 'error', error: err });
      }
    } finally {
      busy = false;
      if (again && !dead) { again = false; tick(true); }
    }
  }

  async function schedule() {
    const stored = await getStored('settings');
    if (!stored) return;
    const { settings = {} } = stored;
    const sec = Math.max(30, Number(settings.intervalSec) || DEFAULT_INTERVAL);
    clearInterval(timer);
    timer = setInterval(tick, sec * 1000);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || dead) return;
    if (changes.settings) { schedule(); tick(true); } // a new deal % changes which listings count
    if (changes.watch) {
      const sig = list => (list || []).map(w => w.id + (w.paused ? 'p' : '')).join();
      if (sig(changes.watch.oldValue) !== sig(changes.watch.newValue)) tick(true); // added, removed, paused or resumed: now
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'search') {
      ask('search', { q: msg.q }).then(r => sendResponse({ ok: true, items: r }), e => sendResponse({ ok: false, error: e }));
      return true;
    }
    if (msg.type === 'pollNow') {
      tick(true).then(() => sendResponse({ ok: true }));
      return true;
    }
    if (msg.type === 'hello') { sendResponse({ ok: true, ready }); return false; }
    return false;
  });

  ask('ping', null, 90000)
    .then(() => { ready = true; schedule(); tick(); })
    .catch(err => send({ type: 'error', error: err }));
})();

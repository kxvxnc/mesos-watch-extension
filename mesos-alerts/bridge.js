// Runs in the extension's isolated world on mesos.watch. Owns the timer, asks the background whether this tab
// should check (so several open tabs don't all poll), relays requests to page.js and results to the background.
(() => {
  const TO_PAGE = 'mwa:to-page';
  const FROM_PAGE = 'mwa:from-page';

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
  const stop = () => { dead = true; for (const L of Object.values(loops)) clearInterval(L.timer); };
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

  let ready = false;

  // Two loops, each on its own timer: the watchlist and NX equips. One running doesn't hold the other up.
  // A check asked for now (an item added, a setting changed) while that loop's check runs: run it right after.
  const loops = {};
  function loop(name, intervalOf, body) {
    const L = loops[name] = { busy: false, again: false, timer: null };
    L.tick = async (force = false) => {
      if (!ready || dead) return;
      if (L.busy) { if (force) L.again = true; return; }
      L.busy = true;
      try { await body(force); }
      finally {
        L.busy = false;
        if (L.again && !dead) { L.again = false; L.tick(true); }
      }
    };
    L.schedule = settings => {
      clearInterval(L.timer);
      L.timer = setInterval(() => L.tick(), intervalOf(settings) * 1000);
    };
    return L;
  }

  // the watchlist: the summary, then the listings of items that may be under their max
  loop('watch', s => secOf(s.intervalSec), async force => {
    const stored = await getStored(['watch', 'settings']);
    if (!stored) return;
    const { watch = [], settings = {} } = stored;
    if (settings.paused || !watchOn(settings, watch)) return; // paused or off: no requests at all
    if (!(await send({ type: 'claim', force }))) return;
    try {
      const data = await ask('poll', { ids: watch.map(w => Number(w.id)) });
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
      await send({ type: 'result', data, hits, checked });
    } catch (err) {
      await send({ type: 'error', error: err });
    }
  });

  // NX equips (the site's Live feed widget reads them every 30 s): {max, rows, truncated} or {max, error}
  loop('nx', s => nxSecOf(s.nxIntervalSec), async force => {
    const stored = await getStored('settings');
    if (!stored) return;
    const { settings = {} } = stored;
    if (settings.paused || !nxOn(settings)) return;
    if (!(await send({ type: 'claim', force }))) return;
    const max = Number(settings.nxMax);
    let nx;
    try { nx = { max, ...(await ask('nx', { max })) }; }
    catch (err) { nx = { max, error: err }; }
    await send({ type: 'result', only: 'nx', nx });
  });

  // NX first: its request goes out ahead of the watchlist's, and they then run side by side
  const inOrder = () => ['nx', 'watch'].map(n => loops[n]);
  const tickAll = force => inOrder().forEach(L => L.tick(force));
  async function scheduleAll() {
    const stored = await getStored('settings');
    if (!stored) return;
    const settings = { ...MWA_DEFAULTS, ...(stored.settings || {}) };
    for (const L of Object.values(loops)) L.schedule(settings);
  }

  // which settings each loop depends on: a change to one checks that loop now
  const KEYS = { watch: ['paused', 'watchPaused', 'intervalSec', 'dealPct'], nx: ['paused', 'nxPaused', 'nxIntervalSec', 'nxMax'] };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || dead) return;
    if (changes.settings) {
      const a = changes.settings.oldValue || {}, b = changes.settings.newValue || {};
      scheduleAll();
      for (const [name, keys] of Object.entries(KEYS)) if (keys.some(k => a[k] !== b[k])) loops[name].tick(true);
    }
    if (changes.watch) {
      const sig = list => (list || []).map(w => w.id + (w.paused ? 'p' : '')).join();
      if (sig(changes.watch.oldValue) !== sig(changes.watch.newValue)) loops.watch.tick(true); // added, removed, paused or resumed: now
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'search') {
      ask('search', { q: msg.q }).then(r => sendResponse({ ok: true, items: r }), e => sendResponse({ ok: false, error: e }));
      return true;
    }
    if (msg.type === 'pollNow') {
      Promise.all(inOrder().map(L => L.tick(true))).then(() => sendResponse({ ok: true }));
      return true;
    }
    if (msg.type === 'hello') { sendResponse({ ok: true, ready }); return false; }
    return false;
  });

  ask('ping', null, 90000)
    .then(() => { ready = true; scheduleAll(); tickAll(false); })
    .catch(err => send({ type: 'error', error: err }));
})();

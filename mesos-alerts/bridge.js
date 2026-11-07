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

  // after the extension is reloaded, this old copy can't reach it any more: stop quietly
  let dead = false;
  const send = async msg => {
    if (dead) return undefined;
    try { return await chrome.runtime.sendMessage(msg); }
    catch (err) {
      if (!chrome.runtime || !chrome.runtime.id) { dead = true; clearInterval(timer); }
      return undefined;
    }
  };

  let ready = false, busy = false, timer = null;

  async function tick(force = false) {
    if (!ready || busy || dead) return;
    busy = true;
    try {
      const { watch = [], settings = {} } = await chrome.storage.local.get(['watch', 'settings']);
      if (!watch.length || settings.paused) return; // all alerts paused: no requests at all
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
          if (x && max > 0 && (mayBundle(w.id) || x.cheapest <= max)) need.push({ id: Number(w.id), max, min: hasMinStats(w.minStats) ? w.minStats : null });
        }
        const hits = need.length ? await ask('listings', { items: need }, 30000 + 15000 * need.length) : {};
        await send({ type: 'result', data, hits });
      } catch (err) {
        await send({ type: 'error', error: err });
      }
    } finally {
      busy = false;
    }
  }

  async function schedule() {
    const { settings = {} } = await chrome.storage.local.get('settings');
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

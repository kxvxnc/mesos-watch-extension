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
      const { watch = [] } = await chrome.storage.local.get('watch');
      if (!watch.length) return;
      if (!(await send({ type: 'claim', force }))) return;
      try {
        const data = await ask('poll', { ids: watch.map(w => Number(w.id)) });
        await send({ type: 'result', data });
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
    if (changes.settings) schedule();
    if (changes.watch) {
      const before = (changes.watch.oldValue || []).map(w => w.id).join();
      const after = (changes.watch.newValue || []).map(w => w.id).join();
      if (before !== after) tick(true); // an item was added or removed: fill it in now
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

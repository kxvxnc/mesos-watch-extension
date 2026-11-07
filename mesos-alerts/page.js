// Runs in the mesos.watch page itself (MAIN world), so it can call the site's own LIVE helpers.
// Those helpers carry the session cookie and renew it (Turnstile included) exactly as the site does.
// It only answers requests from bridge.js; it never polls on its own.
(() => {
  const TO_PAGE = 'mwa:to-page';
  const FROM_PAGE = 'mwa:from-page';

  // LIVE and ITEM are top-level consts in the site's scripts: reachable by name, not as window properties.
  const getLive = () => { try { return typeof LIVE !== 'undefined' ? LIVE : null; } catch { return null; } };
  const getItems = () => { try { return typeof ITEM !== 'undefined' ? ITEM : null; } catch { return null; } };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function waitLive() {
    for (let i = 0; i < 120; i++) {
      const L = getLive();
      if (L && typeof L.summary === 'function') {
        try { await L.ready; } catch { /* the site shows its own error state */ }
        return L;
      }
      await sleep(500);
    }
    throw new Error("Couldn't find the site's data layer (LIVE). mesos.watch may have changed.");
  }

  async function poll(ids) {
    const L = await waitLive();
    const out = {};
    for (let i = 0; i < ids.length; i += 60) {
      Object.assign(out, await L.summary(ids.slice(i, i + 60)));
    }
    const I = getItems() || {};
    for (const id in out) out[id].name = (I[id] && !I[id].unnamed && I[id].name) || null;
    return out;
  }

  // Every listing of each item at or under its max price each, on every channel, newest first. The API filters by the
  // price each (pmax), as the site's own price filter does; rows carry the bundle price, so it's checked again here
  // (a bundle of 100 for 5m is 50k each). A failed item comes back as null.
  async function listings(items) {
    const L = await waitLive();
    const out = {};
    for (const { id, max } of items) {
      try {
        const d = await L.browse({ item: id, pmax: Math.floor(max), sort: 'listed', dir: 'desc' });
        const rows = (d.rows || [])
          .filter(r => Number(r.id) === Number(id))
          .map(r => {
            const per = r.per || 1;
            return {
              store: r.s && r.s.id, slot: r.slot, price: r.price, per, bundles: r.bundles || 1, unit: r.price / per,
              ch: r.ch, r: r.r, owner: (r.s && r.s.owner) || null, seenAt: (r.s && r.s.seenAt) || null, listed: r.listed || null
            };
          })
          .filter(r => r.unit <= max)
          .sort((a, b) => (b.listed || 0) - (a.listed || 0));
        // one row per shop and price: a shop selling several stacks at the same price is one offer, as the site
        // folds them (stacks: how many, qty: how many items in all; the newest stack's listed time)
        const folded = new Map();
        for (const r of rows) {
          const k = `${r.store}|${r.price}|${r.per}`;
          const f = folded.get(k);
          if (f) { f.stacks++; f.qty += r.per * r.bundles; }
          else folded.set(k, { ...r, stacks: 1, qty: r.per * r.bundles });
        }
        out[id] = [...folded.values()];
      } catch {
        out[id] = null;
      }
    }
    return out;
  }

  let namesLoaded = null;
  async function search(q) {
    const L = await waitLive();
    if (!namesLoaded) namesLoaded = L.loadNames().catch(e => { namesLoaded = null; throw e; });
    await namesLoaded;
    const I = getItems() || {};
    const query = String(q || '').trim().toLowerCase();
    if (!query) return [];
    const hits = [];
    for (const id of L.names || []) {
      const it = I[id];
      if (!it || !it.name) continue;
      const name = it.name.toLowerCase();
      if (String(id) === query) hits.push([id, it.name, -1]);
      else if (name.includes(query)) hits.push([id, it.name, name.startsWith(query) ? 0 : 1]);
    }
    hits.sort((a, b) => a[2] - b[2] || a[1].length - b[1].length || a[1].localeCompare(b[1]));
    return hits.slice(0, 25).map(([id, name]) => [id, name]);
  }

  window.addEventListener('message', async e => {
    if (e.source !== window || !e.data || e.data.tag !== TO_PAGE) return;
    const { id, type, payload } = e.data;
    const reply = (ok, data) => window.postMessage({ tag: FROM_PAGE, id, ok, data }, location.origin);
    try {
      if (type === 'ping') { await waitLive(); reply(true, true); }
      else if (type === 'poll') reply(true, await poll(payload.ids));
      else if (type === 'listings') reply(true, await listings(payload.items));
      else if (type === 'search') reply(true, await search(payload.q));
      else reply(false, { message: 'unknown request ' + type });
    } catch (err) {
      reply(false, { message: String((err && err.message) || err), userMessage: (err && err.userMessage) || null });
    }
  });
})();

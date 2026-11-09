// Shared by background.js (importScripts) and popup.js (<script>).
const MWA_DEFAULTS = { intervalSec: 60, dealPct: 0, notify: true, webhook: '', discordOn: true, paused: false };

// a Discord channel webhook: https://discord.com/api/webhooks/<id>/<token> (also discordapp.com, canary., ptb.)
const MWA_WEBHOOK_ORIGINS = ['https://discord.com/api/webhooks/*', 'https://discordapp.com/api/webhooks/*',
  'https://canary.discord.com/api/webhooks/*', 'https://ptb.discord.com/api/webhooks/*'];
const isWebhookUrl = s => /^https:\/\/((canary|ptb)\.)?discord(app)?\.com\/api\/webhooks\/\d+\/[\w-]+\/?$/.test(String(s || '').trim());
const MWA_INBOX_CAP = 200;

// one offer: the same shop, price and bundle size (a shop's stacks of it are folded into one)
const listingKey = r => `${r.store}|${r.price}|${r.per}`;
const MWA_SITE = 'https://mesos.watch/';

// 1234 -> "1,234", 45000 -> "45k", 1250000 -> "1.25m", 2000000000 -> "2b"
function fmtMesos(n) {
  if (n == null || n === '' || isNaN(n)) return '—';
  n = Number(n);
  const trim = (v, d) => v.toFixed(d).replace(/\.?0+$/, '');
  if (n >= 1e9) return trim(n / 1e9, 2) + 'b';
  if (n >= 1e6) return trim(n / 1e6, 2) + 'm';
  if (n >= 1e4) return trim(n / 1e3, 1) + 'k';
  return Math.round(n).toLocaleString('en-US');
}

// "1.5m", "500k", "2b", "1,200,000" -> number; "" -> 0 (no target); junk -> NaN
function parseMesos(s) {
  s = String(s || '').trim().toLowerCase().replace(/[,\s_]/g, '');
  if (!s) return 0;
  const m = s.match(/^(\d+(?:\.\d+)?)([kmb])?$/);
  if (!m) return NaN;
  return Math.round(parseFloat(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1));
}

// the highest price (per item) that should alert: your target, or the deal % under typical, whichever is higher; 0 = none
function alertMax(target, typical, dealPct) {
  let m = target > 0 ? target : 0;
  if (dealPct > 0 && typical > 0) m = Math.max(m, typical * (1 - dealPct / 100));
  return m;
}

// a time in unix seconds (as the API sends them) -> "just now", "5m ago", "3h ago", "2d ago"
function agoS(sec) {
  const m = Math.max(0, Math.round((Date.now() / 1000 - sec) / 60));
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

// equips (IDs starting with 1) are never sold in bundles; everything else can be
const mayBundle = id => String(id)[0] !== '1';

// is this item's cheapest listing worth an alert?
function isUnder(x, target, dealPct) {
  if (!x || x.cheapest == null) return false;
  const max = alertMax(target, x.typical, dealPct);
  return max > 0 && x.cheapest <= max;
}

// Equip stats, in the site's order. A listing's stats look like {str: 5, watk: 2, slots: 7}; a missing stat is 0,
// missing slots is unknown. A watched equip's minStats ({str: 5, slots: 7}) are minimums every alert must meet.
const MWA_STATS = [['watk', 'W.ATK'], ['matk', 'M.ATK'], ['str', 'STR'], ['dex', 'DEX'], ['int', 'INT'], ['luk', 'LUK'],
  ['crit_rate', 'Crit rate'], ['crit_damage', 'Crit dmg'], ['acc', 'Accuracy'], ['avoid', 'Avoid'], ['speed', 'Speed'],
  ['jump', 'Jump'], ['hp', 'HP'], ['mp', 'MP'], ['wdef', 'W.DEF'], ['mdef', 'M.DEF'], ['slots', 'Slots']];
const MWA_STAT_LABEL = Object.fromEntries(MWA_STATS);
const isEquip = id => !mayBundle(id);
const hasMinStats = m => !!m && Object.keys(m).length > 0;

// the same rule as page.js uses while reading listings
function statsOk(st, min) {
  if (!hasMinStats(min)) return true;
  return Object.entries(min).every(([k, v]) => (k === 'slots' ? (st && st.slots != null ? st.slots : -1) : (st && st[k]) || 0) >= v);
}
// {str: 5, watk: 2, slots: 7} -> "STR 5 · W.ATK 2 · 7 slots" (non-zero stats only)
function statsText(st) {
  if (!st) return '';
  const parts = MWA_STATS.filter(([k]) => k !== 'slots' && st[k]).map(([k, l]) => `${l} ${st[k]}`);
  if (st.slots != null) parts.push(`${st.slots} slot${st.slots === 1 ? '' : 's'}`);
  return parts.join(' · ');
}
// {str: 5, slots: 7} -> "STR ≥ 5 · Slots ≥ 7"
const minStatsText = m => MWA_STATS.filter(([k]) => m && m[k] != null).map(([k, l]) => `${l} ≥ ${m[k]}`).join(' · ');
// a stable string for a filter, so changing it re-notes what's already listed ('' = none)
const minStatsSig = m => (hasMinStats(m) ? MWA_STATS.filter(([k]) => m[k] != null).map(([k]) => `${k}${m[k]}`).join(',') : '');

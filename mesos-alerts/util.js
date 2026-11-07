// Shared by background.js (importScripts) and popup.js (<script>).
const MWA_DEFAULTS = { intervalSec: 60, dealPct: 0, notify: true };
const MWA_HISTORY_CAP = 20000;
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

// is this item's cheapest listing worth an alert?
function isUnder(x, target, dealPct) {
  if (!x || x.cheapest == null) return false;
  if (target > 0 && x.cheapest <= target) return true;
  if (dealPct > 0 && x.typical > 0 && x.cheapest <= x.typical * (1 - dealPct / 100)) return true;
  return false;
}

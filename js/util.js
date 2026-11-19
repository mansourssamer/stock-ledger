// Small helpers shared by every screen.
import { lang } from './i18n.js';

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const sum = (arr, f) => arr.reduce((a, x) => a + (Number(f(x)) || 0), 0);

// Python's round(x, n): rounds the exact value, and an exact tie to the even digit.
// Used wherever the old app rounded, so balances come out to the same cent.
export function pyRound(x, n = 0) {
  if (!isFinite(x)) return x;
  const s = Math.abs(x).toFixed(20);
  const [, frac = ''] = s.split('.');
  if (frac[n] === '5' && /^0*$/.test(frac.slice(n + 1))) {
    const f = 10 ** n;
    const lo = Math.floor(Math.abs(x) * f);
    const r = (lo % 2 === 0 ? lo : lo + 1) / f;
    return x < 0 ? -r : r;
  }
  return Number(x.toFixed(n));
}

// ---------- numbers and money ----------
const nfCache = new Map();
function nf(dec) {
  const k = lang() + dec;
  if (!nfCache.has(k)) nfCache.set(k, new Intl.NumberFormat(lang() === 'fr' ? 'fr-FR' : 'en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }));
  return nfCache.get(k);
}
export const fmtNum = (n, dec = 0) => nf(dec).format(Number(n) || 0).replace(/ /g, ' ');
export function fmtQty(n) {
  const v = Number(n) || 0;
  return fmtNum(v, Number.isInteger(v) ? 0 : 2);
}
// Currencies: {code: {symbol, decimals}} filled from the currencies table.
export const CUR = {};
export function fmtMoney(amount, code = 'USD') {
  if (amount === null || amount === undefined || amount === '') return '—';
  const c = CUR[code] || { symbol: code === 'USD' ? '$' : code, decimals: 2 };
  const d = Number.isInteger(c.decimals) ? c.decimals : 2;
  const v = Number(amount) || 0;
  const body = fmtNum(Math.abs(v), d);
  const sign = v < 0 ? '−' : '';
  const sym = c.symbol || code;
  // Dollar and yuan signs go in front; franc symbols (FG) after, as written in Guinea.
  return /^[$¥€£]$/.test(sym) ? `${sign}${sym}${body}` : `${sign}${body} ${sym}`;
}
export const fmtUsd = n => fmtMoney(n, 'USD');
// Short form for tiles: 1,2 M · 450 k
export function fmtShort(n, code = 'USD') {
  const a = Math.abs(Number(n) || 0);
  const c = CUR[code] || { symbol: '$' };
  const sym = c.symbol || code;
  let body;
  if (a >= 1e9) body = fmtNum(a / 1e9, a >= 1e10 ? 0 : 1) + (lang() === 'fr' ? ' Md' : 'B');
  else if (a >= 1e6) body = fmtNum(a / 1e6, a >= 1e7 ? 0 : 1) + ' M';
  else if (a >= 1e4) body = fmtNum(a / 1e3, 0) + ' k';
  else body = fmtNum(a, a < 100 && c.decimals ? 2 : 0);
  const sign = n < 0 ? '−' : '';
  return /^[$¥€£]$/.test(sym) ? `${sign}${sym}${body}` : `${sign}${body} ${sym}`;
}
// Reads what someone typed: "1 234,5", "1,234.50", "1234" → number (NaN if empty/invalid).
export function parseNum(v) {
  if (typeof v === 'number') return v;
  let s = String(v ?? '').trim().replace(/[\s  ']/g, '');
  if (!s) return NaN;
  const commas = (s.match(/,/g) || []).length, dots = (s.match(/\./g) || []).length;
  if (commas && dots) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (commas === 1 && /,\d{1,2}$/.test(s)) s = s.replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = Number(s);
  return isFinite(n) ? n : NaN;
}

// ---------- dates ----------
const MON = {
  fr: ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'],
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
};
export function fmtDate(s, withYear = true) {
  if (!s) return '';
  const [y, m, d] = String(s).slice(0, 10).split('-');
  if (!d) return String(s);
  const mon = MON[lang()][+m - 1];
  return lang() === 'fr' ? `${+d} ${mon}${withYear ? ' ' + y : ''}` : `${+d} ${mon}${withYear ? ' ' + y : ''}`;
}
export const today = () => new Date().toISOString().slice(0, 10);
export function daysBetween(a, b) {
  return Math.round((Date.parse(String(b).slice(0, 10)) - Date.parse(String(a).slice(0, 10))) / 86400000);
}

export const opt = (v, label, sel) => `<option value="${esc(v)}"${sel ? ' selected' : ''}>${esc(label)}</option>`;

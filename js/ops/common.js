// Shared pieces for operations (the old app's form handlers, ported).
import { val } from '../localdb.js';
import { t } from '../i18n.js';

// A change refused with a reason for the person (nothing is changed).
export class UserError extends Error {
  constructor(msg) { super(msg); this.user = true; }
}
export const refuse = (msg, vars) => { throw new UserError(t(msg, vars)); };

// app._today — the business clock is UTC (Guinea time all year).
export const today = () => new Date().toISOString().slice(0, 10);
export const nowYear = () => new Date().getUTCFullYear();

// app._form_day — a typed date, checked: empty = today, future refused.
export function formDay(raw) {
  raw = String(raw || '').trim();
  if (!raw) return [today(), null];
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (!m) return [null, t('That date isn’t valid.')];
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return [null, t('That date isn’t valid.')];
  const day = raw.slice(0, 10);
  if (day > today()) return [null, t('That date is in the future.')];
  return [day, null];
}

// app._stamp — the chosen day with the time kept from the old value, or the clock's.
export function stamp(day, keepTimeFrom = null) {
  const old = String(keepTimeFrom || '');
  const clock = old.length >= 19 ? old.slice(11, 19) : val(`SELECT time('now')`);
  return `${day} ${clock}`;
}

// Whole numbers and amounts from forms (already parsed by the screen).
export function int(v, label = 'quantity') {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) refuse('Enter a whole number for the {label}.', { label: t(label) });
  return n;
}
export function num(v) {
  if (v === '' || v === null || v === undefined) return 0;
  const n = Number(v);
  if (!Number.isFinite(n)) refuse('That amount isn’t a number. Nothing was recorded.');
  return n;
}
export const asId = v => (v === '' || v === null || v === undefined ? null : (typeof v === 'number' || !/^\d+$/.test(String(v)) ? v : Number(v)));

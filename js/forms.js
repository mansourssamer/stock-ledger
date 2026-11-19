// Forms in a sheet over the page: openForm({title, fields, submit, run}). run(values) is an
// operation (it runs inside store.change, so a refusal changes nothing); its message shows as
// a toast, a refusal shows inside the form so nothing typed is lost.
import { esc, parseNum, $, today } from './util.js';
import { t } from './i18n.js';
import { change } from './store.js';

let current = null;
const host = () => document.getElementById('modals');

function fieldHtml(f, vals) {
  const id = 'f-' + f.name;
  const v = vals[f.name] ?? f.value ?? '';
  const lab = f.label ? `<label for="${id}">${esc(f.label)}</label>` : '';
  const hint = f.hint ? `<span class="hint">${esc(f.hint)}</span>` : '';
  const cls = f.full ? ' full' : '';
  if (f.show && !f.show(vals)) return '';
  switch (f.type) {
    case 'html': return `<div class="field full">${typeof f.html === 'function' ? f.html(vals) : f.html}</div>`;
    case 'hidden': return `<input type="hidden" id="${id}" name="${f.name}" value="${esc(v)}">`;
    case 'select': return `<div class="field${cls}">${lab}<select id="${id}" name="${f.name}" class="inp">${(f.options || []).map(([ov, ol]) =>
      `<option value="${esc(ov)}"${String(ov) === String(v) ? ' selected' : ''}>${esc(ol)}</option>`).join('')}</select>${hint}</div>`;
    case 'textarea': return `<div class="field full">${lab}<textarea id="${id}" name="${f.name}" class="inp" rows="2">${esc(v)}</textarea>${hint}</div>`;
    case 'checkbox': return `<label class="check full"><input type="checkbox" id="${id}" name="${f.name}"${v ? ' checked' : ''}> ${esc(f.label)}</label>${hint ? `<div class="full">${hint}</div>` : ''}`;
    case 'date': return `<div class="field${cls}">${lab}<input id="${id}" name="${f.name}" class="inp" type="date" value="${esc(v || '')}" max="${today()}">${hint}</div>`;
    case 'file': return `<div class="field full">${lab}<input id="${id}" name="${f.name}" type="file" accept="${esc(f.accept || '')}">${hint}</div>`;
    case 'number': case 'money': return `<div class="field${cls}">${lab}<input id="${id}" name="${f.name}" class="inp n" inputmode="decimal" autocomplete="off" value="${esc(v)}" placeholder="${esc(f.placeholder || '')}">${hint}</div>`;
    default: return `<div class="field${cls}">${lab}<input id="${id}" name="${f.name}" class="inp" type="${f.type || 'text'}" autocomplete="off" value="${esc(v)}" placeholder="${esc(f.placeholder || '')}">${hint}</div>`;
  }
}

function readValues(f0) {
  const out = { ...current.vals };
  for (const f of current.fields) {
    const el = document.getElementById('f-' + f.name);
    if (!el) continue;
    if (f.type === 'checkbox') out[f.name] = el.checked ? 1 : 0;
    else if (f.type === 'file') out[f.name] = el.files && el.files[0] ? el.files[0] : null;
    else if (f.type === 'number' || f.type === 'money') {
      const raw = el.value.trim();
      out[f.name] = raw === '' ? '' : (isNaN(parseNum(raw)) ? raw : parseNum(raw));
    } else out[f.name] = el.value;
  }
  void f0;
  return out;
}

function draw() {
  if (!current) { host().innerHTML = ''; document.body.classList.remove('locked'); return; }
  const c = current;
  host().innerHTML = `<div class="scrim" data-close="1"><div class="modal${c.wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(c.title)}" tabindex="-1">
    <div class="modal-h"><h2>${esc(c.title)}</h2><button type="button" class="btn ghost iconbtn" data-close="1" aria-label="${esc(t('Close'))}">✕</button></div>
    <form class="modal-b" id="modal-form" novalidate>
      ${c.intro ? `<div class="sub">${c.intro}</div>` : ''}
      <div class="form">${c.fields.map(f => fieldHtml(f, c.vals)).join('')}</div>
      ${c.err ? `<p class="errline" role="alert">${esc(c.err)}</p>` : ''}
    </form>
    <div class="modal-f"><button type="button" class="btn ghost" data-close="1">${esc(t('Cancel'))}</button>
      <button type="submit" form="modal-form" class="btn ${c.danger ? 'danger solid' : 'primary'}"${c.busy ? ' disabled' : ''}>${esc(c.busy ? t('Please wait…') : c.submit || t('Save'))}</button></div>
  </div></div>`;
  document.body.classList.add('locked');
  const first = host().querySelector('.modal-b input:not([type=hidden]):not([type=checkbox]), .modal-b select, .modal-b textarea');
  if (first && !c.focused) { first.focus(); c.focused = true; }
  // fields that show or hide others redraw the form, keeping what was typed
  for (const f of c.fields) {
    if (!f.redraw) continue;
    const el = document.getElementById('f-' + f.name);
    if (el) el.addEventListener('change', () => { c.vals = readValues(); draw(); });
  }
}

export function openForm(opts) {
  current = { fields: [], vals: {}, ...opts, err: '', busy: false, focused: false };
  for (const f of current.fields) if (f.value !== undefined && current.vals[f.name] === undefined) current.vals[f.name] = f.value;
  draw();
}
export const closeForm = () => { current = null; draw(); };

// A yes/no question for something that can't be undone easily.
export function confirmAction({ title, text, confirm, danger = true, run }) {
  openForm({ title, intro: esc(text), fields: [], submit: confirm, danger, run });
}

async function submit() {
  const c = current;
  if (!c || c.busy) return;
  const vals = readValues();
  c.vals = vals;
  c.busy = true; c.err = ''; draw();
  try {
    let res;
    if (c.prepare) await c.prepare(vals);            // async work before the change (e.g. shrinking a photo)
    res = await change(() => c.run(vals));
    current = null; draw();
    if (c.done) c.done(res, vals);
    else if (typeof res === 'string') window.dispatchEvent(new CustomEvent('sl-toast', { detail: res }));
  } catch (e) {
    if (!e.user) console.error(e);
    if (current === c) { c.busy = false; c.err = e.user ? e.message : t('Something went wrong: {e}', { e: e.message || String(e) }); draw(); }
  }
}

document.addEventListener('click', e => {
  if (!current) return;
  const x = e.target.closest('[data-close]');
  if (x && (x.dataset.close && (e.target === x || x.tagName === 'BUTTON'))) { e.preventDefault(); closeForm(); }
});
document.addEventListener('submit', e => {
  if (e.target.id !== 'modal-form') return;
  e.preventDefault();
  submit();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && current && !current.busy) closeForm(); });
export const formOpen = () => !!current;
export { $ };

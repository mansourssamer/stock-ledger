// Building blocks for screens: headers, tiles, tables, pills, empty states.
import { esc } from './util.js';
import { t } from './i18n.js';

export function header(title, { eyebrow = '', sub = '', actions = '', back = '' } = {}) {
  return `<div class="vh"><div>${back ? `<a class="backlink" href="#/${back}">‹ ${esc(t('Back'))}</a>` : ''}
    ${eyebrow ? `<div class="eyebrow">${esc(eyebrow)}</div>` : ''}<h1>${esc(title)}</h1>${sub ? `<p class="sub">${sub}</p>` : ''}</div>
    ${actions ? `<div class="actions">${actions}</div>` : ''}</div>`;
}
export const tile = (k, v, s = '', href = '', cls = '') =>
  `<${href ? `a href="#/${href}"` : 'div'} class="tile ${cls}"><span class="k">${esc(k)}</span><span class="v">${v}</span><span class="s">${s}</span></${href ? 'a' : 'div'}>`;
export const tiles = list => `<div class="tiles">${list.join('')}</div>`;
export function panel(title, body, { actions = '', tight = false } = {}) {
  return `<section class="panel">${title ? `<div class="panel-h"><h2>${esc(title)}</h2>${actions}</div>` : ''}<div class="panel-b${tight ? ' tight' : ''}">${body}</div></section>`;
}
export const pill = (text, cls = '') => `<span class="pill ${cls}">${esc(text)}</span>`;
export const empty = (title, text = '', action = '') =>
  `<div class="empty"><strong>${esc(title)}</strong>${text ? `<span>${esc(text)}</span>` : ''}${action}</div>`;

// cols: [{h: 'Header', n: true (number), cls: 'hide-sm'}]; rows: [{cells: [...html], href, cls}]
export function table(cols, rows, { foot = null, emptyText = '' } = {}) {
  if (!rows.length && emptyText) return `<div class="panel-b">${empty(emptyText)}</div>`;
  const th = cols.map(c => `<th class="${c.n ? 'n ' : ''}${c.cls || ''}">${esc(c.h)}</th>`).join('');
  const tr = rows.map(r => r.span ? `<tr class="${r.cls || ''}"><td colspan="${cols.length}">${r.cells[0]}</td></tr>` : `<tr class="${r.href ? 'click ' : ''}${r.cls || ''}"${r.href ? ` data-href="${esc(r.href)}"` : ''}>${r.cells.map((v, i) =>
    `<td class="${cols[i] && cols[i].n ? 'n ' : ''}${(cols[i] && cols[i].cls) || ''}">${v}</td>`).join('')}</tr>`).join('');
  const tf = foot ? `<tfoot><tr>${foot.map((v, i) => `<td class="${cols[i] && cols[i].n ? 'n ' : ''}${(cols[i] && cols[i].cls) || ''}">${v}</td>`).join('')}</tr></tfoot>` : '';
  return `<div class="scroll"><table class="tbl"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody>${tf}</table></div>`;
}
export const search = (id, value, placeholder) =>
  `<input id="${id}" class="inp search" type="search" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off">`;

// dom.js - tiny helpers shared by all screens. Text is always added as plain text nodes (never HTML strings).
import { ICON_PATHS } from './icons.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
export const $ = (id) => document.getElementById(id);

function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
}
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'value') value = v;
    else if (k === 'checked' || k === 'disabled') el[k] = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, kids);
  if (value !== undefined) el.value = value;
  return el;
}
export function icon(name, label) {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', '0 0 256 256');
  s.setAttribute('class', 'ic');
  if (label) { s.setAttribute('role', 'img'); s.setAttribute('aria-label', label); } else s.setAttribute('aria-hidden', 'true');
  for (const d of ICON_PATHS[name] || []) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    s.append(p);
  }
  return s;
}
// Keep keyboards from learning/suggesting what is typed (where iOS lets us).
export const NOASSIST = { autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false', 'data-lpignore': 'true', 'data-1p-ignore': 'true' };

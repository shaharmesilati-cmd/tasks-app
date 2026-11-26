// keypad.js - an on-screen number pad like the iPhone lock screen (digits only).
import { h, icon } from './dom.js';

let releaseCurrent = null;
export function releaseKeypad() { if (releaseCurrent) { releaseCurrent(); releaseCurrent = null; } }

// onSubmit(code) may return an error text (shown under the dots) or nothing.
export function keypadView({ prompt, hint, submitLabel = 'אישור', minLen = 4, maxLen = 40, autoLen = 0, onSubmit }) {
  releaseKeypad();
  let code = '';
  let busy = false;
  let locked = false;

  const dots = h('div', { class: 'dots', role: 'img', 'aria-label': '0 ספרות' });
  const msg = h('div', { class: 'err', role: 'alert' });
  const submit = h('button', { class: 'btn primary block', type: 'button', onclick: () => go() }, submitLabel);
  if (autoLen) submit.hidden = true; // opens by itself on the last digit
  const keyBtns = [];

  const paint = () => {
    dots.replaceChildren(...Array.from(code, () => h('i')));
    dots.setAttribute('aria-label', `${code.length} ספרות`);
    submit.disabled = busy || locked || code.length < (autoLen || minLen);
    keyBtns.forEach((b) => { b.disabled = busy || locked; });
  };
  const press = (d) => { if (busy || locked || code.length >= maxLen) return; code += d; msg.textContent = ''; paint(); if (autoLen && code.length === autoLen) setTimeout(go, 90); };
  const back = () => { if (busy || locked) return; code = code.slice(0, -1); paint(); };
  async function go() {
    if (submit.disabled) return;
    busy = true; paint();
    const c = code;
    let err = null;
    try { err = await onSubmit(c); } catch (e) { err = 'משהו השתבש, נסה שוב'; }
    busy = false; code = ''; paint();
    if (err) msg.textContent = err;
  }

  const key = (label, onclick, aria, cls = '') => {
    const b = h('button', { class: `key ${cls}`, type: 'button', 'aria-label': aria || label, onclick }, label);
    keyBtns.push(b); return b;
  };
  const digit = (d) => key(String(d), () => press(String(d)));
  const grid = h('div', { class: 'keys', dir: 'ltr' },
    [1, 2, 3, 4, 5, 6, 7, 8, 9].map(digit),
    h('span', { class: 'key spacer', 'aria-hidden': 'true' }),
    digit(0),
    (() => { const b = key('', back, 'מחק ספרה', 'ghost'); b.append(icon('backspace')); return b; })());

  const onKey = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^[0-9]$/.test(e.key)) { e.preventDefault(); press(e.key); }
    else if (e.key === 'Backspace') { e.preventDefault(); back(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (!autoLen) go(); }
  };
  document.addEventListener('keydown', onKey);
  releaseCurrent = () => document.removeEventListener('keydown', onKey);

  const el = h('div', { class: 'pad' }, h('p', { class: 'padprompt' }, prompt), dots, msg, hint ? h('p', { class: 'hint padhint' }, hint) : null, grid, submit);
  paint();
  return {
    el,
    setMessage(t) { msg.textContent = t || ''; },
    setLocked(on) { locked = on; paint(); },
  };
}

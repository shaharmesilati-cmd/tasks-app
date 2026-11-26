// ui.js - all screens. Every piece of text is put on screen as plain text nodes (never as HTML strings),
// so task text can never run as code. No network calls anywhere in this file.
import { $, h, icon, NOASSIST } from './dom.js';
import { keypadView, releaseKeypad } from './keypad.js';
import { Vault, idbBackend, makeExport, readExport, BadPasscodeError } from './vault.js';
import { makeGuard } from './guard.js';
import * as M from './model.js';

// ---------- state ----------
const guard = makeGuard(localStorage);
const S = {
  vault: new Vault(idbBackend()),
  data: null,
  undo: new M.UndoStack(30),
  hasVault: false, storageError: false,
  tab: 'home', scope: 'all', cat: '', catOpen: null, closedKind: 'done',
  openId: null, newForm: null, expanded: new Set(), q: '',
  setup: 'create', setupStep: 'enter', setupFirst: '',
  flow: null, dismiss: null, fold: new Map(), more: new Set(), remindPick: null, draft: null,
};
let idleTimer = null, waitTimer = null, toastTimer = null, lastActive = 0;

function restoreDraft() {
  const d = S.draft; S.draft = null;
  if (d && Date.now() - d.t < 120000) { S.newForm = { ...d.f, focus: false }; }
}
const isStandalone = () => window.navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
const lenHint = () => { try { const n = Number(localStorage.getItem('st.len')); return n >= 4 && n <= 40 ? n : 0; } catch (e) { return 0; } };
const setLen = (n) => { try { localStorage.setItem('st.len', String(n)); } catch (e) { /* ignore */ } };
const clearLen = () => { try { localStorage.removeItem('st.len'); } catch (e) { /* ignore */ } };
const today = () => M.dateStr(new Date());
const task = (id) => (S.data ? S.data.tasks.find((t) => t.id === id) : null);

// ---------- save / change ----------
function persist() {
  S.vault.save(S.data).catch(() => toast('השמירה נכשלה, השינוי האחרון לא נשמר!', { bad: true }));
}
function commit(fn, opts = {}) {
  if (!S.data) return; // app is locked: nothing to change
  S.undo.push(S.data);
  fn(S.data);
  persist();
  if (opts.render === false) refreshUndo(); else render();
}
function withTask(id, fn, opts) {
  commit((d) => { const t = d.tasks.find((x) => x.id === id); if (t) fn(t, d); }, opts);
}
function refreshUndo() { const b = $('undoBtn'); if (b) b.disabled = S.undo.size === 0; }
function doUndo() {
  if (!S.data) return;
  const snap = S.undo.pop();
  if (!snap) return;
  snap.settings = S.data.settings; // undo never reverts theme / lock-time
  S.data = M.validateData(snap);
  if (S.openId && !task(S.openId)) S.openId = null;
  persist(); render(); toast('הפעולה האחרונה בוטלה');
}

function toast(msg, opts = {}) {
  const t = $('toast');
  const depth = S.undo.size; // the undo button only works while nothing else was changed after it appeared
  const span = h('span', { class: opts.bad ? 'bad' : '' }, msg,
    opts.undo ? h('button', { class: 'tbtn', type: 'button', onclick: () => {
      t.replaceChildren();
      if (S.undo.size !== depth) { toast('כבר בוצעו שינויים אחרים. השתמש בכפתור הביטול למעלה', { bad: true }); return; }
      doUndo();
    } }, 'ביטול') : null);
  t.replaceChildren(span);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.replaceChildren(), opts.bad ? 6000 : opts.undo ? 5500 : 2600);
}

// ---------- dialogs ----------
function openDialog({ title, body, actions, dismiss }) {
  const root = $('dialogRoot');
  const prevFocus = document.activeElement;
  let overlay = null;
  // Only closes THIS dialog (a follow-up dialog opened by a button handler must survive).
  const close = () => {
    if (root.firstChild !== overlay) return;
    S.dismiss = null;
    root.replaceChildren();
    if (prevFocus && prevFocus.isConnected) prevFocus.focus();
  };
  const btns = actions.map((a) => h('button', {
    class: `btn ${a.kind || ''}`, type: 'button',
    onclick: async () => { const keep = a.onClick ? await a.onClick() : undefined; if (keep !== false) close(); },
  }, a.label));
  const dlg = h('div', { class: 'dlg', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('h2', null, title), body, h('div', { class: 'btns' }, btns));
  dlg.addEventListener('keydown', (e) => { if (e.key === 'Escape') { close(); if (dismiss) dismiss(); } });
  overlay = h('div', { class: 'overlay' }, dlg);
  S.dismiss = dismiss || null; // called if the app locks while this dialog is open
  root.replaceChildren(overlay);
  const first = dlg.querySelector('input') || btns[btns.length - 1];
  if (first) first.focus();
  return close;
}
function confirmBox({ title, text, ok = 'אישור', danger = false, cancel = 'ביטול' }) {
  return new Promise((resolve) => {
    openDialog({
      title, body: h('p', null, text), dismiss: () => resolve(false),
      actions: [
        { label: cancel, onClick: () => resolve(false) },
        { label: ok, kind: danger ? 'danger' : 'primary', onClick: () => resolve(true) },
      ],
    });
  });
}
// Asks for one line of text (category name etc.). Resolves to the text, or null if cancelled.
function textDialog({ title, label, value = '', ok = 'שמור', extra = null }) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', 'aria-label': label, placeholder: label, value, maxlength: '40', ...NOASSIST });
    const err = h('div', { class: 'err', role: 'alert' });
    const submit = () => {
      if (!input.value.trim()) { err.textContent = 'צריך לכתוב שם'; input.focus(); return false; }
      resolve(input.value);
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (submit() !== false) $('dialogRoot').replaceChildren(); } });
    const actions = [{ label: 'ביטול', onClick: () => resolve(null) }];
    if (extra) actions.push(extra);
    actions.push({ label: ok, kind: 'primary', onClick: submit });
    openDialog({ title, body: h('div', { class: 'field' }, input, err), dismiss: () => resolve(null), actions });
  });
}

// ---------- locking ----------
function lock() {
  clearTimeout(idleTimer);
  // Blur FIRST so a half-typed field is committed (and queued for saving) before the key is dropped.
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  if (S.dismiss) { const d = S.dismiss; S.dismiss = null; d(); } // let open dialogs forget typed values
  S.vault.lock();
  S.data = null;
  S.undo.clear();
  // Keep an unsent new-task form in memory only for 2 minutes, so a quick app switch does not lose typing.
  S.draft = S.newForm && S.newForm.title.trim() + S.newForm.desc.trim() ? { f: S.newForm, t: Date.now() } : null;
  S.q = ''; S.openId = null; S.newForm = null; S.flow = null; S.catOpen = null; S.cat = ''; S.scope = 'all';
  S.expanded.clear(); S.fold.clear(); S.more.clear(); S.remindPick = null; S.setupFirst = ''; S.setupStep = 'enter';
  $('dialogRoot').replaceChildren();
  $('toast').replaceChildren();
  render();
}
function bumpIdle() {
  clearTimeout(idleTimer);
  if (!S.data) return;
  const limit = (S.data.settings.autoLockSec || 60) * 1000;
  // iOS can pause timers; check the clock too, so idle time that really passed still locks.
  if (lastActive && Date.now() - lastActive > limit + 1500) { lock(); return; }
  lastActive = Date.now();
  idleTimer = setTimeout(lock, limit);
}

// ---------- formatting ----------
function dueText(due, now) {
  const d = M.diffDays(due, now);
  if (d === 0) return 'היום';
  if (d === 1) return 'מחר';
  if (d === -1) return 'אתמול';
  if (d < 0) return `באיחור ${-d} ימים`;
  return M.parseDate(due).toLocaleDateString('he-IL', { weekday: 'short', day: 'numeric', month: 'numeric' });
}
function fmtTime(iso) {
  try { return new Date(iso).toLocaleString('he-IL', { day: 'numeric', month: 'numeric', year: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  catch (e) { return iso; }
}
const bar = (pct) => h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': 'התקדמות' },
  (() => { const i = h('i'); i.style.width = `${pct}%`; return i; })());

// ---------- task actions (one source of truth for every screen) ----------
async function tryComplete(id) {
  const t = task(id);
  if (!t) return;
  const open = M.openSubCount(t);
  if (open > 0) {
    const ok = await confirmBox({ title: 'יש תתי-משימות שלא בוצעו', text: `נשארו ${open} תתי-משימות שלא בוצעו. להשלים את המשימה בכל זאת?`, ok: 'השלם בכל זאת' });
    if (!ok) return;
  }
  let res = {};
  commit((d) => {
    const x = d.tasks.find((z) => z.id === id);
    res = M.completeTask(x);
    if (res.completedCopy) d.tasks.push(res.completedCopy);
  });
  const noDate = !res.nextDue && t.repeat !== 'none' && !t.due;
  toast(res.nextDue ? `בוצע. המופע הבא: ${dueText(res.nextDue, today())}` : noDate ? 'הושלמה. לא תחזור כי אין לה תאריך יעד' : 'המשימה הושלמה ועברה ל"הושלמו"', { undo: true });
}
function reopen(id) { withTask(id, (t) => M.setStatus(t, 'todo')); toast('המשימה נפתחה מחדש'); }
function animateThen(e, t, fn) {
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || M.isClosedStatus(t.status)) { fn(); return; }
  const li = e.currentTarget.closest('li');
  if (!li || li.classList.contains('completing')) return;
  li.classList.add('completing');
  setTimeout(fn, 420);
}
function toggleSub(id, nid) {
  commit((d) => { const t = d.tasks.find((x) => x.id === id); const f = t && M.findNode(t.subtasks, nid); if (f) { M.setNodeState(f.node, 'done'); M.addLog(t, `תת-משימה "${f.node.title}": הושלמה`); } });
  toast('תת-המשימה הושלמה', { undo: true });
}
function toggleTask(id) { const t = task(id); if (!t) return; if (M.isClosedStatus(t.status)) reopen(id); else tryComplete(id); }

async function deleteTask(id) {
  const t = task(id);
  const n = t ? M.progress(t).total + M.progress(t).cancelled : 0;
  const ok = await confirmBox({
    title: 'מחיקת משימה', danger: true, ok: 'מחק',
    text: n ? `המשימה ו-${n} תתי-המשימות שלה יימחקו. אפשר לבטל מיד אחרי המחיקה.` : 'המשימה תימחק. אפשר לבטל מיד אחרי המחיקה.',
  });
  if (!ok) return;
  S.openId = null;
  commit((d) => { d.tasks = d.tasks.filter((x) => x.id !== id); });
  toast('המשימה נמחקה', { undo: true });
}

async function newCategory(cb) {
  const name = await textDialog({ title: 'קטגוריה חדשה', label: 'שם הקטגוריה (למשל: פרויקט, יחידה)', ok: 'הוסף' });
  if (!name) return;
  let c = null;
  commit((d) => { c = M.addCategory(d, name); }, { render: false });
  if (!c) { toast('לא ניתן להוסיף קטגוריה', { bad: true }); return; }
  cb(c.id);
}
function catChips(current, onPick) {
  const d = S.data;
  return h('div', { class: 'chips wrap', role: 'group', 'aria-label': 'קטגוריה' },
    [['', 'ללא'], ...d.categories.map((c) => [c.id, c.name])].map(([id, l]) =>
      h('button', { class: 'chip', type: 'button', 'aria-pressed': String(current === id), onclick: () => onPick(id) }, l)),
    h('button', { class: 'chip', type: 'button', onclick: () => newCategory(onPick) }, '+ חדשה'));
}

// ---------- shared pieces ----------
function topbar(title, { back, showUndo = true, sub = '' } = {}) {
  if (!back) {
    return h('header', { class: 'top big' },
      h('div', { class: 'titles' }, h('h1', null, title), sub ? h('p', { class: 'sub' }, sub) : null),
      h('div', { class: 'acts' },
        showUndo ? h('button', { class: 'iconbtn', id: 'undoBtn', type: 'button', 'aria-label': 'ביטול פעולה אחרונה', disabled: S.undo.size === 0, onclick: doUndo }, icon('arrow-counter-clockwise')) : null,
        h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'נעל עכשיו', onclick: lock }, icon('lock-simple'))));
  }
  return h('header', { class: 'top' },
    back ? h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'חזרה', onclick: back }, icon('caret-right')) : null,
    h('h1', null, title),
    showUndo ? h('button', { class: 'iconbtn', id: 'undoBtn', type: 'button', 'aria-label': 'ביטול פעולה אחרונה', disabled: S.undo.size === 0, onclick: doUndo }, icon('arrow-counter-clockwise')) : null,
    h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'נעל עכשיו', onclick: lock }, icon('lock-simple')));
}

function taskCard(t, now, opts = {}) {
  const closed = M.isClosedStatus(t.status);
  const cancelled = t.status === 'cancelled';
  const late = M.isOverdue(t, now);
  const p = M.progress(t);
  const meta = [];
  if (t.isSub) meta.push(h('span', { class: 'm' }, icon('list-checks'), `מתוך: ${t.parentTitle}`));
  if (cancelled) meta.push(h('span', { class: 'm' }, icon('x-circle'), 'בוטל'));
  else if (!closed && !t.isSub) meta.push(h('span', { class: `m p${t.priority}` }, icon('flag'), M.PRIORITIES[t.priority]));
  if (!closed && t.status !== 'todo') meta.push(h('span', { class: 'm' }, M.statusLabel(t.status)));
  if (t.category) meta.push(h('span', { class: 'm cat' }, icon('folder-simple'), M.catName(S.data, t.category)));
  if (closed && t.completedAt) meta.push(h('span', { class: 'm' }, fmtTime(t.completedAt)));
  if (!closed && t.due) meta.push(h('span', { class: `m${late ? ' late' : ''}` }, icon(late ? 'warning' : 'calendar-check'), dueText(t.due, now)));
  if (!closed && t.remindDate) meta.push(h('span', { class: `m${t.remindDate <= now ? ' late' : ''}` }, icon('clock'), `תזכורת: ${dueText(t.remindDate, now)}${t.remindAt ? ' ' + t.remindAt : ''}`));
  if (t.repeat !== 'none') meta.push(h('span', { class: 'm' }, icon('repeat'), M.REPEATS.find((r) => r.id === t.repeat).label));
  t.tags.forEach((g) => meta.push(h('span', { class: 'm' }, icon('tag'), g)));
  if (p.total || p.cancelled) meta.push(h('span', { class: 'm' }, `${p.done} מתוך ${p.total} הושלמו${p.cancelled ? ` · ${p.cancelled} בוטלו` : ''}`));
  return h('li', { class: `card pr${t.priority}${late ? ' late' : ''}${closed ? ' closed' : ''}${cancelled ? ' cancelled' : ''}` },
    h('button', { class: 'cbtn', type: 'button', 'aria-label': closed ? `פתח מחדש: ${t.title}` : `סמן כהושלם: ${t.title}`, onclick: (e) => animateThen(e, t, () => (t.isSub ? toggleSub(t.id, t.nodeId) : toggleTask(t.id))) },
      h('span', { class: `circle${closed ? ' on' : ''}${cancelled ? ' x' : ''}` }, icon(cancelled ? 'x' : 'check'))),
    h('button', { class: 'open', type: 'button', onclick: () => { S.openId = t.id; render(); window.scrollTo(0, 0); } },
      h('div', { class: 'ttl' }, t.title || '(ללא כותרת)'), h('div', { class: 'meta' }, meta), p.total && !closed ? bar(p.pct) : null),
    opts.dismiss ? h('button', { class: 'pill', type: 'button', 'aria-label': `סמן תזכורת כטופלה: ${t.title}`, onclick: () => { withTask(t.id, (x) => { const f = t.isSub ? M.findNode(x.subtasks, t.nodeId) : null; const o = f ? f.node : x; o.remindDate = ''; o.remindAt = ''; M.addLog(x, 'התזכורת טופלה'); }); toast('התזכורת הוסרה', { undo: true }); } }, 'טופל') : null);
}
const taskList = (list, now, opts) => h('ul', { class: 'list' }, list.map((t) => taskCard(t, now, opts)));
function section(title, list, now, cls = '') {
  if (!list.length) return null;
  return h('section', null, h('h2', { class: `sec ${cls}` }, cls === 'danger' ? icon('warning') : null, title, h('span', { class: 'count' }, String(list.length))), taskList(list, now));
}

// Home sections: the urgent groups stay open, the rest fold away when there are many tasks, so the screen never feels like a wall.
const CROWDED = 8, SHOW_FIRST = 8;
function foldSection(sec, now, { crowded, forceOpen, idx }) {
  const id = sec.id;
  const urgent = id === 'overdue' || id === 'remind' || id === 'today';
  const defOpen = forceOpen || !crowded || urgent || (idx < 2 && !['soon', 'later', 'nodate'].includes(id));
  const open = S.fold.has(id) ? S.fold.get(id) : defOpen;
  const danger = id === 'overdue';
  const total = sec.tasks.length;
  const showAll = S.more.has(id) || total <= SHOW_FIRST + 2;
  const shown = open ? (showAll ? sec.tasks : sec.tasks.slice(0, SHOW_FIRST)) : [];
  const preview = !open ? sec.tasks.slice(0, 2).map((t) => t.title).join(' · ') : '';
  return h('section', { class: `fsec${open ? ' open' : ''}` },
    h('button', { class: `sechead${danger ? ' danger' : ''}`, type: 'button', 'aria-expanded': String(open), onclick: () => { S.fold.set(id, !open); render(); } },
      icon(open ? 'caret-down' : 'caret-left'),
      danger ? icon('warning') : id === 'remind' ? icon('clock') : null,
      h('span', { class: 'st' }, sec.title),
      !open && preview ? h('span', { class: 'pv' }, preview) : null,
      h('span', { class: 'count' }, String(total))),
    open ? taskList(shown, now, id === 'remind' ? { dismiss: true } : undefined) : null,
    open && !showAll ? h('button', { class: 'linkrow more', type: 'button', onclick: () => { S.more.add(id); render(); } }, `הצג עוד ${total - SHOW_FIRST}`) : null);
}
const VIEWS = [['time', 'לפי זמן'], ['cat', 'לפי קטגוריה'], ['prio', 'לפי עדיפות']];
function regroup(sections, view) {
  const all = sections.flatMap((s) => s.tasks);
  const byPrio = (a, b) => b.priority - a.priority;
  if (view === 'prio') {
    return [3, 2, 1, 0].map((p) => ({ id: `p${p}`, title: M.PRIORITIES[p], tasks: all.filter((t) => t.priority === p) })).filter((x) => x.tasks.length);
  }
  const cats = [...S.data.categories.map((c) => ({ id: `c${c.id}`, title: c.name, tasks: all.filter((t) => t.category === c.id).sort(byPrio) })),
    { id: 'cnone', title: 'ללא קטגוריה', tasks: all.filter((t) => !t.category).sort(byPrio) }];
  return cats.filter((x) => x.tasks.length);
}

function fab(label, onclick) {
  return h('button', { class: 'fab', type: 'button', 'aria-label': label, onclick }, icon('plus'), h('span', null, label));
}
function openNew(cat = '') {
  S.newForm = { title: '', when: 'none', date: '', remind: '', remindDate: '', remindTime: '', priority: 1, category: cat, desc: '', repeat: 'none', focus: true };
  render(); window.scrollTo(0, 0);
}

const NAV = [['home', 'משימות', 'list-checks'], ['cats', 'קטגוריות', 'folder-simple'], ['closed', 'הושלמו', 'check-circle'], ['search', 'חיפוש', 'magnifying-glass'], ['settings', 'הגדרות', 'gear']];
function navBar(now) {
  const late = M.overdue(S.data.tasks, now).length;
  return h('nav', { class: 'nav', 'aria-label': 'ניווט ראשי' }, NAV.map(([id, label, ic]) =>
    h('button', { type: 'button', 'aria-current': S.tab === id && !S.catOpen ? 'page' : (S.tab === id ? 'true' : null),
      onclick: () => { S.tab = id; S.q = ''; S.catOpen = null; $('toast').replaceChildren(); render(); window.scrollTo(0, 0); } },
      icon(ic), label,
      id === 'home' && late ? h('span', { class: 'badge', 'aria-label': `${late} באיחור` }, String(late)) : null)));
}

// ---------- home: ALL open tasks, with today's numbers on top ----------
function homeScreen(now) {
  const d = S.data;
  const sm = M.summary(d.tasks, now);
  const tile = (id, label, n, cls = '') => h('button', { class: `tile ${cls}`, type: 'button', 'aria-pressed': String(S.scope === id),
    onclick: () => { S.scope = S.scope === id ? 'all' : id; render(); } },
    h('span', { class: 'num' }, String(n)), h('span', { class: 'lbl' }, label));
  const tiles = h('div', { class: 'tiles', role: 'group', 'aria-label': 'סינון לפי זמן' },
    tile('overdue', 'באיחור', sm.overdue, sm.overdue ? 'late' : ''), tile('today', 'היום', sm.today), tile('week', '7 ימים', sm.week), tile('all', 'כל הפתוחות', sm.open));
  const chips = d.categories.length ? h('div', { class: 'chips', role: 'group', 'aria-label': 'קטגוריה' },
    [['', 'הכול'], ...d.categories.map((c) => [c.id, c.name]), ['none', 'ללא קטגוריה']].map(([id, l]) =>
      h('button', { class: 'chip', type: 'button', 'aria-pressed': String(S.cat === id), onclick: () => { S.cat = id; render(); } }, l))) : null;
  const timeSections = M.homeSections(d.tasks, now, { scope: S.scope, cat: S.cat });
  const view = d.settings.view || 'time';
  const sections = view === 'time' ? timeSections : regroup(timeSections, view);
  const crowded = sm.open > CROWDED && S.scope === 'all' && !S.cat;
  const viewSwitch = sm.open > 4 ? h('div', { class: 'viewseg', role: 'group', 'aria-label': 'תצוגה' }, VIEWS.map(([v, l]) =>
    h('button', { type: 'button', 'aria-pressed': String(view === v), onclick: () => { commit((x) => { x.settings.view = v; }); } }, l))) : null;
  let backup = null;
  if (d.tasks.length >= 3) {
    const last = d.settings.lastExport;
    const days = last ? M.diffDays(now, last) : null;
    if (days === null || days >= 14) {
      backup = h('button', { class: 'notice backup', type: 'button', onclick: () => { S.tab = 'settings'; render(); window.scrollTo(0, 0); } },
        icon('download-simple'), days === null ? 'עוד לא יצרת גיבוי מוצפן. לחץ כאן, כדי שהמשימות לא ילכו לאיבוד.' : `הגיבוי האחרון לפני ${days} ימים. לחץ ליצירת גיבוי חדש.`);
    }
  }
  let note = null;
  if (S.scope === 'all' && !S.cat && sm.today === 0 && sm.overdue === 0 && sm.open > 0) {
    note = h('p', { class: 'notice', role: 'status' }, `אין משימות מתוזמנות להיום, אבל יש ${sm.open} משימות פתוחות אחרות.`);
  }
  let empty = null;
  if (!sections.length) {
    empty = !d.tasks.length
      ? h('div', { class: 'hero' }, h('div', { class: 'bubble' }, icon('list-checks')), h('h2', null, 'עוד אין משימות'),
        h('p', null, 'הוסף את הראשונה, ואפשר לפרק אותה לשלבים.'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => openNew('') }, icon('plus'), 'הוסף משימה'))
      : h('div', { class: 'empty' }, h('p', null, S.scope === 'all' && !S.cat ? 'אין משימות פתוחות.' : 'אין משימות במסנן הזה.'),
        S.scope !== 'all' || S.cat ? h('button', { class: 'btn', type: 'button', onclick: () => { S.scope = 'all'; S.cat = ''; render(); } }, 'הצג את כל הפתוחות') : null);
  }
  return h('main', { class: 'main' }, tiles, backup, viewSwitch, chips, note,
    sections.map((s, i) => foldSection(s, now, { crowded, forceOpen: S.scope !== 'all' || !!S.cat, idx: i })), empty,
    sm.closed ? h('button', { class: 'linkrow', type: 'button', onclick: () => { S.tab = 'closed'; render(); window.scrollTo(0, 0); } },
      icon('check-circle'), `הושלמו ובוטלו: ${sm.closed}. הצג`) : null,
    fab('משימה חדשה', () => openNew(S.cat && S.cat !== 'none' ? S.cat : '')));
}

// ---------- categories ----------
function catsScreen() {
  const d = S.data;
  const stats = M.categoryStats(d).filter((r) => r.id !== 'none' || r.open + r.closed > 0);
  return h('main', { class: 'main' },
    d.categories.length ? null : h('p', { class: 'notice' }, 'קטגוריות מחלקות משימות לפי נושא, למשל פרויקט או יחידה. הוסף את הראשונה.'),
    h('ul', { class: 'list' }, stats.map((r) => h('li', null,
      h('button', { class: 'catrow', type: 'button', onclick: () => { S.catOpen = r.id; render(); window.scrollTo(0, 0); } },
        h('span', { class: 'grow' }, h('strong', null, r.name), h('span', { class: 'muted' }, ` ${r.open} פתוחות${r.closed ? ` · ${r.closed} הושלמו` : ''}`)),
        icon('caret-left'))))),
    h('button', { class: 'btn primary block gap', type: 'button', onclick: () => newCategory((id) => { S.catOpen = id; render(); }) }, icon('plus'), 'קטגוריה חדשה'));
}
async function editCategory(id) {
  const c = S.data.categories.find((x) => x.id === id);
  if (!c) return;
  const name = await textDialog({
    title: 'עריכת קטגוריה', label: 'שם הקטגוריה', value: c.name, ok: 'שמור',
    extra: { label: 'מחק קטגוריה', kind: 'danger', onClick: () => {
      setTimeout(async () => {
        const ok = await confirmBox({ title: 'מחיקת קטגוריה', danger: true, ok: 'מחק', text: 'הקטגוריה תימחק, והמשימות שבה יישארו בלי קטגוריה. אפשר לבטל מיד אחרי.' });
        if (!ok) return;
        S.catOpen = null;
        commit((d) => M.deleteCategory(d, id));
        toast('הקטגוריה נמחקה', { undo: true });
      }, 0);
    } },
  });
  if (!name) return;
  let ok = true;
  commit((d) => { ok = M.renameCategory(d, id, name); });
  if (!ok) toast('כבר יש קטגוריה בשם הזה', { bad: true });
}
function catScreen(now) {
  const d = S.data; const id = S.catOpen;
  const name = id === 'none' ? 'ללא קטגוריה' : M.catName(d, id);
  if (!name) { S.catOpen = null; return catsScreen(); }
  const all = M.categoryTasks(d, id);
  const sections = M.homeSections(all, now, { scope: 'all', cat: '' });
  const closed = all.filter(M.isClosed).sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''));
  return h('div', null,
    h('header', { class: 'top' },
      h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'חזרה לקטגוריות', onclick: () => { S.catOpen = null; render(); } }, icon('caret-right')),
      h('h1', null, name),
      id !== 'none' ? h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'עריכת קטגוריה', onclick: () => editCategory(id) }, icon('pencil-simple')) : null,
      h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'נעל עכשיו', onclick: lock }, icon('lock-simple'))),
    h('main', { class: 'main' },
      sections.map((s) => section(s.title, s.tasks, now, s.id === 'overdue' ? 'danger' : '')),
      sections.length ? null : h('p', { class: 'empty' }, 'אין כאן משימות פתוחות.'),
      closed.length ? h('details', { class: 'fold' }, h('summary', null, `הושלמו ובוטלו (${closed.length})`), taskList(closed, now)) : null,
      fab('משימה חדשה', () => openNew(id === 'none' ? '' : id))),
    navBar(now));
}

// ---------- completed / cancelled ----------
function closedScreen(now) {
  const d = S.data;
  const kinds = [['done', 'הושלמו'], ['cancelled', 'בוטלו'], ['archive', 'ארכיון']];
  const list = M.closedList(d.tasks, S.closedKind);
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'סוג' }, kinds.map(([id, l]) =>
    h('button', { class: 'chip', type: 'button', 'aria-pressed': String(S.closedKind === id), onclick: () => { S.closedKind = id; render(); } },
      `${l} (${M.closedList(d.tasks, id).length})`)));
  return h('main', { class: 'main' }, chips,
    list.length && S.closedKind !== 'archive' ? h('button', { class: 'btn block gap', type: 'button', onclick: archiveAll }, icon('archive'), 'העבר את כולן לארכיון') : null,
    list.length ? taskList(list, now) : h('p', { class: 'empty' }, S.closedKind === 'archive' ? 'הארכיון ריק.' : 'עוד אין כאן משימות. כשתסמן משימה כהושלמה היא תופיע כאן ולא תיעלם.'),
    list.length ? h('p', { class: 'hint' }, 'לחיצה על העיגול פותחת את המשימה מחדש.') : null);
}
async function archiveAll() {
  const list = M.closedList(S.data.tasks, S.closedKind);
  if (!list.length) return;
  const ok = await confirmBox({ title: 'העברה לארכיון', text: `${list.length} משימות יועברו לארכיון. הן לא נמחקות ואפשר לראות אותן שם.`, ok: 'העבר' });
  if (!ok) return;
  const ids = new Set(list.map((t) => t.id));
  commit((d) => d.tasks.forEach((t) => { if (ids.has(t.id)) { t.archived = true; M.addLog(t, 'הועברה לארכיון'); } }));
  toast('הועברו לארכיון', { undo: true });
}

// ---------- search ----------
function searchScreen(now) {
  const results = h('div');
  const run = () => {
    const found = S.q.trim() ? M.search(S.data.tasks, S.q, S.data) : [];
    results.replaceChildren(S.q.trim()
      ? (found.length ? h('div', null, h('p', { class: 'hint', role: 'status' }, `נמצאו ${found.length}`), taskList(found, now)) : h('p', { class: 'empty', role: 'status' }, 'לא נמצא כלום.'))
      : h('p', { class: 'empty' }, 'החיפוש מכסה כותרות, תיאורים, קטגוריות, תתי-משימות והערות, גם של משימות שהושלמו. הוא לא נשמר.'));
  };
  const input = h('input', { type: 'text', id: 'searchInput', placeholder: 'חפש בכל המשימות', 'aria-label': 'חיפוש', ...NOASSIST, value: S.q, maxlength: '200' });
  input.setAttribute('enterkeyhint', 'search');
  input.addEventListener('input', () => { S.q = input.value; run(); });
  run();
  const main = h('main', { class: 'main' }, h('div', { class: 'quick' }, input), results);
  if (!S.q) setTimeout(() => input.focus(), 0);
  return main;
}

// ---------- settings ----------
function settingsScreen() {
  const st = S.data.settings;
  const sel = (opts, cur, onchange, label) => h('select', { 'aria-label': label, onchange: (e) => onchange(e.target.value) },
    opts.map(([v, l]) => h('option', { value: String(v), ...(String(cur) === String(v) ? { selected: true } : {}) }, l)));
  const persistedNote = h('p', { class: 'hint', id: 'persistNote' }, '');
  if (navigator.storage && navigator.storage.persisted) {
    navigator.storage.persisted().then((p) => { const el = $('persistNote'); if (el) el.textContent = p ? 'האחסון מסומן כקבוע (פחות סיכוי שהמערכת תמחק אותו).' : 'האחסון לא מסומן כקבוע. המערכת עלולה למחוק אותו אם לא משתמשים בו זמן רב, לכן כדאי לייצא גיבוי מוצפן מדי פעם.'; });
  }
  return h('main', { class: 'main' },
    h('h2', { class: 'sec' }, 'נעילה ומראה'),
    h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'נעילה אוטומטית אחרי חוסר פעילות'),
      sel([[15, '15 שניות'], [30, '30 שניות'], [60, 'דקה'], [120, '2 דקות'], [300, '5 דקות']], st.autoLockSec, (v) => { commit((d) => { d.settings.autoLockSec = Number(v); }, { render: false }); bumpIdle(); }, 'זמן נעילה')),
    h('p', { class: 'hint' }, 'מעבר לרקע נועל תמיד מיד.'),
    h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'מראה'),
      sel([['auto', 'אוטומטי (לפי המכשיר)'], ['light', 'בהיר'], ['dark', 'כהה']], st.theme, (v) => { commit((d) => { d.settings.theme = v; }, { render: false }); applyTheme(); }, 'מראה')),
    h('button', { class: 'btn block', type: 'button', onclick: () => { S.flow = { type: 'change', step: 'old', old: '', neu: '' }; render(); window.scrollTo(0, 0); } }, icon('lock-simple-open'), 'החלפת קוד גישה'),
    h('h2', { class: 'sec' }, 'גיבוי ידני'),
    h('p', { class: 'hint' }, 'הגיבוי נשמר לקובץ מוצפן עם סיסמה נפרדת, רק כשאתה מבקש. שום דבר לא נשלח לשום מקום.'),
    h('button', { class: 'btn block', type: 'button', onclick: doExport }, icon('download-simple'), 'ייצוא לקובץ מוצפן'),
    h('button', { class: 'btn block gap', type: 'button', onclick: () => pickImportFile((txt) => importInto(txt)) }, icon('upload-simple'), 'ייבוא מקובץ גיבוי'),
    persistedNote,
    h('h2', { class: 'sec' }, 'מחיקה'),
    h('button', { class: 'btn block danger', type: 'button', onclick: () => wipeAll() }, icon('trash'), 'מחק הכול (כולל מפתחות ההצפנה)'),
    h('h2', { class: 'sec' }, 'מה מוגן ומה לא'),
    h('ul', { class: 'hint' },
      h('li', null, 'הנתונים נשמרים מוצפנים ב-AES-256-GCM, והמפתח נגזר מהקוד שלך ולא נשמר בשום מקום.'),
      h('li', null, 'האפליקציה לא מתחברת לשום שרת, ואין בה אנליטיקס או דיווחי קריסות.'),
      h('li', null, 'אי אפשר לחסום צילום מסך באייפון. התוכן מוסתר בתצוגת האפליקציות האחרונות.'),
      h('li', null, 'אין התראות. תזכורות מופיעות רק בתוך האפליקציה.'),
      h('li', null, 'אם שוכחים את הקוד, אין שחזור. זה חלק מההגנה.'),
      h('li', null, 'ההשהיה אחרי ניסיונות שגויים מגנה רק על המסך. מי שמעתיק את קובץ הנתונים עצמו מוגן רק על ידי אורך הקוד, ולכן עדיף קוד ארוך.')));
}

function applyTheme() {
  const th = S.data ? S.data.settings.theme : 'auto';
  if (th === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', th);
}

// ---------- backup password & export / import ----------
function strength(p) {
  let score = Math.min(p.length, 20) * 4;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^\w]/, /[֐-׿]/].filter((r) => r.test(p)).length;
  score += classes * 6;
  if (/^(\d)\1+$/.test(p) || /^(0123|1234|abcd|qwer|password|123456)/i.test(p)) score = Math.min(score, 20);
  return Math.max(0, Math.min(100, score));
}
const MIN_SCORE = 50; // for the BACKUP password only: that file leaves the phone, so it must be strong
function strengthMeter(input) {
  const barEl = h('i'); const lbl = h('div', { class: 'hint', 'aria-live': 'polite' }, '');
  const upd = () => {
    const s = strength(input.value);
    barEl.style.width = `${s}%`;
    barEl.style.background = s < 50 ? 'var(--danger)' : s < 75 ? 'var(--warn)' : 'var(--ok)';
    lbl.textContent = !input.value ? '' : s < 50 ? 'חלש. עדיף משפט ארוך של כמה מילים' : s < 75 ? 'סביר, ארוך יותר יהיה בטוח יותר' : 'חזק';
  };
  input.addEventListener('input', upd);
  return h('div', null, h('div', { class: 'meter' }, barEl), lbl);
}
function passDialog({ title, text, confirm = true, ok = 'אישור' }) {
  return new Promise((resolve) => {
    const p1 = h('input', { type: 'text', class: 'secret', 'aria-label': 'סיסמה', placeholder: 'סיסמה', ...NOASSIST });
    const p2 = confirm ? h('input', { type: 'text', class: 'secret', 'aria-label': 'אימות סיסמה', placeholder: 'שוב אותה סיסמה', ...NOASSIST }) : null;
    const err = h('div', { class: 'err', role: 'alert' });
    const body = h('div', null, h('p', { class: 'hint' }, text), h('div', { class: 'field' }, p1, confirm ? strengthMeter(p1) : null), p2 ? h('div', { class: 'field' }, p2) : null, err);
    openDialog({
      title, body, dismiss: () => resolve(null),
      actions: [
        { label: 'ביטול', onClick: () => resolve(null) },
        { label: ok, kind: 'primary', onClick: () => {
          if (confirm && strength(p1.value) < MIN_SCORE) { err.textContent = 'הסיסמה חלשה מדי. השתמש במשפט ארוך של כמה מילים (12 תווים ומעלה).'; return false; }
          if (!confirm && !p1.value) return false;
          if (confirm && p1.value !== p2.value) { err.textContent = 'הסיסמאות לא זהות.'; return false; }
          resolve({ pass: p1.value });
        } },
      ],
    });
  });
}
async function doExport() {
  const ok = await confirmBox({
    title: 'ייצוא גיבוי',
    text: 'ייווצר קובץ מוצפן עם סיסמה נפרדת שתבחר. הקובץ יישמר במכשיר, ואם תעביר אותו לענן, למייל או למחשב אחר הוא יצא מהמכשיר. בלי הסיסמה אי אפשר לפתוח אותו, ואין שחזור שלה. להמשיך?',
    ok: 'המשך',
  });
  if (!ok) return;
  const r = await passDialog({ title: 'סיסמה לקובץ הגיבוי', text: 'סיסמה נפרדת מקוד הגישה. אותה תצטרך לייבוא.', ok: 'צור קובץ' });
  if (!r) return;
  try {
    const text = await makeExport(S.data, r.pass);
    const name = `safetasks-${today()}.safetasks`;
    const blob = new Blob([text], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    commit((d) => { d.settings.lastExport = today(); }, { render: false });
    toast('נוצר קובץ גיבוי מוצפן');
  } catch (e) { toast('הייצוא נכשל', { bad: true }); }
}
function pickImportFile(cb) {
  const inp = h('input', { type: 'file', class: 'sr', 'aria-hidden': 'true', tabindex: '-1' });
  inp.addEventListener('change', async () => {
    const f = inp.files && inp.files[0];
    inp.remove();
    if (!f) return;
    if (f.size > 20 * 1024 * 1024) { toast('הקובץ גדול מדי', { bad: true }); return; }
    cb(await f.text());
  });
  document.body.append(inp);
  inp.click();
}
async function importInto(text, { fresh = false } = {}) {
  const r = await passDialog({ title: 'סיסמת קובץ הגיבוי', text: 'הזן את הסיסמה שבחרת בעת הייצוא.', confirm: false, ok: 'פתח' });
  if (!r) return null;
  let data;
  try { data = M.validateData(await readExport(text, r.pass)); }
  catch (e) {
    toast(e instanceof BadPasscodeError ? 'סיסמה שגויה, או שהקובץ שונה/פגום' : 'זה לא קובץ גיבוי של האפליקציה', { bad: true });
    return null;
  }
  if (fresh) return data;
  if (!S.data) return null; // app was locked meanwhile
  const ok = await confirmBox({ title: 'החלפת הנתונים', danger: true, ok: 'החלף',
    text: `בקובץ ${data.tasks.length} משימות. כל המשימות והקטגוריות הקיימות יוחלפו. אפשר לבטל מיד אחרי הייבוא.` });
  if (!ok) return null;
  commit((d) => { d.tasks = data.tasks; d.categories = data.categories; });
  toast('הייבוא הושלם');
  return data;
}
async function wipeAll(toRestore = false) {
  const ok = await confirmBox({ title: 'מחיקת הכול', danger: true, ok: 'המשך',
    text: 'כל המשימות ומפתחות ההצפנה יימחקו מהמכשיר לצמיתות. אי אפשר לבטל. אם יש לך גיבוי מוצפן, הוא לא יושפע.' });
  if (!ok) return;
  const word = h('input', { type: 'text', 'aria-label': 'הקלד מחק', placeholder: 'מחק', ...NOASSIST });
  openDialog({
    title: 'אישור אחרון', body: h('div', null, h('p', null, 'הקלד את המילה "מחק" כדי לאשר.'), word),
    actions: [
      { label: 'ביטול' },
      { label: 'מחק לצמיתות', kind: 'danger', onClick: async () => {
        if (word.value.trim() !== 'מחק') { word.focus(); return false; }
        clearTimeout(idleTimer);
        try { await S.vault.wipe(); }
        catch (e) { toast('המחיקה לא הושלמה. סגור את האפליקציה ופתח אותה שוב, ונסה שוב.', { bad: true }); return; }
        guard.reset();
        try { localStorage.clear(); sessionStorage.clear(); } catch (e) { /* ignore */ }
        S.data = null; S.draft = null; S.undo.clear(); S.hasVault = false; S.openId = null; S.setup = toRestore ? 'restore' : 'create'; S.setupStep = 'enter';
        render(); toast('הכול נמחק');
      } },
    ],
  });
}

// ---------- new task form ----------
const WHEN = [['today', 'היום', 'sun'], ['tomorrow', 'מחר', 'sun-horizon'], ['week', 'בעוד שבוע', 'calendar-dots'], ['date', 'בחר תאריך', 'calendar-blank'], ['none', 'ללא מועד', 'infinity']];
function whenPicker(cur, onpick) {
  return h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'מתי?'),
    h('div', { class: 'whens', role: 'group', 'aria-label': 'מתי?' }, WHEN.map(([v, l, ic]) =>
      h('button', { type: 'button', class: 'when', 'aria-pressed': String(cur === v), onclick: () => onpick(v) }, icon(ic), h('span', null, l)))));
}
function seg(label, options, current, onpick) {
  return h('div', { class: 'field' }, h('span', { class: 'lbl' }, label),
    h('div', { class: 'seg', role: 'group', 'aria-label': label }, options.map(([v, l]) =>
      h('button', { type: 'button', 'aria-pressed': String(current === v), onclick: () => onpick(v) }, l))));
}
function newTaskScreen() {
  const f = S.newForm;
  const close = () => { S.newForm = null; render(); };
  const title = h('input', { type: 'text', id: 'newTitle', value: f.title, placeholder: 'מה צריך לעשות?', 'aria-label': 'כותרת', ...NOASSIST, maxlength: '300' });
  title.style.fontWeight = '700';
  title.addEventListener('input', () => { f.title = title.value; });
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitNew(false); } });
  const desc = h('textarea', { 'aria-label': 'פירוט קצר', placeholder: 'פירוט קצר (לא חובה)', ...NOASSIST, value: f.desc, maxlength: '20000' });
  desc.addEventListener('input', () => { f.desc = desc.value; });
  const dateIn = f.when === 'date' ? h('input', { type: 'date', 'aria-label': 'תאריך יעד', value: f.date, onchange: (e) => { f.date = e.target.value; } }) : null;
  const remEl = h('details', { class: 'fold', ...(f.remind || f.remOpen ? { open: true } : {}) }, h('summary', { onclick: () => { f.remOpen = true; } }, f.remind ? 'תזכורת: ' + (REMIND.find((r) => r[0] === f.remind) || [0, ''])[1] : 'תזכורת (לא חובה)'),
    remindChips(f.remind, (v) => { f.remind = v; render(); }),
    f.remind === 'date' ? h('div', { class: 'row wrap gap' },
      h('div', { class: 'grow' }, dateField('תאריך התזכורת', f.remindDate, (v) => { f.remindDate = v; })),
      h('div', { class: 'grow' }, dateField('שעה (לא חובה)', f.remindTime, (v) => { f.remindTime = v; }, 'time'))) : null);
  const rep = f.when !== 'none' ? h('details', { class: 'fold' }, h('summary', null, 'עוד אפשרויות: חזרתיות'),
    h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'חזרתיות'),
      h('select', { 'aria-label': 'חזרתיות', onchange: (e) => { f.repeat = e.target.value; } },
        M.REPEATS.map((r) => h('option', { value: r.id, ...(f.repeat === r.id ? { selected: true } : {}) }, r.label))))) : null;
  const screen = h('div', null,
    h('header', { class: 'top' },
      h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'ביטול', onclick: close }, icon('x')),
      h('h1', null, 'משימה חדשה')),
    h('main', { class: 'main' },
      h('label', { class: 'field' }, h('span', { class: 'sr' }, 'כותרת'), title),
      whenPicker(f.when, (v) => { f.when = v; render(); }),
      dateIn ? h('div', { class: 'field' }, dateIn) : null,
      seg('עדיפות', M.PRIORITIES.map((l, i) => [i, l]), f.priority, (v) => { f.priority = v; render(); }),
      h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'קטגוריה'), catChips(f.category, (id) => { f.category = id; render(); })),
      h('label', { class: 'field' }, h('span', { class: 'sr' }, 'פירוט'), desc),
      remEl,
      rep,
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary block', type: 'button', onclick: () => submitNew(false) }, icon('plus'), 'הוסף משימה'),
        h('button', { class: 'btn block', type: 'button', onclick: () => submitNew(true) }, 'הוסף ופתח להוספת תתי-משימות'))));
  if (f.focus) { f.focus = false; setTimeout(() => title.focus(), 50); }
  return screen;
}
function submitNew(openAfter) {
  const f = S.newForm; if (!f) return;
  const title = f.title.trim();
  if (!title) { toast('צריך לכתוב כותרת', { bad: true }); const el = $('newTitle'); if (el) el.focus(); return; }
  const now = today();
  let due = '';
  if (f.when === 'today') due = now;
  else if (f.when === 'tomorrow') due = M.addDays(now, 1);
  else if (f.when === 'week') due = M.addDays(now, 7);
  else if (f.when === 'date') {
    if (!f.date) { toast('בחר תאריך או "ללא מועד"', { bad: true }); return; }
    due = f.date;
  }
  let remD = '';
  if (f.remind === 'date') remD = f.remindDate; else if (f.remind) remD = M.addDays(now, Number(f.remind));
  const t = M.newTask(title, new Date(), {
    due, remindDate: remD, remindAt: remD ? f.remindTime : '', priority: f.priority, category: f.category,
    desc: f.desc.trim(), repeat: due ? f.repeat : 'none',
  });
  commit((d) => d.tasks.push(t), { render: false });
  S.newForm = null;
  S.openId = openAfter ? t.id : null;
  render(); window.scrollTo(0, 0);
  toast('המשימה נוספה', { undo: !openAfter });
}

// ---------- reminders: a date of their own, independent of the due date ----------
const REMIND = [['', 'ללא'], ['1', 'מחר'], ['3', 'בעוד 3 ימים'], ['7', 'בעוד שבוע'], ['date', 'בחר תאריך']];
function remindChips(cur, onpick) {
  return h('div', { class: 'chips wrap', role: 'group', 'aria-label': 'תזכורת' }, REMIND.map(([v, l]) =>
    h('button', { class: 'chip', type: 'button', 'aria-pressed': String(cur === v), onclick: () => onpick(v) }, l)));
}

// ---------- task detail: sub-tasks first, details below ----------
const dateField = (label, value, onchange, type = 'date') =>
  h('label', { class: 'field' }, h('span', { class: 'lbl' }, label), h('input', { type, value: value || '', onchange: (e) => onchange(e.target.value) }));

function detailScreen(id) {
  const t = task(id);
  if (!t) { S.openId = null; return mainScreen(); }
  const back = () => { S.openId = null; render(); };
  const p = M.progress(t);

  const title = h('input', { type: 'text', value: t.title, 'aria-label': 'כותרת', ...NOASSIST, maxlength: '300' });
  title.style.fontWeight = '700';
  title.addEventListener('change', () => {
    const v = title.value.trim();
    if (!v) { title.value = task(id).title; return; }
    withTask(id, (x) => { if (x.title !== v) { x.title = v; M.addLog(x, 'הכותרת שונתה'); } }, { render: false });
  });
  const desc = h('textarea', { 'aria-label': 'תיאור', ...NOASSIST, value: t.desc, maxlength: '20000' });
  desc.addEventListener('change', () => withTask(id, (x) => { if (x.desc !== desc.value) { x.desc = desc.value; M.addLog(x, 'התיאור עודכן'); } }, { render: false }));

  const tagInput = h('input', { type: 'text', 'aria-label': 'הוסף תג', placeholder: 'הוסף תג ו-Enter', ...NOASSIST, maxlength: '30' });
  const addTag = () => {
    const g = M.cleanTag(tagInput.value);
    if (!g) return;
    withTask(id, (x) => { if (!x.tags.includes(g)) { x.tags.push(g); M.addLog(x, `נוספה תגית: ${g}`); } });
  };
  tagInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } });

  const subInput = h('input', { type: 'text', id: 'subAdd', 'aria-label': 'תת-משימה חדשה', placeholder: 'תת-משימה חדשה ו-Enter', ...NOASSIST, maxlength: '300' });
  const addSub = () => {
    const v = subInput.value.trim(); if (!v) return;
    withTask(id, (x) => { x.subtasks.push(M.newSub(v)); M.addLog(x, `נוספה תת-משימה: ${v}`); });
    setTimeout(() => { const el = $('subAdd'); if (el) el.focus(); }, 0);
  };
  subInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addSub(); } });

  return h('div', null,
    topbar('משימה', { back }),
    h('main', { class: 'main' },
      h('label', { class: 'field' }, h('span', { class: 'sr' }, 'כותרת'), title),
      seg('סטטוס', M.STATUSES.map((s) => [s.id, s.label]), t.status, (v) => {
        if (v === 'done') tryComplete(id); else withTask(id, (x) => M.setStatus(x, v));
      }),

      h('h2', { class: 'sec' }, 'תתי-משימות', (p.total || p.cancelled) ? h('span', { class: 'muted' }, `${p.done} מתוך ${p.total} הושלמו${p.cancelled ? ` · ${p.cancelled} בוטלו` : ''}`) : null),
      p.total ? bar(p.pct) : null,
      subList(t, t.subtasks, 1),
      h('div', { class: 'row gap' }, h('div', { class: 'grow' }, subInput), h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'הוסף תת-משימה', onclick: addSub }, icon('plus'))),

      h('h2', { class: 'sec' }, 'פרטי המשימה'),
      seg('עדיפות', M.PRIORITIES.map((l, i) => [i, l]), t.priority, (v) => withTask(id, (x) => { if (x.priority !== v) { x.priority = v; M.addLog(x, `עדיפות: ${M.PRIORITIES[v]}`); } })),
      dateField('תאריך יעד (ריק = ללא מועד)', t.due, (v) => withTask(id, (x) => { x.due = v; M.addLog(x, v ? `תאריך יעד: ${v}` : 'תאריך יעד הוסר'); }, { render: false })),
      h('div', { class: 'field' }, h('span', { class: 'lbl' }, t.remindDate ? `תזכורת: ${dueText(t.remindDate, today())}${t.remindAt ? ' ' + t.remindAt : ''}` : 'תזכורת (יכולה להיות לפני תאריך היעד)'),
        remindChips(S.remindPick === id ? 'date' : '', (v) => {
          if (v === 'date') { S.remindPick = id; render(); return; }
          S.remindPick = null;
          withTask(id, (x) => { x.remindDate = v ? M.addDays(today(), Number(v)) : ''; if (!v) x.remindAt = ''; M.addLog(x, v ? `תזכורת: ${x.remindDate}` : 'התזכורת הוסרה'); });
        }),
        (S.remindPick === id || t.remindDate) ? h('div', { class: 'row wrap gap' },
          h('div', { class: 'grow' }, dateField('תאריך התזכורת', t.remindDate, (v) => { S.remindPick = null; withTask(id, (x) => { x.remindDate = v; M.addLog(x, v ? `תזכורת: ${v}` : 'התזכורת הוסרה'); }); })),
          h('div', { class: 'grow' }, dateField('שעה (לא חובה)', t.remindAt, (v) => withTask(id, (x) => { x.remindAt = v; }, { render: false }), 'time'))) : null,
        h('p', { class: 'hint' }, 'התזכורת מופיעה בראש המסך הראשי כשמגיע היום שלה. האפליקציה לא שולחת התראות לטלפון, כדי שלא יצא ממנה מידע.')),
      h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'קטגוריה'),
        catChips(t.category, (cid) => withTask(id, (x, d) => { if (x.category !== cid) { x.category = cid; M.addLog(x, `קטגוריה: ${cid ? M.catName(d, cid) : 'ללא'}`); } }))),
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'חזרתיות'),
        h('select', { 'aria-label': 'חזרתיות', onchange: (e) => withTask(id, (x) => { x.repeat = e.target.value; M.addLog(x, `חזרתיות: ${M.REPEATS.find((r) => r.id === e.target.value).label}`); }) },
          M.REPEATS.map((r) => h('option', { value: r.id, ...(t.repeat === r.id ? { selected: true } : {}) }, r.label)))),
      t.repeat !== 'none' && !t.due ? h('p', { class: 'hint' }, 'משימה חוזרת צריכה תאריך יעד כדי לדעת מתי להופיע שוב.') : null,
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'תיאור'), desc),
      h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'תגיות'),
        t.tags.length ? h('div', { class: 'tagrow' }, t.tags.map((g) => h('span', { class: 'tag' }, g,
          h('button', { type: 'button', 'aria-label': `הסר תג ${g}`, onclick: () => withTask(id, (x) => { x.tags = x.tags.filter((z) => z !== g); M.addLog(x, `הוסרה תגית: ${g}`); }) }, icon('x'))))) : null,
        h('div', { class: 'row' }, h('div', { class: 'grow' }, tagInput), h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'הוסף תג', onclick: addTag }, icon('plus')))),

      h('details', { class: 'log' }, h('summary', null, `יומן שינויים (${t.log.length})`),
        h('ol', null, [...t.log].reverse().map((l) => h('li', null, l.m, h('time', null, fmtTime(l.t)))))),

      h('div', { class: 'actions' },
        h('button', { class: 'btn block', type: 'button', onclick: () => { const c = M.duplicateTask(task(id)); commit((d) => d.tasks.push(c)); S.openId = c.id; render(); toast('נוצר עותק'); } }, icon('copy'), 'שכפל משימה'),
        (M.isClosedStatus(t.status) || t.archived) ? h('button', { class: 'btn block', type: 'button', onclick: () => withTask(id, (x) => { x.archived = !x.archived; M.addLog(x, x.archived ? 'הועברה לארכיון' : 'הוחזרה מהארכיון'); }) }, icon('archive'), t.archived ? 'החזר מהארכיון' : 'העבר לארכיון') : null,
        h('button', { class: 'btn block danger', type: 'button', onclick: () => deleteTask(id) }, icon('trash'), 'מחק משימה'))));
}

function subList(t, list, depth) {
  if (!list.length) return depth === 1 ? h('p', { class: 'hint' }, 'אין תתי-משימות. הוסף כאן שלבים, ואפשר לסמן כל אחד: בוצע, לא בוצע או בוטל.') : null;
  const ul = h('ul', { class: 'subs' });
  list.forEach((n, i) => ul.append(subItem(t, list, n, i, depth)));
  return ul;
}

function subItem(t, list, n, index, depth) {
  const id = t.id; const nid = n.id;
  const st = M.nodeState(n);
  const open = S.expanded.has(nid);
  const edit = (fn, msg, opts) => withTask(id, (x) => { const f = M.findNode(x.subtasks, nid); if (f) { fn(f.node, f); if (msg) M.addLog(x, msg(f.node)); } }, opts);
  const stLabel = (s) => M.SUB_STATES.find((z) => z.id === s).label;

  const titleIn = h('input', { type: 'text', value: n.title, 'aria-label': 'שם תת-משימה', ...NOASSIST, maxlength: '300' });
  titleIn.addEventListener('change', () => { const v = titleIn.value.trim(); if (!v) { titleIn.value = n.title; return; } edit((x) => { x.title = v; }, null, { render: false }); });

  const handle = h('button', { class: 'handle', type: 'button', 'aria-label': 'שינוי סדר. גרור, או השתמש בחצים' }, icon('dots-six-vertical'));
  const li = h('li', { class: `sub st-${st}` });
  const move = (to) => withTask(id, (x) => { const f = M.findNode(x.subtasks, nid); if (f) M.moveNode(f.list, f.index, to); });
  handle.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp') { e.preventDefault(); move(index - 1); }
    if (e.key === 'ArrowDown') { e.preventDefault(); move(index + 1); }
  });
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const sibs = [...li.parentElement.children];
    const rects = sibs.map((s) => s.getBoundingClientRect());
    const startY = e.clientY; let to = index;
    li.classList.add('dragging');
    const onMove = (ev) => {
      const dy = ev.clientY - startY;
      li.style.transform = `translateY(${dy}px)`;
      const c = rects[index].top + rects[index].height / 2 + dy;
      let k = index;
      rects.forEach((r, j) => { if (c >= r.top && c <= r.bottom) k = j; });
      to = k;
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove); handle.removeEventListener('pointerup', onUp); handle.removeEventListener('pointercancel', onUp);
      li.style.transform = ''; li.classList.remove('dragging');
      if (to !== index) move(to);
    };
    handle.addEventListener('pointermove', onMove); handle.addEventListener('pointerup', onUp); handle.addEventListener('pointercancel', onUp);
  });

  const setState = (s) => edit((x) => M.setNodeState(x, s), (x) => `תת-משימה "${x.title}": ${stLabel(s)}`);
  const check = h('button', { class: 'subcheck', type: 'button', 'aria-pressed': String(st === 'done'),
    'aria-label': `${stLabel(st)}: ${n.title}. לחץ להחלפה`,
    onclick: () => setState(st === 'done' ? 'todo' : 'done') },
    h('span', { class: `circle${st === 'done' ? ' on' : ''}${st === 'cancelled' ? ' x' : ''}` }, icon(st === 'cancelled' ? 'x' : 'check')));

  const chipsInfo = [];
  if (st === 'cancelled') chipsInfo.push(h('span', { class: 'mini cancelled' }, 'בוטל'));
  if (n.category) chipsInfo.push(h('span', { class: 'mini' }, M.catName(S.data, n.category)));
  if (n.remindDate && st === 'todo') chipsInfo.push(h('span', { class: 'mini' }, `תזכורת: ${dueText(n.remindDate, today())}`));
  if (n.due) chipsInfo.push(h('span', { class: `mini${n.due < today() && st === 'todo' ? ' late' : ''}` }, dueText(n.due, today())));
  if (n.note) chipsInfo.push(h('span', { class: 'mini' }, 'יש הערה'));

  const row = h('div', { class: 'subrow' }, handle, check, h('div', { class: 'grow' }, titleIn, chipsInfo.length ? h('div', { class: 'minis' }, chipsInfo) : null),
    h('button', { class: 'iconbtn', type: 'button', 'aria-expanded': String(open), 'aria-label': 'פרטי תת-משימה', onclick: () => { if (open) S.expanded.delete(nid); else S.expanded.add(nid); render(); } }, icon(open ? 'caret-down' : 'pencil-simple')));
  li.append(row);

  if (open) {
    const note = h('textarea', { 'aria-label': 'הערה או סיבה', placeholder: 'הערה או סיבה (למשל למה בוטל)', ...NOASSIST, value: n.note, maxlength: '5000' });
    note.style.minHeight = '5rem';
    note.addEventListener('change', () => edit((x) => { x.note = note.value; }, null, { render: false }));
    const childIn = depth === 1 ? h('input', { type: 'text', 'aria-label': 'תת-משימה פנימית חדשה', placeholder: 'תת-משימה פנימית ו-Enter', ...NOASSIST, maxlength: '300' }) : null;
    if (childIn) childIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); const v = childIn.value.trim(); if (v) edit((x) => { x.children.push(M.newSub(v)); }, () => `נוספה תת-משימה פנימית: ${v}`); }
    });
    const catSel = h('select', { 'aria-label': 'קטגוריה של תת-משימה', onchange: (e) => {
      const v = e.target.value;
      if (v === '__new') { e.target.value = n.category || ''; newCategory((cid) => edit((x) => { x.category = cid; })); return; }
      edit((x) => { x.category = v; });
    } }, h('option', { value: '' }, 'ללא קטגוריה'),
    S.data.categories.map((c) => h('option', { value: c.id, ...(n.category === c.id ? { selected: true } : {}) }, c.name)),
    h('option', { value: '__new' }, '+ קטגוריה חדשה...'));
    li.append(h('div', { class: 'subdetail' },
      h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'מצב'),
        h('div', { class: 'seg', role: 'group', 'aria-label': 'מצב תת-משימה' }, M.SUB_STATES.map((s) =>
          h('button', { type: 'button', 'aria-pressed': String(st === s.id), onclick: () => setState(s.id) }, s.label)))),
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'הערה או סיבה'), note),
      dateField('תאריך יעד לתת-משימה', n.due, (v) => edit((x) => { x.due = v; }, null), 'date'),
      h('div', { class: 'field' }, h('span', { class: 'lbl' }, n.remindDate ? `תזכורת: ${dueText(n.remindDate, today())}${n.remindAt ? ' ' + n.remindAt : ''}` : 'תזכורת לתת-משימה'),
        remindChips(S.remindPick === nid ? 'date' : '', (v) => {
          if (v === 'date') { S.remindPick = nid; render(); return; }
          S.remindPick = null;
          edit((x) => { x.remindDate = v ? M.addDays(today(), Number(v)) : ''; if (!v) x.remindAt = ''; }, null);
        }),
        (S.remindPick === nid || n.remindDate) ? h('div', { class: 'row wrap gap' },
          h('div', { class: 'grow' }, dateField('תאריך התזכורת', n.remindDate, (v) => { S.remindPick = null; edit((x) => { x.remindDate = v; }, null); })),
          h('div', { class: 'grow' }, dateField('שעה (לא חובה)', n.remindAt, (v) => edit((x) => { x.remindAt = v; }, null, { render: false }), 'time'))) : null),
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'קטגוריה'), catSel),
      childIn ? h('div', { class: 'field' }, childIn) : null,
      h('div', { class: 'row' },
        h('button', { class: 'btn', type: 'button', 'aria-label': 'העבר למעלה', disabled: index === 0, onclick: () => move(index - 1) }, icon('arrow-up')),
        h('button', { class: 'btn', type: 'button', 'aria-label': 'העבר למטה', disabled: index === list.length - 1, onclick: () => move(index + 1) }, icon('arrow-down')),
        h('button', { class: 'btn danger grow', type: 'button', onclick: async () => {
          const kids = (n.children || []).length;
          const ok = await confirmBox({ title: 'מחיקת תת-משימה', text: kids ? `תת-המשימה ו-${kids} התת-משימות הפנימיות שלה יימחקו. אם רק לא בוצעה, עדיף לסמן "בוטל" ולהשאיר אותה.` : 'התת-משימה תימחק. אם רק לא בוצעה, עדיף לסמן "בוטל" ולהשאיר אותה בהיסטוריה.', danger: true, ok: 'מחק' });
          if (!ok) return;
          edit((x, f) => { f.list.splice(f.index, 1); }, () => `נמחקה תת-משימה: ${n.title}`);
        } }, icon('trash'), 'מחק'))));
  }
  if (n.children && n.children.length) li.append(subList(t, n.children, depth + 1));
  return li;
}

// ---------- passcode screens (number pad) ----------
function advisory(len) {
  return confirmBox({
    title: 'קוד קצר',
    text: `קוד של ${len} ספרות קל יותר לניחוש, בעיקר אם מישהו מעתיק את קובץ הנתונים מהמכשיר. מומלץ 8 ספרות ומעלה (עדיף 10). ההחלטה שלך.`,
    ok: 'השתמש בקוד הזה', cancel: 'בחר קוד ארוך יותר',
  });
}
const waitText = (w) => { const m = Math.floor(w / 60), s = w % 60; return `יותר מדי ניסיונות. אפשר לנסות שוב בעוד ${m ? `${m}:${String(s).padStart(2, '0')} דקות` : `${s} שניות`}.`; };

function lockScreen() {
  const wrap = h('div', { class: 'lock' }, h('div', { class: 'logo' }, icon('lock-simple')), h('h1', null, 'כספת משימות'));
  if (S.storageError) {
    wrap.append(h('div', { class: 'warnbox', role: 'alert' }, 'לא ניתן לקרוא את האחסון של המכשיר כרגע. הנתונים שלך לא נמחקו. סגור את האפליקציה לגמרי, פתח אותה שוב ונסה שוב.'),
      h('button', { class: 'btn primary block', type: 'button', onclick: async () => { await probeStorage(); render(); } }, 'נסה שוב'));
    return wrap;
  }
  if (!S.hasVault) return setupScreen(wrap);

  let pad = null;
  clearTimeout(waitTimer);
  const tick = () => {
    const w = guard.waitSec();
    if (w > 0) { pad.setLocked(true); pad.setMessage(waitText(w)); waitTimer = setTimeout(tick, 1000); }
    else { pad.setLocked(false); pad.setMessage(''); }
  };
  pad = keypadView({
    prompt: 'הקלד קוד גישה', submitLabel: 'פתח', autoLen: lenHint(),
    onSubmit: async (code) => {
      if (guard.waitSec() > 0) return null;
      guard.fail(); // count the attempt FIRST, so quitting mid-check does not skip it; cleared on success
      try {
        const data = await S.vault.unlock(code, M.validateData);
        if (document.hidden) { S.vault.lock(); render(); return null; } // app was backgrounded meanwhile
        guard.ok(); setLen(code.length);
        S.data = data; S.tab = 'home'; S.undo.clear(); lastActive = 0; restoreDraft();
        if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
        bumpIdle(); render();
        return null;
      } catch (ex) {
        if (ex && ex.message === 'locked-meanwhile') { render(); return null; }
        if (ex instanceof BadPasscodeError) {
          const w = guard.waitSec();
          if (w > 0) { pad.setLocked(true); waitTimer = setTimeout(tick, 1000); return waitText(w); }
          return 'קוד שגוי';
        }
        guard.ok(); // not a wrong-passcode event
        return 'הנתונים במכשיר פגומים או בפורמט לא מוכר. אפשר למחוק ולשחזר מקובץ גיבוי דרך הכפתור למטה.';
      }
    },
  });
  wrap.append(pad.el, h('p', { class: 'hint' }, 'אין דרך לשחזר קוד שנשכח.'),
    lenHint() ? h('button', { class: 'btn block gap', type: 'button', onclick: () => { clearLen(); render(); } }, 'הקוד שלי באורך אחר') : null,
    h('button', { class: 'btn block gap', type: 'button', onclick: () => wipeAll(true) }, 'שכחתי את הקוד / מחק ושחזר מגיבוי'));
  if (guard.waitSec() > 0) tick();
  return wrap;
}

function setupScreen(wrap) {
  const restoring = S.setup === 'restore';
  const step = S.setupStep;
  const create = async (code, data) => {
    await S.vault.create(code, data);
    S.hasVault = true; guard.ok(); setLen(code.length); S.data = M.validateData(data); S.tab = 'home'; lastActive = 0;
    S.setupFirst = ''; S.setupStep = 'enter';
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    bumpIdle(); render();
  };
  const pad = keypadView({
    prompt: step === 'enter' ? 'בחר קוד גישה (ספרות בלבד)' : 'הקלד את הקוד שוב לאימות',
    hint: step === 'enter' ? (restoring ? 'הקוד הזה יהיה למכשיר הזה. אחר כך תבחר את קובץ הגיבוי.' : 'לפחות 4 ספרות. מומלץ 8 ומעלה.') : null,
    submitLabel: step === 'enter' ? 'המשך' : (restoring ? 'המשך לבחירת קובץ' : 'צור כספת'),
    autoLen: step === 'confirm' ? S.setupFirst.length : 0,
    onSubmit: async (code) => {
      if (step === 'enter') {
        if (code.length < 8 && !(await advisory(code.length))) return null;
        S.setupFirst = code; S.setupStep = 'confirm'; render();
        return null;
      }
      if (code !== S.setupFirst) { S.setupFirst = ''; S.setupStep = 'enter'; render(); toast('הקודים לא זהים, נסה שוב', { bad: true }); return null; }
      const ok = await confirmBox({ title: 'אין שחזור לקוד', text: 'אם תשכח את הקוד, אין שום דרך לשחזר את המשימות. זה חלק מההגנה. כדאי לשמור אותו במקום בטוח.', ok: 'הבנתי, המשך' });
      if (!ok) return null;
      try {
        if (!restoring) { await create(code, M.emptyData()); return null; }
        pickImportFile(async (txt) => {
          const data = await importInto(txt, { fresh: true });
          if (data) { try { await create(code, data); } catch (e) { toast('יצירת הכספת נכשלה', { bad: true }); } }
        });
        return null;
      } catch (e) { return 'יצירת הכספת נכשלה'; }
    },
  });
  wrap.append(...[!isStandalone() && !restoring && step === 'enter' ? h('div', { class: 'warnbox', role: 'note' },
      'אתה פותח מהדפדפן ולא מהאייקון במסך הבית. הנתונים בדפדפן ובאייקון נפרדים: כספת שתיווצר כאן לא תופיע באייקון. מומלץ קודם להוסיף למסך הבית ולפתוח משם.') : null,
    pad.el,
    step === 'confirm' ? h('button', { class: 'btn block gap', type: 'button', onclick: () => { S.setupStep = 'enter'; S.setupFirst = ''; render(); } }, 'חזרה') : null,
    step === 'enter' ? h('button', { class: 'btn block gap', type: 'button', onclick: () => { S.setup = restoring ? 'create' : 'restore'; S.setupStep = 'enter'; render(); } },
      restoring ? 'חזרה: כספת חדשה וריקה' : 'יש לי קובץ גיבוי מוצפן') : null].filter(Boolean));
  return wrap;
}

function flowScreen() {
  const f = S.flow;
  const prompts = { old: 'הקלד את הקוד הנוכחי', neu: 'בחר קוד חדש', confirm: 'הקלד את הקוד החדש שוב' };
  const pad = keypadView({
    prompt: prompts[f.step], submitLabel: f.step === 'confirm' ? 'החלף קוד' : 'המשך',
    autoLen: f.step === 'old' ? lenHint() : f.step === 'confirm' ? f.neu.length : 0,
    hint: f.step === 'neu' ? 'לפחות 4 ספרות. מומלץ 8 ומעלה.' : null,
    onSubmit: async (code) => {
      if (f.step === 'old') {
        try { await S.vault.verify(code); } catch (e) { return e instanceof BadPasscodeError ? 'הקוד שגוי' : 'משהו השתבש'; }
        f.old = code; f.step = 'neu'; render(); return null;
      }
      if (f.step === 'neu') {
        if (code.length < 8 && !(await advisory(code.length))) return null;
        f.neu = code; f.step = 'confirm'; render(); return null;
      }
      if (code !== f.neu) { f.step = 'neu'; f.neu = ''; render(); toast('הקודים לא זהים, נסה שוב', { bad: true }); return null; }
      try { await S.vault.changePasscode(f.old, f.neu, () => S.data); }
      catch (e) { S.flow = null; render(); toast('ההחלפה נכשלה', { bad: true }); return null; }
      setLen(f.neu.length); S.flow = null; render(); toast('קוד הגישה הוחלף');
      return null;
    },
  });
  return h('div', null,
    h('header', { class: 'top' },
      h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'ביטול', onclick: () => { S.flow = null; render(); } }, icon('x')),
      h('h1', null, 'החלפת קוד גישה')),
    h('div', { class: 'lock' }, pad.el));
}

// ---------- render ----------
function mainScreen() {
  const now = today();
  if (S.tab === 'cats' && S.catOpen) return catScreen(now);
  const titles = { home: 'המשימות שלי', cats: 'קטגוריות', closed: 'הושלמו ובוטלו', search: 'חיפוש', settings: 'הגדרות' };
  let body;
  if (S.tab === 'home') body = homeScreen(now);
  else if (S.tab === 'cats') body = catsScreen();
  else if (S.tab === 'closed') body = closedScreen(now);
  else if (S.tab === 'search') body = searchScreen(now);
  else body = settingsScreen();
  const sm = M.summary(S.data.tasks, now);
  const dateLine = new Date().toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' });
  const subs = { home: `${dateLine} · ${sm.open} פתוחות`, cats: `${S.data.categories.length} קטגוריות`, closed: `${sm.closed} משימות`, search: '', settings: '' };
  return h('div', null, topbar(titles[S.tab], { sub: subs[S.tab] }), body, navBar(now));
}

function render() {
  const app = $('app');
  if (S.data && S.cat && S.cat !== 'none' && !S.data.categories.some((c) => c.id === S.cat)) S.cat = '';
  if (S.data && S.catOpen && S.catOpen !== 'none' && !S.data.categories.some((c) => c.id === S.catOpen)) S.catOpen = null;
  const y = window.scrollY;
  releaseKeypad();
  applyTheme();
  app.replaceChildren();
  if (!S.data) { app.append(lockScreen()); return; }
  clearTimeout(waitTimer);
  if (S.flow) app.append(flowScreen());
  else if (S.newForm) app.append(newTaskScreen());
  else if (S.openId) app.append(detailScreen(S.openId));
  else app.append(mainScreen());
  window.scrollTo(0, y);
}

// ---------- startup ----------
export async function start() {
  // cover + lock whenever the app leaves the screen
  const cover = $('cover');
  const hide = () => { cover.hidden = false; };
  const show = () => { if (!document.hidden) cover.hidden = true; };
  document.addEventListener('visibilitychange', () => { if (document.hidden) { hide(); lock(); } else show(); });
  window.addEventListener('pagehide', () => { hide(); lock(); });
  window.addEventListener('blur', hide);
  window.addEventListener('focus', show);
  window.addEventListener('pageshow', show);
  cover.addEventListener('pointerdown', show); // tapping the cover dismisses it (if the app is really on screen)
  ['pointerdown', 'keydown', 'touchstart', 'scroll', 'input'].forEach((ev) => document.addEventListener(ev, bumpIdle, { passive: true, capture: true }));

  await probeStorage();
  render();
}

// If the storage cannot be read we must NOT offer to create a new vault (that could hide existing data).
async function probeStorage() {
  try { S.hasVault = await S.vault.exists(); S.storageError = false; }
  catch (e) { S.storageError = true; }
}

// model.js - pure task logic (no screen, no storage). Fully unit-tested.

export const PRIORITIES = ['נמוכה', 'בינונית', 'גבוהה', 'דחוף']; // index 0..3
export const STATUSES = [
  { id: 'todo', label: 'לביצוע' },
  { id: 'doing', label: 'בתהליך' },
  { id: 'waiting', label: 'ממתין' },
  { id: 'done', label: 'הושלם' },
  { id: 'cancelled', label: 'בוטל' },
];
export const SUB_STATES = [
  { id: 'todo', label: 'לא בוצע' },
  { id: 'done', label: 'בוצע' },
  { id: 'cancelled', label: 'בוטל' },
];
export const REPEATS = [
  { id: 'none', label: 'ללא' },
  { id: 'daily', label: 'יומי' },
  { id: 'weekly', label: 'שבועי' },
  { id: 'monthly', label: 'חודשי' },
];
export const MAX_LOG = 200;
export const MAX_CATEGORIES = 60;

let counter = 0;
export function uid() {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  counter += 1;
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('') + counter.toString(36);
}

// ---------- dates (local calendar days as YYYY-MM-DD strings) ----------
const pad = (n) => String(n).padStart(2, '0');
export function dateStr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
export function parseDate(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
export function addDays(s, n) { const d = parseDate(s); d.setDate(d.getDate() + n); return dateStr(d); }
export function addMonths(s, n) {
  const d = parseDate(s); const day = d.getDate();
  d.setDate(1); d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return dateStr(d);
}
export function nextDue(due, repeat) {
  if (repeat === 'daily') return addDays(due, 1);
  if (repeat === 'weekly') return addDays(due, 7);
  if (repeat === 'monthly') return addMonths(due, 1);
  return due;
}
export function diffDays(a, b) { return Math.round((parseDate(a) - parseDate(b)) / 86400000); }
const isDateStr = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && dateStr(parseDate(s)) === s;
const isTimeStr = (s) => typeof s === 'string' && /^\d{2}:\d{2}$/.test(s);

// ---------- creating ----------
export function emptyData() {
  return { v: 1, settings: { autoLockSec: 60, theme: 'auto' }, categories: [], tasks: [] };
}

export function newTask(title, now = new Date(), extra = {}) {
  const t = {
    id: uid(), title: String(title).trim(), desc: '', due: '', remindAt: '',
    priority: 1, tags: [], category: '', status: 'todo', repeat: 'none',
    subtasks: [], log: [], archived: false,
    createdAt: now.toISOString(), updatedAt: now.toISOString(), completedAt: '',
    ...extra,
  };
  addLog(t, 'המשימה נוצרה', now);
  return t;
}

export function newSub(title, extra = {}) {
  return { id: uid(), title: String(title).trim(), state: 'todo', due: '', note: '', category: '', children: [], ...extra };
}

export function addLog(task, msg, now = new Date()) {
  task.log.push({ t: now.toISOString(), m: msg });
  if (task.log.length > MAX_LOG) task.log.splice(0, task.log.length - MAX_LOG);
  task.updatedAt = now.toISOString();
}

// ---------- categories ----------
export const cleanCat = (s) => String(s).trim().replace(/\s+/g, ' ').slice(0, 40);
export function addCategory(d, name) {
  const n = cleanCat(name);
  if (!n) return null;
  const ex = d.categories.find((c) => c.name.toLowerCase() === n.toLowerCase());
  if (ex) return ex;
  if (d.categories.length >= MAX_CATEGORIES) return null;
  const c = { id: uid(), name: n };
  d.categories.push(c);
  return c;
}
export function renameCategory(d, id, name) {
  const n = cleanCat(name);
  const c = d.categories.find((x) => x.id === id);
  if (!c || !n) return false;
  if (d.categories.some((x) => x.id !== id && x.name.toLowerCase() === n.toLowerCase())) return false;
  c.name = n;
  return true;
}
// Deleting a category never deletes tasks: they simply become "no category".
export function deleteCategory(d, id) {
  d.categories = d.categories.filter((c) => c.id !== id);
  const clr = (list) => list.forEach((n) => { if (n.category === id) n.category = ''; clr(n.children || []); });
  d.tasks.forEach((t) => { if (t.category === id) t.category = ''; clr(t.subtasks); });
}
export function catName(d, id) { const c = d.categories.find((x) => x.id === id); return c ? c.name : ''; }

// ---------- sub-tasks & progress ----------
const isClosedState = (s) => s === 'done' || s === 'cancelled';
// A sub-task with children is closed only when ALL its children are closed; it counts as done if any child was done.
export function nodeState(n) {
  if (n.children && n.children.length) {
    const st = n.children.map(nodeState);
    if (st.every(isClosedState)) return st.includes('done') ? 'done' : 'cancelled';
    return 'todo';
  }
  return n.state || 'todo';
}
export const nodeDone = (n) => nodeState(n) === 'done';
export function setNodeState(n, st) {
  if (n.children && n.children.length) {
    const allCancelled = n.children.every((c) => nodeState(c) === 'cancelled');
    n.children.forEach((c) => { if (st === 'done' && !allCancelled && nodeState(c) === 'cancelled') return; setNodeState(c, st); });
  } else n.state = st;
}
export function toggleNodeDone(n) { setNodeState(n, nodeState(n) === 'done' ? 'todo' : 'done'); }
function leaves(list, out = []) {
  for (const n of list) { if (n.children && n.children.length) leaves(n.children, out); else out.push(n); }
  return out;
}
// Cancelled items stay visible but are not counted as work to do.
export function progress(task) {
  const l = leaves(task.subtasks);
  const active = l.filter((n) => n.state !== 'cancelled');
  const done = active.filter((n) => n.state === 'done').length;
  return { done, total: active.length, cancelled: l.length - active.length, pct: active.length ? Math.round((done / active.length) * 100) : 0 };
}
export function openSubCount(task) { return leaves(task.subtasks).filter((n) => n.state === 'todo').length; }
export function findNode(list, id, parent = null) {
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === id) return { node: list[i], list, index: i, parent };
    const r = findNode(list[i].children || [], id, list[i]);
    if (r) return r;
  }
  return null;
}
export function moveNode(list, from, to) {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return false;
  const [x] = list.splice(from, 1);
  list.splice(to, 0, x);
  return true;
}

// ---------- status / completion / recurrence ----------
export const statusLabel = (id) => (STATUSES.find((s) => s.id === id) || {}).label || id;
export const isClosedStatus = (s) => s === 'done' || s === 'cancelled';

export function setStatus(task, status, now = new Date()) {
  if (task.status === status) return task;
  const old = task.status;
  task.status = status;
  task.completedAt = isClosedStatus(status) ? now.toISOString() : '';
  if (!isClosedStatus(status)) task.archived = false; // an open task must never stay hidden in the archive
  addLog(task, `סטטוס: ${statusLabel(old)} ← ${statusLabel(status)}`, now);
  return task;
}

// Completes a task. Recurring tasks leave a completed copy behind and roll forward to the next date.
// Returns { completedCopy, nextDue } when a recurring task rolled over.
export function completeTask(task, now = new Date()) {
  if (task.repeat !== 'none' && task.due) {
    const copy = structuredCloneSafe(task);
    copy.id = uid(); copy.repeat = 'none';
    setStatus(copy, 'done', now);
    addLog(copy, 'נסגר מופע של משימה חוזרת', now);
    const prev = task.due;
    const todayS = dateStr(now);
    task.due = nextDue(task.due, task.repeat);
    for (let i = 0; i < 4000 && task.due < todayS; i++) task.due = nextDue(task.due, task.repeat); // skip missed occurrences
    task.status = 'todo'; task.completedAt = '';
    resetSubs(task.subtasks);
    addLog(task, `משימה חוזרת: מופע הושלם, תאריך הבא ${task.due} (היה ${prev})`, now);
    return { completedCopy: copy, nextDue: task.due };
  }
  setStatus(task, 'done', now);
  return {};
}
function resetSubs(list) { list.forEach((n) => { if (n.children && n.children.length) resetSubs(n.children); else n.state = 'todo'; }); }

export function structuredCloneSafe(o) { return JSON.parse(JSON.stringify(o)); }

export function duplicateTask(task, now = new Date()) {
  const c = structuredCloneSafe(task);
  c.id = uid(); c.title = `${task.title} (עותק)`; c.status = 'todo'; c.archived = false;
  c.completedAt = ''; c.log = []; c.createdAt = now.toISOString();
  const reid = (list) => list.forEach((n) => { n.id = uid(); if (n.children && n.children.length) reid(n.children); else n.state = 'todo'; });
  reid(c.subtasks);
  addLog(c, 'נוצר כשכפול של משימה אחרת', now);
  return c;
}

// ---------- classification & views ----------
export function isOpen(t) { return !isClosedStatus(t.status) && !t.archived; }
export function isClosed(t) { return isClosedStatus(t.status) && !t.archived; }
export function isOverdue(t, today) { return isOpen(t) && !!t.due && t.due < today; }

const byDue = (a, b) => (a.due || '9999').localeCompare(b.due || '9999') ||
  (a.remindAt || '99').localeCompare(b.remindAt || '99') || b.priority - a.priority;
const byPrio = (a, b) => b.priority - a.priority || byDue(a, b);

export function overdue(tasks, today) { return tasks.filter((t) => isOverdue(t, today)).sort(byDue); }
export function dueToday(tasks, today) { return tasks.filter((t) => isOpen(t) && t.due === today).sort(byDue); }
export function upcoming(tasks, today, days = 7) {
  const end = addDays(today, days);
  return tasks.filter((t) => isOpen(t) && t.due > today && t.due <= end).sort(byDue);
}
export function thisWeek(tasks, today) {
  const end = addDays(today, 7);
  return tasks.filter((t) => isOpen(t) && t.due && t.due <= end).sort(byDue);
}
export function allOpen(tasks) { return tasks.filter(isOpen).sort(byDue); }
export function byPriority(tasks) { return tasks.filter(isOpen).sort(byPrio); }
export function byTag(tasks, tag) { return tasks.filter((t) => isOpen(t) && t.tags.includes(tag)).sort(byDue); }
export function allTags(tasks) {
  const m = new Map();
  tasks.filter((t) => !t.archived).forEach((t) => t.tags.forEach((g) => m.set(g, (m.get(g) || 0) + 1)));
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], 'he'));
}

// The numbers shown at the top of the home screen. Always built from the same list as the tasks below them.
export function summary(tasks, today) {
  const open = tasks.filter(isOpen);
  const end = addDays(today, 7);
  return {
    open: open.length,
    overdue: open.filter((t) => t.due && t.due < today).length,
    today: open.filter((t) => t.due === today).length,
    week: open.filter((t) => t.due > today && t.due <= end).length,
    nodate: open.filter((t) => !t.due).length,
    closed: tasks.filter(isClosed).length,
  };
}

const subHasCat = (list, cat) => list.some((n) => n.category === cat || subHasCat(n.children || [], cat));
const inCat = (t, cat) => !cat || (cat === 'none' ? !t.category : (t.category === cat || subHasCat(t.subtasks || [], cat)));
export const SECTION_TITLES = { overdue: 'באיחור', today: 'היום', soon: 'ב-7 הימים הקרובים', later: 'מאוחר יותר', nodate: 'ללא מועד' };
// All open tasks, grouped by when they are due. scope: all | overdue | today | week
export function homeSections(tasks, today, { scope = 'all', cat = '' } = {}) {
  const end = addDays(today, 7);
  const open = tasks.filter((t) => isOpen(t) && inCat(t, cat));
  const groups = {
    overdue: open.filter((t) => t.due && t.due < today).sort(byDue),
    today: open.filter((t) => t.due === today).sort(byDue),
    soon: open.filter((t) => t.due > today && t.due <= end).sort(byDue),
    later: open.filter((t) => t.due > end).sort(byDue),
    nodate: open.filter((t) => !t.due).sort(byPrio),
  };
  const keys = scope === 'overdue' ? ['overdue'] : scope === 'today' ? ['today'] : scope === 'week' ? ['soon'] : ['overdue', 'today', 'soon', 'later', 'nodate'];
  return keys.map((k) => ({ id: k, title: SECTION_TITLES[k], tasks: groups[k] })).filter((s) => s.tasks.length);
}

// Finished tasks (done or cancelled) stay visible here and are never lost. kind: done | cancelled | archive
export function closedList(tasks, kind = 'done') {
  const f = kind === 'archive' ? (t) => t.archived : kind === 'cancelled' ? (t) => isClosed(t) && t.status === 'cancelled' : (t) => isClosed(t) && t.status === 'done';
  return tasks.filter(f).sort((a, b) => (b.completedAt || b.updatedAt).localeCompare(a.completedAt || a.updatedAt));
}
export function archived(tasks) { return closedList(tasks, 'archive'); }
export function completed(tasks) { return tasks.filter((t) => isClosed(t)).sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || '')); }

// Per-category counts for the categories screen.
export function categoryStats(d) {
  const rows = d.categories.map((c) => ({ id: c.id, name: c.name }));
  rows.push({ id: 'none', name: 'ללא קטגוריה' });
  return rows.map((r) => {
    const mine = d.tasks.filter((t) => !t.archived && inCat(t, r.id));
    return { ...r, open: mine.filter(isOpen).length, closed: mine.filter(isClosed).length };
  });
}
export function categoryTasks(d, cat) { return d.tasks.filter((t) => !t.archived && inCat(t, cat)); }

// ---------- search (local, in memory) ----------
function subText(list, d, out = []) {
  list.forEach((n) => { out.push(n.title, n.note || '', n.due || '', n.category && d ? catName(d, n.category) : ''); subText(n.children || [], d, out); });
  return out;
}
export function searchText(t, d = null) {
  return [t.title, t.desc, t.due, t.tags.join(' '),
    d && t.category ? catName(d, t.category) : '', ...subText(t.subtasks, d)].join('\n').toLowerCase();
}
export function search(tasks, q, d = null) {
  const terms = String(q).toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return tasks.filter((t) => { const s = searchText(t, d); return terms.every((x) => s.includes(x)); }).sort(byDue);
}

// ---------- tags ----------
export function cleanTag(s) { return String(s).trim().replace(/^#+/, '').replace(/\s+/g, ' ').slice(0, 30); }

// ---------- undo (in memory only) ----------
export class UndoStack {
  constructor(max = 30) { this.max = max; this.items = []; }
  push(snapshot) { this.items.push(JSON.stringify(snapshot)); if (this.items.length > this.max) this.items.shift(); }
  pop() { const s = this.items.pop(); return s ? JSON.parse(s) : null; }
  get size() { return this.items.length; }
  clear() { this.items = []; }
}

// ---------- validation / migration of loaded or imported data ----------
const str = (v, max, d = '') => (typeof v === 'string' ? v.slice(0, max) : d);
const intIn = (v, lo, hi, d) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d);
const SUB_IDS = SUB_STATES.map((s) => s.id);

function cleanSub(n, depth, catIds) {
  if (!n || typeof n !== 'object') return null;
  const state = SUB_IDS.includes(n.state) ? n.state : (n.done ? 'done' : 'todo'); // older files used a plain done flag
  const o = {
    id: str(n.id, 40) || uid(), title: str(n.title, 300), state,
    due: isDateStr(n.due) ? n.due : '', note: str(n.note, 5000),
    category: catIds.has(n.category) ? n.category : '', children: [],
  };
  if (depth < 2 && Array.isArray(n.children)) o.children = n.children.map((c) => cleanSub(c, depth + 1, catIds)).filter(Boolean);
  return o;
}

export function validateData(d) {
  if (!d || typeof d !== 'object' || d.v !== 1 || !Array.isArray(d.tasks)) throw new Error('bad-data');
  const out = emptyData();
  const s = d.settings || {};
  out.settings.autoLockSec = [15, 30, 60, 120, 300].includes(s.autoLockSec) ? s.autoLockSec : 60;
  out.settings.theme = ['auto', 'light', 'dark'].includes(s.theme) ? s.theme : 'auto';
  out.settings.lastExport = isDateStr(s.lastExport) ? s.lastExport : '';
  const catIds = new Set();
  if (Array.isArray(d.categories)) {
    for (const c of d.categories.slice(0, MAX_CATEGORIES)) {
      if (!c || typeof c !== 'object') continue;
      const name = cleanCat(str(c.name, 80));
      const id = str(c.id, 40) || uid();
      if (!name || catIds.has(id)) continue;
      if (out.categories.some((x) => x.name.toLowerCase() === name.toLowerCase())) continue;
      catIds.add(id); out.categories.push({ id, name });
    }
  }
  const seen = new Set();
  for (const t of d.tasks.slice(0, 20000)) {
    if (!t || typeof t !== 'object') continue;
    let id = str(t.id, 40) || uid();
    if (seen.has(id)) id = uid();
    seen.add(id);
    const status = STATUSES.some((x) => x.id === t.status) ? t.status : 'todo';
    out.tasks.push({
      id, title: str(t.title, 300), desc: str(t.desc, 20000),
      due: isDateStr(t.due) ? t.due : '', remindAt: isTimeStr(t.remindAt) ? t.remindAt : '',
      priority: intIn(t.priority, 0, 3, 1),
      tags: Array.isArray(t.tags) ? [...new Set(t.tags.map(cleanTag).filter(Boolean))].slice(0, 30) : [],
      category: catIds.has(t.category) ? t.category : '',
      status, repeat: REPEATS.some((x) => x.id === t.repeat) ? t.repeat : 'none',
      subtasks: Array.isArray(t.subtasks) ? t.subtasks.map((n) => cleanSub(n, 1, catIds)).filter(Boolean) : [],
      log: Array.isArray(t.log) ? t.log.slice(-MAX_LOG).map((l) => ({ t: str(l && l.t, 40), m: str(l && l.m, 500) })) : [],
      archived: !!t.archived,
      createdAt: str(t.createdAt, 40) || new Date().toISOString(),
      updatedAt: str(t.updatedAt, 40) || new Date().toISOString(),
      completedAt: str(t.completedAt, 40),
    });
  }
  return out;
}

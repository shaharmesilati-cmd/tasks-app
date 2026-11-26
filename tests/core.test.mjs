import test from 'node:test';
import assert from 'node:assert/strict';
import { Vault, memoryBackend, makeExport, readExport } from '../js/vault.js';
import { BadPasscodeError, deriveKey, encryptJSON, decryptJSON, randomBytes } from '../js/crypto.js';
import { makeGuard, delayFor } from '../js/guard.js';
import * as M from '../js/model.js';

const SECRET = 'מסמך סודי ביותר 12345';

// ---------- encryption ----------
test('encrypt/decrypt round trip, fresh IV each time', async () => {
  const key = await deriveKey('correct horse', randomBytes(16), 100000);
  const a = await encryptJSON(key, { x: SECRET }, 'aad');
  const b = await encryptJSON(key, { x: SECRET }, 'aad');
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ct, b.ct);
  assert.deepEqual(await decryptJSON(key, a.iv, a.ct, 'aad'), { x: SECRET });
});

test('wrong AAD label fails (a file of one kind cannot pose as another)', async () => {
  const key = await deriveKey('pw', randomBytes(16), 100000);
  const a = await encryptJSON(key, { x: 1 }, 'vault');
  await assert.rejects(decryptJSON(key, a.iv, a.ct, 'export'), BadPasscodeError);
});

test('tampering with ciphertext is detected', async () => {
  const key = await deriveKey('pw', randomBytes(16), 100000);
  const a = await encryptJSON(key, { x: 1 }, 'aad');
  const bytes = Buffer.from(a.ct, 'base64'); bytes[0] ^= 1;
  await assert.rejects(decryptJSON(key, a.iv, bytes.toString('base64'), 'aad'), BadPasscodeError);
});

// ---------- vault ----------
test('vault: disk holds no plaintext; right passcode opens, wrong fails', async () => {
  const be = memoryBackend();
  const v = new Vault(be);
  const data = M.emptyData();
  data.tasks.push(M.newTask(SECRET));
  await v.create('Strong-Pass-1234', data);
  await v.save(data);
  const raw = be._dump();
  assert.ok(!raw.includes('סודי'), 'plaintext leaked to storage');
  assert.ok(!raw.includes(Buffer.from(SECRET).toString('base64').slice(0, 12)));
  v.lock();
  assert.equal(v.unlocked, false);
  await assert.rejects(v.unlock('wrong'), BadPasscodeError);
  const back = await v.unlock('Strong-Pass-1234');
  assert.equal(back.tasks[0].title, SECRET);
});

test('vault: save uses a fresh IV and survives re-unlock', async () => {
  const be = memoryBackend();
  const v = new Vault(be);
  const data = M.emptyData();
  await v.create('Strong-Pass-1234', data);
  const iv1 = (await be.get('vault')).iv;
  data.tasks.push(M.newTask('חדש'));
  await v.save(data);
  const iv2 = (await be.get('vault')).iv;
  assert.notEqual(iv1, iv2);
  const v2 = new Vault(be);
  assert.equal((await v2.unlock('Strong-Pass-1234')).tasks.length, 1);
});

test('vault: change passcode; old one stops working', async () => {
  const be = memoryBackend(); const v = new Vault(be);
  const data = M.emptyData(); data.tasks.push(M.newTask('a'));
  await v.create('old-pass-1234', data);
  await assert.rejects(v.changePasscode('nope', 'new-pass-5678', () => data), BadPasscodeError);
  await v.changePasscode('old-pass-1234', 'new-pass-5678', () => data);
  const v2 = new Vault(be);
  await assert.rejects(v2.unlock('old-pass-1234'), BadPasscodeError);
  assert.equal((await v2.unlock('new-pass-5678')).tasks.length, 1);
});

test('vault: wipe removes data and key', async () => {
  const be = memoryBackend(); const v = new Vault(be);
  await v.create('pass-12345678', M.emptyData());
  await v.wipe();
  assert.equal(await v.exists(), false);
  assert.equal(v.unlocked, false);
  assert.equal(be._dump(), '[]');
});

test('vault: save while locked is refused', async () => {
  const v = new Vault(memoryBackend());
  await v.create('pass-12345678', M.emptyData());
  v.lock();
  await assert.rejects(v.save(M.emptyData()), /locked/);
});

test('vault: a save started just before lock() still lands (no lost edit)', async () => {
  const be = memoryBackend(); const v = new Vault(be);
  const data = M.emptyData(); await v.create('pass-12345678', data);
  data.tasks.push(M.newTask('נשמר לפני נעילה'));
  const p = v.save(data); v.lock(); await p;
  assert.equal((await new Vault(be).unlock('pass-12345678')).tasks[0].title, 'נשמר לפני נעילה');
});

test('vault: a save that races with wipe() cannot resurrect deleted data', async () => {
  const be = memoryBackend(); const v = new Vault(be);
  const data = M.emptyData(); await v.create('pass-12345678', data);
  data.tasks.push(M.newTask('x'));
  const p = v.save(data); const w = v.wipe(); await Promise.all([p, w]);
  assert.equal(await v.exists(), false);
  assert.equal(be._dump(), '[]');
});

test('vault: create refuses to overwrite an existing vault', async () => {
  const be = memoryBackend(); const v = new Vault(be);
  const d = M.emptyData(); d.tasks.push(M.newTask('חשוב'));
  await v.create('pass-12345678', d);
  const v2 = new Vault(be);
  await assert.rejects(v2.create('another-pass-9999', M.emptyData()));
  assert.equal((await new Vault(be).unlock('pass-12345678')).tasks[0].title, 'חשוב');
});

test('vault: unlock finishing after lock() is discarded; no key stays in memory', async () => {
  const be = memoryBackend(); const v = new Vault(be);
  await v.create('pass-12345678', M.emptyData()); v.lock();
  const p = v.unlock('pass-12345678'); v.lock(); // backgrounded while PBKDF2 runs
  await assert.rejects(p, /locked-meanwhile/);
  assert.equal(v.unlocked, false);
});

test('vault: failed validation leaves no key in memory', async () => {
  const be = memoryBackend(); const v = new Vault(be);
  await v.create('pass-12345678', M.emptyData()); v.lock();
  await assert.rejects(v.unlock('pass-12345678', () => { throw new Error('bad-data'); }), /bad-data/);
  assert.equal(v.unlocked, false);
});

test('vault: saves racing with a passcode change never bring back the old key', async () => {
  const be = memoryBackend(); const v = new Vault(be);
  const data = M.emptyData(); await v.create('old-pass-1234', data);
  data.tasks.push(M.newTask('a'));
  const s1 = v.save(data);
  const c = v.changePasscode('old-pass-1234', 'new-pass-5678', () => data);
  data.tasks.push(M.newTask('b'));
  const s2 = v.save(data);
  await Promise.all([s1, c, s2]);
  const v2 = new Vault(be);
  await assert.rejects(v2.unlock('old-pass-1234'), BadPasscodeError);
  assert.equal((await v2.unlock('new-pass-5678')).tasks.length, 2);
});

test('records: iteration count is authenticated and has a floor/ceiling', async () => {
  const be = memoryBackend(); const v = new Vault(be);
  await v.create('pass-12345678', M.emptyData());
  const rec = await be.get('vault');
  await be.put('vault', { ...rec, iter: 100000 });
  await assert.rejects(new Vault(be).unlock('pass-12345678'), /bad-record/);
  await be.put('vault', { ...rec, iter: 20000000 });
  await assert.rejects(new Vault(be).unlock('pass-12345678'), /bad-record/);
  await be.put('vault', { ...rec, iter: rec.iter + 1 });
  await assert.rejects(new Vault(be).unlock('pass-12345678'), BadPasscodeError); // tampered -> fails
});

test('validateData: impossible dates are dropped', () => {
  const d = M.validateData({ v: 1, tasks: [{ title: 'x', due: '2025-99-99' }, { title: 'y', due: '2026-02-30' }, { title: 'z', due: '2026-02-28' }] });
  assert.deepEqual(d.tasks.map((t) => t.due), ['', '', '2026-02-28']);
});

// ---------- export / import ----------
test('export: encrypted, separate password, round trip, integrity', async () => {
  const data = M.emptyData(); data.tasks.push(M.newTask(SECRET));
  const file = await makeExport(data, 'export-pass-999');
  assert.ok(!file.includes('סודי'));
  const back = await readExport(file, 'export-pass-999');
  assert.equal(back.tasks[0].title, SECRET);
  await assert.rejects(readExport(file, 'bad'), BadPasscodeError);
  const obj = JSON.parse(file); const b = Buffer.from(obj.ct, 'base64'); b[5] ^= 8; obj.ct = b.toString('base64');
  await assert.rejects(readExport(JSON.stringify(obj), 'export-pass-999'), BadPasscodeError);
});

test('import: rejects files not created by this app', async () => {
  await assert.rejects(readExport('{"hello":1}', 'x'), /not-our-file/);
  await assert.rejects(readExport('garbage', 'x'), /not-our-file/);
});

// ---------- guard ----------
test('guard: delays grow after failures and reset on success', () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  let t = 1_000_000;
  const g = makeGuard(storage, () => t);
  assert.equal(g.waitSec(), 0);
  g.fail(); g.fail(); assert.equal(g.waitSec(), 0);
  g.fail(); assert.equal(g.waitSec(), 30);
  t += 31_000; assert.equal(g.waitSec(), 0);
  g.fail(); assert.equal(g.waitSec(), 60);
  t += 61_000; g.fail(); assert.equal(g.waitSec(), 300);
  assert.ok(delayFor(99) >= 3600);
  g.ok(); assert.equal(g.waitSec(), 0); assert.equal(g.state().fails, 0);
});

// ---------- model ----------
test('progress counts leaves; parent derived from children', () => {
  const t = M.newTask('x');
  const a = M.newSub('a'); const b = M.newSub('b');
  const b1 = M.newSub('b1'); const b2 = M.newSub('b2'); b.children.push(b1, b2);
  t.subtasks.push(a, b);
  assert.deepEqual(M.progress(t), { done: 0, total: 3, cancelled: 0, pct: 0 });
  a.state = 'done'; b1.state = 'done';
  assert.deepEqual(M.progress(t), { done: 2, total: 3, cancelled: 0, pct: 67 });
  assert.equal(M.nodeDone(b), false);
  M.setNodeState(b, 'done');
  assert.equal(M.progress(t).done, 3);
  assert.equal(M.openSubCount(t), 0);
});

test('3 of 5 subtasks', () => {
  const t = M.newTask('x');
  for (let i = 0; i < 5; i++) t.subtasks.push(M.newSub('s' + i, { state: i < 3 ? 'done' : 'todo' }));
  const p = M.progress(t); assert.equal(`${p.done}/${p.total}`, '3/5'); assert.equal(p.pct, 60);
});

test('cancelled sub-tasks stay visible, are not counted as work, and keep their note', () => {
  const t = M.newTask('x');
  t.subtasks.push(M.newSub('a', { state: 'done' }), M.newSub('b', { state: 'cancelled', note: 'הספק ביטל' }), M.newSub('c'));
  assert.deepEqual(M.progress(t), { done: 1, total: 2, cancelled: 1, pct: 50 });
  assert.equal(M.openSubCount(t), 1);
  assert.equal(t.subtasks[1].note, 'הספק ביטל');
  const p = M.newSub('parent'); p.children.push(M.newSub('p1', { state: 'cancelled' }), M.newSub('p2'));
  M.setNodeState(p, 'done'); // marking the parent done never un-cancels a cancelled child
  assert.deepEqual(p.children.map((c) => c.state), ['cancelled', 'done']);
  assert.equal(M.nodeState(p), 'done');
});

test('a task can be cancelled and stays in the closed list, not in open views', () => {
  const t = M.newTask('x'); M.setStatus(t, 'cancelled');
  assert.equal(M.isOpen(t), false); assert.equal(M.isClosed(t), true);
  assert.equal(M.closedList([t], 'cancelled').length, 1); assert.equal(M.closedList([t], 'done').length, 0);
  assert.equal(M.summary([t], '2026-11-25').open, 0); assert.equal(M.summary([t], '2026-11-25').closed, 1);
});

test('home shows ALL open tasks in sections; summary matches the list', () => {
  const today = '2026-11-25';
  const mk = (title, due, extra = {}) => M.newTask(title, new Date(), { due, ...extra });
  const tasks = [mk('late', '2026-11-20'), mk('today', today), mk('soon', '2026-11-28'), mk('far', '2027-02-01'), mk('nodate', ''), mk('done', today, { status: 'done' })];
  const secs = M.homeSections(tasks, today);
  assert.deepEqual(secs.map((s) => s.id), ['overdue', 'today', 'soon', 'later', 'nodate']);
  assert.equal(secs.reduce((n, s) => n + s.tasks.length, 0), 5); // nothing open is hidden
  const sm = M.summary(tasks, today);
  assert.deepEqual([sm.open, sm.overdue, sm.today, sm.week, sm.nodate, sm.closed], [5, 1, 1, 1, 1, 1]);
  assert.deepEqual(M.homeSections(tasks, today, { scope: 'today' }).map((s) => s.id), ['today']);
  assert.deepEqual(M.homeSections(tasks, today, { scope: 'overdue' })[0].tasks.map((t) => t.title), ['late']);
});

test('completing a task moves it from open to closed in every view (single source of truth)', () => {
  const today = '2026-11-25';
  const t = M.newTask('אחת', new Date(), { due: today });
  const tasks = [t];
  assert.equal(M.summary(tasks, today).today, 1);
  M.completeTask(t);
  assert.equal(M.summary(tasks, today).today, 0);
  assert.equal(M.homeSections(tasks, today).length, 0);
  assert.equal(M.closedList(tasks, 'done').length, 1);
  assert.equal(M.search(tasks, 'אחת').length, 1); // still findable
});

test('categories: add (no duplicates), rename, delete keeps tasks', () => {
  const d = M.emptyData();
  const c1 = M.addCategory(d, '  הנדסה ימית '); const dup = M.addCategory(d, 'הנדסה ימית');
  assert.equal(c1.id, dup.id); assert.equal(d.categories.length, 1);
  const c2 = M.addCategory(d, 'פלגה 921');
  const t = M.newTask('t', new Date(), { category: c1.id }); t.subtasks.push(M.newSub('s', { category: c1.id }));
  d.tasks.push(t, M.newTask('u', new Date(), { category: c2.id }));
  assert.equal(M.renameCategory(d, c1.id, 'פלגה 921'), false); // name taken
  assert.equal(M.renameCategory(d, c1.id, 'הנדסה'), true);
  assert.deepEqual(M.categoryStats(d).map((r) => [r.name, r.open]), [['הנדסה', 1], ['פלגה 921', 1], ['ללא קטגוריה', 0]]);
  assert.equal(M.search(d.tasks, 'הנדסה', d).length, 1); // search by category name
  M.deleteCategory(d, c1.id);
  assert.equal(d.tasks.length, 2); assert.equal(t.category, ''); assert.equal(t.subtasks[0].category, '');
});

test('validateData migrates old done flag and drops unknown category ids', () => {
  const d = M.validateData({ v: 1, categories: [{ id: 'c1', name: 'א' }, { id: 'c1', name: 'ב' }, { id: 'c2', name: 'א' }],
    tasks: [{ title: 't', category: 'zzz', subtasks: [{ title: 'x', done: true, category: 'c1' }, { title: 'y', state: 'cancelled' }] }] });
  assert.equal(d.categories.length, 1);
  assert.equal(d.tasks[0].category, '');
  assert.deepEqual(d.tasks[0].subtasks.map((n) => [n.state, n.category]), [['done', 'c1'], ['cancelled', '']]);
});

test('dates: month rollover and recurrence', () => {
  assert.equal(M.addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(M.nextDue('2026-11-25', 'weekly'), '2026-12-02');
  assert.equal(M.nextDue('2026-12-31', 'daily'), '2027-01-01');
  assert.equal(M.nextDue('2026-12-15', 'monthly'), '2027-01-15');
});

test('recurring completion rolls forward and keeps a done copy', () => {
  const t = M.newTask('חוזרת', new Date(), { due: '2026-11-25', repeat: 'weekly' });
  t.subtasks.push(M.newSub('s', { state: 'done' }));
  const r = M.completeTask(t);
  assert.equal(t.due, '2026-12-02'); assert.equal(t.status, 'todo'); assert.equal(r.nextDue, '2026-12-02');
  assert.equal(t.subtasks[0].state, 'todo');
  assert.equal(r.completedCopy.status, 'done'); assert.equal(r.completedCopy.repeat, 'none');
});

test('normal completion + change log', () => {
  const t = M.newTask('a'); M.completeTask(t);
  assert.equal(t.status, 'done'); assert.ok(t.completedAt);
  assert.ok(t.log.some((l) => l.m.includes('הושלם')));
});

test('overdue is never hidden: classified and sorted first', () => {
  const today = '2026-11-25';
  const tasks = [
    M.newTask('late', new Date(), { due: '2026-11-20' }),
    M.newTask('today', new Date(), { due: today }),
    M.newTask('soon', new Date(), { due: '2026-11-28' }),
    M.newTask('far', new Date(), { due: '2027-02-01' }),
    M.newTask('done-late', new Date(), { due: '2026-11-01', status: 'done' }),
  ];
  assert.deepEqual(M.overdue(tasks, today).map((t) => t.title), ['late']);
  assert.deepEqual(M.dueToday(tasks, today).map((t) => t.title), ['today']);
  assert.deepEqual(M.upcoming(tasks, today).map((t) => t.title), ['soon']);
  assert.deepEqual(M.thisWeek(tasks, today).map((t) => t.title), ['late', 'today', 'soon']);
});

test('search across all fields, multiple terms', () => {
  const t1 = M.newTask('קנות חלב', new Date(), { desc: 'בסופר', tags: ['בית'] });
  t1.subtasks.push(M.newSub('לבדוק מבצע', { note: 'שמנת' }));
  const t2 = M.newTask('דו"ח', new Date(), { tags: ['עבודה'] });
  const all = [t1, t2];
  assert.equal(M.search(all, 'חלב').length, 1);
  assert.equal(M.search(all, 'שמנת').length, 1);   // sub-task note
  assert.equal(M.search(all, 'עבודה').length, 1);  // tag
  assert.equal(M.search(all, 'חלב סופר').length, 1);
  assert.equal(M.search(all, 'חלב עבודה').length, 0);
  assert.equal(M.search(all, '   ').length, 0);
});

test('duplicate gets new ids and resets state', () => {
  const t = M.newTask('מקור'); t.subtasks.push(M.newSub('s', { state: 'done' })); M.completeTask(t);
  const d = M.duplicateTask(t);
  assert.notEqual(d.id, t.id); assert.notEqual(d.subtasks[0].id, t.subtasks[0].id);
  assert.equal(d.status, 'todo'); assert.equal(d.subtasks[0].state, 'todo');
});

test('undo stack restores snapshots', () => {
  const u = new M.UndoStack(2); u.push({ a: 1 }); u.push({ a: 2 }); u.push({ a: 3 });
  assert.equal(u.size, 2); assert.deepEqual(u.pop(), { a: 3 }); assert.deepEqual(u.pop(), { a: 2 }); assert.equal(u.pop(), null);
});

test('moveNode reorders', () => {
  const l = ['a', 'b', 'c']; M.moveNode(l, 0, 2); assert.deepEqual(l, ['b', 'c', 'a']);
  assert.equal(M.moveNode(l, 0, 9), false);
});

test('validateData cleans junk and clamps depth', () => {
  const bad = { v: 1, tasks: [{ id: 'a', title: 5, priority: 99, due: 'nope', status: 'weird',
    subtasks: [{ title: 'x', children: [{ title: 'y', children: [{ title: 'too deep' }] }] }] }, null, 7] };
  const d = M.validateData(bad);
  assert.equal(d.tasks.length, 1); assert.equal(d.tasks[0].priority, 1); assert.equal(d.tasks[0].due, '');
  assert.equal(d.tasks[0].status, 'todo');
  assert.equal(d.tasks[0].subtasks[0].children[0].children.length, 0);
  assert.throws(() => M.validateData({ v: 2 }), /bad-data/);
});

test('tags are cleaned', () => { assert.equal(M.cleanTag('  ##עבודה  חשובה '), 'עבודה חשובה'); });

test('red-team: reopening an archived task un-archives it (never hidden everywhere)', () => {
  const t = M.newTask('x'); M.completeTask(t); t.archived = true;
  M.setStatus(t, 'todo');
  assert.equal(t.archived, false); assert.equal(M.isOpen(t), true);
});
test('red-team: recurring task completed late skips to today or later', () => {
  const t = M.newTask('x', new Date(), { due: '2026-11-15', repeat: 'daily' });
  const r = M.completeTask(t, new Date(2026, 10, 25, 12));
  assert.equal(r.nextDue, '2026-11-25');
});
test('red-team: parent of all-cancelled children can be marked done; search ignores log text; sub-task category counts', () => {
  const p = M.newSub('p'); p.children.push(M.newSub('a', { state: 'cancelled' }));
  M.setNodeState(p, 'done'); assert.equal(M.nodeState(p), 'done');
  const d = M.emptyData(); const c = M.addCategory(d, 'כספים');
  const t = M.newTask('משימה'); t.subtasks.push(M.newSub('s', { category: c.id })); d.tasks.push(t);
  assert.equal(M.categoryStats(d).find((r) => r.id === c.id).open, 1);
  assert.equal(M.search(d.tasks, 'נוצרה', d).length, 0);
});

test('reminder is independent of due date and appears in its own section', () => {
  const t = M.newTask('x', new Date('2026-11-01'), { due: '2026-12-10', remindDate: '2026-11-26' });
  const secs = M.homeSections([t], '2026-11-26', { scope: 'all' });
  assert.deepEqual(secs.map((s) => s.id), ['remind']);
  assert.equal(M.summary([t], '2026-11-26').today, 1);
  const later = M.homeSections([t], '2026-11-20', { scope: 'all' });
  assert.deepEqual(later.map((s) => s.id), ['later']);
});

test('sub-task with its own date is a row of its own; done/validate keep fields', () => {
  const t = M.newTask('big', new Date('2026-11-01'), { due: '2027-01-01' });
  t.subtasks.push(M.newSub('part', { due: '2026-11-26', remindDate: '2026-11-25' }));
  const secs = M.homeSections([t], '2026-11-26', { scope: 'all' });
  const ids = secs.flatMap((s) => s.tasks.map((x) => !!x.isSub));
  assert.ok(ids.includes(true));
  const v = M.validateData({ v: 1, settings: {}, categories: [], tasks: [t] });
  assert.equal(v.tasks[0].subtasks[0].remindDate, '2026-11-25');
  M.setNodeState(t.subtasks[0], 'done');
  assert.equal(M.subEntries([t]).length, 0);
});

test('calendar export masks titles and never leaks the full title', () => {
  assert.equal(M.maskTitle('משימת אמצעי לחימה'), 'מש*** אמ*** לח***');
  const t = M.newTask('אמצעי לחימה סודי', new Date('2026-11-01'), { remindDate: '2026-12-01', remindAt: '09:45' });
  const m = M.buildIcs([t], new Date('2026-11-26'), 'masked');
  assert.ok(m.text.includes('DTSTART:20261201T094500') && !m.text.includes('סודי') && m.count === 1);
  const g = M.buildIcs([t], new Date('2026-11-26'), 'generic');
  assert.ok(!g.text.includes('אמ') && g.text.includes('VALARM'));
});

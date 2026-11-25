// vault.js - the encrypted "safe" on disk. Only ciphertext is ever written.
// The backend is injectable so the same code is tested in Node and runs on IndexedDB in the browser.
import { sealNew, openRecord, encryptJSON, KDF_ITERATIONS, BadPasscodeError } from './crypto.js';

const VAULT_AAD = 'SafeTasks-vault-v1';
const EXPORT_AAD = 'SafeTasks-export-v1';
const EXPORT_MAGIC = 'SafeTasksExport';
const REC_KEY = 'vault';

// ---------- storage backends ----------
export function memoryBackend() {
  const m = new Map();
  return {
    async get(k) { return m.get(k); },
    async put(k, v) { m.set(k, JSON.parse(JSON.stringify(v))); },
    async add(k, v) { if (m.has(k)) throw new Error('exists'); m.set(k, JSON.parse(JSON.stringify(v))); },
    async clear() { m.clear(); },
    _dump() { return JSON.stringify([...m.entries()]); },
  };
}

export function idbBackend(dbName = 'safetasks', storeName = 'kv') {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open(dbName, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(storeName);
    r.onsuccess = () => res(r.result);
    r.onerror = () => { dbp = null; rej(r.error); };
    r.onblocked = () => { dbp = null; rej(new Error('blocked')); };
  }));
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(storeName, mode);
      const out = fn(t.objectStore(storeName));
      t.oncomplete = () => res(out && 'result' in out ? out.result : undefined);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  };
  const deleteDb = () => new Promise((res, rej) => {
    const r = indexedDB.deleteDatabase(dbName);
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('blocked'));
  });
  return {
    get: (k) => tx('readonly', (s) => s.get(k)),
    put: (k, v) => tx('readwrite', (s) => s.put(v, k)),
    add: (k, v) => tx('readwrite', (s) => s.add(v, k)), // fails if it already exists: never overwrites
    // Only a real success counts. A blocked or failed delete is retried, then reported as an error.
    clear: async () => {
      if (dbp) { try { (await dbp).close(); } catch (e) { /* ignore */ } dbp = null; }
      let last;
      for (let i = 0; i < 5; i++) {
        try { await deleteDb(); return; } catch (e) { last = e; await new Promise((r) => setTimeout(r, 300)); }
      }
      throw last || new Error('delete-failed');
    },
  };
}

// ---------- the vault ----------
// `cur` (key + salt + iterations) lives in memory only and is never stored.
// lockEpoch: bumped by lock()/wipe(); an unlock/create that finishes after a lock is discarded.
// wipeEpoch: bumped by wipe(); a save that finishes after a wipe writes nothing.
export class Vault {
  constructor(backend) {
    this.backend = backend;
    this.cur = null;
    this.lockEpoch = 0;
    this.wipeEpoch = 0;
    this._q = Promise.resolve();
  }

  get unlocked() { return !!this.cur; }
  async exists() { return !!(await this.backend.get(REC_KEY)); }

  // Never overwrites an existing vault.
  async create(passcode, data) {
    const epoch = this.lockEpoch;
    const { key, record } = await sealNew(passcode, data, VAULT_AAD);
    await this.backend.add(REC_KEY, { v: 1, ...record });
    if (epoch !== this.lockEpoch) throw new Error('locked-meanwhile');
    this.cur = { key, salt: record.salt, iter: record.iter };
  }

  // `validate` runs BEFORE the key is kept, so a failure never leaves a key in memory.
  async unlock(passcode, validate = (x) => x) {
    const epoch = this.lockEpoch;
    const rec = await this.backend.get(REC_KEY);
    if (!rec) throw new Error('no-vault');
    const { key, value } = await openRecord(passcode, rec, VAULT_AAD);
    const clean = validate(value);
    if (epoch !== this.lockEpoch) throw new Error('locked-meanwhile'); // app went to background meanwhile
    this.cur = { key, salt: rec.salt, iter: rec.iter };
    return clean;
  }

  // Serialized so saves can never interleave. Takes the key and a private copy of the data NOW,
  // so locking a moment later cannot lose this save, and later edits cannot sneak into it.
  save(data) {
    const cur = this.cur, epoch = this.wipeEpoch;
    if (!cur) return Promise.reject(new Error('locked'));
    const copy = JSON.parse(JSON.stringify(data));
    const run = async () => {
      if (epoch !== this.wipeEpoch) return; // wiped meanwhile: write nothing
      const { iv, ct } = await encryptJSON(cur.key, copy, `${VAULT_AAD}|${cur.iter}`);
      if (epoch !== this.wipeEpoch) return;
      await this.backend.put(REC_KEY, { v: 1, iter: cur.iter, salt: cur.salt, iv, ct });
    };
    this._q = this._q.then(run, run);
    return this._q;
  }

  // Checks a passcode against the stored vault without changing anything.
  async verify(passcode) {
    const rec = await this.backend.get(REC_KEY);
    if (!rec) throw new Error('no-vault');
    await openRecord(passcode, rec, VAULT_AAD);
  }

  lock() { this.cur = null; this.lockEpoch += 1; }

  // Goes through the same queue as saves, so no save can overwrite the new record with the old key.
  async changePasscode(oldPass, newPass, getData) {
    const rec = await this.backend.get(REC_KEY);
    await openRecord(oldPass, rec, VAULT_AAD); // throws BadPasscodeError if wrong
    const { key, record } = await sealNew(newPass, getData(), VAULT_AAD);
    const next = { key, salt: record.salt, iter: record.iter };
    const epoch = this.wipeEpoch;
    this.cur = next; // saves made from now on use the new key and run after the swap below
    const run = async () => {
      if (epoch !== this.wipeEpoch) return;
      const { iv, ct } = await encryptJSON(next.key, JSON.parse(JSON.stringify(getData())), `${VAULT_AAD}|${next.iter}`);
      await this.backend.put(REC_KEY, { v: 1, iter: next.iter, salt: next.salt, iv, ct });
    };
    this._q = this._q.then(run, run);
    return this._q;
  }

  // "Delete everything": removes the data AND forgets the key. Verifies that it really is gone.
  async wipe() {
    this.cur = null;
    this.lockEpoch += 1;
    this.wipeEpoch += 1;
    await this._q.catch(() => {});
    await this.backend.clear();
    if (await this.exists()) throw new Error('wipe-failed');
  }
}

// ---------- encrypted export and import, with a separate password ----------
export async function makeExport(data, exportPass) {
  const { record } = await sealNew(exportPass, { format: 'SafeTasks', v: 1, data }, EXPORT_AAD);
  return JSON.stringify({ app: EXPORT_MAGIC, v: 1, ...record });
}

export async function readExport(text, exportPass) {
  let obj;
  try { obj = JSON.parse(text); } catch (e) { throw new Error('not-our-file'); }
  if (!obj || obj.app !== EXPORT_MAGIC || obj.v !== 1) throw new Error('not-our-file');
  const { value } = await openRecord(exportPass, obj, EXPORT_AAD); // GCM = integrity check
  if (!value || value.format !== 'SafeTasks' || value.v !== 1 || typeof value.data !== 'object') {
    throw new Error('not-our-file');
  }
  return value.data;
}

export { BadPasscodeError };

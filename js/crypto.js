// crypto.js - all encryption lives here. Uses ONLY the browser's built-in WebCrypto.
// AES-256-GCM for encryption, PBKDF2-HMAC-SHA256 (600,000 iterations) for turning the
// passcode into a key. (Argon2id would need an outside library, so PBKDF2 is used.)

export const KDF_ITERATIONS = 600000;
const enc = new TextEncoder();
const dec = new TextDecoder();

export class BadPasscodeError extends Error {
  constructor() { super('bad-passcode'); this.name = 'BadPasscodeError'; }
}

export function randomBytes(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
}

export function toB64(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(s);
}

export function fromB64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// Derive a NON-extractable AES-256-GCM key from a passcode.
export async function deriveKey(passcode, salt, iterations = KDF_ITERATIONS) {
  const material = await crypto.subtle.importKey(
    'raw', enc.encode(String(passcode).normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']);
}

// Encrypt any JSON value. A fresh random 12-byte IV is used every single time.
// `aad` (a label such as "vault-v1") is authenticated so a file of one kind
// can never be passed off as another.
export async function encryptJSON(key, value, aad) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(aad) },
    key, enc.encode(JSON.stringify(value)));
  return { iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}

export async function decryptJSON(key, ivB64, ctB64, aad) {
  let plain;
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(ivB64), additionalData: enc.encode(aad) },
      key, fromB64(ctB64));
  } catch (e) {
    // GCM authentication failed: wrong passcode OR the data was altered.
    throw new BadPasscodeError();
  }
  return JSON.parse(dec.decode(plain));
}

// Build a brand-new encrypted record (new random salt).
// The iteration count is bound into the authenticated label, so it cannot be tampered with.
export async function sealNew(passcode, value, aad, iterations = KDF_ITERATIONS) {
  const salt = randomBytes(16);
  const key = await deriveKey(passcode, salt, iterations);
  const { iv, ct } = await encryptJSON(key, value, `${aad}|${iterations}`);
  return { key, record: { iter: iterations, salt: toB64(salt), iv, ct } };
}

// Open an existing record with a passcode. Returns { key, value }.
export async function openRecord(passcode, record, aad) {
  // Policy: never accept fewer iterations than we write today (no downgrade), and cap the
  // maximum so a crafted file cannot freeze the phone.
  if (!record || typeof record.salt !== 'string' || typeof record.iv !== 'string' ||
      typeof record.ct !== 'string' || !Number.isInteger(record.iter) ||
      record.iter < KDF_ITERATIONS || record.iter > 2000000) {
    throw new Error('bad-record');
  }
  const key = await deriveKey(passcode, fromB64(record.salt), record.iter);
  const value = await decryptJSON(key, record.iv, record.ct, `${aad}|${record.iter}`);
  return { key, value };
}

// Static audit: proves the app contains no network code, no outside addresses, no unsafe patterns.
// Run: node tools/audit.mjs   (exit code 1 if anything is found)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skip = new Set(['tests', 'tools', 'node_modules', '.git']);
const files = [];
(function walk(d) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    if (skip.has(f.name)) continue;
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p); else if (/\.(js|html|css|webmanifest|json)$/.test(f.name)) files.push(p);
  }
})(root);

const rules = [
  ['network call: fetch(', /\bfetch\s*\(/],
  ['network call: XMLHttpRequest', /XMLHttpRequest/],
  ['network call: WebSocket', /WebSocket/],
  ['network call: EventSource', /EventSource/],
  ['network call: sendBeacon', /sendBeacon/],
  ['importScripts', /importScripts/],
  ['dynamic import()', /\bimport\s*\(/],
  ['outside address (http/https/ftp/ws URL)', /\b(?:https?|ftp|wss?):\/\//i],
  ['protocol-relative URL', /["'(]\/\/[a-z0-9.-]+\.[a-z]{2,}/i],
  ['@import / url() in css', /@import|url\s*\(/],
  ['eval / new Function', /\beval\s*\(|new\s+Function\s*\(/],
  ['innerHTML / outerHTML / insertAdjacentHTML / document.write', /innerHTML|outerHTML|insertAdjacentHTML|document\.write/],
  ['clipboard access', /clipboard/i],
  ['notifications / push', /Notification|PushManager|pushManager/],
  ['console logging', /console\./],
  ['geolocation / media devices', /geolocation|mediaDevices/],
  ['external <script>/<link>/<img>/<iframe> src or href', /<(?:script|link|img|iframe)[^>]+(?:src|href)=["'](?!\.?\/?(?:js|css|icons|manifest)[^"']*["'])[^"']*(?:\/\/)/i],
];
// Allowed, documented exceptions: the service worker serves/refreshes the app's OWN files only.
const allowed = [
  { file: 'js/dom.js', rule: 'outside address (http/https/ftp/ws URL)', why: 'the SVG XML namespace NAME for drawing icons; it is an identifier, never contacted' },{ file: 'sw.js', rule: 'network call: fetch(', why: 'service worker falls back to fetching the app\'s own same-origin file; outside origins are never handled (sw.js line "url.origin !== self.location.origin")' }];

let bad = 0;
for (const f of files) {
  const rel = path.relative(root, f).replaceAll('\\', '/');
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const [name, re] of rules) {
      if (!re.test(line)) continue;
      const ex = allowed.find((a) => a.file === rel && a.rule === name);
      if (ex) { console.log(`ALLOWED  ${rel}:${i + 1}  ${name}  (${ex.why})`); continue; }
      console.log(`FOUND    ${rel}:${i + 1}  ${name}\n         ${line.trim().slice(0, 140)}`); bad++;
    }
  });
}

// Policy checks
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const csp = (html.match(/Content-Security-Policy"\s+content="([^"]+)"/) || [])[1] || '';
const need = ["default-src 'none'", "connect-src 'none'", "script-src 'self'", "form-action 'none'", "frame-src 'none'", "object-src 'none'"];
for (const n of need) { if (!csp.includes(n)) { console.log(`FOUND    index.html  CSP missing: ${n}`); bad++; } }
if (/unsafe-inline|unsafe-eval|\*/.test(csp)) { console.log('FOUND    index.html  CSP too loose'); bad++; }
if (/\sstyle=|\son[a-z]+=/i.test(html)) { console.log('FOUND    index.html  inline style/handler attribute'); bad++; }
const man = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
const extraKeys = Object.keys(man).filter((k) => ['permissions', 'share_target', 'protocol_handlers', 'file_handlers', 'related_applications'].includes(k));
if (extraKeys.length) { console.log('FOUND    manifest  extra capability keys: ' + extraKeys); bad++; }
for (const f of fs.readdirSync(path.join(root, 'js'))) { /* list of modules for the record */ }

console.log(`\nFiles scanned: ${files.length}`);
console.log(`CSP: ${csp}`);
console.log(bad ? `\nAUDIT FAILED: ${bad} finding(s)` : '\nAUDIT PASSED: no network code, no outside addresses, no unsafe patterns.');
process.exit(bad ? 1 : 0);

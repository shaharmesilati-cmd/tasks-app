import { start } from './ui.js';

start();

// Offline copy of the app's own code files (no data). Only works on a secure (https) address.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* app still works online */ });
}

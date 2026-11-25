// guard.js - slows down passcode guessing. The counter is stored in plain form on purpose
// (it only holds numbers, no task content). Delays grow after repeated wrong attempts.

const KEY = 'st.guard';
export const DELAYS_SEC = [0, 0, 0, 30, 60, 300, 900, 3600]; // by number of failures so far

export function delayFor(fails) {
  return DELAYS_SEC[Math.min(fails, DELAYS_SEC.length - 1)];
}

export function makeGuard(storage, now = () => Date.now()) {
  const read = () => {
    try { return JSON.parse(storage.getItem(KEY)) || { fails: 0, until: 0 }; }
    catch (e) { return { fails: 0, until: 0 }; }
  };
  const write = (s) => { try { storage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* ignore */ } };
  return {
    // seconds left to wait (0 = allowed to try now)
    waitSec() {
      const s = read();
      return Math.max(0, Math.ceil((s.until - now()) / 1000));
    },
    fail() {
      const s = read();
      s.fails += 1;
      s.until = now() + delayFor(s.fails) * 1000;
      write(s);
      return s;
    },
    ok() { write({ fails: 0, until: 0 }); },
    reset() { try { storage.removeItem(KEY); } catch (e) { /* ignore */ } },
    state: read,
  };
}

// A terminal owns its retry policy. Network loss may retry; authorization or
// policy rejection must yield immediately to the sign-in/error UI.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WebTunTerminalConnection = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function createRetryPolicy({ maxAttempts = 10, random = Math.random } = {}) {
    let attempts = 0, delay = 1000, freshRetried = false, stopped = false;
    return {
      maxAttempts,
      get stopped() { return stopped; },
      reset() { attempts = 0; delay = 1000; freshRetried = stopped = false; },
      next({ closed = false, code, reason = '', sessionId } = {}) {
        if (closed || code === 1008) {
          stopped = true;
          return { action: code === 1008 && /unauthorized|revoked|pin changed|session no longer valid/i.test(reason) ? 'auth' : 'stop', reason };
        }
        if (stopped) return { action: 'stop' };
        attempts++;
        if (attempts > maxAttempts) {
          if (sessionId && !freshRetried) {
            freshRetried = true; attempts = 0; delay = 1000;
            return { action: 'fresh', delay: 1000 };
          }
          stopped = true;
          return { action: 'stop' };
        }
        delay = Math.min(delay * 2, 15000);
        return { action: 'retry', attempt: attempts, delay: delay + Math.floor(random() * 750) };
      },
    };
  }
  return { createRetryPolicy };
});

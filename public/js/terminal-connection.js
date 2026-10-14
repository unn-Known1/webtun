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
      next({ closed = false, exited = false, code, reason = '', sessionId } = {}) {
        if (closed || exited || reason === 'Process exited' || code === 1008) {
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
  // Streaming escape parser used only for history approximation, never input
  // transport. Keep state across chunks, with no unbounded sequence buffer.
  function trackInput(tab, data) {
    let state = tab._inputEscape || '';
    for (const char of data) {
      const c = char.codePointAt(0);
      if (state === 'csi' || state === 'ss3') {
        if (c >= 0x40 && c <= 0x7e) state = '';
        else if (c === 27) state = 'esc';
        continue;
      }
      if (state === 'osc' || state === 'string') {
        if (c === 7 && state === 'osc') state = '';
        else if (c === 27) state += '-esc';
        continue;
      }
      if (state === 'osc-esc' || state === 'string-esc') {
        state = char === '\\' ? '' : state.replace('-esc', '');
        continue;
      }
      if (state === 'esc') {
        state = char === '[' ? 'csi' : char === 'O' ? 'ss3' : char === ']' ? 'osc' : 'PX^_'.includes(char) ? 'string' : '';
        if (!state && char.toLowerCase() === 'd') tab._currentInput = (tab._currentInput || '').replace(/\S+\s*$/, '');
        continue;
      }
      if (c === 27) { state = 'esc'; continue; }
      if (c === 0x9b) { state = 'csi'; continue; }
      if (c === 127 || c === 8) tab._currentInput = (tab._currentInput || '').slice(0, -1);
      else if (c === 21 || c === 3 || c === 4) { tab._currentInput = ''; if (c !== 21) tab._lastPasteText = null; }
      else if (c === 23) tab._currentInput = (tab._currentInput || '').replace(/\S+\s*$/, '');
      else if (c === 11) { tab._yank = tab._currentInput || ''; tab._currentInput = ''; }
      else if (c === 25 && tab._yank) tab._currentInput = ((tab._currentInput || '') + tab._yank).slice(-4096);
      else if (c >= 32 && c !== 127 && !(c >= 0x80 && c <= 0x9f)) tab._currentInput = ((tab._currentInput || '') + char).slice(-4096);
    }
    tab._inputEscape = state;
  }
  return { createRetryPolicy, trackInput };
});

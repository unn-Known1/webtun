// WebTun frontend - terminal.js (terminal WS, xterm core, keys, search, mobile.)

function cleanupWebSocket(tab) {
  if (tab.ws) {
    tab.ws.onopen = null;
    tab.ws.onmessage = null;
    tab.ws.onerror = null;
    tab.ws.onclose = null;
    try { tab.ws.close(); } catch(e) { console.warn(e); }
    tab.ws = null;
  }
  if (tab.pingTimer) {
    clearInterval(tab.pingTimer);
    tab.pingTimer = null;
  }
}

function connectWebSocket(tab, isReconnect = false) {
  if (tab.closed || !tab.term) return;
  clearTimeout(tab.reconnectTimer);
  cleanupWebSocket(tab);

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const cols = tab.term.cols, rows = tab.term.rows;
  const sessionParam = tab.sessionId ? `&session=${encodeURIComponent(tab.sessionId)}` : '';
  const wsUrl = `${proto}://${location.host}/ws?token=${encodeURIComponent(authToken)}&cols=${cols}&rows=${rows}&cwd=${encodeURIComponent(tab.cwd || currentPath)}${sessionParam}`;
  const ws = new WebSocket(wsUrl);
  tab.ws = ws;
  ws.binaryType = 'arraybuffer';

  const sendInput = data => {
    if (ws.readyState !== WebSocket.OPEN) return;
    // On Enter, capture the command for history
    for (let i = 0; i < data.length; i++) {
      const ch = data.charCodeAt(i);
      if (ch === 13 || ch === 10) { // Enter
        try {
          // Prefer stored paste text
          let text = tab._lastPasteText;
          tab._lastPasteText = null;
          if (text) {
            // For multi-line pastes, take only the last line (the command)
            const lines = text.split('\n');
            text = lines[lines.length - 1] || lines[lines.length - 2] || text;
            text = text.trim();
          } else {
            // Use the tracked input buffer (more reliable than buffer scanning)
            text = (tab._currentInput || '').trim();
            // Strip any leaked VT/ANSI parameter junk that bypassed the escape parser
            text = text.replace(/^[>;\d\s]+(?=[a-zA-Z/\\~\-.])/, '').replace(/^[>;\d\s]+$/, '').trim();
          }
          if (text) addToCmdHist(text);
          tab._currentInput = ''; // Clear after history save
        } catch {}
      }
    }
    // Chunked send (server caps input per message)
    sendWsInput(ws, data);

    // Update the keystroke buffer — skip all escape sequences and control characters
    for (let i = 0; i < data.length; i++) {
      const ch = data.charCodeAt(i);
      if (ch === 13 || ch === 10) { // Enter (handled above)
        continue;
      } else if (ch === 127 || ch === 8) { // Backspace / Delete
        if (tab._currentInput) tab._currentInput = tab._currentInput.slice(0, -1);
      } else if (ch === 21) { // ^U — clear line
        tab._currentInput = '';
      } else if (ch === 23) { // ^W — delete word
        if (tab._currentInput) tab._currentInput = tab._currentInput.replace(/\S+\s*$/, '');
      } else if (ch === 27) { // ESC — skip entire escape sequence
        i++;
        if (data[i] === ']') { // OSC — skip to BEL or ESC-backslash (title text isn't input)
          i++;
          while (i < data.length) {
            if (data.charCodeAt(i) === 7) { i++; break; }
            if (data[i] === '\x1b' && data[i+1] === '\\') { i += 2; break; }
            i++;
          }
          i--; // compensate for-loop increment (already past terminator)
        } else if (data[i] === 'P') { // DCS — skip to ESC-backslash
          i++;
          while (i < data.length) {
            if (data[i] === '\x1b' && data[i+1] === '\\') { i += 2; break; }
            i++;
          }
          i--;
        } else { // CSI / SS3 / single-ESC — skip to final char (for-loop moves past it)
          while (i < data.length) {
            const c = data.charCodeAt(i);
            if (c >= 0x40 && c <= 0x7E) break;
            i++;
          }
        }
      } else if (ch >= 32 && ch !== 127) { // Printable (incl. unicode), not DEL
        tab._currentInput = (tab._currentInput || '') + data[i];
        // Cap buffer on long-lived tabs (history only needs the tail)
        if (tab._currentInput.length > 4096) tab._currentInput = tab._currentInput.slice(-4096);
      }
      // All other control chars (0x00-0x1F except 0x0D/0x0A) are silently dropped
    }
  };
  const sendResize = (cols, rows) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const dv = new DataView(new ArrayBuffer(5));
    dv.setUint8(0, 0x01); dv.setUint16(1, cols, true); dv.setUint16(3, rows, true);
    ws.send(dv.buffer);
  };

  ws.onopen = () => {
    tab.reconnectDelay = 1000;
    tab.reconnectAttempts = 0;
    hideTermLoading(tab);
    try { if (typeof clearTabExited === 'function') clearTabExited(tab); } catch {}
    try { if (typeof refreshConnStatus === 'function') refreshConnStatus(); else updateConnStatus(true); } catch {}
    const banner = document.getElementById('reconnect-banner');
    if (banner) {
      banner.innerHTML = '<span class="reconnect-spinner"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></span> Reconnecting…';
      banner.style.display = 'none';
    }
    if (isReconnect) {
      tab.term.writeln('\x1b[32m[Reconnected]\x1b[0m');
    }
    tab.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(new Uint8Array([0x02]).buffer);
    }, 20000);
    setupVisualViewport();
  };

  // OSC sequence handler: intercepts OSC 7, 133, 52 before passing to xterm.js
  let oscBuf = '';
  function processTerminalOutput(data) {
    const str = typeof data === 'string' ? data : new TextDecoder().decode(data);
    let out = '';
    let i = 0;
    while (i < str.length) {
      // Look for ESC ] (OSC introducer)
      if (str[i] === '\x1b' && str[i + 1] === ']') {
        const endIdx = str.indexOf('\x07', i + 2);
        const stIdx = str.indexOf('\x1b\\', i + 2);
        let oscEnd = -1;
        if (endIdx !== -1 && (stIdx === -1 || endIdx < stIdx)) oscEnd = endIdx;
        else if (stIdx !== -1) oscEnd = stIdx;

        if (oscEnd !== -1) {
          const oscData = str.substring(i + 2, oscEnd);
          const semi = oscData.indexOf(';');
          if (semi !== -1) {
            const code = oscData.substring(0, semi);
            const value = oscData.substring(semi + 1);
            if (code === '7') {
              // OSC 7: CWD update — file://hostname/path
              try {
                const url = new URL(value);
                tab.cwd = decodeURIComponent(url.pathname);
              } catch (_) {}
            } else if (code === '133') {
              // OSC 133: Shell integration markers (prompt/cmd start/end/done)
              // Handled silently — available for future command tracking
            } else if (code === '52') {
              // OSC 52: Clipboard operations
              const parts = value.split(';');
              const targets = parts[0] || 'c';
              const b64 = parts.slice(1).join(';');
              if (b64) {
                // SET clipboard — always honored (a program can only overwrite,
                // never read). UTF-8 safe, so emoji/CJK are no longer dropped.
                try {
                  const decoded = b64ToUtf8(b64);
                  if (targets.includes('c') || targets.includes('p')) {
                    navigator.clipboard.writeText(decoded).catch(() => {});
                  }
                } catch (_) {}
              } else if (settings.clipboardRead) {
                // GET clipboard — opt-in (Settings → Terminal). Any remote
                // output could otherwise pull the local clipboard into the
                // session with no prompt at all: a stray
                // `printf '\e]52;c;?'`, a malicious script, a pasted payload.
                navigator.clipboard.readText().then(text => {
                  const response = '\x1b]52;c;' + utf8ToB64(text) + '\x07';
                  if (tab.ws && tab.ws.readyState === WebSocket.OPEN) {
                    const enc = new TextEncoder().encode(response);
                    const buf = new Uint8Array(1 + enc.length);
                    buf[0] = 0x00; buf.set(enc, 1);
                    tab.ws.send(buf.buffer);
                  }
                }).catch(() => {});
              } else if (!tab._clipReadHintShown) {
                tab._clipReadHintShown = true;
                toast('A program asked to read your clipboard — enable "Allow terminal clipboard read" in Settings', 'warning');
              }
            }
          }
          i = oscEnd + (str[oscEnd] === '\x07' ? 1 : 2);
          continue;
        }
      }
      out += str[i];
      i++;
    }
    if (out) {
      tab.term.write(out);
      try { scanPreviewHint(tab, out.slice(-2000)); } catch {}
      try { if (typeof notifyTabOutput === 'function') notifyTabOutput(tab); } catch {}
    }
  }

  // Defensive: ws.binaryType is set to 'arraybuffer' right after construction,
  // but a Blob frame (or an unexpected string frame) must not throw inside the
  // message handler — that would kill the socket handler mid-session.
  ws.onmessage = async e => {
    let buf;
    if (e.data instanceof ArrayBuffer) {
      buf = new Uint8Array(e.data);
    } else if (typeof Blob !== 'undefined' && e.data instanceof Blob) {
      try { buf = new Uint8Array(await e.data.arrayBuffer()); } catch { return; }
    } else if (typeof e.data === 'string') {
      buf = new TextEncoder().encode(e.data);
    } else {
      return;
    }
    if (!buf.length) return;
    const type = buf[0], payload = buf.slice(1);
    if (type === 0x00) processTerminalOutput(payload);
    else if (type === 0x01) { tab.term.writeln('\r\n\x1b[31m[Process exited]\x1b[0m'); try { if (typeof notifyTabExited === 'function') notifyTabExited(tab); } catch {} }
    else if (type === 0x02) tab.term.writeln('\r\n\x1b[31m' + new TextDecoder().decode(payload) + '\x1b[0m');
    else if (type === 0x03) handleClientEvent(payload);
  };

// Server-pushed security events (0x03 JSON): new-login alerts, session-revoked kicks.
function handleClientEvent(payload) {
  let ev = null;
  try { ev = JSON.parse(new TextDecoder().decode(payload)); } catch { return; }
  if (!ev || !ev.event) return;
  if (ev.event === 'new-login') {
    const when = ev.at ? new Date(ev.at).toLocaleString() : 'just now';
    toast(`New login — ${ev.device || 'unknown device'} · ${ev.ip || 'unknown IP'} · ${when}`, 'warning');
    // Persistent triangle until reviewed (toast alone vanishes)
    try { addSecurityAlert(ev); } catch {}
    try { updateSessionCupCount(); } catch {}
    // Refresh the sessions list if the Security panel is visible
    try {
      const sp = document.getElementById('settings-panel');
      if (sp && sp.classList.contains('open') && typeof refreshSessions === 'function') refreshSessions();
    } catch {}
  } else if (ev.event === 'session-revoked') {
    toast('This session was signed out remotely', 'error');
    storeSessionToken('');
    authToken = '';
    showPinScreen();
  } else if (ev.event === 'session-pending') {
    // A new device passed the PIN but is locked until WE approve it.
    // Instant modal here; the sessions list holds Approve/Deny as backstop.
    try { if (typeof refreshSessions === 'function') refreshSessions(); } catch {}
    try { updateSessionCupCount(); } catch {}
    try { addSecurityAlert({ ip: ev.ip, device: `Login approval requested by ${ev.device || 'unknown device'}`, at: ev.at }); } catch {}
    confirmDialog({
      title: 'Approve this device?',
      message: `${ev.device || 'Unknown device'} (${ev.ip || 'unknown IP'}) entered the correct PIN and is waiting for access. Approve it, or dismiss and Deny it in Security.`,
      okText: 'Approve device', cancelText: 'Dismiss', danger: true,
    }).then(async ok => {
      if (!ok) return;
      await approveSession(ev.id);
    }).catch(() => {});
  } else if (ev.event === 'pin-change-pending') {
    // A fresh session asked to rotate the PIN. Act in this very moment:
    // instant modal here, persistent banner in Security as backstop.
    try { if (typeof refreshSessions === 'function') refreshSessions(); } catch {}
    const mine = ev.requester && ev.requester === authToken;
    if (mine) {
      toast('PIN change pending — approve it from another signed-in tab', 'info');
    } else {
      const when = ev.expiresAt ? new Date(ev.expiresAt).toLocaleTimeString() : '';
      confirmDialog({
        title: 'Approve PIN change?',
        message: `${ev.device || 'Unknown device'} (${ev.ip || 'unknown IP'}) wants to change the PIN${when ? ` — expires ${when}` : ''}. If this wasn't you, dismiss and Revert it in Security.`,
        okText: 'Approve change', cancelText: 'Dismiss', danger: true,
      }).then(async ok => {
        if (!ok) return;
        await approvePinChange();
      }).catch(() => {});
      try { addSecurityAlert({ ip: ev.ip, device: `PIN change requested by ${ev.device || 'unknown device'}`, at: Date.now() }); } catch {}
    }
  } else if (ev.event === 'pin-change-resolved') {
    toast(ev.approved ? 'PIN change approved and applied' : `PIN change stopped${ev.expired ? ' (expired)' : ''}${ev.vetoed ? ' (reverted)' : ''}`, ev.approved ? 'success' : 'info');
    try { if (typeof refreshSessions === 'function') refreshSessions(); } catch {}
    try { updateSessionCupCount(); } catch {}
  } else if (ev.event === 'pin-changed') {
    const what = ev.disabled ? 'PIN protection was REMOVED' : 'PIN was changed';
    toast(`${what} by ${ev.device || 'unknown device'} · ${ev.ip || 'unknown IP'} — re-login required`, 'error');
    // Persistent: survives the kick to the PIN screen, shown on next unlock
    try { addSecurityAlert({ ip: ev.ip, device: `${what} by ${ev.device || 'unknown device'}`, at: ev.at }); } catch {}
  } else if (ev.event === 'sessions-changed') {
    try { updateSessionCupCount(); } catch {}
    try {
      const sp = document.getElementById('settings-panel');
      if (sp && sp.classList.contains('open') && typeof refreshSessions === 'function') refreshSessions();
    } catch {}
  }
}

  ws.onerror = (e) => { console.warn('WS error:', e.type); };

  ws.onclose = () => {
    cleanupWebSocket(tab);
    if (tab.closed) return;
    try { if (typeof refreshConnStatus === 'function') refreshConnStatus(); else updateConnStatus(false); } catch {}
    tab.reconnectAttempts = (tab.reconnectAttempts || 0) + 1;
    const _attempt = tab.reconnectAttempts;
    const _maxAttempts = 10;
    const spinnerHtml = '<span class="reconnect-spinner"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></span>';
    const banner = document.getElementById('reconnect-banner');
    // Honor the cap: after _maxAttempts, stop auto-retry and leave the
    // manual Reconnect button (auto-loop never yielded before).
    if (_attempt > _maxAttempts) {
      if (banner) {
        banner.innerHTML = `Connection lost — auto-retry stopped. <button class="btn btn-primary" onclick="manualReconnect()" style="height:26px;padding:0 12px;font-size:11px;margin-left:8px">Reconnect</button>`;
        banner.style.display = 'block';
      }
      tab.term.writeln('\r\n\x1b[33m[Disconnected — auto-retry stopped. Press Reconnect above.]\x1b[0m');
      return;
    }
    if (banner) {
      if (_attempt >= 3) {
        banner.innerHTML = `Connection lost — retry ${_attempt}/${_maxAttempts}. <button class="btn btn-primary" onclick="manualReconnect()" style="height:26px;padding:0 12px;font-size:11px;margin-left:8px">Reconnect</button>`;
      } else {
        banner.innerHTML = `${spinnerHtml} Reconnecting (${_attempt}/${_maxAttempts})…`;
      }
      banner.style.display = 'block';
    }
    tab.reconnectDelay = Math.min((tab.reconnectDelay || 1000) * 2, 15000);
    const secs = tab.reconnectDelay / 1000;
    tab.term.writeln(`\r\n\x1b[33m[Disconnected — reconnecting in ${secs}s (attempt ${_attempt}/${_maxAttempts})…]\x1b[0m`);
    tab.reconnectTimer = setTimeout(() => {
      if (!tab.closed) connectWebSocket(tab, true);
    }, tab.reconnectDelay);
  };

  tab.dataDisposable?.dispose();
  tab.resizeDisposable?.dispose();
  tab.dataDisposable = tab.term.onData(data => sendInput(data));
  tab.resizeDisposable = tab.term.onResize(({ cols, rows }) => sendResize(cols, rows));
}

function manualReconnect() {
  const banner = document.getElementById('reconnect-banner');
  if (banner) {
    banner.innerHTML = '<span class="reconnect-spinner"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></span> Reconnecting (1/10)…';
    banner.style.display = 'block';
  }
  tabs.forEach(tab => {
    if (tab.closed) return;
    if (!tab.ws || tab.ws.readyState !== WebSocket.OPEN) {
      tab.reconnectDelay = 1000;
      tab.reconnectAttempts = 0;
      connectWebSocket(tab, true);
    }
  });
}
function initTerminal(tab) {
  const cfg = {
    fontFamily: settings.font,
    fontSize: settings.fontSize,
    cursorStyle: settings.cursor,
    cursorBlink: settings.blink,
    scrollback: settings.scrollback,
    allowTransparency: false,
    theme: getXtermTheme(),
    windowsMode: serverPlatform === 'win32',
    convertEol: false,
    bellStyle: settings.bell ? 'sound' : 'none',
    smoothScrollDuration: 80,
    selectionTheme: getXtermSelectionTheme()
  };

  const term = new Terminal(cfg);
  const fitAddon = new FitAddon.FitAddon();
  const searchAddon = new SearchAddon.SearchAddon();
  const webLinksAddon = new WebLinksAddon.WebLinksAddon();

  term.loadAddon(fitAddon);
  term.loadAddon(searchAddon);
  term.loadAddon(webLinksAddon);

  // Real match counts. addon-search has no getDecorations(), so the UI used to
  // print a hardcoded "1/1"; onDidChangeResults is the actual API and fires
  // when a search carries decorations (see SEARCH_DECORATIONS).
  try {
    tab._searchResultsSub = searchAddon.onDidChangeResults(res => {
      try {
        if (getActiveTab() !== tab) return;
        const el = document.getElementById('search-results');
        if (!el) return;
        const q = document.getElementById('search-input')?.value || '';
        if (!q) { el.textContent = ''; return; }
        // resultIndex is -1 when the match limit is exceeded.
        if (!res || res.resultIndex < 0 || !res.resultCount) { el.textContent = q ? 'No results' : ''; return; }
        el.textContent = `${res.resultIndex + 1}/${res.resultCount}`;
      } catch {}
    });
  } catch (_) {}

  try {
    const unicodeAddon = new Unicode11Addon.Unicode11Addon();
    term.loadAddon(unicodeAddon);
    term.unicode.activeVersion = '11';
  } catch (_) {}

  // GPU-accelerated renderer — falls back to canvas if WebGL unavailable (skip if >4 tabs to guard memory)
  if (tabs.filter(t => t.term).length < 4) {
    try {
      const webglAddon = new WebglAddon.WebglAddon();
      webglAddon.onContextLoss(() => { try { webglAddon.dispose(); } catch {} try { term.element?.querySelector('canvas')?.remove(); } catch {} });
      term.loadAddon(webglAddon);
      tab._webglAddon = webglAddon;
    } catch (_) {}
  }

  term.open(tab.wrapper);

  tab.term = term;
  tab.fitAddon = fitAddon;
  tab.searchAddon = searchAddon;
  tab.closed = false;
  tab.textarea = term.textarea || term.element?.querySelector('.xterm-textarea, textarea');
  if (tab.textarea && !tab.textarea.id) {
    tab.textarea.id = 'xterm-helper-' + tab.id;
    tab.textarea.name = 'terminal-input';
  }

  // Intercept paste events to use bracketed paste mode (required for TUI apps like vim, nano, mc).
  // NOTE: xterm.js also listens for 'paste' on the same textarea and re-emits
  // it via onData. Without stopping propagation our bracketed send + xterm's
  // send fire together, pasting everything twice (notably with the native
  // browser context menu when the custom right-click menu is disabled).
  if (tab.textarea) {
    tab.textarea.addEventListener('paste', e => {
      e.preventDefault();
      e.stopImmediatePropagation();
      e.stopPropagation();
      const text = (e.clipboardData || window.clipboardData)?.getData('text');
      if (!text || !tab.ws || tab.ws.readyState !== WebSocket.OPEN) return;
      tab._lastPasteText = text;
      // sendWsInput() chunks on character boundaries — the old fixed 60KB byte
      // slices cut multibyte characters in half, showing up as � in the shell.
      const bracketed = '\x1b[200~' + text + '\x1b[201~';
      try { sendWsInput(tab.ws, bracketed); } catch {}
    }, true);
  }

  // term.onFocus() was removed from xterm.js — use native DOM event instead
  term.element.addEventListener('focusin', () => {
    if (activeTabId !== tab.id) {
      activateTab(tab.id);
    }
  });

  // Title updates from OSC
  term.onTitleChange(title => {
    tab.title = title || `Term ${tab.id}`;
    tab.el.querySelector('.tab-title').textContent = tab.title;
  });

  // Bell: visual flash + desktop notification for background tabs (also flash parent for WebGL)
  term.onBell(() => {
    try { if (typeof notifyTabBell === 'function') notifyTabBell(tab); } catch {}
    // Visual flash on terminal screen and parent (WebGL uses canvas, so also flash parent)
    const screen = term.element?.querySelector('.xterm-screen');
    const parent = term.element;
    [screen, parent].forEach(el => {
      if (!el) return;
      el.classList.remove('term-bell-flash');
      void el.offsetWidth; // reflow to restart animation
      el.classList.add('term-bell-flash');
      setTimeout(() => el.classList.remove('term-bell-flash'), 150);
    });
    // Desktop notification if tab is in the background
    if (document.hidden && settings.bell && Notification.permission === 'granted') {
      try {
        new Notification(tab.title || 'WebTun', { body: 'Terminal bell', tag: 'webtun-bell' });
      } catch (_) {}
    }
  });

  // Resize observer
  tab.resizeObserver = new ResizeObserver(() => {
    // In tile view every wrapper is visible, so background tiles must refit
    // too — they used to stay at their old size forever.
    if (tilesMode) {
      tabs.forEach(t => { if (t.term && t.wrapper) { try { fitTerm(t); } catch {} } });
      return;
    }
    if (activeTabId === tab.id) { try { fitTerm(tab); } catch(e) { console.warn(e); } }
  });
  tab.resizeObserver.observe(tab.wrapper);

  // Copy selection to clipboard using modern API
  term.element.addEventListener('copy', e => {
    const sel = term.getSelection();
    if (sel) {
      e.preventDefault();
      navigator.clipboard.writeText(sel).then(() => {
        toast('Copied to clipboard', 'success');
      }).catch(() => {
        document.execCommand('copy');
      });
    }
  });

  // Terminal right-click context menu
  term.element.addEventListener('contextmenu', e => {
    if (!settings.termRightClick) return;
    e.preventDefault();
    try { if (typeof hideAllCtxMenus === 'function') hideAllCtxMenus(); } catch {}
    // TR-02: bind the menu to the exact tile that was right-clicked, then
    // activate it so Tile View actions can't land on a background session.
    try { termCtxTabId = tab.id; } catch {}
    try { if (typeof activateTab === 'function' && activeTabId !== tab.id) activateTab(tab.id); } catch {}
    const menu = document.getElementById('term-ctx-menu');
    // TR-04: proper disabled state (not just dimmed opacity) for Copy.
    const copyItem = document.getElementById('term-ctx-copy');
    const sel = term.getSelection();
    const hasSel = !!sel;
    if (copyItem) {
      copyItem.classList.toggle('disabled', !hasSel);
      copyItem.setAttribute('aria-disabled', String(!hasSel));
      copyItem.style.opacity = '';
    }
    // Start closed: a submenu left open from the last invocation must not
    // affect this measurement or leak its expanded height into positioning.
    try {
      menu.querySelectorAll('.ctx-submenu-wrap.open').forEach(el => {
        el.classList.remove('open');
        el.querySelector(':scope > .ctx-item')?.setAttribute('aria-expanded', 'false');
      });
    } catch {}
    // Keyboard-invoked menus (Shift+F10 / Menu key) report 0,0 — anchor to
    // the terminal tile instead of the viewport origin.
    let cx = e.clientX, cy = e.clientY;
    if (cx === 0 && cy === 0) {
      try {
        const r = term.element.getBoundingClientRect();
        cx = r.left + Math.min(60, Math.max(20, r.width / 3));
        cy = r.top + Math.min(60, Math.max(20, r.height / 3));
      } catch { cx = 20; cy = 60; }
    }
    // Show first to measure actual dimensions
    menu.style.display = 'block';
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    const vw = window.innerWidth;
    // TR-10: keep the menu above the mobile key bar + safe-area inset.
    const mobileKeys = document.getElementById('mobile-keys');
    const mobileOffset = (mobileKeys && mobileKeys.offsetHeight && window.innerWidth <= 768 &&
      getComputedStyle(mobileKeys).display !== 'none') ? mobileKeys.offsetHeight : 0;
    const vh = window.innerHeight - mobileOffset;
    let left = cx;
    let top = cy;
    // Flip horizontally if overflowing right
    if (left + mw > vw) left = Math.max(0, cx - mw);
    // Flip vertically if overflowing bottom (TR-01: clamped to usable vh)
    if (top + mh > vh) top = Math.max(0, cy - mh);
    // Clamp to viewport with an 8px margin
    left = Math.max(8, Math.min(left, vw - mw - 8));
    top = Math.max(8, Math.min(top, vh - mh - 8));
    // Guard against tiny viewports where mw/mh exceed the usable area.
    left = Math.max(8, left);
    top = Math.max(8, top);
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    // TR-05: focus the menu container so arrow keys navigate items instead
    // of being sent to the shell. Focus returns to the terminal on dismiss
    // (see hideTermCtxMenu). The xterm cursor dims while the menu has focus
    // but no input is lost — the PTY keeps running underneath.
    try {
      menu.setAttribute('tabindex', '-1');
      menu.focus({ preventScroll: true });
    } catch { try { menu.focus(); } catch {} }
  });

  // Touch-to-mouse translation for TUI apps (mobile)
  let _tapTimeout = null, _tapPos = null, _longPressTimer = null;
  term.element.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    _tapPos = { x: touch.clientX, y: touch.clientY, time: Date.now() };
    // Long press detection for right-click (TR-03: dispatch a real
    // `contextmenu` event — synthetic mousedown/mouseup with button:2 never
    // triggers the contextmenu handler in WebKit/Blink).
    _longPressTimer = setTimeout(() => {
      if (_tapPos) {
        try {
          const ctxEvt = new MouseEvent('contextmenu', {
            clientX: _tapPos.x, clientY: _tapPos.y,
            button: 2, bubbles: true, cancelable: true
          });
          term.element.dispatchEvent(ctxEvt);
        } catch {}
        _tapPos = null;
      }
    }, 500);
  }, { passive: true });
  term.element.addEventListener('touchend', e => {
    clearTimeout(_longPressTimer);
    if (!_tapPos || e.changedTouches.length !== 1) return;
    const touch = e.changedTouches[0];
    const dx = Math.abs(touch.clientX - _tapPos.x);
    const dy = Math.abs(touch.clientY - _tapPos.y);
    const dt = Date.now() - _tapPos.time;
    if (dx < 10 && dy < 10 && dt < 300) {
      // Short tap → left click
      const evt = new MouseEvent('mousedown', { clientX: touch.clientX, clientY: touch.clientY, button: 0, bubbles: true });
      term.element.dispatchEvent(evt);
      const upEvt = new MouseEvent('mouseup', { clientX: touch.clientX, clientY: touch.clientY, button: 0, bubbles: true });
      term.element.dispatchEvent(upEvt);
    }
    _tapPos = null;
  }, { passive: true });
  term.element.addEventListener('touchmove', () => {
    clearTimeout(_longPressTimer);
    _tapPos = null;
  }, { passive: true });

  // Fit terminal then connect WebSocket — ensures WS uses correct dimensions
  requestAnimationFrame(() => {
    fitTerm(tab);
    if (!tab.closed) connectWebSocket(tab, false);
  });

  // Scroll terminal on wheel — with try/catch fallback for isMouseTracking
  tab.wrapper.addEventListener('wheel', e => {
    if (e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    // TUI apps with mouse tracking handle scroll themselves — forward the event to xterm.js
    const isTracking = xtermMouseTracking(term);
    if (isTracking) {
      try {
        const vp = tab.wrapper.querySelector('.xterm-viewport');
        if (vp) vp.dispatchEvent(new WheelEvent('wheel', { deltaY: e.deltaY, deltaMode: e.deltaMode, deltaX: e.deltaX, clientX: e.clientX, clientY: e.clientY, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, bubbles: true }));
        return;
      } catch (_) { /* fallback to manual scroll */ }
    }
    const atTop = term.buffer.active.baseY === 0;
    const atBottom = term.buffer.active.baseY + term.rows >= term.buffer.active.length;
    if (tilesMode && ((e.deltaY < 0 && atTop) || (e.deltaY > 0 && atBottom))) return;
    let delta = e.deltaY;
    if (e.deltaMode === 1) delta *= 16;
    else if (e.deltaMode === 2) delta *= 16 * term.rows;
    const lineHeight = xtermCharHeight(term, tab.wrapper);
    const lines = Math.sign(delta) * Math.max(1, Math.round(Math.abs(delta) / lineHeight));
    term.scrollLines(lines);
  }, { passive: false });

  // Pinch-to-zoom on mobile
  let lastPinchDist = 0;
  tab.wrapper.addEventListener('touchstart', e => {
    if (e.touches.length === 2) {
      lastPinchDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
    }
  }, { passive: true });
  tab.wrapper.addEventListener('touchmove', e => {
    if (e.touches.length === 2) {
      e.preventDefault();
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      const delta = dist - lastPinchDist;
      if (Math.abs(delta) > 10) {
        const curSize = tab.term.options.fontSize || 14;
        const newSize = Math.max(10, Math.min(28, curSize + (delta > 0 ? 1 : -1)));
        tab.term.options.fontSize = newSize;
        if (tab.fitAddon) tab.fitAddon.fit();
        // Deliberately NOT persisted: a pinch gesture is transient, and writing it into
        // wt-settings silently changed the user's saved default for every future tab.
        // Font size is set deliberately from Settings → Appearance.
        lastPinchDist = dist;
      }
    }
  }, { passive: false });
  tab.wrapper.addEventListener('touchend', e => {
    if (e.touches.length < 2) lastPinchDist = 0;
  }, { passive: true });
}

function getActiveTab() { return tabs.find(t => t.id === activeTabId); }

// ── xterm private-API isolation ─────────────────────────────────────────────
// xterm.js exposes no public API for cell metrics or mouse-tracking state — the
// official fit addon reads the same `_core` internals. All such access lives in
// these three helpers so an upgrade that renames them breaks exactly one place
// (each has a DOM/`term.modes` fallback rather than throwing).
function xtermCellMetrics(term) {
  try {
    const d = term?._core?.viewportRenderer?.dimensions || term?._core?._renderService?.dimensions;
    if (d && d.actualCellWidth && d.actualCellHeight) return d;
  } catch (_) {}
  return null;
}
function xtermMouseTracking(term) {
  try {
    // Public API (xterm ≥5): 'none' | 'x10' | 'vt200' | 'drag' | 'any'
    const mode = term?.modes?.mouseTrackingMode;
    if (typeof mode === 'string') return mode !== 'none';
  } catch (_) {}
  try {
    const svc = term?._core?.coreMouseService;
    if (svc && typeof svc.isMouseTrackingActive === 'function') return !!svc.isMouseTrackingActive();
  } catch (_) {}
  return false;
}
function xtermCharHeight(term, wrapper) {
  const d = xtermCellMetrics(term);
  if (d?.actualCellHeight) return d.actualCellHeight;
  const rowsEl = wrapper?.querySelector ? wrapper.querySelector('.xterm-rows') : null;
  return rowsEl && rowsEl.children[0] ? (rowsEl.children[0].getBoundingClientRect().height || 16) : 16;
}

function fitTerm(tab) {
  try {
    if (!tab?.term?.element || !tab.wrapper) return;
    const d = xtermCellMetrics(tab.term);
    if (!d || !d.actualCellWidth || !d.actualCellHeight) {
      if (tab.fitAddon) { tab.fitAddon.fit(); }
      return;
    }
    const el = tab.term.element;
    const parent = el.parentElement;
    if (!parent) return;
    const ps = getComputedStyle(parent);
    const pt = parseFloat(ps.paddingTop) || 0;
    const pb = parseFloat(ps.paddingBottom) || 0;
    const pl = parseFloat(ps.paddingLeft) || 0;
    const pr = parseFloat(ps.paddingRight) || 0;
    let availW = parent.clientWidth - pl - pr;
    let availH = parent.clientHeight - pt - pb;
    if (tilesMode) {
      const hdr = tab.wrapper.querySelector('.term-tile-header');
      if (hdr) availH -= hdr.offsetHeight;
    }
    const cols = Math.max(1, Math.floor(availW / d.actualCellWidth));
    const rows = Math.max(1, Math.floor(availH / d.actualCellHeight));
    tab.term.resize(cols, rows);
  } catch (e) { console.warn('fitTerm failed:', e); }
}

let shiftLatch = false;
let altLatch = false;

function updateModifierButtons() {
  const sb = document.getElementById('shift-toggle-btn');
  if (sb) sb.classList.toggle('latch-active', shiftLatch);
  const ab = document.getElementById('alt-toggle-btn');
  if (ab) ab.classList.toggle('latch-active', altLatch);
}

function toggleShift() {
  shiftLatch = !shiftLatch;
  updateModifierButtons();
  if (shiftLatch) toast('Shift ON (next key)', 'info');
}

function toggleAlt() {
  altLatch = !altLatch;
  updateModifierButtons();
  if (altLatch) toast('Alt ON (next key)', 'info');
}

function sendKey(key) {
  let modified = key;
  if (key.length === 1) {
    if (shiftLatch && modified >= 'a' && modified <= 'z') {
      modified = modified.toUpperCase();
    }
    shiftLatch = false;
    if (altLatch && modified.charCodeAt(0) >= 0x20) {
      modified = '\x1b' + modified;
      altLatch = false;
    }
    updateModifierButtons();
  } else {
    shiftLatch = false;
    altLatch = false;
    updateModifierButtons();
  }
  const tab = getActiveTab();
  if (tab?.ws?.readyState === WebSocket.OPEN) {
    const enc = new TextEncoder().encode(modified);
    const buf = new Uint8Array(1 + enc.length);
    buf[0] = 0x00; buf.set(enc, 1);
    tab.ws.send(buf.buffer);
  }
  tab?.term?.focus();
}

function sendCtrlP() {
  sendKey('\x10');
  openFinder();
}

// UTF-8 safe base64 (OSC 52). atob/btoa are Latin-1 only and throw on
// emoji/CJK — those payloads silently lost the clipboard sync entirely.
function b64ToUtf8(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const CHUNK = 0x8000; // chunked: avoid blowing the arg limit on big clips
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// ═══════════════════════════════════════════════════════
// XTERM THEME
// ═══════════════════════════════════════════════════════
// Read the theme variables off <body>, which is the element that actually
// carries the resolved [data-theme=…]; documentElement only had it after an
// explicit applyTheme(), so the first terminal painted with the wrong palette.
function getXtermTheme() {
  const s = getComputedStyle(document.body || document.documentElement);
  const g = v => s.getPropertyValue(v).trim();
  return {
    background: g('--bg'), foreground: g('--fg'), cursor: g('--accent'),
    cursorAccent: g('--bg'), selectionBackground: g('--accent') + '44',
    black: '#000000', red: g('--red'), green: g('--green'), yellow: g('--yellow'),
    blue: g('--accent'), magenta: g('--accent2'), cyan: g('--cyan'), white: g('--fg'),
    brightBlack: g('--fg2'), brightRed: g('--red'), brightGreen: g('--green'),
    brightYellow: g('--yellow'), brightBlue: g('--accent'), brightMagenta: g('--accent2'),
    brightCyan: g('--cyan'), brightWhite: '#ffffff'
  };
}

function getXtermSelectionTheme() {
  const s = getComputedStyle(document.body || document.documentElement);
  const g = v => s.getPropertyValue(v).trim();
  return {
    extension: true,
    foreground: g('--bg'),
    background: g('--accent') + '44'
  };
}
// ═══════════════════════════════════════════════════════
// SEARCH
// ═══════════════════════════════════════════════════════
function toggleSearch() {
  const tab = typeof getActiveTab === 'function' ? getActiveTab() : null;
  // File tabs own a CodeMirror, not an xterm search addon — the terminal
  // search bar would open with no results. Route to the file's own surface.
  if (tab && tab.type === 'file') {
    if (tab.cm) {
      try {
        // CodeMirror ships no find UI by default (no search addon loaded);
        // use it when present, otherwise focus the editor for browser find.
        if (tab.cm.execCommand && window.CodeMirror && window.CodeMirror.commands && window.CodeMirror.commands.find) {
          tab.cm.execCommand('find');
        } else {
          tab.cm.focus();
          try { toast('File tab focused — use browser find (Ctrl+F) here', 'info'); } catch {}
        }
      } catch { try { tab.cm.focus(); } catch {} }
    } else {
      try { toast('Search is not available for this file type', 'info'); } catch {}
    }
    return;
  }
  // Preview tabs render a sandboxed iframe (opaque origin, no searchable DOM)
  // — focus the preview path bar instead of a dead terminal search.
  if (tab && tab.type === 'preview') {
    const input = (tab.pathInput && document.contains(tab.pathInput)) ? tab.pathInput
      : tab.wrapper ? tab.wrapper.querySelector('.preview-path-input') : null;
    if (input) { input.focus(); try { input.select(); } catch {} }
    return;
  }
  const bar = document.getElementById('search-bar');
  bar.classList.toggle('open');
  if (bar.classList.contains('open')) {
    document.getElementById('search-input').focus();
    document.getElementById('search-input').select();
  } else closeSearch();
}

function closeSearch() {
  document.getElementById('search-bar').classList.remove('open');
  const tab = getActiveTab();
  tab?.searchAddon?.clearDecorations();
  tab?.term?.focus();
}

let searchCaseSensitive = false;
function toggleSearchCase() {
  searchCaseSensitive = !searchCaseSensitive;
  const btn = document.getElementById('search-case-btn');
  btn.classList.toggle('active', searchCaseSensitive);
  btn.setAttribute('aria-pressed', String(searchCaseSensitive));
  doSearch();
}

// Decoration colors for search highlighting; enabling decorations is also what
// makes the addon emit onDidChangeResults (the count in #search-results).
const SEARCH_DECORATIONS = {
  matchBackground: '#3d59a1', matchBorder: '#7aa2f7', matchOverviewRuler: '#7aa2f7',
  activeMatchBackground: '#e0af68', activeMatchBorder: '#ffc777', activeMatchColorOverviewRuler: '#e0af68'
};

// Typing used to scan the entire scrollback (up to 50k lines) synchronously on
// every keystroke, which janked the terminal in long buffers.
let _searchDebounce = null;
function queueSearch() {
  clearTimeout(_searchDebounce);
  _searchDebounce = setTimeout(doSearch, 150);
}

function doSearch() {
  const q = document.getElementById('search-input').value;
  const tab = getActiveTab();
  const el = document.getElementById('search-results');
  if (!tab?.searchAddon || !q) { el.textContent = ''; return; }
  // Count is rendered by the addon's onDidChangeResults event (wired per tab).
  tab.searchAddon.findNext(q, { caseSensitive: searchCaseSensitive, decorations: SEARCH_DECORATIONS });
}

function searchNext() { const q=document.getElementById('search-input').value; if (!q) return; const t=getActiveTab(); t?.searchAddon?.findNext(q, {caseSensitive: searchCaseSensitive, decorations: SEARCH_DECORATIONS}); }
function searchPrev() { const q=document.getElementById('search-input').value; if (!q) return; const t=getActiveTab(); t?.searchAddon?.findPrevious(q, {caseSensitive: searchCaseSensitive, decorations: SEARCH_DECORATIONS}); }

function searchKeydown(e) {
  if (e.key === 'Enter') { e.shiftKey ? searchPrev() : searchNext(); }
  if (e.key === 'Escape') closeSearch();
}
// ═══════════════════════════════════════════════════════
// KEYBOARD SHORTCUTS
// ═══════════════════════════════════════════════════════
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', e => {
    const ctrl = e.ctrlKey || e.metaKey;
    // Alt+1..8 jump to tab N, Alt+9 jumps to the last tab (VS Code / Win Terminal).
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && /^[1-9]$/.test(e.key || '')) {
      const n = parseInt(e.key, 10);
      if (tabs.length) {
        e.preventDefault();
        const target = (n === 9) ? tabs[tabs.length - 1] : tabs[n - 1];
        if (target) { unpinLaunchpad(); activateTab(target.id); }
      }
      return;
    }
    // F2 renames the active tab (standard terminal emulator convention).
    if (e.key === 'F2' && !ctrl && !e.altKey) {
      e.preventDefault();
      if (typeof triggerTabRename === 'function' && activeTabId) triggerTabRename(activeTabId);
      return;
    }
    if (ctrl && e.key === 'p') { e.preventDefault(); openFinder(); }
    if (ctrl && e.shiftKey && (e.key === 'T' || e.key === 't')) { e.preventDefault(); if (typeof reopenLastClosedTab === 'function') reopenLastClosedTab(); return; }
    if (ctrl && e.shiftKey && (e.key === 'D' || e.key === 'd')) { e.preventDefault(); if (typeof duplicateTab === 'function' && activeTabId) duplicateTab(activeTabId); return; }
    if (ctrl && e.shiftKey && (e.key === 'P' || e.key === 'p')) { e.preventDefault(); if (typeof togglePinTab === 'function' && activeTabId) togglePinTab(activeTabId); return; }
    if (ctrl && e.key === 't') { e.preventDefault(); newTab(); }
    if (ctrl && e.key === 'b') { e.preventDefault(); toggleSidebar(); }
    if (ctrl && e.key === 'f') { e.preventDefault(); toggleSearch(); }
    if (ctrl && e.key === 'w') { e.preventDefault(); if (activeTabId) closeTab(e, activeTabId); }
    if (ctrl && e.shiftKey && e.key === 'ArrowRight') { e.preventDefault(); cycleTab(1); }
    if (ctrl && e.shiftKey && e.key === 'ArrowLeft') { e.preventDefault(); cycleTab(-1); }
    if (ctrl && e.shiftKey && e.key === 'r') { e.preventDefault(); refreshPreview(); }
    if (e.key === 'F11' && document.getElementById('editor-view').classList.contains('open')) { e.preventDefault(); toggleEditorFullscreen(); }
    if (e.key === 'Escape') {
      // Skip if a menu-level handler already consumed the key (TR-09: the
      // term-ctx keydown closes just the submenu and stops propagation, so
      // this global handler must not then close the whole menu as well).
      if (e.defaultPrevented) return;
      try {
        const tabMenu = document.getElementById('tab-ctx-menu');
        const newMenu = document.getElementById('new-tab-menu');
        const listMenu = document.getElementById('tab-list-menu');
        if ((tabMenu && tabMenu.style.display === 'block') || (newMenu && newMenu.style.display === 'block') || (listMenu && listMenu.style.display === 'block')) {
          if (typeof hideTabMenus === 'function') hideTabMenus();
          return;
        }
      } catch {}
      const termMenu = document.getElementById('term-ctx-menu');
      if (termMenu && termMenu.style.display !== 'none') {
        // TR-09: hierarchical dismissal — an open "More Options" flyout
        // closes first (covers mouse-opened menus where focus never entered
        // the menu, so the menu-level keydown never fires).
        try {
          const openSub = termMenu.querySelector('.ctx-submenu-wrap.open');
          if (openSub) {
            openSub.classList.remove('open');
            openSub.querySelector(':scope > .ctx-item')?.setAttribute('aria-expanded', 'false');
            return;
          }
        } catch {}
        hideTermCtxMenu();
        return;
      }
      if (document.getElementById('ctx-menu').classList.contains('open')) {
        document.getElementById('ctx-menu').classList.remove('open');
        return;
      }
      if (document.getElementById('search-bar').classList.contains('open')) closeSearch();
      if (document.getElementById('cmd-lib-panel').classList.contains('open')) toggleCmdLib();
      if (document.getElementById('settings-panel').classList.contains('open')) closeSettings();
      try { const np = document.getElementById('notif-panel'); if (np && np.classList.contains('open')) closeNotifPanel(); } catch {}
      document.querySelectorAll('.overlay.open').forEach(el => {
        const id = el.id;
        if (id === 'sys-overlay') closeSystemStats();
        else if (id === 'finder-overlay') { clearTimeout(finderTimer); closeOverlay(id); }
        else if (id === 'newfolder-overlay' || id === 'newfile-overlay' || id === 'rename-overlay') closeOverlay(id);
        else if (id === 'image-viewer') closeImageViewer();
        else if (id === 'conflict-overlay') closeOverlay(id);
        else closeOverlay(id);
      });
    }
  });
}

function cycleTab(dir) {
  if (!tabs.length) return;
  const idx = tabs.findIndex(t => t.id === activeTabId);
  const next = tabs[(idx + dir + tabs.length) % tabs.length];
  activateTab(next.id);
}

// ═══════════════════════════════════════════════════════
// MOBILE KEYS
// ═══════════════════════════════════════════════════════
let termSelectMode = false;
let scrollMode = false;
let _scrollHandlers = [];

function toggleTermSelect() {
  termSelectMode = !termSelectMode;
  const btn = document.getElementById('sel-toggle-btn');
  if (btn) btn.classList.toggle('sel-mode', termSelectMode);
  document.getElementById('mkey-sel-row').style.display = termSelectMode ? 'flex' : 'none';
  const mk = document.getElementById('mobile-keys');
  if (mk) {
    if (termSelectMode) {
      mk.dataset.prevDisplay = mk.style.display;
      mk.style.display = 'none';
    } else {
      mk.style.display = mk.dataset.prevDisplay || '';
    }
  }

  const activeTab = getActiveTab();
  if (termSelectMode) {
    if (activeTab?.term) {
      activeTab.term.options.disableStdin = true;
      const ta = activeTab.textarea || activeTab.term.textarea || activeTab.term.element?.querySelector('.xterm-textarea, textarea');
      if (ta) ta.disabled = true;
    }
  } else {
    scrollMode = false;
    cleanupScrollHandlers();
    const scrollBtn = document.getElementById('sel-scroll-btn');
    if (scrollBtn) scrollBtn.classList.remove('active-mode');
    shiftLatch = false; altLatch = false; updateModifierButtons();
    if (activeTab?.term) {
      activeTab.term.options.disableStdin = false;
      const ta = activeTab.textarea || activeTab.term.textarea || activeTab.term.element?.querySelector('.xterm-textarea, textarea');
      if (ta) ta.disabled = false;
      activeTab.term.clearSelection();
    }
  }
}

function toggleScrollMode() {
  scrollMode = !scrollMode;
  const btn = document.getElementById('sel-scroll-btn');
  if (btn) btn.classList.toggle('active-mode', scrollMode);
  cleanupScrollHandlers();
  if (scrollMode) {
    tabs.forEach(t => {
      if (!t.term) return;
      const h = attachScrollHandler(t);
      if (h) _scrollHandlers.push(h);
    });
  }
}

function attachScrollHandler(tab) {
  const el = tab.wrapper;
  const term = tab.term;
  if (!el || !term) return null;
  let startY = 0, startX = 0;
  function onTouchStart(e) {
    if (e.touches.length > 1) return;
    startY = e.touches[0].clientY;
    startX = e.touches[0].clientX;
    const screen = term.element?.querySelector('.xterm-screen');
    if (screen) screen.style.pointerEvents = 'none';
  }
  function onTouchMove(e) {
    if (e.touches.length > 1) return;
    const dy = startY - e.touches[0].clientY;
    const dx = startX - e.touches[0].clientX;
    startY = e.touches[0].clientY;
    startX = e.touches[0].clientX;
    if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 3) {
      e.preventDefault();
      const lines = Math.sign(dy) * Math.max(1, Math.ceil(Math.abs(dy) / 15));
      term.scrollLines(lines);
    }
  }
  function onTouchEnd() {
    const screen = term.element?.querySelector('.xterm-screen');
    if (screen) screen.style.pointerEvents = '';
  }
  el.addEventListener('touchstart', onTouchStart, { passive: true });
  el.addEventListener('touchmove', onTouchMove, { passive: false });
  el.addEventListener('touchend', onTouchEnd, { passive: true });
  return { el, start: onTouchStart, move: onTouchMove, end: onTouchEnd };
}

function cleanupScrollHandlers() {
  _scrollHandlers.forEach(h => {
    h.el.removeEventListener('touchstart', h.start);
    h.el.removeEventListener('touchmove', h.move);
    h.el.removeEventListener('touchend', h.end);
    const screens = h.el.querySelectorAll('.xterm-screen');
    screens.forEach(s => s.style.pointerEvents = '');
  });
  _scrollHandlers = [];
}

function copyTermSelection() {
  const tab = getActiveTab();
  if (!tab?.term) return;
  const sel = tab.term.getSelection();
  if (sel) {
    navigator.clipboard.writeText(sel).then(() => {
      toast('Copied to clipboard', 'success');
    }).catch(() => {
      toast('Copy failed', 'error');
    });
    tab.term.clearSelection();
  } else {
    toast('No text selected', 'info');
  }
}

let _pasteInput = null;

function pasteToTerminal() {
  const doPaste = text => {
    if (!text) return;
    // TR-02: prefer the right-clicked tile when the menu is open; falls back
    // to the active tab once the menu is dismissed (target is cleared).
    const tab = (typeof getTermCtxTarget === 'function' ? getTermCtxTarget() : null) || getActiveTab();
    if (tab?.ws && tab.ws.readyState === WebSocket.OPEN) {
      // Bracketed paste: wrap in escape sequences so the shell buffers the input.
      // sendWsInput() chunks on character boundaries, so multibyte UTF-8 is never split.
      const bracketed = '\x1b[200~' + text + '\x1b[201~';
      try { sendWsInput(tab.ws, bracketed); } catch {}
      tab.term?.focus();
      toast('Pasted to terminal', 'success');
    }
  };

  if (navigator.clipboard?.readText) {
    navigator.clipboard.readText().then(doPaste).catch(() => fallbackPaste(doPaste));
  } else {
    fallbackPaste(doPaste);
  }
}

function fallbackPaste(callback) {
  if (!_pasteInput) {
    _pasteInput = document.createElement('textarea');
    _pasteInput.id = 'fallback-paste-area';
    _pasteInput.name = 'paste-input';
    _pasteInput.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;z-index:-1';
    document.body.appendChild(_pasteInput);
    _pasteInput.addEventListener('paste', () => {
      setTimeout(() => {
        if (_pasteInput.value) {
          callback(_pasteInput.value);
          toast('Pasted to terminal', 'success');
        } else {
          // TR-11: explicit permission guidance — an empty read means the
          // browser blocked clipboard access (HTTP origin, denied permission,
          // or execCommand('paste') unsupported), not an empty clipboard.
          toast('Clipboard access blocked by browser — press Ctrl+V to paste', 'warning');
        }
        _pasteInput.value = '';
      }, 0);
    });
  }
  _pasteInput.value = '';
  _pasteInput.focus();
  try {
    const ok = document.execCommand('paste');
    if (!ok) toast('Clipboard access blocked by browser — press Ctrl+V to paste', 'warning');
  } catch {
    toast('Clipboard access blocked — press Ctrl+V to paste', 'warning');
  }
}

function selectAllTerm() {
  const tab = (typeof getTermCtxTarget === 'function' ? getTermCtxTarget() : null) || getActiveTab();
  if (tab?.term) {
    let ta = tab.textarea || tab.term.textarea || tab.term.element?.querySelector('.xterm-textarea, textarea');
    let restore = null;
    if (ta?.disabled) { ta.disabled = false; restore = true; }
    tab.term.focus();
    tab.term.selectAll();
    if (restore && ta) ta.disabled = true;
    toast('All text selected', 'success');
  }
}

function selectTermLine() {
  const tab = (typeof getTermCtxTarget === 'function' ? getTermCtxTarget() : null) || getActiveTab();
  if (!tab?.term) return;
  const buf = tab.term.buffer.active;
  const cursorY = buf.baseY + buf.cursorY;
  tab.term.selectLines(cursorY, cursorY);
  toast('Line selected', 'success');
}

function termScrollUp() {
  const tab = (typeof getTermCtxTarget === 'function' ? getTermCtxTarget() : null) || getActiveTab();
  if (tab?.term) tab.term.scrollLines(-Math.floor((tab.term.rows || 10) / 2));
}

function termScrollDn() {
  const tab = (typeof getTermCtxTarget === 'function' ? getTermCtxTarget() : null) || getActiveTab();
  if (tab?.term) tab.term.scrollLines(Math.floor((tab.term.rows || 10) / 2));
}

function toggleCtrlRow() {
  const row = document.getElementById('mkey-ctrl-row');
  if (!row) return;
  const isOpen = row.style.display !== 'none';
  row.style.display = isOpen ? 'none' : 'flex';
  const btn = document.getElementById('ctrl-toggle-btn');
  if (btn) btn.style.background = isOpen ? '' : 'var(--accent)';
  shiftLatch = false; altLatch = false; updateModifierButtons();
}

let _viewportHandlerInstalled = false;
let _viewportDebounce = null;
function setupVisualViewport() {
  if (_viewportHandlerInstalled) return;
  _viewportHandlerInstalled = true;
  if (window.visualViewport) {
    const handler = () => {
      clearTimeout(_viewportDebounce);
      _viewportDebounce = setTimeout(() => {
        const vvH = window.visualViewport.height;
        const vvScale = window.visualViewport.scale || 1;
        // Samsung Internet: innerHeight resizes, not visualViewport. Use layout viewport height via window.innerHeight vs vvH
        // On iOS, keyboard shows as vvH < innerHeight. On Samsung, opposite. Take max diff and ignore when scaled (pinch zoom).
        if (vvScale !== 1) return; // ignore pinch-zoom (U61, U65)
        const diff = vvH - window.innerHeight;
        const absDiff = Math.abs(diff);
        // Fallback: visualViewport offsetTop > 10 means the visual viewport panned
        // up, which is how some Android builds report the keyboard.
        const offsetTop = window.visualViewport.offsetTop || 0;
        // Height the keyboard actually covers.
        //  iOS keeps the layout viewport and shrinks the visual one → innerHeight - vvH.
        //  Android/Samsung shrink innerHeight too → ≈0, and nothing needs compensating.
        // Using absDiff alone was wrong on the offsetTop path: it added a handful of
        // pixels of margin where hundreds of pixels were covered.
        const covered = Math.max(0, window.innerHeight - vvH - offsetTop);
        const isKeyboard = absDiff > 50 && diff < 0;
        const keyboardOpen = isKeyboard || offsetTop > 10 || covered > 50;
        // Never reserve more than 60% of the viewport — a bogus metric must not
        // collapse the terminal to nothing.
        const keyboardMargin = Math.min(covered, Math.round(window.innerHeight * 0.6));
        const mobileKeys = document.getElementById('mobile-keys');
        const selRow = document.getElementById('mkey-sel-row');
        const terminals = document.getElementById('terminals');
        if (!terminals) return;
        if (keyboardOpen) {
          terminals.style.marginBottom = keyboardMargin + 'px';
          if (mobileKeys) mobileKeys.style.display = 'none';
          const ctrlRow = document.getElementById('mkey-ctrl-row');
          if (ctrlRow && ctrlRow.style.display === 'flex') ctrlRow.dataset.wasOpen = '1';
          if (ctrlRow) ctrlRow.style.display = 'none';
          if (selRow && selRow.style.display === 'flex') selRow.dataset.wasOpen = '1';
          if (selRow) selRow.style.display = 'none';
        } else {
          terminals.style.marginBottom = '0';
          if (mobileKeys && window.innerWidth <= 768 && settings.mobilekeys !== false) {
            mobileKeys.style.display = 'flex';
          }
          if (window.innerWidth <= 768 && settings.mobilekeys !== false) {
            const ctrlRow = document.getElementById('mkey-ctrl-row');
            if (ctrlRow && ctrlRow.dataset.wasOpen === '1') {
              ctrlRow.style.display = 'flex';
              delete ctrlRow.dataset.wasOpen;
            }
          }
          if (selRow && window.innerWidth <= 768) {
            if (selRow.dataset.wasOpen === '1') {
              selRow.style.display = 'flex';
              delete selRow.dataset.wasOpen;
            } else {
              selRow.style.display = termSelectMode ? 'flex' : 'none';
            }
          }
        }
      }, 100);
    };
    window.visualViewport.addEventListener('resize', handler);
    window.visualViewport.addEventListener('scroll', handler);
    window._cleanups?.push(() => {
      window.visualViewport.removeEventListener('resize', handler);
      window.visualViewport.removeEventListener('scroll', handler);
    });
  }
}

function setupMobileKeys() {
  const mk = document.getElementById('mobile-keys');
  const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  if (settings.mobilekeys === undefined && isTouch) {
    settings.mobilekeys = true;
  }
  const show = window.innerWidth <= 768 && settings.mobilekeys;
  if (mk) mk.style.display = show ? 'flex' : 'none';
  const tc = document.getElementById('toast-container');
  if (tc) tc.classList.toggle('keys-hidden', !show);
  const ctrlRow = document.getElementById('mkey-ctrl-row');
  if (ctrlRow) ctrlRow.style.display = 'none';
  const ctrlBtn = document.getElementById('ctrl-toggle-btn');
  if (ctrlBtn) ctrlBtn.style.background = '';
  shiftLatch = false; altLatch = false; updateModifierButtons();
}
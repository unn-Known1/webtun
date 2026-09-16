// WebTun frontend - launchpad.js (launchpad home screen + pulse + screensaver.)

// ── Launchpad: zero-tab home screen ──
function lpOpenExplorer() { if (!sidebarOpen) toggleSidebar(); }
async function launchAndRun(cmd) {
  if (!cmd || !String(cmd).trim()) return;
  const tab = newTab();
  const t0 = Date.now();
  while (Date.now() - t0 < 10000) {
    if (tab.closed) return;
    if (tab.ws && tab.ws.readyState === WebSocket.OPEN) break;
    await new Promise(r => setTimeout(r, 200));
  }
  if (tab.ws && tab.ws.readyState === WebSocket.OPEN) {
    activateTab(tab.id);
    runCmdLib(String(cmd).trim());
  } else {
    toast('Terminal is still connecting…', 'warning');
  }
}
function updateLaunchpad() {
  const lp = document.getElementById('launchpad');
  if (!lp) return;
  const show = tabs.length === 0 || lpPinned || lpAuto;
  lp.classList.toggle('show', show);
  lp.setAttribute('aria-hidden', String(!show));
  if (show) {
    renderLaunchpad();
    startLpPulse();
    // Only steal focus on a fresh zero-tab landing — when pinned alongside
    // tabs (e.g. after closeTab) the active terminal keeps keyboard focus.
    if (tabs.length === 0) lp.querySelector('.lp-new')?.focus({ preventScroll: true });
  } else {
    stopLpPulse();
  }
}
// Idle dashboard screensaver: auto-show the launchpad after N idle minutes.
// Visual only (not a lock) — any activity dismisses it. Opt-in via settings.
let lpAuto = false;
let _lastActivity = Date.now();
let _ssTimer = null;
function pokeScreensaver() {
  _lastActivity = Date.now();
  if (lpAuto) unpinLaunchpad();
}
function startScreensaverWatch() {
  if (_ssTimer) return;
  ['mousemove', 'mousedown', 'keydown', 'touchstart', 'wheel'].forEach(ev =>
    document.addEventListener(ev, pokeScreensaver, { passive: true }));
  _ssTimer = setInterval(() => {
    if (!settings.screensaver || document.hidden) return;
    if (tabs.length === 0 || lpPinned || lpAuto) return;
    if (document.querySelector('.overlay.open')) return;
    if (Date.now() - _lastActivity >= (settings.screensaverMin || 5) * 60000) {
      lpAuto = true;
      updateLaunchpad();
    }
  }, 5000);
}
// Pinned dashboard: Home button shows the launchpad over live terminals.
// Picking/creating a tab unpins; closing tabs never unpins.
let lpPinned = false;
function toggleLaunchpad() {
  lpPinned = !lpPinned;
  const hb = document.getElementById('home-btn');
  if (hb) { hb.classList.toggle('active', lpPinned); hb.setAttribute('aria-pressed', String(lpPinned)); }
  updateLaunchpad();
}
function unpinLaunchpad() {
  if (!lpPinned && !lpAuto) return;
  lpPinned = false;
  lpAuto = false;
  const hb = document.getElementById('home-btn');
  if (hb) { hb.classList.remove('active'); hb.setAttribute('aria-pressed', 'false'); }
  updateLaunchpad();
}
// Manual preview from Settings → Interface → Preview screensaver.
// Works even when the auto-screensaver toggle is off.
function startScreensaverNow() {
  lpAuto = true;
  updateLaunchpad();
}
let lpPulseTimer = null;
let lpCpuSamples = [];
function drawLpSpark() {
  try {
    const cv = document.getElementById('lp-spark');
    if (!cv || !cv.getContext) return;
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    if (lpCpuSamples.length < 2) return;
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#00c853';
    const max = Math.max(10, ...lpCpuSamples);
    ctx.beginPath();
    lpCpuSamples.forEach((v, i) => {
      const x = (i / (lpCpuSamples.length - 1)) * (W - 4) + 2;
      const y = H - 3 - (Math.min(v, max) / max) * (H - 8);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.lineTo(W - 2, H);
    ctx.lineTo(2, H);
    ctx.closePath();
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = accent;
    ctx.fill();
    ctx.globalAlpha = 1;
  } catch {}
}
function fmtUptime(s) {
  s = Math.max(0, Math.floor(s || 0));
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  if (d > 0) return d + 'd' + h + 'h';
  if (h > 0) return h + 'h' + m + 'm';
  return m + 'm';
}
async function tickLpPulse() {
  const el = document.getElementById('lp-pulse');
  if (!el || !document.getElementById('launchpad')?.classList.contains('show')) return;
  try {
    const s = await fetchSystemStats();
    if (!s || !document.getElementById('launchpad')?.classList.contains('show')) return;
    const load = s.cpu && s.cpu.loadAvg ? Number(s.cpu.loadAvg[0]).toFixed(2) : '–';
    const cpu = s.cpu && s.cpu.usage !== undefined ? s.cpu.usage + '%' : '–';
    const mem = s.memory && s.memory.percent !== undefined ? s.memory.percent + '%' : '–';
    el.innerHTML = '';
    const dot = document.createElement('span');
    dot.className = 'lp-dot';
    el.appendChild(dot);
    const t = document.createElement('span');
    t.textContent = `load ${load} · cpu ${cpu} · mem ${mem} · up ${fmtUptime(s.uptime)}`;
    el.appendChild(t);
    if (s.cpu && typeof s.cpu.usage === 'number') {
      lpCpuSamples.push(Math.max(0, s.cpu.usage));
      if (lpCpuSamples.length > 28) lpCpuSamples.shift();
      drawLpSpark();
    }
  } catch {}
}
function startLpPulse() {
  stopLpPulse();
  tickLpPulse();
  lpPulseTimer = setInterval(tickLpPulse, 5000);
}
function stopLpPulse() {
  if (lpPulseTimer) { clearInterval(lpPulseTimer); lpPulseTimer = null; }
}
function renderLaunchpad() {
  const host = (document.getElementById('hostname-badge')?.textContent || '').trim();
  document.getElementById('lp-host').textContent = host && host !== '—' ? host : 'local session';
  // Recent commands (freshest first)
  const cmds = document.getElementById('lp-cmds');
  cmds.innerHTML = '';
  const recent = [...(_cmdHistCache || [])].sort((a, b) => (b.time || 0) - (a.time || 0)).slice(0, 6);
  if (!recent.length) {
    const d = document.createElement('div');
    d.className = 'lp-empty';
    d.textContent = 'Run a command to pin it here';
    cmds.appendChild(d);
  }
  for (const h of recent) {
    if (!h.cmd) continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'lp-row';
    b.title = 'Run: ' + h.cmd;
    const ico = document.createElement('span');
    ico.style.display = 'inline-flex';
    ico.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 3 20 12 6 21 6 3"/></svg>';
    b.appendChild(ico);
    const t = document.createElement('span');
    t.textContent = h.cmd;
    b.appendChild(t);
    b.addEventListener('click', () => launchAndRun(h.cmd));
    cmds.appendChild(b);
  }
  // Places: current dir, recent nav, bookmarks (deduped)
  const places = document.getElementById('lp-places');
  places.innerHTML = '';
  const seen = new Set();
  const dirs = [];
  for (const p of [currentPath, ...[...navHistory].reverse(), ...getBookmarks().map(b => b.path)]) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    dirs.push(p);
    if (dirs.length >= 6) break;
  }
  if (!dirs.length) {
    const d = document.createElement('div');
    d.className = 'lp-empty';
    d.textContent = 'No places yet';
    places.appendChild(d);
  }
  for (const p of dirs) {
    const base = p.split(/[\\/]/).filter(Boolean).pop() || p;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'lp-row';
    b.title = p;
    const ico = document.createElement('span');
    ico.style.display = 'inline-flex';
    ico.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
    b.appendChild(ico);
    const t = document.createElement('span');
    t.textContent = base;
    b.appendChild(t);
    b.addEventListener('click', () => newTab(undefined, undefined, p));
    places.appendChild(b);
  }
  renderLpToday();
  wireLpKeys();
}
function renderLpToday() {
  const el = document.getElementById('lp-today');
  if (!el) return;
  try {
    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    let n = 0, top = null, topCount = 0;
    for (const h of (_cmdHistCache || [])) {
      if (!h.cmd || !(h.time >= dayStart)) continue;
      const c = h.count || 1;
      n += c;
      if (c > topCount) { topCount = c; top = h.cmd; }
    }
    el.innerHTML = '';
    if (!n) { el.textContent = 'A fresh shell awaits its first command'; return; }
    el.appendChild(document.createTextNode('today · ' + n + (n === 1 ? ' command · top: ' : ' commands · top: ')));
    const b = document.createElement('b');
    b.textContent = top;
    el.appendChild(b);
  } catch {}
}
// Number-key runs (1–6): document-level so they work no matter where
// focus sits, gated on launchpad visibility + editable targets.
let _lpKeysWired = false;
function wireLpKeys() {
  if (_lpKeysWired) return;
  _lpKeysWired = true;
  document.addEventListener('keydown', e => {
    const lp = document.getElementById('launchpad');
    if (!lp || !lp.classList.contains('show')) return;
    if (!/^[1-6]$/.test(e.key) || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (document.querySelector('.overlay.open')) return;
    const rows = lp.querySelectorAll('#lp-cmds .lp-row');
    const row = rows[parseInt(e.key, 10) - 1];
    if (row) { e.preventDefault(); row.click(); }
  });
}
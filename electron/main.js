const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const { fork } = require('child_process');
const path = require('path');
const os = require('os');
const http = require('http');
const net = require('net');
const fs = require('fs');

// Native crash dumps (main process). No upload server is configured — dumps
// land in the OS crash-dumps dir for post-mortem debugging of native faults
// (conpty/PTY) that leave no JS stack in webtun-server.log.
try {
  const { crashReporter } = require('electron');
  crashReporter.start({ uploadToServer: false });
} catch {}

// Squirrel.Windows install/update hooks (no-op unless launched by Squirrel;
// must run before app.ready). Return early so installer events don't acquire
// the single-instance lock or register whenReady work on the way out.
if (require('electron-squirrel-startup')) { app.quit(); return; }

// In-app updates. The GitHub provider is auto-inferred from package.json
// repository (the same inference that emits app-update.yml). Packaged builds
// only; silent when offline. No settings UI yet: background download +
// notify, install on quit. Portable .exe / AppImage builds cannot self-update
// via electron-updater (no installer to apply the update) — see the Desktop
// section in README.md; the manual check below reports that instead of
// failing silently.
function setupAutoUpdates() {
  if (!app.isPackaged) return;
  let autoUpdater = null;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (e) {
    try { console.error('auto-updater unavailable:', e.message); } catch {}
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // Surface failures instead of swallowing them: background status is invisible
  // otherwise (a broken feed used to look identical to "up to date").
  autoUpdater.on('error', (e) => {
    try { console.error('auto-updater error:', (e && e.message) || e); } catch {}
  });
  const check = () => {
    try {
      const r = autoUpdater.checkForUpdatesAndNotify();
      if (r && typeof r.catch === 'function') r.catch((e) => {
        try { console.error('update check failed:', (e && e.message) || e); } catch {}
      });
    } catch (e) {
      try { console.error('update check failed:', (e && e.message) || e); } catch {}
    }
  };
  setTimeout(check, 30000);
  const timer = setInterval(check, 24 * 3600 * 1000);
  if (timer.unref) timer.unref();
  return autoUpdater;
}
let _autoUpdater = null;
// Renderer-reachable manual check (Settings → About can wire it up): resolves
// to a short status string, never throws.
ipcMain.handle('check-for-updates', async () => {
  try {
    if (!_autoUpdater) return 'updates unavailable in this build (portable/AppImage have no self-update — grab the next release from GitHub)';
    const r = await _autoUpdater.checkForUpdatesAndNotify();
    if (r && r.updateInfo && r.updateInfo.version) return 'update available: ' + r.updateInfo.version;
    return 'up to date';
  } catch (e) {
    return 'update check failed: ' + ((e && e.message) || e);
  }
});

let mainWindow;
let serverProcess;
let PORT = (() => {
  const p = parseInt(process.env.PORT, 10);
  return Number.isFinite(p) && p > 0 && p <= 65535 ? p : 3000;
})();
// process.env.PIN is always a string when set, so no type check is needed here.
const PIN = process.env.PIN || '';

// Where the forked server should look for dependencies, in order.
// Packaged layout: app.asar contains node_modules, except whatever asarUnpack lists
// (currently only node-pty) which lives under app.asar.unpacked. So the first two
// candidates are asar-then-unpacked; the rest are fallbacks for portable/`--dir`
// builds where the tree sits beside the executable. Only node-pty is native — see
// the "//electron-build" note in package.json before adding dependencies.
function resolveNodeModules() {
  if (app.isPackaged) {
    const candidates = [
      path.join(app.getAppPath(), 'node_modules'),
      path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules'),
      path.join(process.resourcesPath, 'node_modules'),
      path.join(path.dirname(app.getAppPath()), 'node_modules'),
    ];
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) return c;
      } catch {}
    }
  }
  return path.join(__dirname, '..', 'node_modules');
}

function serverLogPath() {
  try {
    return path.join(app.getPath('userData'), 'webtun-server.log');
  } catch {
    return path.join(os.tmpdir(), 'webtun-server.log');
  }
}

// Probe 127.0.0.1 for a free port starting at `startPort` (up to 20 tries).
// Lets the packaged app boot on 3001+ when 3000 is taken instead of
// showing "Failed to start server". Rejects when the range is exhausted —
// resolving to `startPort` here used to guarantee an EADDRINUSE crash.
function findFreePort(startPort, maxTries = 20) {
  return new Promise((resolve, reject) => {
    const tryPort = (port, attempt) => {
      if (attempt >= maxTries || port > 65535) {
        return reject(new Error(`No free port found between ${startPort} and ${port}`));
      }
      const tester = net.createServer();
      tester.once('error', () => {
        tester.close();
        tryPort(port + 1, attempt + 1);
      });
      tester.once('listening', () => {
        tester.close(() => resolve(port));
      });
      tester.listen(port, '127.0.0.1');
    };
    tryPort(startPort, 0);
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, '..', 'server.js');
    const nodeModules = resolveNodeModules();
    const env = {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
    };
    // Pass the PIN through verbatim: trimming here silently altered the secret
    // (a PIN with intentional leading/trailing whitespace would no longer match).
    if (PIN.length > 0) env.PIN = PIN;
    else delete env.PIN;
    // Ensure forked server can resolve deps when packaged
    env.NODE_PATH = [nodeModules, env.NODE_PATH].filter(Boolean).join(path.delimiter);

    serverProcess = fork(serverPath, [], {
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      silent: true
    });

    // Keep the tail of server output so startup failures show the real
    // error (not just an exit code). Also mirrored to a log file.
    const serverLog = [];
    let _logBytes = -1; // lazily stat'ed; rotation keeps the file ≤1MB
    const pushLog = (chunk, tag) => {
      const text = chunk.toString();
      try { console.log(tag, text.trim()); } catch {}
      serverLog.push(text);
      // Bound memory: keep ~last 64KB
      let total = 0;
      for (let i = serverLog.length - 1; i >= 0; i--) {
        total += serverLog[i].length;
        if (total > 65536) { serverLog.splice(0, i); break; }
      }
    try {
      // Bound disk: rotate to the last 256KB once the file passes 1MB, so a
      // chatty server can never fill the disk via this log.
      const lp = serverLogPath();
      if (_logBytes < 0) { try { _logBytes = fs.statSync(lp).size; } catch { _logBytes = 0; } }
      if (_logBytes > 1024 * 1024) {
        try {
          // Slice the raw bytes before decoding: slicing a decoded JS string
          // can split a UTF-16 surrogate pair and corrupt the log.
          const tail = fs.readFileSync(lp).slice(-262144).toString('utf8');
          fs.writeFileSync(lp, tail);
          _logBytes = Buffer.byteLength(tail);
        } catch {}
      }
      fs.appendFileSync(lp, text);
      _logBytes += Buffer.byteLength(text);
    } catch {}
    };
    serverProcess.stdout.on('data', d => pushLog(d, '[server]'));
    serverProcess.stderr.on('data', d => pushLog(d, '[server:err]'));

    let settled = false;
    const serverOutputTail = () => {
      const tail = serverLog.join('').trim().split(/\r?\n/).slice(-15).join('\n');
      return tail ? `\n\nServer output:\n${tail}` : '';
    };
    const fail = (msg) => {
      if (settled) return;
      settled = true;
      try {
        fs.appendFileSync(serverLogPath(), `\n[webtun] ${msg}\n`);
      } catch {}
      reject(new Error(msg + serverOutputTail() + `\n\nFull log: ${serverLogPath()}`));
    };

    serverProcess.on('exit', code => {
      if (code !== 0) {
        console.error(`Server exited with code ${code}`);
        if (settled) {
          // Post-startup crash: without this the window shows a dead app.
          // Surface it and quit instead of idling on a broken backend.
          try { dialog.showErrorBox('WebTun server stopped', `The WebTun server exited with code ${code}.${serverOutputTail()}\n\nFull log: ${serverLogPath()}`); } catch {}
          try { app.quit(); } catch {}
          return;
        }
        fail(`Server exited with code ${code}`);
      } else if (!settled) {
        // Exited cleanly but never answered the healthcheck — don't sit here
        // until the deadline, the port is free again right now.
        fail('Server exited before it finished starting');
      }
    });
    serverProcess.on('error', err => fail(err.message));

    const deadline = Date.now() + 30000;
    const check = () => {
      if (settled) return;
      if (Date.now() > deadline) return fail('Server start timed out');
      const req = http.get(`http://127.0.0.1:${PORT}/api/auth/required`, res => {
        res.resume(); // drain, or the socket lingers
        if (settled) return;
        if (res.statusCode === 200) {
          settled = true;
          resolve();
        } else if (res.statusCode === 404 || (res.statusCode >= 500 && res.statusCode <= 599)) {
          // Wrong service (404) or a broken one (5xx) owns this port — retrying
          // for 30s cannot help. Fail fast instead of a blind timeout.
          fail(`Server answered with HTTP ${res.statusCode} — something else may own port ${PORT}`);
        } else setTimeout(check, 200);
      });
      // A hung server must not leave this request open past the deadline.
      req.setTimeout(2000, () => { try { req.destroy(); } catch {} });
      req.on('error', () => { if (!settled) setTimeout(check, 200); });
    };
    setTimeout(check, 500);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 600,
    minHeight: 400,
    title: 'WebTun',
    icon: path.join(__dirname, '..', 'public', 'icon-512.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  const viewMenu = [
    { role: 'reload' }, { role: 'forceReload' },
    { type: 'separator' },
    { role: 'togglefullscreen' },
  ];
  // DevTools only in dev — a packaged renderer with a console is a gift to XSS
  if (!app.isPackaged) {
    viewMenu.push({ type: 'separator' }, { role: 'toggleDevTools' });
  }
  const menu = Menu.buildFromTemplate([
    {
      label: 'WebTun',
      submenu: [
        { label: 'About WebTun', role: 'about' },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: viewMenu
    }
  ]);
  Menu.setApplicationMenu(menu);

  mainWindow.loadURL(`http://127.0.0.1:${PORT}`);

  mainWindow.on('closed', () => { mainWindow = null; });
}

// Single instance: a second launch focuses the running window instead of
// racing the same PORT and showing an error dialog.
// NOTE: requestSingleInstanceLock() also returns false when the lock socket
// itself cannot be created (read-only/exotic TMPDIR, sandboxed FS) —
// indistinguishable from "another instance is running". If the app quits
// silently right after launch with no window and no dialog, check TMPDIR
// writability (Linux) or a stale lock before assuming a crash.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function isAddrInUse(err) {
  return /EADDRINUSE|address already in use/i.test(String(err && err.message || ''));
}

function stopServerProcess() {
  if (!serverProcess) return;
  const child = serverProcess;
  serverProcess = null;
  try { child.kill('SIGTERM'); } catch {}
  // A stuck server holding the port used to survive SIGTERM forever, so rapid
  // relaunch depended entirely on the EADDRINUSE retry loop. Escalate to
  // SIGKILL after a grace period (taskkill below already covers win32).
  setTimeout(() => {
    try { child.kill('SIGKILL'); } catch {}
  }, 5000).unref();
  // Windows SIGTERM is best-effort — fall back to taskkill so a stuck child
  // cannot hold the port across the EADDRINUSE retry loop either.
  if (process.platform === 'win32' && child.pid) {
    try {
      const { execFileSync } = require('child_process');
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {}
  }
}

app.whenReady().then(async () => {
  if (!gotLock) return; // second instance — quitting, don't boot another server
  try {
    // Auto-pick a free port (3000 → 3001 → …) so an occupied default port
    // boots the app instead of failing. startServer()/createWindow() read PORT.
    const free = await findFreePort(PORT);
    if (free !== PORT) console.log(`Port ${PORT} occupied — using ${free} instead`);
    PORT = free;
    // findFreePort only *probed* the port (bind, close, hand over); something can
    // grab it in that window. Retry on the next port instead of dying.
    for (let attempt = 0; ; attempt++) {
      try {
        await startServer();
        break;      } catch (e) {
        stopServerProcess();
        if (attempt >= 4 || !isAddrInUse(e)) throw e;
        const next = await findFreePort(PORT + 1);
        console.log(`Port ${PORT} was taken during startup — retrying on ${next}`);
        PORT = next;
      }
    }
    createWindow();
    _autoUpdater = setupAutoUpdates() || null;
  } catch (e) {
    dialog.showErrorBox('WebTun Error', `Failed to start server:\n${e.message}`);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (serverProcess) {
    const child = serverProcess;
    serverProcess = null;
    try { child.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000).unref();
    // Windows SIGTERM is best-effort — fall back to taskkill so the port frees
    if (process.platform === 'win32' && child.pid) {
      try {
        const { execFileSync } = require('child_process');
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {}
    }
  }
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});

// ── Exit app (from Settings → Exit app) ──────────────────────────
ipcMain.handle('exit-app', () => {
  app.quit();
});

// ── Auto-start on login ──────────────────────────────────────
ipcMain.handle('get-autostart', () => {
  return app.getLoginItemSettings().openAtLogin;
});

ipcMain.handle('set-autostart', (_event, enabled) => {
  // IPC is renderer-reachable: accept a strict boolean only, so a compromised
  // renderer can't smuggle unexpected values into the login-item settings.
  const open = enabled === true;
  // Preserve the app's own args across autostart, but strip Electron/Chromium
  // runtime flags (they are re-added by the runtime itself and must not
  // accumulate in the login item). A denylist of known runtime flags keeps
  // future app flags working; compare on the part before '=' so --flag=v
  // forms are caught too.
  const RUNTIME_FLAGS = new Set([
    '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--disable-software-rasterizer', '--enable-logging', '--v', '--vmodule',
    '--remote-debugging-port', '--inspect', '--inspect-brk', '--js-flags',
    '--trace-warnings', '--pending-deprecation', '--no-deprecation',
    '--expose-gc', '--single-process', '--no-zygote', '--in-process-gpu',
  ]);
  app.setLoginItemSettings({
    openAtLogin: open,
    path: process.execPath,
    args: process.argv.slice(1).filter(a => !RUNTIME_FLAGS.has(String(a).split('=')[0]))
  });
  return app.getLoginItemSettings().openAtLogin;
});

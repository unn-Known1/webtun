const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const { fork } = require('child_process');
const path = require('path');
const os = require('os');
const http = require('http');
const net = require('net');
const fs = require('fs');

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
        fs.appendFileSync(serverLogPath(), text);
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
  try { serverProcess.kill('SIGTERM'); } catch {}
  serverProcess = null;
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
        break;
      } catch (e) {
        stopServerProcess();
        if (attempt >= 4 || !isAddrInUse(e)) throw e;
        const next = await findFreePort(PORT + 1);
        console.log(`Port ${PORT} was taken during startup — retrying on ${next}`);
        PORT = next;
      }
    }
    createWindow();
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
    try { serverProcess.kill('SIGTERM'); } catch {}
    // Windows SIGTERM is best-effort — fall back to taskkill so the port frees
    if (process.platform === 'win32' && serverProcess.pid) {
      try {
        const { execFileSync } = require('child_process');
        execFileSync('taskkill', ['/PID', String(serverProcess.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {}
    }
    serverProcess = null;
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
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: process.execPath,
    args: process.argv.slice(1).filter(a => !a.startsWith('--'))
  });
  return app.getLoginItemSettings().openAtLogin;
});

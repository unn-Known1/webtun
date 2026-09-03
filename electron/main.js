const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const { fork } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');

let mainWindow;
let serverProcess;
const PORT = (() => {
  const p = parseInt(process.env.PORT, 10);
  return Number.isFinite(p) && p > 0 && p <= 65535 ? p : 3000;
})();
const PIN = process.env.PIN || '';
if (PIN && typeof PIN !== 'string') {
  console.warn('Invalid PIN type — expected string');
}

function resolveNodeModules() {
  // Packaged app: resources/node_modules or app.asar.unpacked/node_modules
  if (app.isPackaged) {
    const candidates = [
      path.join(process.resourcesPath, 'node_modules'),
      path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules'),
      path.join(path.dirname(app.getAppPath()), 'node_modules'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
  }
  return path.join(__dirname, '..', 'node_modules');
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
    // Validate PIN exists and is a non-empty string before passing to server
    if (PIN && typeof PIN === 'string' && PIN.trim().length > 0) {
      env.PIN = PIN.trim();
    } else if (PIN) {
      console.warn('Invalid PIN — starting without authentication');
      delete env.PIN;
    }
    // Ensure forked server can resolve deps when packaged
    env.NODE_PATH = [nodeModules, env.NODE_PATH].filter(Boolean).join(path.delimiter);

    serverProcess = fork(serverPath, [], {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    serverProcess.stdout.on('data', d => console.log('[server]', d.toString().trim()));
    serverProcess.stderr.on('data', d => console.error('[server]', d.toString().trim()));

    let settled = false;
    const fail = (msg) => {
      if (settled) return;
      settled = true;
      reject(new Error(msg));
    };

    serverProcess.on('exit', code => {
      if (code !== 0) {
        console.error(`Server exited with code ${code}`);
        fail(`Server exited with code ${code}`);
      }
    });
    serverProcess.on('error', err => fail(err.message));

    const deadline = Date.now() + 30000;
    const check = () => {
      if (settled) return;
      if (Date.now() > deadline) return fail('Server start timed out');
      http.get(`http://127.0.0.1:${PORT}/api/auth/required`, res => {
        if (res.statusCode === 200) {
          settled = true;
          resolve();
        } else setTimeout(check, 200);
      }).on('error', () => setTimeout(check, 200));
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

app.whenReady().then(async () => {
  if (!gotLock) return; // second instance — quitting, don't boot another server
  try {
    await startServer();
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
        const { execSync } = require('child_process');
        execSync(`taskkill /PID ${serverProcess.pid} /T /F`, { stdio: 'ignore' });
      } catch {}
    }
    serverProcess = null;
  }
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
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

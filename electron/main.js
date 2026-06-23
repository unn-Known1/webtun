const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require('electron');
const { fork } = require('child_process');
const path = require('path');
const http = require('http');

let mainWindow;
let serverProcess;
const PORT = process.env.PORT || 3000;

function startServer() {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, '..', 'server.js');
    serverProcess = fork(serverPath, [], {
      env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    serverProcess.stdout.on('data', d => console.log('[server]', d.toString().trim()));
    serverProcess.stderr.on('data', d => console.error('[server]', d.toString().trim()));

    serverProcess.on('exit', code => {
      if (code !== 0) console.error(`Server exited with code ${code}`);
    });

    const check = () => {
      http.get(`http://127.0.0.1:${PORT}/api/auth/required`, res => {
        if (res.statusCode === 200) resolve();
        else setTimeout(check, 200);
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
      preload: path.join(__dirname, 'preload.js')
    }
  });

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
      submenu: [
        { role: 'reload' }, { role: 'forceReload' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'toggleDevTools' }
      ]
    }
  ]);
  Menu.setApplicationMenu(menu);

  mainWindow.loadURL(`http://127.0.0.1:${PORT}`);

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
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
    serverProcess.kill('SIGTERM');
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
    args: process.argv.slice(1).filter(a => a !== '--')
  });
  return app.getLoginItemSettings().openAtLogin;
});

// MaxOS desktop wrapper (Mac + Windows).
// Opens the live MaxOS deployment in a native window. The web app does all the
// real work (login, apps, server APIs) — this just gives it a Dock/Taskbar icon,
// its own window, and lets MaxOS's Fullscreen API drive real native fullscreen.
const { app, BrowserWindow, shell, Menu } = require('electron');
const path = require('path');

const MAXOS_URL = 'https://maxos-1oe3.onrender.com';
// Only these hosts are allowed to load *inside* the app window. Anything else
// (an external link a user clicks) opens in their real browser instead.
const ALLOWED_HOSTS = new Set([
  'maxos-1oe3.onrender.com',
  'minecraft-mockup.onrender.com',
]);

let win;

function isInternal(url) {
  try { return ALLOWED_HOSTS.has(new URL(url).hostname); }
  catch { return false; }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0a0a0f',
    title: 'MaxOS',
    show: false,
    autoHideMenuBar: true, // hide the menu bar on Windows/Linux (Mac keeps its top menu)
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
      webviewTag: true, // lets the in-app Browser use <webview> to load real websites
    },
  });

  win.once('ready-to-show', () => {
    win.maximize();
    win.show();
  });

  win.loadURL(MAXOS_URL);

  // External links → default browser. Internal navigation stays in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isInternal(url)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!isInternal(url)) { e.preventDefault(); shell.openExternal(url); }
  });

  win.on('closed', () => { win = null; });
}

// A trimmed menu: keep the essentials (copy/paste, reload, fullscreen, devtools,
// quit) and the standard macOS app menu, drop the clutter.
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Single-instance: focus the existing window instead of opening a second one.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(() => {
    buildMenu();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

// MaxOS desktop wrapper (Mac + Windows).
// Opens the live MaxOS deployment in a native window. The web app does all the
// real work (login, apps, server APIs) — this just gives it a Dock/Taskbar icon,
// its own window, and lets MaxOS's Fullscreen API drive real native fullscreen.
const { app, BrowserWindow, shell, Menu, ipcMain, net } = require('electron');
const path = require('path');
const fs = require('fs');

// Let the in-app WebRTC see the real LAN IP (browsers normally hide it behind an
// mDNS .local name). This makes MaxOS's device-IP logging reliable in the app.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');

const MAXOS_URL = 'https://maxos-1oe3.onrender.com';
// GitHub repo that publishes the desktop installers (GitHub Releases).
const GH_REPO = 'maxvbuda/maxos';
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

// ── In-app updates ────────────────────────────────────────────────────────────
// The app loads the live site, so the *web* part updates instantly. This handles
// the native shell: it asks GitHub Releases for the latest version and, on the
// user's click, downloads the right installer for this OS and launches it. No
// code-signing / auto-update feed required — it's a one-button "go get the new
// installer and open it" so the user doesn't have to hunt for a download link.

// Which release asset matches the machine we're running on.
function assetNameForPlatform() {
  if (process.platform === 'darwin') return 'MaxOS-mac.dmg';
  if (process.platform === 'win32') return 'MaxOS-Setup.exe';
  return null;
}

// Compare dotted versions ("1.2.0" vs "v1.10.0"). Returns 1 / 0 / -1.
function cmpVersion(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

// GET JSON via Electron's net stack (follows redirects, uses system proxy).
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, redirect: 'follow' });
    request.setHeader('User-Agent', 'MaxOS-Desktop');
    request.setHeader('Accept', 'application/vnd.github+json');
    let body = '';
    request.on('response', (response) => {
      response.on('data', (c) => { body += c.toString(); });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Bad response from GitHub')); }
      });
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end();
  });
}

// Download a file to `dest`, reporting 0–100% progress. GitHub asset URLs
// redirect to a CDN; net follows that automatically.
function downloadTo(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, redirect: 'follow' });
    request.setHeader('User-Agent', 'MaxOS-Desktop');
    request.on('response', (response) => {
      if (response.statusCode >= 400) { reject(new Error('Download failed (HTTP ' + response.statusCode + ')')); return; }
      const len = response.headers['content-length'];
      const total = parseInt(Array.isArray(len) ? len[0] : len, 10) || 0;
      let received = 0;
      const out = fs.createWriteStream(dest);
      out.on('error', reject);
      response.on('data', (chunk) => {
        received += chunk.length;
        out.write(chunk);
        if (onProgress && total) onProgress(Math.min(100, Math.round((received / total) * 100)));
      });
      response.on('end', () => out.end(() => resolve()));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end();
  });
}

ipcMain.handle('app:version', () => app.getVersion());

ipcMain.handle('update:check', async () => {
  try {
    const rel = await fetchJson(`https://api.github.com/repos/${GH_REPO}/releases/latest`);
    const latest = rel.tag_name || rel.name || '';
    const current = app.getVersion();
    const want = assetNameForPlatform();
    let downloadUrl = null;
    if (Array.isArray(rel.assets) && want) {
      const a = rel.assets.find(x => x.name === want);
      if (a) downloadUrl = a.browser_download_url;
    }
    return { ok: true, current, latest, hasUpdate: cmpVersion(latest, current) > 0,
             downloadUrl, notes: rel.body || '', url: rel.html_url || '' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('update:install', async () => {
  try {
    const rel = await fetchJson(`https://api.github.com/repos/${GH_REPO}/releases/latest`);
    const want = assetNameForPlatform();
    const asset = (rel.assets || []).find(x => x.name === want);
    // No matching installer (e.g. Linux) → just open the releases page.
    if (!asset) {
      await shell.openExternal(rel.html_url || `https://github.com/${GH_REPO}/releases/latest`);
      return { ok: true, opened: 'page' };
    }
    const dest = path.join(app.getPath('downloads'), asset.name);
    await downloadTo(asset.browser_download_url, dest, (pct) => {
      if (win && !win.isDestroyed()) win.webContents.send('update:progress', pct);
    });
    // Launch the installer (.dmg mounts / .exe runs); user finishes the install.
    await shell.openPath(dest);
    return { ok: true, opened: 'installer', path: dest };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

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

  // When a page inside the in-app browser opens a new window (window.open /
  // target=_blank), route it into a new browser TAB instead of a bare window.
  app.on('web-contents-created', (e, contents) => {
    if (contents.getType && contents.getType() === 'webview') {
      contents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/i.test(url) && win) {
          win.webContents.executeJavaScript(`window.ebNewTab && ebNewTab(${JSON.stringify(url)})`).catch(() => {});
        }
        return { action: 'deny' };
      });
    }
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

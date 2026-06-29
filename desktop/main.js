// MaxOS desktop wrapper (Mac + Windows).
// Opens the live MaxOS deployment in a native window. The web app does all the
// real work (login, apps, server APIs) — this just gives it a Dock/Taskbar icon,
// its own window, and lets MaxOS's Fullscreen API drive real native fullscreen.
const { app, BrowserWindow, shell, Menu, ipcMain, net, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFileSync } = require('child_process');

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
// the native shell with a NO-INSTALLER self-update: it downloads the new version
// as a zip, swaps its own .app bundle on disk, and relaunches. This works without
// an Apple Developer ID because the app lives in a user-writable folder and is
// ad-hoc signed — we just strip quarantine and reopen. (The standard Squirrel
// auto-updater can't do this on macOS without a paid signing identity.)

// The release asset this OS self-updates FROM. macOS uses a zip of the .app so we
// can swap the bundle in place; Windows uses the portable zip for the same reason.
function updateAssetName() {
  if (process.platform === 'darwin') return 'MaxOS-mac.zip';
  if (process.platform === 'win32') return 'MaxOS-windows.zip';
  return null;
}

// Path to the running .app bundle (macOS), or null if not packaged in one (dev).
function appBundlePath() {
  const exe = app.getPath('exe');           // …/MaxOS.app/Contents/MacOS/MaxOS
  const i = exe.indexOf('.app/');
  return i === -1 ? null : exe.slice(0, i + 4);
}

// First *.app directory found directly under `dir`.
function findDotApp(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.app')) return path.join(dir, name);
  }
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

// Download the update zip, then hand off to the platform self-replacer. On macOS
// this quits the app and a detached helper swaps the bundle + relaunches, so this
// promise typically never resolves on success (the process is gone) — that's fine.
async function applyUpdate(asset) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maxos-update-'));
  const zipPath = path.join(tmp, asset.name);
  await downloadTo(asset.browser_download_url, zipPath, (pct) => {
    if (win && !win.isDestroyed()) { win.setProgressBar(pct / 100); win.webContents.send('update:progress', pct); }
  });
  if (win && !win.isDestroyed()) win.setProgressBar(-1);

  if (process.platform === 'darwin') return applyUpdateMac(zipPath, tmp);
  if (process.platform === 'win32')  return applyUpdateWin(zipPath, tmp);
  await shell.openPath(zipPath); // other platforms: just reveal the download
  return { ok: true, opened: 'file' };
}

// macOS: extract the new .app, then a detached bash helper waits for us to quit,
// replaces the bundle in place, strips quarantine, and relaunches.
function applyUpdateMac(zipPath, tmp) {
  const bundle = appBundlePath();
  if (!bundle) return { ok: false, error: "Not running from an .app bundle (dev mode)" };
  const extractDir = path.join(tmp, 'x');
  fs.mkdirSync(extractDir, { recursive: true });
  execFileSync('/usr/bin/ditto', ['-x', '-k', zipPath, extractDir]); // preserves signature
  const newApp = findDotApp(extractDir);
  if (!newApp) return { ok: false, error: 'No .app found inside the update' };
  try { execFileSync('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', newApp]); } catch {}

  const q = (s) => s.replace(/"/g, '\\"');
  const script = `#!/bin/bash
APP="${q(bundle)}"
NEW="${q(newApp)}"
# Wait (up to ~30s) for the running app to fully exit.
for i in $(seq 1 60); do
  pgrep -f "$APP/Contents/MacOS/" >/dev/null || break
  sleep 0.5
done
rm -rf "$APP" && /usr/bin/ditto "$NEW" "$APP"
/usr/bin/xattr -dr com.apple.quarantine "$APP" 2>/dev/null
open "$APP"
`;
  const scriptPath = path.join(tmp, 'swap.sh');
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });
  spawn('/bin/bash', [scriptPath], { detached: true, stdio: 'ignore' }).unref();
  // Quit so the helper can replace us; it relaunches the new version.
  setTimeout(() => app.exit(0), 400);
  return { ok: true, applied: 'mac' };
}

// Windows: extract the portable zip, then a detached batch waits for exit,
// mirrors the new files over the install dir, and relaunches.
function applyUpdateWin(zipPath, tmp) {
  const exe = app.getPath('exe');
  const installDir = path.dirname(exe);
  const extractDir = path.join(tmp, 'x');
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${extractDir}' -Force`]);
  // The portable zip extracts the app files at the root of extractDir.
  const bat = `@echo off
:wait
tasklist /FI "IMAGENAME eq MaxOS.exe" | find /I "MaxOS.exe" >nul && (timeout /t 1 /nobreak >nul & goto wait)
robocopy "${extractDir}" "${installDir}" /MIR /NFL /NDL /NJH /NJS /NC /NS /NP >nul
start "" "${exe}"
`;
  const batPath = path.join(tmp, 'swap.bat');
  fs.writeFileSync(batPath, bat);
  spawn('cmd.exe', ['/c', batPath], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  setTimeout(() => app.exit(0), 400);
  return { ok: true, applied: 'win' };
}

ipcMain.handle('app:version', () => app.getVersion());

ipcMain.handle('update:check', async () => {
  try {
    const rel = await fetchJson(`https://api.github.com/repos/${GH_REPO}/releases/latest`);
    const latest = rel.tag_name || rel.name || '';
    const current = app.getVersion();
    const want = updateAssetName();
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
    const want = updateAssetName();
    const asset = (rel.assets || []).find(x => x.name === want);
    // No matching asset (e.g. Linux) → just open the releases page.
    if (!asset) {
      await shell.openExternal(rel.html_url || `https://github.com/${GH_REPO}/releases/latest`);
      return { ok: true, opened: 'page' };
    }
    return await applyUpdate(asset); // downloads, swaps in place, relaunches
  } catch (e) {
    if (win && !win.isDestroyed()) win.setProgressBar(-1);
    return { ok: false, error: String((e && e.message) || e) };
  }
});

// Menu-driven "Check for Updates…" — always available (even while logged in),
// using native dialogs + a Dock/taskbar progress bar during download.
async function checkForUpdatesInteractive() {
  let rel;
  try {
    rel = await fetchJson(`https://api.github.com/repos/${GH_REPO}/releases/latest`);
  } catch (e) {
    dialog.showMessageBox(win, { type: 'warning', message: 'Could not check for updates',
      detail: String((e && e.message) || e), buttons: ['OK'] });
    return;
  }
  const latest = rel.tag_name || rel.name || '';
  const current = app.getVersion();

  if (cmpVersion(latest, current) <= 0) {
    dialog.showMessageBox(win, { type: 'info', message: "You're up to date",
      detail: `MaxOS ${current} is the latest version.`, buttons: ['OK'] });
    return;
  }

  const { response } = await dialog.showMessageBox(win, {
    type: 'info', message: `Update available — MaxOS ${latest}`,
    detail: `You have ${current}. Update now? MaxOS will download it, then restart itself — no installer.`,
    buttons: ['Update & Restart', 'Later'], defaultId: 0, cancelId: 1 });
  if (response !== 0) return;

  const want = updateAssetName();
  const asset = (rel.assets || []).find(x => x.name === want);
  if (!asset) { shell.openExternal(rel.html_url || `https://github.com/${GH_REPO}/releases/latest`); return; }

  try {
    const r = await applyUpdate(asset); // downloads + swaps in place + relaunches
    // On macOS/Windows the app exits to relaunch, so we usually never reach here.
    if (r && r.ok && r.opened) {
      dialog.showMessageBox(win, { type: 'info', message: 'Update downloaded',
        detail: 'Opened the download to finish.', buttons: ['OK'] });
    } else if (r && !r.ok) {
      dialog.showMessageBox(win, { type: 'error', message: 'Update failed',
        detail: r.error || 'Please try again later.', buttons: ['OK'] });
    }
  } catch (e) {
    if (win && !win.isDestroyed()) win.setProgressBar(-1);
    dialog.showMessageBox(win, { type: 'error', message: 'Update failed',
      detail: String((e && e.message) || e), buttons: ['OK'] });
  }
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
  const checkForUpdates = { label: 'Check for Updates…', click: () => checkForUpdatesInteractive() };
  const template = [
    // Custom app menu on macOS so we can slot "Check for Updates…" under About.
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        checkForUpdates,
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
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
    // On Windows/Linux there's no app menu, so expose updates under Help.
    ...(!isMac ? [{ label: 'Help', submenu: [checkForUpdates] }] : []),
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

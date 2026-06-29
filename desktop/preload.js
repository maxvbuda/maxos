// Preload bridge. MaxOS is a normal web app and needs no privileged native APIs
// for its day-to-day work — but we expose a tiny, locked-down "maxosDesktop"
// object so the web page can offer an in-app "Install update" button. Nothing
// here gives the page filesystem or shell access; it can only ask the main
// process to check GitHub Releases and (if the user clicks) download + launch
// the official installer.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('maxosDesktop', {
  isDesktop: true,
  // Current installed app version (e.g. "1.0.0").
  version: () => ipcRenderer.invoke('app:version'),
  // Returns { ok, current, latest, hasUpdate, downloadUrl, notes, url }.
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
  // Downloads the installer for this OS and opens it. `onProgress(pct)` is
  // called with 0–100 while downloading. Resolves to { ok, opened, path }.
  installUpdate: (onProgress) => {
    const handler = (_e, pct) => { try { onProgress && onProgress(pct); } catch {} };
    if (onProgress) ipcRenderer.on('update:progress', handler);
    return ipcRenderer.invoke('update:install').finally(() => {
      ipcRenderer.removeListener('update:progress', handler);
    });
  },
});

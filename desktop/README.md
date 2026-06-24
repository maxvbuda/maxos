# MaxOS Desktop (Mac & Windows)

A native desktop wrapper around the live MaxOS deployment
(`https://maxos-1oe3.onrender.com`). It's a thin Electron shell: the website does
all the real work, and this gives it its own window, a Dock/Taskbar icon, and real
native fullscreen (MaxOS's Fullscreen API drives it).

Because it loads the live site, the app is **always up to date** — no rebuild needed
when you ship changes to MaxOS. You only rebuild the installer to change the wrapper
itself (icon, window behavior, allowed hosts).

## Run it (dev)

```bash
cd desktop
npm install
npm start
```

## Build installers

Each installer must be built **on its own OS** (electron-builder can't reliably
cross-build a signed Windows `.exe` from macOS, and vice-versa).

**Mac** (run on macOS) → produces `release/MaxOS-1.0.0-arm64.dmg` and an x64 dmg:

```bash
cd desktop
npm install
npm run dist:mac
```

**Windows** (run on Windows) → produces `release/MaxOS Setup 1.0.0.exe` (NSIS installer):

```bash
cd desktop
npm install
npm run dist:win
```

> No GitHub-Actions/CI runner is configured here. If you want one-command builds of
> both from any machine, add a CI workflow with a `macos-latest` job and a
> `windows-latest` job each running the matching command — ask and I'll add it.

## Code signing / notarization

The builds above are **unsigned**. They run fine, but:

- **macOS** shows a Gatekeeper warning on first open (right-click → Open to bypass).
  To remove it you need an Apple Developer ID cert + notarization.
- **Windows** shows a SmartScreen warning. To remove it you need an Authenticode
  cert (e.g. from a CA).

Signing needs your own paid certificates, so it's left off by default.

## What loads in-app vs the browser

Only `maxos-1oe3.onrender.com` and `minecraft-mockup.onrender.com` load inside the
window. Any other link a user clicks opens in their default browser. Edit
`ALLOWED_HOSTS` in `main.js` to change that.

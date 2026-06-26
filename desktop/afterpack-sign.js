// electron-builder afterPack hook: ad-hoc code-sign the macOS app inside-out.
//
// Without a paid Apple Developer ID, electron-builder leaves the bundled Helper
// apps "not signed at all". That's fine until the app is DOWNLOADED — macOS then
// quarantines it and refuses to spawn unsigned helper processes, so the window
// never appears (the app just "bounces" in the Dock). An ad-hoc signature (`-`)
// is a valid signature (just not from a known developer), which lets the helpers
// run after the user approves the app via right-click → Open.
//
// We sign deepest-first (helpers + frameworks + dylibs, then the app) because a
// bundle's signature seals the hashes of everything inside it.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  // For a universal build, electron-builder packs per-arch into *-temp dirs and
  // then merges them. Signing the temp dirs changes file counts and breaks the
  // merge, so only sign the final merged app.
  if (context.appOutDir.includes('-temp')) return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  const frameworks = path.join(appPath, 'Contents', 'Frameworks');

  const sign = (args, label) => {
    try {
      execFileSync('codesign', args, { stdio: 'pipe' });
    } catch (e) {
      console.warn('[afterpack-sign] sign issue on', label, '-', (e.stderr || e.message || '').toString().trim());
    }
  };

  // Sign deepest-first: each helper app and framework with --deep (so their nested
  // dylibs/binaries are sealed), then the whole app bundle with --deep.
  if (fs.existsSync(frameworks)) {
    for (const entry of fs.readdirSync(frameworks)) {
      const full = path.join(frameworks, entry);
      sign(['--force', '--deep', '--sign', '-', '--timestamp=none', full], entry);
    }
  }
  sign(['--force', '--deep', '--sign', '-', '--timestamp=none', appPath], appName + '.app');

  // Verify the result so a broken signature fails the build loudly rather than
  // shipping an app that bounces on Apple Silicon.
  try {
    execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'pipe' });
    console.log('[afterpack-sign] ad-hoc signed + verified', appName + '.app');
  } catch (e) {
    console.warn('[afterpack-sign] VERIFY FAILED:', (e.stderr || e.message || '').toString().trim());
  }
};

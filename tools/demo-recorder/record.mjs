// Records a guided-tour video of MaxOS with Playwright.
// Signs in with demo creds (from env / GitHub secrets — never hard-coded), then
// opens a sequence of apps so the video shows off the desktop. Playwright records
// the whole session to a .webm; CI converts it to .mp4 afterwards.
//
// Env:
//   MAXOS_URL  (default https://maxos-1oe3.onrender.com)
//   DEMO_USER  demo account username   (required)
//   DEMO_PASS  demo account password   (required)
//   OUT_DIR    where to write the video (default "video")
import { chromium } from 'playwright';

const URL  = process.env.MAXOS_URL || 'https://maxos-1oe3.onrender.com';
const USER = process.env.DEMO_USER;
const PASS = process.env.DEMO_PASS;
const OUT  = process.env.OUT_DIR || 'video';

if (!USER || !PASS) {
  console.error('Missing DEMO_USER / DEMO_PASS env vars (set them as GitHub repo secrets).');
  process.exit(1);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  recordVideo: { dir: OUT, size: { width: 1280, height: 800 } },
});
const page = await context.newPage();

try {
  console.log('Opening', URL);
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });

  // Render's free tier can cold-start — wait generously for the login form.
  await page.waitForSelector('#auth-username', { timeout: 120000 });
  await wait(2000); // let the login screen settle on camera

  console.log('Signing in as', USER);
  await page.fill('#auth-username', USER);
  await page.fill('#auth-password', PASS); // masked field — never shows in the video
  await wait(700);
  await page.click('#auth-btn');

  // Logged in once the login screen is hidden.
  await page.waitForFunction(() => {
    const ls = document.getElementById('login-screen');
    return ls && getComputedStyle(ls).display === 'none';
  }, { timeout: 60000 });
  await wait(4000); // boot animation + desktop settle

  // Guided tour: open a handful of apps with pauses so each is visible.
  const tour = ['files', 'calendar', 'paint', 'music', 'weather', 'snake'];
  for (const id of tour) {
    console.log('Opening app:', id);
    await page.evaluate((app) => window.openApp && window.openApp(app), id);
    await wait(2800);
  }
  await wait(2000);
  console.log('Tour complete.');
} catch (e) {
  console.error('Tour error (saving whatever was recorded):', e.message);
} finally {
  // Closing the context finalizes and flushes the video file.
  await context.close();
  await browser.close();
}

// Records a guided-tour video of MaxOS with Playwright — and actually *uses* the
// apps: runs a calculation, draws a smiley in Paint, plays a real game of Snake
// (autopilot synced to the game's tick so it grows instead of dying), and plays
// music. Signs in with demo creds from env / GitHub secrets (never hard-coded);
// the password goes into a masked field so it never appears on camera.
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
const W = 1440, H = 900;

if (!USER || !PASS) {
  console.error('Missing DEMO_USER / DEMO_PASS env vars (set them as GitHub repo secrets).');
  process.exit(1);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
  recordVideo: { dir: OUT, size: { width: W, height: H } },
});
const page = await context.newPage();

// ── small helpers ────────────────────────────────────────────────────────────
const openApp  = async (id, settle = 1100) => { await page.evaluate((a) => window.openApp(a), id);  await wait(settle); };
const closeApp = async (id, settle = 500)  => { await page.evaluate((a) => window.closeWindow && window.closeWindow(a), id); await wait(settle); };
const closeAll = async () => { await page.evaluate(() => { document.querySelectorAll('.window').forEach(w => window.closeWindow && window.closeWindow(w.id.replace(/^win-/, ''))); }); await wait(700); };

// Draw a freehand stroke through viewport points with the real mouse.
async function stroke(points) {
  await page.mouse.move(points[0].x, points[0].y);
  await page.mouse.down();
  for (let i = 1; i < points.length; i++) await page.mouse.move(points[i].x, points[i].y, { steps: 4 });
  await page.mouse.up();
  await wait(120);
}

try {
  console.log('Opening', URL);
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('#auth-username', { timeout: 120000 });
  await wait(1800); // let the login screen settle on camera

  // ── Sign in ────────────────────────────────────────────────────────────────
  console.log('Signing in as', USER);
  await page.fill('#auth-username', USER);
  await page.fill('#auth-password', PASS); // masked — never visible in the video
  await wait(700);
  await page.click('#auth-btn');
  await page.waitForFunction(() => {
    const ls = document.getElementById('login-screen');
    return ls && getComputedStyle(ls).display === 'none';
  }, { timeout: 60000 });
  await wait(4200); // boot animation + desktop settle

  // ── Calculator: 7 × 8 = 56 ───────────────────────────────────────────────────
  console.log('Calculator');
  await openApp('calc', 1000);
  for (const label of ['7', '×', '8', '=']) {
    await page.evaluate((l) => {
      const b = [...document.querySelectorAll('.calc-btn')].find((x) => x.textContent.trim() === l);
      if (b) b.click();
    }, label);
    await wait(650);
  }
  await wait(1600);
  await closeApp('calc');

  // ── Paint: draw a smiley with real mouse strokes + colour changes ────────────
  console.log('Paint');
  await openApp('paint', 1200);
  const r = await page.evaluate(() => {
    const c = document.getElementById('paint-canvas');
    const b = c.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  });
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2, R = Math.min(r.w, r.h) * 0.26;
  const pickSwatch = (i) => page.evaluate((idx) => document.querySelectorAll('.color-swatch')[idx].click(), i);
  const setSize    = (n) => page.evaluate((s) => { const el = document.getElementById('pt-size'); if (el) el.value = s; }, n);
  // colours: [white, red, yellow, green, blue, purple, orange, mint, black, grey]
  // Face (yellow)
  await pickSwatch(2); await setSize(6);
  const face = [];
  for (let a = 0; a <= 360; a += 10) { const t = (a * Math.PI) / 180; face.push({ x: cx + R * Math.cos(t), y: cy + R * Math.sin(t) }); }
  await stroke(face);
  await wait(400);
  // Eyes (blue)
  await pickSwatch(4); await setSize(13);
  const eyeY = cy - R * 0.25, eyeDX = R * 0.4;
  await stroke([{ x: cx - eyeDX, y: eyeY - 7 }, { x: cx - eyeDX, y: eyeY + 7 }]);
  await stroke([{ x: cx + eyeDX, y: eyeY - 7 }, { x: cx + eyeDX, y: eyeY + 7 }]);
  await wait(400);
  // Smile (red)
  await pickSwatch(1); await setSize(7);
  const smile = [];
  for (let t = -1; t <= 1.001; t += 0.1) smile.push({ x: cx + t * R * 0.55, y: cy + R * 0.15 + (1 - t * t) * R * 0.4 });
  await stroke(smile);
  await wait(1800);
  await closeApp('paint');

  // ── Snake: actually play it (and play it well) ───────────────────────────────
  // A real food-seeking AI: mirror the snake's state in JS and read the food's
  // position straight off the canvas (the red pixel), then greedily move toward it
  // while avoiding walls and our own body. Synced to the game's 130ms tick using
  // the page's own clock, so the snake actually eats and grows on camera.
  console.log('Snake');
  await openApp('snake', 900);
  await page.evaluate(() => new Promise((resolve) => {
    const COLS = 18, ROWS = 18, CELL = 20, TICK = 130, STEPS = 110;
    const cv = document.getElementById('snake-canvas'); const ctx = cv.getContext('2d');
    const fire = (key) => document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    fire(' '); // Space starts the game
    let body = [{ x: 9, y: 9 }, { x: 8, y: 9 }, { x: 7, y: 9 }], dir = { x: 1, y: 0 };
    const dirs = [
      { x: 1, y: 0, k: 'ArrowRight' }, { x: -1, y: 0, k: 'ArrowLeft' },
      { x: 0, y: 1, k: 'ArrowDown' },  { x: 0, y: -1, k: 'ArrowUp' },
    ];
    const readFood = () => {
      const img = ctx.getImageData(0, 0, cv.width, cv.height).data;
      let best = null, bs = -1;
      for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
        const px = (x * CELL + CELL / 2) | 0, py = (y * CELL + CELL / 2) | 0, i = (py * cv.width + px) * 4;
        const r = img[i], g = img[i + 1], b = img[i + 2], sc = r - (g + b) / 2;
        if (r > 150 && g < 150 && b < 150 && sc > bs) { bs = sc; best = { x, y }; }
      }
      return best;
    };
    let step = 0; const t0 = performance.now();
    const loop = () => {
      if (step >= STEPS) { resolve(); return; }
      const food = readFood(), occ = new Set(body.map((b) => b.x + ',' + b.y)), tail = body[body.length - 1];
      const opts = dirs
        .filter((d) => !(d.x === -dir.x && d.y === -dir.y)) // never reverse
        .map((d) => {
          const nx = body[0].x + d.x, ny = body[0].y + d.y;
          const wall = nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS;
          const hitTail = nx === tail.x && ny === tail.y; // tail vacates this tick
          const blocked = wall || (occ.has(nx + ',' + ny) && !hitTail);
          const dist = food ? Math.abs(nx - food.x) + Math.abs(ny - food.y) : 0;
          return { d, nx, ny, blocked, dist };
        })
        .filter((c) => !c.blocked);
      if (!opts.length) { resolve(); return; } // trapped — end the game gracefully
      // closest to the food, tie-break by keeping the current heading
      opts.sort((a, b) => a.dist - b.dist
        || ((b.d.x === dir.x && b.d.y === dir.y) ? 1 : 0) - ((a.d.x === dir.x && a.d.y === dir.y) ? 1 : 0));
      const p = opts[0];
      if (p.d.x !== dir.x || p.d.y !== dir.y) fire(p.d.k);
      dir = { x: p.d.x, y: p.d.y };
      const head = { x: p.nx, y: p.ny };
      body.unshift(head);
      if (food && head.x === food.x && head.y === food.y) { /* ate — keep the tail */ } else { body.pop(); }
      step++;
      setTimeout(loop, Math.max(0, t0 + step * TICK + 65 - performance.now())); // decide mid-tick
    };
    setTimeout(loop, 65);
  }));
  await wait(2400); // admire the score
  await closeApp('snake');

  // ── Music: hit play ──────────────────────────────────────────────────────────
  console.log('Music');
  await openApp('music', 1000);
  await page.evaluate(() => document.getElementById('music-play')?.click());
  await wait(3000);
  await closeApp('music');

  // ── Finish on a clean desktop ─────────────────────────────────────────────────
  await closeAll();
  await wait(1800);
  console.log('Tour complete.');
} catch (e) {
  console.error('Tour error (saving whatever was recorded):', e.message);
} finally {
  await context.close(); // finalizes/flushes the video
  await browser.close();
}

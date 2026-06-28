require('dotenv').config({ silent: true });
const express  = require('express');
const mongoose = require('mongoose');
const cors     = require('cors');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const path     = require('path');
const fs       = require('fs');
const http     = require('http');
const crypto   = require('crypto');
const { Server: SocketIOServer } = require('socket.io');

const app = express();
app.set('trust proxy', 1); // Render runs behind a proxy — get the real client IP from X-Forwarded-For
app.use(cors());
app.use(express.json({ limit: '25mb' })); // images (camera/paint/.pic) are base64 and far exceed the 100kb default

// ── Simple in-memory rate limiter (per IP, sliding window) ────────────────────
const rateHits = new Map(); // key -> [timestamps]
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const arr = (rateHits.get(key) || []).filter(t => now - t < windowMs);
  arr.push(now);
  rateHits.set(key, arr);
  return arr.length <= max; // true = allowed
}
setInterval(() => { const now = Date.now(); for (const [k, arr] of rateHits) { if (!arr.some(t => now - t < 3600000)) rateHits.delete(k); } }, 600000).unref?.();

// ── Proof-of-work sign-up challenge ───────────────────────────────────────────
// The browser must find a nonce so sha256(salt:nonce) starts with N zero hex
// chars. Stateless (HMAC-signed), so it costs real CPU per account (slows bots)
// without any per-IP penalty — classroom-friendly. ~4 zeros ≈ a second of work.
// Number of leading zero hex chars required in sha256(salt:nonce). Each +1 is ~16×
// more work for the browser. 5 ≈ ~1s on a phone; raise POW_DIFFICULTY env to go harder.
const POW_DIFFICULTY = Math.max(3, Math.min(6, parseInt(process.env.POW_DIFFICULTY, 10) || 5));
const POW_TTL = 3 * 60 * 1000;
const usedPow = new Set();
const powSig = (salt, exp) => crypto.createHmac('sha256', JWT_SECRET).update(salt + '.' + exp).digest('hex').slice(0, 16);
function powValid(p) {
  if (!p || !p.salt || !p.exp || !p.sig || p.nonce === undefined) return false;
  if (Date.now() > +p.exp) return false;
  if (powSig(p.salt, p.exp) !== p.sig) return false;          // we issued this challenge
  if (usedPow.has(p.salt)) return false;                       // no replay
  const h = crypto.createHash('sha256').update(p.salt + ':' + p.nonce).digest('hex');
  if (!h.startsWith('0'.repeat(POW_DIFFICULTY))) return false; // work actually done
  usedPow.add(p.salt); setTimeout(() => usedPow.delete(p.salt), POW_TTL).unref?.();
  return true;
}
const server = http.createServer(app);

const JWT_SECRET = process.env.JWT_SECRET || 'maxos-super-secret-key-2024';
// Always-admin usernames: 'max' (owner) plus anything in the ADMIN_USERS env var
const ADMIN_USERS = ['max', ...(process.env.ADMIN_USERS || '').split(',')].map(s => s.trim().toLowerCase()).filter(Boolean);
// Tester usernames: 'andy' plus anything in the TESTER_USERS env var. Testers get a
// bottom feedback panel and a "test mode" toggle that grants unlimited Minecraft time.
const TESTER_USERS = ['andy', ...(process.env.TESTER_USERS || '').split(',')].map(s => s.trim().toLowerCase()).filter(Boolean);
const isTester = (name) => TESTER_USERS.includes((name || '').toLowerCase());
// Resend API key for tester problem reports — set this in the environment, never in code.
// Env var name: RESEND_API (RESEND_API_KEY also accepted as a fallback).
const RESEND_API_KEY = process.env.RESEND_API || process.env.RESEND_API_KEY || '';
const FEEDBACK_TO = process.env.FEEDBACK_TO || 'maxvbuda@gmail.com';
// Email verification for NEW signups before they can post. OFF by default — only
// enable once a sending DOMAIN is verified in Resend (onboarding@resend.dev can't
// deliver to arbitrary users). Existing accounts are grandfathered (mustVerifyEmail
// stays false). Set REQUIRE_EMAIL_VERIFY=1 in the environment to turn it on.
const REQUIRE_EMAIL_VERIFY = process.env.REQUIRE_EMAIL_VERIFY === '1';
const BASE_URL = (process.env.BASE_URL || 'https://maxos-1oe3.onrender.com').replace(/\/+$/, '');
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SCREENWATCH_ROOM = username => `screenwatch:${username}`;
const SCREENWATCH_STALE_MS = 15000;
const SCREENWATCH_MAX_FRAME_LEN = 2_000_000;
const SCREENWATCH_MAX_APP_LEN = 80;
const latestScreenFrames = new Map(); // username -> { username, at, frame }
const io = new SocketIOServer(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

// ── Serve frontend ────────────────────────────────────────────────────────────
// The build step (build.js, run on prestart) splits os.html into dist/{index.html,
// app.js, styles.css} with the JS obfuscated — that's what we serve, so "View Source"
// only shows the tiny index.html. If the build hasn't run (dist missing), fall back
// to the single-file os.html so the site stays up no matter what.
const DIST = path.join(__dirname, 'dist');
const noStore = (res) => { res.set('Cache-Control', 'no-cache, no-store, must-revalidate'); res.set('Pragma', 'no-cache'); res.set('Expires', '0'); };
function sendOS(res) {
  noStore(res);
  const built = path.join(DIST, 'index.html');
  res.sendFile(fs.existsSync(built) ? built : path.join(__dirname, 'os.html'));
}
app.get('/', (req, res) => sendOS(res));
// Split assets (only exist when the build has run). no-store so a deploy is picked up.
app.get('/app.js', (req, res) => {
  const f = path.join(DIST, 'app.js');
  if (!fs.existsSync(f)) return res.status(404).end();
  noStore(res); res.type('application/javascript'); res.sendFile(f);
});
app.get('/styles.css', (req, res) => {
  const f = path.join(DIST, 'styles.css');
  if (!fs.existsSync(f)) return res.status(404).end();
  noStore(res); res.type('text/css'); res.sendFile(f);
});

// ── Desktop app downloads ─────────────────────────────────────────────────────
// The installers live on GitHub Releases (no size limit, no repo bloat). These
// routes keep the download links on our own domain and redirect to the latest
// release asset, so the URL never changes when the app version is bumped.
const DL_RELEASE = 'https://github.com/maxvbuda/maxos/releases/latest/download';
const DOWNLOADS = {
  mac:           `${DL_RELEASE}/MaxOS-mac.dmg`,       // universal: Apple Silicon + Intel
  windows:       `${DL_RELEASE}/MaxOS-Setup.exe`,     // NSIS installer (built by CI on a Windows runner)
  'windows-zip': `${DL_RELEASE}/MaxOS-windows.zip`,   // portable: unzip and run MaxOS.exe
};
app.get('/download/:platform', (req, res) => {
  const url = DOWNLOADS[String(req.params.platform).toLowerCase()];
  if (!url) return res.status(404).send('Unknown platform. Try /download/mac or /download/windows');
  res.redirect(302, url);
});

// ── Demo video (/demo) ────────────────────────────────────────────────────────
// A standalone landing page that plays a recorded guided tour of MaxOS. The video
// is recorded by the "Record demo video" GitHub workflow and committed to /media.
app.get(['/demo.mp4', '/demo.webm'], (req, res) => {
  const f = path.join(__dirname, 'media', path.basename(req.path));
  if (!fs.existsSync(f)) return res.status(404).end();
  res.sendFile(f); // sendFile handles Range requests so the video can seek/stream
});
const DEMO_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MaxOS — Demo</title>
<meta name="description" content="Watch a quick tour of MaxOS, a full desktop that runs in your browser.">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
         background:linear-gradient(135deg,#0d0d1a,#1a1a2e 55%,#0f3460); color:#eaf0ff;
         display:flex; flex-direction:column; align-items:center; justify-content:center; padding:32px 18px; gap:22px; }
  .logo { width:72px; height:72px; border-radius:18px; box-shadow:0 10px 40px rgba(30,80,180,.45); }
  h1 { margin:0; font-size:30px; font-weight:800; letter-spacing:-.5px; text-align:center; }
  p.tag { margin:0; color:rgba(234,240,255,.62); font-size:15px; text-align:center; max-width:560px; line-height:1.5; }
  .player { width:min(960px,100%); border-radius:16px; overflow:hidden; border:1px solid rgba(255,255,255,.1);
            box-shadow:0 24px 80px rgba(0,0,0,.55); background:#000; }
  video { display:block; width:100%; height:auto; }
  .cta { display:flex; gap:12px; flex-wrap:wrap; justify-content:center; margin-top:4px; }
  .btn { padding:12px 22px; border-radius:12px; font-size:14.5px; font-weight:600; text-decoration:none; transition:opacity .15s,transform .1s,background .15s; }
  .btn:active { transform:scale(.98); }
  .btn-primary { background:linear-gradient(135deg,#64b4ff,#bf5af2); color:#fff; }
  .btn-primary:hover { opacity:.9; }
  .btn-ghost { background:rgba(255,255,255,.06); border:1px solid rgba(255,255,255,.16); color:#dce7ff; }
  .btn-ghost:hover { background:rgba(100,180,255,.14); border-color:rgba(100,180,255,.4); }
  footer { color:rgba(255,255,255,.3); font-size:12px; margin-top:6px; }
</style>
</head>
<body>
  <img class="logo" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='0' y2='1'%3E%3Cstop offset='0' stop-color='%2364c4ff'/%3E%3Cstop offset='1' stop-color='%231f6fff'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='64' height='64' rx='14' fill='%23081226'/%3E%3Crect x='10' y='12' width='44' height='32' rx='6' fill='none' stroke='url(%23g)' stroke-width='3.5'/%3E%3Cpath d='M20 38 V22 L32 32 L44 22 V38' fill='none' stroke='url(%23g)' stroke-width='5' stroke-linejoin='round' stroke-linecap='round'/%3E%3Crect x='28' y='46' width='8' height='5' fill='url(%23g)'/%3E%3Crect x='22' y='51' width='20' height='3' rx='1.5' fill='url(%23g)'/%3E%3C/svg%3E" alt="MaxOS">
  <h1>MaxOS in action</h1>
  <p class="tag">A full desktop — files, apps, games and more — running entirely in your browser. Here's a quick tour.</p>
  <div class="player">
    <video controls autoplay muted loop playsinline preload="metadata">
      <source src="/demo.mp4" type="video/mp4">
      <source src="/demo.webm" type="video/webm">
      Your browser can't play this video. <a href="/demo.mp4">Download it</a>.
    </video>
  </div>
  <div class="cta">
    <a class="btn btn-primary" href="/">Open MaxOS</a>
    <a class="btn btn-ghost" href="/download/mac">Download the app</a>
  </div>
  <footer>MaxOS — your personal web desktop</footer>
</body>
</html>`;
app.get('/demo', (req, res) => { noStore(res); res.type('html').send(DEMO_HTML); });

// ── Offline mode: a service worker that caches the app shell ──────────────────
// Network-first for the page so online users always get the latest build, but it
// falls back to the last cached shell when there's no connection.
app.get('/sw.js', (req, res) => {
  res.set('Content-Type', 'application/javascript');
  res.set('Service-Worker-Allowed', '/');
  res.set('Cache-Control', 'no-cache');
  res.send(`
const CACHE = 'maxos-shell-v16';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(
  caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim())
));
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;        // leave cross-origin alone
  if (url.pathname.startsWith('/api/')) return;       // never cache the API
  const isShell = req.mode === 'navigate' || req.destination === 'document' || url.pathname === '/' || url.pathname === '/os.html';
  // The split build also needs app.js + styles.css cached so the shell still works offline.
  const isAsset = url.pathname === '/app.js' || url.pathname === '/styles.css';
  if (!isShell && !isAsset) return;
  const key = isShell ? '/' : url.pathname; // navigations all share the '/' shell entry
  e.respondWith(
    fetch(req)
      .then(resp => { const copy = resp.clone(); caches.open(CACHE).then(c => c.put(key, copy)); return resp; })
      .catch(() => caches.open(CACHE).then(c => c.match(key)).then(r => r || (isShell ? new Response('<h1>MaxOS is offline</h1><p>Open it once online to cache it.</p>', { headers: { 'Content-Type': 'text/html' } }) : undefined)))
  );
});`);
});

// ── Schemas ───────────────────────────────────────────────────────────────────
const UserSchema = new mongoose.Schema({
  username:    { type: String, required: true, unique: true, lowercase: true, trim: true },
  password:    { type: String, required: true },
  displayName: { type: String, default: '' },
  installed:   { type: [String], default: ['calc', 'music', 'snake', 'notes'] },
  appData:     { type: mongoose.Schema.Types.Mixed, default: {} }, // per-user KV store (MaxCoin wallet, etc.)
  suspended:   { type: Boolean, default: false },
  suspicious:  { type: Boolean, default: false },
  signupIP:    { type: String, default: '' }, // captured at registration (abuse moderation, superadmin-only)
  lastIP:      { type: String, default: '' }, // updated on each login
  email:           { type: String, default: '' },
  emailVerified:   { type: Boolean, default: false },
  mustVerifyEmail: { type: Boolean, default: false }, // true only for accounts created while email verification is required (existing accounts grandfathered)
  teacher:     { type: Boolean, default: false }, // appointed by an admin; only teachers can create classes
  admin:       { type: Boolean, default: false },
  adminRequest:   { type: Boolean, default: false }, // pending request to become admin (one at a time)
  teacherRequest: { type: Boolean, default: false }, // pending request to become teacher (one at a time)
  // Server-authoritative Minecraft playtime (NOT writable via /api/me/data) — tamperproof weekly cap.
  // bonus = extra seconds granted by the superadmin for the current week (on top of the base limit).
  mcPlay: { week: { type: String, default: '' }, used: { type: Number, default: 0 }, lastBeat: { type: Number, default: 0 }, bonus: { type: Number, default: 0 } },
  mcTimeRequest: { type: Boolean, default: false }, // pending "more Minecraft time" request to the superadmin
  testMode: { type: Boolean, default: false }, // testers only: unlimited Minecraft time while on
}, { timestamps: true });

const FileSchema = new mongoose.Schema({
  userId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  path:    { type: String, required: true },
  name:    { type: String, required: true },
  type:    { type: String, enum: ['file', 'directory'], required: true },
  content: { type: String, default: '' },
  parent:  { type: String, default: '' },
}, { timestamps: true });

FileSchema.index({ userId: 1, path: 1 }, { unique: true });

const MessageSchema = new mongoose.Schema({
  from:     { type: String, required: true },   // username
  to:       { type: String, required: true },   // username
  text:     { type: String, required: true },
  read:     { type: Boolean, default: false },
}, { timestamps: true });

const ChatSchema = new mongoose.Schema({
  channel: { type: String, required: true },    // e.g. "general"
  from:    { type: String, required: true },
  text:    { type: String, required: true },
}, { timestamps: true });
ChatSchema.index({ channel: 1, createdAt: 1 });

const PostSchema = new mongoose.Schema({
  author:   { type: String, required: true },
  text:     { type: String, required: true },
  authorIP: { type: String, default: '' },       // captured at post time (abuse moderation, superadmin-only)
  bg:       { type: Number, default: -1 },       // colored-status background index (-1 = plain)
  likes:    { type: [String], default: [] },     // usernames who liked
  comments: { type: [{ from: String, text: String, at: { type: Date, default: Date.now } }], default: [] },
}, { timestamps: true });
PostSchema.index({ createdAt: -1 });

const ChannelSchema = new mongoose.Schema({
  name:      { type: String, required: true, unique: true, lowercase: true, trim: true },
  createdBy: { type: String, default: '' },
}, { timestamps: true });
MessageSchema.index({ from: 1, to: 1, createdAt: 1 });

const AppSchema = new mongoose.Schema({
  id:         { type: String, required: true, unique: true }, // url slug
  title:      { type: String, required: true },
  icon:       { type: String, default: '🧩' },
  html:       { type: String, default: '' },
  css:        { type: String, default: '' },
  js:         { type: String, default: '' },   // source (JS or MaxScript)
  lang:       { type: String, enum: ['js', 'maxscript'], default: 'js' },
  authorId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  authorName: { type: String, required: true },
  installs:   { type: Number, default: 0 },
}, { timestamps: true });

const VersionSchema = new mongoose.Schema({
  userId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  path:    { type: String, required: true },
  content: { type: String, default: '' },
  auto:    { type: Boolean, default: false },
}, { timestamps: true });
VersionSchema.index({ userId: 1, path: 1, createdAt: -1 });

const SharedSchema = new mongoose.Schema({
  id:         { type: String, required: true, unique: true }, // share slug
  type:       { type: String, enum: ['form', 'sheet', 'doc'], required: true },
  title:      { type: String, default: 'Untitled' },
  content:    { type: String, default: '' }, // form JSON or sheet CSV
  authorId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  authorName: { type: String, required: true },
  views:      { type: Number, default: 0 },
  visibility: { type: String, enum: ['public', 'private'], default: 'public' }, // public = anyone w/ link; private = owner + allow list
  allow:      { type: [String], default: [] }, // lowercased usernames allowed to view when private
}, { timestamps: true });

const ResponseSchema = new mongoose.Schema({
  sharedId:   { type: String, required: true },
  answers:    { type: Array, default: [] },
  byName:     { type: String, default: 'anonymous' },
}, { timestamps: true });
ResponseSchema.index({ sharedId: 1, createdAt: -1 });

// School mode: a class with a teacher, students, and the apps students may open
const ClassSchema = new mongoose.Schema({
  name:        { type: String, required: true },
  code:        { type: String, required: true, unique: true, uppercase: true }, // join code
  teacher:     { type: String, required: true }, // username
  students:    { type: [String], default: [] },  // usernames
  allowedApps: { type: [String], default: [] },  // app ids students are allowed to open
  flags:       { type: [{ student: String, snippet: String, at: { type: Date, default: Date.now } }], default: [] }, // safety alerts for the teacher
}, { timestamps: true });

const User    = mongoose.model('User', UserSchema);
const File    = mongoose.model('File', FileSchema);
const Message = mongoose.model('Message', MessageSchema);
const Chat    = mongoose.model('Chat', ChatSchema);
const Post    = mongoose.model('Post', PostSchema);
const Channel = mongoose.model('Channel', ChannelSchema);
const AppModel = mongoose.model('App', AppSchema);
const FileVersion = mongoose.model('FileVersion', VersionSchema);
const Shared = mongoose.model('Shared', SharedSchema);
const Response = mongoose.model('Response', ResponseSchema);
const Klass = mongoose.model('Class', ClassSchema);
const ReportSchema = new mongoose.Schema({
  postId:   { type: String, required: true },
  author:   { type: String, default: '' },   // who wrote the reported post
  text:     { type: String, default: '' },    // snapshot of the post text
  reporter: { type: String, required: true },  // who reported it
  reason:   { type: String, default: '' },
  handled:  { type: Boolean, default: false }, // cleared when an admin acts on it
}, { timestamps: true });
const Report = mongoose.model('Report', ReportSchema);

const serializeClass = (c, forTeacher) => ({ id: c._id.toString(), name: c.name, code: c.code, teacher: c.teacher, students: c.students || [], allowedApps: c.allowedApps || [], ...(forTeacher ? { flags: (c.flags || []).slice(-30).reverse() } : {}) });
// A user's school state: classes they teach, the class they're a student in, and
// the resulting restrictions. A teacher is never restricted.
async function getSchoolState(username) {
  username = (username || '').toLowerCase();
  const teaching = await Klass.find({ teacher: username }).lean();
  const enrolled = await Klass.findOne({ students: username }).lean();
  const restricted = !!enrolled && teaching.length === 0;
  return {
    teaching: teaching.map(c => serializeClass(c, true)), // teachers see safety flags
    enrolled: enrolled ? serializeClass(enrolled, false) : null,
    restricted,
    allowedApps: enrolled ? (enrolled.allowedApps || []) : [],
    teachers: enrolled ? [enrolled.teacher] : [],
  };
}

// `allow` (the viewer list) is only revealed to the owner, never to plain viewers
const serializeShared = (d, isOwner) => ({ id: d.id, type: d.type, title: d.title, content: d.content, author: d.authorName, views: d.views, visibility: d.visibility || 'public', ...(isOwner ? { allow: d.allow || [] } : {}) });
const normUsers = a => Array.isArray(a) ? [...new Set(a.map(u => String(u).trim().toLowerCase().replace(/^@/, '')).filter(Boolean))] : [];

// ── MaxSocial anti-spam / moderation ──────────────────────────────────────────
const POST_BAD = /\b(f+u+c+k|sh[i1!]t|b[i1]tch|assh[o0]le|bastard|cunt|wh[o0]re|fag|n[i1]gg(a|er)|retard|porn|nsfw)\b/i;
const POST_LINK = /(https?:\/\/|www\.[a-z0-9]|[a-z0-9-]+\.(com|net|org|xyz|io|ru|info)\b)/i;
const POST_SPAMMY = /(.)\1{9,}/; // 10+ of the same char in a row
const lastPostByUser = new Map(); // username -> last text (block instant duplicates)
function moderatePost(text, username) {
  const t = (text || '').trim();
  if (!t) return 'Say something!';
  if (POST_BAD.test(t)) return 'Please keep it friendly — that post was blocked.';
  if (POST_LINK.test(t)) return "Links aren't allowed in posts.";
  if (POST_SPAMMY.test(t)) return 'That looks like spam.';
  if (lastPostByUser.get(username) === t) return 'You just posted that — try something new.';
  return null;
}

// Persistent duplicate detection (DB-backed, survives restarts). Blocks the same
// text reposted by the same user (30 min) or copy-pasted by anyone (10 min) —
// the pattern a spam bot uses. Feed volume is small, so scanning recent posts is cheap.
const normText = (s) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
async function duplicatePostMsg(text, username) {
  const nt = normText(text);
  if (nt.length < 6) return null; // too short to meaningfully dedupe
  const since = new Date(Date.now() - 30 * 60 * 1000);
  const recent = await Post.find({ createdAt: { $gte: since } })
    .select('text author createdAt').sort({ createdAt: -1 }).limit(150).lean();
  for (const p of recent) {
    if (normText(p.text) !== nt) continue;
    if (p.author === username) return 'You already posted that — try something new.';
    if (Date.now() - new Date(p.createdAt).getTime() < 10 * 60 * 1000) return 'That post was just shared by someone else.';
  }
  return null;
}

// Auto-suspend repeat offenders: count consecutive blocked posts per account; a
// human won't trip the filters 5× in a row, but a bot hammering the endpoint will.
// Admins are never auto-suspended. Strikes reset on a successful post.
const spamStrikes = new Map(); // username -> { n, t }
const SPAM_SUSPEND_AT = 5;
async function recordSpamStrike(username) {
  if (ADMIN_USERS.includes(username)) return false;
  const now = Date.now();
  const s = spamStrikes.get(username);
  const n = (s && now - s.t < 3 * 60 * 1000) ? s.n + 1 : 1; // strikes must be within 3 min of each other
  spamStrikes.set(username, { n, t: now });
  if (n >= SPAM_SUSPEND_AT) {
    spamStrikes.delete(username);
    await User.updateOne({ username }, { suspended: true }).catch(() => {});
    console.warn(`[anti-spam] auto-suspended "${username}" after ${n} blocked posts in a row`);
    return true;
  }
  return false;
}
const clearSpamStrikes = (username) => spamStrikes.delete(username);

const serializeApp = d => ({ id: d.id, title: d.title, icon: d.icon, html: d.html, css: d.css, js: d.js, lang: d.lang, author: d.authorName, installs: d.installs, updatedAt: d.updatedAt });
const slugify = t => ((t || 'app').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24) || 'app');
async function uniqueSlug(base) { let id = base, n = 1; while (await AppModel.findOne({ id })) id = base + (++n); return id; }

// ── Seed user filesystem ──────────────────────────────────────────────────────
async function seedUser(userId, username) {
  const count = await File.countDocuments({ userId });
  if (count > 0) return;
  const h = `/home/${username}`;
  await File.insertMany([
    { userId, path: '/',                  name: '/',          type: 'directory', parent: '' },
    { userId, path: '/home',              name: 'home',       type: 'directory', parent: '/' },
    { userId, path: h,                    name: username,     type: 'directory', parent: '/home' },
    { userId, path: `${h}/documents`,     name: 'documents',  type: 'directory', parent: h },
    { userId, path: `${h}/pictures`,      name: 'pictures',   type: 'directory', parent: h },
    { userId, path: `${h}/Shared with me`, name: 'Shared with me', type: 'directory', parent: h },
    { userId, path: `${h}/readme.txt`,    name: 'readme.txt', type: 'file',      parent: h,
      content: 'Welcome to MaxOS!\nYour personal files are stored here in MongoDB.' },
    { userId, path: `${h}/notes.md`,      name: 'notes.md',   type: 'file',      parent: h,
      content: '# My Notes\n- Start writing here\n- Files persist across sessions' },
    { userId, path: `${h}/documents/ideas.md`, name: 'ideas.md', type: 'file',   parent: `${h}/documents`,
      content: '# Ideas\n- Build something great' },
  ]);
}

// ── Auth middleware (verifies the account still exists & isn't suspended) ─────
async function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  let payload;
  try { payload = jwt.verify(token, JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Invalid or expired token' }); }
  // A signed token isn't enough — the account must still exist in MongoDB
  const user = await User.findById(payload.id);
  if (!user) return res.status(401).json({ error: 'Account no longer exists' });
  if (user.suspended) return res.status(403).json({ error: 'Account suspended' });
  req.user = { id: user._id.toString(), username: user.username, displayName: user.displayName, admin: user.admin, teacher: !!user.teacher };
  next();
}
function adminOnly(req, res, next) {
  if (!req.user.admin) return res.status(403).json({ error: 'Admins only' });
  next();
}
// Regular admins can only view the user list and suspend. Everything more powerful
// (appointing teachers/admins, flagging, screen-watch, deleting, reports) is superadmin-only.
function superadminOnly(req, res, next) {
  if (!ADMIN_USERS.includes(req.user.username)) return res.status(403).json({ error: 'Superadmin only' });
  next();
}
// Like auth, but never rejects — sets req.user only when a valid, active token is present
async function optionalAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const user = await User.findById(payload.id);
      if (user && !user.suspended) req.user = { id: user._id.toString(), username: user.username, displayName: user.displayName, admin: user.admin };
    } catch { /* ignore — treat as anonymous */ }
  }
  next();
}

async function socketAuthUser(token) {
  if (!token) return null;
  let payload;
  try { payload = jwt.verify(token, JWT_SECRET); }
  catch { return null; }
  const user = await User.findById(payload.id).select('username displayName suspended admin suspicious');
  if (!user || user.suspended) return null;
  return { id: user._id.toString(), username: user.username, displayName: user.displayName, admin: user.admin, suspicious: user.suspicious };
}

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.split(' ')[1] || '';
    const user = await socketAuthUser(token);
    if (!user) return next(new Error('Not authenticated'));
    socket.data.user = user;
    next();
  } catch (e) { next(new Error('Not authenticated')); }
});

io.on('connection', socket => {
  // Real-time rooms: a personal room for DMs/unread, plus the shared feed.
  const me = socket.data.user;
  if (me?.username) socket.join('user:' + me.username);
  socket.join('feed');
  socket.on('chat:join', ch => {
    if (typeof ch !== 'string') return;
    if (socket.data.chatRoom) socket.leave(socket.data.chatRoom);
    socket.data.chatRoom = 'chan:' + ch.toLowerCase();
    socket.join(socket.data.chatRoom);
  });

  socket.on('screenwatch:subscribe', async payload => {
    try {
      const watcher = socket.data.user;
      if (!watcher?.admin) return socket.emit('screenwatch:error', { error: 'Admins only' });
      const username = String(payload?.username || '').trim().toLowerCase();
      if (!username) return socket.emit('screenwatch:error', { error: 'Missing username' });
      const target = await User.findOne({ username }).select('username suspicious');
      if (!target) return socket.emit('screenwatch:error', { error: 'User not found' });
      if (!target.suspicious) return socket.emit('screenwatch:error', { error: 'User is not marked suspicious' });
      if (socket.data.watchRoom) socket.leave(socket.data.watchRoom);
      const room = SCREENWATCH_ROOM(username);
      socket.join(room);
      socket.data.watchRoom = room;
      socket.data.watchUser = username;
      const latest = latestScreenFrames.get(username);
      if (latest) socket.emit('screenwatch:frame', latest);
      socket.emit('screenwatch:subscribed', { username });
    } catch (e) {
      socket.emit('screenwatch:error', { error: 'Unable to subscribe watcher' });
    }
  });

  socket.on('screenwatch:unsubscribe', () => {
    if (socket.data.watchRoom) socket.leave(socket.data.watchRoom);
    socket.data.watchRoom = null;
    socket.data.watchUser = null;
  });

  socket.on('screenwatch:frame', async payload => {
    try {
      const source = socket.data.user;
      if (!source) return;
      // Re-check suspicious status so admins can revoke watch streaming immediately.
      const dbUser = await User.findById(source.id).select('username suspicious suspended');
      if (!dbUser || dbUser.suspended || !dbUser.suspicious) return;
      const frame = typeof payload?.frame === 'string' ? payload.frame : '';
      if (!frame.startsWith('data:image/') || frame.length > SCREENWATCH_MAX_FRAME_LEN) return;
      const appId = typeof payload?.appId === 'string' ? payload.appId.slice(0, 40) : '';
      const appTitle = typeof payload?.appTitle === 'string' ? payload.appTitle.slice(0, SCREENWATCH_MAX_APP_LEN) : '';
      const packet = { username: dbUser.username, at: Date.now(), frame, appId, appTitle };
      latestScreenFrames.set(dbUser.username, packet);
      io.to(SCREENWATCH_ROOM(dbUser.username)).emit('screenwatch:frame', packet);
    } catch {
      socket.emit('screenwatch:error', { error: 'Unable to publish frame' });
    }
  });

  socket.on('disconnect', () => {
    socket.data.watchRoom = null;
    socket.data.watchUser = null;
  });
});

// ── Auth routes ───────────────────────────────────────────────────────────────
// Hand out a proof-of-work challenge for sign-up
app.get('/api/auth/challenge', (req, res) => {
  if (!rateLimit('chal:' + req.ip, 80, 10 * 60 * 1000)) return res.status(429).json({ error: 'Slow down' });
  const salt = crypto.randomBytes(8).toString('hex');
  const exp = Date.now() + POW_TTL;
  res.json({ salt, exp, sig: powSig(salt, exp), difficulty: POW_DIFFICULTY });
});

// Send a verification email with a stateless signed link. Best-effort: returns
// false (never throws) if email isn't configured or Resend rejects it.
async function sendVerifyEmail(user) {
  if (!RESEND_API_KEY || !user.email) return false;
  const token = jwt.sign({ purpose: 'verify-email', uid: user._id.toString() }, JWT_SECRET, { expiresIn: '3d' });
  const link = `${BASE_URL}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
  const name = String(user.displayName || user.username).replace(/[<>]/g, '');
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'MaxOS <onboarding@resend.dev>',
        to: [user.email],
        subject: 'Verify your MaxOS email',
        html: `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:480px">
          <h2>Welcome to MaxOS, ${name}!</h2>
          <p>Confirm your email to start posting on MaxSocial.</p>
          <p><a href="${link}" style="display:inline-block;padding:11px 20px;background:#3b82f6;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Verify my email</a></p>
          <p style="color:#888;font-size:12px">Or paste this link into your browser:<br>${link}</p>
          <p style="color:#aaa;font-size:12px">This link expires in 3 days.</p>
        </div>`,
      }),
    });
    return r.ok;
  } catch { return false; }
}

// Public config the login screen needs (e.g. whether to collect an email at signup).
app.get('/api/config', (req, res) => res.json({ emailRequired: REQUIRE_EMAIL_VERIFY }));

// Verify-email landing page (opened from the email link in a browser).
app.get('/api/auth/verify-email', async (req, res) => {
  const page = (icon, title, msg) => `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:-apple-system,Segoe UI,sans-serif;background:linear-gradient(135deg,#0d0d1a,#1a1a2e,#0f3460);color:#eaf0ff;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;text-align:center"><div><div style="font-size:54px">${icon}</div><h2 style="margin:8px 0">${title}</h2><p style="color:#9aa6c0">${msg}</p><a href="/" style="display:inline-block;margin-top:16px;padding:11px 22px;background:linear-gradient(135deg,#64b4ff,#bf5af2);color:#fff;border-radius:11px;text-decoration:none;font-weight:600">Open MaxOS</a></div></body>`;
  try {
    const payload = jwt.verify(String(req.query.token || ''), JWT_SECRET);
    if (payload.purpose !== 'verify-email') throw new Error('bad purpose');
    await User.updateOne({ _id: payload.uid }, { emailVerified: true });
    res.type('html').send(page('✅', 'Email verified!', 'You can now post on MaxSocial.'));
  } catch {
    res.status(400).type('html').send(page('⚠️', 'Link expired or invalid', 'Sign in to MaxOS and resend the verification email.'));
  }
});

// Resend the verification email to the signed-in user.
app.post('/api/auth/resend-verification', auth, async (req, res) => {
  try {
    if (!rateLimit('resend:' + req.user.username, 4, 10 * 60 * 1000)) return res.status(429).json({ error: 'Please wait a bit before requesting another email.' });
    const u = await User.findById(req.user.id);
    if (!u || u.emailVerified || !u.email) return res.json({ ok: true });
    const sent = await sendVerifyEmail(u);
    res.json({ ok: true, sent });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password, displayName, hp, pow, email } = req.body;
    // ── Bot guards ──
    // 1) Honeypot: a hidden form field real users never fill. Bots auto-fill it.
    if (hp) return res.status(400).json({ error: 'Signup blocked' });
    // 2) Proof-of-work: the browser must have solved our challenge (server-verified,
    //    so direct-API bots can't skip it like they can the client human-check).
    if (!powValid(pow)) return res.status(400).json({ error: 'Verification failed — please reload and try again.' });
    // 3) Rate limit signups per IP — lenient so a whole classroom (shared IP) can
    //    register, but a runaway bot making hundreds gets stopped.
    if (!rateLimit('reg:' + req.ip, 20, 10 * 60 * 1000)) return res.status(429).json({ error: 'Too many sign-ups from this network. Try again in a bit.' });
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    // 3) Basic username sanity — letters/numbers/_/- only, 3–24 chars
    if (!/^[a-z0-9_-]{3,24}$/i.test(username)) return res.status(400).json({ error: 'Username must be 3–24 letters, numbers, _ or -' });
    if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
    // Email verification gate (when enabled): require a valid email for new accounts.
    let cleanEmail = '';
    if (REQUIRE_EMAIL_VERIFY) {
      cleanEmail = String(email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(cleanEmail)) return res.status(400).json({ error: 'A valid email is required to sign up.' });
    }
    const exists = await User.findOne({ username: username.toLowerCase() });
    if (exists) return res.status(409).json({ error: 'Username already taken' });
    const hashed = await bcrypt.hash(password, 10);
    // First registered user (or a baked-in / ADMIN_USERS name) becomes an admin
    const isAdmin = (await User.countDocuments()) === 0 || ADMIN_USERS.includes(username.toLowerCase());
    const user = await User.create({ username, password: hashed, displayName: displayName || username, admin: isAdmin, signupIP: req.ip, lastIP: req.ip, email: cleanEmail, mustVerifyEmail: REQUIRE_EMAIL_VERIFY });
    await seedUser(user._id, user.username);
    if (REQUIRE_EMAIL_VERIFY) sendVerifyEmail(user).catch(() => {}); // best-effort; account still created
    const token = jwt.sign({ id: user._id, username: user.username, displayName: user.displayName }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: user.username, displayName: user.displayName, admin: user.admin, teacher: user.teacher, adminRequest: user.adminRequest, teacherRequest: user.teacherRequest, suspicious: user.suspicious, installed: user.installed, superadmin: ADMIN_USERS.includes(user.username), tester: isTester(user.username), testMode: !!user.testMode, emailVerified: user.emailVerified, mustVerifyEmail: user.mustVerifyEmail });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const user = await User.findOne({ username: username.toLowerCase() });
    if (!user) return res.status(401).json({ error: 'Invalid username or password' });
    if (user.suspended) return res.status(403).json({ error: 'This account has been suspended' });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Invalid username or password' });
    if (user.lastIP !== req.ip) { user.lastIP = req.ip; await user.save().catch(() => {}); }
    await seedUser(user._id, user.username);
    await ensureSharedFolder(user._id, user.username); // retroactive for accounts predating the folder
    const token = jwt.sign({ id: user._id, username: user.username, displayName: user.displayName }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: user.username, displayName: user.displayName, admin: user.admin, teacher: user.teacher, adminRequest: user.adminRequest, teacherRequest: user.teacherRequest, suspicious: user.suspicious, installed: user.installed, superadmin: ADMIN_USERS.includes(user.username), tester: isTester(user.username), testMode: !!user.testMode, emailVerified: user.emailVerified, mustVerifyEmail: user.mustVerifyEmail });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/auth/me', auth, async (req, res) => {
  const u = await User.findById(req.user.id).select('username displayName admin teacher adminRequest teacherRequest suspicious installed testMode emailVerified mustVerifyEmail');
  await ensureSharedFolder(u._id, u.username); // retroactive for accounts predating the folder
  res.json({ username: u.username, displayName: u.displayName, admin: u.admin, teacher: u.teacher, adminRequest: u.adminRequest, teacherRequest: u.teacherRequest, suspicious: u.suspicious, installed: u.installed, superadmin: ADMIN_USERS.includes(u.username), tester: isTester(u.username), testMode: !!u.testMode, emailVerified: u.emailVerified, mustVerifyEmail: u.mustVerifyEmail });
});

// Request to become a teacher or admin — one pending request per role (anti-spam)
app.post('/api/requests/:role', auth, async (req, res) => {
  try {
    const role = req.params.role;
    if (role !== 'admin' && role !== 'teacher') return res.status(400).json({ error: 'Bad role' });
    const u = await User.findById(req.user.id);
    if (u[role]) return res.status(400).json({ error: `You are already a ${role}.` });
    const field = role + 'Request';
    if (u[field]) return res.status(400).json({ error: 'You already have a pending request.' });
    u[field] = true; await u.save();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Persist the user's installed apps (so it's not just a browser token)
app.put('/api/me/installed', auth, async (req, res) => {
  try { await User.updateOne({ _id: req.user.id }, { installed: Array.isArray(req.body.installed) ? req.body.installed : [] }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Per-user app data (KV store in Mongo): MaxCoin wallet, app prefs, etc. ────
app.get('/api/me/data/:key', auth, async (req, res) => {
  try { const u = await User.findById(req.user.id).select('appData'); res.json({ value: (u.appData || {})[req.params.key] ?? null }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/me/data/:key', auth, async (req, res) => {
  try {
    // Mixed paths need an explicit $set on the dotted key
    await User.updateOne({ _id: req.user.id }, { $set: { ['appData.' + req.params.key]: req.body.value } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Minecraft weekly play limit — server-authoritative & tamperproof ─────────────
// Time is tracked here with the server's own clock; the client cannot write or reset
// it. 15 minutes per ISO week; superadmins are exempt.
const MC_WEEK_LIMIT = 15 * 60;       // seconds
const MC_MAX_GAP = 20;               // cap seconds credited per heartbeat (handles tab throttling / gaps)
function mcWeekKey(d = new Date()) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7) + 3); // nearest Thursday
  const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((t - firstThu) / 864e5 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return t.getUTCFullYear() + '-W' + week;
}
// Read state, rolling over to a fresh week if needed (does not persist on its own).
// A new week resets used AND any superadmin-granted bonus.
function mcReadWeek(u) {
  const wk = mcWeekKey();
  const p = u.mcPlay || {};
  return (p.week === wk) ? { week: wk, used: p.used || 0, lastBeat: p.lastBeat || 0, bonus: p.bonus || 0 }
                         : { week: wk, used: 0, lastBeat: 0, bonus: 0 };
}
const mcLimitFor = (p) => MC_WEEK_LIMIT + (p.bonus || 0); // base + granted bonus
// Unlimited time for superadmins, and for testers while test mode is on.
const mcExempt = (username, u) => ADMIN_USERS.includes(username) || (isTester(username) && !!(u && u.testMode));
// Status only — never increments. Used to gate opening the app.
app.get('/api/minecraft/status', auth, async (req, res) => {
  try {
    const u = await User.findById(req.user.id).select('mcPlay mcTimeRequest testMode');
    if (mcExempt(req.user.username, u)) return res.json({ unlimited: true, remaining: MC_WEEK_LIMIT, limit: MC_WEEK_LIMIT });
    const p = mcReadWeek(u);
    const lim = mcLimitFor(p);
    res.json({ remaining: Math.max(0, lim - p.used), limit: lim, requested: !!u.mcTimeRequest });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Heartbeat — credits real elapsed time (server clock, capped) and enforces the cap.
app.post('/api/minecraft/heartbeat', auth, async (req, res) => {
  try {
    const u = await User.findById(req.user.id).select('mcPlay testMode');
    if (mcExempt(req.user.username, u)) return res.json({ ok: true, unlimited: true, remaining: MC_WEEK_LIMIT });
    const p = mcReadWeek(u);
    const now = Date.now();
    // Credit only continuous play: a gap within MC_MAX_GAP means beats are still
    // flowing (~every 10s). A larger gap = new session / was away → credit nothing,
    // so opening the game doesn't cost time for the break since last play.
    const gap = p.lastBeat ? Math.round((now - p.lastBeat) / 1000) : 0;
    if (gap > 0 && gap <= MC_MAX_GAP) p.used += gap;
    p.lastBeat = now;
    await User.updateOne({ _id: req.user.id }, { $set: { mcPlay: p } });
    const lim = mcLimitFor(p);
    const remaining = Math.max(0, lim - p.used);
    res.json({ ok: remaining > 0, remaining, limit: lim });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// A kid out of time asks the superadmin for more (one pending request at a time).
app.post('/api/minecraft/request-more', auth, async (req, res) => {
  try {
    if (ADMIN_USERS.includes(req.user.username)) return res.json({ ok: true }); // superadmin never needs to ask
    await User.updateOne({ _id: req.user.id }, { $set: { mcTimeRequest: true } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Tester tools ────────────────────────────────────────────────────────────────
function testerOnly(req, res, next) {
  if (!isTester(req.user.username)) return res.status(403).json({ error: 'Testers only' });
  next();
}
// Toggle test mode (unlimited Minecraft time while on).
// Test mode (unlimited Minecraft time for a tester) can ONLY be flipped by a
// superadmin — testers can't toggle their own.
app.post('/api/admin/users/:username/testmode', auth, superadminOnly, async (req, res) => {
  try {
    const name = String(req.params.username || '').toLowerCase();
    if (!isTester(name)) return res.status(400).json({ error: 'That account is not a tester.' });
    const u = await User.findOne({ username: name });
    if (!u) return res.status(404).json({ error: 'User not found' });
    u.testMode = !u.testMode; await u.save();
    io.to('user:' + name).emit('testmode', { testMode: u.testMode }); // push live to the tester
    res.json({ ok: true, testMode: u.testMode });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// File a problem report → emailed to the owner via Resend. Testers only (keeps the
// email endpoint from being abused as a spam relay).
app.post('/api/feedback', auth, testerOnly, async (req, res) => {
  try {
    const text = (req.body.text || '').toString().trim().slice(0, 4000);
    if (!text) return res.status(400).json({ error: 'Describe the problem first.' });
    if (!RESEND_API_KEY) return res.status(500).json({ error: 'Email is not configured (RESEND_API_KEY not set).' });
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'MaxOS Tester <onboarding@resend.dev>',
        to: [FEEDBACK_TO],
        reply_to: FEEDBACK_TO,
        subject: `MaxOS problem report from @${req.user.username}`,
        text: `Reported by: @${req.user.username} (${req.user.displayName || ''})\nWhen: ${new Date().toISOString()}\n\n${text}`,
      }),
    });
    if (!r.ok) { const body = await r.text().catch(() => ''); return res.status(502).json({ error: 'Email failed to send.', detail: body.slice(0, 300) }); }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin routes ──────────────────────────────────────────────────────────────
app.get('/api/admin/users', auth, adminOnly, async (req, res) => {
  try {
    const showIP = ADMIN_USERS.includes(req.user.username); // IPs are superadmin-only
    const users = await User.find().select('username displayName suspended suspicious admin teacher adminRequest teacherRequest mcTimeRequest createdAt signupIP lastIP testMode').sort({ createdAt: 1 });
    res.json(users.map(u => ({
      username: u.username, displayName: u.displayName, suspended: u.suspended, suspicious: u.suspicious,
      admin: u.admin, teacher: u.teacher, adminRequest: u.adminRequest, teacherRequest: u.teacherRequest,
      mcTimeRequest: u.mcTimeRequest, superadmin: ADMIN_USERS.includes(u.username), createdAt: u.createdAt,
      tester: isTester(u.username), testMode: !!u.testMode,
      ...(showIP ? { signupIP: u.signupIP || '', lastIP: u.lastIP || '' } : {}),
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Superadmin appoints (or removes) a teacher; also clears any pending teacher request
app.post('/api/admin/users/:username/teacher', auth, superadminOnly, async (req, res) => {
  try {
    const u = await User.findOne({ username: req.params.username.toLowerCase() });
    if (!u) return res.status(404).json({ error: 'User not found' });
    u.teacher = !u.teacher; u.teacherRequest = false; await u.save();
    res.json({ ok: true, teacher: u.teacher });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Superadmin makes (or removes) an admin; also clears any pending admin request
app.post('/api/admin/users/:username/admin', auth, superadminOnly, async (req, res) => {
  try {
    const name = req.params.username.toLowerCase();
    if (ADMIN_USERS.includes(name)) return res.status(400).json({ error: 'That account is a permanent superadmin' });
    if (name === req.user.username) return res.status(400).json({ error: 'You cannot change your own admin status' });
    const u = await User.findOne({ username: name });
    if (!u) return res.status(404).json({ error: 'User not found' });
    u.admin = !u.admin; u.adminRequest = false; await u.save();
    res.json({ ok: true, admin: u.admin });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Deny a pending role request without granting it
app.post('/api/admin/users/:username/deny/:role', auth, superadminOnly, async (req, res) => {
  try {
    const role = req.params.role;
    if (role !== 'admin' && role !== 'teacher') return res.status(400).json({ error: 'Bad role' });
    const u = await User.findOne({ username: req.params.username.toLowerCase() });
    if (!u) return res.status(404).json({ error: 'User not found' });
    u[role + 'Request'] = false; await u.save();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/users/:username/suspend', auth, adminOnly, async (req, res) => {
  try {
    const u = await User.findOne({ username: req.params.username.toLowerCase() });
    if (!u) return res.status(404).json({ error: 'User not found' });
    if (u.username === req.user.username) return res.status(400).json({ error: 'You cannot suspend yourself' });
    if (ADMIN_USERS.includes(u.username)) return res.status(403).json({ error: 'The superadmin cannot be suspended' });
    u.suspended = !u.suspended; await u.save();
    res.json({ ok: true, suspended: u.suspended });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Superadmin grants more Minecraft time for the current week (default +15 min) and clears the request.
app.post('/api/admin/users/:username/grant-time', auth, superadminOnly, async (req, res) => {
  try {
    const u = await User.findOne({ username: req.params.username.toLowerCase() });
    if (!u) return res.status(404).json({ error: 'User not found' });
    const mins = Math.min(120, Math.max(1, parseInt(req.body.minutes, 10) || 15));
    const p = mcReadWeek(u); // rolls to current week (resets stale used/bonus first)
    p.bonus = (p.bonus || 0) + mins * 60;
    await User.updateOne({ _id: u._id }, { $set: { mcPlay: p, mcTimeRequest: false } });
    res.json({ ok: true, addedMinutes: mins });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/users/:username/suspicious', auth, superadminOnly, async (req, res) => {
  try {
    const u = await User.findOne({ username: req.params.username.toLowerCase() });
    if (!u) return res.status(404).json({ error: 'User not found' });
    if (u.username === req.user.username) return res.status(400).json({ error: 'You cannot flag yourself' });
    u.suspicious = !u.suspicious;
    if (!u.suspicious) {
      latestScreenFrames.delete(u.username);
      io.to(SCREENWATCH_ROOM(u.username)).emit('screenwatch:ended', { username: u.username });
    }
    await u.save();
    res.json({ ok: true, suspicious: u.suspicious });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/users/:username/screen', auth, superadminOnly, async (req, res) => {
  try {
    const u = await User.findOne({ username: req.params.username.toLowerCase() }).select('username displayName suspicious');
    if (!u) return res.status(404).json({ error: 'User not found' });
    const sw = latestScreenFrames.get(u.username) || null;
    const at = sw?.at ? Number(sw.at) : 0;
    const stale = !at || (Date.now() - at > SCREENWATCH_STALE_MS);
    res.json({
      username: u.username,
      displayName: u.displayName,
      suspicious: !!u.suspicious,
      at,
      stale,
      frame: stale ? '' : (sw?.frame || ''),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/users/:username', auth, superadminOnly, async (req, res) => {
  try {
    const uname = req.params.username.toLowerCase();
    if (uname === req.user.username) return res.status(400).json({ error: 'You cannot delete yourself' });
    if (ADMIN_USERS.includes(uname)) return res.status(403).json({ error: 'The superadmin cannot be deleted' });
    const u = await User.findOne({ username: uname });
    if (!u) return res.status(404).json({ error: 'User not found' });
    latestScreenFrames.delete(u.username);
    io.to(SCREENWATCH_ROOM(u.username)).emit('screenwatch:ended', { username: u.username });
    await u.deleteOne();
    await File.deleteMany({ userId: u._id });
    await FileVersion.deleteMany({ userId: u._id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Messaging routes ──────────────────────────────────────────────────────────
// List all other users (to start a chat with)
app.get('/api/users', auth, async (req, res) => {
  try {
    const users = await User.find({ username: { $ne: req.user.username } })
      .select('username displayName -_id').sort({ username: 1 });
    res.json(users);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Conversation list with last message + unread counts
app.get('/api/conversations', auth, async (req, res) => {
  try {
    const me = req.user.username;
    const msgs = await Message.find({ $or: [{ from: me }, { to: me }] }).sort({ createdAt: -1 });
    const convos = {};
    for (const m of msgs) {
      const other = m.from === me ? m.to : m.from;
      if (!convos[other]) convos[other] = { user: other, lastText: m.text, lastAt: m.createdAt, unread: 0 };
      if (m.to === me && !m.read) convos[other].unread++;
    }
    res.json(Object.values(convos));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get conversation with a specific user (marks incoming as read)
app.get('/api/messages', auth, async (req, res) => {
  try {
    const me = req.user.username, other = req.query.with;
    if (!other) return res.status(400).json({ error: 'Missing "with" param' });
    const msgs = await Message.find({
      $or: [{ from: me, to: other }, { from: other, to: me }],
    }).sort({ createdAt: 1 }).limit(200);
    await Message.updateMany({ from: other, to: me, read: false }, { read: true });
    res.json(msgs.map(m => ({ id: m._id, from: m.from, to: m.to, text: m.text, at: m.createdAt })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete a message (sender only)
app.delete('/api/messages/:id', auth, async (req, res) => {
  try {
    const msg = await Message.findById(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    if (msg.from !== req.user.username) return res.status(403).json({ error: 'You can only delete your own messages' });
    await msg.deleteOne();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Send a message
app.post('/api/messages', auth, async (req, res) => {
  try {
    const { to, text } = req.body;
    if (!to || !text?.trim()) return res.status(400).json({ error: 'Recipient and text required' });
    const recipient = await User.findOne({ username: to.toLowerCase() });
    if (!recipient) return res.status(404).json({ error: 'User not found' });
    // School mode: students may only message their class teacher
    const ss = await getSchoolState(req.user.username);
    if (ss.restricted && !ss.teachers.includes(to.toLowerCase())) return res.status(403).json({ error: 'School mode: you can only message your teacher' });
    const msg = await Message.create({ from: req.user.username, to: to.toLowerCase(), text: text.trim() });
    // Real-time: notify both ends so the chat list/thread/unread refresh instantly
    io.to('user:' + msg.to).emit('dm', { from: msg.from });
    io.to('user:' + msg.from).emit('dm', { to: msg.to });
    res.json({ from: msg.from, to: msg.to, text: msg.text, at: msg.createdAt });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Total unread count
app.get('/api/messages/unread', auth, async (req, res) => {
  try {
    const count = await Message.countDocuments({ to: req.user.username, read: false });
    res.json({ count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── School mode: classes ──────────────────────────────────────────────────────
// Current user's school state (teaching, enrolled, restrictions)
app.get('/api/me/school', auth, async (req, res) => {
  try {
    const state = await getSchoolState(req.user.username);
    // Only teachers appointed by the superadmin may create classes — admin alone is not enough
    state.canCreateClass = !!req.user.teacher;
    res.json(state);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Create a class — only teachers appointed by the superadmin
app.post('/api/classes', auth, async (req, res) => {
  try {
    if (!req.user.teacher) return res.status(403).json({ error: 'Only a teacher can create a class. Ask the superadmin to make you a teacher.' });
    const name = (req.body.name || '').trim() || 'My Class';
    let code; do { code = Math.random().toString(36).slice(2, 7).toUpperCase(); } while (await Klass.findOne({ code }));
    const k = await Klass.create({ name, code, teacher: req.user.username, students: [], allowedApps: [] });
    res.json(serializeClass(k));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Join a class by code (becomes a student)
app.post('/api/classes/join', auth, async (req, res) => {
  try {
    const code = (req.body.code || '').trim().toUpperCase();
    const k = await Klass.findOne({ code });
    if (!k) return res.status(404).json({ error: 'No class with that code' });
    if (k.teacher === req.user.username) return res.status(400).json({ error: "You're the teacher of this class" });
    if (!k.students.includes(req.user.username)) { k.students.push(req.user.username); await k.save(); }
    res.json(serializeClass(k));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Teacher: set which apps students can open
app.put('/api/classes/:id/apps', auth, async (req, res) => {
  try {
    const k = await Klass.findById(req.params.id);
    if (!k) return res.status(404).json({ error: 'Class not found' });
    if (k.teacher !== req.user.username) return res.status(403).json({ error: 'Only the teacher can change this' });
    k.allowedApps = Array.isArray(req.body.allowedApps) ? req.body.allowedApps : [];
    await k.save(); res.json(serializeClass(k));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Teacher controls the roster: add students by username, or dismiss them.
// Students cannot add or remove themselves — only the teacher manages the class.
app.put('/api/classes/:id/students', auth, async (req, res) => {
  try {
    const k = await Klass.findById(req.params.id);
    if (!k) return res.status(404).json({ error: 'Class not found' });
    if (k.teacher !== req.user.username) return res.status(403).json({ error: 'Only the teacher can manage the class roster' });
    const add = Array.isArray(req.body.add) ? req.body.add.map(s => String(s).trim().toLowerCase().replace(/^@/, '')) : [];
    const remove = Array.isArray(req.body.remove) ? req.body.remove.map(s => String(s).trim().toLowerCase()) : [];
    const notFound = [];
    for (const u of add) {
      if (!u || u === k.teacher || k.students.includes(u)) continue;
      const exists = await User.findOne({ username: u });
      if (exists) k.students.push(u); else notFound.push(u);
    }
    if (remove.length) k.students = k.students.filter(s => !remove.includes(s));
    await k.save();
    res.json({ ...serializeClass(k), ...(notFound.length ? { notFound } : {}) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Student safety flag: record an alert for the teacher (content the student typed)
app.post('/api/classes/flag', auth, async (req, res) => {
  try {
    const snippet = String(req.body.snippet || '').slice(0, 200);
    const k = await Klass.findOne({ students: req.user.username });
    if (!k) return res.json({ ok: false }); // not in a class — nothing to flag
    k.flags.push({ student: req.user.username, snippet, at: new Date() });
    if (k.flags.length > 60) k.flags = k.flags.slice(-60);
    await k.save();
    res.json({ ok: true, teacher: k.teacher });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Teacher: delete the class
app.delete('/api/classes/:id', auth, async (req, res) => {
  try {
    const k = await Klass.findById(req.params.id);
    if (!k) return res.status(404).json({ error: 'Class not found' });
    if (k.teacher !== req.user.username) return res.status(403).json({ error: 'Only the teacher can delete this class' });
    await k.deleteOne(); res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Team chat (Slack-style channels, shared by everyone) ──────────────────────
app.get('/api/chat/:channel', auth, async (req, res) => {
  try {
    const msgs = await Chat.find({ channel: req.params.channel.toLowerCase() }).sort({ createdAt: 1 }).limit(100);
    res.json(msgs.map(m => ({ from: m.from, text: m.text, at: m.createdAt })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/chat/:channel', auth, async (req, res) => {
  try {
    if (!req.body.text?.trim()) return res.status(400).json({ error: 'Empty message' });
    const m = await Chat.create({ channel: req.params.channel.toLowerCase(), from: req.user.username, text: req.body.text.trim() });
    io.to('chan:' + m.channel).emit('chat', { channel: m.channel }); // real-time channel update
    res.json({ from: m.from, text: m.text, at: m.createdAt });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Channel management (add / delete / list)
app.get('/api/channels', auth, async (req, res) => {
  try {
    let list = await Channel.find().sort({ createdAt: 1 });
    if (!list.length) { await Channel.insertMany(['general', 'random', 'ideas'].map(name => ({ name, createdBy: 'system' }))); list = await Channel.find().sort({ createdAt: 1 }); }
    res.json(list.map(c => c.name));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/channels', auth, async (req, res) => {
  try {
    const name = (req.body.name || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24);
    if (!name) return res.status(400).json({ error: 'Invalid channel name' });
    if (await Channel.findOne({ name })) return res.status(409).json({ error: 'Channel already exists' });
    await Channel.create({ name, createdBy: req.user.username });
    res.json({ ok: true, name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/channels/:name', auth, async (req, res) => {
  try {
    const name = req.params.name.toLowerCase();
    if (name === 'general') return res.status(400).json({ error: 'The #general channel cannot be deleted' });
    await Channel.deleteOne({ name });
    await Chat.deleteMany({ channel: name });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── MaxSocial — public feed with likes & comments ────────────────────────────
const serializePost = (p, me) => ({ id: p._id, author: p.author, text: p.text, bg: p.bg, at: p.createdAt, likes: p.likes.length, liked: p.likes.includes(me), comments: p.comments.map(c => ({ from: c.from, text: c.text, at: c.at })) });
app.get('/api/posts', auth, async (req, res) => {
  try { const posts = await Post.find().sort({ createdAt: -1 }).limit(100); res.json(posts.map(p => serializePost(p, req.user.username))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/posts', auth, async (req, res) => {
  try {
    const username = req.user.username;
    if (!rateLimit('post:' + username, 6, 60 * 1000)) return res.status(429).json({ error: "You're posting too fast — take a breather." });
    // New-account gates (staff exempt): block posting for the first 10 minutes,
    // then cap posts in the first day. Stops drive-by bots that sign up and flood.
    // These are NOT spam strikes — a legit new user shouldn't get auto-suspended.
    const isStaff = ADMIN_USERS.includes(username) || req.user.admin;
    if (!isStaff) {
      const me = await User.findById(req.user.id).select('createdAt emailVerified mustVerifyEmail').lean();
      if (REQUIRE_EMAIL_VERIFY && me && me.mustVerifyEmail && !me.emailVerified) {
        return res.status(403).json({ error: 'Please verify your email before posting — check your inbox (or resend it from your profile).' });
      }
      const ageMs = me ? Date.now() - new Date(me.createdAt).getTime() : Infinity;
      if (ageMs < 10 * 60 * 1000) {
        const mins = Math.ceil((10 * 60 * 1000 - ageMs) / 60000);
        return res.status(403).json({ error: `New accounts can post after 10 minutes — about ${mins} more to go.` });
      }
      if (ageMs < 24 * 60 * 60 * 1000) {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const cnt = await Post.countDocuments({ author: username, createdAt: { $gte: since } });
        if (cnt >= 15) return res.status(429).json({ error: 'New accounts are limited to 15 posts a day for now — back tomorrow!' });
      }
    }
    // Reject helper: records a spam strike and auto-suspends after too many in a row.
    const reject = async (msg, code = 400) => {
      const suspended = await recordSpamStrike(username);
      if (suspended) return res.status(403).json({ error: 'Account suspended for repeated spam.' });
      return res.status(code).json({ error: msg });
    };
    const bad = moderatePost(req.body.text, username);
    if (bad) return reject(bad);
    const dup = await duplicatePostMsg(req.body.text, username);
    if (dup) return reject(dup);
    const text = req.body.text.trim().slice(0, 1000);
    const p = await Post.create({ author: username, text, authorIP: req.ip, bg: Number.isInteger(req.body.bg) ? req.body.bg : -1 });
    lastPostByUser.set(username, text);
    clearSpamStrikes(username); // a good post wipes the slate
    io.to('feed').emit('feed');
    res.json(serializePost(p, username));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/posts/:id/like', auth, async (req, res) => {
  try {
    const p = await Post.findById(req.params.id); if (!p) return res.status(404).json({ error: 'Not found' });
    const i = p.likes.indexOf(req.user.username);
    if (i >= 0) p.likes.splice(i, 1); else p.likes.push(req.user.username);
    await p.save(); io.to('feed').emit('feed'); res.json({ likes: p.likes.length, liked: i < 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/posts/:id/comment', auth, async (req, res) => {
  try {
    if (!req.body.text?.trim()) return res.status(400).json({ error: 'Empty comment' });
    if (!rateLimit('cmt:' + req.user.username, 12, 60 * 1000)) return res.status(429).json({ error: "You're commenting too fast." });
    const t = req.body.text.trim();
    if (POST_BAD.test(t)) return res.status(400).json({ error: 'Please keep it friendly.' });
    if (POST_LINK.test(t)) return res.status(400).json({ error: "Links aren't allowed." });
    const p = await Post.findById(req.params.id); if (!p) return res.status(404).json({ error: 'Not found' });
    p.comments.push({ from: req.user.username, text: req.body.text.trim().slice(0, 500) });
    await p.save(); io.to('feed').emit('feed'); res.json(serializePost(p, req.user.username));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/posts/:id', auth, async (req, res) => {
  try {
    const p = await Post.findById(req.params.id); if (!p) return res.status(404).json({ error: 'Not found' });
    if (p.author !== req.user.username && !ADMIN_USERS.includes(req.user.username)) return res.status(403).json({ error: 'Not your post' });
    await p.deleteOne();
    await Report.updateMany({ postId: req.params.id }, { handled: true }); // clear any reports
    io.to('feed').emit('feed');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Kids report a post → it goes to the superadmin (admins). One open report per kid per post.
app.post('/api/posts/:id/report', auth, async (req, res) => {
  try {
    const p = await Post.findById(req.params.id); if (!p) return res.status(404).json({ error: 'Post not found' });
    const dup = await Report.findOne({ postId: req.params.id, reporter: req.user.username, handled: false });
    if (dup) return res.json({ ok: true, already: true });
    await Report.create({ postId: req.params.id, author: p.author, text: (p.text || '').slice(0, 280), reporter: req.user.username, reason: String(req.body.reason || '').slice(0, 100) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Admin: list open reports + dismiss
app.get('/api/admin/reports', auth, superadminOnly, async (req, res) => {
  try {
    const list = await Report.find({ handled: false }).sort({ createdAt: -1 }).limit(100);
    res.json(list.map(r => ({ id: r._id.toString(), postId: r.postId, author: r.author, text: r.text, reporter: r.reporter, reason: r.reason, at: r.createdAt })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/reports/:id/dismiss', auth, superadminOnly, async (req, res) => {
  try { await Report.updateOne({ _id: req.params.id }, { handled: true }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Custom App Store (community apps in MongoDB) ──────────────────────────────
// Publish (create or update own app)
app.post('/api/apps', auth, async (req, res) => {
  try {
    const { id, title, icon, html, css, js, lang } = req.body;
    if (!title) return res.status(400).json({ error: 'Title required' });
    let doc = null;
    if (id) { doc = await AppModel.findOne({ id }); if (doc && doc.authorId.toString() !== req.user.id) doc = null; }
    if (doc) {
      Object.assign(doc, { title, icon, html, css, js, lang: lang === 'maxscript' ? 'maxscript' : 'js' });
      await doc.save();
    } else {
      const slug = await uniqueSlug(slugify(title));
      doc = await AppModel.create({ id: slug, title, icon, html, css, js, lang: lang === 'maxscript' ? 'maxscript' : 'js', authorId: req.user.id, authorName: req.user.username });
    }
    res.json(serializeApp(doc));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// List all community apps (public)
app.get('/api/apps', async (req, res) => {
  try { const list = await AppModel.find().sort({ updatedAt: -1 }).limit(300); res.json(list.map(serializeApp)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// Get one app (public — enables shareable deep links)
app.get('/api/apps/:id', async (req, res) => {
  try { const d = await AppModel.findOne({ id: req.params.id }); if (!d) return res.status(404).json({ error: 'Not found' }); res.json(serializeApp(d)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// Count an install (public)
app.post('/api/apps/:id/install', async (req, res) => {
  try { await AppModel.updateOne({ id: req.params.id }, { $inc: { installs: 1 } }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// Delete own app
app.delete('/api/apps/:id', auth, async (req, res) => {
  try {
    const d = await AppModel.findOne({ id: req.params.id });
    if (!d) return res.status(404).json({ error: 'Not found' });
    if (d.authorId.toString() !== req.user.id) return res.status(403).json({ error: 'You can only delete your own apps' });
    await d.deleteOne();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Make sure a user's "Shared with me" folder exists (idempotent — also used to
// retroactively add the folder to accounts created before it existed).
async function ensureSharedFolder(userId, username) {
  const sharedDir = `/home/${username}/Shared with me`;
  await File.updateOne(
    { userId, path: sharedDir },
    { $setOnInsert: { userId, path: sharedDir, name: 'Shared with me', type: 'directory', parent: `/home/${username}` } },
    { upsert: true }
  );
  return sharedDir;
}

// Add a shared doc to recipient's MaxDrive
async function addSharedToUserDrive(userId, type, title, content, fromUser) {
  const user = await User.findById(userId);
  if (!user) throw new Error(`User not found for ID ${userId}`);

  const extMap = { doc: '.docs', sheet: '.sheet', form: '.forms' };
  const ext = extMap[type] || '.txt';
  const sharedDir = await ensureSharedFolder(user._id, user.username);

  // Create file in "Shared with me" folder
  const filename = title.replace(/[^a-z0-9]+/gi, '_').slice(0, 30) || 'shared';
  const filepath = `${sharedDir}/${filename}${ext}`;

  const fileExists = await File.findOne({ userId, path: filepath });
  if (!fileExists) {
    await File.create({
      userId, path: filepath, name: `${filename}${ext}`, type: 'file', content, parent: sharedDir
    });
  } else {
    // If file already exists, update content
    await File.findOneAndUpdate({ userId, path: filepath }, { content }, { new: true });
  }
}

// ── Shared documents (publish Forms & Sheets) ────────────────────────────────
// Publish or update a shared form/sheet
app.post('/api/shared', auth, async (req, res) => {
  try {
    const { id, type, title, content, visibility, allow } = req.body;
    if (!type || !['form', 'sheet', 'doc'].includes(type)) return res.status(400).json({ error: 'Bad type' });
    // Only touch audience settings when the client explicitly sends them, so a plain
    // re-publish (Save) keeps the existing visibility instead of resetting to public.
    const vis = typeof visibility === 'undefined' ? undefined : (visibility === 'private' ? 'private' : 'public');
    let doc = null;
    if (id) { doc = await Shared.findOne({ id }); if (doc && doc.authorId.toString() !== req.user.id) doc = null; }

    // Track old allow list to detect changes
    const oldAllow = doc ? (doc.allow || []) : [];

    if (doc) {
      Object.assign(doc, { title, content });
      if (typeof vis !== 'undefined') doc.visibility = vis;
      if (typeof allow !== 'undefined') doc.allow = normUsers(allow);
      await doc.save();
    } else {
      const slug = await (async b => { let s = b, n = 1; while (await Shared.findOne({ id: s })) s = b + (++n); return s; })(slugify(title) || type);
      doc = await Shared.create({ id: slug, type, title, content, authorId: req.user.id, authorName: req.user.username, visibility: vis || 'public', allow: normUsers(allow) });
    }

    // If now private, add files to allowed users' drives (new additions only)
    if (doc.visibility === 'private' && doc.allow && doc.allow.length > 0) {
      const newUsers = doc.allow.filter(u => !oldAllow.includes(u));
      console.log(`[SHARE] Processing private share, newUsers:`, newUsers);
      for (const username of newUsers) {
        try {
          console.log(`[SHARE] Looking up user: ${username}`);
          const user = await User.findOne({ username });
          if (!user) {
            console.log(`[SHARE] User not found: ${username}`);
            continue;
          }
          console.log(`[SHARE] Found user ${username}, calling addSharedToUserDrive`);
          await addSharedToUserDrive(user._id, type, title, content, req.user.username);
          console.log(`[SHARE] Successfully added file for ${username}`);
        } catch (e) {
          console.error(`[SHARE] Error adding file for ${username}: ${e.message}`);
          // Silently fail — don't fail the share if file copy fails
        }
      }
    }

    res.json(serializeShared(doc, true));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Fetch a shared doc (public, so anyone with the link can view/fill)
app.get('/api/shared/:id', optionalAuth, async (req, res) => {
  try {
    const d = await Shared.findOne({ id: req.params.id });
    if (!d) return res.status(404).json({ error: 'Not found' });
    const isOwner = req.user && d.authorId.toString() === req.user.id;
    if ((d.visibility || 'public') === 'private' && !isOwner) {
      if (!req.user) return res.status(401).json({ error: 'Sign in to view this private document' });
      if (!(d.allow || []).includes(req.user.username.toLowerCase())) return res.status(403).json({ error: "You don't have access to this document" });
    }
    if (!isOwner) { d.views = (d.views || 0) + 1; await d.save(); } // count a view only once access is granted
    res.json(serializeShared(d, isOwner));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Submit a response to a shared form
app.post('/api/shared/:id/respond', auth, async (req, res) => {
  try {
    const d = await Shared.findOne({ id: req.params.id });
    if (!d || d.type !== 'form') return res.status(404).json({ error: 'Form not found' });
    const isOwner = d.authorId.toString() === req.user.id;
    if ((d.visibility || 'public') === 'private' && !isOwner && !(d.allow || []).includes(req.user.username.toLowerCase()))
      return res.status(403).json({ error: "You don't have access to this form" });
    await Response.create({ sharedId: req.params.id, answers: req.body.answers || [], byName: req.user.username });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// View responses (owner only)
app.get('/api/shared/:id/responses', auth, async (req, res) => {
  try {
    const d = await Shared.findOne({ id: req.params.id });
    if (!d) return res.status(404).json({ error: 'Not found' });
    if (d.authorId.toString() !== req.user.id) return res.status(403).json({ error: 'Only the owner can view responses' });
    const list = await Response.find({ sharedId: req.params.id }).sort({ createdAt: -1 }).limit(500);
    res.json(list.map(r => ({ answers: r.answers, by: r.byName, at: r.createdAt })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── File routes (all require auth) ───────────────────────────────────────────
const HOME = (user) => `/home/${user.username}`;

app.get('/api/ls', auth, async (req, res) => {
  try {
    const p = req.query.path || HOME(req.user);
    const files = await File.find({ userId: req.user.id, parent: p }).select('name type path updatedAt').sort({ type: -1, name: 1 });
    res.json(files);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// All files anywhere in the user's drive (flat) — used by the Open picker
app.get('/api/files', auth, async (req, res) => {
  try {
    const files = await File.find({ userId: req.user.id, type: 'file' }).select('name path updatedAt').sort({ path: 1 });
    res.json(files.map(f => ({ name: f.name, path: f.path })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stat', auth, async (req, res) => {
  try {
    const file = await File.findOne({ userId: req.user.id, path: req.query.path }).select('name type path');
    if (!file) return res.status(404).json({ error: 'Not found' });
    res.json(file);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/cat', auth, async (req, res) => {
  try {
    const file = await File.findOne({ userId: req.user.id, path: req.query.path, type: 'file' });
    if (!file) return res.status(404).json({ error: `cat: ${req.query.path}: No such file` });
    res.json({ content: file.content, name: file.name, path: file.path });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/write', auth, async (req, res) => {
  try {
    const { path, content, auto } = req.body;
    const name = (path || '').split('/').pop();
    if (!path || !name) return res.status(400).json({ error: 'Bad path' });
    const parent = path.slice(0, path.lastIndexOf('/')) || '';
    // Upsert: create the file if it doesn't exist yet, otherwise update it. (Saving a
    // brand-new file — e.g. a camera photo — used to 404 here, and the client then
    // silently wrote to its offline mirror instead of the server.)
    const file = await File.findOneAndUpdate(
      { userId: req.user.id, path, type: 'file' },
      { content, $setOnInsert: { name, parent } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    // Snapshot a version whenever the content actually changed — but skip big binary
    // images (.pic), where version history is pointless and would bloat the database.
    const skipVersions = /\.pic$/i.test(path || '') || (content && content.length > 200000);
    const last = skipVersions ? null : await FileVersion.findOne({ userId: req.user.id, path }).sort({ createdAt: -1 });
    if (!skipVersions && (!last || last.content !== content)) {
      await FileVersion.create({ userId: req.user.id, path, content, auto: !!auto });
      const count = await FileVersion.countDocuments({ userId: req.user.id, path });
      if (count > 50) {
        const old = await FileVersion.find({ userId: req.user.id, path }).sort({ createdAt: 1 }).limit(count - 50).select('_id');
        await FileVersion.deleteMany({ _id: { $in: old.map(o => o._id) } });
      }
    }
    res.json({ ok: true, path: file.path });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// List versions (newest first) for a file
app.get('/api/versions', auth, async (req, res) => {
  try {
    const list = await FileVersion.find({ userId: req.user.id, path: req.query.path }).sort({ createdAt: -1 }).limit(50).select('auto content createdAt');
    res.json(list.map(v => ({ id: v._id, auto: v.auto, createdAt: v.createdAt, size: (v.content || '').length })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Get one version's full content
app.get('/api/versions/:id', auth, async (req, res) => {
  try {
    const v = await FileVersion.findById(req.params.id);
    if (!v || v.userId.toString() !== req.user.id) return res.status(404).json({ error: 'Not found' });
    res.json({ content: v.content, createdAt: v.createdAt, auto: v.auto });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/mkdir', auth, async (req, res) => {
  try {
    const { path, name, parent } = req.body;
    if (await File.findOne({ userId: req.user.id, path })) return res.status(409).json({ error: `mkdir: ${name}: Already exists` });
    const dir = await File.create({ userId: req.user.id, path, name, type: 'directory', parent });
    res.json(dir);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/touch', auth, async (req, res) => {
  try {
    const { path, name, parent } = req.body;
    if (await File.findOne({ userId: req.user.id, path })) return res.status(409).json({ error: `touch: ${name}: Already exists` });
    const file = await File.create({ userId: req.user.id, path, name, type: 'file', content: '', parent });
    res.json(file);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/rm', auth, async (req, res) => {
  try {
    const p = req.query.path;
    if (!p || p === '/' || p === '/home') return res.status(403).json({ error: 'rm: cannot delete system path' });
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await File.deleteMany({ userId: req.user.id, path: new RegExp(`^${escaped}(/|$)`) });
    await File.deleteOne({ userId: req.user.id, path: p });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Bot tarpit ────────────────────────────────────────────────────────────────
// Hidden honeypot links (in the page) plus robots.txt-disallowed paths lure bad
// crawlers/scrapers into fake "trap" pages that log them, stall ~1.2s, and serve an
// endless maze of fake links. Rate-limited so one bot can't melt our own server.
const TRAP_PATHS = ['/bot-trap', '/private', '/admin-secret', '/backup', '/wp-admin', '/wp-login.php', '/backup.zip', '/.env', '/api/private/users'];
const trapSlug = () => crypto.randomBytes(6).toString('hex');
function logTrap(req, label) {
  console.warn('[' + (label || 'BOT-TRAP') + '] ' + JSON.stringify({ ip: req.ip, ua: (req.headers['user-agent'] || '').slice(0, 200), path: req.path }));
}
function trapPage(title) {
  const links = Array.from({ length: 30 }, () => '/bot-trap/' + trapSlug());
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title><meta name="robots" content="noindex,nofollow"></head><body><h1>${title}</h1><p>Continue verification…</p>${links.map(l => `<a href="${l}">${l}</a>`).join('<br>')}</body></html>`;
}
async function trapHandler(req, res) {
  logTrap(req, req.path.startsWith('/bot-trap/') ? 'BOT-MAZE' : 'BOT-TRAP');
  if (!rateLimit('trap:' + req.ip, 60, 60 * 1000)) return res.status(429).type('text/plain').send('Too many requests.');
  await new Promise(r => setTimeout(r, 1200)); // stall the bot, but not enough to hurt us
  res.type('html').send(trapPage('Access check'));
}
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send('User-agent: *\n' + TRAP_PATHS.map(p => 'Disallow: ' + p).join('\n') + '\nDisallow: /bot-trap/\n');
});
app.get(TRAP_PATHS, trapHandler);
app.get('/bot-trap/:slug', trapHandler);

// ── Deep links: every non-API path serves the OS (so /calc, /chess, etc. work) ──
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  sendOS(res);
});

// ── Start ─────────────────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!MONGO_URI) { console.error('❌ MONGO_URI env var is not set!'); process.exit(1); }
mongoose.connect(MONGO_URI, { dbName: 'maxos' })
  .then(async () => {
    console.log('✅ Connected to MongoDB');
    // Migrate: drop stale single-field unique index on `path` from old schema
    try {
      const idx = await File.collection.indexes();
      if (idx.some(i => i.name === 'path_1')) {
        await File.collection.dropIndex('path_1');
        console.log('🔧 Dropped stale path_1 index');
      }
    } catch (e) { console.log('Index check skipped:', e.message); }
    await File.syncIndexes();
    // Bootstrap: make sure at least one admin exists. Promote ADMIN_USERS by name,
    // otherwise promote the oldest account (the owner).
    try {
      if (ADMIN_USERS.length) {
        const r = await User.updateMany({ username: { $in: ADMIN_USERS } }, { admin: true });
        if (r.modifiedCount) console.log('🛡️ Ensured admins:', ADMIN_USERS.join(', '));
      }
      if ((await User.countDocuments({ admin: true })) === 0) {
        const oldest = await User.findOne().sort({ createdAt: 1 });
        if (oldest) { oldest.admin = true; await oldest.save(); console.log('🛡️ Promoted oldest account to admin: @' + oldest.username); }
      }
    } catch (e) { console.log('Admin bootstrap skipped:', e.message); }
    const port = process.env.PORT || 3001;
    server.listen(port, () => console.log(`🚀 MaxOS server on http://localhost:${port}`));
  })
  .catch(err => { console.error('❌ MongoDB error:', err.message); process.exit(1); });

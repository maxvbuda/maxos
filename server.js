require('dotenv').config({ silent: true });
const express  = require('express');
const mongoose = require('mongoose');
const cors     = require('cors');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const path     = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'maxos-super-secret-key-2024';

// ── Serve frontend ────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'os.html')));

// ── Schemas ───────────────────────────────────────────────────────────────────
const UserSchema = new mongoose.Schema({
  username:    { type: String, required: true, unique: true, lowercase: true, trim: true },
  password:    { type: String, required: true },
  displayName: { type: String, default: '' },
  installed:   { type: [String], default: ['calc', 'music', 'snake', 'notes'] },
  suspended:   { type: Boolean, default: false },
  admin:       { type: Boolean, default: false },
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
  type:       { type: String, enum: ['form', 'sheet'], required: true },
  title:      { type: String, default: 'Untitled' },
  content:    { type: String, default: '' }, // form JSON or sheet CSV
  authorId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  authorName: { type: String, required: true },
  views:      { type: Number, default: 0 },
}, { timestamps: true });

const ResponseSchema = new mongoose.Schema({
  sharedId:   { type: String, required: true },
  answers:    { type: Array, default: [] },
  byName:     { type: String, default: 'anonymous' },
}, { timestamps: true });
ResponseSchema.index({ sharedId: 1, createdAt: -1 });

const User    = mongoose.model('User', UserSchema);
const File    = mongoose.model('File', FileSchema);
const Message = mongoose.model('Message', MessageSchema);
const AppModel = mongoose.model('App', AppSchema);
const FileVersion = mongoose.model('FileVersion', VersionSchema);
const Shared = mongoose.model('Shared', SharedSchema);
const Response = mongoose.model('Response', ResponseSchema);

const serializeShared = d => ({ id: d.id, type: d.type, title: d.title, content: d.content, author: d.authorName, views: d.views });

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
  req.user = { id: user._id.toString(), username: user.username, displayName: user.displayName, admin: user.admin };
  next();
}
function adminOnly(req, res, next) {
  if (!req.user.admin) return res.status(403).json({ error: 'Admins only' });
  next();
}

// ── Auth routes ───────────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password, displayName } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
    const exists = await User.findOne({ username: username.toLowerCase() });
    if (exists) return res.status(409).json({ error: 'Username already taken' });
    const hashed = await bcrypt.hash(password, 10);
    // First registered user (or one named in ADMIN_USERS) becomes an admin
    const adminList = (process.env.ADMIN_USERS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const isAdmin = (await User.countDocuments()) === 0 || adminList.includes(username.toLowerCase());
    const user = await User.create({ username, password: hashed, displayName: displayName || username, admin: isAdmin });
    await seedUser(user._id, user.username);
    const token = jwt.sign({ id: user._id, username: user.username, displayName: user.displayName }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: user.username, displayName: user.displayName, admin: user.admin, installed: user.installed });
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
    await seedUser(user._id, user.username);
    const token = jwt.sign({ id: user._id, username: user.username, displayName: user.displayName }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: user.username, displayName: user.displayName, admin: user.admin, installed: user.installed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/auth/me', auth, async (req, res) => {
  const u = await User.findById(req.user.id).select('username displayName admin installed');
  res.json({ username: u.username, displayName: u.displayName, admin: u.admin, installed: u.installed });
});

// Persist the user's installed apps (so it's not just a browser token)
app.put('/api/me/installed', auth, async (req, res) => {
  try { await User.updateOne({ _id: req.user.id }, { installed: Array.isArray(req.body.installed) ? req.body.installed : [] }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin routes ──────────────────────────────────────────────────────────────
app.get('/api/admin/users', auth, adminOnly, async (req, res) => {
  try {
    const users = await User.find().select('username displayName suspended admin createdAt').sort({ createdAt: 1 });
    const counts = {};
    res.json(users.map(u => ({ username: u.username, displayName: u.displayName, suspended: u.suspended, admin: u.admin, createdAt: u.createdAt })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/users/:username/suspend', auth, adminOnly, async (req, res) => {
  try {
    const u = await User.findOne({ username: req.params.username.toLowerCase() });
    if (!u) return res.status(404).json({ error: 'User not found' });
    if (u.username === req.user.username) return res.status(400).json({ error: 'You cannot suspend yourself' });
    u.suspended = !u.suspended; await u.save();
    res.json({ ok: true, suspended: u.suspended });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/users/:username', auth, adminOnly, async (req, res) => {
  try {
    const uname = req.params.username.toLowerCase();
    if (uname === req.user.username) return res.status(400).json({ error: 'You cannot delete yourself' });
    const u = await User.findOne({ username: uname });
    if (!u) return res.status(404).json({ error: 'User not found' });
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
    const msg = await Message.create({ from: req.user.username, to: to.toLowerCase(), text: text.trim() });
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

// ── Shared documents (publish Forms & Sheets) ────────────────────────────────
// Publish or update a shared form/sheet
app.post('/api/shared', auth, async (req, res) => {
  try {
    const { id, type, title, content } = req.body;
    if (!type || !['form', 'sheet'].includes(type)) return res.status(400).json({ error: 'Bad type' });
    let doc = null;
    if (id) { doc = await Shared.findOne({ id }); if (doc && doc.authorId.toString() !== req.user.id) doc = null; }
    if (doc) { Object.assign(doc, { title, content }); await doc.save(); }
    else { const slug = await (async b => { let s = b, n = 1; while (await Shared.findOne({ id: s })) s = b + (++n); return s; })(slugify(title) || type); doc = await Shared.create({ id: slug, type, title, content, authorId: req.user.id, authorName: req.user.username }); }
    res.json(serializeShared(doc));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Fetch a shared doc (public, so anyone with the link can view/fill)
app.get('/api/shared/:id', async (req, res) => {
  try {
    const d = await Shared.findOneAndUpdate({ id: req.params.id }, { $inc: { views: 1 } }, { new: true });
    if (!d) return res.status(404).json({ error: 'Not found' });
    res.json(serializeShared(d));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Submit a response to a shared form
app.post('/api/shared/:id/respond', auth, async (req, res) => {
  try {
    const d = await Shared.findOne({ id: req.params.id });
    if (!d || d.type !== 'form') return res.status(404).json({ error: 'Form not found' });
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
    const file = await File.findOneAndUpdate({ userId: req.user.id, path, type: 'file' }, { content }, { new: true });
    if (!file) return res.status(404).json({ error: 'File not found' });
    // Snapshot a version whenever the content actually changed
    const last = await FileVersion.findOne({ userId: req.user.id, path }).sort({ createdAt: -1 });
    if (!last || last.content !== content) {
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

// ── Deep links: every non-API path serves the OS (so /calc, /chess, etc. work) ──
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'os.html'));
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
      const adminList = (process.env.ADMIN_USERS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      if (adminList.length) await User.updateMany({ username: { $in: adminList } }, { admin: true });
      if ((await User.countDocuments({ admin: true })) === 0) {
        const oldest = await User.findOne().sort({ createdAt: 1 });
        if (oldest) { oldest.admin = true; await oldest.save(); console.log('🛡️ Promoted oldest account to admin: @' + oldest.username); }
      }
    } catch (e) { console.log('Admin bootstrap skipped:', e.message); }
    const port = process.env.PORT || 3001;
    app.listen(port, () => console.log(`🚀 MaxOS server on http://localhost:${port}`));
  })
  .catch(err => { console.error('❌ MongoDB error:', err.message); process.exit(1); });

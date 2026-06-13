require('dotenv').config({ silent: true });
const express  = require('express');
const mongoose = require('mongoose');
const cors     = require('cors');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const path     = require('path');
const http     = require('http');
const { Server: SocketIOServer } = require('socket.io');

const app = express();
app.use(cors());
app.use(express.json());
const server = http.createServer(app);

const JWT_SECRET = process.env.JWT_SECRET || 'maxos-super-secret-key-2024';
// Always-admin usernames: 'max' (owner) plus anything in the ADMIN_USERS env var
const ADMIN_USERS = ['max', ...(process.env.ADMIN_USERS || '').split(',')].map(s => s.trim().toLowerCase()).filter(Boolean);
const SCREENWATCH_ROOM = username => `screenwatch:${username}`;
const SCREENWATCH_STALE_MS = 15000;
const SCREENWATCH_MAX_FRAME_LEN = 2_000_000;
const SCREENWATCH_MAX_APP_LEN = 80;
const latestScreenFrames = new Map(); // username -> { username, at, frame }
const io = new SocketIOServer(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

// ── Serve frontend ────────────────────────────────────────────────────────────
// Always send the latest os.html — never let the browser (esp. iOS Safari) cache
// a stale single-page app shell.
function sendOS(res) {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.sendFile(path.join(__dirname, 'os.html'));
}
app.get('/', (req, res) => sendOS(res));

// ── Schemas ───────────────────────────────────────────────────────────────────
const UserSchema = new mongoose.Schema({
  username:    { type: String, required: true, unique: true, lowercase: true, trim: true },
  password:    { type: String, required: true },
  displayName: { type: String, default: '' },
  installed:   { type: [String], default: ['calc', 'music', 'snake', 'notes'] },
  appData:     { type: mongoose.Schema.Types.Mixed, default: {} }, // per-user KV store (MaxCoin wallet, etc.)
  suspended:   { type: Boolean, default: false },
  suspicious:  { type: Boolean, default: false },
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

const ChatSchema = new mongoose.Schema({
  channel: { type: String, required: true },    // e.g. "general"
  from:    { type: String, required: true },
  text:    { type: String, required: true },
}, { timestamps: true });
ChatSchema.index({ channel: 1, createdAt: 1 });

const PostSchema = new mongoose.Schema({
  author:   { type: String, required: true },
  text:     { type: String, required: true },
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

// `allow` (the viewer list) is only revealed to the owner, never to plain viewers
const serializeShared = (d, isOwner) => ({ id: d.id, type: d.type, title: d.title, content: d.content, author: d.authorName, views: d.views, visibility: d.visibility || 'public', ...(isOwner ? { allow: d.allow || [] } : {}) });
const normUsers = a => Array.isArray(a) ? [...new Set(a.map(u => String(u).trim().toLowerCase().replace(/^@/, '')).filter(Boolean))] : [];

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
  req.user = { id: user._id.toString(), username: user.username, displayName: user.displayName, admin: user.admin };
  next();
}
function adminOnly(req, res, next) {
  if (!req.user.admin) return res.status(403).json({ error: 'Admins only' });
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
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password, displayName } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
    const exists = await User.findOne({ username: username.toLowerCase() });
    if (exists) return res.status(409).json({ error: 'Username already taken' });
    const hashed = await bcrypt.hash(password, 10);
    // First registered user (or a baked-in / ADMIN_USERS name) becomes an admin
    const isAdmin = (await User.countDocuments()) === 0 || ADMIN_USERS.includes(username.toLowerCase());
    const user = await User.create({ username, password: hashed, displayName: displayName || username, admin: isAdmin });
    await seedUser(user._id, user.username);
    const token = jwt.sign({ id: user._id, username: user.username, displayName: user.displayName }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: user.username, displayName: user.displayName, admin: user.admin, suspicious: user.suspicious, installed: user.installed });
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
    await ensureSharedFolder(user._id, user.username); // retroactive for accounts predating the folder
    const token = jwt.sign({ id: user._id, username: user.username, displayName: user.displayName }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: user.username, displayName: user.displayName, admin: user.admin, suspicious: user.suspicious, installed: user.installed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/auth/me', auth, async (req, res) => {
  const u = await User.findById(req.user.id).select('username displayName admin suspicious installed');
  await ensureSharedFolder(u._id, u.username); // retroactive for accounts predating the folder
  res.json({ username: u.username, displayName: u.displayName, admin: u.admin, suspicious: u.suspicious, installed: u.installed });
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

// ── Admin routes ──────────────────────────────────────────────────────────────
app.get('/api/admin/users', auth, adminOnly, async (req, res) => {
  try {
    const users = await User.find().select('username displayName suspended suspicious admin createdAt').sort({ createdAt: 1 });
    const counts = {};
    res.json(users.map(u => ({ username: u.username, displayName: u.displayName, suspended: u.suspended, suspicious: u.suspicious, admin: u.admin, createdAt: u.createdAt })));
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
app.post('/api/admin/users/:username/suspicious', auth, adminOnly, async (req, res) => {
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
app.get('/api/admin/users/:username/screen', auth, adminOnly, async (req, res) => {
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
app.delete('/api/admin/users/:username', auth, adminOnly, async (req, res) => {
  try {
    const uname = req.params.username.toLowerCase();
    if (uname === req.user.username) return res.status(400).json({ error: 'You cannot delete yourself' });
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
    if (!req.body.text?.trim()) return res.status(400).json({ error: 'Say something!' });
    const p = await Post.create({ author: req.user.username, text: req.body.text.trim().slice(0, 1000), bg: Number.isInteger(req.body.bg) ? req.body.bg : -1 });
    res.json(serializePost(p, req.user.username));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/posts/:id/like', auth, async (req, res) => {
  try {
    const p = await Post.findById(req.params.id); if (!p) return res.status(404).json({ error: 'Not found' });
    const i = p.likes.indexOf(req.user.username);
    if (i >= 0) p.likes.splice(i, 1); else p.likes.push(req.user.username);
    await p.save(); res.json({ likes: p.likes.length, liked: i < 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/posts/:id/comment', auth, async (req, res) => {
  try {
    if (!req.body.text?.trim()) return res.status(400).json({ error: 'Empty comment' });
    const p = await Post.findById(req.params.id); if (!p) return res.status(404).json({ error: 'Not found' });
    p.comments.push({ from: req.user.username, text: req.body.text.trim().slice(0, 500) });
    await p.save(); res.json(serializePost(p, req.user.username));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/posts/:id', auth, async (req, res) => {
  try {
    const p = await Post.findById(req.params.id); if (!p) return res.status(404).json({ error: 'Not found' });
    if (p.author !== req.user.username && !req.user.admin) return res.status(403).json({ error: 'Not your post' });
    await p.deleteOne(); res.json({ ok: true });
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

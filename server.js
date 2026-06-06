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

const User    = mongoose.model('User', UserSchema);
const File    = mongoose.model('File', FileSchema);
const Message = mongoose.model('Message', MessageSchema);

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

// ── Auth middleware ───────────────────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
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
    const user = await User.create({ username, password: hashed, displayName: displayName || username });
    await seedUser(user._id, user.username);
    const token = jwt.sign({ id: user._id, username: user.username, displayName: user.displayName }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: user.username, displayName: user.displayName });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const user = await User.findOne({ username: username.toLowerCase() });
    if (!user) return res.status(401).json({ error: 'Invalid username or password' });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Invalid username or password' });
    await seedUser(user._id, user.username);
    const token = jwt.sign({ id: user._id, username: user.username, displayName: user.displayName }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: user.username, displayName: user.displayName });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/auth/me', auth, async (req, res) => {
  res.json({ username: req.user.username, displayName: req.user.displayName });
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

// ── File routes (all require auth) ───────────────────────────────────────────
const HOME = (user) => `/home/${user.username}`;

app.get('/api/ls', auth, async (req, res) => {
  try {
    const p = req.query.path || HOME(req.user);
    const files = await File.find({ userId: req.user.id, parent: p }).select('name type path updatedAt').sort({ type: -1, name: 1 });
    res.json(files);
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
    const { path, content } = req.body;
    const file = await File.findOneAndUpdate({ userId: req.user.id, path, type: 'file' }, { content }, { new: true });
    if (!file) return res.status(404).json({ error: 'File not found' });
    res.json({ ok: true, path: file.path });
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
    const port = process.env.PORT || 3001;
    app.listen(port, () => console.log(`🚀 MaxOS server on http://localhost:${port}`));
  })
  .catch(err => { console.error('❌ MongoDB error:', err.message); process.exit(1); });

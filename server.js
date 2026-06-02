require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ── Schema ────────────────────────────────────────────────────────────────────
const FileSchema = new mongoose.Schema({
  path:    { type: String, required: true, unique: true },
  name:    { type: String, required: true },
  type:    { type: String, enum: ['file', 'directory'], required: true },
  content: { type: String, default: '' },
  parent:  { type: String, required: true },
}, { timestamps: true });

const File = mongoose.model('File', FileSchema);

// ── Seed ──────────────────────────────────────────────────────────────────────
async function seed() {
  const count = await File.countDocuments();
  if (count > 0) return;
  await File.insertMany([
    { path: '/',                            name: '/',          type: 'directory', parent: ''         },
    { path: '/home',                        name: 'home',       type: 'directory', parent: '/'        },
    { path: '/home/max',                    name: 'max',        type: 'directory', parent: '/home'    },
    { path: '/home/max/documents',          name: 'documents',  type: 'directory', parent: '/home/max' },
    { path: '/home/max/pictures',           name: 'pictures',   type: 'directory', parent: '/home/max' },
    { path: '/home/max/readme.txt',         name: 'readme.txt', type: 'file',
      content: 'Welcome to MaxOS!\nThis file is stored in MongoDB.\n\nHave fun!',
      parent: '/home/max' },
    { path: '/home/max/notes.md',           name: 'notes.md',   type: 'file',
      content: '# Notes\n- Build something cool\n- Learn more every day\n- Ship it!',
      parent: '/home/max' },
    { path: '/home/max/documents/report.txt', name: 'report.txt', type: 'file',
      content: 'MaxOS Status Report\n===================\nAll systems operational.',
      parent: '/home/max/documents' },
    { path: '/home/max/documents/ideas.md', name: 'ideas.md',   type: 'file',
      content: '# Ideas\n- Add more apps\n- Dark/light theme toggle\n- Multi-user support',
      parent: '/home/max/documents' },
  ]);
  console.log('✅ Seeded initial filesystem');
}

// ── Routes ────────────────────────────────────────────────────────────────────

// List directory
app.get('/api/ls', async (req, res) => {
  try {
    const { path = '/home/max' } = req.query;
    const files = await File.find({ parent: path }).select('name type path updatedAt').sort({ type: -1, name: 1 });
    res.json(files);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Stat (check if path exists and what type)
app.get('/api/stat', async (req, res) => {
  try {
    const { path } = req.query;
    const file = await File.findOne({ path }).select('name type path');
    if (!file) return res.status(404).json({ error: 'Not found' });
    res.json(file);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Read file content
app.get('/api/cat', async (req, res) => {
  try {
    const { path } = req.query;
    const file = await File.findOne({ path, type: 'file' });
    if (!file) return res.status(404).json({ error: `cat: ${path}: No such file` });
    res.json({ content: file.content, name: file.name, path: file.path });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Write / update file content
app.put('/api/write', async (req, res) => {
  try {
    const { path, content } = req.body;
    const file = await File.findOneAndUpdate(
      { path, type: 'file' },
      { content },
      { new: true }
    );
    if (!file) return res.status(404).json({ error: 'File not found' });
    res.json({ ok: true, path: file.path });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create directory
app.post('/api/mkdir', async (req, res) => {
  try {
    const { path, name, parent } = req.body;
    if (await File.findOne({ path })) return res.status(409).json({ error: `mkdir: ${name}: Already exists` });
    const dir = await File.create({ path, name, type: 'directory', parent });
    res.json(dir);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create file
app.post('/api/touch', async (req, res) => {
  try {
    const { path, name, parent } = req.body;
    if (await File.findOne({ path })) return res.status(409).json({ error: `touch: ${name}: Already exists` });
    const file = await File.create({ path, name, type: 'file', content: '', parent });
    res.json(file);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete file or directory (recursive)
app.delete('/api/rm', async (req, res) => {
  try {
    const { path } = req.query;
    if (!path || path === '/' || path === '/home' || path === '/home/max')
      return res.status(403).json({ error: 'rm: cannot delete system path' });
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await File.deleteMany({ path: new RegExp(`^${escaped}(/|$)`) });
    await File.deleteOne({ path });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Rename / move
app.post('/api/mv', async (req, res) => {
  try {
    const { from, to, name } = req.body;
    const parent = to.substring(0, to.lastIndexOf('/')) || '/';
    const file = await File.findOneAndUpdate({ path: from }, { path: to, name, parent }, { new: true });
    if (!file) return res.status(404).json({ error: 'Source not found' });
    res.json(file);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Start ─────────────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI)
  .then(async () => {
    console.log('✅ Connected to MongoDB');
    await seed();
    const port = process.env.PORT || 3001;
    app.listen(port, () => console.log(`🚀 MaxOS server on http://localhost:${port}`));
  })
  .catch(err => { console.error('❌ MongoDB error:', err.message); process.exit(1); });

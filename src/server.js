const path = require('path');
const fs = require('fs');
const express = require('express');
const compression = require('compression');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const matter = require('gray-matter');
// marked is ESM; load dynamically from CommonJS
let markedModulePromise;
async function getMarked() {
  if (!markedModulePromise) markedModulePromise = import('marked');
  const mod = await markedModulePromise;
  return mod.marked;
}
// Pre-warm markdown parser to avoid first-request delay
getMarked().catch(() => {});
const slugify = require('slugify');
const Loki = require('lokijs');

const app = express();
const PORT = process.env.PORT || 3000;

// Paths
const ROOT = __dirname;
const POSTS_DIR = path.join(ROOT, 'posts');
const PUBLIC_DIR = path.join(ROOT, 'public');
const CLIENT_DIR = path.join(ROOT, 'client');
const CLIENT_DIST = path.join(CLIENT_DIR, 'dist');
const IS_DEV = !fs.existsSync(CLIENT_DIST);
const VIEWS_DIR = path.join(ROOT, 'views');
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'blog.db.json');

// Ensure directories exist
for (const dir of [POSTS_DIR, PUBLIC_DIR, DATA_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// DB setup
const db = new Loki(DB_PATH, {
  autoload: true,
  autoloadCallback: initDb,
  autosave: true,
  autosaveInterval: 2000,
});

let postsCollection;
let commentsCollection;
function initDb() {
  postsCollection = db.getCollection('posts');
  if (!postsCollection) postsCollection = db.addCollection('posts', { indices: ['slug', 'createdAt'] });
  commentsCollection = db.getCollection('comments');
  if (!commentsCollection) commentsCollection = db.addCollection('comments', { indices: ['slug', 'createdAt'] });
  // Backfill from filesystem into DB on startup
  try {
    const files = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const slug = file.replace(/\.md$/, '');
      const filePath = path.join(POSTS_DIR, file);
      const raw = fs.readFileSync(filePath, 'utf8');
      const { data } = matter(raw);
      const title = data.title || slug;
      const createdAt = data.createdAt || fs.statSync(filePath).ctime.toISOString();
      const existing = postsCollection.findOne({ slug });
      if (!existing) {
        postsCollection.insert({ slug, title, createdAt });
      } else {
        existing.title = title;
        existing.createdAt = createdAt;
        postsCollection.update(existing);
      }
    }
    db.saveDatabase();
  } catch (_) {}
}

// Express setup (EJS removed; React client serves UI)
app.use('/static', express.static(PUBLIC_DIR, { maxAge: '1h' }));
// Serve built React client if present
if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST, { maxAge: '1h' }));
}
app.use(compression());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
// Expose admin flag to all views
app.use((req, res, next) => {
  res.locals.isAdmin = req.cookies && req.cookies.admin === '1';
  next();
});

// Multer for FormData (no files initially, but ready for future assets)
const upload = multer({ storage: multer.memoryStorage() });

// Utilities
function listPosts() {
  const files = fs.readdirSync(POSTS_DIR).filter((f) => f.endsWith('.md'));
  const posts = files
    .map((file) => {
      const filePath = path.join(POSTS_DIR, file);
      const raw = fs.readFileSync(filePath, 'utf8');
      const { data, content } = matter(raw);
      const slug = file.replace(/\.md$/, '');
      const title = data.title || slug;
      const createdAt = data.createdAt || fs.statSync(filePath).ctime.toISOString();
      return { slug, title, createdAt, excerpt: content.slice(0, 200) };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return posts;
}

function getAllPostsFromDb() {
  if (postsCollection) {
    return postsCollection.chain().simplesort('createdAt', true).data();
  }
  return listPosts();
}

async function readPost(slug) {
  const filePath = path.join(POSTS_DIR, `${slug}.md`);
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf8');
  const { data, content } = matter(raw);
  const marked = await getMarked();
  const html = marked.parse(content);
  return { slug, title: data.title || slug, createdAt: data.createdAt, html };
}

// Routes
// API: list posts
app.get('/api/posts', (req, res) => {
  try {
    let posts = [];
    if (postsCollection) {
      posts = postsCollection.chain().simplesort('createdAt', true).data();
    } else {
      posts = listPosts();
    }
    return res.json({ posts });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to load posts' });
  }
});

// API: whoami
app.get('/api/me', (req, res) => {
  const isAdmin = req.cookies && req.cookies.admin === '1';
  res.json({ isAdmin });
});

// Require auth to write
app.get('/write', requireAdmin, (req, res) => {
  res.redirect('/postarticle');
});

// FormData publish endpoint (requires login)
app.post('/publish', requireAdmin, upload.none(), (req, res) => {
  try {
    const { title, body } = req.body;
    if (!title || !body) {
      return res.status(400).send('Title and body are required');
    }
    const slug = slugify(title, { lower: true, strict: true }) || `post-${Date.now()}`;
    const filePath = path.join(POSTS_DIR, `${slug}.md`);
    const frontmatter = matter.stringify(body, {
      title,
      createdAt: new Date().toISOString(),
    });
    fs.writeFileSync(filePath, frontmatter, 'utf8');
    if (postsCollection) {
      postsCollection.insert({ slug, title, createdAt: new Date().toISOString() });
      db.saveDatabase();
    }
    res.redirect(`/p/${slug}`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to publish');
  }
});

// API: get post content
app.get('/api/posts/:slug', async (req, res) => {
  const post = await readPost(req.params.slug);
  if (!post) return res.status(404).json({ error: 'Not found' });
  const comments = commentsCollection ? commentsCollection.chain().find({ slug: req.params.slug }).simplesort('createdAt', true).data() : [];
  return res.json({ post, comments });
});

// Add comment to a post
app.post('/api/posts/:slug/comments', upload.none(), (req, res) => {
  const { name, text } = req.body || {};
  const slug = req.params.slug;
  if (!name || !text) return res.status(400).json({ error: 'Name and comment are required' });
  if (!commentsCollection) return res.status(500).json({ error: 'Comments unavailable' });
  commentsCollection.insert({ slug, name, text, createdAt: new Date().toISOString() });
  db.saveDatabase();
  res.json({ ok: true });
});

// --- Simple admin auth ---
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'abelashinework@gmail.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '1926522431';
function requireAdmin(req, res, next) {
  if (req.cookies && req.cookies.admin === '1') return next();
  const wantsJson = req.path.startsWith('/api') || (req.headers.accept || '').includes('application/json');
  if (wantsJson) return res.status(401).json({ error: 'Unauthorized' });
  return res.redirect('/login');
}

app.get('/login', (req, res) => {
  if (fs.existsSync(CLIENT_DIST)) return res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  // In dev, let the client (Vite) handle /login route
  res.redirect('http://localhost:5173/login');
});

app.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  const emailOk = typeof email === 'string' && email.toLowerCase() === ADMIN_EMAIL.toLowerCase();
  const passwordOk = typeof password === 'string' && password === ADMIN_PASSWORD;
  if (emailOk && passwordOk) {
    res.cookie('admin', '1', { httpOnly: true, sameSite: 'lax' });
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: 'Invalid credentials' });
});

app.post('/logout', (req, res) => {
  res.clearCookie('admin');
  res.redirect('/');
});

// Admin dashboard to post an article
app.get('/postarticle', requireAdmin, (req, res) => {
  if (fs.existsSync(CLIENT_DIST)) return res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  res.redirect('http://localhost:5173/postarticle');
});

// Reuse publish for admin submissions
app.post('/postarticle', requireAdmin, upload.none(), (req, res) => {
  try {
    const { title, body } = req.body;
    if (!title || !body) return res.status(400).send('Title and body are required');
    const slug = slugify(title, { lower: true, strict: true }) || `post-${Date.now()}`;
    const filePath = path.join(POSTS_DIR, `${slug}.md`);
    const frontmatter = matter.stringify(body, { title, createdAt: new Date().toISOString() });
    fs.writeFileSync(filePath, frontmatter, 'utf8');
    if (postsCollection) {
      postsCollection.insert({ slug, title, createdAt: new Date().toISOString() });
      db.saveDatabase();
    }
    res.redirect(`/p/${slug}`);
  } catch (e) {
    console.error(e);
    res.status(500).send('Failed to publish');
  }
});

// API publish endpoint used by React client (dev/prod)
app.post('/api/admin/publish', requireAdmin, upload.none(), (req, res) => {
  try {
    const { title, body } = req.body;
    if (!title || !body) return res.status(400).json({ error: 'Title and body are required' });
    const slug = slugify(title, { lower: true, strict: true }) || `post-${Date.now()}`;
    const filePath = path.join(POSTS_DIR, `${slug}.md`);
    const frontmatter = matter.stringify(body, { title, createdAt: new Date().toISOString() });
    fs.writeFileSync(filePath, frontmatter, 'utf8');
    if (postsCollection) {
      postsCollection.insert({ slug, title, createdAt: new Date().toISOString() });
      db.saveDatabase();
    }
    return res.json({ ok: true, slug });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to publish' });
  }
});

// Admin list
app.get('/admin/posts', requireAdmin, (req, res) => {
  if (fs.existsSync(CLIENT_DIST)) return res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  res.redirect('http://localhost:5173/admin');
});

// Redirect /admin -> /admin/posts (dev/prod)
app.get('/admin', requireAdmin, (req, res) => {
  return res.redirect('/admin/posts');
});

// Delete site confirm
app.get('/admin/delete', requireAdmin, (req, res) => {
  if (fs.existsSync(CLIENT_DIST)) return res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  res.send('Admin delete page is available when the client is built.');
});

// Delete site action
app.post('/admin/delete', requireAdmin, (req, res) => {
  try {
    // Remove posts files
    for (const f of fs.readdirSync(POSTS_DIR)) {
      if (f.endsWith('.md')) fs.unlinkSync(path.join(POSTS_DIR, f));
    }
    // Clear DB
    if (postsCollection) {
      postsCollection.clear();
      db.saveDatabase();
    }
    return res.send('Site content deleted. <a href="/">Home</a>');
  } catch (e) {
    console.error(e);
    return res.status(500).send('Failed to delete');
  }
});

// Delete a single post (admin)
app.post('/admin/posts/:slug/delete', requireAdmin, (req, res) => {
  try {
    const { slug } = req.params;
    const filePath = path.join(POSTS_DIR, `${slug}.md`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    if (postsCollection) {
      const row = postsCollection.findOne({ slug });
      if (row) postsCollection.remove(row);
    }
    if (commentsCollection) {
      commentsCollection.findAndRemove({ slug });
    }
    db.saveDatabase();
    return res.redirect('/admin/posts');
  } catch (e) {
    console.error(e);
    return res.status(500).send('Failed to delete post');
  }
});

// JSON delete endpoint for admin (used by React client)
app.delete('/api/admin/posts/:slug', requireAdmin, (req, res) => {
  try {
    const { slug } = req.params;
    const filePath = path.join(POSTS_DIR, `${slug}.md`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    if (postsCollection) {
      const row = postsCollection.findOne({ slug });
      if (row) postsCollection.remove(row);
    }
    if (commentsCollection) {
      commentsCollection.findAndRemove({ slug });
    }
    db.saveDatabase();
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to delete post' });
  }
});

// SPA fallback to React build for non-API, non-static routes
if (fs.existsSync(CLIENT_DIST)) {
  app.get(/^(?!\/api|\/static).*/, (req, res) => {
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Abel's blog listening on http://localhost:${PORT}`);
});



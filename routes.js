const express = require('express');
const bcrypt = require('bcryptjs');
const { getDb, all, get, run } = require('./db');
const { sendMail } = require('./email');
const multer = require('multer');
const path = require('path');
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, 'data', 'uploads')),
    filename: (req, file, cb) => {
      const safeBase = (file.originalname || 'image').replace(/[^a-zA-Z0-9_\.-]/g, '_');
      const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
      cb(null, unique + '-' + safeBase);
    },
  }),
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image uploads are allowed'));
  },
  limits: { fileSize: 5 * 1024 * 1024 },
});

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  next();
}

// Helpers
function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Render content to HTML: linkify URLs and embed image URLs
function renderContentToHtml(content) {
  if (!content) return '';
  const escapeHtml = (s) => s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const imageRegex = /(https?:\/\/[^\s]+\.(?:png|jpg|jpeg|gif|webp))/i;
  const lines = content.split(/\r?\n/);
  const htmlLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return '<br/>';
    // If line is just an image URL, embed image
    if (imageRegex.test(trimmed) && trimmed.match(urlRegex)?.[0] === trimmed) {
      const src = trimmed;
      return `<div class="post-image"><img src="${escapeHtml(src)}" alt="image" loading="lazy"/></div>`;
    }
    // Otherwise linkify URLs
    const escaped = escapeHtml(line);
    const linked = escaped.replace(urlRegex, (url) => {
      const isImg = /(\.png|\.jpg|\.jpeg|\.gif|\.webp)(\?|#|$)/i.test(url);
      if (isImg) {
        return `<div class=\"post-image\"><img src=\"${escapeHtml(url)}\" alt=\"image\" loading=\"lazy\"/></div>`;
      }
      return `<a href=\"${escapeHtml(url)}\" target=\"_blank\" rel=\"noopener noreferrer\">${escapeHtml(url)}</a>`;
    });
    return `<p>${linked}</p>`;
  });
  return htmlLines.join('\n');
}

// Home - list posts
router.get('/', async (req, res) => {
  const db = getDb();
  const posts = await all(
    db,
    'SELECT id, title, slug, substr(content,1,240) AS excerpt, created_at, updated_at FROM posts ORDER BY created_at DESC'
  );
  const subscribed = req.query.subscribed === '1';
  const already = req.query.subscribed === '0';
  res.render('home', { posts, subscribed, already });
});

// View single post with comments
router.get('/post/:slug', async (req, res) => {
  const db = getDb();
  const post = await get(db, 'SELECT * FROM posts WHERE slug = ?', [req.params.slug]);
  if (!post) return res.status(404).send('Not found');
  const comments = await all(db, 'SELECT * FROM comments WHERE post_id = ? ORDER BY created_at DESC', [
    post.id,
  ]);
  const contentHtml = renderContentToHtml(post.content);
  res.render('post', { post, comments, contentHtml });
});

// Add comment
router.post('/post/:slug/comments', async (req, res) => {
  const db = getDb();
  const post = await get(db, 'SELECT id FROM posts WHERE slug = ?', [req.params.slug]);
  if (!post) return res.status(404).send('Not found');
  const author = req.body.author?.trim() || 'Anonymous';
  const body = req.body.body?.trim();
  if (body) {
    await run(db, 'INSERT INTO comments (post_id, author, body) VALUES (?, ?, ?)', [
      post.id,
      author,
      body,
    ]);
  }
  res.redirect(`/post/${req.params.slug}`);
});

// Subscribe email
router.post('/subscribe', async (req, res) => {
  const db = getDb();
  const email = (req.body.email || '').trim().toLowerCase();
  if (email) {
    try {
      await run(db, 'INSERT INTO subscribers (email) VALUES (?)', [email]);
      // fire-and-forget confirmation email
      console.log('[subscribe] New subscriber:', email);
      console.log('[subscribe] Sending welcome email...');
      sendMail({
        to: email,
        subject: 'Welcome to abelashine blog',
        text: 'Welcome to abelashine blog! You\'re subscribed for new articles.',
        html: '<p>Welcome to <strong>abelashine blog</strong>! 🎉</p><p>We\'ll email you when new articles are published.</p>',
      }).catch(() => {});
      console.log('[subscribe] Welcome email queued');
      return res.redirect('/?subscribed=1');
    } catch (e) {
      // ignore duplicates
      return res.redirect('/?subscribed=0');
    }
  }
  res.redirect('/');
});

// Auth
router.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/admin');
  res.render('login', { error: null });
});

router.post('/login', async (req, res) => {
  const db = getDb();
  const { email, password } = req.body;
  const user = await get(db, 'SELECT * FROM users WHERE email = ?', [email]);
  if (!user) return res.render('login', { error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.render('login', { error: 'Invalid credentials' });
  req.session.userId = user.id;
  res.redirect('/admin');
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// Admin dashboard
router.get('/admin', requireAuth, async (req, res) => {
  const db = getDb();
  const posts = await all(db, 'SELECT id, title, slug, created_at, updated_at FROM posts ORDER BY created_at DESC');
  const subscribers = await all(db, 'SELECT id, email, created_at FROM subscribers ORDER BY created_at DESC');
  res.render('admin/index', { posts, subscribers });
});

// Admin email test
router.get('/admin/email-test', requireAuth, async (req, res) => {
  const to = (req.query.to || '').trim();
  if (!to) return res.status(400).send('Provide ?to=email@example.com');
  const ok = await sendMail({ to, subject: 'abelashine email test', text: 'Test email from abelashine', html: '<p>Test email from <strong>abelashine</strong></p>' });
  res.send(ok ? 'Sent' : 'Failed');
});

// Create post form
router.get('/admin/posts/new', requireAuth, (req, res) => {
  res.render('admin/new', { post: { title: '', content: '' }, error: null });
});

// Create post
router.post('/admin/posts', requireAuth, upload.array('images', 8), async (req, res) => {
  const db = getDb();
  const title = (req.body.title || '').trim();
  const content = (req.body.content || '').trim();
  if (!title || !content) return res.render('admin/new', { post: { title, content }, error: 'Title and content required' });
  const slug = slugify(title);
  try {
    // Append uploaded image URLs to content
    let finalContent = content;
    if (req.files && req.files.length > 0) {
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const urls = req.files.map(f => `${baseUrl}/uploads/${f.filename}`);
      finalContent += '\n\n' + urls.map(u => u).join('\n');
    }
    await run(db, 'INSERT INTO posts (title, slug, content) VALUES (?, ?, ?)', [title, slug, finalContent]);
    // send notifications to all subscribers
    const subscribers = await all(db, 'SELECT email FROM subscribers');
    const postUrl = `${req.protocol}://${req.get('host')}/post/${slug}`;
    const html = `<p>New post: <strong>${title}</strong></p><p><a href="${postUrl}">Read it here</a></p>`;
    const text = `New post: ${title}\n${postUrl}`;
    console.log('[post] Created:', title, 'slug=', slug);
    console.log('[post] Notifying subscribers:', subscribers.length);
    Promise.allSettled(
      subscribers.map(s => sendMail({ to: s.email, subject: `New post: ${title}`, html, text }))
    )
      .then(results => {
        const fulfilled = results.filter(r => r.status === 'fulfilled').length;
        const rejected = results.length - fulfilled;
        console.log('[post] Notification results:', { total: results.length, sent: fulfilled, failed: rejected });
      })
      .catch(err => {
        console.error('[post] Notification batch error:', err && err.message ? err.message : err);
      });
    res.redirect('/admin');
  } catch (e) {
    res.render('admin/new', { post: { title, content }, error: 'Title already used' });
  }
});

// Edit post form
router.get('/admin/posts/:id/edit', requireAuth, async (req, res) => {
  const db = getDb();
  const post = await get(db, 'SELECT * FROM posts WHERE id = ?', [req.params.id]);
  if (!post) return res.redirect('/admin');
  res.render('admin/edit', { post, error: null });
});

// Update post
router.put('/admin/posts/:id', requireAuth, upload.array('images', 8), async (req, res) => {
  const db = getDb();
  const title = (req.body.title || '').trim();
  const content = (req.body.content || '').trim();
  if (!title || !content) {
    const post = await get(db, 'SELECT * FROM posts WHERE id = ?', [req.params.id]);
    return res.render('admin/edit', { post: { ...post, title, content }, error: 'Title and content required' });
  }
  const slug = slugify(title);
  try {
    // Append uploaded images to content
    let finalContent = content;
    if (req.files && req.files.length > 0) {
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const urls = req.files.map(f => `${baseUrl}/uploads/${f.filename}`);
      finalContent += '\n\n' + urls.map(u => u).join('\n');
    }
    await run(
      db,
      'UPDATE posts SET title = ?, slug = ?, content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [title, slug, finalContent, req.params.id]
    );
    res.redirect('/admin');
  } catch (e) {
    const post = await get(db, 'SELECT * FROM posts WHERE id = ?', [req.params.id]);
    res.render('admin/edit', { post: { ...post, title, content }, error: 'Title already used' });
  }
});

// Delete post
router.delete('/admin/posts/:id', requireAuth, async (req, res) => {
  const db = getDb();
  await run(db, 'DELETE FROM posts WHERE id = ?', [req.params.id]);
  res.redirect('/admin');
});

// Delete subscriber
router.delete('/admin/subscribers/:id', requireAuth, async (req, res) => {
  const db = getDb();
  await run(db, 'DELETE FROM subscribers WHERE id = ?', [req.params.id]);
  res.redirect('/admin');
});

// Broadcast email compose
router.get('/admin/broadcast', requireAuth, (req, res) => {
  res.render('admin/broadcast', { error: null, sent: false, subject: '', message: '' });
});

// Send broadcast to all subscribers
router.post('/admin/broadcast', requireAuth, async (req, res) => {
  const db = getDb();
  const subject = (req.body.subject || '').trim();
  const message = (req.body.message || '').trim();
  if (!subject || !message) return res.render('admin/broadcast', { error: 'Subject and message required', sent: false, subject, message });
  const subscribers = await all(db, 'SELECT email FROM subscribers');
  console.log('[broadcast] Sending to subscribers:', subscribers.length, 'subject=', subject);
  const html = `
  <div style="font-family: Arial, sans-serif; background:#f6f7f9; padding:24px">
    <div style="max-width:640px; margin:0 auto; background:#ffffff; border-radius:8px; overflow:hidden; box-shadow:0 2px 8px rgba(0,0,0,0.06)">
      <div style="background:#111; color:#fff; padding:16px 20px;">
        <h2 style="margin:0; font-weight:600">abelashine</h2>
      </div>
      <div style="padding:20px">
        <h3 style="margin-top:0; color:#111">${subject}</h3>
        <div style="white-space:pre-wrap; color:#222; line-height:1.6">${message.replace(/</g, '&lt;')}</div>
        <p style="margin-top:28px; color:#666; font-size:12px">You are receiving this because you subscribed to abelashine updates.</p>
      </div>
    </div>
  </div>`;
  const text = message;
  const results = await Promise.allSettled(subscribers.map(s => sendMail({ to: s.email, subject, html, text })));
  const fulfilled = results.filter(r => r.status === 'fulfilled').length;
  const rejected = results.length - fulfilled;
  console.log('[broadcast] Results:', { total: results.length, sent: fulfilled, failed: rejected });
  res.render('admin/broadcast', { error: null, sent: true, subject: '', message: '' });
});

module.exports = router;



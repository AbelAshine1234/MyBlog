require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const methodOverride = require('method-override');
const fs = require('fs');

const { initDb } = require('./db');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, 'public')));
// Ensure persistent data/uploads directory exists and is served
const dataUploadsDir = path.join(__dirname, 'data', 'uploads');
if (!fs.existsSync(dataUploadsDir)) fs.mkdirSync(dataUploadsDir, { recursive: true });
app.use('/uploads', express.static(dataUploadsDir));

app.use(
  session({
    store: new SQLiteStore({ db: 'sessions.sqlite', dir: path.join(__dirname, 'data') }),
    secret: 'replace-with-env-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 },
  })
);

// Simple auth middleware flag
app.use((req, res, next) => {
  res.locals.currentUserId = req.session.userId || null;
  next();
});

// Routes
const routes = require('./routes');
app.use('/', routes);

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`abelashine running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to init DB', err);
    process.exit(1);
  });

module.exports = app;



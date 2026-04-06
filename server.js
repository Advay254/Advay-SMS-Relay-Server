// server.js — SMS Relay Server main entry
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const path = require('path');
const db = require('./db');
const queue = require('./queue');
const { router: authRouter } = require('./routes/auth');
const apiRouter = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Trust proxy (Render sits behind one) ────────────────────────────────────
app.set('trust proxy', 1);

// ─── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));

// ─── Sessions ─────────────────────────────────────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
    sameSite: 'strict',
  },
}));

// ─── Global rate limiter ──────────────────────────────────────────────────────
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
}));

// ─── Static files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── Auth routes ──────────────────────────────────────────────────────────────
app.use('/', authRouter);

// ─── API routes ───────────────────────────────────────────────────────────────
app.use('/api', apiRouter);

// ─── Page routes ──────────────────────────────────────────────────────────────
const { requireLogin } = require('./routes/auth');

app.get('/', (req, res) => {
  if (req.session?.authenticated) return res.redirect('/dashboard');
  res.redirect('/login');
});

app.get('/login', (req, res) => {
  if (req.session?.authenticated) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/dashboard', requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/webhooks', requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'webhooks.html'));
});

app.get('/health-page', requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'health.html'));
});

// ─── 404 ─────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// ─── Error handler ────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
(async () => {
  try {
    await db.init();
    queue.start();
    app.listen(PORT, () => {
      console.log(`[server] SMS Relay running on port ${PORT}`);
    });
  } catch (err) {
    console.error('[boot] Fatal error:', err.message);
    process.exit(1);
  }
})();

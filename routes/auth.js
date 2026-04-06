// routes/auth.js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../db');

// ─── Constant-time string comparison (prevents timing attacks) ────────────────
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // Buffers must be the same length for timingSafeEqual; pad to avoid
  // short-circuit on length mismatch while still returning false.
  if (bufA.length !== bufB.length) {
    // Still run the comparison to avoid timing leak on length difference
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// ─── Middleware: require session login ────────────────────────────────────────
function requireLogin(req, res, next) {
  if (req.session?.authenticated) return next();
  res.redirect('/login');
}

// ─── Middleware: require API key ──────────────────────────────────────────────
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.apiKey;
  if (!key || !safeEqual(key, process.env.API_KEY || '')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── Rate-limit brute-force: 5 attempts → 15 min lockout ─────────────────────
async function loginRateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress;
  try {
    const attempts = await db.getLoginAttempts(ip);
    if (attempts.locked_until && new Date(attempts.locked_until) > new Date()) {
      const remaining = Math.ceil((new Date(attempts.locked_until) - Date.now()) / 60000);
      return res.status(429).json({ error: `Too many attempts. Locked for ${remaining} more minute(s).` });
    }
    next();
  } catch (e) {
    next();
  }
}

// ─── POST /login ──────────────────────────────────────────────────────────────
router.post('/login', loginRateLimit, async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress;
  const { username, password } = req.body;

  // Use constant-time comparison for both fields to prevent timing attacks
  const validUser = safeEqual(username || '', process.env.ADMIN_USERNAME || '');
  const validPass = safeEqual(password || '', process.env.ADMIN_PASSWORD || '');

  if (!validUser || !validPass) {
    const count = await db.incrementLoginAttempts(ip);
    if (count >= 5) {
      await db.lockoutIP(ip);
      return res.status(429).json({ error: 'Too many failed attempts. Locked for 15 minutes.' });
    }
    return res.status(401).json({ error: `Invalid credentials. ${5 - count} attempt(s) remaining.` });
  }

  await db.resetLoginAttempts(ip);
  req.session.authenticated = true;
  req.session.username = username;
  res.json({ ok: true });
});

// ─── POST /logout ─────────────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ─── GET /api/session ─────────────────────────────────────────────────────────
router.get('/api/session', (req, res) => {
  res.json({ authenticated: !!req.session?.authenticated });
});

module.exports = { router, requireLogin, requireApiKey };

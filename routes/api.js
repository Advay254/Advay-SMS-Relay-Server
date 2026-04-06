// routes/api.js — webhook endpoints for MacroDroid and n8n
const express = require('express');
const router = express.Router();
const db = require('../db');
const queue = require('../queue');
const { requireApiKey } = require('./auth');

// Sanitize input — strip null bytes, trim, limit length
function sanitize(val, maxLen = 4000) {
  if (val === null || val === undefined) return null;
  return String(val).replace(/\0/g, '').trim().slice(0, maxLen);
}

function validatePhone(phone) {
  return /^\+?[\d\s\-().]{7,20}$/.test(phone);
}

// ─── POST /api/sms  (MacroDroid → Server) ────────────────────────────────────
router.post('/sms', requireApiKey, async (req, res) => {
  try {
    const { name, phoneNumber, message } = req.body || {};

    if (!phoneNumber || !message) {
      return res.status(400).json({ error: 'phoneNumber and message are required' });
    }
    if (!validatePhone(phoneNumber)) {
      return res.status(400).json({ error: 'Invalid phoneNumber format' });
    }

    const clean = {
      phoneNumber: sanitize(phoneNumber, 30),
      name: sanitize(name, 100),
      message: sanitize(message),
    };

    const msg = await db.insertMessage({
      phoneNumber: clean.phoneNumber,
      name: clean.name,
      message: clean.message,
      direction: 'inbound',
      rawPayload: req.body,
    });

    // Kick the queue immediately (non-blocking)
    setImmediate(() => queue.processPending());

    res.json({ ok: true, messageId: msg.id });
  } catch (e) {
    console.error('[api/sms]', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/reply  (n8n → Server → MacroDroid) ────────────────────────────
router.post('/reply', requireApiKey, async (req, res) => {
  try {
    const { phoneNumber, message } = req.body || {};

    if (!phoneNumber || !message) {
      return res.status(400).json({ error: 'phoneNumber and message are required' });
    }
    if (!validatePhone(phoneNumber)) {
      return res.status(400).json({ error: 'Invalid phoneNumber format' });
    }

    const clean = {
      phoneNumber: sanitize(phoneNumber, 30),
      message: sanitize(message),
    };

    const msg = await db.insertMessage({
      phoneNumber: clean.phoneNumber,
      name: null,
      message: clean.message,
      direction: 'outbound',
      rawPayload: req.body,
    });

    setImmediate(() => queue.processPending());

    res.json({ ok: true, messageId: msg.id });
  } catch (e) {
    console.error('[api/reply]', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /api/pending-replies  (MacroDroid polls for queued replies) ──────────
// Alternative delivery: MacroDroid can poll instead of receive webhooks
router.get('/pending-replies', requireApiKey, async (req, res) => {
  try {
    const pending = await db.getPendingMessages('outbound');
    res.json({ replies: pending.map(m => ({
      id: m.id,
      phoneNumber: m.phone_number,
      message: m.message,
      createdAt: m.created_at,
    }))});
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/reply-delivered  (MacroDroid confirms delivery) ───────────────
router.post('/reply-delivered', requireApiKey, async (req, res) => {
  try {
    const { messageId } = req.body || {};
    if (!messageId) return res.status(400).json({ error: 'messageId required' });
    await db.updateMessageStatus(sanitize(messageId, 40), 'delivered');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /api/health  (public health check) ──────────────────────────────────
router.get('/health', async (req, res) => {
  try {
    await db.pool.query('SELECT 1');
    const stats = await db.getQueueStats();
    res.json({
      status: 'ok',
      uptime: queue.getUptimeSeconds(),
      queue: stats,
    });
  } catch (e) {
    res.status(503).json({ status: 'error', message: e.message });
  }
});

// ─── UI data endpoints (session-protected) ────────────────────────────────────
const { requireLogin } = require('./auth');

router.get('/ui/messages', requireLogin, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const msgs = await db.getRecentMessages(limit);
  res.json(msgs);
});

router.get('/ui/stats', requireLogin, async (req, res) => {
  const [stats, syncTimes] = await Promise.all([
    db.getQueueStats(),
    db.getLastSyncTimes(),
  ]);
  const n8nUrl = await db.getSetting('n8n_webhook_url');
  const mdUrl = await db.getSetting('macrodroid_webhook_url');
  res.json({
    queue: stats,
    lastSync: syncTimes,
    uptime: queue.getUptimeSeconds(),
    n8nConfigured: !!n8nUrl,
    macrodroidConfigured: !!mdUrl,
  });
});

router.get('/ui/settings', requireLogin, async (req, res) => {
  const all = await db.getAllSettings();
  res.json(all);
});

router.post('/ui/settings', requireLogin, async (req, res) => {
  const { key, value } = req.body || {};
  const allowed = ['n8n_webhook_url', 'macrodroid_webhook_url'];
  if (!allowed.includes(key)) return res.status(400).json({ error: 'Invalid key' });
  if (typeof value !== 'string') return res.status(400).json({ error: 'Invalid value' });
  await db.setSetting(sanitize(key, 50), sanitize(value, 2000));
  res.json({ ok: true });
});

module.exports = router;

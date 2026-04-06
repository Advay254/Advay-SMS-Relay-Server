// queue.js — Retry queue for inbound (→ n8n) and outbound (→ MacroDroid) messages
const axios = require('axios');
const { spawn } = require('child_process');
const path = require('path');
const db = require('./db');

const RETRY_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

let _running = false;
const startTime = Date.now();

// ─── Compress conversation history via Python ─────────────────────────────────
function compressHistory(history, currentMessage, phoneNumber) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ history, currentMessage, phoneNumber });
    const py = spawn('python3', [path.join(__dirname, 'compress.py')]);
    let out = '';
    let err = '';
    py.stdout.on('data', (d) => (out += d));
    py.stderr.on('data', (d) => (err += d));
    py.on('close', () => {
      try {
        resolve(JSON.parse(out));
      } catch {
        console.warn('[compress] parse error:', err || out);
        resolve({ compressed: '', originalTokens: 0, compressedTokens: 0 });
      }
    });
    py.stdin.write(payload);
    py.stdin.end();
    // Timeout safety — 5 seconds max
    setTimeout(() => {
      py.kill();
      resolve({ compressed: '', originalTokens: 0, compressedTokens: 0 });
    }, 5000);
  });
}

// ─── Forward inbound SMS to n8n ──────────────────────────────────────────────
async function forwardToN8n(msg) {
  const n8nUrl = await db.getSetting('n8n_webhook_url');
  if (!n8nUrl) {
    console.warn('[queue] n8n webhook URL not configured, skipping');
    return false;
  }

  const history = await db.getHistory(msg.phone_number);
  const compression = await compressHistory(history, msg.message, msg.phone_number);

  const payload = {
    name: msg.name,
    phoneNumber: msg.phone_number,
    message: msg.message,
    conversationHistory: compression.compressed || null,
    historyTokens: compression.compressedTokens,
    timestamp: msg.created_at,
  };

  try {
    const apiKey = process.env.API_KEY;
    await axios.post(n8nUrl, payload, {
      timeout: 15000,
      headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
    });

    // Save to history
    await db.addToHistory(msg.phone_number, 'user', msg.message);
    await db.updateMessageStatus(msg.id, 'forwarded');
    console.log(`[queue→n8n] Forwarded msg ${msg.id} for ${msg.phone_number}`);
    return true;
  } catch (e) {
    const status = e.response?.status;
    console.warn(`[queue→n8n] Failed msg ${msg.id}: ${e.message}`);
    if (msg.retry_count >= 12) {
      await db.markFailed(msg.id);
    } else {
      await db.bumpRetry(msg.id, msg.retry_count);
    }
    return false;
  }
}

// ─── Forward reply to MacroDroid ─────────────────────────────────────────────
async function forwardToMacroDroid(msg) {
  const mdUrl = await db.getSetting('macrodroid_webhook_url');
  if (!mdUrl) {
    console.warn('[queue] MacroDroid webhook URL not configured, skipping');
    return false;
  }

  const payload = {
    phoneNumber: msg.phone_number,
    message: msg.message,
    messageId: msg.id,
  };

  try {
    const apiKey = process.env.API_KEY;
    await axios.post(mdUrl, payload, {
      timeout: 15000,
      headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
    });

    await db.addToHistory(msg.phone_number, 'assistant', msg.message);
    await db.updateMessageStatus(msg.id, 'delivered');
    console.log(`[queue→MD] Delivered reply ${msg.id} to MacroDroid`);
    return true;
  } catch (e) {
    console.warn(`[queue→MD] Failed reply ${msg.id}: ${e.message}`);
    if (msg.retry_count >= 12) {
      await db.markFailed(msg.id);
    } else {
      await db.bumpRetry(msg.id, msg.retry_count);
    }
    return false;
  }
}

// ─── Process pending queues ───────────────────────────────────────────────────
async function processPending() {
  if (_running) return;
  _running = true;
  try {
    const inbound = await db.getPendingMessages('inbound');
    for (const msg of inbound) {
      await forwardToN8n(msg);
    }

    const outbound = await db.getPendingMessages('outbound');
    for (const msg of outbound) {
      await forwardToMacroDroid(msg);
    }

    await db.cleanExpiredLockouts();
  } catch (err) {
    console.error('[queue] processPending error:', err.message);
  } finally {
    _running = false;
  }
}

function start() {
  processPending(); // immediate first pass
  setInterval(processPending, RETRY_INTERVAL_MS);
  console.log('[queue] Retry worker started (interval: 10 min)');
}

function getUptimeSeconds() {
  return Math.floor((Date.now() - startTime) / 1000);
}

module.exports = { start, processPending, getUptimeSeconds };

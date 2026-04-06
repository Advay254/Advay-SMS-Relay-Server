// db.js — PostgreSQL via Supabase, auto-creates tables on first run
const { Pool } = require('pg');

// ─── SSL fix ──────────────────────────────────────────────────────────────────
// Newer pg-connection-string (v3+) / pg (v9+) treats sslmode=require as
// verify-full, which rejects Supabase's self-signed pooler certificates.
// We strip sslmode from the URL entirely and set ssl via the Pool option so
// rejectUnauthorized: false takes effect without interference.
function buildConnectionString(url) {
  if (!url) return url;
  try {
    const u = new URL(url);
    u.searchParams.delete('sslmode');
    return u.toString();
  } catch {
    // Fallback regex strip for non-standard URL formats
    return url
      .replace(/[?&]sslmode=[^&]*/g, '')
      .replace(/\?$/, '')
      .replace(/&&/g, '&');
  }
}

const pool = new Pool({
  connectionString: buildConnectionString(process.env.DATABASE_URL),
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS messages (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_number TEXT        NOT NULL,
    name         TEXT,
    message      TEXT        NOT NULL,
    direction    TEXT        NOT NULL CHECK (direction IN ('inbound','outbound')),
    status       TEXT        NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending','forwarded','failed','delivered')),
    retry_count  INT         NOT NULL DEFAULT 0,
    next_retry   TIMESTAMPTZ,
    raw_payload  JSONB,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at   TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS conversations (
    phone_number TEXT PRIMARY KEY,
    history      JSONB       NOT NULL DEFAULT '[]',
    updated_at   TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS login_attempts (
    ip           TEXT PRIMARY KEY,
    count        INT         NOT NULL DEFAULT 0,
    locked_until TIMESTAMPTZ,
    updated_at   TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_messages_status      ON messages(status);
  CREATE INDEX IF NOT EXISTS idx_messages_phone       ON messages(phone_number);
  CREATE INDEX IF NOT EXISTS idx_messages_direction   ON messages(direction);
  CREATE INDEX IF NOT EXISTS idx_messages_next_retry  ON messages(next_retry)
    WHERE status = 'pending';
`;

async function init() {
  const client = await pool.connect();
  try {
    await client.query(SCHEMA);
    console.log('[DB] Schema ready');
  } finally {
    client.release();
  }
}

// ─── Settings ────────────────────────────────────────────────────────────────
async function getSetting(key) {
  const r = await pool.query('SELECT value FROM settings WHERE key=$1', [key]);
  return r.rows[0]?.value ?? null;
}

async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO settings(key,value,updated_at) VALUES($1,$2,NOW())
     ON CONFLICT(key) DO UPDATE SET value=$2, updated_at=NOW()`,
    [key, value]
  );
}

async function getAllSettings() {
  const r = await pool.query('SELECT key,value,updated_at FROM settings ORDER BY key');
  return r.rows;
}

// ─── Messages ─────────────────────────────────────────────────────────────────
async function insertMessage({ phoneNumber, name, message, direction, rawPayload }) {
  const r = await pool.query(
    `INSERT INTO messages(phone_number,name,message,direction,status,next_retry,raw_payload)
     VALUES($1,$2,$3,$4,'pending',NOW(),$5) RETURNING *`,
    [phoneNumber, name || null, message, direction, JSON.stringify(rawPayload)]
  );
  return r.rows[0];
}

async function updateMessageStatus(id, status, extraFields = {}) {
  const sets = ['status=$2', 'updated_at=NOW()'];
  const vals = [id, status];
  let i = 3;
  for (const [k, v] of Object.entries(extraFields)) {
    sets.push(`${k}=$${i++}`);
    vals.push(v);
  }
  const r = await pool.query(
    `UPDATE messages SET ${sets.join(',')} WHERE id=$1 RETURNING *`,
    vals
  );
  return r.rows[0];
}

async function getPendingMessages(direction) {
  const r = await pool.query(
    `SELECT * FROM messages
     WHERE direction=$1 AND status='pending'
       AND (next_retry IS NULL OR next_retry <= NOW())
     ORDER BY created_at ASC LIMIT 50`,
    [direction]
  );
  return r.rows;
}

async function bumpRetry(id, retryCount) {
  const nextRetry = new Date(Date.now() + 10 * 60 * 1000); // +10 min
  await pool.query(
    `UPDATE messages SET retry_count=$2, next_retry=$3, updated_at=NOW() WHERE id=$1`,
    [id, retryCount + 1, nextRetry]
  );
}

async function markFailed(id) {
  await pool.query(
    `UPDATE messages SET status='failed', updated_at=NOW() WHERE id=$1`,
    [id]
  );
}

async function getRecentMessages(limit = 100) {
  const r = await pool.query(
    `SELECT * FROM messages ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return r.rows;
}

async function getQueueStats() {
  const r = await pool.query(
    `SELECT direction, status, COUNT(*) AS cnt FROM messages GROUP BY direction, status`
  );
  const stats = { inbound: {}, outbound: {} };
  for (const row of r.rows) {
    stats[row.direction][row.status] = parseInt(row.cnt);
  }
  return stats;
}

async function getLastSyncTimes() {
  const r = await pool.query(
    `SELECT direction, MAX(updated_at) AS last_sync
     FROM messages WHERE status IN ('forwarded','delivered')
     GROUP BY direction`
  );
  const out = {};
  for (const row of r.rows) out[row.direction] = row.last_sync;
  return out;
}

// ─── Conversations ────────────────────────────────────────────────────────────
const MAX_HISTORY = 8;

async function addToHistory(phoneNumber, role, content) {
  // role: 'user' | 'assistant'
  const r = await pool.query(
    `SELECT history FROM conversations WHERE phone_number=$1`,
    [phoneNumber]
  );
  let history = r.rows[0]?.history ?? [];
  history.push({ role, content, ts: new Date().toISOString() });
  if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);

  await pool.query(
    `INSERT INTO conversations(phone_number,history,updated_at) VALUES($1,$2,NOW())
     ON CONFLICT(phone_number) DO UPDATE SET history=$2, updated_at=NOW()`,
    [phoneNumber, JSON.stringify(history)]
  );
  return history;
}

async function getHistory(phoneNumber) {
  const r = await pool.query(
    `SELECT history FROM conversations WHERE phone_number=$1`,
    [phoneNumber]
  );
  return r.rows[0]?.history ?? [];
}

// ─── Login attempts ───────────────────────────────────────────────────────────
async function getLoginAttempts(ip) {
  const r = await pool.query(
    `SELECT count, locked_until FROM login_attempts WHERE ip=$1`,
    [ip]
  );
  return r.rows[0] ?? { count: 0, locked_until: null };
}

async function incrementLoginAttempts(ip) {
  await pool.query(
    `INSERT INTO login_attempts(ip, count, updated_at) VALUES($1, 1, NOW())
     ON CONFLICT(ip) DO UPDATE SET count = login_attempts.count + 1, updated_at=NOW()`,
    [ip]
  );
  const r = await pool.query('SELECT count FROM login_attempts WHERE ip=$1', [ip]);
  return r.rows[0]?.count ?? 1;
}

async function lockoutIP(ip) {
  const until = new Date(Date.now() + 15 * 60 * 1000);
  await pool.query(
    `INSERT INTO login_attempts(ip, count, locked_until, updated_at) VALUES($1, 5, $2, NOW())
     ON CONFLICT(ip) DO UPDATE SET locked_until=$2, updated_at=NOW()`,
    [ip, until]
  );
}

async function resetLoginAttempts(ip) {
  await pool.query('DELETE FROM login_attempts WHERE ip=$1', [ip]);
}

async function cleanExpiredLockouts() {
  await pool.query(
    `DELETE FROM login_attempts WHERE locked_until < NOW() OR (locked_until IS NULL AND updated_at < NOW() - INTERVAL '1 hour')`
  );
}

module.exports = {
  pool, init,
  getSetting, setSetting, getAllSettings,
  insertMessage, updateMessageStatus, getPendingMessages,
  bumpRetry, markFailed, getRecentMessages, getQueueStats, getLastSyncTimes,
  addToHistory, getHistory,
  getLoginAttempts, incrementLoginAttempts, lockoutIP, resetLoginAttempts, cleanExpiredLockouts,
};

# 📡 SMS Relay Server

A smart cloud buffer between **MacroDroid** (Android) and **n8n**, with automatic retry, conversation compression, and a dark-themed admin dashboard.

---

## Architecture

```
MacroDroid (Android)
    │  POST /api/sms  (x-api-key)
    ▼
SMS Relay Server  ◄──────────────────────────────────┐
    │  POST n8n_webhook_url  (x-api-key)             │
    ▼                                                 │
n8n Workflow                                          │
    │  POST /api/reply  (x-api-key)  ────────────────┘
    ▼
MacroDroid sends SMS reply
```

**Retry policy:** If any hop is offline, the server retries every **10 minutes** for up to **2 hours** (12 retries). After that the message is marked `failed`.

---

## Quick Start

### 1. Supabase Setup

1. Create a free project at [supabase.com](https://supabase.com)
2. Go to **Project Settings → Database → Connection string (URI)**
3. Copy the URI — it's your `DATABASE_URL`
4. Tables are created **automatically** on first boot — no SQL to run manually

### 2. Local Development

```bash
git clone <your-repo>
cd sms-relay-server

# Install dependencies
npm install

# Copy and fill env file
cp .env.example .env
nano .env   # fill in all values

# Start server
npm start
# or with auto-reload:
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) — you'll be redirected to `/login`.

### 3. Deploy to Render (Free Tier)

1. Push code to GitHub
2. Go to [render.com](https://render.com) → **New Web Service**
3. Connect your GitHub repo
4. Render auto-detects `render.yaml` — confirm the settings
5. Add environment variables in the **Environment** tab:

| Variable | Value |
|---|---|
| `DATABASE_URL` | Supabase URI (with `?sslmode=require`) |
| `ADMIN_USERNAME` | Your dashboard username |
| `ADMIN_PASSWORD` | Strong password |
| `API_KEY` | Random 32+ char secret |
| `SESSION_SECRET` | Another random 32+ char secret |
| `NODE_ENV` | `production` |
| `PORT` | Leave blank (Render sets it) |

6. Deploy. Visit `https://your-app.onrender.com`

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✅ | Supabase PostgreSQL URI |
| `ADMIN_USERNAME` | ✅ | Dashboard login username |
| `ADMIN_PASSWORD` | ✅ | Dashboard login password |
| `API_KEY` | ✅ | Shared secret for MacroDroid & n8n |
| `SESSION_SECRET` | ✅ | Session encryption key |
| `PORT` | — | Default: 3000 (Render sets automatically) |
| `NODE_ENV` | — | Set to `production` on Render |

Generate secure secrets:
```bash
openssl rand -hex 32
```

---

## MacroDroid Setup

### Trigger: Incoming SMS → Server

Create a macro:
- **Trigger:** SMS Received
- **Action:** HTTP Request
  - Method: `POST`
  - URL: `https://your-app.onrender.com/api/sms`
  - Headers: `x-api-key: <your API_KEY>`, `Content-Type: application/json`
  - Body:
    ```json
    {
      "name": "[contact_name]",
      "phoneNumber": "[sender_number]",
      "message": "[message_text]"
    }
    ```
  - **Retry:** Every 10 minutes if request fails (MacroDroid retry macro)

### Action: Receive Reply → Send SMS

Create a second macro (webhook trigger):
- **Trigger:** Webhook (MacroDroid cloud URL or local)
- **Action:** Send SMS
  - Phone: `[webhook_phoneNumber]`
  - Message: `[webhook_message]`

Register your MacroDroid webhook URL in the dashboard under **Webhooks → MacroDroid Webhook URL**.

---

## n8n Setup

### Receive Incoming SMS

- **Trigger node:** Webhook
  - Method: `POST`
  - Authentication: Header Auth → `x-api-key: <your API_KEY>`
- Available fields: `name`, `phoneNumber`, `message`, `conversationHistory`, `historyTokens`, `timestamp`

### Send a Reply

Add an **HTTP Request node** at the end of your flow:
- Method: `POST`
- URL: `https://your-app.onrender.com/api/reply`
- Headers: `x-api-key: <your API_KEY>`
- Body:
  ```json
  {
    "phoneNumber": "{{ $json.phoneNumber }}",
    "message": "Your AI-generated reply here"
  }
  ```

---

## API Reference

All endpoints require `x-api-key` header except `/api/health`.

### `POST /api/sms` — MacroDroid → Server
```json
{
  "name": "John Doe",
  "phoneNumber": "+254712345678",
  "message": "Hello"
}
```
Response: `{ "ok": true, "messageId": "uuid" }`

### `POST /api/reply` — n8n → Server
```json
{
  "phoneNumber": "+254712345678",
  "message": "Hello back!"
}
```
Response: `{ "ok": true, "messageId": "uuid" }`

### `GET /api/pending-replies` — MacroDroid polls
Returns list of pending replies MacroDroid should send.

### `POST /api/reply-delivered` — MacroDroid confirms
```json
{ "messageId": "uuid" }
```

### `GET /api/health` — Public health check
```json
{ "status": "ok", "uptime": 3600, "queue": { ... } }
```

---

## Dashboard Pages

| Page | URL | Description |
|---|---|---|
| Login | `/login` | Rate-limited (5 attempts → 15 min lockout) |
| Dashboard | `/dashboard` | Live message log, delivery status |
| Webhooks | `/webhooks` | Register n8n & MacroDroid URLs |
| Health | `/health-page` | Uptime, queue stats, last sync times |

---

## Conversation Compression

The server calls `compress.py` (Python 3) before forwarding each SMS to n8n:

- Reads the last **8 messages** per phone number from the database
- Strips filler words and truncates long messages
- Falls back gracefully if Python is unavailable
- Compressed history is sent as `conversationHistory` (plain text) + `historyTokens` (estimated count)

**Example:** 3,000 raw tokens → ~200–400 compressed tokens

---

## Security

- Session-based auth with HttpOnly, SameSite=Strict cookies
- Brute-force protection: 5 failed logins → 15 min IP lockout
- All webhook endpoints protected by `x-api-key` header
- Input sanitization: null bytes stripped, length limits enforced
- Phone number format validation
- Parameterized SQL queries (no string interpolation)
- No secrets in code — all via environment variables

---

## Database Schema

Tables created automatically on first boot:

| Table | Purpose |
|---|---|
| `messages` | All SMS (inbound & outbound), status, retry count |
| `conversations` | Last 8 messages per phone number (for context) |
| `settings` | n8n & MacroDroid webhook URLs |
| `login_attempts` | Brute-force tracking per IP |

---

## Folder Structure

```
sms-relay-server/
├── server.js          # Express app entry point
├── db.js              # Database layer (auto-migration)
├── queue.js           # Retry worker + n8n/MacroDroid forwarding
├── compress.py        # Python conversation compressor
├── routes/
│   ├── auth.js        # Login/logout + middleware
│   └── api.js         # Webhook & UI API endpoints
├── public/
│   ├── login.html     # Login page
│   ├── dashboard.html # Main dashboard
│   ├── webhooks.html  # Webhook settings
│   ├── health.html    # System health
│   └── shared.css     # Design system
├── render.yaml        # Render deployment config
├── package.json
├── .env.example
└── .gitignore
```

---

## Free Tier Notes (Render)

- Render free tier **spins down** after 15 min of inactivity
- On spin-up, the retry worker restarts and processes any queued messages
- MacroDroid should be configured to retry on failure — the server will buffer messages
- Use Render's **health check path** `/api/health` to keep it warm (or use UptimeRobot free tier to ping every 5 min)

---

## Troubleshooting

**Server won't start:** Check `DATABASE_URL` is correct and Supabase allows connections.

**Messages stuck in pending:** Check n8n webhook URL is correct in the Webhooks page. Check n8n is running and the API key matches.

**MacroDroid not receiving replies:** Verify the MacroDroid webhook URL is registered. Check MacroDroid macro is listening on that webhook trigger.

**Login locked out:** Wait 15 minutes, or delete the row from the `login_attempts` table in Supabase.

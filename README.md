# PingPulse

Network monitoring system that tracks latency, packet loss, and throughput across distributed endpoints. Combines a Rust client daemon with a Cloudflare Workers backend and React dashboard.

## Architecture

```
+------------------+        WebSocket         +---------------------------+
|  Rust Client     | -----------------------> |  Cloudflare Worker        |
|  (daemon on      |  pings, speed tests,     |  (Hono + Durable Objects) |
|   target machine)|  heartbeats              |                           |
+------------------+                          |  D1 (SQLite) for data     |
                                              |  R2 for archives          |
                                              |  Analytics Engine         |
                                              +---------------------------+
                                                        |
                                                        | serves
                                                        v
                                              +---------------------------+
                                              |  React Dashboard          |
                                              |  (Vite + Tailwind + uPlot)|
                                              +---------------------------+
```

**Three-tier system:**
1. **Rust Client Daemon** -- Runs on target machines as a system service (launchd/systemd/Windows Service). Connects via WebSocket to backend. Performs pings and speed tests.
2. **Cloudflare Workers + Durable Objects** -- One `ClientMonitor` Durable Object per registered client. Stores metrics in D1, archives old data to R2, sends alerts via email (Resend) and Telegram.
3. **React Dashboard** -- SPA served by the Worker. JWT-based admin auth. Displays metrics, manages clients, configures alerts.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Client | Rust, Tokio, tokio-tungstenite (WebSocket), reqwest, clap, axum (local agent API) |
| Backend | Cloudflare Workers, Hono, Durable Objects, D1 (SQLite), R2, Analytics Engine |
| Dashboard | React 19, React Router 7, Vite 8, Tailwind CSS 4, uPlot |
| Alerts | Resend (email), Telegram Bot API |
| CI/CD | GitHub Actions, Bun, Wrangler |
| Builds | Bun (worker/dashboard), Cargo (client) |

## Repository Structure

```
pingpulse/
+-- client/                     # Rust client daemon
|   +-- src/
|   |   +-- main.rs             # CLI entry point (register, start, stop, status, uninstall, agent)
|   |   +-- daemon.rs           # Background daemon with WebSocket connection
|   |   +-- speedtest.rs        # Download/upload speed test logic
|   |   +-- agent.rs            # Local HTTP management API (port 9111)
|   |   +-- service.rs          # OS service install (launchd/systemd/Windows)
|   |   +-- config.rs           # Config file management
|   |   +-- register.rs         # Token-based registration
|   |   +-- logging.rs          # Structured logging
|   +-- Cargo.toml
|
+-- worker/                     # Cloudflare Worker backend
|   +-- src/
|   |   +-- index.ts            # Worker entry point (Hono app)
|   |   +-- api/
|   |   |   +-- auth.ts         # Login/logout/session endpoints
|   |   |   +-- clients.ts      # Client CRUD + config management
|   |   |   +-- metrics.ts      # Historical metrics queries
|   |   |   +-- alerts.ts       # Alert thresholds + listing
|   |   |   +-- speedtest.ts    # On-demand speed test triggers + payload endpoints
|   |   |   +-- export.ts       # CSV/JSON export from R2
|   |   |   +-- command.ts      # Send commands to Durable Objects
|   |   +-- durable-objects/
|   |   |   +-- client-monitor.ts   # Per-client Durable Object (pings, state machine)
|   |   +-- services/
|   |   |   +-- alert-dispatch.ts   # Email (Resend) + Telegram alert delivery
|   |   |   +-- archiver.ts        # D1 -> R2 data archival
|   |   +-- middleware/
|   |   |   +-- auth.ts            # JWT verification middleware
|   |   |   +-- rate-limit.ts      # Per-IP rate limiting
|   |   +-- utils/
|   +-- dashboard/              # React SPA
|   |   +-- src/
|   |   |   +-- pages/          # Login, Overview, ClientDetail, Clients, Alerts, Settings
|   |   |   +-- components/     # ClientCard, LatencyChart, ThroughputChart, etc.
|   |   |   +-- lib/            # API client, auth helpers, formatters
|   |   +-- package.json
|   +-- migrations/
|   |   +-- 0001_initial.sql
|   |   +-- 0002_add_client_version.sql
|   +-- wrangler.toml
|   +-- package.json
|
+-- docs/                       # Design specs and implementation plans
+-- install.sh                  # One-liner install script (macOS/Linux)
+-- install.ps1                 # One-liner install script (Windows)
+-- .github/workflows/
    +-- deploy-worker.yml       # Auto-deploy worker on push to master
    +-- release-client.yml      # Auto-build + release client binaries
```

---

# New Company Setup Guide

Complete guide to deploying PingPulse for a new organization from scratch.

## Prerequisites

- **Cloudflare account** (free plan works; paid plan needed only for higher limits)
- **GitHub repository** (fork or clone of this repo)
- **Domain** pointed to Cloudflare (or use a workers.dev subdomain)
- **Bun** installed locally: `curl -fsSL https://bun.sh/install | bash`
- **Rust toolchain** (only if building client locally): `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- **Wrangler CLI**: `bun install -g wrangler`

## Step 1: Cloudflare Resources

Login to Wrangler and create the required resources:

```bash
# Authenticate with Cloudflare
wrangler login

# Create D1 database
wrangler d1 create pingpulse-db
# Note the database_id from output

# Create R2 bucket
wrangler r2 bucket create pingpulse-archive

# Create Analytics Engine dataset (via Cloudflare dashboard)
# Go to: Workers & Pages > Analytics Engine > Create dataset named "pingpulse-metrics"
```

## Step 2: Configure wrangler.toml

Edit `worker/wrangler.toml` with your values:

```toml
name = "pingpulse"
main = "src/index.ts"
compatibility_date = "2025-12-01"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "DB"
database_name = "pingpulse-db"
database_id = "YOUR_DATABASE_ID_HERE"         # <-- from Step 1

[[r2_buckets]]
binding = "ARCHIVE"
bucket_name = "pingpulse-archive"

[[analytics_engine_datasets]]
binding = "METRICS"
dataset = "pingpulse-metrics"

[durable_objects]
bindings = [
  { name = "CLIENT_MONITOR", class_name = "ClientMonitor" }
]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["ClientMonitor"]

# Option A: Custom domain (requires domain on Cloudflare)
[[routes]]
pattern = "ping.yourdomain.com"
custom_domain = true

# Option B: Use workers.dev subdomain instead (remove the [[routes]] block above)
# Your app will be at: https://pingpulse.YOUR_SUBDOMAIN.workers.dev

[triggers]
crons = ["0 */6 * * *"]        # Speed tests + archival every 6 hours

[assets]
directory = "./dashboard/dist"
not_found_handling = "single-page-application"

[vars]
LATEST_CLIENT_VERSION = "0.2.3"
```

## Step 3: Set Secrets

```bash
cd worker

# Required: JWT signing secret (generate a strong random string)
echo "YOUR_RANDOM_SECRET_HERE" | wrangler secret put ADMIN_JWT_SECRET

# Optional: Email alerts via Resend (https://resend.com)
echo "re_YOUR_KEY" | wrangler secret put RESEND_API_KEY
echo "PingPulse <alerts@yourdomain.com>" | wrangler secret put ALERT_FROM_EMAIL
echo "admin@yourdomain.com" | wrangler secret put ALERT_TO_EMAIL

# Optional: Telegram alerts
echo "YOUR_BOT_TOKEN" | wrangler secret put TELEGRAM_BOT_TOKEN
echo "YOUR_CHAT_ID" | wrangler secret put TELEGRAM_CHAT_ID
```

**Generating a JWT secret:**
```bash
openssl rand -base64 32
```

**Setting up Telegram alerts (automated):**
```bash
# Run the setup script — it handles token validation, chat ID discovery, and secret configuration
./setup-telegram.sh
```

The script will:
1. Ask you to paste your bot token (get one from [@BotFather](https://t.me/BotFather) — send `/newbot`)
2. Validate the token against Telegram's API
3. Wait for you to message the bot, then auto-discover your chat ID
4. Set both `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` as Wrangler secrets
5. Send a confirmation message to your Telegram

## Step 4: Run Database Migrations

```bash
cd worker

# Apply migrations to production D1
wrangler d1 execute pingpulse-db --remote --file=migrations/0001_initial.sql
wrangler d1 execute pingpulse-db --remote --file=migrations/0002_add_client_version.sql
```

## Step 5: Set Admin Password

The first time you visit the dashboard login page, you'll be prompted to set an admin password. Alternatively, you can set it via D1 directly:

```bash
# Generate a bcrypt hash of your password, then insert:
wrangler d1 execute pingpulse-db --remote --command \
  "INSERT INTO admin (id, password_hash, created_at) VALUES (1, 'YOUR_BCRYPT_HASH', datetime('now'))"
```

Or just deploy and use the dashboard -- it handles first-time setup automatically.

## Step 6: Deploy

```bash
cd worker

# Install dependencies
bun install
cd dashboard && bun install && cd ..

# Build dashboard and deploy
bun run deploy
```

Your dashboard is now live at your configured domain or `https://pingpulse.YOUR_SUBDOMAIN.workers.dev`.

## Step 7: Set Up CI/CD (GitHub Actions)

Add these secrets to your GitHub repository (Settings > Secrets > Actions):

| Secret | Value |
|--------|-------|
| `CLOUDFLARE_API_TOKEN` | API token with Workers/D1/R2 permissions |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID |

**Creating the Cloudflare API Token:**
1. Go to [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens)
2. Create token with permissions:
   - **Account** > Workers Scripts > Edit
   - **Account** > Workers KV Storage > Edit
   - **Account** > Workers R2 Storage > Edit
   - **Account** > D1 > Edit
   - **Account** > Account Analytics > Edit

Once configured, the CI/CD workflows handle everything automatically:
- **Worker deploys** on push to `master` when `worker/**` files change
- **Client releases** on push to `master` when `client/**` files change (builds cross-platform binaries and creates GitHub releases)

---

# Installing Clients

## Option A: One-Liner Install (Recommended)

First, generate a registration token from the dashboard (Clients page > Register New Client). Tokens expire in 15 minutes and are single-use.

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/BaruchEric/pingpulse/master/install.sh | bash -s -- \
  --token "TOKEN_FROM_DASHBOARD" \
  --server "https://ping.yourdomain.com"
```

**Windows (PowerShell as Administrator):**
```powershell
irm https://raw.githubusercontent.com/BaruchEric/pingpulse/master/install.ps1 | iex -token "TOKEN_FROM_DASHBOARD" -server "https://ping.yourdomain.com"
```

The install script will:
1. Download the correct binary for your OS/architecture
2. Install to `/usr/local/bin` (Unix) or `%LOCALAPPDATA%\pingpulse` (Windows)
3. Prompt for client name and location
4. Register with the server
5. Start the daemon as a system service

## Option B: Manual Install

```bash
# Download from GitHub releases
curl -L https://github.com/BaruchEric/pingpulse/releases/latest/download/pingpulse-darwin-arm64.tar.gz | tar xz
sudo mv pingpulse /usr/local/bin/

# Register
pingpulse register \
  --token "TOKEN_FROM_DASHBOARD" \
  --name "Office Router" \
  --location "NYC Office" \
  --server "https://ping.yourdomain.com"

# Start as background service
pingpulse start
```

## Client CLI Reference

```bash
pingpulse register    # Register with server using a one-time token
pingpulse start       # Start daemon as system service (launchd/systemd/Windows Service)
pingpulse start --foreground  # Run in foreground (useful for debugging)
pingpulse stop        # Stop the daemon
pingpulse status      # Show connection status and config
pingpulse uninstall   # Stop daemon, remove service, clean up all files
pingpulse agent       # Start local management API on port 9111
```

## Available Client Binaries

| Platform | Architecture | Artifact |
|----------|-------------|----------|
| macOS | ARM64 (Apple Silicon) | `pingpulse-darwin-arm64.tar.gz` |
| Linux | x86_64 | `pingpulse-linux-amd64.tar.gz` |
| Linux | ARM64 | `pingpulse-linux-arm64.tar.gz` |
| Windows | x86_64 | `pingpulse-windows-amd64.zip` |

## Client Configuration

Config is stored at `~/.pingpulse/config.toml` after registration:

```toml
client_id = "abc123"
secret = "client_secret_here"
server_url = "https://ping.yourdomain.com"
name = "Office Router"
location = "NYC Office"
```

Configuration is pushed from the dashboard via WebSocket. Configurable parameters:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `ping_interval_s` | 30 | Seconds between pings |
| `speed_test_interval_s` | 300 | Seconds between probe speed tests |
| `probe_size_bytes` | 262144 (256KB) | Payload size for probe speed tests |
| `full_test_schedule` | `0 */6 * * *` | Cron for full speed tests |
| `full_test_payload_bytes` | 10485760 (10MB) | Payload for full speed tests |
| `alert_latency_threshold_ms` | 100 | Latency alert threshold |
| `alert_loss_threshold_pct` | 5 | Packet loss alert threshold |
| `grace_period_s` | 60 | Grace period before alerting |

---

# API Reference

Base URL: `https://ping.yourdomain.com`

## Authentication

Admin endpoints require a JWT session cookie set via the login endpoint.

### POST /api/auth/login
```json
{ "password": "your_admin_password" }
```
Returns a `session` HTTP-only cookie (24h expiry).

### POST /api/auth/logout
Clears the session cookie.

### GET /api/auth/me
Returns current session info or 401.

## Client Registration

### POST /api/auth/register
Exchange a one-time token for client credentials.
```json
{
  "token": "registration_token",
  "name": "My Server",
  "location": "US-East"
}
```
Response:
```json
{
  "client_id": "abc123",
  "secret": "client_secret"
}
```

## Clients

### GET /api/clients
List all clients with current stats (last_seen, latency, loss, status).

### GET /api/clients/:id
Get single client details.

### PUT /api/clients/:id
Update client config (name, location, ping_interval_s, speed_test_interval_s, alert thresholds, etc.).

### DELETE /api/clients/:id
Delete a client and all its data.

### DELETE /api/clients/:id/self
Client self-deletion (authenticated with client secret, not admin JWT).

## Metrics

### GET /api/clients/:id/metrics?from=ISO&to=ISO
Historical metrics including pings, speed tests, and outages within time range.

### GET /api/clients/:id/logs?page=1&limit=50
Paginated detailed ping/speed test logs.

## Alerts

### GET /api/alerts
List all alerts across all clients.

### PUT /api/alerts
Update global alert thresholds.

### POST /api/alerts/test
Send a test alert to verify email/Telegram configuration.

## Speed Tests

### POST /api/speedtest/:id
Trigger an on-demand speed test for a client. Rate limited: 1 per client per 5 minutes.

## Data Export

### GET /api/export/:id?format=csv|json&from=ISO&to=ISO
Export historical data from R2 archive.

## Speed Test Payload Endpoints (Client-Facing)

### GET /speedtest/download?size=BYTES
Download test payload for speed measurement.

### POST /speedtest/upload
Upload test payload for speed measurement.

## WebSocket

### /ws/:clientId
Client daemon connection. Requires `Authorization: Bearer <client_secret>` header.

Messages from server:
- `config_update` -- Updated client configuration
- `ping` -- Ping request (client measures RTT and responds)
- `trigger_speed_test` -- Server requests a speed test

Messages from client:
- `pong` -- Ping response with RTT measurement
- `speed_test_result` -- Speed test results (download/upload Mbps)

## Rate Limits

| Endpoint | Limit |
|----------|-------|
| Global | 60 requests/min per IP |
| POST /api/auth/login | 5 attempts/min per IP |
| POST /api/speedtest/:id | 10 requests/min overall, 1 per client per 5min |

---

# Alert System

## Alert Types

| Type | Severity | Trigger |
|------|----------|---------|
| `client_down` | critical | Client disconnected beyond grace period |
| `client_up` | info | Client reconnected after outage |
| `high_latency` | warning | RTT exceeds threshold |
| `latency_recovered` | info | RTT returned to normal |
| `packet_loss` | warning | Loss % exceeds threshold |
| `speed_degradation` | warning | Speed test below expected baseline |

## Channels

- **Email** via [Resend](https://resend.com) -- requires `RESEND_API_KEY`, `ALERT_FROM_EMAIL`, `ALERT_TO_EMAIL`
- **Telegram** via Bot API -- requires `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`

Both channels are optional. Configure one, both, or neither.

---

# Data Retention

| Storage | Retention | Data |
|---------|-----------|------|
| D1 (SQLite) | 30 days | Ping results, speed tests, outages, alerts |
| Analytics Engine | 90 days | Aggregated metrics |
| R2 (Object Storage) | Unlimited | Archived raw data (CSV/JSON export) |

Archival runs automatically every 6 hours via the cron trigger.

---

# Database Schema

## Tables

| Table | Purpose |
|-------|---------|
| `clients` | Registered client machines (id, name, location, config, last_seen, version) |
| `ping_results` | Individual ping measurements (rtt_ms, jitter_ms, direction, status) |
| `speed_tests` | Speed test results (download/upload Mbps, payload size, duration) |
| `outages` | Detected outage periods (start, end, duration) |
| `alerts` | Alert history (type, severity, value, threshold, delivery status) |
| `registration_tokens` | One-time registration tokens (15min expiry) |
| `admin` | Admin credentials (bcrypt hash) |
| `rate_limits` | Per-IP rate limiting state |

---

# Local Development

## Worker

```bash
cd worker

# Install dependencies
bun install
cd dashboard && bun install && cd ..

# Start local dev server (with D1 local database)
bun run dev

# In a separate terminal, start dashboard dev server with HMR
bun run dev:dashboard
```

The worker dev server runs at `http://localhost:8787`.
The dashboard dev server runs at `http://localhost:5173` (proxies API calls to worker).

## Client

```bash
cd client

# Build
cargo build

# Run in foreground for development
cargo run -- start --foreground

# Run tests
cargo test
```

## Worker Tests

```bash
cd worker
bun run test
```

---

# Troubleshooting

## Client won't connect
- Check `~/.pingpulse/config.toml` has correct `server_url`
- Check `~/.pingpulse/logs/` for error details
- Run `pingpulse start --foreground` to see real-time logs
- Verify the registration token hasn't expired (15min window)

## Client shows as offline in dashboard
- Check client is running: `pingpulse status`
- WebSocket may have disconnected -- client auto-reconnects with exponential backoff
- Check the server logs: `wrangler tail` (live logs from Worker)

## Alerts not delivering
- Test with `POST /api/alerts/test`
- Check Resend API key is valid and domain is verified
- Check Telegram bot token and chat ID are correct
- The bot must have been messaged at least once before it can send to the chat

## Speed tests timing out
- Default full test uses 10MB payload -- may be too large for slow connections
- Adjust `full_test_payload_bytes` and `probe_size_bytes` in dashboard client config

## Dashboard login issues
- JWT cookie requires HTTPS in production (HTTP works on localhost)
- Clear browser cookies and try again
- Check `ADMIN_JWT_SECRET` is set as a Wrangler secret

---

# AI Agent Guide

Instructions for AI coding agents (Claude Code, Cursor, Copilot, etc.) working on this codebase.

## Project Context

PingPulse is a network monitoring tool. The codebase has two main parts:
- **`/client`** -- Rust binary (Cargo project)
- **`/worker`** -- Cloudflare Worker (TypeScript + Hono) with an embedded React dashboard

## Getting Started for AI Agents

### 1. Understand the Architecture
- Backend is a **Cloudflare Worker** using **Hono** framework, NOT Express/Next.js/Node.js
- Database is **Cloudflare D1** (SQLite), NOT Postgres/MySQL
- Real-time communication uses **WebSocket** via Durable Objects
- Dashboard is a **Vite + React SPA**, NOT Next.js
- Client is a **Rust binary**, NOT Node.js

### 2. Key Files to Read First
```
worker/src/index.ts                    # All routes and middleware setup
worker/src/durable-objects/client-monitor.ts  # Core monitoring logic
worker/src/api/*.ts                    # API endpoint handlers
worker/dashboard/src/pages/*.tsx       # Dashboard pages
worker/dashboard/src/components/*.tsx  # Reusable UI components
client/src/main.rs                     # Client CLI and subcommands
client/src/daemon.rs                   # WebSocket client logic
```

### 3. Development Commands
```bash
# Worker development
cd worker
bun install                            # Install deps
bun run dev                            # Start worker locally (port 8787)
bun run dev:dashboard                  # Start dashboard with HMR (port 5173)
bun run test                           # Run worker tests
bun run deploy                         # Build dashboard + deploy to Cloudflare

# Client development
cd client
cargo build                            # Build client
cargo test                             # Run client tests
cargo run -- start --foreground        # Run client in foreground
```

### 4. Important Patterns

**Hono Route Handlers (Worker)**
```typescript
// All routes are in worker/src/api/*.ts
// They receive Hono context with D1, R2, Durable Object bindings:
app.get('/api/clients', authMiddleware, async (c) => {
  const db = c.env.DB;  // D1 database
  const results = await db.prepare('SELECT * FROM clients').all();
  return c.json(results);
});
```

**Durable Object Communication**
```typescript
// To send a command to a specific client's Durable Object:
const id = c.env.CLIENT_MONITOR.idFromName(clientId);
const stub = c.env.CLIENT_MONITOR.get(id);
await stub.fetch(new Request('http://internal/trigger-speed-test'));
```

**Dashboard API Calls**
```typescript
// Dashboard uses fetch() with credentials: 'include' for JWT cookies
const res = await fetch('/api/clients', { credentials: 'include' });
```

### 5. Common Tasks

**Adding a new API endpoint:**
1. Create or edit a file in `worker/src/api/`
2. Register the route in `worker/src/index.ts`
3. Add auth middleware if needed: `authMiddleware` from `worker/src/middleware/auth.ts`

**Adding a new dashboard page:**
1. Create page component in `worker/dashboard/src/pages/`
2. Add route in `worker/dashboard/src/App.tsx`
3. Add nav link in the layout component

**Modifying client behavior:**
1. Edit relevant Rust source in `client/src/`
2. If adding a new config field, update:
   - `worker/src/durable-objects/client-monitor.ts` (server sends config)
   - `client/src/config.rs` (client reads config)
   - `worker/dashboard/src/components/EditClientDialog.tsx` (UI to edit)

**Adding a new database table/column:**
1. Create new migration file: `worker/migrations/NNNN_description.sql`
2. Apply locally: `wrangler d1 execute pingpulse-db --local --file=migrations/NNNN_description.sql`
3. Apply to production: `wrangler d1 execute pingpulse-db --remote --file=migrations/NNNN_description.sql`

### 6. Environment & Bindings

The Worker has these Cloudflare bindings available on `c.env`:

| Binding | Type | Usage |
|---------|------|-------|
| `DB` | D1 Database | SQLite queries |
| `ARCHIVE` | R2 Bucket | Data archival and export |
| `METRICS` | Analytics Engine | Time-series aggregation |
| `CLIENT_MONITOR` | Durable Object Namespace | Per-client monitoring state |
| `ADMIN_JWT_SECRET` | Secret | JWT signing key |
| `RESEND_API_KEY` | Secret | Email alert delivery |
| `ALERT_FROM_EMAIL` | Variable | Alert sender address |
| `ALERT_TO_EMAIL` | Variable | Alert recipient address |
| `TELEGRAM_BOT_TOKEN` | Secret | Telegram alert delivery |
| `TELEGRAM_CHAT_ID` | Variable | Telegram chat for alerts |
| `LATEST_CLIENT_VERSION` | Variable | For client update notifications |

### 7. Testing

```bash
# Worker tests use @cloudflare/vitest-pool-workers
cd worker && bun run test

# Client tests use standard Rust test framework
cd client && cargo test
```

### 8. Deployment Checklist

- [ ] `wrangler.toml` has correct `database_id` and domain
- [ ] All secrets set via `wrangler secret put`
- [ ] D1 migrations applied to production
- [ ] GitHub Actions secrets configured (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`)
- [ ] Domain DNS pointed to Cloudflare (if using custom domain)
- [ ] Admin password set on first dashboard login
- [ ] Test alert delivery with `POST /api/alerts/test`

### 9. Do NOT

- Do **not** use `npm` or `yarn` -- use `bun` for everything
- Do **not** use `node:fs` or Node.js APIs in the Worker -- use Cloudflare Workers APIs
- Do **not** use Express patterns -- this is Hono on Cloudflare Workers
- Do **not** add `dotenv` -- Bun loads `.env` automatically
- Do **not** modify `wrangler.toml` database_id in commits -- it's environment-specific
- Do **not** store secrets in `[vars]` in wrangler.toml -- use `wrangler secret put`

### 10. File Path Alias

Always use `@/` path alias for imports in the dashboard code (configured in Vite/TypeScript).

# PingPulse

Network monitoring system that tracks latency, packet loss, and throughput across distributed endpoints. Combines a Rust client daemon with a Convex backend and React dashboard.

## Architecture

```
+------------------+      HTTP heartbeat      +---------------------------+
|  Rust Client     | -----------------------> |  Convex backend           |
|  (daemon on      |  RTT, probes,            |  (queries/mutations/      |
|   target machine)|  speed tests             |   actions + HTTP router)  |
+------------------+  <-----------------------|                           |
                      config + queued commands|  Convex tables for data   |
                                              |  crons: down detection,   |
                                              |  retention, health reports|
                                              +---------------------------+
                                                        ^
                                                        | REST over HTTPS
                                                        v
                                              +---------------------------+
                                              |  React Dashboard          |
                                              |  (Vite + Tailwind + uPlot)|
                                              +---------------------------+
```

**Three-tier system:**
1. **Rust Client Daemon** -- Runs on target machines as a system service (launchd/systemd/Windows Service). POSTs an HTTP heartbeat every ping interval, reporting measured RTT and pulling config + queued admin commands in the response. Performs ICMP/HTTP probes and speed tests.
2. **Convex backend** -- Queries/mutations/actions plus an HTTP router (`convex/http.ts`) that exposes a REST API at `https://<deployment>.convex.site`. Stores metrics in Convex tables. Crons handle down/up detection, retention, and scheduled health reports; alert delivery (email via Resend, Telegram) runs in scheduled actions.
3. **React Dashboard** -- Standalone SPA. Bearer-JWT admin auth. Displays metrics, manages clients, configures alerts.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Client | Rust, Tokio, reqwest (HTTP), clap, axum (local agent API) |
| Backend | Convex (TypeScript functions, document DB, HTTP actions, crons, scheduler) |
| Dashboard | React 19, React Router 7, Vite 8, Tailwind CSS 4, uPlot |
| Alerts | Resend (email), Telegram Bot API |
| CI/CD | GitHub Actions, Bun, Convex CLI |
| Builds | Bun (convex/dashboard), Cargo (client) |

## Repository Structure

```
pingpulse/
+-- client/                     # Rust client daemon
|   +-- src/
|   |   +-- main.rs             # CLI entry point (register, start, stop, status, uninstall, agent)
|   |   +-- heartbeat.rs        # HTTP heartbeat loop, command dispatch, self-update
|   |   +-- speed_test.rs       # Download/upload speed test logic + result reporting
|   |   +-- agent.rs            # Local HTTP management API (port 9111)
|   |   +-- service.rs          # OS service install (launchd/systemd/Windows)
|   |   +-- config.rs           # Config file management
|   |   +-- messages.rs         # Heartbeat request/response + command types
|   |   +-- store.rs            # SQLite probe storage + sync + connectivity events
|   |   +-- sync.rs             # Batch sync of probe results + connectivity events to server
|   |   +-- probe.rs            # ICMP and HTTP probe engine
|   |   +-- logger.rs           # Structured logging
|   +-- Cargo.toml
|
+-- convex/                     # Convex backend
|   +-- schema.ts               # Tables (clients, pingResults, speedTests, outages, alerts, ...)
|   +-- http.ts                 # HTTP router — REST API at /api/* and speed-test payloads
|   +-- auth.ts                 # Admin login/bootstrap + client registration
|   +-- clients.ts              # Client CRUD, stats, cascade delete, retention purge
|   +-- ingest.ts               # heartbeat, probe sync, speed-test result, connectivity
|   +-- commands.ts             # Admin command enqueue + client status
|   +-- metrics.ts              # Metrics, logs, probes, sync-status, export queries
|   +-- analysis.ts             # Deep-analysis aggregations
|   +-- alerts.ts               # Alert trigger/dedup, listing, thresholds
|   +-- alertDispatch.ts        # Email (Resend) + Telegram delivery (scheduled action)
|   +-- monitor.ts              # Down/up detection (30s cron)
|   +-- maintenance.ts          # Speed-test fan-out, retention, health reports (6h cron)
|   +-- telegram.ts             # Telegram bot webhook + commands
|   +-- crons.ts                # Cron definitions
|   +-- _generated/             # Committed codegen (regenerate with `npx convex dev`)
|
+-- dashboard/                  # React SPA
|   +-- src/
|   |   +-- pages/              # Login, Overview, ClientDetail, Clients, Alerts, Settings
|   |   +-- components/         # ClientCard, LatencyChart, ThroughputChart, etc.
|   |   +-- lib/                # API client (VITE_API_URL + Bearer token), hooks, formatters
|   +-- package.json
|
+-- package.json                # Convex deps + repo scripts (typecheck/lint/deploy)
+-- docs/                       # Design specs and implementation plans
+-- install.sh                  # One-liner install script (macOS/Linux)
+-- install.ps1                 # One-liner install script (Windows)
+-- .github/workflows/
    +-- deploy-convex.yml       # Auto-deploy Convex + dashboard build on push to master
    +-- release-client.yml      # Auto-build + release client binaries
```

---

# New Company Setup Guide

Complete guide to deploying PingPulse for a new organization from scratch.

## Prerequisites

- **Convex account** (free plan works) — sign up at [convex.dev](https://convex.dev)
- **GitHub repository** (fork or clone of this repo)
- **A static host** for the dashboard SPA (Netlify, Vercel, Cloudflare Pages, etc.)
- **Bun** installed locally: `curl -fsSL https://bun.sh/install | bash`
- **Rust toolchain** (only if building client locally): `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`

## Step 1: Create the Convex Project

```bash
# From the repo root — installs the convex dependency
bun install

# Configure a Convex project and push the schema + functions.
# This is interactive the first time (login + project selection) and
# generates convex/_generated/.
npx convex dev --once
```

Note your deployment's HTTP actions URL — it looks like
`https://<deployment-name>.convex.site`. The dashboard and clients call this URL.

## Step 2: Set Environment Variables

```bash
# Required: JWT signing secret (generate a strong random string)
npx convex env set ADMIN_JWT_SECRET "$(openssl rand -base64 32)"

# The latest client version (drives the dashboard "update available" prompt)
npx convex env set LATEST_CLIENT_VERSION "1.0.5"

# Optional: Email alerts via Resend (https://resend.com)
npx convex env set RESEND_API_KEY "re_YOUR_KEY"
npx convex env set ALERT_FROM_EMAIL "PingPulse <alerts@yourdomain.com>"
npx convex env set ALERT_TO_EMAIL "admin@yourdomain.com"

# Optional: Telegram alerts
npx convex env set TELEGRAM_BOT_TOKEN "YOUR_BOT_TOKEN"
npx convex env set TELEGRAM_CHAT_ID "YOUR_CHAT_ID"
```

**Setting up Telegram alerts (automated):**
```bash
# Run the setup script — it handles token validation, chat ID discovery,
# and sets TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID as Convex env vars.
./setup-telegram.sh
```

The script will:
1. Ask you to paste your bot token (get one from [@BotFather](https://t.me/BotFather) — send `/newbot`)
2. Validate the token against Telegram's API
3. Wait for you to message the bot, then auto-discover your chat ID
4. Set both `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` as Convex env vars
5. Send a confirmation message to your Telegram

Then register the bot webhook (after deploying) with an authenticated
`POST /api/telegram/setup`.

## Step 3: Deploy the Backend

```bash
# Deploys schema, functions, and crons to your production deployment
npx convex deploy
```

The schema is declarative — Convex creates the tables on deploy. No SQL migrations.

## Step 4: Set the Admin Password

The admin password is set once via the bootstrap endpoint (it only works while no
admin exists):

```bash
curl -X POST https://<deployment-name>.convex.site/api/auth/bootstrap \
  -H "Content-Type: application/json" \
  -d '{"password":"YOUR_ADMIN_PASSWORD"}'
```

## Step 5: Build and Host the Dashboard

```bash
cd dashboard
bun install

# Point the dashboard at your Convex HTTP actions URL
echo 'VITE_API_URL=https://<deployment-name>.convex.site' > .env.local

bun run build          # outputs dashboard/dist/
# Deploy dist/ to your static host (Netlify/Vercel/Cloudflare Pages/...)
```

## Step 6: Set Up CI/CD (GitHub Actions)

Add this secret to your GitHub repository (Settings > Secrets > Actions):

| Secret | Value |
|--------|-------|
| `CONVEX_DEPLOY_KEY` | Production deploy key from the Convex dashboard (Settings > Deploy keys) |

Once configured, the CI/CD workflows handle everything automatically:
- **Convex deploys** on push to `master` when `convex/**` or `dashboard/**` files change
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
2. Install to `~/.pingpulse/bin/` (Unix) or `%LOCALAPPDATA%\pingpulse` (Windows)
3. Prompt for client name and location
4. Register with the server
5. Start the daemon as a system service

## Option B: Manual Install

```bash
# Download from GitHub releases
curl -L https://github.com/BaruchEric/pingpulse/releases/latest/download/pingpulse-darwin-arm64.tar.gz | tar xz
mkdir -p ~/.pingpulse/bin && mv pingpulse ~/.pingpulse/bin/

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
| Windows | ARM64 | `pingpulse-windows-arm64.zip` |

## Self-Update

Clients support unattended over-the-air updates triggered from the dashboard. When a newer `LATEST_CLIENT_VERSION` is set as a Convex env var (`npx convex env set LATEST_CLIENT_VERSION X.Y.Z`), the dashboard shows an "Update to X.Y.Z" button next to outdated clients.

**How it works:**
1. Admin clicks "Update" in the dashboard
2. Server queues a `self_update` command; the client pulls it on its next heartbeat (with the target version and GitHub repo)
3. Client downloads the correct platform binary from GitHub Releases (`client-v{version}`)
4. Client extracts, ad-hoc code-signs (macOS), and replaces its own binary
5. Client restarts via `launchctl kickstart` (macOS), `systemctl restart` (Linux), or process respawn (Windows)

**Requirements:**
- Client must be connected (status: Up) to receive the update command
- A GitHub Release with the matching tag (`client-v{version}`) and platform artifacts must exist
- Binary is installed in a user-writable location (`~/.pingpulse/bin/`) — no sudo required

**macOS note:** The self-update deletes the old binary before writing the new one to create a fresh inode. This prevents macOS AppleSystemPolicy from killing the process due to stale code signature page hashes.

## Client Configuration

Config is stored at `~/.pingpulse/config.toml` after registration:

```toml
client_id = "abc123"
secret = "client_secret_here"
server_url = "https://ping.yourdomain.com"
name = "Office Router"
location = "NYC Office"
```

Configuration is edited in the dashboard and delivered to the client in its heartbeat response. Configurable parameters:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `ping_interval_s` | 30 | Seconds between pings |
| `speed_test_interval_s` | 300 | Seconds between probe speed tests |
| `probe_size_bytes` | 262144 (256KB) | Payload size for probe speed tests |
| `full_test_schedule` | `0 */6 * * *` | Cron for full speed tests |
| `full_test_payload_bytes` | 10485760 (10MB) | Payload for full speed tests |
| `alert_latency_threshold_ms` | 100 | Latency alert threshold |
| `alert_loss_threshold_pct` | 5 | Packet loss alert threshold |
| `grace_period_s` | 60 | Grace period before alerting on reconnect |
| `down_alert_grace_seconds` | 60 | Grace period before client_down alert fires |

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

## Client Connectivity (Client-Facing)

### POST /api/clients/:id/connectivity
Client-reported connectivity events (authenticated with client secret, not admin JWT). The client records `connected`/`disconnected` events locally and syncs them on reconnect. The server pairs events into outages and sends retrospective alerts if server-side detection missed the outage.
```json
{
  "events": [
    { "event": "disconnected", "timestamp": 1711234567890, "reason": "ws_closed" },
    { "event": "connected", "timestamp": 1711234627890 }
  ]
}
```
Response:
```json
{ "ok": true, "outages_created": 1 }
```
- Max 200 events per batch
- Events shorter than the client's grace period are skipped
- Duplicate outages (within ±30s of an existing one) are deduplicated

## Speed Tests

### POST /api/speedtest/:id
Trigger an on-demand speed test for a client. Rate limited: 1 per client per 5 minutes.

## Data Export

### GET /api/export/:id?format=csv|json&from=ISO&to=ISO
Export historical ping/speed-test data. Admin token may be passed as `?token=` for direct download links.

## Speed Test Payload Endpoints (Client-Facing)

### GET /speedtest/download?size=BYTES
Download test payload for speed measurement.

### POST /speedtest/upload
Upload test payload for speed measurement.

## Client Heartbeat (replaces the former WebSocket)

### POST /api/clients/:id/heartbeat
Client daemon poll. Requires `Authorization: Bearer <client_secret>`. Sent every ping interval.

Request body: `{ rtt_ms, jitter_ms, status, client_version, timezone, include_logs }` — the
round-trip latency the client measured for the *previous* heartbeat.

Response body:
- `config` -- current client configuration
- `paused` / `simulation` -- server-applied monitoring state
- `latest_version` -- newest available client version (drives the update prompt)
- `commands` -- queued admin commands to run: `speed_test`, `self_update`, `request_ping`, `deregister`
- `server_logs` -- recent server-side log entries (when `include_logs` is set)

Status `410` means the client was deleted (the daemon self-uninstalls); `503` means an
admin-disconnect window is in effect.

Other client-authenticated endpoints: `POST /api/clients/:id/sync` (probe batches),
`POST /api/clients/:id/connectivity` (outage backfill),
`POST /api/clients/:id/speedtest-result`, `DELETE /api/clients/:id/self`.

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
| `client_down` | critical | Client disconnected beyond grace period (server-detected) |
| `client_down` | warning | Client-reported outage synced retrospectively on reconnect |
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

| Data | Retention | Notes |
|------|-----------|-------|
| Ping results, probe results | `retention_raw_days` (default 30) | Purged per client by the 6h maintenance cron |
| Speed tests, outages, alerts | Kept | Retained in Convex tables |

Retention runs automatically every 6 hours via the Convex cron (`convex/maintenance.ts`).

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

## Backend (Convex)

```bash
# Install deps (repo root)
bun install

# Start the Convex dev deployment — watches convex/, pushes changes,
# and regenerates convex/_generated/. Prints your .convex.site URL.
npx convex dev
```

## Dashboard

```bash
cd dashboard
bun install

# Point at your Convex dev deployment's HTTP actions URL
echo 'VITE_API_URL=https://<deployment-name>.convex.site' > .env.local

bun run dev          # Vite dev server with HMR (http://localhost:5173)
```

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

## Checks

```bash
bun run typecheck    # tsc for convex/ + dashboard
bun run lint         # eslint for convex/ + dashboard
cd client && cargo test
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
- Heartbeats may be failing -- the client retries every ping interval and syncs connectivity events + buffered probes once heartbeats succeed again
- Check the server logs: `npx convex logs` (live function logs)

## Alerts not delivering
- Test with `POST /api/alerts/test`
- Check Resend API key is valid and domain is verified
- Check Telegram bot token and chat ID are correct
- The bot must have been messaged at least once before it can send to the chat

## Self-update fails on macOS
- Check crash reports: `ls ~/Library/Logs/DiagnosticReports/*pingpulse*`
- If crash shows `SIGKILL (Code Signature Invalid)` / `Invalid Page`, the binary's code signature is stale
- Fix: manually delete the binary and re-copy: `rm ~/.pingpulse/bin/pingpulse && cp /path/to/new/pingpulse ~/.pingpulse/bin/`
- Ensure v0.3.1+ is installed — older versions used in-place copy which preserves stale inodes
- Check for `com.apple.provenance` xattr: `xattr -l ~/.pingpulse/bin/pingpulse` (this is informational — provenance alone doesn't cause crashes)

## Speed tests timing out
- Default full test uses 10MB payload -- may be too large for slow connections
- Adjust `full_test_payload_bytes` and `probe_size_bytes` in dashboard client config

## Dashboard login issues
- The admin token is stored in `localStorage` and sent as `Authorization: Bearer`
- Clear `localStorage` and try again
- Check `ADMIN_JWT_SECRET` is set as a Convex env var, and `VITE_API_URL` points at your `.convex.site` URL
- Ensure the admin password was bootstrapped (`POST /api/auth/bootstrap`)

---

# AI Agent Guide

Instructions for AI coding agents (Claude Code, Cursor, Copilot, etc.) working on this codebase.

## Project Context

PingPulse is a network monitoring tool. The codebase has three main parts:
- **`/client`** -- Rust binary (Cargo project)
- **`/convex`** -- Convex backend (TypeScript functions + HTTP router)
- **`/dashboard`** -- Vite + React SPA

## Getting Started for AI Agents

### 1. Understand the Architecture
- Backend is **Convex** (queries/mutations/actions + an HTTP router), NOT Express/Next.js/Cloudflare Workers
- Database is the **Convex document store** (declarative schema in `convex/schema.ts`), NOT SQL
- There is **no WebSocket**. The client polls `POST /api/clients/:id/heartbeat`; admin commands are queued and pulled in the response
- Dashboard is a **standalone Vite + React SPA** that calls the API over HTTP (`VITE_API_URL`)
- Client is a **Rust binary**, NOT Node.js

### 2. Key Files to Read First
```
convex/schema.ts            # Tables and validators
convex/http.ts              # HTTP router — the REST API surface
convex/ingest.ts            # heartbeat + ingestion mutations
convex/clients.ts           # client CRUD/queries
convex/monitor.ts           # down/up detection cron
convex/maintenance.ts       # retention + health-report cron
dashboard/src/lib/api.ts    # Dashboard API client (base URL + Bearer token)
dashboard/src/pages/*.tsx   # Dashboard pages
client/src/main.rs          # Client CLI and subcommands
client/src/heartbeat.rs     # HTTP heartbeat loop, command dispatch, self-update
```

### 3. Development Commands
```bash
# Backend (repo root)
bun install
npx convex dev                         # Push functions, codegen, watch
npx convex deploy                      # Deploy to production
bun run typecheck                      # tsc for convex/ + dashboard
bun run lint                           # eslint for convex/ + dashboard

# Dashboard
cd dashboard && bun install && bun run dev   # Vite HMR (port 5173)

# Client
cd client
cargo build
cargo test
cargo run -- start --foreground
```

### 4. Important Patterns

**Convex functions**
```typescript
// Queries/mutations/actions are registered with the generated builders.
export const listClients = internalQuery({
  args: {},
  handler: async (ctx) => ctx.db.query("clients").collect(),
});
```

**HTTP routing** — `convex/http.ts` registers a single handler per method under the
`/api/` prefix and dispatches by parsing `url.pathname`. It authenticates (admin Bearer
JWT or per-client secret), then calls internal queries/mutations/actions via
`ctx.runQuery` / `ctx.runMutation` / `ctx.runAction`.

**Admin commands** — enqueued with `internal.commands.enqueue` (state-style commands
mutate the client doc; action-style commands insert into the `commands` table) and pulled
by the client in its heartbeat response.

**Dashboard API calls** — go through `dashboard/src/lib/api.ts`, which prefixes
`VITE_API_URL` and attaches `Authorization: Bearer <token>` from `localStorage`.

### 5. Common Tasks

**Adding a new API endpoint:**
1. Add the query/mutation/action to the relevant `convex/*.ts` module
2. Add a route branch in `convex/http.ts` (match the path/method, auth, then `ctx.run*`)
3. Add a method to `dashboard/src/lib/api.ts` if the dashboard needs it

**Adding a new dashboard page:**
1. Create page component in `dashboard/src/pages/`
2. Add route in `dashboard/src/App.tsx`
3. Add nav link in the layout component

**Modifying client behavior:**
1. Edit relevant Rust source in `client/src/`
2. If adding a new config field, update:
   - `convex/schema.ts` (`clientConfigValidator`) and `convex/lib/config.ts` (`DEFAULT_CLIENT_CONFIG`, `ALLOWED_CONFIG_KEYS`)
   - `client/src/config.rs` (`RemoteConfig` + `apply_remote`)
   - `dashboard/src/components/EditClientDialog.tsx` (UI to edit)

**Adding a new table/column:**
1. Edit `convex/schema.ts` (Convex applies it on push — no SQL migrations)
2. Run `npx convex dev` to push and regenerate `convex/_generated/`

### 6. Environment Variables

Set with `npx convex env set NAME value`:

| Variable | Usage |
|----------|-------|
| `ADMIN_JWT_SECRET` | Admin JWT signing key (required) |
| `LATEST_CLIENT_VERSION` | Drives client update notifications (required) |
| `RESEND_API_KEY` | Email alert delivery |
| `ALERT_FROM_EMAIL` | Alert sender address |
| `ALERT_TO_EMAIL` | Alert recipient address |
| `TELEGRAM_BOT_TOKEN` | Telegram alert delivery |
| `TELEGRAM_CHAT_ID` | Telegram chat for alerts |

### 7. Testing

```bash
# Backend: typecheck + lint (no live deployment needed)
bun run typecheck && bun run lint

# Client tests use the standard Rust test framework
cd client && cargo test
```

### 8. Deployment Checklist

- [ ] Convex env vars set (`ADMIN_JWT_SECRET`, `LATEST_CLIENT_VERSION`, alert keys)
- [ ] `npx convex deploy` succeeds (schema, functions, crons)
- [ ] Dashboard built with `VITE_API_URL` pointing at the `.convex.site` URL and hosted
- [ ] GitHub Actions secret configured (`CONVEX_DEPLOY_KEY`)
- [ ] Admin password bootstrapped (`POST /api/auth/bootstrap`)
- [ ] Test alert delivery with `POST /api/alerts/test`

### 9. Do NOT

- Do **not** use `npm` or `yarn` -- use `bun` for everything
- Do **not** reintroduce Cloudflare Workers / D1 / Durable Objects / R2 / WebSockets -- the backend is Convex
- Do **not** hand-edit `convex/_generated/` -- regenerate with `npx convex dev`
- Do **not** add `dotenv` -- Convex env vars are managed via `npx convex env`

### 10. File Path Alias

Always use `@/` path alias for imports in the dashboard code (configured in Vite/TypeScript).

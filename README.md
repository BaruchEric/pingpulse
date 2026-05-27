# PingPulse

A distributed network-monitoring system that tracks latency, jitter, packet loss, outages, and throughput across remote machines, pairing a Rust client daemon with a Cloudflare Workers backend and a React dashboard.

Live at **[ping.beric.ca](https://ping.beric.ca)** (Cloudflare Workers).

## TL;DR

- **What:** Self-hosted uptime/latency monitor. A lightweight daemon runs on each machine you want to watch; the cloud backend stores metrics, detects outages, and alerts you via Telegram and email.
- **How:** Each client opens a persistent WebSocket to a per-client Cloudflare Durable Object. The client runs ICMP/HTTP probes and speed tests; the worker times round-trips, persists results to D1, archives to R2, and fans alerts out on Telegram + Resend email. A React SPA (served by the same worker) visualizes everything.
- **Stack:** Rust (client daemon) · Cloudflare Workers + Hono + Durable Objects + D1 + R2 + Analytics Engine (backend) · React 19 + Vite 8 + Tailwind 4 + uPlot (dashboard).
- **Run it:**
  - Backend/dashboard dev: `cd worker && bun install && bun run dev` (worker on `:8787`), `bun run dev:dashboard` (HMR on `:5173`).
  - Client dev: `cd client && cargo run -- start --foreground`.
  - Deploy: `cd worker && bun run deploy` (builds dashboard, applies D1 migrations, `wrangler deploy`).
- **Deploy target:** Cloudflare Workers, custom domain `ping.beric.ca` (see `worker/wrangler.toml`).

## Overview

PingPulse is a three-tier monitoring stack:

1. **Rust client daemon** — Installs on a target machine as a system service (launchd / systemd / Windows Service) or runs in the foreground. It connects over WebSocket to the backend, answers server-initiated pings, runs ICMP and HTTP probes against configurable targets, runs probe + full speed tests, buffers results to a local SQLite store, and syncs them on reconnect. Self-updates over the air from GitHub Releases.
2. **Cloudflare Worker** — A Hono app with one `ClientMonitor` Durable Object per registered client (holds the live WebSocket and per-client state machine). Metrics land in D1 (SQLite), get archived to R2, and alerts dispatch through Telegram and Resend email. A scheduled cron (every 6h) triggers speed tests, archival, retention pruning, and health reports.
3. **React dashboard** — A Vite SPA served directly by the worker as static assets. JWT-cookie admin auth. Shows latency/throughput charts, per-client detail, outage timelines, hourly heatmaps, alert history, and client/alert configuration.

```
+------------------+        WebSocket         +---------------------------+
|  Rust Client     | -----------------------> |  Cloudflare Worker        |
|  (daemon on      |  pings, probes,          |  (Hono + Durable Objects) |
|   target machine)|  speed tests, heartbeats |                           |
+------------------+                          |  D1 (SQLite) for data     |
                                              |  R2 for archives          |
                                              |  Analytics Engine metrics |
                                              +---------------------------+
                                                        | serves SPA assets
                                                        v
                                              +---------------------------+
                                              |  React Dashboard          |
                                              |  (Vite + Tailwind + uPlot)|
                                              +---------------------------+
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Client | Rust, Tokio, `tokio-tungstenite` (WebSocket), `reqwest`, `clap`, `axum` (local agent API on :9111), `rusqlite` (local buffer), `surge-ping` (ICMP) |
| Backend | Cloudflare Workers, Hono 4, Durable Objects, D1 (SQLite), R2, Analytics Engine |
| Dashboard | React 19, React Router 7, Vite 8, Tailwind CSS 4, uPlot |
| Alerts | Telegram Bot API, Resend (email) |
| CI/CD | GitHub Actions (`deploy-worker.yml`, `release-client.yml`), Bun, Wrangler |
| Builds | Bun (worker + dashboard), Cargo (client) |

## Repository Structure

```
pingpulse/
├── client/                     # Rust client daemon (Cargo)
│   └── src/
│       ├── main.rs             # CLI: register, start, stop, status, uninstall, agent
│       ├── websocket.rs        # WebSocket event loop, self-update, reconnect
│       ├── probe.rs            # ICMP + HTTP probe engine
│       ├── speed_test.rs       # Download/upload speed test logic
│       ├── store.rs            # Local SQLite buffer (probes + connectivity events)
│       ├── sync.rs             # Batch sync of buffered results to the server
│       ├── service.rs          # OS service install (launchd/systemd/Windows)
│       ├── agent.rs            # Local management HTTP API (port 9111)
│       ├── config.rs           # ~/.pingpulse/config.toml management
│       ├── messages.rs         # WebSocket message types
│       └── logger.rs           # Structured logging
├── worker/                     # Cloudflare Worker backend
│   ├── src/
│   │   ├── index.ts            # Worker entry (fetch + scheduled cron handlers)
│   │   ├── api/                # Hono route files (auth, clients, metrics, alerts,
│   │   │                       #   speedtest, export, command, sync, connectivity,
│   │   │                       #   analysis, telegram)
│   │   ├── durable-objects/
│   │   │   └── client-monitor.ts   # Per-client DO: WebSocket, pings, state machine
│   │   ├── services/           # archiver, alert-dispatch, analysis-queries,
│   │   │                       #   health-report, notify, bot-settings
│   │   ├── middleware/         # auth-guard (JWT), client-auth, rate-limit
│   │   └── utils/              # client-db, do-client, hash, pagination
│   ├── dashboard/              # React SPA (Vite)
│   │   └── src/{pages,components,lib}/
│   ├── migrations/             # D1 schema migrations (0001–0003)
│   ├── wrangler.toml
│   └── package.json
├── docs/                       # Design notes / network analysis
├── install.sh / install.ps1    # One-liner client installers (Unix / Windows)
└── .github/workflows/          # deploy-worker.yml, release-client.yml
```

## Getting Started

### Prerequisites

- **Bun** — `curl -fsSL https://bun.sh/install | bash`
- **Wrangler** — `bun install -g wrangler`
- **Rust toolchain** (only to build the client locally) — `rustup`
- A **Cloudflare account** (free plan works for personal use)

### Backend + dashboard (local dev)

```bash
cd worker
bun install
cd dashboard && bun install && cd ..

bun run dev            # worker on http://localhost:8787 (local D1)
bun run dev:dashboard  # dashboard with HMR on http://localhost:5173 (proxies /api → worker)
```

### Client (local dev)

```bash
cd client
cargo build
cargo run -- start --foreground   # run in foreground for debugging
cargo test
```

### Environment / secrets

The worker reads Cloudflare bindings and secrets (set with `wrangler secret put`, never committed):

| Name | Kind | Purpose |
|------|------|---------|
| `DB` | D1 binding | SQLite metrics store |
| `ARCHIVE` | R2 binding | Archived raw data / exports |
| `METRICS` | Analytics Engine binding | Time-series aggregation |
| `CLIENT_MONITOR` | Durable Object | Per-client monitoring state |
| `ADMIN_JWT_SECRET` | secret | JWT signing key for admin auth |
| `RESEND_API_KEY` | secret | Email alert delivery (optional) |
| `ALERT_FROM_EMAIL` / `ALERT_TO_EMAIL` | secret/var | Email alert addresses (optional) |
| `TELEGRAM_BOT_TOKEN` | secret | Telegram alert delivery (optional) |
| `TELEGRAM_CHAT_ID` | var | Telegram chat for alerts (optional) |
| `LATEST_CLIENT_VERSION` | var (in `wrangler.toml`) | Drives OTA client update prompts |

Telegram setup is automated: run `./setup-telegram.sh` (validates the bot token, auto-discovers your chat ID, and sets both Wrangler secrets).

The client stores its credentials at `~/.pingpulse/config.toml` after registration; runtime config (ping interval, probe targets, alert thresholds, retention, report schedule, etc.) is pushed from the dashboard over WebSocket.

## Scripts

Worker scripts (run from `worker/`):

| Script | Command | What it does |
|--------|---------|--------------|
| `dev` | `wrangler dev` | Run the worker locally with a local D1 |
| `dev:dashboard` | `cd dashboard && bun run dev` | Vite dashboard dev server (HMR) |
| `build` | builds dashboard + `wrangler deploy --dry-run` | Verify a deployable build without shipping |
| `deploy` | sync version → build dashboard → apply D1 migrations → `wrangler deploy` | Full production deploy |
| `sync-version` | reads `client/Cargo.toml` → updates `LATEST_CLIENT_VERSION` | Keeps OTA version in sync with the client |
| `test` | `vitest run` | Worker tests (`@cloudflare/vitest-pool-workers`) |
| `lint` | `eslint` worker + dashboard | Lint both TypeScript trees |
| `typecheck` | `tsc --noEmit` worker + dashboard | Type-check both trees |

Top-level `Makefile` targets (`make check`, `lint`, `typecheck`, `test`, `build`) fan these out across worker, dashboard, and the Rust client. Note: the `Makefile`'s `lint-client`/`test-client` run `cargo clippy`/`cargo test`.

Client CLI (`pingpulse <cmd>`): `register`, `start` (`--foreground`), `stop`, `status`, `uninstall`, `agent` (local management API, default port 9111).

## Data Model

D1 schema (`worker/migrations/`):

| Table | Purpose |
|-------|---------|
| `clients` | Registered machines: id, name, location, secret hash, `config_json`, `last_seen`, `client_version` |
| `ping_results` | Per-ping RTT/jitter with `direction` (`cf_to_client` / `client_to_cf`) and status |
| `client_probe_results` | Client-run ICMP/HTTP probe results synced in batches (session + seq dedup) |
| `speed_tests` | Probe/full speed tests: download/upload Mbps, payload size, duration, `target` (`worker` / `edge`) |
| `outages` | Detected outage windows (start, end, duration) |
| `alerts` | Alert history: type, severity, value, threshold, per-channel delivery flags |
| `registration_tokens` | Single-use, time-limited client registration tokens |
| `admin` | Admin password hash |
| `rate_limits` | Per-IP rate-limit state |
| `bot_settings` | Key/value store for bot/notification settings |

The worker `scheduled` cron (every 6h) triggers per-client speed tests, R2 archival, per-client raw-data retention pruning, rate-limit cleanup, and Telegram/email health reports. WebSocket message types and the full `ClientConfig` shape live in `worker/src/types.ts`.

## API Surface

Mounted under `/api/*` (global 60 req/min per-IP rate limit). Routes are split across `worker/src/api/`:

- **Auth** (`/api/auth`) — admin login/logout/session, client registration (`/register`).
- **Clients** (`/api/clients`) — admin CRUD + config; client self-delete and client-secret-authenticated sync/connectivity endpoints.
- **Metrics & analysis** (`/api/metrics`) — historical queries, paginated logs, aggregated analysis.
- **Alerts** (`/api/alerts`) — list, threshold config, test delivery.
- **Speed tests** (`/api/speedtest`, `/speedtest`) — on-demand triggers + client-facing payload up/download endpoints.
- **Export** (`/api/export`) — CSV/JSON export from R2.
- **Command / Telegram** (`/api/command`, `/api/telegram`) — DO commands and Telegram webhook handling.
- **WebSocket** — `GET /ws/:clientId` (Upgrade) routes to that client's `ClientMonitor` Durable Object.
- **Health** — `GET /api/health` (unauthenticated).

## Deployment (Cloudflare Workers)

The worker is deployed to Cloudflare Workers and served on the custom domain **`ping.beric.ca`** (configured in `worker/wrangler.toml` via `[[routes]] custom_domain = true`). Bindings: D1 (`pingpulse-db`), R2 (`pingpulse-archive`), Analytics Engine (`pingpulse-metrics`), and the `ClientMonitor` Durable Object.

Deploy from `worker/`:

```bash
bun run deploy   # sync version → build dashboard → apply D1 migrations (--remote) → wrangler deploy
```

CI/CD: GitHub Actions auto-deploys the worker on pushes that touch `worker/**` and builds + releases cross-platform client binaries on pushes that touch `client/**` (`.github/workflows/`). CI needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repo secrets.

### Installing a client

Generate a single-use registration token from the dashboard (Clients → Register New Client), then:

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/BaruchEric/pingpulse/master/install.sh | bash -s -- \
  --token "TOKEN" --server "https://ping.beric.ca"
```

Clients support unattended OTA self-update: bump `LATEST_CLIENT_VERSION` (auto-synced from `client/Cargo.toml` on deploy), and outdated connected clients show an "Update" button in the dashboard that pulls the matching `client-v{version}` GitHub Release.

## Status

Actively maintained and running in production at `ping.beric.ca` (client version `1.0.5`). Worker has a vitest suite (`worker/test/`, including `integration.test.ts`); the Rust client has unit tests across most modules. Email alerts (Resend) and Telegram alerts are both optional — configure either, both, or neither.

**Note:** This is a personal deployment; `wrangler.toml` contains environment-specific IDs (D1 `database_id`, the `ping.beric.ca` route) that must be changed for any other deployment. The repo's `CLAUDE.md` still describes the client as "Zig" — it is in fact a Rust/Cargo project (see `client/Cargo.toml`).

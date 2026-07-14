# pingpulse

Self-hosted network monitor: a lightweight Rust daemon on each machine streams pings, probes, and speed tests over WebSocket to a Cloudflare Workers backend that stores metrics, detects outages, and alerts via Telegram and email.

## TL;DR

- **What:** A self-hosted uptime/latency monitor. A small Rust agent runs on every machine you want to watch; a Cloudflare Workers backend ingests its metrics, detects outages, and notifies you.
- **How:** Each client holds a persistent WebSocket to its own `ClientMonitor` Durable Object. Metrics land in D1 (SQLite), rollups archive to R2, raw samples feed Analytics Engine, and a 6-hourly cron runs speed tests, archival, retention pruning, and health reports. The same worker serves the React dashboard.
- **Stack:** Rust + Tokio (client) · Cloudflare Workers + Hono 4 + Durable Objects + D1 + R2 + Analytics Engine (backend) · React 19 + Vite + Tailwind 4 + uPlot (dashboard) · Telegram + Resend (alerts).
- **Run it:** `cd worker && bun install && bun run dev` (worker on `:8787`), `bun run dev:dashboard` (Vite HMR); client: `cd client && cargo run`.
- **Deploy:** Cloudflare Workers, custom domain **https://ping.beric.ca** — `cd worker && bun run deploy`.

## Overview

pingpulse watches a fleet of machines for connectivity, latency, and throughput problems and tells you when something breaks. It has three tiers:

- **`client/`** — a Rust daemon (crate `pingpulse`, v1.0.5) installed on each monitored host. It runs ICMP pings and HTTP probes, periodic speed tests, buffers samples locally when offline, and streams everything to the backend over a persistent WebSocket. It exposes a small local HTTP API (axum) for on-host management and self-updates from GitHub Releases when the backend reports a newer version.
- **`worker/`** — a Cloudflare Worker (Hono 4) that terminates each client's WebSocket in a per-client `ClientMonitor` Durable Object, persists metrics to D1, archives rollups to R2, writes samples to Analytics Engine, runs scheduled maintenance via cron, dispatches alerts, and serves the dashboard SPA.
- **`worker/dashboard/`** — a React 19 single-page app (Vite, Tailwind 4, uPlot charts, react-router) served same-origin by the worker for live latency/uptime views.

Alerts go out over the Telegram Bot API and Resend (email) when the backend detects an outage or a degraded host.

## Tech stack

| Layer | Technology |
|-------|-----------|
| Client | Rust, Tokio, tokio-tungstenite (WebSocket), reqwest (HTTP probes), surge-ping (ICMP), clap (CLI), axum + tower-http (local agent API), rusqlite/bundled (offline buffer), tracing |
| Backend | Cloudflare Workers, Hono 4, Durable Objects (`ClientMonitor`), D1, R2, Analytics Engine, Wrangler 4 |
| Dashboard | React 19, Vite 8, Tailwind CSS 4, uPlot, react-router 7 |
| Alerts | Telegram Bot API, Resend (email) |
| Tests | Vitest (+ `@cloudflare/vitest-pool-workers`) for the worker; `cargo` for the client |
| CI/CD | GitHub Actions — `deploy-worker.yml` (worker deploy), `release-client.yml` (client binaries → GitHub Releases for OTA self-update) |

## Getting started

This is a monorepo with no root `package.json` — each tier is built and run from its own directory.

### Prerequisites

- [Bun](https://bun.sh) (worker + dashboard)
- Rust toolchain / `cargo` (client)
- A Cloudflare account with Wrangler authenticated (for deploys)

### Worker + dashboard (local dev)

```bash
cd worker
bun install
bun run dev            # worker via wrangler dev, http://127.0.0.1:8787
bun run dev:dashboard  # dashboard (Vite) with HMR, in a second terminal
```

### Client (local dev)

```bash
cd client
cargo run              # or: cargo build --release
```

### Registering a real client

The one-line installers download a release binary, register it, and start it as a service:

```bash
# macOS / Linux
curl -fsSL https://ping.beric.ca/install.sh | bash -s -- \
  --token <REGISTRATION_TOKEN> --server https://ping.beric.ca

# Windows: install.ps1 (see repo)
```

`--token` comes from the dashboard; `--server` is your backend URL. Client config is written to a TOML file in the platform config dir (see `client/src/config.rs`).

### Environment variables / secrets (worker)

Bindings for D1/R2/Analytics Engine/Durable Objects live in `worker/wrangler.toml`. The following are read at runtime and should be provisioned as Wrangler secrets (`wrangler secret put <NAME>`) rather than committed:

| Name | Purpose |
|------|---------|
| `ADMIN_JWT_SECRET` | Signs admin/dashboard JWTs. `wrangler.toml` ships a `change-me-in-secrets` placeholder — override it with a real secret. |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Telegram alert delivery. Run `./setup-telegram.sh` to obtain them. |
| `RESEND_API_KEY` | Email alert delivery via Resend. |
| `ALERT_FROM_EMAIL` / `ALERT_TO_EMAIL` | From/to addresses for email alerts. |
| `LATEST_CLIENT_VERSION` | A `wrangler.toml` var (not a secret) telling clients the newest release to self-update to; auto-synced from `client/Cargo.toml` by `bun run sync-version`. |

## Scripts

Run from `worker/` (Bun):

| Command | What it does |
|---------|--------------|
| `bun run dev` | Local worker via `wrangler dev`. |
| `bun run dev:dashboard` | Dashboard dev server (Vite). |
| `bun run build` | Build dashboard, then `wrangler deploy --dry-run`. |
| `bun run sync-version` | Sync `LATEST_CLIENT_VERSION` in `wrangler.toml` from `client/Cargo.toml`. |
| `bun run deploy` | sync-version → build dashboard → apply D1 migrations (`--remote`) → `wrangler deploy`. |
| `bun run test` | Worker test suite (Vitest). |
| `bun run lint` / `bun run typecheck` | ESLint / `tsc` for worker + dashboard. |

Cross-tier via the root `Makefile`:

| Command | What it does |
|---------|--------------|
| `make check` | `lint` + `typecheck` + `test` across worker, dashboard, and client. |
| `make lint` | ESLint (worker, dashboard) + `cargo clippy -D warnings` (client). |
| `make build` | Build all three tiers. |

## Architecture

```
client/                # Rust daemon (crate: pingpulse v1.0.5)
  src/                 # main, config, probe, speed_test, websocket, sync, store (rusqlite), agent (axum), service
worker/                # Cloudflare Worker (Hono 4) + wrangler.toml
  src/
    index.ts           # worker entry (fetch + scheduled/cron)
    api/               # router, metrics, clients, auth, sync, alerts, telegram, speedtest, analysis, command, connectivity, export
    durable-objects/   # client-monitor.ts (per-client WebSocket + live state)
    middleware/        # client-auth, auth-guard, rate-limit
    services/          # alert-dispatch, notify, health-report, archiver, analysis-queries, bot-settings (+ __tests__)
    utils/             # do-client, client-db, pagination, hash
  dashboard/           # React SPA (built to dashboard/dist, served by the worker)
  migrations/          # D1 SQL (0001_initial, 0002_bot_settings, 0003_speed_test_target)
docs/                  # design specs, plans, and network-analysis notes
install.sh / .ps1      # client one-line installers (macOS/Linux/Windows)
setup-telegram.sh      # Telegram bot setup helper
Makefile               # lint / typecheck / test / build across all three tiers
```

**Data flow:** client probes host connectivity → streams samples over a persistent WebSocket to its `ClientMonitor` Durable Object (buffering to a local SQLite store while disconnected) → the worker writes metrics to D1, samples to Analytics Engine, and archives rollups to R2. A 6-hourly cron (`0 */6 * * *`) triggers speed tests, archival, retention pruning, and health reports; outage/degradation events fan out through the alert-dispatch service to Telegram and Resend email. The worker also serves the dashboard SPA (`assets` → `dashboard/dist`, SPA fallback).

## Deployment

- **Platform:** Cloudflare Workers, custom domain **https://ping.beric.ca** (`custom_domain` route in `worker/wrangler.toml`).
- **Deploy:** `cd worker && bun run deploy` — syncs the client version, builds the dashboard, applies remote D1 migrations, and runs `wrangler deploy`.
- **CI:** `.github/workflows/deploy-worker.yml` deploys the worker; `.github/workflows/release-client.yml` builds and publishes client binaries to GitHub Releases, which the daemon uses for OTA self-updates.

## Status

Actively developed and running in production at https://ping.beric.ca (client crate v1.0.5). Backend and client are functional end-to-end; the worker has a Vitest suite covering alert dispatch, analysis queries, and health reports. Note: secrets (Telegram/Resend/JWT) must be provisioned before alerts work, and the `Makefile` `typecheck-worker` target currently runs the dashboard typecheck (a minor rough edge) — prefer `cd worker && bun run typecheck` for the worker itself.

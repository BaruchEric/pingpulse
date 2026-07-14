# PingPulse

Self-hosted uptime/latency monitoring: a Rust daemon on each watched machine streams pings, probes, and speed tests over WebSocket to a Cloudflare Worker backend with a React dashboard and Telegram/email alerts, live at ping.beric.ca.

## TL;DR

- **What:** Self-hosted network monitor. A lightweight Rust daemon runs on every machine you want to watch; the cloud backend stores metrics, detects outages, and alerts via Telegram and Resend email.
- **How:** Each client holds a persistent WebSocket to its own `ClientMonitor` Durable Object. Metrics land in D1 (SQLite), archives go to R2, and a 6-hourly cron handles speed tests, archival, retention pruning, and health reports. The same worker serves the React dashboard SPA.
- **Stack:** Rust + Tokio (client) · Cloudflare Workers + Hono 4 + Durable Objects + D1 + R2 + Analytics Engine (backend) · React + Vite + Tailwind + uPlot (dashboard).
- **Run it:** `cd worker && bun install && bun run dev` (worker on `:8787`), `bun run dev:dashboard` (HMR); client: `cd client && cargo run`.
- **Deploy:** Cloudflare Workers, custom domain **https://ping.beric.ca** — `cd worker && bun run deploy`.

## Overview

PingPulse is a three-tier monitoring stack:

1. **Rust client daemon** (`client/`, crate `pingpulse`, v1.0.5) — installs on a target machine as a system service or runs in the foreground (`install.sh` / `install.ps1` one-line installers take `--token`, `--server`, `--name`, `--location`). It answers server-initiated pings over WebSocket, runs ICMP and HTTP probes and speed tests, buffers results to a local SQLite store (`rusqlite`) for offline sync, and exposes a local agent API via `axum`.
2. **Cloudflare Worker** (`worker/`) — a Hono app with one `ClientMonitor` Durable Object per registered client holding the live WebSocket and per-client state. Bindings: D1 (`pingpulse-db`) for metrics, R2 (`pingpulse-archive`) for archives, Analytics Engine (`pingpulse-metrics`), plus a `0 */6 * * *` cron. Alerts fan out through the Telegram Bot API and Resend email (`setup-telegram.sh` bootstraps the bot).
3. **React dashboard** (`worker/dashboard/`) — a Vite SPA served as static worker assets (SPA fallback routing), with JWT-cookie admin auth, latency/throughput charts (uPlot), outage timelines, and client/alert configuration.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Client | Rust, Tokio, tokio-tungstenite, reqwest, clap, axum (local agent API), rusqlite (offline buffer) |
| Backend | Cloudflare Workers, Hono 4, Durable Objects, D1, R2, Analytics Engine, Wrangler 4 |
| Dashboard | React, Vite, Tailwind CSS, uPlot |
| Alerts | Telegram Bot API, Resend (email) |
| CI/CD | GitHub Actions — `deploy-worker.yml` (worker deploy), `release-client.yml` (client binaries to GitHub Releases for OTA self-update) |

## Repository Structure

```
client/            # Rust daemon (crate: pingpulse v1.0.5)
worker/            # Cloudflare Worker (Hono) + wrangler.toml
  src/             # api/, durable-objects/, middleware/, services/, utils/
  dashboard/       # React SPA (built into dashboard/dist, served by the worker)
  migrations/      # D1 SQL migrations
  test/            # vitest (+ @cloudflare/vitest-pool-workers)
docs/              # notes (e.g. novamini-network-analysis.md)
install.sh / .ps1  # client one-line installers (macOS/Linux/Windows)
setup-telegram.sh  # Telegram bot setup helper
Makefile           # lint / typecheck / test / build across all three tiers
```

## Getting Started

```bash
# Backend + dashboard
cd worker
bun install
bun run dev              # wrangler dev on :8787
bun run dev:dashboard    # Vite HMR for the SPA

# Client
cd client
cargo run                # or: cargo build --release
```

## Scripts

| Command | What it does |
|---------|--------------|
| `cd worker && bun run dev` | Local worker via `wrangler dev` |
| `cd worker && bun run dev:dashboard` | Dashboard dev server (Vite) |
| `cd worker && bun run build` | Build dashboard + `wrangler deploy --dry-run` |
| `cd worker && bun run deploy` | Sync client version → build dashboard → apply D1 migrations → `wrangler deploy` |
| `cd worker && bun run test` | Worker test suite (vitest) |
| `cd worker && bun run lint` / `typecheck` | ESLint / tsc for worker + dashboard |
| `make check` | Lint + typecheck + test across worker, dashboard, and client |
| `make build` | Dashboard/worker build + `cargo build --release` |

## Deployment

- **Platform:** Cloudflare Workers, custom domain `ping.beric.ca` (route in `worker/wrangler.toml`).
- `bun run deploy` first syncs `LATEST_CLIENT_VERSION` in `wrangler.toml` from `client/Cargo.toml` (the worker tells clients when to self-update from GitHub Releases), then builds the dashboard, applies remote D1 migrations, and deploys.
- CI: `deploy-worker.yml` deploys the worker; `release-client.yml` builds and publishes client binaries.

## Status

Live in production at **https://ping.beric.ca**. Client at v1.0.5 with OTA self-update. Worker tests run under vitest with the Cloudflare workers pool; client linted via `cargo clippy -D warnings`.

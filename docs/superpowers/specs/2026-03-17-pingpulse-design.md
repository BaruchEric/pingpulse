# PingPulse Design Spec

**Date:** 2026-03-17
**Status:** Approved

## Overview

PingPulse is a bidirectional network monitoring tool with a Rust desktop client and an all-Cloudflare backend. It measures latency, jitter, packet loss, and throughput between client locations and the Cloudflare edge, with a management dashboard at ping.beric.ca.

**Use cases:** Personal network monitoring, multi-site comparison, ISP accountability, dev/ops connectivity monitoring.

## Architecture

All-Cloudflare: Workers, Durable Objects, D1, Analytics Engine, R2, Workers Static Assets. Single `wrangler deploy` ships everything.

```
┌─────────────────────────────────────────────────────────────────┐
│                    CLOUDFLARE EDGE                               │
│                                                                  │
│  ┌──────────────┐    ┌───────────────────────────────────────┐  │
│  │ Cron Worker   │    │  Durable Object (1 per client)        │  │
│  │ (scheduled)   │───>│  - Holds WebSocket to client          │  │
│  │               │    │  - Ping scheduling via alarms          │  │
│  │ - Full speed  │    │  - Lightweight probe execution         │  │
│  │   test trigger│    │  - Latency/jitter/loss tracking        │  │
│  └──────────────┘    └───────────┬───────────────────────────┘  │
│                                  │                               │
│  ┌──────────────┐    ┌───────────v───────────────────────────┐  │
│  │ API Worker    │    │  Storage Layer                         │  │
│  │               │    │  ┌─────┐  ┌──────────┐  ┌────┐       │  │
│  │ - /api/auth   │───>│  │ D1  │  │Analytics │  │ R2 │       │  │
│  │ - /api/clients│    │  │     │  │Engine    │  │    │       │  │
│  │ - /api/metrics│    │  │logs │  │time-series│ │archive│    │  │
│  │ - /api/config │    │  └─────┘  └──────────┘  └────┘       │  │
│  │ - /api/alerts │    └──────────────────────────────────────┘  │
│  └──────┬───────┘                                               │
│         │                                                        │
│  ┌──────v───────┐                                               │
│  │ Static Assets │  <- React dashboard (ping.beric.ca)          │
│  └──────────────┘                                               │
└─────────────────────────────────────────────────────────────────┘
          ^ WebSocket                    ^ HTTPS
          |                              |
┌─────────┴──────────┐      ┌───────────┴──────────┐
│  Rust Client Daemon │      │  Browser (Dashboard)  │
│  (macOS/Win/Linux)  │      │  ping.beric.ca        │
└────────────────────┘      └───────────────────────┘
```

## Rust Client Daemon

**Binary name:** `pingpulse`

### Lifecycle

1. Admin generates a registration token in the dashboard (requires admin auth). Token is single-use, expires after 15 minutes, 32 bytes of entropy (base62-encoded). Token hash stored in D1 `registration_tokens` table.
2. User runs `pingpulse register --token <TOKEN>` on the client machine
3. Client sends token to API Worker. Worker validates: token hash exists in D1, not expired, not already used. On success: marks token as used, returns client ID + client secret + WebSocket URL.
4. Client stores credentials locally (`~/.pingpulse/config.toml`) — client secret used for WebSocket auth
4. Client connects WebSocket to its assigned Durable Object
5. Daemon runs in background — installed as a system service (launchd on macOS, systemd on Linux, Windows Service)

### Responsibilities

- Maintain WebSocket connection to its Durable Object (auto-reconnect with exponential backoff). WebSocket upgrade request includes `Authorization: Bearer <client_secret>` header; the DO validates the secret before accepting the connection.
- Respond to ping requests from CF (echo with timestamps for RTT calculation)
- Execute speed tests when instructed by CF (download/upload payloads from the Worker)
- Send its own client-to-CF pings at intervals dictated by the dashboard config
- Write local logs to `~/.pingpulse/logs/` (rotated daily, configurable retention)

### Speed Test Flow

- **Lightweight probe:** CF sends a small payload (configurable 100KB-1MB) over the WebSocket, client echoes back. Measures throughput in both directions.
- **Full test:** CF signals "start full test". Client opens parallel HTTP connections to a Worker endpoint, downloads/uploads larger payloads (5-25MB configurable). Reports results back over WebSocket.

### Config (pushed from dashboard via WebSocket)

```
ping_interval: 30s
probe_size: 256KB
full_test_schedule: "0 */6 * * *"
full_test_payload: 10MB
alert_latency_threshold: 100ms
alert_loss_threshold: 5%
```

### Cross-Platform Build

Rust cross-compilation via `cross` or `cargo-zigbuild` for:
- macOS: aarch64 + x86_64
- Linux: amd64 + arm64
- Windows: x86_64

## Cloudflare Durable Objects & Workers

### ClientMonitor Durable Object (1 per client)

**State:**
- Client metadata (name, location label, registration time)
- Current config (intervals, thresholds, payload sizes)
- Connection status (connected/disconnected, last seen)
- Rolling window of recent pings (last 100) for real-time stats
- Active WebSocket reference

**Alarm-driven scheduling:**
- `setAlarm()` fires at the configured ping interval
- On alarm: sends timestamped ping over WebSocket, records when echo returns
- Calculates: RTT, jitter (RFC 3550 — mean of absolute differences between consecutive RTTs), packet loss (missed echoes / total)
- Buffers results in-memory (rolling window); flushes batch to D1 + Analytics Engine every 60s or every 10 pings (whichever comes first). This keeps D1 writes manageable (~1.4K writes/day per client instead of ~2.9K).
- Each DO handles its own Analytics Engine write during flush (1 AE write per flush, well within AE's 25-per-invocation limit)
- Checks thresholds after each ping, triggers alert if breached
- Sets next alarm

**D1 plan requirement:** Paid plan (Workers Paid / D1 paid tier) required for production use. At 20 clients with 30s intervals and 30-day retention, expect ~1.7M rows in `ping_results`. Well within D1 paid limits (10B rows).

**Disconnection handling:**
- WebSocket `close` event marks client as disconnected with timestamp
- Starts a "down" timer — if client doesn't reconnect within grace period (configurable, default 60s), triggers a "client down" alert
- On reconnect: calculates downtime duration, logs the outage event

### API Worker Routes

| Route | Method | Purpose |
|---|---|---|
| `/api/health` | GET | Health check — returns 200 with basic status |
| `/api/auth/login` | POST | Admin login — returns JWT session cookie |
| `/api/auth/logout` | POST | Admin logout — clears session cookie |
| `/api/auth/me` | GET | Current admin session info |
| `/api/auth/register` | POST | Exchange registration token for client ID + secret + WS URL |
| `/api/clients` | GET | List all clients with current status |
| `/api/clients/:id` | GET/PUT/DELETE | Client detail, update config, remove |
| `/api/clients/:id/metrics` | GET | Historical metrics (range, resolution) |
| `/api/clients/:id/logs` | GET | Paginated detailed logs |
| `/api/alerts` | GET/PUT | List alerts, update thresholds |
| `/api/alerts/test` | POST | Send test alert (email + Telegram) |
| `/api/speedtest/:id` | POST | Trigger on-demand full speed test (rate limited: max 1 per client per 5 min) |
| `/api/export/:id` | GET | Export logs as CSV/JSON from R2 |

**Rate limiting:** All API routes rate-limited at 60 requests/min per IP. `/api/speedtest/:id` additionally limited to 1 trigger per client per 5 minutes. `/api/auth/login` limited to 5 attempts per minute per IP.

**CORS:** Not required — dashboard SPA and API routes are served from the same Worker under `ping.beric.ca` (same origin).

### Cron Worker (`scheduled()` handler)

- Runs on configured schedule (e.g., every 6 hours)
- Iterates all registered client DOs, signals each to run a full speed test
- Aggregates daily/weekly summaries, archives old logs from D1 to R2

## Storage

| Store | What | Retention |
|---|---|---|
| D1 | Ping results, speed tests, client config, outage events, alert history | 30 days (configurable) |
| Analytics Engine | Time-series metrics (latency p50/p95/p99, throughput, loss %) | 90 days (CF managed) |
| R2 | Archived logs, CSV/JSON exports | Unlimited |

### D1 Tables

- `ping_results` — `id, client_id, timestamp, rtt_ms, jitter_ms, direction (cf->client | client->cf), status (ok | timeout | error)`
- `speed_tests` — `id, client_id, timestamp, type (probe | full), download_mbps, upload_mbps, payload_bytes, duration_ms`
- `outages` — `id, client_id, start_ts, end_ts, duration_s`
- `alerts` — `id, client_id, type, severity, value, threshold, delivered_email, delivered_telegram, timestamp`
- `clients` — `id, name, location, secret_hash, config_json, created_at, last_seen`
- `registration_tokens` — `id, token_hash, created_at, expires_at, used_at, used_by_client_id`
- `admin` — `id, password_hash, created_at`

### R2 Archival

- Cron Worker runs daily, exports D1 rows older than retention period to R2 as gzipped JSON files
- Path: `archive/{client_id}/{year}/{month}/{day}.json.gz`
- D1 rows deleted after confirmed R2 write

## Dashboard (ping.beric.ca)

**Tech stack:** React + Vite, Cloudflare Workers Static Assets, Tailwind CSS, dark mode default. uPlot for time-series charts (lightweight, fast with large datasets).

### Pages

**Overview (home):**
- Grid of client cards: name, location, status indicator (green/yellow/red), current latency/jitter/loss, last speed test result, sparkline of latency over last hour
- Updates via API polling every 5-10s
- Global stats bar: total clients, clients up/down, average latency

**Client Detail (`/client/:id`):**
- Real-time panel: live latency graph, connection status, active config
- Historical charts: latency, throughput, packet loss over time
- Time range selector: 1h, 6h, 24h, 7d, 30d, custom
- Resolution auto-adjusts (per-ping for short ranges, aggregated for longer)
- Outage timeline: horizontal bar showing up/down periods
- Speed test history table

**Client Management (`/clients/manage`):**
- Register new client: generates token, shows setup instructions
- Edit client: name, location, intervals, thresholds
- Delete client: confirmation dialog, removes DO + data
- Bulk actions: trigger speed test on all, export all logs

**Alerts (`/alerts`):**
- Alert history: timestamped list with type, severity, value
- Global alert config: default thresholds, email address, Telegram bot token + chat ID
- Per-client threshold overrides
- Test alert button

**Settings (`/settings`):**
- Account: change admin password
- Data retention: D1 retention period, R2 archival schedule
- Export: download all data for a client or date range

### Auth

Simple token-based admin auth. Single admin user. Login page with password, JWT session in cookie. Password hash stored in D1.

## Alerting System

### Alert Types

| Alert | Trigger | Severity |
|---|---|---|
| Client Down | No WebSocket reconnect within grace period (default 60s) | Critical |
| Client Up | Client reconnects after being down | Info |
| High Latency | Average latency over last N pings exceeds threshold | Warning |
| Packet Loss | Loss % over last N pings exceeds threshold | Warning |
| Speed Degradation | Full test result below configured minimum | Warning |
| Latency Recovered | Latency drops back below threshold after alert | Info |

### Delivery Channels

- **Email:** Resend (transactional email API via `fetch()` from Workers, generous free tier). Single admin address. Resend API key stored as a Worker secret.
- **Telegram:** Bot API via `fetch()` from the Worker. Bot token + chat ID configured in settings.

### Alert Logic

Lives in the Durable Object. After each ping/test, DO checks thresholds and calls API Worker's alert dispatch if breached. Deduplication: don't re-fire same alert type within cooldown window (configurable, default 5 minutes). Alert history stored in D1.

## Client-Side Logging

**Location:** `~/.pingpulse/logs/`

- `pingpulse-YYYY-MM-DD.log` — structured JSON lines, one per event
- Events: ping sent/received, speed test start/complete, WebSocket connect/disconnect/reconnect, config updates received, errors
- Format: `{ "ts": "2026-03-17T12:00:00-04:00", "event": "ping_reply", "rtt_ms": 23.4, "jitter_ms": 1.2 }`
- Rotation: daily files, configurable retention (default 30 days, auto-delete older)
- Log level configurable: `debug`, `info`, `warn`, `error`

## DNS & Deployment

### DNS

`ping.beric.ca` — CNAME to Workers custom domain (or proxied via Workers Routes). Configured in Cloudflare dashboard or via Wrangler. Domain beric.ca already managed by Cloudflare.

### Project Structure

```
pingpulse/
├── client/                    # Rust daemon
│   ├── Cargo.toml
│   ├── src/
│   │   ├── main.rs           # CLI entry (register, start, status, stop — stop wraps launchctl/systemctl/sc)
│   │   ├── websocket.rs      # WebSocket connection + reconnect logic
│   │   ├── speed_test.rs     # Download/upload test execution
│   │   ├── logger.rs         # Local structured logging
│   │   └── config.rs         # Local config management
│   └── cross/                # Cross-compilation configs
│
├── worker/                    # Cloudflare Worker project
│   ├── wrangler.toml         # Worker config (D1, R2, DO bindings, cron)
│   ├── src/
│   │   ├── index.ts          # Main Worker entry (fetch + scheduled handlers)
│   │   ├── durable-objects/
│   │   │   └── client-monitor.ts  # ClientMonitor DO
│   │   ├── api/
│   │   │   ├── auth.ts
│   │   │   ├── clients.ts
│   │   │   ├── metrics.ts
│   │   │   ├── alerts.ts
│   │   │   └── speedtest.ts
│   │   ├── services/
│   │   │   ├── alert-dispatch.ts  # Email + Telegram delivery
│   │   │   ├── archiver.ts        # D1 -> R2 archival
│   │   │   └── analytics.ts       # Analytics Engine writes
│   │   └── types.ts
│   │
│   └── dashboard/             # React + Vite SPA
│       ├── index.html
│       ├── vite.config.ts
│       ├── src/
│       │   ├── App.tsx
│       │   ├── pages/
│       │   │   ├── Overview.tsx
│       │   │   ├── ClientDetail.tsx
│       │   │   ├── ClientManage.tsx
│       │   │   ├── Alerts.tsx
│       │   │   └── Settings.tsx
│       │   ├── components/
│       │   │   ├── ClientCard.tsx
│       │   │   ├── LatencyChart.tsx
│       │   │   ├── SpeedChart.tsx
│       │   │   ├── OutageTimeline.tsx
│       │   │   └── StatusBadge.tsx
│       │   └── lib/
│       │       ├── api.ts         # API client
│       │       └── hooks.ts       # Data fetching hooks
│       └── public/
│
├── docs/
│   └── superpowers/
│       └── specs/
└── README.md
```

### Deploy Flow

1. `wrangler deploy` — deploys Worker + DOs + static dashboard assets in one command
2. Rust client built via CI (GitHub Actions) — releases as binaries for each platform
3. D1 migrations managed via `wrangler d1 migrations`

### Environments

- `dev` — local via `wrangler dev` (miniflare simulates DOs, D1, R2 locally)
- `production` — Cloudflare edge, ping.beric.ca

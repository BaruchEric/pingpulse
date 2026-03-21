# Client as Source of Truth — Design Spec

**Date:** 2026-03-21
**Status:** Approved

## Problem

The current architecture makes the server the source of truth for WAN quality measurements. The server initiates pings, measures RTT, and writes everything to D1. The client is passive — it responds to pings and runs speed tests when told. When the WebSocket drops, there's a measurement gap: the server can't ping what it can't reach, and the client isn't recording anything meaningful on its own.

## Solution

Flip the model: the client becomes an autonomous WAN quality observer that continuously measures network quality regardless of server connectivity, logs locally, and syncs to the server on reconnect. The server becomes the sync target, connection monitor, notifier, and master of records.

## Architecture: Dual Channel (WebSocket + HTTP Sync)

- **WebSocket** handles: real-time probe streaming, server heartbeat, config push, trigger commands
- **HTTP** handles: batch sync of buffered measurements (`POST /api/clients/:id/sync`)

This separation ensures sync doesn't interfere with the real-time channel and allows robust retries/chunking for large batch transfers.

---

## 1. Client Probe Engine

The client daemon runs an autonomous probe loop, independent of WebSocket state.

### ICMP Probes
- Ping configurable targets (defaults: `8.8.8.8`, `1.1.1.1`, `9.9.9.9`)
- Interval: 5s (configurable)
- Timeout: 3000ms
- Records: target, rtt_ms, jitter_ms, status (ok/timeout/error), timestamp

### HTTP Probes
- HEAD requests to configurable targets (defaults: `https://www.google.com`, `https://cloudflare.com`)
- Interval: 15s (configurable)
- Timeout: 5000ms
- Records: target, response_time_ms, status_code, status (ok/timeout/error), timestamp

### Config Hierarchy
1. Hardcoded defaults (client works with zero config)
2. Local `~/.pingpulse/config.toml` (user customization)
3. Server-pushed config via `config_update` WebSocket message (fleet management, wins on conflict)

---

## 2. Local Storage

SQLite database at `~/.pingpulse/probes.db`. Chosen over raw binary for atomic writes, easy querying, and corruption resistance.

### Schema

```sql
CREATE TABLE probe_results (
    seq_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    probe_type    TEXT    NOT NULL,  -- 'icmp' | 'http'
    target        TEXT    NOT NULL,  -- '8.8.8.8' or 'https://google.com'
    timestamp     INTEGER NOT NULL,  -- unix millis, client clock
    rtt_ms        REAL,             -- NULL if timeout/error
    status_code   INTEGER,          -- NULL for ICMP
    status        TEXT    NOT NULL,  -- 'ok' | 'timeout' | 'error'
    jitter_ms     REAL,             -- NULL if not applicable
    synced        INTEGER NOT NULL DEFAULT 0  -- 0 or 1
);

CREATE TABLE sync_state (
    key           TEXT PRIMARY KEY,
    value         TEXT
    -- stores: 'last_acked_seq', 'session_id', 'client_id', etc.
);
```

### Session ID
On first DB creation, the client generates a random UUID (`session_id`) and stores it in `sync_state`. This `session_id` is sent with every sync batch. If the client's DB is deleted or recreated, a new `session_id` is generated, and the server treats it as a fresh sequence space — preventing `seq_id` collisions from AUTOINCREMENT resets.

### SQLite Configuration
- **WAL mode** enabled on DB open (`PRAGMA journal_mode=WAL`) — allows concurrent reads during probe writes without BUSY errors

### Retention
- 1-week rolling window (7 days)
- Cleanup runs once per hour (not every probe cycle)
- **Never deletes unsynced rows** even if past retention — belt-and-suspenders

---

## 3. Sync Protocol

### Transport
`POST /api/clients/:id/sync` — authenticated with existing `Authorization: Bearer <client_secret>`.

### Client-Side Flow
1. On WebSocket reconnect (or periodically every 60s while connected), query: `SELECT * FROM probe_results WHERE synced = 0 ORDER BY seq_id LIMIT 500`
2. POST batch as JSON array to sync endpoint, including `session_id`
3. Server responds with `{ "acked_seq": <highest_seq_received> }`
4. Client marks `synced = 1` for only the exact `seq_id` values included in the sent batch (not range-based — avoids marking rows inserted between query and ack)
5. If more unsynced rows remain, repeat

### Server-Side Flow
1. Receive batch, validate auth
2. Write rows to `client_probe_results` table in D1
3. Deduplicate by `(client_id, seq_id)` — idempotent, safe to retry
4. Respond with `acked_seq`

### Real-Time Streaming
While connected, client also streams each probe result over WebSocket as a `probe_result` message for live dashboard updates. These are written to local DB first. The periodic HTTP sync catches anything WebSocket missed.

### Backpressure
- 500-row batch limit per request
- Client loops until drained
- Server can respond with `{ "acked_seq": N, "throttle_ms": 1000 }` if under load

### Reconnect Burst (Worst Case)
1 week offline ≈ 443,520 rows → ~887 batches → drains in ~15 minutes with throttling.

---

## 4. Server-Side Schema

### New Table: Client Probe Results (WAN quality — primary data)

```sql
CREATE TABLE client_probe_results (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id     TEXT    NOT NULL,
    session_id    TEXT    NOT NULL,  -- client DB session UUID, resets on DB recreate
    seq_id        INTEGER NOT NULL,
    probe_type    TEXT    NOT NULL,  -- 'icmp' | 'http'
    target        TEXT    NOT NULL,
    timestamp     INTEGER NOT NULL,  -- client clock, unix millis
    rtt_ms        REAL,
    status_code   INTEGER,
    status        TEXT    NOT NULL,
    jitter_ms     REAL,
    received_at   INTEGER NOT NULL,  -- server clock, when synced
    UNIQUE(client_id, session_id, seq_id)
);
```

### Existing Tables
- `ping_results` — becomes "connection state" tracking (server heartbeat to client)
- `speed_tests` — unchanged
- `outages` — unchanged
- `clients` — unchanged

### Data Semantics
- `client_probe_results.timestamp` = when measurement happened (client clock)
- `client_probe_results.received_at` = when server ingested it
- Gap between the two indicates offline period
- Analytics Engine (`METRICS`) also receives client probe data for 90-day aggregated view

---

## 5. Server Heartbeat & Down Detection

The Durable Object keeps its existing WebSocket heartbeat to the client. This is now purely for connection state tracking, not WAN quality measurement.

### Down Detection Flow
1. WebSocket drops (or ping timeout)
2. Server starts grace timer: `down_alert_grace_seconds` (default: 60s, per-client configurable)
3. If client doesn't reconnect within grace → mark as `down`
4. Fire alert via configured channels per client settings
5. On reconnect → mark as `up`, send recovery notification
6. Record outage in `outages` table

### Per-Client Alert Config (extends `config_json`)

```json
{
    "down_alert_grace_seconds": 60,
    "down_alert_channels": ["telegram"],
    "down_alert_escalation": {
        "enabled": false,
        "escalate_after_seconds": 600,
        "escalate_channels": ["email"]
    }
}
```

---

## 6. Server-Side Retention Policy

Per-client retention, configurable from dashboard, enforced on existing 6h cron.

### Config (extends `config_json`)

```json
{
    "retention": {
        "raw_days": 30,
        "aggregated_days": 90,
        "archive_to_r2": true
    }
}
```

### Cleanup Flow (per client, every 6h)
1. Query `client_probe_results` and `ping_results` older than `raw_days`
2. If `archive_to_r2` is true, export to R2 as CSV (existing archival logic)
3. Delete from D1
4. Analytics Engine data ages out per its own retention

---

## 7. Client Config Changes

### Local `~/.pingpulse/config.toml` Additions

```toml
[probes.icmp]
enabled = true
interval_s = 5
targets = ["8.8.8.8", "1.1.1.1", "9.9.9.9"]
timeout_ms = 3000

[probes.http]
enabled = true
interval_s = 15
targets = ["https://www.google.com", "https://cloudflare.com"]
timeout_ms = 5000

[storage]
db_path = "~/.pingpulse/probes.db"
retention_days = 7

[sync]
batch_size = 500
interval_s = 60
```

---

## 8. Dashboard Changes

### WAN Quality View (new, primary)
- Timeline chart: client-measured latency per target (ICMP + HTTP)
- Packet loss percentage over time
- Jitter trend
- Filterable by probe type and target

### Connection State View (replaces "Ping Results")
- Server↔Client connection status timeline (up/down)
- Server-measured RTT to client
- Outage history with durations
- Gap visualization: periods synced retroactively shown in distinct color

### Sync Status
- Per-client badge: last sync time, unsynced row count, buffer age
- New column in clients list table

### Alert Config
- Down detection settings in client edit dialog (grace period, channels, escalation)
- Retention policy settings in client edit dialog

---

## 9. Load Budget (100 Clients, Aggressive Defaults)

| Probe | Interval | Per Client/min | 100 Clients/min | 100 Clients/hour |
|-------|----------|---------------|-----------------|-------------------|
| ICMP (3 targets) | 5s | 36 | 3,600 | 216,000 |
| HTTP (2 targets) | 15s | 8 | 800 | 48,000 |
| **Total probes** | | **44** | **4,400** | **264,000** |

- D1: ~73 inserts/sec across 100 DOs — comfortable
- WebSocket: 200 heartbeat pings/min — trivial
- HTTP sync: mostly no-ops while connected, burst on reconnect with throttling

---

## 10. New WebSocket Message Types

### Client → Server
- `probe_result` — real-time probe measurement (streamed while connected)

### Server → Client
- (existing) `config_update`, `ping`, `trigger_speed_test`

### HTTP Endpoints
- `POST /api/clients/:id/sync` — batch sync of probe results (new)

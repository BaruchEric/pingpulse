# PingPulse: Trippy Path-Tracing Integration (trace-on-alert)

**Date:** 2026-07-21
**Scope:** Fold [fujiapple852/trippy](https://github.com/fujiapple852/trippy)'s path-intelligence capabilities into PingPulse — per-hop tracing, ASN/GeoIP enrichment, and TCP/UDP/IPv6 probing — culminating in *trace-on-alert*.

---

## Foundation decision

PingPulse is the base; Trippy is merged into it. PingPulse already owns the hard, non-trivial platform: a distributed agent fleet, per-client Durable Objects, D1/R2/Analytics history, an alert pipeline (Telegram/Resend), a remote React dashboard, and OTA client updates. Trippy is a single-session terminal diagnostic with none of that. What Trippy has that PingPulse lacks is **path intelligence** — and, critically, it ships that intelligence as a reusable Apache-2.0 library (`trippy-core`, `trippy-dns`), so merging is *adding a dependency to the existing Rust client*, not a rewrite.

This is only cheap because **the client is Rust** (Tokio, `surge-ping`, `reqwest`, `axum`). `crates/trippy/examples/toy-traceroute` is a working "traceroute built on `trippy-core`" reference and depends on `trippy = { features = ["core", "dns"] }`.

## Capability gap being closed

PingPulse today probes **endpoints only** — single-shot ICMP-v4 echo (`surge-ping`, one `PingSequence(0)`) + HTTP `HEAD`. Verified: no `ttl`/`hop`/`traceroute`/`geoip`/`asn` anywhere in `client/` or `worker/`. It reports *that* a host degraded, never *where* on the path.

| Capability | Have | Merging in | Phase |
|---|:--:|:--:|:--:|
| Per-hop path tracing (traceroute/mtr) | ❌ | `trippy-core` | 1 |
| Reverse-DNS + ASN per hop | ❌ | `trippy-dns` | 2 |
| GeoIP (MaxMind/IPinfo `.mmdb`) | ❌ | worker-side lookup | 2 |
| Trace-on-alert (auto path trace on degradation) | ❌ | glue over 1+2 | 3 |
| TCP/UDP tracing + IPv6 | ❌ (ICMP::V4 only) | `trippy-core` protocol switch | 4 |
| ECMP multipath / flow isolation | ❌ | `trippy-core` (deferred) | 5 |

---

## Phase 1 — On-demand path tracing (core)

The client runs a **bounded** trace to a target on request and streams per-hop results to its Durable Object. Bounded is essential: a background daemon must not run interactive-style continuous tracing.

### `client/Cargo.toml`

```toml
trippy-core = "0.14"
trippy-dns  = "0.14"   # used in Phase 2; add now to avoid a second version bump
```

### New file: `client/src/trace.rs`

`trippy-core`'s `Tracer` is thread/blocking (`run` / `run_with`), so drive it off the Tokio runtime via `spawn_blocking`.

```rust
use trippy_core::{Builder, Protocol, PrivilegeMode};
use std::net::IpAddr;

pub async fn run_trace(addr: IpAddr, rounds: usize) -> anyhow::Result<Vec<HopSample>> {
    tokio::task::spawn_blocking(move || {
        let hops = std::sync::Mutex::new(Vec::new());
        Builder::new(addr)
            .protocol(Protocol::Icmp)          // Phase 4 makes this configurable
            .privilege_mode(PrivilegeMode::Privileged)
            .max_rounds(Some(rounds))          // e.g. 3 — bounded, then stops
            .max_ttl(30)
            .build()?
            .run_with(|round| collect_hops(round, &hops))?;
        Ok(hops.into_inner().unwrap())
    })
    .await?
}
```

`collect_hops` maps `trippy_core::state::Hop` (ttl, addr, sent/recv, last/avg/best/worst/stddev/jitter, loss%) into a flat `HopSample`. Per-hop stats come for free — this is exactly the per-hop richness PingPulse lacks at the endpoint level.

**Privilege:** the client already requires `CAP_NET_RAW` for ICMP (`probe.rs` warns when the socket fails), so the prerequisite is met. Trippy's `trippy-privilege` crate handles the cross-OS elevation (Linux caps / Windows) if we want to formalize it.

### `client/src/messages.rs`

```rust
// server → client
enum IncomingMessage { /* … */ RunTrace { target: String, rounds: u8 } }
// client → server
enum OutgoingMessage { /* … */ TraceResult { session_id: String, target: String, hops: Vec<HopSample>, started_at: String } }
```

`HopSample { ttl, addr: Option<String>, loss_pct, sent, recv, last_ms, avg_ms, best_ms, worst_ms, stddev_ms, jitter_ms }`.

### New migration: `worker/migrations/0004_trace_results.sql`

```sql
CREATE TABLE IF NOT EXISTS traces (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, target TEXT NOT NULL,
  protocol TEXT NOT NULL DEFAULT 'icmp', started_at TEXT NOT NULL, trigger TEXT NOT NULL  -- 'manual' | 'alert'
);
CREATE TABLE IF NOT EXISTS trace_hops (
  id INTEGER PRIMARY KEY AUTOINCREMENT, trace_id TEXT NOT NULL, ttl INTEGER NOT NULL,
  addr TEXT, hostname TEXT, asn INTEGER, asn_name TEXT, geo TEXT,   -- hostname/asn/geo filled in Phase 2
  loss_pct REAL, sent INTEGER, recv INTEGER,
  last_ms REAL, avg_ms REAL, best_ms REAL, worst_ms REAL, stddev_ms REAL, jitter_ms REAL
);
CREATE INDEX IF NOT EXISTS idx_trace_hops_trace ON trace_hops(trace_id, ttl);
CREATE INDEX IF NOT EXISTS idx_traces_client ON traces(client_id, started_at);
```

### Worker + dashboard

- `worker/src/durable-objects/client-monitor.ts` — handle inbound `TraceResult`: insert `traces` + `trace_hops`.
- `worker/src/api/command.ts` — add `POST /api/clients/:id/trace` that pushes `RunTrace` down the DO WebSocket (reuses the existing command channel).
- `worker/dashboard/src/pages/ControlPanel.tsx` — "Trace path" button per target.
- New `worker/dashboard/src/components/TraceHopTable.tsx` — mtr-style hop table, surfaced on `ClientDetail.tsx`.

---

## Phase 2 — Enrichment (ASN / GeoIP / reverse-DNS)

Turns raw hop IPs into accountable parties: *"hop 6 = AS174 Cogent, Frankfurt."*

- **rDNS + ASN:** `trippy-dns` (`Resolver`) client-side, or resolve lazily worker-side to keep agents thin. ASN via Trippy's DNS-based origin lookup.
- **GeoIP:** worker-side `.mmdb` lookup (MaxMind or IPinfo) so the database lives once in the worker/R2, not on every agent. `maxminddb` crate on the client is the alternative if we prefer edge-free enrichment.
- Populate `trace_hops.hostname/asn/asn_name/geo`; render owner + flag in `TraceHopTable`.

Delivers standalone value on the endpoint IP immediately, and per-hop value once Phase 1 lands.

---

## Phase 3 — Trace-on-alert ⭐ (the headline)

The reason to do any of this. When the worker detects degradation/outage, auto-fire an enriched trace and attach it to the alert.

- `worker/src/durable-objects/client-monitor.ts` (`triggerAlert()`) / `worker/src/services/alert-dispatch.ts` — on alert, push `RunTrace` to the offending client, wait briefly (bounded) for the `TraceResult`, enrich it, and include a hop summary in the Telegram/email body.
- Alert copy goes from *"novamini degraded"* → *"novamini → 1.1.1.1 degraded; loss starts at hop 6, 203.0.113.x (AS174 Cogent)."*
- Reuses the existing command channel, alert pipeline, and DO session — the only genuinely new pieces are Phases 1 and 2.
- Guardrails: rate-limit alert-triggered traces per client; `trigger='alert'` on the `traces` row; skip if the client is fully offline (nothing to trace from).

---

## Phase 4 — Probe realism: TCP/UDP + IPv6

Many networks deprioritize/block ICMP, producing false "loss" that misleads alerts.

- With `trippy-core` present, tracing gains TCP/UDP via `.protocol(Protocol::Tcp)` + `.port_direction(PortDirection::…)`; IPv6 is automatic (`Builder::new` takes `IpAddr`).
- For plain (non-trace) endpoint probes, add a TCP-connect probe type in `client/src/probe.rs`; relax the `probe_type` CHECK (`'icmp','http'`) and the hardcoded `ICMP::V4`.

---

## Phase 5 — ECMP multipath / flows (deferred)

Real but advanced; defer until Phases 1–4 are proven. `trippy-core` already exposes `MultipathStrategy` (Dublin/Paris), `max_flows`, and `FlowId`; the work is the data model + UI to represent multiple flows per target, not the tracing.

---

## File Change Summary

### New files
- `client/src/trace.rs` — `trippy-core` trace runner (`spawn_blocking`)
- `worker/migrations/0004_trace_results.sql` — `traces` + `trace_hops`
- `worker/dashboard/src/components/TraceHopTable.tsx` — mtr-style hop view

### Modified files
- `client/Cargo.toml` — add `trippy-core`, `trippy-dns`
- `client/src/messages.rs` — `RunTrace` (in) + `TraceResult` (out)
- `client/src/main.rs` / `websocket.rs` — dispatch `RunTrace` → `trace::run_trace`
- `client/src/probe.rs` — (Phase 4) TCP-connect probe, drop `ICMP::V4` hardcode
- `worker/src/durable-objects/client-monitor.ts` — persist `TraceResult`; trace-on-alert
- `worker/src/api/command.ts` — `POST /api/clients/:id/trace`
- `worker/src/services/alert-dispatch.ts` — trigger + embed trace in alerts
- `worker/dashboard/src/pages/{ControlPanel,ClientDetail}.tsx` — trigger + display

### New dependencies
- `trippy-core` (Apache-2.0) — path tracing engine
- `trippy-dns` (Apache-2.0) — rDNS + ASN
- (Phase 2, optional) `maxminddb` — client-side GeoIP if not done worker-side

### Risks / notes
- `trippy-core`'s public API is explicitly "not stable" — pin the version and wrap it behind `client/src/trace.rs`.
- Raw-socket privilege on Windows agents needs verifying against `trippy-privilege`.
- Always bound traces (`max_rounds`, `max_ttl`, `max_round_duration`) — this is a daemon, not an interactive session.
- **Repo correction:** `CLAUDE.md` calls the client "Zig"; it is Rust (`client/src/*.rs`, crate `pingpulse` v1.0.5). Fixed alongside this spec — and it's precisely what makes this merge cheap.
```

# Design Review: Client as Source of Truth

**Spec:** `docs/superpowers/specs/2026-03-21-client-source-of-truth-design.md`
**Reviewer:** Code Review Agent
**Date:** 2026-03-21

---

## Overall Assessment

The spec is well-structured and addresses the core problem clearly: eliminating measurement gaps during WebSocket disconnections by making the client an autonomous observer. The dual-channel architecture (WebSocket for real-time, HTTP for batch sync) is a sound design choice. The load budget analysis is thorough and the sync protocol is well-thought-out with idempotency and backpressure.

Several issues need attention before implementation, ranging from a critical deduplication flaw to missing details that will cause ambiguity during development.

---

## Issues

### CRITICAL

#### 1. Deduplication by `(client_id, seq_id)` is unsafe across client reinstalls

**Section 3 & 4.** The spec uses `UNIQUE(client_id, seq_id)` for dedup, where `seq_id` is `INTEGER PRIMARY KEY AUTOINCREMENT` in the client's SQLite. If a client is reinstalled, re-registered with the same `client_id`, or if `probes.db` is deleted, `seq_id` resets to 1. The server will silently reject or overwrite legitimate new data that collides with old `seq_id` values.

**Fix:** Either:
- (a) Add a `session_id` (random UUID generated on DB creation) to the client's `sync_state` table, and include it in the unique constraint: `UNIQUE(client_id, session_id, seq_id)`.
- (b) Use a UUID primary key in the client DB instead of autoincrement, and deduplicate by `(client_id, probe_id)` on the server.

Option (a) is simpler and preserves the ordered-sequence properties the sync protocol relies on.

#### 2. `acked_seq` marks all rows up to N as synced -- unsafe with concurrent probe writes

**Section 3.** Step 4 says: "Client marks `synced = 1` for all rows up to `acked_seq`." If the probe loop inserts new rows with `seq_id` values between the batch query and the server ack, those rows will be incorrectly marked as synced despite never being sent.

**Fix:** The client must mark synced using the exact set of `seq_id` values that were included in the batch, not a range:
```sql
UPDATE probe_results SET synced = 1 WHERE seq_id IN (?, ?, ?, ...)
```
Or at minimum: `WHERE seq_id <= ? AND synced = 0 AND seq_id IN (<sent_ids>)`.

---

### MAJOR

#### 3. Clock skew handling is unspecified

**Section 4.** The spec stores `timestamp` (client clock) and `received_at` (server clock) and notes the gap "indicates offline period." But there is no handling for clients with drifted clocks. A client 5 minutes ahead will produce timestamps in the future relative to `received_at`, and analytics/dashboard queries sorted by timestamp will show data out of order.

**Fix:** Add a section on clock skew:
- Server should compute `clock_offset = received_at - timestamp` on each sync batch and log/alert if offset exceeds a threshold (e.g., 30s).
- Dashboard should use `received_at` for ordering when skew is detected.
- Optionally: the server can send its current timestamp in the sync response, letting the client self-diagnose drift.

#### 4. No authentication on the sync endpoint beyond Bearer token

**Section 3.** The sync endpoint uses `Authorization: Bearer <client_secret>` but the spec does not specify that the `:id` in the URL path must match the authenticated client. A client with a valid token could potentially POST data to another client's sync endpoint.

**Fix:** The server must validate that the Bearer token's associated `client_id` matches the `:id` URL parameter. Add this explicitly to the server-side flow.

#### 5. Jitter calculation in the client probe engine is unspecified

**Section 1.** ICMP probes record `jitter_ms` but the spec does not define how jitter is calculated on the client side. The server currently uses RFC 3550 running jitter (visible in `client-monitor.ts` line 417). The client probe engine needs the same algorithm specified, or jitter values from client probes vs. server heartbeat probes will be incomparable.

**Fix:** Specify RFC 3550 running jitter in the probe engine section, or explicitly state jitter is computed per-target using the same formula as the existing server implementation.

#### 6. SQLite concurrent access from probe loop and sync loop

**Section 2 & 3.** The client will have at least two concurrent tasks accessing `probes.db`: the probe loop (INSERT) and the sync loop (SELECT + UPDATE). SQLite's default journal mode can cause `SQLITE_BUSY` errors under concurrent writes.

**Fix:** Specify that the client must open SQLite with `journal_mode=WAL` (Write-Ahead Logging), which allows concurrent readers and a single writer without blocking. This is a one-liner but critical for correctness.

#### 7. No migration path for existing `ping_results` data

**Section 4.** The spec says `ping_results` "becomes connection state tracking" but does not specify:
- Whether existing `ping_results` rows are migrated to `client_probe_results`
- Whether the dashboard shows a unified timeline or has a gap at the transition point
- Whether `ping_results` continues to receive writes from the server heartbeat

**Fix:** Add a migration strategy section: existing `ping_results` data stays as-is for historical queries, the `ping_results` table continues to receive server heartbeat measurements, and the dashboard WAN Quality view only shows `client_probe_results` data (with a "data available from" marker).

---

### MINOR

#### 8. Retention cleanup "after each probe cycle" is too frequent

**Section 2.** Running `DELETE FROM probe_results WHERE timestamp < ? AND synced = 1` every 5 seconds is wasteful. SQLite DELETE with a WHERE clause on non-indexed columns causes a table scan.

**Fix:** Run cleanup once per hour (or on a separate timer), and add an index:
```sql
CREATE INDEX idx_probe_results_synced_ts ON probe_results(synced, timestamp);
```

#### 9. Load budget row count math is slightly off

**Section 9.** "1 week offline ~ 443,520 rows" at 44 probes/min = 44 * 60 * 24 * 7 = 443,520. This checks out. But "~887 batches" at 500/batch = 443,520 / 500 = 887.04. The concern is the "drains in ~15 minutes with throttling" claim: 887 batches at 1000ms throttle = 887 seconds = ~14.8 minutes. This only holds if there is zero processing time per batch. With D1 write latency (~50-100ms per batch insert of 500 rows), actual drain time is closer to 17-18 minutes.

**Fix:** Minor -- update the estimate to "~15-20 minutes" or note it excludes processing time.

#### 10. Config hierarchy conflict resolution unclear for partial overlap

**Section 1.** "Server-pushed config wins on conflict" but the spec defines different config shapes for local TOML (Section 7, with `[probes.icmp]`, `[probes.http]`, `[sync]`) vs. the existing server-pushed config (which has `ping_interval_s`, `probe_size_bytes`, etc. -- visible in `RemoteConfig` in the Rust client). The server config does not include probe targets or sync settings, so it is unclear what "wins on conflict" means for fields that exist only in local config.

**Fix:** Explicitly enumerate which fields can be server-overridden and which are local-only. Suggested split:
- **Server-controlled:** probe intervals, alert thresholds, grace period
- **Local-only:** probe targets, DB path, sync batch size, retention days

#### 11. Missing `UpdateAvailable` handling in context of new architecture

**Section 10.** The new WebSocket message types section lists only `probe_result` as new. But the existing `update_available` message type (visible in client-monitor.ts line 147) is not mentioned. This is fine if unchanged, but the spec should acknowledge existing message types are preserved for completeness.

#### 12. No spec for HTTP sync endpoint error responses

**Section 3.** The spec defines the success response `{ "acked_seq": N }` and throttle response, but does not specify error responses. What does the client do on 400, 401, 413 (payload too large), 429 (rate limited), or 500?

**Fix:** Add an error handling table:
- 400: log and skip batch (malformed data, do not retry)
- 401: re-authenticate or trigger reconnect flow
- 413: reduce batch size and retry
- 429: use `Retry-After` header or exponential backoff
- 500: retry with backoff

---

## Consistency Check

| Area | Consistent? | Note |
|------|-------------|------|
| Timestamp format | No | Client SQLite uses unix millis (INTEGER), server `ping_results` uses ISO 8601 (TEXT). Spec should note the conversion happens at sync time. |
| Probe intervals | Yes | 5s ICMP / 15s HTTP matches load budget math. |
| Auth model | Yes | Same Bearer token as existing WebSocket auth. |
| Config hierarchy | Partial | See issue #10 above. |
| Retention | Yes | Client 7d, server 30d raw / 90d aggregated. Consistent. |

---

## What Was Done Well

- The dual-channel separation (WebSocket for real-time, HTTP for batch) is architecturally clean and avoids overloading the WebSocket with retries.
- The "never delete unsynced rows" retention policy is a good defensive measure.
- The backpressure design with `throttle_ms` is practical and prevents reconnect storms.
- The load budget section is thorough and demonstrates the design works at scale.
- Building on existing auth infrastructure rather than introducing a new auth mechanism keeps complexity low.

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 2 |
| Major | 5 |
| Minor | 5 |

The two critical issues (seq_id collision on reinstall, and unsafe range-based sync marking) must be resolved before implementation begins. The major issues should be addressed in the spec before coding starts but have straightforward fixes. Minor issues can be resolved during implementation.

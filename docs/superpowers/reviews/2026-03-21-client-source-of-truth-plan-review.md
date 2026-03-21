# Plan Review: Client as Source of Truth

**Reviewed:** 2026-03-21
**Plan:** `docs/superpowers/plans/2026-03-21-client-source-of-truth.md`
**Spec:** `docs/superpowers/specs/2026-03-21-client-source-of-truth-design.md`

---

## Summary

The plan is well-structured with 15 tasks, correct dependency ordering, and good parallelization opportunities. However, there are several critical and major issues that will cause build failures or runtime bugs if not addressed before implementation.

---

## Critical Issues (must fix)

### C1. `ProbeStore` is not `Send` -- cannot share across tokio tasks

**Task 5, Steps 5-6.** `rusqlite::Connection` is not `Send`, so `ProbeStore` cannot be moved into a `tokio::spawn` or shared across async tasks. The plan does this in two places:

- Step 5: `sync_client.sync_all(&store)` inside `tokio::spawn`
- Step 6: `store_clone` moved into a spawned task while `store` is also used in the select loop

**Fix:** Wrap the connection in `Arc<Mutex<Connection>>` (using `tokio::sync::Mutex` or `std::sync::Mutex`), or open separate `Connection` instances per task (SQLite WAL mode supports concurrent readers). The cleanest approach: make `ProbeStore::open` return an `Arc<ProbeStore>` with interior `Mutex<Connection>`, or use `r2d2` connection pooling.

### C2. `dispatchAlert` signature mismatch in Task 10

**Task 10, Step 2.** The plan calls:
```typescript
await dispatchAlert(this.env, { ...alertData }, { email: shouldEmail, telegram: shouldTelegram });
```

But the actual `dispatchAlert` signature is `(env: Env, alert: AlertPayload) => Promise<void>` -- it takes exactly 2 arguments. The existing function decides channels by checking for env vars (`RESEND_API_KEY`, `TELEGRAM_BOT_TOKEN`), not a channel-selection parameter.

**Fix:** Either (a) modify `dispatchAlert` to accept an optional third `channels` parameter, or (b) add channel filtering inside the DO before calling `dispatchAlert`, or (c) create a new `dispatchAlertToChannels` wrapper.

### C3. Sync endpoint reimplements hashing instead of using `hashString` utility

**Task 8, Step 1.** The sync endpoint manually hashes the secret with inline `crypto.subtle.digest` code. The codebase already has `hashString` in `@/utils/hash` (used by the DO and self-delete route). The inline implementation is identical, but duplicating it is error-prone and violates DRY.

**Fix:** Import and use `hashString` from `@/utils/hash`:
```typescript
import { hashString } from "@/utils/hash";
const hashHex = await hashString(clientSecret);
```

### C4. Dual probe loops cause duplicate writes

**Task 5, Steps 4 and 6.** The plan creates two independent probe loops:
1. A background task (Step 6) that always runs and writes to the store
2. ICMP/HTTP branches in the `tokio::select!` loop (Step 4) that also probe and write to the store

When connected, both loops run simultaneously, producing duplicate probes at the same intervals. The Step 4 loop also streams over WebSocket, but the background task does not.

**Fix:** Use only the background task for probing. Have it send results through an `mpsc` channel. The `tokio::select!` loop receives from this channel, writes to the store, and optionally streams over WebSocket. When disconnected, the background task keeps probing and the channel buffers or the task writes directly to the store.

### C5. `surge-ping` API mismatch

**Task 2, Step 2.** The plan uses:
```rust
let mut pinger = self.ping_client.pinger(target.addr, PingIdentifier(rand::random())).await;
pinger.timeout(timeout);
match pinger.ping(PingSequence(0), &[0u8; 56]).await {
```

In `surge-ping` 0.8, `Client::pinger()` is not async -- it returns a `Pinger` directly, not a future. Also, `pinger.timeout()` is a builder method on `Pinger` that returns `&mut Pinger`, and `PingIdentifier`/`PingSequence` are simple tuple structs wrapping `u16`, so `rand::random()` needs to generate a `u16` specifically.

**Fix:** Remove `.await` from `pinger()`, confirm `rand::random::<u16>()` or `rand::random_range(0..u16::MAX)` for the identifier.

---

## Major Issues (should fix)

### M1. `new_from_registration` does not initialize new config fields

**Task 3.** After adding `probes`, `storage`, and `sync` fields to `Config`, the `new_from_registration()` constructor (used when a client first registers) does not set these fields. Without `#[serde(default)]` on the `Config` struct itself, constructing `Config` without these fields will fail to compile since they are not `Option` types.

**Fix:** Add the new fields with `Default::default()` values in `new_from_registration`:
```rust
probes: ProbesConfig::default(),
storage: StorageConfig::default(),
sync: SyncConfig::default(),
```

### M2. Migration file numbering

**Task 6.** The plan creates `0003_client_probes.sql`. Existing migrations are `0001_initial.sql` and `0002_add_client_version.sql`. The numbering is correct. However, D1 migrations use the `migrations/` directory and `wrangler d1 migrations apply` -- the plan uses `wrangler d1 execute --file` instead, which bypasses migration tracking.

**Fix:** Use `wrangler d1 migrations apply` for proper migration state tracking, or acknowledge that `execute --file` is for local dev only and add a note to run `migrations apply` for production.

### M3. `chrono` dependency used in `store.rs` but plan doesn't add it

**Task 1.** `store.rs` uses `chrono::Utc::now().timestamp_millis()` in `cleanup_old()`. The client already has `chrono` in Cargo.toml, so this works, but the plan doesn't mention the dependency. Similarly, Task 2 uses `chrono` in `probe.rs`. This is fine since chrono is already present, but should be noted.

### M4. `ping_results.timestamp` is ISO string, not unix millis

**Task 11, Step 1.** The retention cleanup query uses:
```sql
DELETE FROM ping_results WHERE client_id = ? AND timestamp < ?
```
with a unix-millis cutoff. But the existing `flushBuffer` in `client-monitor.ts` writes `timestamp: new Date().toISOString()` (ISO string) to `ping_results`. Comparing an ISO string to a unix-millis number will not work correctly.

**Fix:** Either convert the cutoff to ISO format for the `ping_results` query, or update `ping_results` to use unix millis. Since `client_probe_results` uses unix millis, the cleanest fix is to use ISO for the `ping_results` DELETE:
```typescript
const cutoffIso = new Date(cutoff).toISOString();
await env.DB.prepare("DELETE FROM ping_results WHERE client_id = ? AND timestamp < ?")
  .bind(client.id, cutoffIso).run();
```

### M5. `ProbeRecord.seq_id` initialized to 0 everywhere

**Task 2.** Every `ProbeRecord` constructed in `probe.rs` sets `seq_id: 0` with the comment "assigned by SQLite". But after `insert_probe`, the plan updates it via `ProbeRecord { seq_id, ..record }` in Task 5 Step 4. This works but is fragile -- the `seq_id` field should perhaps be `Option<i64>` to make the pre-insert state explicit.

### M6. Sync route placement may conflict with existing client routes

**Task 8, Step 2.** The plan mounts `syncRoutes` on `/api/clients`. But `clientRoutes` is already mounted there (line 61 of `router.ts`). Hono handles this by merging, but the sync route `/:clientId/sync` could conflict with existing `clientRoutes` patterns if any use a similar wildcard structure. Additionally, `syncRoutes` uses client-secret auth (not JWT), while `clientRoutes` likely uses JWT auth via middleware.

**Fix:** Mount sync routes before JWT-protected client routes (the plan notes this), and verify no route collision. Consider mounting at a distinct path like `/api/sync/:clientId` to avoid ambiguity.

### M7. No error handling for `ProbeEngine::new()` failure

**Task 5.** `ProbeEngine::new()` can fail if ICMP socket creation fails (requires root/capabilities on Linux). The plan uses `unwrap()` in the spawned background task. On macOS this generally works, but on Linux without `CAP_NET_RAW`, this will panic the entire daemon.

**Fix:** Handle the error gracefully -- if ICMP socket creation fails, log a warning and disable ICMP probes (fall back to HTTP-only probing).

---

## Minor Issues (nice to have)

### m1. No tests for Task 2 (Probe Engine)

The probe engine (Task 2) has no unit tests. Task 1 (store) has thorough tests. The plan should include at least mock-based tests for probe result construction.

### m2. No tests for Task 4 (Sync Client)

The sync module has no tests. Testing the sync loop with a mock HTTP server would catch serialization issues early.

### m3. No tests for Task 8 (Sync Endpoint)

The worker sync endpoint has no tests. An integration test with a mock D1 binding would verify the batch insert and deduplication logic.

### m4. Dashboard `ClientDetail.tsx` reference is correct but lacks specifics

**Task 13, Step 2.** The plan says to import `WanQualityChart` and add it to the page but doesn't specify where in the JSX or how `from`/`to` props are sourced. The existing page likely has a time range selector; this should reference it explicitly.

### m5. `db_path` tilde expansion is naive

**Task 3, Step 5.** `resolved_db_path` uses string replacement: `self.storage.db_path.replace("~", ...)`. This only handles the `~` prefix case. The `shellexpand` crate or `dirs::home_dir` combined with `Path::join` would be more robust.

### m6. Spec mentions "Connection State View" and "Gap visualization" -- not in plan

The spec (Section 8) describes a "Connection State View" replacing "Ping Results" with server-measured RTT timeline, outage history, and gap visualization. The plan has no task for this component (`ConnectionStateChart.tsx` is listed in the file table but has no task).

### m7. Spec mentions "Alert Config escalation" UI -- partially covered

The spec (Section 5) describes escalation settings (enabled, escalate_after_seconds, escalate_channels). Task 15 adds the grace period and channel checkboxes but does not include escalation toggle, delay, and escalation channels in the UI.

### m8. `SyncClient` is recreated every interval tick

**Task 5, Step 4.** A new `SyncClient` is constructed on every sync interval tick. This creates a new `reqwest::Client` each time, which means new TLS sessions. Create once and reuse.

---

## Spec Coverage Assessment

| Spec Section | Plan Coverage | Notes |
|---|---|---|
| 1. Client Probe Engine | Tasks 2, 3 | Covered |
| 2. Local Storage | Task 1 | Covered |
| 3. Sync Protocol | Tasks 4, 5, 8 | Covered |
| 4. Server Schema | Tasks 6, 7 | Covered |
| 5. Heartbeat & Down Detection | Task 10 | Partially -- escalation logic has signature bug (C2) |
| 6. Retention Policy | Task 11 | Covered, timestamp bug (M4) |
| 7. Client Config | Task 3 | Covered |
| 8. Dashboard Changes | Tasks 13-15 | Partial -- ConnectionStateChart missing (m6) |
| 9. Load Budget | N/A | Design concern, not implementation |
| 10. New WS Message Types | Tasks 5, 7, 9 | Covered |

---

## Task Ordering Assessment

The dependency graph is correct. Parallelization is well-identified:
- Tasks 1-4 (client) and 6-7 (worker) can run in parallel
- Tasks 8-12 depend on 6-7
- Tasks 13-15 depend on 12

One improvement: Task 9 (WS probe_result handler in DO) does not actually depend on Task 8 (sync endpoint). They both depend on 6-7 but are independent of each other. The dependency graph shows this correctly.

---

## TDD Assessment

TDD adherence is mixed:
- **Good:** Task 1 writes tests before the commit step
- **Weak:** Tasks 2, 4, 8, 9, 10, 11, 12 have no tests at all
- **Missing:** No integration test for the full client-to-server sync flow

Recommendation: Add test steps to Tasks 4 (sync client mock), 8 (sync endpoint), and at minimum a compilation check for Task 2 since ICMP testing requires privileges.

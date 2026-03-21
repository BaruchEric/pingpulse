# Client as Source of Truth — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the client the autonomous WAN quality observer with local storage and server sync, while the server becomes the connection monitor, notifier, and master of records.

**Architecture:** Dual-channel model — WebSocket for real-time streaming + heartbeat + config push, HTTP for batch sync. Client probes ICMP + HTTP targets independently, stores in local SQLite ring buffer, syncs to server via `POST /api/clients/:id/sync`. Server maintains heartbeat for connection state and configurable down detection with notifications.

**Tech Stack:** Rust (client: `rusqlite`, `surge-ping`, `reqwest`), TypeScript (worker: Hono, D1, Durable Objects), React (dashboard: uPlot, Tailwind)

**Spec:** `docs/superpowers/specs/2026-03-21-client-source-of-truth-design.md`

---

## File Structure

### Client — New/Modified Files

| File | Action | Responsibility |
|------|--------|---------------|
| `client/Cargo.toml` | Modify | Add `rusqlite` (bundled), `surge-ping`, `uuid` deps |
| `client/src/probe.rs` | Create | Probe engine: ICMP + HTTP probing logic |
| `client/src/store.rs` | Create | Local SQLite storage: schema, read/write, retention |
| `client/src/sync.rs` | Create | HTTP batch sync protocol |
| `client/src/config.rs` | Modify | Add probe, storage, sync config sections |
| `client/src/messages.rs` | Modify | Add `ProbeResult` outgoing message type |
| `client/src/websocket.rs` | Modify | Integrate probe loop, real-time streaming, sync trigger on reconnect |

### Worker — New/Modified Files

| File | Action | Responsibility |
|------|--------|---------------|
| `worker/migrations/0003_client_probes.sql` | Create | `client_probe_results` table |
| `worker/src/types.ts` | Modify | Extend `ClientConfig`, add probe/sync types |
| `worker/src/api/sync.ts` | Create | `POST /api/clients/:id/sync` handler |
| `worker/src/api/router.ts` | Modify | Register sync route |
| `worker/src/api/metrics.ts` | Modify | Query `client_probe_results` for WAN quality data |
| `worker/src/durable-objects/client-monitor.ts` | Modify | Handle `probe_result` WS message, configurable down detection |
| `worker/src/index.ts` | Modify | Per-client retention in cron handler |

### Dashboard — New/Modified Files

| File | Action | Responsibility |
|------|--------|---------------|
| `worker/dashboard/src/components/WanQualityChart.tsx` | Create | Timeline chart for client probe data |
| `worker/dashboard/src/components/ConnectionStateChart.tsx` | Create | Server heartbeat / connection state view |
| `worker/dashboard/src/components/SyncStatusBadge.tsx` | Create | Per-client sync indicator |
| `worker/dashboard/src/components/EditClientDialog.tsx` | Modify | Add probe config, down alert, retention fields |
| `worker/dashboard/src/pages/ClientDetail.tsx` | Modify | Integrate new chart components |

---

## Task 1: Client Local SQLite Storage

**Files:**
- Modify: `client/Cargo.toml`
- Create: `client/src/store.rs`
- Modify: `client/src/main.rs` (add `mod store`)

- [ ] **Step 1: Add dependencies to Cargo.toml**

Add to `[dependencies]` in `client/Cargo.toml`:

```toml
rusqlite = { version = "0.33", features = ["bundled"] }
uuid = { version = "1", features = ["v4"] }
```

- [ ] **Step 2: Create store module with schema initialization**

Create `client/src/store.rs`:

```rust
use anyhow::Result;
use rusqlite::Connection;
use std::path::Path;
use uuid::Uuid;

/// Thread-safe wrapper. `rusqlite::Connection` is not `Send`, so we use
/// `Arc<Mutex<>>` to share across tokio tasks.
pub struct ProbeStore {
    conn: std::sync::Arc<std::sync::Mutex<Connection>>,
    session_id: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ProbeRecord {
    pub seq_id: i64,
    pub probe_type: String,    // "icmp" | "http"
    pub target: String,
    pub timestamp: i64,        // unix millis
    pub rtt_ms: Option<f64>,
    pub status_code: Option<i32>,
    pub status: String,        // "ok" | "timeout" | "error"
    pub jitter_ms: Option<f64>,
}

impl ProbeStore {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS probe_results (
                seq_id        INTEGER PRIMARY KEY AUTOINCREMENT,
                probe_type    TEXT    NOT NULL,
                target        TEXT    NOT NULL,
                timestamp     INTEGER NOT NULL,
                rtt_ms        REAL,
                status_code   INTEGER,
                status        TEXT    NOT NULL,
                jitter_ms     REAL,
                synced        INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS sync_state (
                key   TEXT PRIMARY KEY,
                value TEXT
            );"
        )?;

        let session_id = Self::get_or_create_session_id(&conn)?;

        Ok(Self {
            conn: std::sync::Arc::new(std::sync::Mutex::new(conn)),
            session_id,
        })
    }

    /// Clone the Arc for sharing across tasks. Both handles share the same
    /// underlying Mutex<Connection>.
    pub fn clone_handle(&self) -> Self {
        Self {
            conn: self.conn.clone(),
            session_id: self.session_id.clone(),
        }
    }

    fn get_or_create_session_id(conn: &Connection) -> Result<String> {
        let existing: Option<String> = conn
            .query_row(
                "SELECT value FROM sync_state WHERE key = 'session_id'",
                [],
                |row| row.get(0),
            )
            .ok();

        if let Some(id) = existing {
            Ok(id)
        } else {
            let id = Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO sync_state (key, value) VALUES ('session_id', ?1)",
                [&id],
            )?;
            Ok(id)
        }
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn insert_probe(&self, record: &ProbeRecord) -> Result<i64> {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("lock poisoned: {e}"))?;
        conn.execute(
            "INSERT INTO probe_results (probe_type, target, timestamp, rtt_ms, status_code, status, jitter_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                record.probe_type,
                record.target,
                record.timestamp,
                record.rtt_ms,
                record.status_code,
                record.status,
                record.jitter_ms,
            ],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn get_unsynced(&self, limit: usize) -> Result<Vec<ProbeRecord>> {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("lock poisoned: {e}"))?;
        let mut stmt = conn.prepare(
            "SELECT seq_id, probe_type, target, timestamp, rtt_ms, status_code, status, jitter_ms
             FROM probe_results WHERE synced = 0 ORDER BY seq_id LIMIT ?1"
        )?;
        let rows = stmt.query_map([limit as i64], |row| {
            Ok(ProbeRecord {
                seq_id: row.get(0)?,
                probe_type: row.get(1)?,
                target: row.get(2)?,
                timestamp: row.get(3)?,
                rtt_ms: row.get(4)?,
                status_code: row.get(5)?,
                status: row.get(6)?,
                jitter_ms: row.get(7)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn mark_synced(&self, seq_ids: &[i64]) -> Result<()> {
        if seq_ids.is_empty() {
            return Ok(());
        }
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("lock poisoned: {e}"))?;
        let placeholders: Vec<String> = seq_ids.iter().map(|_| "?".to_string()).collect();
        let sql = format!(
            "UPDATE probe_results SET synced = 1 WHERE seq_id IN ({})",
            placeholders.join(",")
        );
        let params: Vec<Box<dyn rusqlite::types::ToSql>> =
            seq_ids.iter().map(|id| Box::new(*id) as Box<dyn rusqlite::types::ToSql>).collect();
        conn.execute(&sql, rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())))?;
        Ok(())
    }

    pub fn cleanup_old(&self, retention_days: u32) -> Result<usize> {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("lock poisoned: {e}"))?;
        let cutoff_ms = chrono::Utc::now().timestamp_millis()
            - (retention_days as i64 * 24 * 60 * 60 * 1000);
        let deleted = conn.execute(
            "DELETE FROM probe_results WHERE timestamp < ?1 AND synced = 1",
            [cutoff_ms],
        )?;
        Ok(deleted)
    }
}
```

- [ ] **Step 3: Register the store module**

Add to `client/src/main.rs` alongside other `mod` declarations:

```rust
mod store;
```

- [ ] **Step 4: Write unit tests for store**

Add to the bottom of `client/src/store.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn test_store() -> (ProbeStore, TempDir) {
        let dir = TempDir::new().unwrap();
        let store = ProbeStore::open(&dir.path().join("test.db")).unwrap();
        (store, dir)
    }

    #[test]
    fn test_session_id_persists() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.db");
        let id1 = ProbeStore::open(&path).unwrap().session_id().to_string();
        let id2 = ProbeStore::open(&path).unwrap().session_id().to_string();
        assert_eq!(id1, id2);
    }

    #[test]
    fn test_new_db_gets_new_session_id() {
        let (store1, _d1) = test_store();
        let (store2, _d2) = test_store();
        assert_ne!(store1.session_id(), store2.session_id());
    }

    #[test]
    fn test_insert_and_query_unsynced() {
        let (store, _dir) = test_store();
        let record = ProbeRecord {
            seq_id: 0,
            probe_type: "icmp".into(),
            target: "8.8.8.8".into(),
            timestamp: 1234567890000,
            rtt_ms: Some(15.5),
            status_code: None,
            status: "ok".into(),
            jitter_ms: Some(2.1),
        };
        store.insert_probe(&record).unwrap();
        let unsynced = store.get_unsynced(100).unwrap();
        assert_eq!(unsynced.len(), 1);
        assert_eq!(unsynced[0].probe_type, "icmp");
        assert_eq!(unsynced[0].target, "8.8.8.8");
    }

    #[test]
    fn test_mark_synced() {
        let (store, _dir) = test_store();
        let record = ProbeRecord {
            seq_id: 0,
            probe_type: "icmp".into(),
            target: "8.8.8.8".into(),
            timestamp: 1234567890000,
            rtt_ms: Some(15.5),
            status_code: None,
            status: "ok".into(),
            jitter_ms: None,
        };
        let id = store.insert_probe(&record).unwrap();
        store.mark_synced(&[id]).unwrap();
        let unsynced = store.get_unsynced(100).unwrap();
        assert_eq!(unsynced.len(), 0);
    }

    #[test]
    fn test_cleanup_respects_synced() {
        let (store, _dir) = test_store();
        let old_ts = chrono::Utc::now().timestamp_millis() - (8 * 24 * 60 * 60 * 1000); // 8 days ago
        let record = ProbeRecord {
            seq_id: 0,
            probe_type: "icmp".into(),
            target: "8.8.8.8".into(),
            timestamp: old_ts,
            rtt_ms: Some(10.0),
            status_code: None,
            status: "ok".into(),
            jitter_ms: None,
        };
        store.insert_probe(&record).unwrap();

        // unsynced old record should NOT be deleted
        let deleted = store.cleanup_old(7).unwrap();
        assert_eq!(deleted, 0);

        // mark synced, then cleanup should delete
        let unsynced = store.get_unsynced(100).unwrap();
        store.mark_synced(&[unsynced[0].seq_id]).unwrap();
        let deleted = store.cleanup_old(7).unwrap();
        assert_eq!(deleted, 1);
    }
}
```

- [ ] **Step 5: Run tests**

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/client && cargo test store`
Expected: All 4 tests pass.

- [ ] **Step 6: Commit**

```bash
git add client/Cargo.toml client/src/store.rs client/src/main.rs
git commit -m "feat(client): add local SQLite probe storage with session tracking"
```

---

## Task 2: Client Probe Engine

**Files:**
- Modify: `client/Cargo.toml`
- Create: `client/src/probe.rs`
- Modify: `client/src/main.rs` (add `mod probe`)

- [ ] **Step 1: Add surge-ping dependency**

Add to `[dependencies]` in `client/Cargo.toml`:

```toml
surge-ping = "0.8"
```

- [ ] **Step 2: Create probe module**

Create `client/src/probe.rs`:

```rust
use anyhow::Result;
use reqwest::Client as HttpClient;
use std::net::IpAddr;
use std::time::{Duration, Instant};
use surge_ping::{Client as PingClient, Config as PingConfig, PingIdentifier, PingSequence, ICMP};
use tracing::{debug, warn};

use crate::store::ProbeRecord;

pub struct ProbeEngine {
    ping_client: Option<PingClient>,  // None if ICMP socket creation failed
    http_client: HttpClient,
}

#[derive(Debug, Clone)]
pub struct IcmpTarget {
    pub addr: IpAddr,
    pub label: String,
}

#[derive(Debug, Clone)]
pub struct HttpTarget {
    pub url: String,
}

impl ProbeEngine {
    pub fn new() -> Result<Self> {
        let ping_config = PingConfig::builder().kind(ICMP::V4).build();
        let ping_client = match PingClient::new(&ping_config) {
            Ok(c) => Some(c),
            Err(e) => {
                warn!(error = %e, "ICMP socket creation failed (need root/CAP_NET_RAW?) — ICMP probes disabled");
                None
            }
        };
        let http_client = HttpClient::builder()
            .timeout(Duration::from_millis(5000))
            .build()?;
        Ok(Self { ping_client, http_client })
    }

    pub async fn probe_icmp(&self, target: &IcmpTarget, timeout_ms: u64) -> ProbeRecord {
        let now_ms = chrono::Utc::now().timestamp_millis();
        let timeout = Duration::from_millis(timeout_ms);

        let ping_client = match &self.ping_client {
            Some(c) => c,
            None => {
                return ProbeRecord {
                    seq_id: 0, probe_type: "icmp".into(), target: target.label.clone(),
                    timestamp: now_ms, rtt_ms: None, status_code: None,
                    status: "error".into(), jitter_ms: None,
                };
            }
        };

        let mut pinger = ping_client.pinger(target.addr, PingIdentifier(rand::random()));
        pinger.timeout(timeout);

        let start = Instant::now();
        match pinger.ping(PingSequence(0), &[0u8; 56]).await {
            Ok((_reply, rtt)) => {
                let rtt_ms = rtt.as_secs_f64() * 1000.0;
                debug!(target = %target.label, rtt_ms, "ICMP probe ok");
                ProbeRecord {
                    seq_id: 0, // assigned by SQLite
                    probe_type: "icmp".into(),
                    target: target.label.clone(),
                    timestamp: now_ms,
                    rtt_ms: Some(rtt_ms),
                    status_code: None,
                    status: "ok".into(),
                    jitter_ms: None, // calculated by caller if needed
                }
            }
            Err(e) => {
                let elapsed = start.elapsed();
                let status = if elapsed >= timeout { "timeout" } else { "error" };
                warn!(target = %target.label, error = %e, status, "ICMP probe failed");
                ProbeRecord {
                    seq_id: 0,
                    probe_type: "icmp".into(),
                    target: target.label.clone(),
                    timestamp: now_ms,
                    rtt_ms: None,
                    status_code: None,
                    status: status.into(),
                    jitter_ms: None,
                }
            }
        }
    }

    pub async fn probe_http(&self, target: &HttpTarget, timeout_ms: u64) -> ProbeRecord {
        let now_ms = chrono::Utc::now().timestamp_millis();

        let client = HttpClient::builder()
            .timeout(Duration::from_millis(timeout_ms))
            .build()
            .unwrap_or_else(|_| self.http_client.clone());

        let start = Instant::now();
        match client.head(&target.url).send().await {
            Ok(resp) => {
                let rtt_ms = start.elapsed().as_secs_f64() * 1000.0;
                let status_code = resp.status().as_u16() as i32;
                debug!(target = %target.url, rtt_ms, status_code, "HTTP probe ok");
                ProbeRecord {
                    seq_id: 0,
                    probe_type: "http".into(),
                    target: target.url.clone(),
                    timestamp: now_ms,
                    rtt_ms: Some(rtt_ms),
                    status_code: Some(status_code),
                    status: "ok".into(),
                    jitter_ms: None,
                }
            }
            Err(e) => {
                let elapsed = start.elapsed();
                let status = if e.is_timeout() || elapsed >= Duration::from_millis(timeout_ms) {
                    "timeout"
                } else {
                    "error"
                };
                warn!(target = %target.url, error = %e, status, "HTTP probe failed");
                ProbeRecord {
                    seq_id: 0,
                    probe_type: "http".into(),
                    target: target.url.clone(),
                    timestamp: now_ms,
                    rtt_ms: None,
                    status_code: None,
                    status: status.into(),
                    jitter_ms: None,
                }
            }
        }
    }
}
```

- [ ] **Step 3: Register the probe module**

Add to `client/src/main.rs`:

```rust
mod probe;
```

- [ ] **Step 4: Build and verify compilation**

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/client && cargo build`
Expected: Compiles successfully.

- [ ] **Step 5: Commit**

```bash
git add client/Cargo.toml client/src/probe.rs client/src/main.rs
git commit -m "feat(client): add ICMP and HTTP probe engine"
```

---

## Task 3: Client Probe Config

**Files:**
- Modify: `client/src/config.rs`

- [ ] **Step 1: Add probe config structs**

Add to `client/src/config.rs`, after the existing config structs:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProbeIcmpConfig {
    #[serde(default = "default_probe_icmp_enabled")]
    pub enabled: bool,
    #[serde(default = "default_probe_icmp_interval")]
    pub interval_s: u32,
    #[serde(default = "default_probe_icmp_targets")]
    pub targets: Vec<String>,
    #[serde(default = "default_probe_icmp_timeout")]
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProbeHttpConfig {
    #[serde(default = "default_probe_http_enabled")]
    pub enabled: bool,
    #[serde(default = "default_probe_http_interval")]
    pub interval_s: u32,
    #[serde(default = "default_probe_http_targets")]
    pub targets: Vec<String>,
    #[serde(default = "default_probe_http_timeout")]
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProbesConfig {
    #[serde(default)]
    pub icmp: ProbeIcmpConfig,
    #[serde(default)]
    pub http: ProbeHttpConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageConfig {
    #[serde(default = "default_storage_db_path")]
    pub db_path: String,
    #[serde(default = "default_storage_retention_days")]
    pub retention_days: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncConfig {
    #[serde(default = "default_sync_batch_size")]
    pub batch_size: usize,
    #[serde(default = "default_sync_interval")]
    pub interval_s: u32,
}

fn default_probe_icmp_enabled() -> bool { true }
fn default_probe_icmp_interval() -> u32 { 5 }
fn default_probe_icmp_targets() -> Vec<String> {
    vec!["8.8.8.8".into(), "1.1.1.1".into(), "9.9.9.9".into()]
}
fn default_probe_icmp_timeout() -> u64 { 3000 }
fn default_probe_http_enabled() -> bool { true }
fn default_probe_http_interval() -> u32 { 15 }
fn default_probe_http_targets() -> Vec<String> {
    vec!["https://www.google.com".into(), "https://cloudflare.com".into()]
}
fn default_probe_http_timeout() -> u64 { 5000 }
fn default_storage_db_path() -> String { "~/.pingpulse/probes.db".into() }
fn default_storage_retention_days() -> u32 { 7 }
fn default_sync_batch_size() -> usize { 500 }
fn default_sync_interval() -> u32 { 60 }

impl Default for ProbeIcmpConfig {
    fn default() -> Self {
        Self {
            enabled: default_probe_icmp_enabled(),
            interval_s: default_probe_icmp_interval(),
            targets: default_probe_icmp_targets(),
            timeout_ms: default_probe_icmp_timeout(),
        }
    }
}

impl Default for ProbeHttpConfig {
    fn default() -> Self {
        Self {
            enabled: default_probe_http_enabled(),
            interval_s: default_probe_http_interval(),
            targets: default_probe_http_targets(),
            timeout_ms: default_probe_http_timeout(),
        }
    }
}

impl Default for ProbesConfig {
    fn default() -> Self {
        Self { icmp: ProbeIcmpConfig::default(), http: ProbeHttpConfig::default() }
    }
}

impl Default for StorageConfig {
    fn default() -> Self {
        Self { db_path: default_storage_db_path(), retention_days: default_storage_retention_days() }
    }
}

impl Default for SyncConfig {
    fn default() -> Self {
        Self { batch_size: default_sync_batch_size(), interval_s: default_sync_interval() }
    }
}
```

- [ ] **Step 2: Add new fields to Config struct**

Add these fields to the existing `Config` struct in `client/src/config.rs`:

```rust
#[serde(default)]
pub probes: ProbesConfig,
#[serde(default)]
pub storage: StorageConfig,
#[serde(default)]
pub sync: SyncConfig,
```

- [ ] **Step 3: Extend RemoteConfig for server-pushed probe overrides**

Add these optional fields to `RemoteConfig` in `client/src/config.rs`:

```rust
#[serde(default)]
pub probe_icmp_interval_s: Option<u32>,
#[serde(default)]
pub probe_icmp_targets: Option<Vec<String>>,
#[serde(default)]
pub probe_icmp_timeout_ms: Option<u64>,
#[serde(default)]
pub probe_http_interval_s: Option<u32>,
#[serde(default)]
pub probe_http_targets: Option<Vec<String>>,
#[serde(default)]
pub probe_http_timeout_ms: Option<u64>,
```

- [ ] **Step 4: Update apply_remote to merge probe config**

In the `Config::apply_remote` method, add after existing field merges:

```rust
if let Some(v) = remote.probe_icmp_interval_s {
    self.probes.icmp.interval_s = v;
}
if let Some(v) = &remote.probe_icmp_targets {
    self.probes.icmp.targets = v.clone();
}
if let Some(v) = remote.probe_icmp_timeout_ms {
    self.probes.icmp.timeout_ms = v;
}
if let Some(v) = remote.probe_http_interval_s {
    self.probes.http.interval_s = v;
}
if let Some(v) = &remote.probe_http_targets {
    self.probes.http.targets = v.clone();
}
if let Some(v) = remote.probe_http_timeout_ms {
    self.probes.http.timeout_ms = v;
}
```

- [ ] **Step 5: Add helper to resolve db_path**

Add to `Config` impl:

```rust
pub fn resolved_db_path(&self) -> std::path::PathBuf {
    let path = self.storage.db_path.replace("~", &dirs::home_dir().unwrap().to_string_lossy());
    std::path::PathBuf::from(path)
}
```

- [ ] **Step 6: Build and verify**

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/client && cargo build`
Expected: Compiles. Existing config files without `[probes]` section still load fine (serde defaults).

- [ ] **Step 7: Commit**

```bash
git add client/src/config.rs
git commit -m "feat(client): add probe, storage, and sync config sections"
```

---

## Task 4: Client Sync Protocol

**Files:**
- Create: `client/src/sync.rs`
- Modify: `client/src/main.rs` (add `mod sync`)

- [ ] **Step 1: Create sync module**

Create `client/src/sync.rs`:

```rust
use anyhow::Result;
use reqwest::Client as HttpClient;
use tracing::{debug, info, warn};

use crate::store::{ProbeRecord, ProbeStore};

#[derive(Debug, serde::Serialize)]
struct SyncBatch {
    session_id: String,
    records: Vec<ProbeRecord>,
}

#[derive(Debug, serde::Deserialize)]
struct SyncResponse {
    acked_seq: i64,
    #[serde(default)]
    throttle_ms: Option<u64>,
}

pub struct SyncClient {
    http: HttpClient,
    base_url: String,
    client_id: String,
    client_secret: String,
    batch_size: usize,
}

impl SyncClient {
    pub fn new(base_url: &str, client_id: &str, client_secret: &str, batch_size: usize) -> Self {
        Self {
            http: HttpClient::new(),
            base_url: base_url.trim_end_matches('/').to_string(),
            client_id: client_id.to_string(),
            client_secret: client_secret.to_string(),
            batch_size,
        }
    }

    /// Drain all unsynced records to the server. Returns total records synced.
    pub async fn sync_all(&self, store: &ProbeStore) -> Result<usize> {
        let mut total_synced = 0;

        loop {
            let unsynced = store.get_unsynced(self.batch_size)?;
            if unsynced.is_empty() {
                break;
            }

            let seq_ids: Vec<i64> = unsynced.iter().map(|r| r.seq_id).collect();
            let batch_len = unsynced.len();

            let batch = SyncBatch {
                session_id: store.session_id().to_string(),
                records: unsynced,
            };

            let url = format!("{}/api/clients/{}/sync", self.base_url, self.client_id);
            let resp = self.http
                .post(&url)
                .header("Authorization", format!("Bearer {}", self.client_secret))
                .json(&batch)
                .send()
                .await?;

            if !resp.status().is_success() {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                warn!(status = %status, body, "Sync request failed");
                anyhow::bail!("Sync failed with status {status}");
            }

            let sync_resp: SyncResponse = resp.json().await?;
            store.mark_synced(&seq_ids)?;
            total_synced += batch_len;

            info!(synced = batch_len, total = total_synced, acked_seq = sync_resp.acked_seq, "Sync batch complete");

            if let Some(throttle) = sync_resp.throttle_ms {
                debug!(throttle_ms = throttle, "Server requested throttle");
                tokio::time::sleep(tokio::time::Duration::from_millis(throttle)).await;
            }

            if batch_len < self.batch_size {
                break; // no more records
            }
        }

        Ok(total_synced)
    }
}
```

- [ ] **Step 2: Register the sync module**

Add to `client/src/main.rs`:

```rust
mod sync;
```

- [ ] **Step 3: Build and verify**

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/client && cargo build`
Expected: Compiles successfully.

- [ ] **Step 4: Commit**

```bash
git add client/src/sync.rs client/src/main.rs
git commit -m "feat(client): add HTTP batch sync client"
```

---

## Task 5: Integrate Probes into Client WebSocket Loop

**Files:**
- Modify: `client/src/websocket.rs`
- Modify: `client/src/messages.rs`

This is the core integration task — the probe engine, local storage, and sync all get wired into the main daemon loop.

- [ ] **Step 1: Add ProbeResult outgoing message**

In `client/src/messages.rs`, add a new variant to `OutgoingMessage`:

```rust
ProbeResult {
    session_id: String,
    record: crate::store::ProbeRecord,
},
```

And add a corresponding serialization case in the `Serialize` impl (or if using `#[serde(tag = "type")]`, ensure it serializes as `{ "type": "probe_result", "session_id": "...", "record": {...} }`).

- [ ] **Step 2: Add probe loop to websocket.rs**

In `client/src/websocket.rs`, add imports at the top:

```rust
use crate::probe::{ProbeEngine, IcmpTarget, HttpTarget};
use crate::store::ProbeStore;
use crate::sync::SyncClient;
use std::net::IpAddr;
```

- [ ] **Step 3: Initialize probe engine and store in run()**

In the `run()` function in `websocket.rs`, before the reconnect loop, initialize:

```rust
let probe_engine = ProbeEngine::new()?;
let store = ProbeStore::open(&config.resolved_db_path())?;

// Parse ICMP targets
let icmp_targets: Vec<IcmpTarget> = config.probes.icmp.targets.iter().filter_map(|t| {
    t.parse::<IpAddr>().ok().map(|addr| IcmpTarget { addr, label: t.clone() })
}).collect();

// Parse HTTP targets
let http_targets: Vec<HttpTarget> = config.probes.http.targets.iter().map(|url| {
    HttpTarget { url: url.clone() }
}).collect();
```

- [ ] **Step 4: Spawn single background probe task with mpsc channel**

The probe engine runs as ONE background task, independent of WebSocket state. It writes to the store and sends results through an mpsc channel. When connected, `connect_and_run` reads from the channel and forwards over WebSocket. When disconnected, results accumulate in the store only.

In `run()`, before the reconnect loop:

```rust
use tokio::sync::mpsc;

// Channel for probe results — background task → WS forwarder
let (probe_tx, mut probe_rx) = mpsc::channel::<crate::store::ProbeRecord>(256);

// Create one SyncClient to reuse across syncs (preserves TLS sessions)
let sync_client = SyncClient::new(
    &config.server.base_url,
    &config.server.client_id,
    &config.server.client_secret,
    config.sync.batch_size,
);

// Spawn the canonical probe loop — runs regardless of WS state
let probe_store = store.clone_handle();
let probe_handle = tokio::spawn({
    let icmp_targets = icmp_targets.clone();
    let http_targets = http_targets.clone();
    let icmp_interval_s = config.probes.icmp.interval_s;
    let http_interval_s = config.probes.http.interval_s;
    let icmp_timeout = config.probes.icmp.timeout_ms;
    let http_timeout = config.probes.http.timeout_ms;
    let icmp_enabled = config.probes.icmp.enabled;
    let http_enabled = config.probes.http.enabled;
    let engine = ProbeEngine::new().unwrap();
    let tx = probe_tx;

    async move {
        let mut icmp_tick = tokio::time::interval(Duration::from_secs(icmp_interval_s as u64));
        let mut http_tick = tokio::time::interval(Duration::from_secs(http_interval_s as u64));
        let mut cleanup_tick = tokio::time::interval(Duration::from_secs(3600));

        loop {
            tokio::select! {
                _ = icmp_tick.tick() => {
                    if icmp_enabled {
                        for target in &icmp_targets {
                            let record = engine.probe_icmp(target, icmp_timeout).await;
                            if let Ok(seq_id) = probe_store.insert_probe(&record) {
                                let mut stored = record.clone();
                                stored.seq_id = seq_id;
                                tx.send(stored).await.ok(); // non-blocking if nobody reads
                            }
                        }
                    }
                }
                _ = http_tick.tick() => {
                    if http_enabled {
                        for target in &http_targets {
                            let record = engine.probe_http(target, http_timeout).await;
                            if let Ok(seq_id) = probe_store.insert_probe(&record) {
                                let mut stored = record.clone();
                                stored.seq_id = seq_id;
                                tx.send(stored).await.ok();
                            }
                        }
                    }
                }
                _ = cleanup_tick.tick() => {
                    probe_store.cleanup_old(7).ok(); // uses config default
                }
            }
        }
    }
});
```

- [ ] **Step 5: Forward probe results and run sync in connect_and_run()**

In `connect_and_run()`, add sync and probe forwarding to the `tokio::select!` loop:

```rust
let mut sync_interval = tokio::time::interval(Duration::from_secs(config.sync.interval_s as u64));

// Drain buffered probes from any offline period on reconnect
let reconnect_store = store.clone_handle();
tokio::spawn({
    let sync = sync_client.clone(); // SyncClient needs Clone — or create a new one here
    async move {
        match SyncClient::new(
            &config.server.base_url, &config.server.client_id,
            &config.server.client_secret, config.sync.batch_size,
        ).sync_all(&reconnect_store).await {
            Ok(n) if n > 0 => info!(records = n, "Reconnect sync complete"),
            Ok(_) => {},
            Err(e) => warn!(error = %e, "Reconnect sync failed"),
        }
    }
});
```

Add these branches to the existing `tokio::select!`:

```rust
// Forward real-time probe results over WebSocket
Some(record) = probe_rx.recv() => {
    let msg = OutgoingMessage::ProbeResult {
        session_id: store.session_id().to_string(),
        record,
    };
    if let Ok(json) = serde_json::to_string(&msg) {
        sink.send(tokio_tungstenite::tungstenite::Message::Text(json.into())).await.ok();
    }
}
// Periodic sync (catches anything WS missed)
_ = sync_interval.tick() => {
    let sync_store = store.clone_handle();
    if let Err(e) = SyncClient::new(
        &config.server.base_url, &config.server.client_id,
        &config.server.client_secret, config.sync.batch_size,
    ).sync_all(&sync_store).await {
        warn!(error = %e, "Sync failed, will retry next interval");
    }
}
```

**Key design:** Only one probe loop exists (the background task). The `connect_and_run` WS loop only *forwards* results — no duplicate probing.

- [ ] **Step 7: Build and verify**

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/client && cargo build`
Expected: Compiles. May need minor adjustments for borrow checker around `store` usage across tasks.

- [ ] **Step 8: Commit**

```bash
git add client/src/websocket.rs client/src/messages.rs
git commit -m "feat(client): integrate probe engine, local storage, and sync into daemon loop"
```

---

## Task 6: Worker D1 Migration

**Files:**
- Create: `worker/migrations/0003_client_probes.sql`

- [ ] **Step 1: Create migration file**

Create `worker/migrations/0003_client_probes.sql`:

```sql
CREATE TABLE client_probe_results (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id     TEXT    NOT NULL,
    session_id    TEXT    NOT NULL,
    seq_id        INTEGER NOT NULL,
    probe_type    TEXT    NOT NULL CHECK (probe_type IN ('icmp', 'http')),
    target        TEXT    NOT NULL,
    timestamp     INTEGER NOT NULL,
    rtt_ms        REAL,
    status_code   INTEGER,
    status        TEXT    NOT NULL CHECK (status IN ('ok', 'timeout', 'error')),
    jitter_ms     REAL,
    received_at   INTEGER NOT NULL,
    UNIQUE(client_id, session_id, seq_id)
);

CREATE INDEX idx_client_probes_client_ts ON client_probe_results (client_id, timestamp);
CREATE INDEX idx_client_probes_client_type ON client_probe_results (client_id, probe_type, timestamp);
```

- [ ] **Step 2: Apply migration locally**

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/worker && bunx wrangler d1 execute pingpulse-db --local --file=migrations/0003_client_probes.sql`
Expected: Migration applied successfully.

- [ ] **Step 3: Commit**

```bash
git add worker/migrations/0003_client_probes.sql
git commit -m "feat(worker): add client_probe_results D1 migration"
```

---

## Task 7: Worker Types & Config Extension

**Files:**
- Modify: `worker/src/types.ts`

- [ ] **Step 1: Add probe-related types**

Add to `worker/src/types.ts`:

```typescript
export interface ProbeRecord {
  seq_id: number;
  probe_type: "icmp" | "http";
  target: string;
  timestamp: number;
  rtt_ms: number | null;
  status_code: number | null;
  status: "ok" | "timeout" | "error";
  jitter_ms: number | null;
}

export interface SyncBatch {
  session_id: string;
  records: ProbeRecord[];
}

export interface SyncResponse {
  acked_seq: number;
  throttle_ms?: number;
}
```

- [ ] **Step 2: Extend ClientConfig with probe, retention, and alert fields**

Add to the `ClientConfig` interface in `worker/src/types.ts`:

```typescript
// Probe config (pushed to client)
probe_icmp_interval_s?: number;
probe_icmp_targets?: string[];
probe_icmp_timeout_ms?: number;
probe_http_interval_s?: number;
probe_http_targets?: string[];
probe_http_timeout_ms?: number;

// Retention policy
retention_raw_days: number;
retention_aggregated_days: number;
retention_archive_to_r2: boolean;

// Down alert config
down_alert_grace_seconds: number;
down_alert_channels: string[];
down_alert_escalation_enabled: boolean;
down_alert_escalate_after_seconds: number;
down_alert_escalate_channels: string[];
```

- [ ] **Step 3: Update DEFAULT_CLIENT_CONFIG**

Update the default config object to include new fields:

```typescript
retention_raw_days: 30,
retention_aggregated_days: 90,
retention_archive_to_r2: true,
down_alert_grace_seconds: 60,
down_alert_channels: ["telegram"],
down_alert_escalation_enabled: false,
down_alert_escalate_after_seconds: 600,
down_alert_escalate_channels: ["email"],
```

- [ ] **Step 4: Add probe_result to WSMessage union**

Add to the `WSMessage` type:

```typescript
| { type: "probe_result"; session_id: string; record: ProbeRecord }
```

- [ ] **Step 5: Commit**

```bash
git add worker/src/types.ts
git commit -m "feat(worker): extend types with probe, sync, retention, and alert config"
```

---

## Task 8: Worker Sync Endpoint

**Files:**
- Create: `worker/src/api/sync.ts`
- Modify: `worker/src/api/router.ts`

- [ ] **Step 1: Create sync API handler**

Create `worker/src/api/sync.ts`:

```typescript
import { Hono } from "hono";
import type { Env } from "@/index";
import type { SyncBatch, SyncResponse } from "@/types";
import { hashString } from "@/utils/hash"; // reuse existing hash utility

const syncRoutes = new Hono<{ Bindings: Env }>();

syncRoutes.post("/:clientId/sync", async (c) => {
  const clientId = c.req.param("clientId");
  const authHeader = c.req.header("Authorization");

  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Missing authorization" }, 401);
  }
  const clientSecret = authHeader.slice(7);

  // Verify client exists and secret matches (reuse existing hash utility)
  const client = await c.env.DB.prepare(
    "SELECT id, secret_hash FROM clients WHERE id = ?"
  ).bind(clientId).first<{ id: string; secret_hash: string }>();

  if (!client) {
    return c.json({ error: "Client not found" }, 404);
  }

  const secretHash = await hashString(clientSecret);
  if (secretHash !== client.secret_hash) {
    return c.json({ error: "Invalid credentials" }, 401);
  }

  const batch: SyncBatch = await c.req.json();

  if (!batch.session_id || !Array.isArray(batch.records) || batch.records.length === 0) {
    return c.json({ error: "Invalid sync batch" }, 400);
  }

  if (batch.records.length > 500) {
    return c.json({ error: "Batch too large, max 500" }, 400);
  }

  const now = Date.now();
  let maxSeq = 0;

  // Batch insert with ON CONFLICT IGNORE for idempotency
  const stmt = c.env.DB.prepare(
    `INSERT INTO client_probe_results
     (client_id, session_id, seq_id, probe_type, target, timestamp, rtt_ms, status_code, status, jitter_ms, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(client_id, session_id, seq_id) DO NOTHING`
  );

  const stmts = batch.records.map((r) => {
    if (r.seq_id > maxSeq) maxSeq = r.seq_id;
    return stmt.bind(
      clientId, batch.session_id, r.seq_id,
      r.probe_type, r.target, r.timestamp,
      r.rtt_ms, r.status_code, r.status, r.jitter_ms,
      now
    );
  });

  await c.env.DB.batch(stmts);

  // Also write to Analytics Engine for aggregated view
  for (const r of batch.records) {
    if (r.rtt_ms != null) {
      c.env.METRICS.writeDataPoint({
        blobs: [clientId, r.probe_type, r.target, r.status],
        doubles: [r.rtt_ms, r.jitter_ms ?? 0],
        indexes: [clientId],
      });
    }
  }

  const response: SyncResponse = { acked_seq: maxSeq };
  return c.json(response);
});

export { syncRoutes };
```

- [ ] **Step 2: Register sync route in router**

In `worker/src/api/router.ts`, add import and route registration:

```typescript
import { syncRoutes } from "@/api/sync";
```

Add route (before the JWT-protected routes, since sync uses client-secret auth):

```typescript
app.route("/api/clients", syncRoutes);
```

- [ ] **Step 3: Build and verify**

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/worker && bun run build` (or `bunx wrangler deploy --dry-run`)
Expected: Compiles successfully.

- [ ] **Step 4: Commit**

```bash
git add worker/src/api/sync.ts worker/src/api/router.ts
git commit -m "feat(worker): add sync endpoint for client probe data ingestion"
```

---

## Task 9: Worker — Handle probe_result WebSocket Messages

**Files:**
- Modify: `worker/src/durable-objects/client-monitor.ts`

- [ ] **Step 1: Handle probe_result in webSocketMessage()**

In the `webSocketMessage()` handler in `client-monitor.ts`, add a case for the new message type:

```typescript
case "probe_result": {
  const { session_id, record } = parsed as { session_id: string; record: ProbeRecord };
  // Write directly to D1 for real-time ingestion
  await this.env.DB.prepare(
    `INSERT INTO client_probe_results
     (client_id, session_id, seq_id, probe_type, target, timestamp, rtt_ms, status_code, status, jitter_ms, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(client_id, session_id, seq_id) DO NOTHING`
  ).bind(
    this.clientId, session_id, record.seq_id,
    record.probe_type, record.target, record.timestamp,
    record.rtt_ms, record.status_code, record.status, record.jitter_ms,
    Date.now()
  ).run();

  // Write to Analytics Engine
  if (record.rtt_ms != null) {
    this.env.METRICS.writeDataPoint({
      blobs: [this.clientId, record.probe_type, record.target, record.status],
      doubles: [record.rtt_ms, record.jitter_ms ?? 0],
      indexes: [this.clientId],
    });
  }
  break;
}
```

- [ ] **Step 2: Build and verify**

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/worker && bun run build`
Expected: Compiles.

- [ ] **Step 3: Commit**

```bash
git add worker/src/durable-objects/client-monitor.ts
git commit -m "feat(worker): handle real-time probe_result WebSocket messages in DO"
```

---

## Task 10: Worker — Configurable Down Detection

**Files:**
- Modify: `worker/src/durable-objects/client-monitor.ts`

- [ ] **Step 1: Update grace period to use config**

In the alarm handler in `client-monitor.ts`, find the existing grace period check and replace the hardcoded `grace_period_s` with the new `down_alert_grace_seconds` config field:

```typescript
const gracePeriod = (this.config.down_alert_grace_seconds ?? this.config.grace_period_s) * 1000;
```

- [ ] **Step 2: Update alert dispatch to use configured channels**

In `triggerAlert()`, gate on configured channels. The existing `dispatchAlert(env, alertData)`
always sends to both email + Telegram based on env vars. We add channel filtering by wrapping:

```typescript
if (this.config.notifications_enabled) {
  const channels = new Set(this.config.down_alert_channels ?? ["telegram"]);

  // Escalation: add channels if client has been down long enough
  if (this.config.down_alert_escalation_enabled && type === "client_down") {
    const downDuration = (Date.now() - (this.disconnectedAt ?? Date.now())) / 1000;
    if (downDuration >= (this.config.down_alert_escalate_after_seconds ?? 600)) {
      for (const ch of this.config.down_alert_escalate_channels ?? ["email"]) {
        channels.add(ch);
      }
    }
  }

  // Build a scoped env that only has credentials for enabled channels.
  // dispatchAlert(env, alertData) checks for TELEGRAM_BOT_TOKEN / RESEND_API_KEY
  // presence to decide whether to send — so we null out the ones we don't want.
  const scopedEnv = {
    ...this.env,
    TELEGRAM_BOT_TOKEN: channels.has("telegram") ? this.env.TELEGRAM_BOT_TOKEN : "",
    TELEGRAM_CHAT_ID: channels.has("telegram") ? this.env.TELEGRAM_CHAT_ID : "",
    RESEND_API_KEY: channels.has("email") ? this.env.RESEND_API_KEY : "",
  };

  await dispatchAlert(scopedEnv, alertData);
}
```

This preserves the existing 2-arg `dispatchAlert` signature while controlling which channels fire.

- [ ] **Step 3: Build and verify**

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/worker && bun run build`
Expected: Compiles.

- [ ] **Step 4: Commit**

```bash
git add worker/src/durable-objects/client-monitor.ts
git commit -m "feat(worker): configurable down detection grace period and alert channels"
```

---

## Task 11: Worker — Per-Client Retention Policy

**Files:**
- Modify: `worker/src/index.ts`

- [ ] **Step 1: Update cron handler to enforce per-client retention**

In the `scheduled()` handler in `worker/src/index.ts`, replace or extend the `archiveOldRecords` call with per-client retention logic:

```typescript
// Per-client retention
const clients = await env.DB.prepare(
  "SELECT id, config_json FROM clients"
).all<{ id: string; config_json: string }>();

for (const client of clients.results ?? []) {
  const config = JSON.parse(client.config_json || "{}");
  const rawDays = config.retention_raw_days ?? 30;
  const archiveToR2 = config.retention_archive_to_r2 ?? true;
  const cutoff = Date.now() - rawDays * 24 * 60 * 60 * 1000;

  if (archiveToR2) {
    // Archive client probe results to R2 before deletion
    const oldProbes = await env.DB.prepare(
      "SELECT * FROM client_probe_results WHERE client_id = ? AND timestamp < ?"
    ).bind(client.id, cutoff).all();

    if ((oldProbes.results?.length ?? 0) > 0) {
      const csv = probesToCsv(oldProbes.results);
      const key = `archive/${client.id}/probes/${new Date().toISOString().slice(0, 10)}.csv`;
      await env.ARCHIVE.put(key, csv);
    }
  }

  // Delete old client probe results
  await env.DB.prepare(
    "DELETE FROM client_probe_results WHERE client_id = ? AND timestamp < ?"
  ).bind(client.id, cutoff).run();

  // Also clean old ping_results (connection state) with same retention
  await env.DB.prepare(
    "DELETE FROM ping_results WHERE client_id = ? AND timestamp < ?"
  ).bind(client.id, cutoff).run();
}
```

- [ ] **Step 2: Add probesToCsv helper**

Add a helper function (in `worker/src/index.ts` or a new `worker/src/utils/csv.ts`):

```typescript
function probesToCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map(h => JSON.stringify(row[h] ?? "")).join(","));
  }
  return lines.join("\n");
}
```

- [ ] **Step 3: Build and verify**

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/worker && bun run build`
Expected: Compiles.

- [ ] **Step 4: Commit**

```bash
git add worker/src/index.ts
git commit -m "feat(worker): add per-client retention policy enforced on cron"
```

---

## Task 12: Worker — Metrics API for Client Probes

**Files:**
- Modify: `worker/src/api/metrics.ts`

- [ ] **Step 1: Add client probes endpoint**

Add a new route in `worker/src/api/metrics.ts`:

```typescript
metricsRoutes.get("/:clientId/probes", async (c) => {
  const clientId = c.req.param("clientId");
  const from = c.req.query("from") ?? String(Date.now() - 24 * 60 * 60 * 1000);
  const to = c.req.query("to") ?? String(Date.now());
  const probeType = c.req.query("type"); // optional: "icmp" | "http"

  let sql = `SELECT timestamp, probe_type, target, rtt_ms, status_code, status, jitter_ms
             FROM client_probe_results
             WHERE client_id = ? AND timestamp >= ? AND timestamp <= ?`;
  const params: unknown[] = [clientId, Number(from), Number(to)];

  if (probeType) {
    sql += " AND probe_type = ?";
    params.push(probeType);
  }

  sql += " ORDER BY timestamp ASC LIMIT 10000";

  const results = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json({ data: results.results ?? [] });
});
```

- [ ] **Step 2: Add sync status endpoint**

```typescript
metricsRoutes.get("/:clientId/sync-status", async (c) => {
  const clientId = c.req.param("clientId");

  const latest = await c.env.DB.prepare(
    `SELECT MAX(received_at) as last_sync, COUNT(*) as total_records,
            MAX(timestamp) as latest_probe_ts
     FROM client_probe_results WHERE client_id = ?`
  ).bind(clientId).first<{ last_sync: number; total_records: number; latest_probe_ts: number }>();

  return c.json({
    last_sync: latest?.last_sync ?? null,
    total_records: latest?.total_records ?? 0,
    latest_probe_ts: latest?.latest_probe_ts ?? null,
  });
});
```

- [ ] **Step 3: Build and verify**

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/worker && bun run build`
Expected: Compiles.

- [ ] **Step 4: Commit**

```bash
git add worker/src/api/metrics.ts
git commit -m "feat(worker): add client probe metrics and sync status API endpoints"
```

---

## Task 13: Dashboard — WAN Quality Chart

**Files:**
- Create: `worker/dashboard/src/components/WanQualityChart.tsx`
- Modify: `worker/dashboard/src/pages/ClientDetail.tsx`

- [ ] **Step 1: Create WAN Quality chart component**

Create `worker/dashboard/src/components/WanQualityChart.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

interface ProbePoint {
  timestamp: number;
  probe_type: string;
  target: string;
  rtt_ms: number | null;
  status: string;
}

interface Props {
  clientId: string;
  from: number;
  to: number;
}

export function WanQualityChart({ clientId, from, to }: Props) {
  const chartRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<ProbePoint[]>([]);
  const [filter, setFilter] = useState<"all" | "icmp" | "http">("all");

  useEffect(() => {
    const typeParam = filter !== "all" ? `&type=${filter}` : "";
    fetch(`/api/metrics/${clientId}/probes?from=${from}&to=${to}${typeParam}`, {
      credentials: "include",
    })
      .then((r) => r.json())
      .then((j) => setData(j.data ?? []));
  }, [clientId, from, to, filter]);

  useEffect(() => {
    if (!chartRef.current || data.length === 0) return;

    // Group by target
    const targets = [...new Set(data.map((d) => d.target))];
    const timestamps = [...new Set(data.map((d) => Math.floor(d.timestamp / 1000)))].sort();

    const series: uPlot.Series[] = [{ label: "Time" }];
    const plotData: number[][] = [timestamps];

    for (const target of targets) {
      series.push({
        label: target,
        stroke: target.includes("8.8.8.8") ? "#4ade80" : target.includes("1.1.1.1") ? "#60a5fa" : "#f59e0b",
        width: 1.5,
      });
      const targetData = new Map(
        data
          .filter((d) => d.target === target && d.rtt_ms != null)
          .map((d) => [Math.floor(d.timestamp / 1000), d.rtt_ms!])
      );
      plotData.push(timestamps.map((ts) => targetData.get(ts) ?? null as unknown as number));
    }

    const opts: uPlot.Options = {
      width: chartRef.current.clientWidth,
      height: 300,
      title: "WAN Latency (ms)",
      series,
      axes: [
        { stroke: "#888" },
        { stroke: "#888", label: "RTT (ms)" },
      ],
      scales: { x: { time: true } },
    };

    const plot = new uPlot(opts, plotData as uPlot.AlignedData, chartRef.current);
    return () => plot.destroy();
  }, [data]);

  return (
    <div>
      <div className="flex gap-2 mb-2">
        {(["all", "icmp", "http"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1 rounded text-sm ${filter === f ? "bg-blue-600 text-white" : "bg-zinc-800 text-zinc-400"}`}
          >
            {f.toUpperCase()}
          </button>
        ))}
      </div>
      <div ref={chartRef} />
    </div>
  );
}
```

- [ ] **Step 2: Integrate into ClientDetail page**

In `worker/dashboard/src/pages/ClientDetail.tsx`, import and add the component:

```tsx
import { WanQualityChart } from "@/components/WanQualityChart";
```

Add to the JSX, above or in a tab with existing charts:

```tsx
<WanQualityChart clientId={clientId} from={from} to={to} />
```

- [ ] **Step 3: Verify in dev server**

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/worker/dashboard && bun run dev`
Expected: Page loads without errors. Chart renders (empty until client sends data).

- [ ] **Step 4: Commit**

```bash
git add worker/dashboard/src/components/WanQualityChart.tsx worker/dashboard/src/pages/ClientDetail.tsx
git commit -m "feat(dashboard): add WAN quality chart for client probe data"
```

---

## Task 14: Dashboard — Sync Status Badge

**Files:**
- Create: `worker/dashboard/src/components/SyncStatusBadge.tsx`

- [ ] **Step 1: Create badge component**

Create `worker/dashboard/src/components/SyncStatusBadge.tsx`:

```tsx
import { useEffect, useState } from "react";

interface SyncStatus {
  last_sync: number | null;
  total_records: number;
  latest_probe_ts: number | null;
}

export function SyncStatusBadge({ clientId }: { clientId: string }) {
  const [status, setStatus] = useState<SyncStatus | null>(null);

  useEffect(() => {
    fetch(`/api/metrics/${clientId}/sync-status`, { credentials: "include" })
      .then((r) => r.json())
      .then(setStatus);
  }, [clientId]);

  if (!status) return null;

  const lastSyncAgo = status.last_sync
    ? Math.floor((Date.now() - status.last_sync) / 1000)
    : null;

  const formatAge = (seconds: number) => {
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  };

  return (
    <span className="inline-flex items-center gap-1 text-xs">
      <span className={`w-2 h-2 rounded-full ${lastSyncAgo !== null && lastSyncAgo < 120 ? "bg-green-500" : "bg-yellow-500"}`} />
      <span className="text-zinc-400">
        {lastSyncAgo !== null ? `Synced ${formatAge(lastSyncAgo)}` : "Never synced"}
        {" · "}
        {status.total_records.toLocaleString()} probes
      </span>
    </span>
  );
}
```

- [ ] **Step 2: Add badge to client list or detail view**

Import and use in the appropriate location (client list table or detail page header).

- [ ] **Step 3: Commit**

```bash
git add worker/dashboard/src/components/SyncStatusBadge.tsx
git commit -m "feat(dashboard): add sync status badge component"
```

---

## Task 15: Dashboard — Extended Client Config UI

**Files:**
- Modify: `worker/dashboard/src/components/EditClientDialog.tsx`

- [ ] **Step 1: Add probe config fields**

In `EditClientDialog.tsx`, add fields for the new config options:

```tsx
{/* Probe Configuration */}
<fieldset className="border border-zinc-700 rounded p-3 space-y-2">
  <legend className="text-sm font-medium text-zinc-300 px-1">Probe Config</legend>

  <label className="block text-xs text-zinc-400">ICMP Interval (seconds)</label>
  <input type="number" value={config.probe_icmp_interval_s ?? 5}
    onChange={(e) => setConfig({ ...config, probe_icmp_interval_s: Number(e.target.value) })}
    className="w-full bg-zinc-800 rounded px-2 py-1 text-sm" />

  <label className="block text-xs text-zinc-400">ICMP Targets (comma-separated)</label>
  <input type="text" value={(config.probe_icmp_targets ?? ["8.8.8.8", "1.1.1.1", "9.9.9.9"]).join(", ")}
    onChange={(e) => setConfig({ ...config, probe_icmp_targets: e.target.value.split(",").map(s => s.trim()) })}
    className="w-full bg-zinc-800 rounded px-2 py-1 text-sm" />

  <label className="block text-xs text-zinc-400">HTTP Interval (seconds)</label>
  <input type="number" value={config.probe_http_interval_s ?? 15}
    onChange={(e) => setConfig({ ...config, probe_http_interval_s: Number(e.target.value) })}
    className="w-full bg-zinc-800 rounded px-2 py-1 text-sm" />

  <label className="block text-xs text-zinc-400">HTTP Targets (comma-separated)</label>
  <input type="text" value={(config.probe_http_targets ?? ["https://www.google.com", "https://cloudflare.com"]).join(", ")}
    onChange={(e) => setConfig({ ...config, probe_http_targets: e.target.value.split(",").map(s => s.trim()) })}
    className="w-full bg-zinc-800 rounded px-2 py-1 text-sm" />
</fieldset>

{/* Down Alert Configuration */}
<fieldset className="border border-zinc-700 rounded p-3 space-y-2">
  <legend className="text-sm font-medium text-zinc-300 px-1">Down Alerts</legend>

  <label className="block text-xs text-zinc-400">Grace Period (seconds)</label>
  <input type="number" value={config.down_alert_grace_seconds ?? 60}
    onChange={(e) => setConfig({ ...config, down_alert_grace_seconds: Number(e.target.value) })}
    className="w-full bg-zinc-800 rounded px-2 py-1 text-sm" />

  <label className="block text-xs text-zinc-400">Alert Channels</label>
  <div className="flex gap-3">
    <label className="flex items-center gap-1 text-sm text-zinc-300">
      <input type="checkbox" checked={(config.down_alert_channels ?? ["telegram"]).includes("telegram")}
        onChange={(e) => {
          const channels = config.down_alert_channels ?? ["telegram"];
          setConfig({ ...config, down_alert_channels: e.target.checked ? [...channels, "telegram"] : channels.filter(c => c !== "telegram") });
        }} />
      Telegram
    </label>
    <label className="flex items-center gap-1 text-sm text-zinc-300">
      <input type="checkbox" checked={(config.down_alert_channels ?? []).includes("email")}
        onChange={(e) => {
          const channels = config.down_alert_channels ?? [];
          setConfig({ ...config, down_alert_channels: e.target.checked ? [...channels, "email"] : channels.filter(c => c !== "email") });
        }} />
      Email
    </label>
  </div>

  <label className="flex items-center gap-1 text-sm text-zinc-300 mt-2">
    <input type="checkbox" checked={config.down_alert_escalation_enabled ?? false}
      onChange={(e) => setConfig({ ...config, down_alert_escalation_enabled: e.target.checked })} />
    Enable escalation
  </label>
  {config.down_alert_escalation_enabled && (
    <>
      <label className="block text-xs text-zinc-400">Escalate after (seconds)</label>
      <input type="number" value={config.down_alert_escalate_after_seconds ?? 600}
        onChange={(e) => setConfig({ ...config, down_alert_escalate_after_seconds: Number(e.target.value) })}
        className="w-full bg-zinc-800 rounded px-2 py-1 text-sm" />
      <label className="block text-xs text-zinc-400">Escalation channels (comma-separated)</label>
      <input type="text" value={(config.down_alert_escalate_channels ?? ["email"]).join(", ")}
        onChange={(e) => setConfig({ ...config, down_alert_escalate_channels: e.target.value.split(",").map(s => s.trim()) })}
        className="w-full bg-zinc-800 rounded px-2 py-1 text-sm" />
    </>
  )}
</fieldset>

{/* Retention Policy */}
<fieldset className="border border-zinc-700 rounded p-3 space-y-2">
  <legend className="text-sm font-medium text-zinc-300 px-1">Retention</legend>

  <label className="block text-xs text-zinc-400">Raw Data (days)</label>
  <input type="number" value={config.retention_raw_days ?? 30}
    onChange={(e) => setConfig({ ...config, retention_raw_days: Number(e.target.value) })}
    className="w-full bg-zinc-800 rounded px-2 py-1 text-sm" />

  <label className="flex items-center gap-1 text-sm text-zinc-300">
    <input type="checkbox" checked={config.retention_archive_to_r2 ?? true}
      onChange={(e) => setConfig({ ...config, retention_archive_to_r2: e.target.checked })} />
    Archive to R2 before deletion
  </label>
</fieldset>
```

- [ ] **Step 2: Build dashboard**

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/worker/dashboard && bun run build`
Expected: Compiles successfully.

- [ ] **Step 3: Commit**

```bash
git add worker/dashboard/src/components/EditClientDialog.tsx
git commit -m "feat(dashboard): add probe, alert, and retention config to edit dialog"
```

---

## Task 16: Dashboard — Connection State Chart

**Files:**
- Create: `worker/dashboard/src/components/ConnectionStateChart.tsx`
- Modify: `worker/dashboard/src/pages/ClientDetail.tsx`

- [ ] **Step 1: Create ConnectionStateChart component**

Create `worker/dashboard/src/components/ConnectionStateChart.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

interface PingPoint {
  timestamp: number;
  rtt_ms: number | null;
  status: string;
  direction: string;
}

interface OutagePoint {
  start_ts: string;
  end_ts: string | null;
  duration_s: number | null;
}

interface Props {
  clientId: string;
  from: number;
  to: number;
}

export function ConnectionStateChart({ clientId, from, to }: Props) {
  const chartRef = useRef<HTMLDivElement>(null);
  const [pings, setPings] = useState<PingPoint[]>([]);
  const [outages, setOutages] = useState<OutagePoint[]>([]);

  useEffect(() => {
    // Fetch server heartbeat data (existing ping_results)
    fetch(`/api/clients/${clientId}/logs?from=${from}&to=${to}&limit=5000`, {
      credentials: "include",
    })
      .then((r) => r.json())
      .then((j) => setPings(j.pings ?? []));

    // Fetch outages
    fetch(`/api/metrics/${clientId}?from=${from}&to=${to}`, {
      credentials: "include",
    })
      .then((r) => r.json())
      .then((j) => setOutages(j.outages ?? []));
  }, [clientId, from, to]);

  useEffect(() => {
    if (!chartRef.current || pings.length === 0) return;

    const timestamps = pings.map((p) => Math.floor(p.timestamp / 1000));
    const rtts = pings.map((p) => p.rtt_ms ?? null);

    const opts: uPlot.Options = {
      width: chartRef.current.clientWidth,
      height: 200,
      title: "Server → Client Connection (RTT)",
      series: [
        { label: "Time" },
        { label: "RTT (ms)", stroke: "#a78bfa", width: 1.5 },
      ],
      axes: [
        { stroke: "#888" },
        { stroke: "#888", label: "RTT (ms)" },
      ],
      scales: { x: { time: true } },
    };

    const plot = new uPlot(opts, [timestamps, rtts] as uPlot.AlignedData, chartRef.current);
    return () => plot.destroy();
  }, [pings]);

  return (
    <div>
      <div ref={chartRef} />
      {outages.length > 0 && (
        <div className="mt-2">
          <h4 className="text-xs font-medium text-zinc-400 mb-1">Recent Outages</h4>
          <div className="space-y-1">
            {outages.slice(0, 5).map((o, i) => (
              <div key={i} className="text-xs text-zinc-500">
                {new Date(o.start_ts).toLocaleString()} —{" "}
                {o.end_ts ? new Date(o.end_ts).toLocaleString() : "ongoing"}
                {o.duration_s != null && ` (${Math.floor(o.duration_s / 60)}m ${o.duration_s % 60}s)`}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add to ClientDetail page**

In `worker/dashboard/src/pages/ClientDetail.tsx`, import and add below the WAN chart:

```tsx
import { ConnectionStateChart } from "@/components/ConnectionStateChart";
```

```tsx
<ConnectionStateChart clientId={clientId} from={from} to={to} />
```

- [ ] **Step 3: Commit**

```bash
git add worker/dashboard/src/components/ConnectionStateChart.tsx worker/dashboard/src/pages/ClientDetail.tsx
git commit -m "feat(dashboard): add connection state chart with outage history"
```

---

## Execution Order & Dependencies

```
Task 1 (SQLite store) ──┐
Task 2 (Probe engine) ──┤
Task 3 (Probe config) ──┼── Task 5 (Integration into websocket.rs)
Task 4 (Sync client) ───┘

Task 6 (D1 migration) ──┐
Task 7 (Worker types) ───┼── Task 8 (Sync endpoint)
                         ├── Task 9 (WS probe_result handler)
                         ├── Task 10 (Down detection)
                         ├── Task 11 (Retention)
                         └── Task 12 (Metrics API) ── Task 13 (WAN chart)
                                                   ── Task 14 (Sync badge)
                                                   ── Task 15 (Config UI)
                                                   ── Task 16 (Connection state chart)
```

Tasks 1-4 and Tasks 6-7 can be done in parallel (client vs worker). Task 5 depends on 1-4. Tasks 8-16 depend on 6-7. Dashboard tasks (13-16) depend on 12.

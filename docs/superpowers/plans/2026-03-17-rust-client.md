# PingPulse Rust Client — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Rust daemon that connects to the PingPulse Cloudflare Worker backend via WebSocket, responds to pings, executes speed tests, and logs events locally.

**Architecture:** Single-binary CLI (`pingpulse`) with 4 commands: `register`, `start`, `stop`, `status`. The `start` command runs a tokio event loop that manages a WebSocket connection with auto-reconnect, periodic client-to-CF pings, and on-demand speed tests. Config stored in `~/.pingpulse/config.toml`, logs as JSON lines in `~/.pingpulse/logs/`.

**Tech Stack:** Rust, tokio, tokio-tungstenite, reqwest, clap, serde, tracing

**Spec:** `docs/superpowers/specs/2026-03-17-rust-client-design.md`

---

## File Structure

```
client/
├── Cargo.toml
├── src/
│   ├── main.rs           # CLI entry via clap, dispatches to commands
│   ├── config.rs          # Read/write ~/.pingpulse/config.toml, merge remote updates
│   ├── logger.rs          # Daily-rotating JSON log writer via tracing
│   ├── messages.rs        # WebSocket message types with serde
│   ├── websocket.rs       # Connect, reconnect, main event loop
│   ├── speed_test.rs      # Probe + full speed test execution
│   └── service.rs         # launchd/systemd service install/uninstall/status
└── tests/
    └── integration.rs     # End-to-end tests against a mock server (future)
```

Note: `messages.rs` is split from `websocket.rs` because the message types are used by both `websocket.rs` and `speed_test.rs`, and keeping serde types separate makes them independently testable.

---

### Task 1: Project Scaffolding

**Files:**
- Create: `client/Cargo.toml`
- Create: `client/src/main.rs` (minimal placeholder)

- [ ] **Step 1: Create the project directory**

```bash
mkdir -p client/src
```

- [ ] **Step 2: Write `Cargo.toml`**

```toml
[package]
name = "pingpulse"
version = "0.1.0"
edition = "2021"

[dependencies]
tokio = { version = "1", features = ["rt-multi-thread", "macros", "fs", "time", "signal", "process"] }
tokio-tungstenite = { version = "0.26", features = ["native-tls"] }
reqwest = { version = "0.12", features = ["json"] }
clap = { version = "4", features = ["derive"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
toml = "0.8"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["json", "env-filter"] }
url = "2"
chrono = { version = "0.4", features = ["serde"] }
rand = "0.9"
dirs = "5"
http = "1"
futures-util = "0.3"
```

- [ ] **Step 3: Write minimal `src/main.rs`**

```rust
fn main() {
    println!("pingpulse v0.1.0");
}
```

- [ ] **Step 4: Verify it compiles**

Run: `cd client && cargo build`
Expected: Compiles successfully, produces `target/debug/pingpulse`

- [ ] **Step 5: Commit**

```bash
git add client/
git commit -m "feat(client): scaffold Rust project with dependencies"
```

---

### Task 2: Config Module

**Files:**
- Create: `client/src/config.rs`
- Modify: `client/src/main.rs` — add `mod config;`

- [ ] **Step 1: Write tests for config**

In `client/src/config.rs`, add the module with tests at the bottom:

```rust
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub server: ServerConfig,
    pub ping: PingConfig,
    pub speed_test: SpeedTestConfig,
    pub alerts: AlertConfig,
    pub logging: LoggingConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    pub base_url: String,
    pub ws_url: String,
    pub client_id: String,
    pub client_secret: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PingConfig {
    pub interval_s: u32,
    pub grace_period_s: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpeedTestConfig {
    pub probe_size_bytes: u64,
    pub full_test_payload_bytes: u64,
    pub full_test_schedule: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlertConfig {
    pub latency_threshold_ms: f64,
    pub loss_threshold_pct: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoggingConfig {
    pub level: String,
    pub retention_days: u32,
}

/// Remote config pushed by server via WebSocket config_update message.
/// Maps to backend ClientConfig (all 7 fields).
#[derive(Debug, Clone, Deserialize)]
pub struct RemoteConfig {
    pub ping_interval_s: u32,
    pub probe_size_bytes: u64,
    pub full_test_payload_bytes: u64,
    pub full_test_schedule: String,
    pub alert_latency_threshold_ms: f64,
    pub alert_loss_threshold_pct: f64,
    pub grace_period_s: u32,
}

impl Config {
    pub fn config_dir() -> PathBuf {
        dirs::home_dir()
            .expect("Could not determine home directory")
            .join(".pingpulse")
    }

    pub fn config_path() -> PathBuf {
        Self::config_dir().join("config.toml")
    }

    pub fn logs_dir() -> PathBuf {
        Self::config_dir().join("logs")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_roundtrip() {
        let config = Config {
            server: ServerConfig {
                base_url: "https://ping.beric.ca".into(),
                ws_url: "/ws/abc123".into(),
                client_id: "abc123".into(),
                client_secret: "secret".into(),
            },
            ping: PingConfig { interval_s: 30, grace_period_s: 60 },
            speed_test: SpeedTestConfig {
                probe_size_bytes: 262144,
                full_test_payload_bytes: 10485760,
                full_test_schedule: "0 */6 * * *".into(),
            },
            alerts: AlertConfig { latency_threshold_ms: 100.0, loss_threshold_pct: 5.0 },
            logging: LoggingConfig { level: "info".into(), retention_days: 30 },
        };

        let serialized = toml::to_string_pretty(&config).unwrap();
        let deserialized: Config = toml::from_str(&serialized).unwrap();

        assert_eq!(deserialized.server.client_id, "abc123");
        assert_eq!(deserialized.ping.interval_s, 30);
        assert_eq!(deserialized.speed_test.full_test_schedule, "0 */6 * * *");
    }

    #[test]
    fn test_remote_config_deserialize() {
        let json = r#"{
            "ping_interval_s": 15,
            "probe_size_bytes": 131072,
            "full_test_payload_bytes": 5242880,
            "full_test_schedule": "0 */3 * * *",
            "alert_latency_threshold_ms": 50.0,
            "alert_loss_threshold_pct": 2.5,
            "grace_period_s": 120
        }"#;
        let remote: RemoteConfig = serde_json::from_str(json).unwrap();
        assert_eq!(remote.ping_interval_s, 15);
        assert_eq!(remote.grace_period_s, 120);
    }

    #[test]
    fn test_apply_remote_config() {
        let mut config = Config {
            server: ServerConfig {
                base_url: "https://ping.beric.ca".into(),
                ws_url: "/ws/abc".into(),
                client_id: "abc".into(),
                client_secret: "sec".into(),
            },
            ping: PingConfig { interval_s: 30, grace_period_s: 60 },
            speed_test: SpeedTestConfig {
                probe_size_bytes: 262144,
                full_test_payload_bytes: 10485760,
                full_test_schedule: "0 */6 * * *".into(),
            },
            alerts: AlertConfig { latency_threshold_ms: 100.0, loss_threshold_pct: 5.0 },
            logging: LoggingConfig { level: "info".into(), retention_days: 30 },
        };

        let remote = RemoteConfig {
            ping_interval_s: 15,
            probe_size_bytes: 131072,
            full_test_payload_bytes: 5242880,
            full_test_schedule: "0 */3 * * *".into(),
            alert_latency_threshold_ms: 50.0,
            alert_loss_threshold_pct: 2.5,
            grace_period_s: 120,
        };

        config.apply_remote(&remote);

        assert_eq!(config.ping.interval_s, 15);
        assert_eq!(config.ping.grace_period_s, 120);
        assert_eq!(config.speed_test.probe_size_bytes, 131072);
        assert_eq!(config.alerts.latency_threshold_ms, 50.0);
        // Server config should NOT change
        assert_eq!(config.server.client_id, "abc");
    }
}
```

- [ ] **Step 2: Run tests — they should fail (apply_remote not implemented)**

Run: `cd client && cargo test config`
Expected: Compilation error — `apply_remote` method not found

- [ ] **Step 3: Implement `apply_remote` and file I/O methods**

Add to `Config` impl block in `client/src/config.rs`:

```rust
impl Config {
    // ... existing methods ...

    pub fn apply_remote(&mut self, remote: &RemoteConfig) {
        self.ping.interval_s = remote.ping_interval_s;
        self.ping.grace_period_s = remote.grace_period_s;
        self.speed_test.probe_size_bytes = remote.probe_size_bytes;
        self.speed_test.full_test_payload_bytes = remote.full_test_payload_bytes;
        self.speed_test.full_test_schedule = remote.full_test_schedule.clone();
        self.alerts.latency_threshold_ms = remote.alert_latency_threshold_ms;
        self.alerts.loss_threshold_pct = remote.alert_loss_threshold_pct;
    }

    pub fn new_from_registration(
        base_url: String,
        ws_url: String,
        client_id: String,
        client_secret: String,
    ) -> Self {
        Self {
            server: ServerConfig { base_url, ws_url, client_id, client_secret },
            ping: PingConfig { interval_s: 30, grace_period_s: 60 },
            speed_test: SpeedTestConfig {
                probe_size_bytes: 262144,
                full_test_payload_bytes: 10_485_760,
                full_test_schedule: "0 */6 * * *".into(),
            },
            alerts: AlertConfig { latency_threshold_ms: 100.0, loss_threshold_pct: 5.0 },
            logging: LoggingConfig { level: "info".into(), retention_days: 30 },
        }
    }

    pub async fn load() -> anyhow::Result<Self> {
        let path = Self::config_path();
        let contents = tokio::fs::read_to_string(&path).await?;
        Ok(toml::from_str(&contents)?)
    }

    pub async fn save(&self) -> anyhow::Result<()> {
        let path = Self::config_path();
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let contents = toml::to_string_pretty(self)?;
        tokio::fs::write(&path, contents).await?;
        Ok(())
    }
}
```

Also add `anyhow = "1"` to `[dependencies]` in `Cargo.toml`.

- [ ] **Step 4: Add `mod config;` to `main.rs`**

```rust
mod config;

fn main() {
    println!("pingpulse v0.1.0");
}
```

- [ ] **Step 5: Run tests — should pass**

Run: `cd client && cargo test config`
Expected: All 3 tests pass

- [ ] **Step 6: Commit**

```bash
git add client/
git commit -m "feat(client): add config module with TOML read/write and remote config merge"
```

---

### Task 3: WebSocket Message Types

**Files:**
- Create: `client/src/messages.rs`
- Modify: `client/src/main.rs` — add `mod messages;`

- [ ] **Step 1: Write message types with serde and tests**

Create `client/src/messages.rs`:

```rust
use serde::{Deserialize, Serialize};

use crate::config::RemoteConfig;

// --- Speed test types ---

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SpeedTestType {
    Probe,
    Full,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpeedTestResult {
    pub client_id: String,
    pub timestamp: String,
    #[serde(rename = "type")]
    pub test_type: SpeedTestType,
    pub download_mbps: f64,
    pub upload_mbps: f64,
    pub payload_bytes: u64,
    pub duration_ms: u64,
}

// --- Incoming messages (from server) ---

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum IncomingMessage {
    Ping {
        id: String,
        ts: u64,
        #[serde(default)]
        payload: Option<Vec<u8>>,
    },
    Pong {
        id: String,
        ts: u64,
        client_ts: u64,
    },
    ConfigUpdate {
        config: RemoteConfig,
    },
    StartSpeedTest {
        test_type: SpeedTestType,
    },
}

// --- Outgoing messages (to server) ---

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OutgoingMessage {
    Pong {
        id: String,
        ts: u64,
        client_ts: u64,
    },
    Ping {
        id: String,
        ts: u64,
        #[serde(default)]
        payload: Option<Vec<u8>>,
    },
    SpeedTestResult {
        result: SpeedTestResult,
    },
    Error {
        message: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_deserialize_ping_from_server() {
        let json = r#"{"type":"ping","id":"abc-123","ts":1710700000000}"#;
        let msg: IncomingMessage = serde_json::from_str(json).unwrap();
        match msg {
            IncomingMessage::Ping { id, ts } => {
                assert_eq!(id, "abc-123");
                assert_eq!(ts, 1710700000000);
            }
            _ => panic!("Expected Ping"),
        }
    }

    #[test]
    fn test_deserialize_pong_from_server() {
        let json = r#"{"type":"pong","id":"abc-123","ts":1710700000000,"client_ts":1710700000050}"#;
        let msg: IncomingMessage = serde_json::from_str(json).unwrap();
        match msg {
            IncomingMessage::Pong { id, ts, client_ts } => {
                assert_eq!(id, "abc-123");
                assert_eq!(ts, 1710700000000);
                assert_eq!(client_ts, 1710700000050);
            }
            _ => panic!("Expected Pong"),
        }
    }

    #[test]
    fn test_deserialize_start_speed_test() {
        let json = r#"{"type":"start_speed_test","test_type":"full"}"#;
        let msg: IncomingMessage = serde_json::from_str(json).unwrap();
        match msg {
            IncomingMessage::StartSpeedTest { test_type } => {
                assert_eq!(test_type, SpeedTestType::Full);
            }
            _ => panic!("Expected StartSpeedTest"),
        }
    }

    #[test]
    fn test_deserialize_config_update() {
        let json = r#"{"type":"config_update","config":{"ping_interval_s":15,"probe_size_bytes":131072,"full_test_payload_bytes":5242880,"full_test_schedule":"0 */3 * * *","alert_latency_threshold_ms":50.0,"alert_loss_threshold_pct":2.5,"grace_period_s":120}}"#;
        let msg: IncomingMessage = serde_json::from_str(json).unwrap();
        match msg {
            IncomingMessage::ConfigUpdate { config } => {
                assert_eq!(config.ping_interval_s, 15);
            }
            _ => panic!("Expected ConfigUpdate"),
        }
    }

    #[test]
    fn test_serialize_pong() {
        let msg = OutgoingMessage::Pong {
            id: "abc-123".into(),
            ts: 1710700000000,
            client_ts: 1710700000050,
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""type":"pong""#));
        assert!(json.contains(r#""ts":1710700000000"#));
        assert!(json.contains(r#""client_ts":1710700000050"#));
    }

    #[test]
    fn test_serialize_client_ping() {
        let msg = OutgoingMessage::Ping {
            id: "client-ping-1".into(),
            ts: 1710700001000,
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""type":"ping""#));
        assert!(json.contains(r#""ts":1710700001000"#));
    }

    #[test]
    fn test_serialize_speed_test_result() {
        let msg = OutgoingMessage::SpeedTestResult {
            result: SpeedTestResult {
                client_id: "abc123".into(),
                timestamp: "2026-03-17T12:00:00Z".into(),
                test_type: SpeedTestType::Probe,
                download_mbps: 95.2,
                upload_mbps: 42.1,
                payload_bytes: 262144,
                duration_ms: 350,
            },
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""type":"speed_test_result""#));
        assert!(json.contains(r#""download_mbps":95.2"#));
        assert!(json.contains(r#""type":"probe""#));
    }
}
```

- [ ] **Step 2: Add `mod messages;` to `main.rs`**

- [ ] **Step 3: Run tests — should pass**

Run: `cd client && cargo test messages`
Expected: All 7 tests pass

- [ ] **Step 4: Commit**

```bash
git add client/
git commit -m "feat(client): add WebSocket message types with serde serialization"
```

---

### Task 4: Logger Module

**Files:**
- Create: `client/src/logger.rs`
- Modify: `client/src/main.rs` — add `mod logger;`

- [ ] **Step 1: Write the daily-rotating JSON log writer**

Create `client/src/logger.rs`:

```rust
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::Local;
use tracing_subscriber::fmt::MakeWriter;

/// A tracing writer that rotates log files daily.
/// Files are named `pingpulse-YYYY-MM-DD.log` in the configured logs directory.
pub struct DailyFileWriter {
    logs_dir: PathBuf,
    state: Mutex<WriterState>,
}

struct WriterState {
    current_date: String,
    file: Option<File>,
}

impl DailyFileWriter {
    pub fn new(logs_dir: PathBuf) -> Self {
        fs::create_dir_all(&logs_dir).ok();
        Self {
            logs_dir,
            state: Mutex::new(WriterState {
                current_date: String::new(),
                file: None,
            }),
        }
    }

    fn log_path(&self, date: &str) -> PathBuf {
        self.logs_dir.join(format!("pingpulse-{date}.log"))
    }

    /// Delete log files older than `retention_days`.
    pub fn cleanup_old_logs(&self, retention_days: u32) {
        let cutoff = Local::now() - chrono::Duration::days(retention_days as i64);
        let cutoff_str = cutoff.format("%Y-%m-%d").to_string();

        let entries = match fs::read_dir(&self.logs_dir) {
            Ok(e) => e,
            Err(_) => return,
        };

        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            // Match pingpulse-YYYY-MM-DD.log
            if let Some(date) = name
                .strip_prefix("pingpulse-")
                .and_then(|s| s.strip_suffix(".log"))
            {
                if date < cutoff_str.as_str() {
                    fs::remove_file(entry.path()).ok();
                }
            }
        }
    }
}

/// Wrapper that implements `Write` for a single log write operation.
pub struct DailyFileWriteGuard<'a> {
    writer: &'a DailyFileWriter,
}

impl<'a> Write for DailyFileWriteGuard<'a> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let today = Local::now().format("%Y-%m-%d").to_string();
        let mut state = self.writer.state.lock().unwrap();

        if state.current_date != today || state.file.is_none() {
            let path = self.writer.log_path(&today);
            state.file = Some(
                OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(path)?,
            );
            state.current_date = today;
        }

        if let Some(ref mut file) = state.file {
            file.write(buf)
        } else {
            Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                "No log file",
            ))
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        let state = self.writer.state.lock().unwrap();
        if let Some(ref file) = state.file {
            // File doesn't have interior mutability for flush, but append mode
            // flushes on each write in practice. This is a best-effort flush.
            drop(state);
        }
        Ok(())
    }
}

impl<'a> MakeWriter<'a> for DailyFileWriter {
    type Writer = DailyFileWriteGuard<'a>;

    fn make_writer(&'a self) -> Self::Writer {
        DailyFileWriteGuard { writer: self }
    }
}

/// Initialize the tracing subscriber with daily-rotating JSON output.
pub fn init(logs_dir: PathBuf, level: &str, retention_days: u32) {
    let writer = DailyFileWriter::new(logs_dir);
    writer.cleanup_old_logs(retention_days);

    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(level));

    tracing_subscriber::fmt()
        .json()
        .with_env_filter(env_filter)
        .with_writer(writer)
        .with_target(false)
        .flatten_event(true)
        .init();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    fn test_writer(dir: &Path) -> DailyFileWriter {
        DailyFileWriter::new(dir.to_path_buf())
    }

    #[test]
    fn test_log_path_format() {
        let dir = TempDir::new().unwrap();
        let writer = test_writer(dir.path());
        let path = writer.log_path("2026-03-17");
        assert_eq!(
            path.file_name().unwrap().to_str().unwrap(),
            "pingpulse-2026-03-17.log"
        );
    }

    #[test]
    fn test_write_creates_file() {
        let dir = TempDir::new().unwrap();
        let writer = test_writer(dir.path());
        let mut guard = DailyFileWriteGuard { writer: &writer };
        guard.write_all(b"test line\n").unwrap();

        let today = Local::now().format("%Y-%m-%d").to_string();
        let log_path = dir.path().join(format!("pingpulse-{today}.log"));
        assert!(log_path.exists());
        let contents = fs::read_to_string(log_path).unwrap();
        assert_eq!(contents, "test line\n");
    }

    #[test]
    fn test_cleanup_old_logs() {
        let dir = TempDir::new().unwrap();
        let writer = test_writer(dir.path());

        // Create some fake log files
        File::create(dir.path().join("pingpulse-2020-01-01.log")).unwrap();
        File::create(dir.path().join("pingpulse-2020-06-15.log")).unwrap();
        // Today's log should survive
        let today = Local::now().format("%Y-%m-%d").to_string();
        File::create(dir.path().join(format!("pingpulse-{today}.log"))).unwrap();

        writer.cleanup_old_logs(30);

        assert!(!dir.path().join("pingpulse-2020-01-01.log").exists());
        assert!(!dir.path().join("pingpulse-2020-06-15.log").exists());
        assert!(dir.path().join(format!("pingpulse-{today}.log")).exists());
    }
}
```

- [ ] **Step 2: Add `tempfile` dev-dependency to `Cargo.toml`**

```toml
[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 3: Add `mod logger;` to `main.rs`**

- [ ] **Step 4: Run tests — should pass**

Run: `cd client && cargo test logger`
Expected: All 3 tests pass

- [ ] **Step 5: Commit**

```bash
git add client/
git commit -m "feat(client): add daily-rotating JSON log writer with retention cleanup"
```

---

### Task 5: Speed Test Module

**Files:**
- Create: `client/src/speed_test.rs`
- Modify: `client/src/main.rs` — add `mod speed_test;`

- [ ] **Step 1: Write the speed test module**

Create `client/src/speed_test.rs`:

```rust
use std::time::Instant;

use reqwest::Client;
use tracing::{info, error};

use crate::messages::{SpeedTestResult, SpeedTestType};

/// Run a probe speed test: single sequential download + upload.
pub async fn run_probe(
    http: &Client,
    base_url: &str,
    client_id: &str,
    payload_size: u64,
) -> anyhow::Result<SpeedTestResult> {
    info!(event = "speed_test_start", test_type = "probe", payload_bytes = payload_size);

    let start = Instant::now();

    // Download
    let download_url = format!("{base_url}/api/speedtest/download?size={payload_size}");
    let dl_start = Instant::now();
    let dl_bytes = http.get(&download_url).send().await?.bytes().await?;
    let dl_elapsed = dl_start.elapsed();
    let download_mbps = (dl_bytes.len() as f64 * 8.0) / (dl_elapsed.as_secs_f64() * 1_000_000.0);

    // Upload
    let upload_url = format!("{base_url}/api/speedtest/upload");
    let ul_start = Instant::now();
    let payload = vec![0u8; payload_size as usize];
    http.post(&upload_url).body(payload).send().await?;
    let ul_elapsed = ul_start.elapsed();
    let upload_mbps = (payload_size as f64 * 8.0) / (ul_elapsed.as_secs_f64() * 1_000_000.0);

    let total_elapsed = start.elapsed();

    let result = SpeedTestResult {
        client_id: client_id.to_string(),
        timestamp: chrono::Local::now().to_rfc3339(),
        test_type: SpeedTestType::Probe,
        download_mbps,
        upload_mbps,
        payload_bytes: payload_size,
        duration_ms: total_elapsed.as_millis() as u64,
    };

    info!(
        event = "speed_test_complete",
        test_type = "probe",
        download_mbps = format!("{:.1}", result.download_mbps),
        upload_mbps = format!("{:.1}", result.upload_mbps),
        duration_ms = result.duration_ms,
    );

    Ok(result)
}

/// Run a full speed test: 4 parallel connections for download, then 4 for upload.
pub async fn run_full(
    http: &Client,
    base_url: &str,
    client_id: &str,
    total_payload: u64,
) -> anyhow::Result<SpeedTestResult> {
    const STREAMS: u64 = 4;
    let chunk_size = total_payload / STREAMS;

    info!(event = "speed_test_start", test_type = "full", payload_bytes = total_payload);

    let start = Instant::now();

    // Parallel download
    let download_url = format!("{base_url}/api/speedtest/download?size={chunk_size}");
    let dl_start = Instant::now();
    let dl_tasks: Vec<_> = (0..STREAMS)
        .map(|_| {
            let http = http.clone();
            let url = download_url.clone();
            tokio::spawn(async move {
                let resp = http.get(&url).send().await?;
                let bytes = resp.bytes().await?;
                Ok::<usize, anyhow::Error>(bytes.len())
            })
        })
        .collect();

    let mut total_dl_bytes = 0usize;
    for task in dl_tasks {
        total_dl_bytes += task.await??;
    }
    let dl_elapsed = dl_start.elapsed();
    let download_mbps = (total_dl_bytes as f64 * 8.0) / (dl_elapsed.as_secs_f64() * 1_000_000.0);

    // Parallel upload
    let upload_url = format!("{base_url}/api/speedtest/upload");
    let ul_start = Instant::now();
    let ul_tasks: Vec<_> = (0..STREAMS)
        .map(|_| {
            let http = http.clone();
            let url = upload_url.clone();
            let payload = vec![0u8; chunk_size as usize];
            tokio::spawn(async move {
                http.post(&url).body(payload).send().await?;
                Ok::<(), anyhow::Error>(())
            })
        })
        .collect();

    for task in ul_tasks {
        task.await??;
    }
    let ul_elapsed = ul_start.elapsed();
    let upload_mbps = (total_payload as f64 * 8.0) / (ul_elapsed.as_secs_f64() * 1_000_000.0);

    let total_elapsed = start.elapsed();

    let result = SpeedTestResult {
        client_id: client_id.to_string(),
        timestamp: chrono::Local::now().to_rfc3339(),
        test_type: SpeedTestType::Full,
        download_mbps,
        upload_mbps,
        payload_bytes: total_payload,
        duration_ms: total_elapsed.as_millis() as u64,
    };

    info!(
        event = "speed_test_complete",
        test_type = "full",
        download_mbps = format!("{:.1}", result.download_mbps),
        upload_mbps = format!("{:.1}", result.upload_mbps),
        duration_ms = result.duration_ms,
    );

    Ok(result)
}
```

- [ ] **Step 2: Add `mod speed_test;` to `main.rs`**

- [ ] **Step 3: Verify it compiles**

Run: `cd client && cargo build`
Expected: Compiles successfully

- [ ] **Step 4: Commit**

```bash
git add client/
git commit -m "feat(client): add speed test module with probe and full test support"
```

---

### Task 6: WebSocket Connection + Main Event Loop

**Files:**
- Create: `client/src/websocket.rs`
- Modify: `client/src/main.rs` — add `mod websocket;`

- [ ] **Step 1: Write the WebSocket module**

Create `client/src/websocket.rs`:

```rust
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use rand::Rng;
use tokio::time::{self, Instant};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{info, warn, error};

use crate::config::Config;
use crate::messages::{IncomingMessage, OutgoingMessage, SpeedTestType};
use crate::speed_test;

/// Run the main WebSocket event loop with auto-reconnect.
pub async fn run(config: Config) -> anyhow::Result<()> {
    let http = reqwest::Client::new();
    let mut config = config;
    let mut backoff = Backoff::new();

    loop {
        match connect_and_run(&mut config, &http, &mut backoff).await {
            Ok(Shutdown::Graceful) => {
                info!(event = "shutdown", reason = "signal");
                return Ok(());
            }
            Ok(Shutdown::Disconnected) => {
                let delay = backoff.next_delay();
                warn!(
                    event = "ws_disconnected",
                    reconnect_in_ms = delay.as_millis() as u64,
                );
                time::sleep(delay).await;
            }
            Err(e) => {
                let delay = backoff.next_delay();
                error!(
                    event = "ws_error",
                    error = %e,
                    reconnect_in_ms = delay.as_millis() as u64,
                );
                time::sleep(delay).await;
            }
        }
    }
}

enum Shutdown {
    Graceful,
    Disconnected,
}

async fn connect_and_run(
    config: &mut Config,
    http: &reqwest::Client,
    backoff: &mut Backoff,
) -> anyhow::Result<Shutdown> {
    // Build WebSocket URL
    let base = &config.server.base_url;
    let ws_path = &config.server.ws_url;
    let ws_url = base
        .replace("https://", "wss://")
        .replace("http://", "ws://")
        + ws_path;

    info!(event = "ws_connecting", url = %ws_url);

    // Build request with auth header
    let request = http::Request::builder()
        .uri(&ws_url)
        .header("Authorization", format!("Bearer {}", config.server.client_secret))
        .header("Host", url::Url::parse(base)?.host_str().unwrap_or(""))
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header("Sec-WebSocket-Key", tokio_tungstenite::tungstenite::handshake::client::generate_key())
        .body(())?;

    let (ws_stream, _) = connect_async(request).await?;
    let (mut sink, mut stream) = ws_stream.split();

    info!(event = "ws_connected");
    backoff.reset();

    let mut ping_interval = time::interval(Duration::from_secs(config.ping.interval_s as u64));
    ping_interval.tick().await; // Skip the immediate first tick
    let mut ping_counter: u64 = 0;

    loop {
        tokio::select! {
            msg = stream.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        match serde_json::from_str::<IncomingMessage>(&text) {
                            Ok(incoming) => {
                                handle_message(
                                    incoming,
                                    config,
                                    http,
                                    &mut sink,
                                    &mut ping_interval,
                                ).await;
                            }
                            Err(e) => {
                                warn!(event = "ws_parse_error", error = %e, raw = %text);
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        return Ok(Shutdown::Disconnected);
                    }
                    Some(Err(e)) => {
                        return Err(e.into());
                    }
                    _ => {} // Ignore binary, ping/pong frames (handled by tungstenite)
                }
            }

            _ = ping_interval.tick() => {
                ping_counter += 1;
                let ts = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as u64;
                let msg = OutgoingMessage::Ping {
                    id: format!("client-{ping_counter}"),
                    ts,
                };
                let json = serde_json::to_string(&msg).unwrap();
                if let Err(e) = sink.send(Message::Text(json.into())).await {
                    error!(event = "ping_send_error", error = %e);
                    return Ok(Shutdown::Disconnected);
                }
                info!(event = "ping_sent", id = format!("client-{ping_counter}"));
            }

            _ = shutdown_signal() => {
                let _ = sink.close().await;
                return Ok(Shutdown::Graceful);
            }
        }
    }
}

async fn handle_message(
    msg: IncomingMessage,
    config: &mut Config,
    http: &reqwest::Client,
    sink: &mut futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        Message,
    >,
    ping_interval: &mut time::Interval,
) {
    match msg {
        IncomingMessage::Ping { id, ts } => {
            let client_ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64;
            let pong = OutgoingMessage::Pong { id: id.clone(), ts, client_ts };
            let json = serde_json::to_string(&pong).unwrap();
            if let Err(e) = sink.send(Message::Text(json.into())).await {
                error!(event = "pong_send_error", error = %e);
            }
            info!(event = "ping_reply", ping_id = %id);
        }

        IncomingMessage::Pong { id, ts, client_ts } => {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64;
            // ts was our original timestamp, client_ts is CF's reply time
            let rtt_ms = now.saturating_sub(ts);
            info!(event = "pong_received", ping_id = %id, rtt_ms = rtt_ms);
        }

        IncomingMessage::ConfigUpdate { config: remote } => {
            let old_interval = config.ping.interval_s;
            let old_probe = config.speed_test.probe_size_bytes;
            let old_full = config.speed_test.full_test_payload_bytes;
            let old_latency = config.alerts.latency_threshold_ms;
            let old_loss = config.alerts.loss_threshold_pct;
            let old_grace = config.ping.grace_period_s;

            config.apply_remote(&remote);
            if let Err(e) = config.save().await {
                error!(event = "config_save_error", error = %e);
            }
            if config.ping.interval_s != old_interval {
                *ping_interval = time::interval(Duration::from_secs(config.ping.interval_s as u64));
                ping_interval.tick().await; // Skip immediate tick
            }
            info!(
                event = "config_updated",
                ping_interval_s = config.ping.interval_s,
                interval_changed = (config.ping.interval_s != old_interval),
                probe_changed = (config.speed_test.probe_size_bytes != old_probe),
                full_payload_changed = (config.speed_test.full_test_payload_bytes != old_full),
                latency_threshold_changed = (config.alerts.latency_threshold_ms != old_latency),
                loss_threshold_changed = (config.alerts.loss_threshold_pct != old_loss),
                grace_period_changed = (config.ping.grace_period_s != old_grace),
            );
        }

        IncomingMessage::StartSpeedTest { test_type } => {
            let http = http.clone();
            let base_url = config.server.base_url.clone();
            let client_id = config.server.client_id.clone();
            let probe_size = config.speed_test.probe_size_bytes;
            let full_size = config.speed_test.full_test_payload_bytes;

            // Clone what we need for the sink send
            // Speed tests run as a spawned task to avoid blocking the event loop
            // We can't move sink into the task, so we'll send via a channel
            let result = match test_type {
                SpeedTestType::Probe => {
                    speed_test::run_probe(&http, &base_url, &client_id, probe_size).await
                }
                SpeedTestType::Full => {
                    speed_test::run_full(&http, &base_url, &client_id, full_size).await
                }
            };

            match result {
                Ok(result) => {
                    let msg = OutgoingMessage::SpeedTestResult { result };
                    let json = serde_json::to_string(&msg).unwrap();
                    if let Err(e) = sink.send(Message::Text(json.into())).await {
                        error!(event = "speed_test_send_error", error = %e);
                    }
                }
                Err(e) => {
                    error!(event = "speed_test_error", error = %e);
                    let msg = OutgoingMessage::Error {
                        message: format!("Speed test failed: {e}"),
                    };
                    let json = serde_json::to_string(&msg).unwrap();
                    let _ = sink.send(Message::Text(json.into())).await;
                }
            }
        }
    }
}

// --- Backoff ---

struct Backoff {
    current_ms: u64,
}

impl Backoff {
    const INITIAL_MS: u64 = 1_000;
    const MAX_MS: u64 = 60_000;

    fn new() -> Self {
        Self { current_ms: Self::INITIAL_MS }
    }

    fn reset(&mut self) {
        self.current_ms = Self::INITIAL_MS;
    }

    fn next_delay(&mut self) -> Duration {
        let jitter_range = self.current_ms / 4; // ±25%
        let jitter = if jitter_range > 0 {
            rand::random_range(0..jitter_range * 2) as i64 - jitter_range as i64
        } else {
            0
        };
        let delay_ms = (self.current_ms as i64 + jitter).max(100) as u64;
        self.current_ms = (self.current_ms * 2).min(Self::MAX_MS);
        Duration::from_millis(delay_ms)
    }
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("Failed to install SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = sigterm.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c().await.ok();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_backoff_increases() {
        let mut b = Backoff::new();
        let d1 = b.next_delay();
        let d2 = b.next_delay();
        // d2 should be roughly 2x d1 (accounting for jitter)
        assert!(d2.as_millis() > d1.as_millis());
    }

    #[test]
    fn test_backoff_caps_at_max() {
        let mut b = Backoff::new();
        for _ in 0..20 {
            b.next_delay();
        }
        // After many iterations, should not exceed MAX + jitter
        let d = b.next_delay();
        assert!(d.as_millis() <= (Backoff::MAX_MS + Backoff::MAX_MS / 4) as u128);
    }

    #[test]
    fn test_backoff_reset() {
        let mut b = Backoff::new();
        b.next_delay();
        b.next_delay();
        b.next_delay();
        b.reset();
        // After reset, delay should be close to INITIAL
        let d = b.next_delay();
        assert!(d.as_millis() < 2000); // INITIAL is 1000, with 25% jitter max ~1250
    }
}
```

- [ ] **Step 2: Add `mod websocket;` to `main.rs`**

- [ ] **Step 3: Run tests — should pass**

Run: `cd client && cargo test websocket`
Expected: All 3 backoff tests pass

- [ ] **Step 4: Verify full build compiles**

Run: `cd client && cargo build`
Expected: Compiles successfully

- [ ] **Step 5: Commit**

```bash
git add client/
git commit -m "feat(client): add WebSocket connection with auto-reconnect and event loop"
```

---

### Task 7: Service Installation Module

**Files:**
- Create: `client/src/service.rs`
- Modify: `client/src/main.rs` — add `mod service;`

- [ ] **Step 1: Write the service module**

Create `client/src/service.rs`:

```rust
use std::path::PathBuf;
use std::process::Command;

use anyhow::{bail, Context, Result};
use tracing::info;

/// Install and start the daemon as a system service.
pub fn install_and_start(binary_path: &str) -> Result<()> {
    #[cfg(target_os = "macos")]
    return install_launchd(binary_path);

    #[cfg(target_os = "linux")]
    return install_systemd(binary_path);

    #[cfg(target_os = "windows")]
    {
        eprintln!("Windows service installation not yet supported. Use --foreground.");
        bail!("Windows service not supported in v1");
    }
}

/// Stop and uninstall the daemon service.
pub fn stop() -> Result<()> {
    #[cfg(target_os = "macos")]
    return stop_launchd();

    #[cfg(target_os = "linux")]
    return stop_systemd();

    #[cfg(target_os = "windows")]
    {
        bail!("Windows service not supported in v1");
    }
}

/// Check if the service is currently running.
pub fn status() -> Result<bool> {
    #[cfg(target_os = "macos")]
    return status_launchd();

    #[cfg(target_os = "linux")]
    return status_systemd();

    #[cfg(target_os = "windows")]
    {
        bail!("Windows service not supported in v1");
    }
}

// --- macOS (launchd) ---

#[cfg(target_os = "macos")]
const PLIST_LABEL: &str = "ca.beric.pingpulse";

#[cfg(target_os = "macos")]
fn plist_path() -> PathBuf {
    dirs::home_dir()
        .expect("No home directory")
        .join("Library/LaunchAgents/ca.beric.pingpulse.plist")
}

#[cfg(target_os = "macos")]
fn install_launchd(binary_path: &str) -> Result<()> {
    let logs_dir = crate::config::Config::logs_dir();
    std::fs::create_dir_all(&logs_dir)?;

    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{PLIST_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{binary_path}</string>
        <string>start</string>
        <string>--foreground</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>{stdout}</string>
    <key>StandardErrorPath</key>
    <string>{stderr}</string>
</dict>
</plist>"#,
        stdout = logs_dir.join("stdout.log").display(),
        stderr = logs_dir.join("stderr.log").display(),
    );

    let path = plist_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, plist)?;

    let output = Command::new("launchctl")
        .args(["load", path.to_str().unwrap()])
        .output()
        .context("Failed to run launchctl")?;

    if !output.status.success() {
        bail!(
            "launchctl load failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    info!(event = "service_installed", method = "launchd");
    println!("PingPulse service installed and started.");
    Ok(())
}

#[cfg(target_os = "macos")]
fn stop_launchd() -> Result<()> {
    let path = plist_path();
    if !path.exists() {
        bail!("Service plist not found at {}", path.display());
    }

    let output = Command::new("launchctl")
        .args(["unload", path.to_str().unwrap()])
        .output()
        .context("Failed to run launchctl")?;

    if !output.status.success() {
        bail!(
            "launchctl unload failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    std::fs::remove_file(&path)?;
    println!("PingPulse service stopped and removed.");
    Ok(())
}

#[cfg(target_os = "macos")]
fn status_launchd() -> Result<bool> {
    let output = Command::new("launchctl")
        .args(["list", PLIST_LABEL])
        .output()
        .context("Failed to run launchctl")?;

    Ok(output.status.success())
}

// --- Linux (systemd) ---

#[cfg(target_os = "linux")]
fn service_path() -> PathBuf {
    dirs::home_dir()
        .expect("No home directory")
        .join(".config/systemd/user/pingpulse.service")
}

#[cfg(target_os = "linux")]
fn install_systemd(binary_path: &str) -> Result<()> {
    let unit = format!(
        r#"[Unit]
Description=PingPulse Network Monitor
After=network-online.target

[Service]
ExecStart={binary_path} start --foreground
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
"#
    );

    let path = service_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, unit)?;

    Command::new("systemctl")
        .args(["--user", "daemon-reload"])
        .output()?;

    let output = Command::new("systemctl")
        .args(["--user", "enable", "--now", "pingpulse"])
        .output()
        .context("Failed to run systemctl")?;

    if !output.status.success() {
        bail!(
            "systemctl enable failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    println!("PingPulse service installed and started.");
    Ok(())
}

#[cfg(target_os = "linux")]
fn stop_systemd() -> Result<()> {
    Command::new("systemctl")
        .args(["--user", "stop", "pingpulse"])
        .output()?;

    Command::new("systemctl")
        .args(["--user", "disable", "pingpulse"])
        .output()?;

    let path = service_path();
    if path.exists() {
        std::fs::remove_file(&path)?;
    }

    Command::new("systemctl")
        .args(["--user", "daemon-reload"])
        .output()?;

    println!("PingPulse service stopped and removed.");
    Ok(())
}

#[cfg(target_os = "linux")]
fn status_systemd() -> Result<bool> {
    let output = Command::new("systemctl")
        .args(["--user", "is-active", "--quiet", "pingpulse"])
        .output()
        .context("Failed to run systemctl")?;

    Ok(output.status.success())
}
```

- [ ] **Step 2: Add `mod service;` to `main.rs`**

- [ ] **Step 3: Verify it compiles**

Run: `cd client && cargo build`
Expected: Compiles successfully

- [ ] **Step 4: Commit**

```bash
git add client/
git commit -m "feat(client): add service installation for macOS launchd and Linux systemd"
```

---

### Task 8: CLI Interface (main.rs)

**Files:**
- Modify: `client/src/main.rs` — full rewrite with clap CLI

- [ ] **Step 1: Write the full CLI entry point**

Replace `client/src/main.rs` with:

```rust
mod config;
mod logger;
mod messages;
mod service;
mod speed_test;
mod websocket;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "pingpulse", version, about = "PingPulse network monitor daemon")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Exchange a registration token for client credentials
    Register {
        /// Single-use token from the admin dashboard
        #[arg(long)]
        token: String,
        /// Human-readable name for this client (e.g., "Home Office")
        #[arg(long)]
        name: String,
        /// Location label (e.g., "Toronto, CA")
        #[arg(long)]
        location: String,
        /// Base URL of the PingPulse server (e.g., https://ping.beric.ca)
        #[arg(long)]
        server: String,
    },
    /// Start the PingPulse daemon
    Start {
        /// Run in the foreground instead of installing as a service
        #[arg(long)]
        foreground: bool,
    },
    /// Stop the PingPulse daemon
    Stop,
    /// Check the daemon status
    Status,
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();

    match cli.command {
        Commands::Register { token, name, location, server } => {
            if let Err(e) = cmd_register(&server, &token, &name, &location).await {
                eprintln!("Registration failed: {e}");
                std::process::exit(1);
            }
        }
        Commands::Start { foreground } => {
            if foreground {
                if let Err(e) = cmd_start_foreground().await {
                    eprintln!("Daemon error: {e}");
                    std::process::exit(1);
                }
            } else {
                if let Err(e) = cmd_start_service() {
                    eprintln!("Service install failed: {e}");
                    std::process::exit(1);
                }
            }
        }
        Commands::Stop => {
            if let Err(e) = service::stop() {
                eprintln!("Failed to stop: {e}");
                std::process::exit(1);
            }
        }
        Commands::Status => {
            match service::status() {
                Ok(true) => println!("PingPulse is running"),
                Ok(false) => println!("PingPulse is not running"),
                Err(e) => {
                    eprintln!("Status check failed: {e}");
                    std::process::exit(1);
                }
            }
        }
    }
}

async fn cmd_register(server: &str, token: &str, name: &str, location: &str) -> anyhow::Result<()> {
    println!("Registering with {}...", server);

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{server}/api/auth/register"))
        .json(&serde_json::json!({
            "token": token,
            "name": name,
            "location": location,
        }))
        .send()
        .await?;

    if !resp.status().is_success() {
        let body: serde_json::Value = resp.json().await?;
        anyhow::bail!(
            "Server returned error: {}",
            body.get("error").and_then(|e| e.as_str()).unwrap_or("unknown error")
        );
    }

    #[derive(serde::Deserialize)]
    struct RegisterResponse {
        client_id: String,
        client_secret: String,
        ws_url: String,
    }

    let reg: RegisterResponse = resp.json().await?;
    let config = config::Config::new_from_registration(
        server.to_string(),
        reg.ws_url,
        reg.client_id.clone(),
        reg.client_secret,
    );

    config.save().await?;

    println!("Registered successfully!");
    println!("  Client ID: {}", reg.client_id);
    println!("  Config saved to: {}", config::Config::config_path().display());
    println!();
    println!("Start the daemon with: pingpulse start");

    Ok(())
}

async fn cmd_start_foreground() -> anyhow::Result<()> {
    let config = config::Config::load().await?;

    logger::init(
        config::Config::logs_dir(),
        &config.logging.level,
        config.logging.retention_days,
    );

    tracing::info!(event = "daemon_starting", client_id = %config.server.client_id);

    websocket::run(config).await
}

fn cmd_start_service() -> anyhow::Result<()> {
    let binary = std::env::current_exe()?
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("Binary path is not valid UTF-8"))?
        .to_string();

    service::install_and_start(&binary)
}
```

- [ ] **Step 2: Verify it compiles and `--help` works**

Run: `cd client && cargo build && ./target/debug/pingpulse --help`
Expected: Shows help with `register`, `start`, `stop`, `status` subcommands

- [ ] **Step 3: Verify subcommand help works**

Run: `./target/debug/pingpulse register --help`
Expected: Shows `--token`, `--name`, `--location`, `--server` flags

- [ ] **Step 4: Commit**

```bash
git add client/
git commit -m "feat(client): add CLI interface with register, start, stop, status commands"
```

---

### Task 9: Build Verification + Final Cleanup

**Files:**
- All files in `client/`

- [ ] **Step 1: Run all tests**

Run: `cd client && cargo test`
Expected: All tests pass (config: 3, messages: 7, logger: 3, websocket/backoff: 3)

- [ ] **Step 2: Run clippy**

Run: `cd client && cargo clippy -- -W clippy::all`
Expected: No warnings (fix any that appear)

- [ ] **Step 3: Verify release build**

Run: `cd client && cargo build --release`
Expected: Compiles, binary at `target/release/pingpulse`

- [ ] **Step 4: Test CLI help output**

Run: `./target/release/pingpulse --help`
Expected: Clean help output with all 4 subcommands

- [ ] **Step 5: Final commit**

```bash
git add client/
git commit -m "chore(client): cleanup, clippy fixes, release build verification"
```

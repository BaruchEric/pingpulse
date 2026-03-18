# Local Agent Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent local management HTTP server (`pingpulse agent`) and dashboard panel for full client lifecycle control.

**Architecture:** A new `pingpulse agent` subcommand runs an axum HTTP server on `127.0.0.1:9111`, managing the daemon service via OS commands. The dashboard detects the local agent and renders a control panel. A new server-side endpoint allows the agent to self-delete its client record during uninstall.

**Tech Stack:** Rust (axum, tokio, serde), TypeScript (React), Hono (Cloudflare Workers)

**Spec:** `docs/superpowers/specs/2026-03-17-local-agent-management-design.md`

---

### Task 1: Add axum dependency and Agent subcommand

**Files:**
- Modify: `client/Cargo.toml`
- Modify: `client/src/main.rs`
- Create: `client/src/agent.rs`

- [ ] **Step 1: Add axum to Cargo.toml**

In `client/Cargo.toml`, add to `[dependencies]`:

```toml
axum = "0.8"
tower-http = { version = "0.6", features = ["cors"] }
```

- [ ] **Step 2: Create agent.rs stub module**

Create `client/src/agent.rs`:

```rust
use std::net::SocketAddr;
use anyhow::Result;
use crate::config::Config;

pub async fn run(port: u16) -> Result<()> {
    let config = Config::load().await?;
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    tracing::info!(event = "agent_starting", %addr, client_id = %config.server.client_id);
    // TODO: implement HTTP server
    println!("Agent listening on {addr}");
    tokio::signal::ctrl_c().await?;
    Ok(())
}
```

- [ ] **Step 3: Add Agent command variant to main.rs**

In `client/src/main.rs`, add `mod agent;` after `mod websocket;`.

Add to the `Commands` enum:

```rust
/// Run the local management API server
Agent {
    /// Port for the local management API
    #[arg(long, default_value = "9111")]
    port: u16,
},
```

Add to the `match cli.command` block:

```rust
Commands::Agent { port } => {
    if let Err(e) = agent::run(port).await {
        eprintln!("Agent error: {e}");
        std::process::exit(1);
    }
}
```

- [ ] **Step 4: Verify it compiles**

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/client && cargo build`
Expected: Compiles successfully.

- [ ] **Step 5: Commit**

```bash
git add client/Cargo.toml client/src/main.rs client/src/agent.rs
git commit -m "feat(client): add agent subcommand stub with axum dependency"
```

---

### Task 2: Extend service module with agent functions

**Files:**
- Modify: `client/src/service.rs`

- [ ] **Step 1: Add agent plist constants and path function (macOS)**

After the existing `plist_path()` function, add:

```rust
#[cfg(target_os = "macos")]
const AGENT_PLIST_LABEL: &str = "ca.beric.pingpulse.agent";

#[cfg(target_os = "macos")]
fn agent_plist_path() -> PathBuf {
    dirs::home_dir()
        .expect("No home directory")
        .join("Library/LaunchAgents/ca.beric.pingpulse.agent.plist")
}
```

- [ ] **Step 2: Add install_agent for macOS**

```rust
#[cfg(target_os = "macos")]
fn install_agent_launchd(binary_path: &str) -> Result<()> {
    let logs_dir = crate::config::Config::logs_dir();
    std::fs::create_dir_all(&logs_dir)?;

    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{AGENT_PLIST_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{binary_path}</string>
        <string>agent</string>
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
        stdout = logs_dir.join("agent-stdout.log").display(),
        stderr = logs_dir.join("agent-stderr.log").display(),
    );

    let path = agent_plist_path();
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

    info!(event = "agent_service_installed", method = "launchd");
    println!("PingPulse agent service installed and started.");
    Ok(())
}
```

- [ ] **Step 3: Add stop_agent and status_agent for macOS**

```rust
#[cfg(target_os = "macos")]
fn stop_agent_launchd() -> Result<()> {
    let path = agent_plist_path();
    if !path.exists() {
        bail!("Agent service plist not found at {}", path.display());
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
    println!("PingPulse agent service stopped and removed.");
    Ok(())
}

#[cfg(target_os = "macos")]
fn status_agent_launchd() -> Result<bool> {
    let output = Command::new("launchctl")
        .args(["list", AGENT_PLIST_LABEL])
        .output()
        .context("Failed to run launchctl")?;

    Ok(output.status.success())
}
```

- [ ] **Step 4: Add agent functions for Linux**

```rust
#[cfg(target_os = "linux")]
fn agent_service_path() -> PathBuf {
    dirs::home_dir()
        .expect("No home directory")
        .join(".config/systemd/user/pingpulse-agent.service")
}

#[cfg(target_os = "linux")]
fn install_agent_systemd(binary_path: &str) -> Result<()> {
    let unit = format!(
        r#"[Unit]
Description=PingPulse Agent (Local Management API)
After=network-online.target

[Service]
ExecStart={binary_path} agent
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
"#
    );

    let path = agent_service_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, unit)?;

    Command::new("systemctl")
        .args(["--user", "daemon-reload"])
        .output()?;

    let output = Command::new("systemctl")
        .args(["--user", "enable", "--now", "pingpulse-agent"])
        .output()
        .context("Failed to run systemctl")?;

    if !output.status.success() {
        bail!(
            "systemctl enable failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    println!("PingPulse agent service installed and started.");
    Ok(())
}

#[cfg(target_os = "linux")]
fn stop_agent_systemd() -> Result<()> {
    Command::new("systemctl")
        .args(["--user", "stop", "pingpulse-agent"])
        .output()?;

    Command::new("systemctl")
        .args(["--user", "disable", "pingpulse-agent"])
        .output()?;

    let path = agent_service_path();
    if path.exists() {
        std::fs::remove_file(&path)?;
    }

    Command::new("systemctl")
        .args(["--user", "daemon-reload"])
        .output()?;

    println!("PingPulse agent service stopped and removed.");
    Ok(())
}

#[cfg(target_os = "linux")]
fn status_agent_systemd() -> Result<bool> {
    let output = Command::new("systemctl")
        .args(["--user", "is-active", "--quiet", "pingpulse-agent"])
        .output()
        .context("Failed to run systemctl")?;

    Ok(output.status.success())
}
```

- [ ] **Step 5: Add public dispatch functions**

Add these public functions alongside the existing `install_and_start`, `stop`, and `status`:

```rust
/// Install and start the agent as a system service.
pub fn install_agent(binary_path: &str) -> Result<()> {
    #[cfg(target_os = "macos")]
    return install_agent_launchd(binary_path);

    #[cfg(target_os = "linux")]
    return install_agent_systemd(binary_path);

    #[cfg(target_os = "windows")]
    {
        bail!("Windows agent service not supported in v1");
    }
}

/// Stop and remove the agent service.
pub fn stop_agent() -> Result<()> {
    #[cfg(target_os = "macos")]
    return stop_agent_launchd();

    #[cfg(target_os = "linux")]
    return stop_agent_systemd();

    #[cfg(target_os = "windows")]
    {
        bail!("Windows agent service not supported in v1");
    }
}

/// Check if the agent service is currently running.
pub fn status_agent() -> Result<bool> {
    #[cfg(target_os = "macos")]
    return status_agent_launchd();

    #[cfg(target_os = "linux")]
    return status_agent_systemd();

    #[cfg(target_os = "windows")]
    {
        bail!("Windows agent service not supported in v1");
    }
}

/// Remove both daemon and agent services.
pub fn uninstall_all() -> Result<()> {
    // Stop daemon first (ignore errors — may already be stopped)
    let _ = stop();
    stop_agent()
}

/// Delete all PingPulse data from this machine.
pub fn cleanup_data() -> Result<()> {
    let dir = crate::config::Config::config_dir();
    if dir.exists() {
        std::fs::remove_dir_all(&dir)
            .context("Failed to remove PingPulse data directory")?;
        info!(event = "data_cleaned", path = %dir.display());
    }
    Ok(())
}
```

- [ ] **Step 6: Verify it compiles**

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/client && cargo build`
Expected: Compiles successfully.

- [ ] **Step 7: Commit**

```bash
git add client/src/service.rs
git commit -m "feat(client): add agent service management functions for macOS and Linux"
```

---

### Task 3: Implement agent HTTP server with /status endpoint

**Files:**
- Modify: `client/src/agent.rs`

- [ ] **Step 1: Write test for status response serialization**

Add to the bottom of `client/src/agent.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_status_response_serialization() {
        let status = StatusResponse {
            client_id: "abc123".into(),
            client_name: "Home Office".into(),
            location: "Toronto".into(),
            server_url: "https://ping.beric.ca".into(),
            daemon_running: true,
            agent_version: env!("CARGO_PKG_VERSION").into(),
            uptime_s: 3600,
        };
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["client_id"], "abc123");
        assert_eq!(json["daemon_running"], true);
        assert_eq!(json["uptime_s"], 3600);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/client && cargo test agent::tests::test_status_response_serialization`
Expected: FAIL — `StatusResponse` not defined.

- [ ] **Step 3: Implement the full agent server**

Replace `client/src/agent.rs` with:

```rust
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Instant;

use anyhow::Result;
use axum::extract::State;
use axum::http::{HeaderValue, Method};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Serialize;
use tower_http::cors::CorsLayer;

use crate::config::Config;
use crate::service;

struct AppState {
    config: Config,
    started_at: Instant,
}

#[derive(Serialize)]
struct StatusResponse {
    client_id: String,
    client_name: String,
    location: String,
    server_url: String,
    daemon_running: bool,
    agent_version: String,
    uptime_s: u64,
}

#[derive(Serialize)]
struct ActionResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    warnings: Option<Vec<String>>,
}

impl ActionResponse {
    fn success() -> Self {
        Self { ok: true, error: None, warnings: None }
    }

    fn error(msg: impl Into<String>) -> Self {
        Self { ok: false, error: Some(msg.into()), warnings: None }
    }

    fn with_warnings(mut self, warnings: Vec<String>) -> Self {
        self.warnings = Some(warnings);
        self
    }
}

async fn get_status(State(state): State<Arc<AppState>>) -> Json<StatusResponse> {
    let daemon_running = service::status().unwrap_or(false);
    Json(StatusResponse {
        client_id: state.config.server.client_id.clone(),
        client_name: String::new(), // Agent doesn't store the name locally
        location: String::new(),    // Agent doesn't store location locally
        server_url: state.config.server.base_url.clone(),
        daemon_running,
        agent_version: env!("CARGO_PKG_VERSION").into(),
        uptime_s: state.started_at.elapsed().as_secs(),
    })
}

fn build_cors(server_url: &str) -> CorsLayer {
    let origin = server_url
        .parse::<HeaderValue>()
        .unwrap_or_else(|_| HeaderValue::from_static("http://localhost:8787"));

    CorsLayer::new()
        .allow_origin(origin)
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers(tower_http::cors::Any)
}

pub async fn run(port: u16) -> Result<()> {
    let config = Config::load().await?;
    let addr = SocketAddr::from(([127, 0, 0, 1], port));

    let cors = build_cors(&config.server.base_url);

    let state = Arc::new(AppState {
        config,
        started_at: Instant::now(),
    });

    let app = Router::new()
        .route("/status", get(get_status))
        .layer(cors)
        .with_state(state);

    tracing::info!(event = "agent_starting", %addr);
    println!("Agent listening on {addr}");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_status_response_serialization() {
        let status = StatusResponse {
            client_id: "abc123".into(),
            client_name: "Home Office".into(),
            location: "Toronto".into(),
            server_url: "https://ping.beric.ca".into(),
            daemon_running: true,
            agent_version: env!("CARGO_PKG_VERSION").into(),
            uptime_s: 3600,
        };
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["client_id"], "abc123");
        assert_eq!(json["daemon_running"], true);
        assert_eq!(json["uptime_s"], 3600);
    }

    #[test]
    fn test_action_response_success() {
        let resp = ActionResponse::success();
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["ok"], true);
        assert!(json.get("error").is_none());
    }

    #[test]
    fn test_action_response_error() {
        let resp = ActionResponse::error("something failed");
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["ok"], false);
        assert_eq!(json["error"], "something failed");
    }

    #[test]
    fn test_action_response_with_warnings() {
        let resp = ActionResponse::success()
            .with_warnings(vec!["Server unreachable".into()]);
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["ok"], true);
        assert_eq!(json["warnings"][0], "Server unreachable");
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/client && cargo test agent::tests`
Expected: 4 tests PASS.

- [ ] **Step 5: Verify full build**

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/client && cargo build`
Expected: Compiles successfully.

- [ ] **Step 6: Commit**

```bash
git add client/src/agent.rs
git commit -m "feat(client): implement agent HTTP server with /status endpoint and CORS"
```

---

### Task 4: Implement daemon management endpoints

**Files:**
- Modify: `client/src/agent.rs`

- [ ] **Step 1: Add daemon control handlers**

Add these handler functions after `get_status` in `agent.rs`:

```rust
async fn daemon_start(State(state): State<Arc<AppState>>) -> Json<ActionResponse> {
    let binary = match std::env::current_exe() {
        Ok(p) => p.to_string_lossy().to_string(),
        Err(e) => return Json(ActionResponse::error(format!("Cannot find binary path: {e}"))),
    };

    match service::install_and_start(&binary) {
        Ok(()) => Json(ActionResponse::success()),
        Err(e) => Json(ActionResponse::error(format!("Failed to start daemon: {e}"))),
    }
}

async fn daemon_stop(State(state): State<Arc<AppState>>) -> Json<ActionResponse> {
    match service::stop() {
        Ok(()) => Json(ActionResponse::success()),
        Err(e) => Json(ActionResponse::error(format!("Failed to stop daemon: {e}"))),
    }
}

async fn daemon_restart(State(state): State<Arc<AppState>>) -> Json<ActionResponse> {
    // Stop (ignore error if not running)
    let _ = service::stop();
    // Brief pause to ensure clean shutdown
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    let binary = match std::env::current_exe() {
        Ok(p) => p.to_string_lossy().to_string(),
        Err(e) => return Json(ActionResponse::error(format!("Cannot find binary path: {e}"))),
    };

    match service::install_and_start(&binary) {
        Ok(()) => Json(ActionResponse::success()),
        Err(e) => Json(ActionResponse::error(format!("Failed to restart daemon: {e}"))),
    }
}
```

- [ ] **Step 2: Register daemon routes**

Update the `Router::new()` in `run()` to add the daemon routes:

```rust
let app = Router::new()
    .route("/status", get(get_status))
    .route("/daemon/start", post(daemon_start))
    .route("/daemon/stop", post(daemon_stop))
    .route("/daemon/restart", post(daemon_restart))
    .layer(cors)
    .with_state(state);
```

- [ ] **Step 3: Verify it compiles**

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/client && cargo build`
Expected: Compiles successfully. Note: `state` parameter is unused in handlers — remove `State(state)` or prefix with `_state` if clippy warns. Actually, since we have `#![deny(warnings, clippy::all)]`, remove unused `State` parameter from `daemon_stop`:

```rust
async fn daemon_stop() -> Json<ActionResponse> {
```

And `daemon_start` and `daemon_restart` also don't use state — remove `State(state)` from their signatures too.

- [ ] **Step 4: Commit**

```bash
git add client/src/agent.rs
git commit -m "feat(client): add daemon start/stop/restart agent endpoints"
```

---

### Task 5: Implement /logs and /config endpoints

**Files:**
- Modify: `client/src/agent.rs`

- [ ] **Step 1: Write test for config sanitization**

Add to `agent::tests`:

```rust
#[test]
fn test_config_sanitization() {
    let config = Config {
        server: crate::config::ServerConfig {
            base_url: "https://ping.beric.ca".into(),
            ws_url: "/ws/abc".into(),
            client_id: "abc123".into(),
            client_secret: "super-secret-value".into(),
        },
        ping: crate::config::PingConfig { interval_s: 30, grace_period_s: 60 },
        speed_test: crate::config::SpeedTestConfig {
            probe_size_bytes: 262144,
            full_test_payload_bytes: 10485760,
            full_test_schedule: "0 */6 * * *".into(),
        },
        alerts: crate::config::AlertConfig { latency_threshold_ms: 100.0, loss_threshold_pct: 5.0 },
        logging: crate::config::LoggingConfig { level: "info".into(), retention_days: 30 },
    };
    let sanitized = sanitize_config(&config);
    let json = serde_json::to_string(&sanitized).unwrap();
    assert!(!json.contains("super-secret-value"));
    assert!(json.contains("abc123"));
    assert!(json.contains("REDACTED"));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/client && cargo test agent::tests::test_config_sanitization`
Expected: FAIL — `sanitize_config` not defined.

- [ ] **Step 3: Implement sanitize_config, /config, and /logs handlers**

Add to `agent.rs` (before the handler functions):

```rust
use crate::config;

#[derive(Serialize)]
struct SanitizedConfig {
    server: SanitizedServer,
    ping: config::PingConfig,
    speed_test: config::SpeedTestConfig,
    alerts: config::AlertConfig,
    logging: config::LoggingConfig,
}

#[derive(Serialize)]
struct SanitizedServer {
    base_url: String,
    ws_url: String,
    client_id: String,
    client_secret: String,
}

fn sanitize_config(config: &Config) -> SanitizedConfig {
    SanitizedConfig {
        server: SanitizedServer {
            base_url: config.server.base_url.clone(),
            ws_url: config.server.ws_url.clone(),
            client_id: config.server.client_id.clone(),
            client_secret: "REDACTED".into(),
        },
        ping: config.ping.clone(),
        speed_test: config.speed_test.clone(),
        alerts: config.alerts.clone(),
        logging: config.logging.clone(),
    }
}
```

Add the handler functions:

```rust
async fn get_config(State(state): State<Arc<AppState>>) -> Json<SanitizedConfig> {
    Json(sanitize_config(&state.config))
}

#[derive(Serialize)]
struct LogsResponse {
    lines: Vec<String>,
    file: String,
}

async fn get_logs() -> Json<LogsResponse> {
    let logs_dir = Config::logs_dir();
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let log_file = logs_dir.join(format!("{today}.jsonl"));

    let file_name = log_file.display().to_string();

    let lines = match std::fs::read_to_string(&log_file) {
        Ok(content) => content
            .lines()
            .rev()
            .take(100)
            .map(String::from)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect(),
        Err(_) => vec![],
    };

    Json(LogsResponse { lines, file: file_name })
}
```

- [ ] **Step 4: Register routes**

Update the router in `run()`:

```rust
let app = Router::new()
    .route("/status", get(get_status))
    .route("/daemon/start", post(daemon_start))
    .route("/daemon/stop", post(daemon_stop))
    .route("/daemon/restart", post(daemon_restart))
    .route("/logs", get(get_logs))
    .route("/config", get(get_config))
    .layer(cors)
    .with_state(state);
```

- [ ] **Step 5: Run tests**

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/client && cargo test agent::tests`
Expected: All tests PASS (including the new config sanitization test).

- [ ] **Step 6: Commit**

```bash
git add client/src/agent.rs
git commit -m "feat(client): add /logs and /config agent endpoints with secret redaction"
```

---

### Task 6: Implement service removal and uninstall endpoints

**Files:**
- Modify: `client/src/agent.rs`

- [ ] **Step 1: Implement /service/remove handler**

```rust
async fn service_remove() -> Json<ActionResponse> {
    // Stop daemon and remove its service file
    match service::stop() {
        Ok(()) => Json(ActionResponse::success()),
        Err(e) => Json(ActionResponse::error(format!("Failed to remove daemon service: {e}"))),
    }
}
```

- [ ] **Step 2: Implement /service/uninstall handler**

```rust
async fn service_uninstall(State(state): State<Arc<AppState>>) -> Json<ActionResponse> {
    let mut warnings = Vec::new();

    // 1. Stop daemon service
    let _ = service::stop();

    // 2. Try to delete server record
    let client = reqwest::Client::new();
    let url = format!(
        "{}/api/clients/{}/self",
        state.config.server.base_url, state.config.server.client_id
    );
    match client
        .delete(&url)
        .header("Authorization", format!("Bearer {}", state.config.server.client_secret))
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {}
        Ok(resp) => {
            warnings.push(format!(
                "Server record not deleted — server returned {}",
                resp.status()
            ));
        }
        Err(e) => {
            warnings.push(format!("Server record not deleted — server unreachable: {e}"));
        }
    }

    // 3. Schedule delayed self-cleanup
    tokio::spawn(async {
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;

        // Remove agent service
        if let Err(e) = service::stop_agent() {
            eprintln!("Warning: failed to remove agent service: {e}");
        }

        // Delete data directory
        if let Err(e) = service::cleanup_data() {
            eprintln!("Warning: failed to clean up data: {e}");
        }

        std::process::exit(0);
    });

    let resp = ActionResponse::success();
    if warnings.is_empty() {
        Json(resp)
    } else {
        Json(resp.with_warnings(warnings))
    }
}
```

- [ ] **Step 3: Register routes**

Update the router:

```rust
let app = Router::new()
    .route("/status", get(get_status))
    .route("/daemon/start", post(daemon_start))
    .route("/daemon/stop", post(daemon_stop))
    .route("/daemon/restart", post(daemon_restart))
    .route("/logs", get(get_logs))
    .route("/config", get(get_config))
    .route("/service/remove", post(service_remove))
    .route("/service/uninstall", post(service_uninstall))
    .layer(cors)
    .with_state(state);
```

- [ ] **Step 4: Verify it compiles**

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/client && cargo build`
Expected: Compiles. If clippy warns about unused variables in handlers, fix accordingly.

- [ ] **Step 5: Commit**

```bash
git add client/src/agent.rs
git commit -m "feat(client): add service remove and full uninstall agent endpoints"
```

---

### Task 7: Add self-delete API endpoint on the worker

**Files:**
- Modify: `worker/src/api/clients.ts`
- Modify: `worker/src/utils/hash.ts` (reference only — already exists)

- [ ] **Step 1: Add the self-delete endpoint**

In `worker/src/api/clients.ts`, add this route after the existing `clientRoutes.delete("/:id", ...)`:

```typescript
// Self-delete: allows a client to delete itself using its own secret
clientRoutes.delete("/:id/self", async (c) => {
  const id = c.req.param("id");
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }
  const secret = authHeader.slice(7);

  // Look up the client and verify the secret
  const { hashString } = await import("@/utils/hash");
  const client = await c.env.DB.prepare(
    "SELECT id, secret_hash FROM clients WHERE id = ?"
  )
    .bind(id)
    .first<{ id: string; secret_hash: string }>();

  if (!client) {
    return c.json({ error: "Client not found" }, 404);
  }

  const secretHash = await hashString(secret);
  if (secretHash !== client.secret_hash) {
    return c.json({ error: "Invalid client secret" }, 403);
  }

  // Delete all associated data (same as admin delete)
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM ping_results WHERE client_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM speed_tests WHERE client_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM outages WHERE client_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM alerts WHERE client_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM clients WHERE id = ?").bind(id),
  ]);

  return c.json({ ok: true });
});
```

Note: This endpoint does NOT use the `authGuard` middleware. The `clientRoutes.use("*", authGuard)` at the top will apply to it. We need to exclude this route from auth guard. Two options:

**Option A:** Move the self-delete route to a separate route group mounted before the auth guard.

**Option B:** Check for client-secret auth in the route handler and skip the auth guard.

Since the auth guard is applied with `clientRoutes.use("*", authGuard)` at the top of the file, all routes get it. The cleanest approach is to create a separate route group. Instead of adding to `clientRoutes`, add to `router.ts`:

In `worker/src/api/router.ts`, add a direct route before the protected client routes:

```typescript
// Client self-delete (authenticated with client secret, not admin JWT)
app.delete("/api/clients/:id/self", async (c) => {
  const id = c.req.param("id");
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }
  const secret = authHeader.slice(7);

  const { hashString } = await import("@/utils/hash");
  const client = await c.env.DB.prepare(
    "SELECT id, secret_hash FROM clients WHERE id = ?"
  )
    .bind(id)
    .first<{ id: string; secret_hash: string }>();

  if (!client) {
    return c.json({ error: "Client not found" }, 404);
  }

  const secretHash = await hashString(secret);
  if (secretHash !== client.secret_hash) {
    return c.json({ error: "Invalid client secret" }, 403);
  }

  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM ping_results WHERE client_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM speed_tests WHERE client_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM outages WHERE client_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM alerts WHERE client_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM clients WHERE id = ?").bind(id),
  ]);

  return c.json({ ok: true });
});
```

Place this BEFORE the `app.route("/api/clients", clientRoutes)` line so it matches first. Hono matches routes in order, and the more specific `/api/clients/:id/self` will match before the generic `/api/clients` route group.

- [ ] **Step 2: Verify it builds**

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/worker && bun run build` (or whatever the worker build command is — check `package.json`)

- [ ] **Step 3: Commit**

```bash
git add worker/src/api/router.ts
git commit -m "feat(worker): add client self-delete endpoint for agent uninstall flow"
```

---

### Task 8: Build local agent API helpers for dashboard

**Files:**
- Create: `worker/dashboard/src/lib/local-agent.ts`

- [ ] **Step 1: Create the local agent API module**

```typescript
const AGENT_BASE = "http://localhost:9111";
const AGENT_TIMEOUT = 2000;

export interface AgentStatus {
  client_id: string;
  client_name: string;
  location: string;
  server_url: string;
  daemon_running: boolean;
  agent_version: string;
  uptime_s: number;
}

export interface AgentActionResponse {
  ok: boolean;
  error?: string;
  warnings?: string[];
}

export interface AgentLogs {
  lines: string[];
  file: string;
}

async function agentRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AGENT_TIMEOUT);

  try {
    const res = await fetch(`${AGENT_BASE}${path}`, {
      ...init,
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(body.error || res.statusText);
    }
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

export const localAgent = {
  /** Returns null if agent is not running */
  detect: async (): Promise<AgentStatus | null> => {
    try {
      return await agentRequest<AgentStatus>("/status");
    } catch {
      return null;
    }
  },

  status: () => agentRequest<AgentStatus>("/status"),

  daemonStart: () =>
    agentRequest<AgentActionResponse>("/daemon/start", { method: "POST" }),

  daemonStop: () =>
    agentRequest<AgentActionResponse>("/daemon/stop", { method: "POST" }),

  daemonRestart: () =>
    agentRequest<AgentActionResponse>("/daemon/restart", { method: "POST" }),

  serviceRemove: () =>
    agentRequest<AgentActionResponse>("/service/remove", { method: "POST" }),

  serviceUninstall: () =>
    agentRequest<AgentActionResponse>("/service/uninstall", { method: "POST" }),

  logs: () => agentRequest<AgentLogs>("/logs"),
};
```

- [ ] **Step 2: Commit**

```bash
git add worker/dashboard/src/lib/local-agent.ts
git commit -m "feat(dashboard): add local agent API client helpers"
```

---

### Task 9: Build LocalClientPanel component

**Files:**
- Create: `worker/dashboard/src/components/LocalClientPanel.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { useState, useEffect, useCallback } from "react";
import { localAgent, type AgentStatus, type AgentLogs } from "@/lib/local-agent";

export function LocalClientPanel({ onUninstalled }: { onUninstalled: () => void }) {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [detected, setDetected] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [logs, setLogs] = useState<AgentLogs | null>(null);
  const [showLogs, setShowLogs] = useState(false);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const refresh = useCallback(async () => {
    const s = await localAgent.detect();
    setStatus(s);
    setDetected(s !== null);
  }, []);

  // Initial detection + polling
  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  const runAction = async (
    action: () => Promise<{ ok: boolean; error?: string; warnings?: string[] }>,
    label: string
  ) => {
    setBusy(label);
    try {
      const result = await action();
      if (result.ok) {
        showToast(`${label} successful`);
        if (result.warnings?.length) {
          showToast(`Warning: ${result.warnings.join(", ")}`);
        }
      } else {
        showToast(`${label} failed: ${result.error}`);
      }
      await refresh();
    } catch (e) {
      showToast(`${label} failed: ${e instanceof Error ? e.message : "unknown"}`);
    } finally {
      setBusy(null);
    }
  };

  const handleUninstall = async () => {
    if (!confirm("This will remove all PingPulse services, config, and logs from this machine and delete the client from the server. This cannot be undone. Continue?")) {
      return;
    }
    await runAction(() => localAgent.serviceUninstall(), "Full Uninstall");
    // Agent will self-terminate — detection will fail on next poll
    setDetected(false);
    setStatus(null);
    onUninstalled();
  };

  const handleViewLogs = async () => {
    try {
      const logsData = await localAgent.logs();
      setLogs(logsData);
      setShowLogs(true);
    } catch {
      showToast("Failed to fetch logs");
    }
  };

  if (!detected || !status) return null;

  const btnClass = "rounded-md px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
  const btnPrimary = `${btnClass} bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)]`;
  const btnSecondary = `${btnClass} border border-zinc-700 text-zinc-300 hover:bg-zinc-800`;
  const btnDanger = `${btnClass} border border-red-800 text-red-400 hover:bg-red-950`;

  return (
    <>
      {/* Toast */}
      {toast && (
        <div className="fixed top-4 right-4 z-50 rounded-md border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-200 shadow-lg">
          {toast}
        </div>
      )}

      <div className="rounded-lg border border-emerald-800/50 bg-emerald-950/20 p-5 space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-medium text-emerald-400">Local Client</h2>
            <p className="text-xs text-zinc-500 font-mono mt-0.5">{status.client_id}</p>
          </div>
        </div>

        {/* Status badges */}
        <div className="flex flex-wrap gap-2">
          <span className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium ${
            status.daemon_running
              ? "bg-emerald-950 text-emerald-400 border border-emerald-800/50"
              : "bg-red-950 text-red-400 border border-red-800/50"
          }`}>
            <span className={`h-1.5 w-1.5 rounded-full ${status.daemon_running ? "bg-emerald-400" : "bg-red-400"}`} />
            {status.daemon_running ? "Daemon Running" : "Daemon Stopped"}
          </span>
          <span className="inline-flex items-center rounded-md bg-zinc-900 px-2.5 py-1 text-xs font-mono text-zinc-400 border border-zinc-800">
            Agent v{status.agent_version}
          </span>
        </div>

        {/* Daemon controls */}
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => runAction(() => localAgent.daemonStart(), "Start")}
            disabled={busy !== null || status.daemon_running}
            className={btnPrimary}
          >
            {busy === "Start" ? "Starting..." : "Start"}
          </button>
          <button
            onClick={() => runAction(() => localAgent.daemonStop(), "Stop")}
            disabled={busy !== null || !status.daemon_running}
            className={btnSecondary}
          >
            {busy === "Stop" ? "Stopping..." : "Stop"}
          </button>
          <button
            onClick={() => runAction(() => localAgent.daemonRestart(), "Restart")}
            disabled={busy !== null}
            className={btnSecondary}
          >
            {busy === "Restart" ? "Restarting..." : "Restart"}
          </button>
          <button
            onClick={handleViewLogs}
            className={btnSecondary}
          >
            View Logs
          </button>
        </div>

        {/* Danger zone */}
        <div className="border-t border-zinc-800 pt-4">
          <p className="text-xs text-zinc-600 mb-2">Danger Zone</p>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => {
                if (!confirm("This will stop and remove the daemon service. Config and logs are preserved. Continue?")) return;
                runAction(() => localAgent.serviceRemove(), "Remove Service");
              }}
              disabled={busy !== null}
              className={btnDanger}
            >
              {busy === "Remove Service" ? "Removing..." : "Remove Service"}
            </button>
            <button
              onClick={handleUninstall}
              disabled={busy !== null}
              className={`${btnClass} bg-red-900 text-red-200 hover:bg-red-800`}
            >
              {busy === "Full Uninstall" ? "Uninstalling..." : "Full Uninstall"}
            </button>
          </div>
        </div>
      </div>

      {/* Logs modal */}
      {showLogs && logs && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowLogs(false)}>
          <div className="w-full max-w-3xl max-h-[80vh] rounded-lg border border-zinc-800 bg-zinc-950 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
              <div>
                <h3 className="text-sm font-medium text-zinc-200">Client Logs</h3>
                <p className="text-xs text-zinc-500 font-mono">{logs.file}</p>
              </div>
              <button onClick={() => setShowLogs(false)} className="text-zinc-500 hover:text-zinc-300">&times;</button>
            </div>
            <div className="overflow-auto max-h-[calc(80vh-60px)] p-4">
              {logs.lines.length > 0 ? (
                <pre className="text-xs font-mono text-zinc-400 whitespace-pre-wrap break-all">
                  {logs.lines.join("\n")}
                </pre>
              ) : (
                <p className="text-sm text-zinc-500">No log entries found for today.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add worker/dashboard/src/components/LocalClientPanel.tsx
git commit -m "feat(dashboard): add LocalClientPanel component for local agent management"
```

---

### Task 10: Integrate LocalClientPanel into Clients page

**Files:**
- Modify: `worker/dashboard/src/pages/Clients.tsx`

- [ ] **Step 1: Import and render the panel**

At the top of `Clients.tsx`, add the import:

```typescript
import { LocalClientPanel } from "@/components/LocalClientPanel";
```

In the `Clients` component's return, add the `LocalClientPanel` right before the existing table section (after the header `div` with buttons, before the `{clients && clients.length > 0 ? (` block):

```tsx
<LocalClientPanel onUninstalled={refresh} />
```

- [ ] **Step 2: Verify dashboard builds**

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/worker && bun run build`
Expected: Builds successfully.

- [ ] **Step 3: Commit**

```bash
git add worker/dashboard/src/pages/Clients.tsx
git commit -m "feat(dashboard): integrate LocalClientPanel into clients page"
```

---

### Task 11: Update install scripts

**Files:**
- Modify: `install.sh`
- Modify: `install.ps1`

- [ ] **Step 1: Update install.sh**

After the existing "Start service" section (after `pingpulse start`), add agent installation:

```bash
# --- Start agent service ---
echo "Starting pingpulse agent..."
if ! pingpulse agent & disown; then
  echo "Warning: Failed to start agent. You can start it manually with 'pingpulse agent'"
fi
```

Actually, the agent should be installed as a proper system service, not run in the background. The existing `pingpulse start` calls `service::install_and_start()`. We need a similar CLI command for the agent service. But the current `agent` subcommand runs the HTTP server directly (foreground).

We need to add agent service installation to the Rust binary. Two options:

**Option A:** Add `--install` flag to the agent subcommand that installs the agent as a service (like `pingpulse start` does for the daemon).

**Option B:** The install script calls `launchctl load` / `systemctl enable` directly.

**Go with Option A** — keep service logic in Rust. Add to `Commands::Agent`:

```rust
Agent {
    #[arg(long, default_value = "9111")]
    port: u16,
    /// Install as a system service instead of running in foreground
    #[arg(long)]
    install: bool,
},
```

And in the match arm:

```rust
Commands::Agent { port, install } => {
    if install {
        let binary = std::env::current_exe()
            .expect("Cannot determine binary path")
            .to_string_lossy()
            .to_string();
        if let Err(e) = service::install_agent(&binary) {
            eprintln!("Agent service install failed: {e}");
            std::process::exit(1);
        }
    } else if let Err(e) = agent::run(port).await {
        eprintln!("Agent error: {e}");
        std::process::exit(1);
    }
}
```

Then update `install.sh` — replace the final section with:

```bash
# --- Start service ---
echo "Starting pingpulse daemon..."
if ! pingpulse start; then
  echo "Error: Failed to start daemon. Try 'pingpulse start --foreground' for details."
  exit 1
fi

# --- Install and start agent service ---
echo "Starting pingpulse management agent..."
if ! pingpulse agent --install; then
  echo "Warning: Failed to install agent service. Local management via dashboard unavailable."
  echo "You can start it manually with: pingpulse agent"
fi
```

- [ ] **Step 2: Update install.ps1**

Add the equivalent after the daemon start:

```powershell
Write-Host "Starting pingpulse management agent..."
try {
    & "$installDir\pingpulse.exe" agent --install
} catch {
    Write-Host "Warning: Failed to install agent service. Local management via dashboard unavailable."
}
```

- [ ] **Step 3: Update main.rs with the --install flag**

As described above in the Agent match arm.

- [ ] **Step 4: Verify full build**

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/client && cargo build`
Expected: Compiles.

- [ ] **Step 5: Commit**

```bash
git add client/src/main.rs install.sh install.ps1
git commit -m "feat: add agent service installation to install scripts and CLI"
```

---

### Task 12: Final integration test

- [ ] **Step 1: Run full Rust test suite**

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/client && cargo test`
Expected: All tests pass.

- [ ] **Step 2: Run clippy**

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/client && cargo clippy -- -D warnings`
Expected: No warnings.

- [ ] **Step 3: Build worker**

Run: `cd /Users/ericbaruch/Arik/dev/pingpulse/worker && bun run build`
Expected: Builds successfully.

- [ ] **Step 4: Manual smoke test (if agent binary available)**

1. Run `pingpulse agent` in a terminal
2. Open browser to `http://localhost:9111/status`
3. Verify JSON response with `daemon_running`, `client_id`, etc.
4. Test CORS by opening your dashboard domain and checking browser console for CORS errors

- [ ] **Step 5: Final commit if any fixes needed**

```bash
git add -A
git commit -m "chore: final cleanup for local agent management feature"
```

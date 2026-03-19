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
        Self {
            ok: true,
            error: None,
            warnings: None,
        }
    }

    fn error(msg: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(msg.into()),
            warnings: None,
        }
    }

    fn with_warnings(mut self, warnings: Vec<String>) -> Self {
        self.warnings = Some(warnings);
        self
    }
}

#[derive(Serialize)]
struct SanitizedConfig {
    server: SanitizedServer,
    ping: crate::config::PingConfig,
    speed_test: crate::config::SpeedTestConfig,
    alerts: crate::config::AlertConfig,
    logging: crate::config::LoggingConfig,
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

#[derive(Serialize)]
struct LogsResponse {
    lines: Vec<String>,
    file: String,
}

async fn get_status(State(state): State<Arc<AppState>>) -> Json<StatusResponse> {
    let daemon_running = tokio::task::spawn_blocking(|| service::status().unwrap_or(false))
        .await
        .unwrap_or(false);
    Json(StatusResponse {
        client_id: state.config.server.client_id.clone(),
        server_url: state.config.server.base_url.clone(),
        daemon_running,
        agent_version: env!("CARGO_PKG_VERSION").into(),
        uptime_s: state.started_at.elapsed().as_secs(),
    })
}

fn resolve_binary_path() -> Result<String, String> {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| format!("Cannot find binary path: {e}"))
}

async fn daemon_start() -> Json<ActionResponse> {
    let binary = match resolve_binary_path() {
        Ok(b) => b,
        Err(e) => return Json(ActionResponse::error(e)),
    };
    match tokio::task::spawn_blocking(move || service::install_and_start(&binary)).await {
        Ok(Ok(())) => Json(ActionResponse::success()),
        Ok(Err(e)) => Json(ActionResponse::error(format!(
            "Failed to start daemon: {e}"
        ))),
        Err(e) => Json(ActionResponse::error(format!("Internal error: {e}"))),
    }
}

async fn daemon_stop() -> Json<ActionResponse> {
    match tokio::task::spawn_blocking(service::stop).await {
        Ok(Ok(())) => Json(ActionResponse::success()),
        Ok(Err(e)) => Json(ActionResponse::error(format!("Failed to stop daemon: {e}"))),
        Err(e) => Json(ActionResponse::error(format!("Internal error: {e}"))),
    }
}

async fn daemon_restart() -> Json<ActionResponse> {
    let _ = tokio::task::spawn_blocking(service::stop).await;
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    daemon_start().await
}

async fn get_config(State(state): State<Arc<AppState>>) -> Json<SanitizedConfig> {
    Json(sanitize_config(&state.config))
}

async fn get_logs() -> Json<LogsResponse> {
    let logs_dir = Config::logs_dir();
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let log_file = logs_dir.join(format!("{today}.jsonl"));
    let file_name = log_file.display().to_string();

    let log_file_clone = log_file.clone();
    let lines = tokio::task::spawn_blocking(move || read_tail_lines(&log_file_clone, 100))
        .await
        .unwrap_or_default();

    Json(LogsResponse {
        lines,
        file: file_name,
    })
}

/// Read the last `n` lines from a file efficiently by reading backward from EOF.
fn read_tail_lines(path: &std::path::Path, n: usize) -> Vec<String> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return vec![],
    };
    let len = match file.metadata() {
        Ok(m) => m.len(),
        Err(_) => return vec![],
    };
    if len == 0 {
        return vec![];
    }

    // Read up to 64KB from the end — should be plenty for 100 JSONL lines
    let read_size = len.min(64 * 1024) as usize;
    let offset = len - read_size as u64;
    file.seek(SeekFrom::Start(offset)).ok();
    let mut buf = vec![0u8; read_size];
    let bytes_read = match file.read(&mut buf) {
        Ok(n) => n,
        Err(_) => return vec![],
    };
    buf.truncate(bytes_read);

    let content = String::from_utf8_lossy(&buf);
    let mut lines: Vec<String> = content.lines().map(String::from).collect();

    // If we didn't read from the start, the first line is likely partial — drop it
    if offset > 0 && !lines.is_empty() {
        lines.remove(0);
    }

    // Take the last n lines
    if lines.len() > n {
        lines.drain(..lines.len() - n);
    }
    lines
}

async fn service_remove() -> Json<ActionResponse> {
    daemon_stop().await
}

async fn service_uninstall(State(state): State<Arc<AppState>>) -> Json<ActionResponse> {
    let mut warnings = Vec::new();

    // Try to delete server record first (needs config which self_remove deletes)
    let client = reqwest::Client::new();
    let url = format!(
        "{}/api/clients/{}/self",
        state.config.server.base_url, state.config.server.client_id
    );
    match client
        .delete(&url)
        .header(
            "Authorization",
            format!("Bearer {}", state.config.server.client_secret),
        )
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
            warnings.push(format!(
                "Server record not deleted — server unreachable: {e}"
            ));
        }
    }

    // Schedule delayed self-removal and exit
    tokio::spawn(async {
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        if let Err(e) = service::self_remove() {
            eprintln!("Warning: self-remove failed: {e}");
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

fn build_cors(server_url: &str) -> CorsLayer {
    let origin = server_url
        .parse::<HeaderValue>()
        .unwrap_or_else(|_| HeaderValue::from_static("http://localhost:8787"));

    CorsLayer::new()
        .allow_origin(origin)
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers(tower_http::cors::Any)
}

pub async fn run(port: u16, config: Option<Config>) -> Result<()> {
    let config = match config {
        Some(c) => c,
        None => Config::load().await?,
    };
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let cors = build_cors(&config.server.base_url);

    let state = Arc::new(AppState {
        config,
        started_at: Instant::now(),
    });

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
        let resp = StatusResponse {
            client_id: "abc123".into(),
            server_url: "https://ping.beric.ca".into(),
            daemon_running: true,
            agent_version: "0.1.0".into(),
            uptime_s: 42,
        };
        let json = serde_json::to_string(&resp).unwrap();
        assert!(json.contains("\"client_id\":\"abc123\""));
        assert!(json.contains("\"daemon_running\":true"));
        assert!(json.contains("\"uptime_s\":42"));
        assert!(json.contains("\"agent_version\":\"0.1.0\""));
    }

    #[test]
    fn test_action_response_success() {
        let resp = ActionResponse::success();
        assert!(resp.ok);
        assert!(resp.error.is_none());
        assert!(resp.warnings.is_none());
    }

    #[test]
    fn test_action_response_error() {
        let resp = ActionResponse::error("something went wrong");
        assert!(!resp.ok);
        assert_eq!(resp.error.as_deref(), Some("something went wrong"));
        assert!(resp.warnings.is_none());
    }

    #[test]
    fn test_action_response_with_warnings() {
        let resp = ActionResponse::success().with_warnings(vec!["warn".into()]);
        assert!(resp.ok);
        assert!(resp.error.is_none());
        let warnings = resp.warnings.unwrap();
        assert_eq!(warnings, vec!["warn"]);
    }

    #[test]
    fn test_config_sanitization() {
        let config = Config {
            server: crate::config::ServerConfig {
                base_url: "https://ping.beric.ca".into(),
                ws_url: "/ws/abc".into(),
                client_id: "abc123".into(),
                client_secret: "super-secret-value".into(),
            },
            ping: crate::config::PingConfig {
                interval_s: 30,
                grace_period_s: 60,
            },
            speed_test: crate::config::SpeedTestConfig {
                probe_size_bytes: 262144,
                full_test_payload_bytes: 10485760,
                full_test_schedule: "0 */6 * * *".into(),
            },
            alerts: crate::config::AlertConfig {
                latency_threshold_ms: 100.0,
                loss_threshold_pct: 5.0,
            },
            logging: crate::config::LoggingConfig {
                level: "info".into(),
                retention_days: 30,
            },
        };
        let sanitized = sanitize_config(&config);
        let json = serde_json::to_string(&sanitized).unwrap();
        assert!(!json.contains("super-secret-value"));
        assert!(json.contains("abc123"));
        assert!(json.contains("REDACTED"));
    }
}

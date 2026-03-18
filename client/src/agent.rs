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
    let daemon_running = service::status().unwrap_or(false);
    Json(StatusResponse {
        client_id: state.config.server.client_id.clone(),
        client_name: String::new(),
        location: String::new(),
        server_url: state.config.server.base_url.clone(),
        daemon_running,
        agent_version: env!("CARGO_PKG_VERSION").into(),
        uptime_s: state.started_at.elapsed().as_secs(),
    })
}

async fn daemon_start() -> Json<ActionResponse> {
    let binary = match std::env::current_exe() {
        Ok(p) => p.to_string_lossy().to_string(),
        Err(e) => return Json(ActionResponse::error(format!("Cannot find binary path: {e}"))),
    };
    match service::install_and_start(&binary) {
        Ok(()) => Json(ActionResponse::success()),
        Err(e) => Json(ActionResponse::error(format!("Failed to start daemon: {e}"))),
    }
}

async fn daemon_stop() -> Json<ActionResponse> {
    match service::stop() {
        Ok(()) => Json(ActionResponse::success()),
        Err(e) => Json(ActionResponse::error(format!("Failed to stop daemon: {e}"))),
    }
}

async fn daemon_restart() -> Json<ActionResponse> {
    let _ = service::stop();
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

async fn get_config(State(state): State<Arc<AppState>>) -> Json<SanitizedConfig> {
    Json(sanitize_config(&state.config))
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

async fn service_remove() -> Json<ActionResponse> {
    match service::stop() {
        Ok(()) => Json(ActionResponse::success()),
        Err(e) => Json(ActionResponse::error(format!("Failed to remove daemon service: {e}"))),
    }
}

async fn service_uninstall(State(state): State<Arc<AppState>>) -> Json<ActionResponse> {
    let mut warnings = Vec::new();

    // Stop daemon
    let _ = service::stop();

    // Try to delete server record
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
            warnings.push(format!("Server record not deleted — server returned {}", resp.status()));
        }
        Err(e) => {
            warnings.push(format!("Server record not deleted — server unreachable: {e}"));
        }
    }

    // Schedule delayed self-cleanup
    tokio::spawn(async {
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        if let Err(e) = service::stop_agent() {
            eprintln!("Warning: failed to remove agent service: {e}");
        }
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
            client_name: String::new(),
            location: String::new(),
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
}

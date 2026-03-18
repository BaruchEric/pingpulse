use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Instant;

use anyhow::Result;
use axum::extract::State;
use axum::http::{HeaderValue, Method};
use axum::routing::get;
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
#[allow(dead_code)]
struct ActionResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    warnings: Option<Vec<String>>,
}

#[allow(dead_code)]
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
        client_name: String::new(),
        location: String::new(),
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
}

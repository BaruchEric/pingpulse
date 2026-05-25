use serde::{Deserialize, Serialize};

use crate::config::RemoteConfig;

// --- Speed test types ---

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SpeedTestType {
    Probe,
    Full,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SpeedTestTarget {
    #[default]
    Worker,
    Edge,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpeedTestResult {
    pub client_id: String,
    pub timestamp: String,
    #[serde(rename = "type")]
    pub test_type: SpeedTestType,
    #[serde(default)]
    pub target: SpeedTestTarget,
    pub download_mbps: f64,
    pub upload_mbps: f64,
    pub payload_bytes: u64,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum LogLevel {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub struct ServerLogEntry {
    pub ts: String,
    pub level: LogLevel,
    pub event: String,
    pub detail: Option<String>,
}

// --- Heartbeat protocol (HTTP) ---
//
// The client POSTs a Heartbeat every ping interval and receives a
// HeartbeatResponse carrying the current config, queued admin commands, the
// latest available client version, and recent server-side log entries. This
// replaces the former WebSocket ping/pong + config_update + command push.

#[derive(Debug, Serialize)]
pub struct Heartbeat {
    /// Round-trip latency the client measured for the previous heartbeat (ms).
    pub rtt_ms: Option<f64>,
    pub jitter_ms: Option<f64>,
    pub status: Option<String>,
    pub client_version: String,
    pub timezone: Option<String>,
    pub include_logs: bool,
}

// Server-applied state, surfaced for completeness/forward-compat. The client
// does not act on these directly (the server applies pause/simulation).
#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub struct Simulation {
    #[serde(default)]
    pub latency_ms: f64,
    #[serde(default)]
    pub loss_pct: f64,
}

#[derive(Debug, Deserialize)]
pub struct Command {
    pub command: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct HeartbeatResponse {
    pub config: RemoteConfig,
    #[serde(default)]
    pub paused: bool,
    #[serde(default)]
    pub simulation: Option<Simulation>,
    #[serde(default)]
    pub latest_version: String,
    #[serde(default)]
    pub commands: Vec<Command>,
    #[serde(default)]
    pub server_logs: Vec<ServerLogEntry>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_serialize_heartbeat() {
        let hb = Heartbeat {
            rtt_ms: Some(12.5),
            jitter_ms: None,
            status: Some("ok".into()),
            client_version: "1.0.5".into(),
            timezone: None,
            include_logs: false,
        };
        let json = serde_json::to_string(&hb).unwrap();
        assert!(json.contains(r#""rtt_ms":12.5"#));
        assert!(json.contains(r#""status":"ok""#));
    }

    #[test]
    fn test_deserialize_heartbeat_response() {
        let json = r#"{
            "config":{"ping_interval_s":15,"speed_test_interval_s":180,"probe_size_bytes":131072,"full_test_payload_bytes":5242880,"full_test_schedule":"0 */3 * * *","alert_latency_threshold_ms":50.0,"alert_loss_threshold_pct":2.5,"grace_period_s":120},
            "paused":false,
            "simulation":{"latency_ms":0,"loss_pct":0},
            "latest_version":"1.0.6",
            "commands":[{"command":"speed_test","params":{"test_type":"full","target":"edge"}}],
            "server_logs":[]
        }"#;
        let resp: HeartbeatResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.config.ping_interval_s, 15);
        assert_eq!(resp.latest_version, "1.0.6");
        assert_eq!(resp.commands.len(), 1);
        assert_eq!(resp.commands[0].command, "speed_test");
    }

    #[test]
    fn test_deserialize_speed_test_command_params() {
        let cmd = Command {
            command: "speed_test".into(),
            params: serde_json::json!({ "test_type": "probe", "target": "worker" }),
        };
        assert_eq!(cmd.params["test_type"], "probe");
        assert_eq!(cmd.params["target"], "worker");
    }

    #[test]
    fn test_serialize_speed_test_result() {
        let result = SpeedTestResult {
            client_id: "abc123".into(),
            timestamp: "2026-03-17T12:00:00Z".into(),
            test_type: SpeedTestType::Probe,
            target: SpeedTestTarget::Worker,
            download_mbps: 95.2,
            upload_mbps: 42.1,
            payload_bytes: 262_144,
            duration_ms: 350,
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains(r#""download_mbps":95.2"#));
        assert!(json.contains(r#""type":"probe""#));
        assert!(json.contains(r#""target":"worker""#));
    }
}

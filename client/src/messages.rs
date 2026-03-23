use serde::{Deserialize, Serialize};

use crate::config::RemoteConfig;

// --- Speed test types ---

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SpeedTestType {
    Probe,
    Full,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SpeedTestTarget {
    Worker,
    Edge,
}

impl Default for SpeedTestTarget {
    fn default() -> Self {
        Self::Worker
    }
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

// --- Incoming messages (from server) ---

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[allow(dead_code)] // fields populated by serde deserialization
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
        #[serde(default)]
        target: SpeedTestTarget,
    },
    Deregistered {
        reason: String,
    },
    ServerLogs {
        entries: Vec<ServerLogEntry>,
    },
    SelfUpdate {
        version: String,
        repo: String,
    },
}

// --- Outgoing messages (to server) ---

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OutgoingMessage {
    Pong { id: String, ts: u64, client_ts: u64 },
    Ping { id: String, ts: u64 },
    SpeedTestResult { result: SpeedTestResult },
    ProbeResult {
        session_id: String,
        record: crate::store::ProbeRecord,
    },
    Error { message: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_deserialize_ping_from_server() {
        let json = r#"{"type":"ping","id":"abc-123","ts":1710700000000}"#;
        let msg: IncomingMessage = serde_json::from_str(json).unwrap();
        match msg {
            IncomingMessage::Ping { id, ts, .. } => {
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
            IncomingMessage::StartSpeedTest { test_type, target } => {
                assert_eq!(test_type, SpeedTestType::Full);
                assert_eq!(target, SpeedTestTarget::Worker); // default
            }
            _ => panic!("Expected StartSpeedTest"),
        }
    }

    #[test]
    fn test_deserialize_start_speed_test_edge() {
        let json = r#"{"type":"start_speed_test","test_type":"probe","target":"edge"}"#;
        let msg: IncomingMessage = serde_json::from_str(json).unwrap();
        match msg {
            IncomingMessage::StartSpeedTest { test_type, target } => {
                assert_eq!(test_type, SpeedTestType::Probe);
                assert_eq!(target, SpeedTestTarget::Edge);
            }
            _ => panic!("Expected StartSpeedTest"),
        }
    }

    #[test]
    fn test_deserialize_deregistered() {
        let json = r#"{"type":"deregistered","reason":"Client deleted by admin"}"#;
        let msg: IncomingMessage = serde_json::from_str(json).unwrap();
        match msg {
            IncomingMessage::Deregistered { reason } => {
                assert_eq!(reason, "Client deleted by admin");
            }
            _ => panic!("Expected Deregistered"),
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
    fn test_serialize_probe_result() {
        let msg = OutgoingMessage::ProbeResult {
            session_id: "sess-123".into(),
            record: crate::store::ProbeRecord {
                seq_id: 42,
                probe_type: "icmp".into(),
                target: "8.8.8.8".into(),
                timestamp: 1710700000000,
                rtt_ms: Some(12.5),
                status_code: None,
                status: "ok".into(),
                jitter_ms: None,
            },
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""type":"probe_result""#));
        assert!(json.contains(r#""session_id":"sess-123""#));
        assert!(json.contains(r#""seq_id":42"#));
    }

    #[test]
    fn test_serialize_speed_test_result() {
        let msg = OutgoingMessage::SpeedTestResult {
            result: SpeedTestResult {
                client_id: "abc123".into(),
                timestamp: "2026-03-17T12:00:00Z".into(),
                test_type: SpeedTestType::Probe,
                target: SpeedTestTarget::Worker,
                download_mbps: 95.2,
                upload_mbps: 42.1,
                payload_bytes: 262_144,
                duration_ms: 350,
            },
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""type":"speed_test_result""#));
        assert!(json.contains(r#""download_mbps":95.2"#));
        assert!(json.contains(r#""type":"probe""#));
        assert!(json.contains(r#""target":"worker""#));
    }

    #[test]
    fn test_serialize_speed_test_result_edge() {
        let msg = OutgoingMessage::SpeedTestResult {
            result: SpeedTestResult {
                client_id: "abc123".into(),
                timestamp: "2026-03-17T12:00:00Z".into(),
                test_type: SpeedTestType::Full,
                target: SpeedTestTarget::Edge,
                download_mbps: 200.5,
                upload_mbps: 85.3,
                payload_bytes: 10_485_760,
                duration_ms: 1200,
            },
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""target":"edge""#));
        assert!(json.contains(r#""type":"full""#));
    }
}

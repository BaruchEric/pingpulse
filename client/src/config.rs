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
    #[serde(default = "default_speed_test_interval")]
    pub interval_s: u32,
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
    #[serde(default = "default_speed_test_interval")]
    pub speed_test_interval_s: u32,
    pub probe_size_bytes: u64,
    pub full_test_payload_bytes: u64,
    pub full_test_schedule: String,
    pub alert_latency_threshold_ms: f64,
    pub alert_loss_threshold_pct: f64,
    pub grace_period_s: u32,
}

fn default_speed_test_interval() -> u32 {
    300
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

    pub fn apply_remote(&mut self, remote: &RemoteConfig) {
        self.ping.interval_s = remote.ping_interval_s;
        self.ping.grace_period_s = remote.grace_period_s;
        self.speed_test.interval_s = remote.speed_test_interval_s;
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
            server: ServerConfig {
                base_url,
                ws_url,
                client_id,
                client_secret,
            },
            ping: PingConfig {
                interval_s: 30,
                grace_period_s: 60,
            },
            speed_test: SpeedTestConfig {
                interval_s: 300,
                probe_size_bytes: 262144,
                full_test_payload_bytes: 10_485_760,
                full_test_schedule: "0 */6 * * *".into(),
            },
            alerts: AlertConfig {
                latency_threshold_ms: 100.0,
                loss_threshold_pct: 5.0,
            },
            logging: LoggingConfig {
                level: "info".into(),
                retention_days: 30,
            },
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
            ping: PingConfig {
                interval_s: 30,
                grace_period_s: 60,
            },
            speed_test: SpeedTestConfig {
                interval_s: 300,
                probe_size_bytes: 262144,
                full_test_payload_bytes: 10485760,
                full_test_schedule: "0 */6 * * *".into(),
            },
            alerts: AlertConfig {
                latency_threshold_ms: 100.0,
                loss_threshold_pct: 5.0,
            },
            logging: LoggingConfig {
                level: "info".into(),
                retention_days: 30,
            },
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
            ping: PingConfig {
                interval_s: 30,
                grace_period_s: 60,
            },
            speed_test: SpeedTestConfig {
                interval_s: 300,
                probe_size_bytes: 262144,
                full_test_payload_bytes: 10485760,
                full_test_schedule: "0 */6 * * *".into(),
            },
            alerts: AlertConfig {
                latency_threshold_ms: 100.0,
                loss_threshold_pct: 5.0,
            },
            logging: LoggingConfig {
                level: "info".into(),
                retention_days: 30,
            },
        };

        let remote = RemoteConfig {
            ping_interval_s: 15,
            speed_test_interval_s: 180,
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

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub server: ServerConfig,
    pub ping: PingConfig,
    pub speed_test: SpeedTestConfig,
    pub alerts: AlertConfig,
    pub logging: LoggingConfig,
    #[serde(default)]
    pub probes: ProbesConfig,
    #[serde(default)]
    pub storage: StorageConfig,
    #[serde(default)]
    pub sync: SyncConfig,
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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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

impl Default for StorageConfig {
    fn default() -> Self {
        Self {
            db_path: default_storage_db_path(),
            retention_days: default_storage_retention_days(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncConfig {
    #[serde(default = "default_sync_batch_size")]
    pub batch_size: usize,
    #[serde(default = "default_sync_interval")]
    pub interval_s: u32,
}

impl Default for SyncConfig {
    fn default() -> Self {
        Self {
            batch_size: default_sync_batch_size(),
            interval_s: default_sync_interval(),
        }
    }
}

/// Remote config pushed by server via WebSocket `config_update` message.
/// Maps to backend `ClientConfig` (all 7 fields).
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
}

fn default_speed_test_interval() -> u32 {
    300
}

fn default_probe_icmp_enabled() -> bool {
    true
}
fn default_probe_icmp_interval() -> u32 {
    5
}
fn default_probe_icmp_targets() -> Vec<String> {
    vec!["8.8.8.8".into(), "1.1.1.1".into(), "9.9.9.9".into()]
}
fn default_probe_icmp_timeout() -> u64 {
    3000
}
fn default_probe_http_enabled() -> bool {
    true
}
fn default_probe_http_interval() -> u32 {
    15
}
fn default_probe_http_targets() -> Vec<String> {
    vec![
        "https://www.google.com".into(),
        "https://cloudflare.com".into(),
    ]
}
fn default_probe_http_timeout() -> u64 {
    5000
}
fn default_storage_db_path() -> String {
    "~/.pingpulse/probes.db".into()
}
fn default_storage_retention_days() -> u32 {
    7
}
fn default_sync_batch_size() -> usize {
    500
}
fn default_sync_interval() -> u32 {
    60
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

    #[allow(dead_code)]
    pub fn resolved_db_path(&self) -> std::path::PathBuf {
        let path = self
            .storage
            .db_path
            .replace('~', &dirs::home_dir().unwrap().to_string_lossy());
        std::path::PathBuf::from(path)
    }

    pub fn apply_remote(&mut self, remote: &RemoteConfig) {
        self.ping.interval_s = remote.ping_interval_s;
        self.ping.grace_period_s = remote.grace_period_s;
        self.speed_test.interval_s = remote.speed_test_interval_s;
        self.speed_test.probe_size_bytes = remote.probe_size_bytes;
        self.speed_test.full_test_payload_bytes = remote.full_test_payload_bytes;
        self.speed_test.full_test_schedule.clone_from(&remote.full_test_schedule);
        self.alerts.latency_threshold_ms = remote.alert_latency_threshold_ms;
        self.alerts.loss_threshold_pct = remote.alert_loss_threshold_pct;
        if let Some(v) = remote.probe_icmp_interval_s {
            self.probes.icmp.interval_s = v;
        }
        if let Some(v) = &remote.probe_icmp_targets {
            self.probes.icmp.targets.clone_from(v);
        }
        if let Some(v) = remote.probe_icmp_timeout_ms {
            self.probes.icmp.timeout_ms = v;
        }
        if let Some(v) = remote.probe_http_interval_s {
            self.probes.http.interval_s = v;
        }
        if let Some(v) = &remote.probe_http_targets {
            self.probes.http.targets.clone_from(v);
        }
        if let Some(v) = remote.probe_http_timeout_ms {
            self.probes.http.timeout_ms = v;
        }
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
                probe_size_bytes: 262_144,
                full_test_payload_bytes: 52_428_800,
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
            probes: ProbesConfig::default(),
            storage: StorageConfig::default(),
            sync: SyncConfig::default(),
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
                probe_size_bytes: 262_144,
                full_test_payload_bytes: 52_428_800,
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
            probes: ProbesConfig::default(),
            storage: StorageConfig::default(),
            sync: SyncConfig::default(),
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
                probe_size_bytes: 262_144,
                full_test_payload_bytes: 52_428_800,
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
            probes: ProbesConfig::default(),
            storage: StorageConfig::default(),
            sync: SyncConfig::default(),
        };

        let remote = RemoteConfig {
            ping_interval_s: 15,
            speed_test_interval_s: 180,
            probe_size_bytes: 131_072,
            full_test_payload_bytes: 5_242_880,
            full_test_schedule: "0 */3 * * *".into(),
            alert_latency_threshold_ms: 50.0,
            alert_loss_threshold_pct: 2.5,
            grace_period_s: 120,
            probe_icmp_interval_s: Some(10),
            probe_icmp_targets: None,
            probe_icmp_timeout_ms: None,
            probe_http_interval_s: Some(30),
            probe_http_targets: Some(vec!["https://example.com".into()]),
            probe_http_timeout_ms: None,
        };

        config.apply_remote(&remote);

        assert_eq!(config.ping.interval_s, 15);
        assert_eq!(config.ping.grace_period_s, 120);
        assert_eq!(config.speed_test.probe_size_bytes, 131_072);
        assert_eq!(config.alerts.latency_threshold_ms, 50.0);
        // Server config should NOT change
        assert_eq!(config.server.client_id, "abc");
        // Probe overrides should apply
        assert_eq!(config.probes.icmp.interval_s, 10);
        assert_eq!(config.probes.icmp.targets, default_probe_icmp_targets()); // None = no override
        assert_eq!(config.probes.http.interval_s, 30);
        assert_eq!(config.probes.http.targets, vec!["https://example.com"]);
    }
}

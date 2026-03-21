export interface ClientConfig {
  ping_interval_s: number;
  speed_test_interval_s: number;
  probe_size_bytes: number;
  full_test_schedule: string;
  full_test_payload_bytes: number;
  alert_latency_threshold_ms: number;
  alert_loss_threshold_pct: number;
  grace_period_s: number;
  notifications_enabled: boolean;
}

export const DEFAULT_CLIENT_CONFIG: ClientConfig = {
  ping_interval_s: 30,
  speed_test_interval_s: 300,
  probe_size_bytes: 256 * 1024,
  full_test_schedule: "0 */6 * * *",
  full_test_payload_bytes: 10 * 1024 * 1024,
  alert_latency_threshold_ms: 100,
  alert_loss_threshold_pct: 5,
  grace_period_s: 60,
  notifications_enabled: true,
};

export interface PingResult {
  client_id: string;
  timestamp: string;
  rtt_ms: number;
  jitter_ms: number;
  direction: "cf_to_client" | "client_to_cf";
  status: "ok" | "timeout" | "error";
}

export interface SpeedTestResult {
  client_id: string;
  timestamp: string;
  type: "probe" | "full";
  download_mbps: number;
  upload_mbps: number;
  payload_bytes: number;
  duration_ms: number;
}

export type AlertType =
  | "client_down"
  | "client_up"
  | "high_latency"
  | "packet_loss"
  | "speed_degradation"
  | "latency_recovered";

export type AlertSeverity = "critical" | "warning" | "info";

export interface AlertRecord {
  client_id: string;
  type: AlertType;
  severity: AlertSeverity;
  value: number;
  threshold: number;
  timestamp: string;
}

export interface ClientRecord {
  id: string;
  name: string;
  location: string;
  secret_hash: string;
  config_json: string;
  created_at: string;
  last_seen: string;
  client_version: string;
}

export interface JwtPayload {
  sub: string;
  iat: number;
  exp: number;
}

export interface ServerLogEntry {
  ts: string;
  level: "info" | "warning" | "error";
  event: string;
  detail?: string;
}

export type WSMessage =
  | { type: "ping"; id: string; ts: number; payload?: ArrayBuffer }
  | { type: "pong"; id: string; ts: number; client_ts: number }
  | { type: "config_update"; config: ClientConfig }
  | { type: "start_speed_test"; test_type: "probe" | "full" }
  | { type: "speed_test_result"; result: SpeedTestResult }
  | { type: "error"; message: string }
  | { type: "deregistered"; reason: string }
  | { type: "server_logs"; entries: ServerLogEntry[] }
  | { type: "update_available"; latest_version: string; download_url: string };

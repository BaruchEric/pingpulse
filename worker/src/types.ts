export interface ProbeRecord {
  seq_id: number;
  probe_type: "icmp" | "http";
  target: string;
  timestamp: number;
  rtt_ms: number | null;
  status_code: number | null;
  status: "ok" | "timeout" | "error";
  jitter_ms: number | null;
}

export interface SyncBatch {
  session_id: string;
  records: ProbeRecord[];
}

export interface SyncResponse {
  acked_seq: number;
  throttle_ms?: number;
}

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

  // Probe config (pushed to client)
  probe_icmp_interval_s?: number;
  probe_icmp_targets?: string[];
  probe_icmp_timeout_ms?: number;
  probe_http_interval_s?: number;
  probe_http_targets?: string[];
  probe_http_timeout_ms?: number;

  // Retention policy
  retention_raw_days: number;
  retention_aggregated_days: number;
  retention_archive_to_r2: boolean;

  // Down alert config
  down_alert_grace_seconds: number;
  down_alert_channels: string[];
  down_alert_escalation_enabled: boolean;
  down_alert_escalate_after_seconds: number;
  down_alert_escalate_channels: string[];
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
  retention_raw_days: 30,
  retention_aggregated_days: 90,
  retention_archive_to_r2: true,
  down_alert_grace_seconds: 60,
  down_alert_channels: ["telegram"],
  down_alert_escalation_enabled: false,
  down_alert_escalate_after_seconds: 600,
  down_alert_escalate_channels: ["email"],
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
  | { type: "update_available"; latest_version: string; download_url: string }
  | { type: "probe_result"; session_id: string; record: ProbeRecord }
  | { type: "self_update"; version: string; repo: string };

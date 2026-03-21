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

  // Probe config
  probe_icmp_interval_s?: number;
  probe_icmp_targets?: string[];
  probe_icmp_timeout_ms?: number;
  probe_http_interval_s?: number;
  probe_http_targets?: string[];
  probe_http_timeout_ms?: number;

  // Retention
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

export interface ClientStats {
  avg_rtt_ms: number | null;
  loss_pct: number | null;
  last_speed_test: {
    download_mbps: number;
    upload_mbps: number;
    timestamp: string;
  } | null;
}

export interface Client {
  id: string;
  name: string;
  location: string;
  client_version: string;
  config: ClientConfig;
  created_at: string;
  last_seen: string;
  stats?: ClientStats;
}

export interface PingResult {
  timestamp: string;
  rtt_ms: number;
  jitter_ms: number;
  direction: "cf_to_client" | "client_to_cf";
  status: "ok" | "timeout" | "error";
}

export interface SpeedTest {
  timestamp: string;
  type: "probe" | "full";
  download_mbps: number;
  upload_mbps: number;
  payload_bytes: number;
  duration_ms: number;
}

export interface Outage {
  start_ts: string;
  end_ts: string | null;
  duration_s: number | null;
}

export interface MetricsSummary {
  total_pings: number;
  ok_pings: number;
  timeout_pings: number;
  loss_pct: number;
  avg_rtt_ms: number;
  min_rtt_ms: number;
  max_rtt_ms: number;
  p50_rtt_ms: number;
  p95_rtt_ms: number;
  p99_rtt_ms: number;
}

export interface MetricsResponse {
  pings: PingResult[];
  speed_tests: SpeedTest[];
  outages: Outage[];
  summary: MetricsSummary;
}

export type AlertType =
  | "client_down"
  | "client_up"
  | "high_latency"
  | "packet_loss"
  | "speed_degradation"
  | "latency_recovered";

export type AlertSeverity = "critical" | "warning" | "info";

export interface Alert {
  id: string;
  client_id: string;
  type: AlertType;
  severity: AlertSeverity;
  value: number;
  threshold: number;
  timestamp: string;
}

import type { Infer } from "convex/values";
import { clientConfigValidator } from "../schema";

export type ClientConfig = Infer<typeof clientConfigValidator>;

export const DEFAULT_CLIENT_CONFIG: ClientConfig = {
  ping_interval_s: 30,
  speed_test_interval_s: 300,
  probe_size_bytes: 256 * 1024,
  full_test_schedule: "0 */6 * * *",
  full_test_payload_bytes: 50 * 1024 * 1024,
  alert_latency_threshold_ms: 100,
  alert_loss_threshold_pct: 5,
  grace_period_s: 60,
  notifications_enabled: true,
  retention_raw_days: 30,
  retention_aggregated_days: 90,
  retention_archive_to_r2: true,
  timezone: "UTC",
  down_alert_grace_seconds: 30,
  down_alert_channels: ["telegram"],
  down_alert_escalation_enabled: false,
  down_alert_escalate_after_seconds: 600,
  down_alert_escalate_channels: ["email"],
  report_schedule: "daily",
  report_channels: ["telegram", "email"],
  telegram_notification_sound: {
    client_down: "default",
    client_up: "silent",
    high_latency: "default",
    packet_loss: "default",
    speed_degradation: "silent",
    latency_recovered: "silent",
  },
  telegram_notification_enabled: {
    client_down: true,
    client_up: true,
    high_latency: true,
    packet_loss: true,
    speed_degradation: true,
    latency_recovered: true,
  },
};

/** Merge a partial (possibly stored) config onto the defaults. */
export function withDefaults(partial: Partial<ClientConfig> | undefined): ClientConfig {
  return { ...DEFAULT_CLIENT_CONFIG, ...(partial ?? {}) };
}

// Config keys an admin is allowed to push to a client. Mirrors the allow-list
// the Durable Object enforced before broadcasting config_update.
export const ALLOWED_CONFIG_KEYS: (keyof ClientConfig)[] = [
  "ping_interval_s",
  "speed_test_interval_s",
  "probe_size_bytes",
  "full_test_schedule",
  "full_test_payload_bytes",
  "alert_latency_threshold_ms",
  "alert_loss_threshold_pct",
  "grace_period_s",
  "notifications_enabled",
  "probe_icmp_interval_s",
  "probe_icmp_targets",
  "probe_icmp_timeout_ms",
  "probe_http_interval_s",
  "probe_http_targets",
  "probe_http_timeout_ms",
  "retention_raw_days",
  "retention_aggregated_days",
  "retention_archive_to_r2",
  "down_alert_grace_seconds",
  "down_alert_channels",
  "down_alert_escalation_enabled",
  "down_alert_escalate_after_seconds",
  "down_alert_escalate_channels",
  "report_schedule",
  "report_channels",
  "telegram_notification_sound",
  "telegram_notification_enabled",
  "timezone",
];

export function pickAllowedConfig(
  input: Record<string, unknown>,
): Partial<ClientConfig> {
  const out: Record<string, unknown> = {};
  for (const key of ALLOWED_CONFIG_KEYS) {
    if (key in input) out[key] = input[key];
  }
  return out as Partial<ClientConfig>;
}

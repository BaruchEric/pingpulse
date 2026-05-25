import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Client-tunable configuration. Mirrors the former D1 `config_json` blob, but
// stored as a structured object now that we're on a document database.
export const clientConfigValidator = v.object({
  ping_interval_s: v.number(),
  speed_test_interval_s: v.number(),
  probe_size_bytes: v.number(),
  full_test_schedule: v.string(),
  full_test_payload_bytes: v.number(),
  alert_latency_threshold_ms: v.number(),
  alert_loss_threshold_pct: v.number(),
  grace_period_s: v.number(),
  notifications_enabled: v.boolean(),

  probe_icmp_interval_s: v.optional(v.number()),
  probe_icmp_targets: v.optional(v.array(v.string())),
  probe_icmp_timeout_ms: v.optional(v.number()),
  probe_http_interval_s: v.optional(v.number()),
  probe_http_targets: v.optional(v.array(v.string())),
  probe_http_timeout_ms: v.optional(v.number()),

  retention_raw_days: v.number(),
  retention_aggregated_days: v.number(),
  retention_archive_to_r2: v.boolean(),

  down_alert_grace_seconds: v.number(),
  down_alert_channels: v.array(v.string()),
  down_alert_escalation_enabled: v.boolean(),
  down_alert_escalate_after_seconds: v.number(),
  down_alert_escalate_channels: v.array(v.string()),

  report_schedule: v.union(
    v.literal("daily"),
    v.literal("6h"),
    v.literal("weekly"),
    v.literal("off"),
  ),
  report_channels: v.array(v.union(v.literal("telegram"), v.literal("email"))),

  timezone: v.string(),

  telegram_notification_sound: v.record(
    v.string(),
    v.union(v.literal("default"), v.literal("silent")),
  ),
  telegram_notification_enabled: v.record(v.string(), v.boolean()),
});

export default defineSchema({
  clients: defineTable({
    clientId: v.string(),
    name: v.string(),
    location: v.string(),
    secretHash: v.string(),
    config: clientConfigValidator,
    createdAt: v.string(),
    lastSeen: v.string(),
    clientVersion: v.string(),

    // Runtime monitor state (formerly held in the Durable Object).
    paused: v.boolean(),
    simulationLatencyMs: v.number(),
    simulationLossPct: v.number(),
    // Epoch millis of the moment we first noticed the client missing, or null.
    disconnectedAt: v.union(v.number(), v.null()),
    // Outage row currently open for this client (after grace expired), or null.
    currentOutageId: v.union(v.id("outages"), v.null()),
    // When set and in the future (epoch millis), heartbeats are rejected so an
    // admin-triggered disconnect can run its grace window.
    adminDisconnectUntil: v.union(v.number(), v.null()),
  })
    .index("by_clientId", ["clientId"])
    .index("by_lastSeen", ["lastSeen"]),

  registrationTokens: defineTable({
    tokenHash: v.string(),
    createdAt: v.string(),
    expiresAt: v.string(),
    usedAt: v.union(v.string(), v.null()),
    usedByClientId: v.union(v.string(), v.null()),
  }).index("by_tokenHash", ["tokenHash"]),

  admin: defineTable({
    passwordHash: v.string(),
    createdAt: v.string(),
  }),

  pingResults: defineTable({
    clientId: v.string(),
    timestamp: v.string(),
    rttMs: v.number(),
    jitterMs: v.number(),
    direction: v.union(v.literal("cf_to_client"), v.literal("client_to_cf")),
    status: v.union(v.literal("ok"), v.literal("timeout"), v.literal("error")),
  }).index("by_client_ts", ["clientId", "timestamp"]),

  speedTests: defineTable({
    clientId: v.string(),
    timestamp: v.string(),
    type: v.union(v.literal("probe"), v.literal("full")),
    target: v.union(v.literal("worker"), v.literal("edge")),
    downloadMbps: v.number(),
    uploadMbps: v.number(),
    payloadBytes: v.number(),
    durationMs: v.number(),
  }).index("by_client_ts", ["clientId", "timestamp"]),

  outages: defineTable({
    clientId: v.string(),
    startTs: v.string(),
    endTs: v.union(v.string(), v.null()),
    durationS: v.union(v.number(), v.null()),
  }).index("by_client_start", ["clientId", "startTs"]),

  alerts: defineTable({
    clientId: v.string(),
    type: v.string(),
    severity: v.union(
      v.literal("critical"),
      v.literal("warning"),
      v.literal("info"),
    ),
    value: v.number(),
    threshold: v.number(),
    deliveredEmail: v.number(),
    deliveredTelegram: v.number(),
    timestamp: v.string(),
  }).index("by_client_ts", ["clientId", "timestamp"]),

  clientProbeResults: defineTable({
    clientId: v.string(),
    sessionId: v.string(),
    seqId: v.number(),
    probeType: v.union(v.literal("icmp"), v.literal("http")),
    target: v.string(),
    timestamp: v.number(),
    rttMs: v.union(v.number(), v.null()),
    statusCode: v.union(v.number(), v.null()),
    status: v.union(v.literal("ok"), v.literal("timeout"), v.literal("error")),
    jitterMs: v.union(v.number(), v.null()),
    receivedAt: v.number(),
  })
    .index("by_client_ts", ["clientId", "timestamp"])
    .index("by_client_type_ts", ["clientId", "probeType", "timestamp"])
    .index("by_dedup", ["clientId", "sessionId", "seqId"]),

  // Queue of admin commands the client pulls during its heartbeat poll. This
  // replaces the WebSocket push model of the old Durable Object.
  commands: defineTable({
    clientId: v.string(),
    command: v.string(),
    params: v.optional(v.any()),
    createdAt: v.number(),
  }).index("by_client", ["clientId", "createdAt"]),

  botSettings: defineTable({
    key: v.string(),
    value: v.string(),
    updatedAt: v.string(),
  }).index("by_key", ["key"]),

  rateLimits: defineTable({
    key: v.string(),
    count: v.number(),
    windowStart: v.number(),
  }).index("by_key", ["key"]),
});

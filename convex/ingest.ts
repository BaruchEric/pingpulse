import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { getClientDoc } from "./clients";
import { triggerAlert } from "./alerts";
import { withDefaults } from "./lib/config";
import { latestClientVersion } from "./lib/crypto";

const LOSS_WINDOW_SIZE = 20;

interface ServerLogEntry {
  ts: string;
  level: "info" | "warning" | "error";
  event: string;
  detail?: string;
}

async function gatherRecentLogs(
  ctx: QueryCtx,
  clientId: string,
): Promise<ServerLogEntry[]> {
  const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const hourAgo = new Date(Date.now() - 60 * 60_000).toISOString();

  const [recentAlerts, recentOutages, recentPings] = await Promise.all([
    ctx.db
      .query("alerts")
      .withIndex("by_client_ts", (q) =>
        q.eq("clientId", clientId).gte("timestamp", since),
      )
      .order("desc")
      .take(20),
    ctx.db
      .query("outages")
      .withIndex("by_client_start", (q) =>
        q.eq("clientId", clientId).gte("startTs", since),
      )
      .order("desc")
      .take(10),
    ctx.db
      .query("pingResults")
      .withIndex("by_client_ts", (q) =>
        q.eq("clientId", clientId).gte("timestamp", hourAgo),
      )
      .collect(),
  ]);

  const entries: ServerLogEntry[] = [];
  for (const a of recentAlerts) {
    entries.push({
      ts: a.timestamp,
      level:
        a.severity === "critical"
          ? "error"
          : a.severity === "warning"
            ? "warning"
            : "info",
      event: `alert:${a.type}`,
      detail: `value=${a.value} threshold=${a.threshold}`,
    });
  }
  for (const o of recentOutages) {
    entries.push({
      ts: o.startTs,
      level: "error",
      event: "outage:start",
      detail: o.endTs ? `ended=${o.endTs} duration=${o.durationS}s` : "ongoing",
    });
  }
  if (recentPings.length > 0) {
    const okCount = recentPings.filter((p) => p.status === "ok").length;
    const avgRtt =
      recentPings.filter((p) => p.status === "ok").reduce((s, p) => s + p.rttMs, 0) /
      Math.max(okCount, 1);
    const lossPct = (
      ((recentPings.length - okCount) / recentPings.length) *
      100
    ).toFixed(1);
    entries.push({
      ts: new Date().toISOString(),
      level: "info",
      event: "server:ping_summary",
      detail: `last_hour: ${recentPings.length} pings, ${okCount} ok, avg_rtt=${avgRtt.toFixed(1)}ms, loss=${lossPct}%`,
    });
  }

  entries.sort((a, b) => a.ts.localeCompare(b.ts));
  return entries;
}

async function handleReconnect(
  ctx: MutationCtx,
  clientId: string,
  disconnectedAt: number,
  currentOutageId: Id<"outages"> | null,
): Promise<void> {
  const now = new Date();
  const duration = (now.getTime() - disconnectedAt) / 1000;

  if (currentOutageId) {
    const outage = await ctx.db.get(currentOutageId);
    if (outage) {
      await ctx.db.patch(outage._id, {
        endTs: now.toISOString(),
        durationS: duration,
      });
    }
    await triggerAlert(ctx, {
      clientId,
      type: "client_up",
      severity: "info",
      value: duration,
      threshold: 0,
    });
  } else {
    await ctx.db.insert("outages", {
      clientId,
      startTs: new Date(disconnectedAt).toISOString(),
      endTs: now.toISOString(),
      durationS: duration,
    });
    await triggerAlert(ctx, {
      clientId,
      type: "client_up",
      severity: "info",
      value: duration,
      threshold: 0,
    });
  }
}

export const heartbeat = internalMutation({
  args: {
    clientId: v.string(),
    rttMs: v.optional(v.union(v.number(), v.null())),
    jitterMs: v.optional(v.number()),
    status: v.optional(
      v.union(v.literal("ok"), v.literal("timeout"), v.literal("error")),
    ),
    clientVersion: v.optional(v.string()),
    timezone: v.optional(v.string()),
    includeLogs: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const c = await getClientDoc(ctx, args.clientId);
    if (!c) return { deregistered: true as const };

    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    if (c.adminDisconnectUntil && now < c.adminDisconnectUntil) {
      return { rejected: true as const, reason: "admin_disconnect" };
    }

    const config = withDefaults(c.config);
    const patch: Record<string, unknown> = { lastSeen: nowIso };
    if (c.adminDisconnectUntil) patch.adminDisconnectUntil = null;
    if (args.clientVersion) patch.clientVersion = args.clientVersion;

    if (
      (config.timezone === "UTC" || !config.timezone) &&
      args.timezone &&
      args.timezone !== "UTC"
    ) {
      config.timezone = args.timezone;
      patch.config = config;
    }

    // Reconnect detection: a heartbeat after the monitor marked us down.
    if (c.disconnectedAt != null) {
      await handleReconnect(ctx, c.clientId, c.disconnectedAt, c.currentOutageId);
      patch.disconnectedAt = null;
      patch.currentOutageId = null;
    }

    // Record the round-trip latency the client measured for this heartbeat.
    if (!c.paused && args.rttMs != null) {
      const simulateLoss =
        c.simulationLossPct > 0 && Math.random() * 100 < c.simulationLossPct;

      if (simulateLoss) {
        await ctx.db.insert("pingResults", {
          clientId: c.clientId,
          timestamp: nowIso,
          rttMs: 0,
          jitterMs: 0,
          direction: "cf_to_client",
          status: "timeout",
        });
      } else {
        const effectiveRtt = args.rttMs + c.simulationLatencyMs;
        const status = args.status ?? "ok";

        const last = await ctx.db
          .query("pingResults")
          .withIndex("by_client_ts", (q) => q.eq("clientId", c.clientId))
          .order("desc")
          .first();
        const jitter =
          args.jitterMs ??
          (last ? Math.round(Math.abs(effectiveRtt - last.rttMs) * 100) / 100 : 0);

        await ctx.db.insert("pingResults", {
          clientId: c.clientId,
          timestamp: nowIso,
          rttMs: effectiveRtt,
          jitterMs: jitter,
          direction: "cf_to_client",
          status,
        });

        if (status === "ok" && effectiveRtt > config.alert_latency_threshold_ms) {
          await triggerAlert(ctx, {
            clientId: c.clientId,
            type: "high_latency",
            severity: "warning",
            value: effectiveRtt,
            threshold: config.alert_latency_threshold_ms,
          });
        }
      }

      // Packet loss over the most recent window.
      const window = await ctx.db
        .query("pingResults")
        .withIndex("by_client_ts", (q) => q.eq("clientId", c.clientId))
        .order("desc")
        .take(LOSS_WINDOW_SIZE);
      if (window.length > 0) {
        const timeouts = window.filter((p) => p.status === "timeout").length;
        const lossPct = (timeouts / window.length) * 100;
        if (lossPct > config.alert_loss_threshold_pct) {
          await triggerAlert(ctx, {
            clientId: c.clientId,
            type: "packet_loss",
            severity: "warning",
            value: lossPct,
            threshold: config.alert_loss_threshold_pct,
          });
        }
      }
    }

    await ctx.db.patch(c._id, patch);

    // Pull and ack pending commands.
    const pending = await ctx.db
      .query("commands")
      .withIndex("by_client", (q) => q.eq("clientId", c.clientId))
      .collect();
    const commands = pending.map((cmd) => ({
      command: cmd.command,
      params: cmd.params ?? {},
    }));
    for (const cmd of pending) await ctx.db.delete(cmd._id);

    const server_logs = args.includeLogs
      ? await gatherRecentLogs(ctx, c.clientId)
      : [];

    return {
      config,
      paused: c.paused,
      simulation: { latency_ms: c.simulationLatencyMs, loss_pct: c.simulationLossPct },
      latest_version: latestClientVersion(),
      commands,
      server_logs,
    };
  },
});

export const recordSpeedTest = internalMutation({
  args: {
    clientId: v.string(),
    type: v.union(v.literal("probe"), v.literal("full")),
    target: v.union(v.literal("worker"), v.literal("edge")),
    downloadMbps: v.number(),
    uploadMbps: v.number(),
    payloadBytes: v.number(),
    durationMs: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("speedTests", {
      clientId: args.clientId,
      timestamp: new Date().toISOString(),
      type: args.type,
      target: args.target,
      downloadMbps: args.downloadMbps,
      uploadMbps: args.uploadMbps,
      payloadBytes: args.payloadBytes,
      durationMs: args.durationMs,
    });
    return { ok: true };
  },
});

const probeRecordValidator = v.object({
  seq_id: v.number(),
  probe_type: v.union(v.literal("icmp"), v.literal("http")),
  target: v.string(),
  timestamp: v.number(),
  rtt_ms: v.union(v.number(), v.null()),
  status_code: v.union(v.number(), v.null()),
  status: v.union(v.literal("ok"), v.literal("timeout"), v.literal("error")),
  jitter_ms: v.union(v.number(), v.null()),
});

export const syncProbeResults = internalMutation({
  args: {
    clientId: v.string(),
    sessionId: v.string(),
    records: v.array(probeRecordValidator),
  },
  handler: async (ctx, { clientId, sessionId, records }) => {
    const now = Date.now();
    let maxSeq = 0;
    for (const r of records) {
      if (r.seq_id > maxSeq) maxSeq = r.seq_id;
      const existing = await ctx.db
        .query("clientProbeResults")
        .withIndex("by_dedup", (q) =>
          q.eq("clientId", clientId).eq("sessionId", sessionId).eq("seqId", r.seq_id),
        )
        .unique();
      if (existing) continue;
      await ctx.db.insert("clientProbeResults", {
        clientId,
        sessionId,
        seqId: r.seq_id,
        probeType: r.probe_type,
        target: r.target,
        timestamp: r.timestamp,
        rttMs: r.rtt_ms,
        statusCode: r.status_code,
        status: r.status,
        jitterMs: r.jitter_ms,
        receivedAt: now,
      });
    }
    return { acked_seq: maxSeq };
  },
});

export const ingestProbeResult = internalMutation({
  args: { clientId: v.string(), sessionId: v.string(), record: probeRecordValidator },
  handler: async (ctx, { clientId, sessionId, record }) => {
    const existing = await ctx.db
      .query("clientProbeResults")
      .withIndex("by_dedup", (q) =>
        q.eq("clientId", clientId).eq("sessionId", sessionId).eq("seqId", record.seq_id),
      )
      .unique();
    if (existing) return { ok: true };
    await ctx.db.insert("clientProbeResults", {
      clientId,
      sessionId,
      seqId: record.seq_id,
      probeType: record.probe_type,
      target: record.target,
      timestamp: record.timestamp,
      rttMs: record.rtt_ms,
      statusCode: record.status_code,
      status: record.status,
      jitterMs: record.jitter_ms,
      receivedAt: Date.now(),
    });
    return { ok: true };
  },
});

const connectivityEventValidator = v.object({
  // The client includes its local row id; accepted but unused server-side.
  id: v.optional(v.number()),
  event: v.union(v.literal("disconnected"), v.literal("connected")),
  timestamp: v.number(),
  reason: v.optional(v.union(v.string(), v.null())),
});

export const processConnectivity = internalMutation({
  args: { clientId: v.string(), events: v.array(connectivityEventValidator) },
  handler: async (ctx, { clientId, events }) => {
    const c = await getClientDoc(ctx, clientId);
    if (!c) return { error: "not_found" as const };
    const config = withDefaults(c.config);

    const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
    let outagesCreated = 0;
    let pendingDisconnect: (typeof sorted)[number] | null = null;

    for (const evt of sorted) {
      if (evt.event === "disconnected") {
        pendingDisconnect = evt;
      } else if (evt.event === "connected" && pendingDisconnect) {
        const startMs = pendingDisconnect.timestamp;
        const startTs = new Date(startMs).toISOString();
        const endTs = new Date(evt.timestamp).toISOString();
        const durationS = (evt.timestamp - startMs) / 1000;

        const graceS = config.down_alert_grace_seconds ?? 60;
        if (durationS < graceS) {
          pendingDisconnect = null;
          continue;
        }

        const windowStart = new Date(startMs - 30_000).toISOString();
        const windowEnd = new Date(startMs + 30_000).toISOString();
        const existing = await ctx.db
          .query("outages")
          .withIndex("by_client_start", (q) =>
            q.eq("clientId", clientId).gte("startTs", windowStart).lte("startTs", windowEnd),
          )
          .first();

        if (!existing) {
          await ctx.db.insert("outages", {
            clientId,
            startTs,
            endTs,
            durationS,
          });

          const priorAlerts = await ctx.db
            .query("alerts")
            .withIndex("by_client_ts", (q) =>
              q.eq("clientId", clientId).gte("timestamp", windowStart).lte("timestamp", endTs),
            )
            .collect();
          const alertExists = priorAlerts.some((a) => a.type === "client_down");

          if (!alertExists && config.notifications_enabled) {
            const alertTs = new Date().toISOString();
            const alertId = await ctx.db.insert("alerts", {
              clientId,
              type: "client_down",
              severity: "warning",
              value: durationS,
              threshold: graceS,
              deliveredEmail: 0,
              deliveredTelegram: 0,
              timestamp: alertTs,
            });
            await ctx.scheduler.runAfter(0, internal.alertDispatch.dispatch, {
              alertId,
              clientId,
              clientName: c.name,
              type: "client_down",
              severity: "warning",
              value: durationS,
              threshold: graceS,
              timestamp: alertTs,
              message: `Client-reported outage: ${startTs} — ${endTs} (${Math.round(durationS)}s)\nReason: ${pendingDisconnect.reason ?? "unknown"}`,
              channels: config.down_alert_channels ?? ["telegram"],
              config,
            });
          }
          outagesCreated++;
        }
        pendingDisconnect = null;
      }
    }

    return { ok: true as const, outages_created: outagesCreated };
  },
});

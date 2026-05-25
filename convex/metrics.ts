import { v } from "convex/values";
import { internalQuery } from "./_generated/server";

const LOGS_SCAN_CAP = 5000;

function pingRow(p: {
  _id: string;
  timestamp: string;
  rttMs: number;
  jitterMs: number;
  direction: string;
  status: string;
}) {
  return {
    id: p._id,
    timestamp: p.timestamp,
    rtt_ms: p.rttMs,
    jitter_ms: p.jitterMs,
    direction: p.direction,
    status: p.status,
  };
}

export const getMetrics = internalQuery({
  args: { clientId: v.string(), from: v.string(), to: v.string() },
  handler: async (ctx, { clientId, from, to }) => {
    const [pings, speedTests, outages] = await Promise.all([
      ctx.db
        .query("pingResults")
        .withIndex("by_client_ts", (q) =>
          q.eq("clientId", clientId).gte("timestamp", from).lte("timestamp", to),
        )
        .order("desc")
        .collect(),
      ctx.db
        .query("speedTests")
        .withIndex("by_client_ts", (q) =>
          q.eq("clientId", clientId).gte("timestamp", from).lte("timestamp", to),
        )
        .order("desc")
        .collect(),
      ctx.db
        .query("outages")
        .withIndex("by_client_start", (q) =>
          q.eq("clientId", clientId).gte("startTs", from).lte("startTs", to),
        )
        .order("desc")
        .collect(),
    ]);

    const okPings = pings.filter((p) => p.status === "ok");
    const rtts = okPings.map((p) => p.rttMs);
    const sorted = [...rtts].sort((a, b) => a - b);

    const summary = {
      total_pings: pings.length,
      ok_pings: okPings.length,
      timeout_pings: pings.filter((p) => p.status === "timeout").length,
      loss_pct:
        pings.length > 0
          ? ((pings.length - okPings.length) / pings.length) * 100
          : 0,
      avg_rtt_ms: rtts.length > 0 ? rtts.reduce((a, b) => a + b, 0) / rtts.length : 0,
      min_rtt_ms: sorted[0] || 0,
      max_rtt_ms: sorted[sorted.length - 1] || 0,
      p50_rtt_ms: sorted[Math.floor(sorted.length * 0.5)] || 0,
      p95_rtt_ms: sorted[Math.floor(sorted.length * 0.95)] || 0,
      p99_rtt_ms: sorted[Math.floor(sorted.length * 0.99)] || 0,
    };

    return {
      pings: pings.map(pingRow),
      speed_tests: speedTests.map((s) => ({
        timestamp: s.timestamp,
        type: s.type,
        target: s.target,
        download_mbps: s.downloadMbps,
        upload_mbps: s.uploadMbps,
        payload_bytes: s.payloadBytes,
        duration_ms: s.durationMs,
      })),
      outages: outages.map((o) => ({
        start_ts: o.startTs,
        end_ts: o.endTs,
        duration_s: o.durationS,
      })),
      summary,
    };
  },
});

export const getLogs = internalQuery({
  args: { clientId: v.string(), limit: v.number(), offset: v.number() },
  handler: async (ctx, { clientId, limit, offset }) => {
    // Bounded scan of the most recent pings (Convex has no COUNT aggregate).
    const recent = await ctx.db
      .query("pingResults")
      .withIndex("by_client_ts", (q) => q.eq("clientId", clientId))
      .order("desc")
      .take(LOGS_SCAN_CAP);

    const page = recent.slice(offset, offset + limit);
    return { logs: page.map(pingRow), total: recent.length, limit, offset };
  },
});

export const getProbes = internalQuery({
  args: {
    clientId: v.string(),
    from: v.number(),
    to: v.number(),
    type: v.optional(v.union(v.literal("icmp"), v.literal("http"))),
  },
  handler: async (ctx, { clientId, from, to, type }) => {
    const rows = type
      ? await ctx.db
          .query("clientProbeResults")
          .withIndex("by_client_type_ts", (q) =>
            q
              .eq("clientId", clientId)
              .eq("probeType", type)
              .gte("timestamp", from)
              .lte("timestamp", to),
          )
          .order("asc")
          .take(10000)
      : await ctx.db
          .query("clientProbeResults")
          .withIndex("by_client_ts", (q) =>
            q.eq("clientId", clientId).gte("timestamp", from).lte("timestamp", to),
          )
          .order("asc")
          .take(10000);

    return {
      data: rows.map((r) => ({
        timestamp: r.timestamp,
        probe_type: r.probeType,
        target: r.target,
        rtt_ms: r.rttMs,
        status_code: r.statusCode,
        status: r.status,
        jitter_ms: r.jitterMs,
      })),
    };
  },
});

const EXPORT_CAP = 100_000;

export const exportData = internalQuery({
  args: { clientId: v.string(), from: v.string(), to: v.string() },
  handler: async (ctx, { clientId, from, to }) => {
    const client = await ctx.db
      .query("clients")
      .withIndex("by_clientId", (q) => q.eq("clientId", clientId))
      .unique();
    if (!client) return null;

    const [pings, speedTests] = await Promise.all([
      ctx.db
        .query("pingResults")
        .withIndex("by_client_ts", (q) =>
          q.eq("clientId", clientId).gte("timestamp", from).lte("timestamp", to),
        )
        .order("asc")
        .take(EXPORT_CAP),
      ctx.db
        .query("speedTests")
        .withIndex("by_client_ts", (q) =>
          q.eq("clientId", clientId).gte("timestamp", from).lte("timestamp", to),
        )
        .order("asc")
        .take(EXPORT_CAP),
    ]);

    return {
      ping_results: pings.map((p) => ({
        id: p._id,
        client_id: p.clientId,
        timestamp: p.timestamp,
        rtt_ms: p.rttMs,
        jitter_ms: p.jitterMs,
        direction: p.direction,
        status: p.status,
      })),
      speed_tests: speedTests.map((s) => ({
        id: s._id,
        client_id: s.clientId,
        timestamp: s.timestamp,
        type: s.type,
        target: s.target,
        download_mbps: s.downloadMbps,
        upload_mbps: s.uploadMbps,
        payload_bytes: s.payloadBytes,
        duration_ms: s.durationMs,
      })),
    };
  },
});

export const getSyncStatus = internalQuery({
  args: { clientId: v.string() },
  handler: async (ctx, { clientId }) => {
    const latest = await ctx.db
      .query("clientProbeResults")
      .withIndex("by_client_ts", (q) => q.eq("clientId", clientId))
      .order("desc")
      .first();

    const scan = await ctx.db
      .query("clientProbeResults")
      .withIndex("by_client_ts", (q) => q.eq("clientId", clientId))
      .order("desc")
      .take(LOGS_SCAN_CAP);

    return {
      last_sync: latest?.receivedAt ?? null,
      total_records: scan.length,
      latest_probe_ts: latest?.timestamp ?? null,
    };
  },
});

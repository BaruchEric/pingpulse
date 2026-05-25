import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { getClientDoc } from "./clients";
import { withDefaults, pickAllowedConfig } from "./lib/config";

function isConnected(lastSeen: string, pingIntervalS: number): boolean {
  const threshold = Math.max(pingIntervalS * 1000 * 2, 90_000);
  return Date.now() - new Date(lastSeen).getTime() < threshold;
}

/**
 * Apply or enqueue an admin command. State-style commands (pause/resume/
 * simulate/update_config/disconnect) take effect immediately on the client
 * document; action-style commands (speed_test/request_ping/self_update/
 * deregister) are queued and pulled by the client on its next heartbeat.
 */
export const enqueue = internalMutation({
  args: { clientId: v.string(), command: v.string(), params: v.optional(v.any()) },
  handler: async (ctx, { clientId, command, params }) => {
    const c = await getClientDoc(ctx, clientId);
    if (!c) return { error: "not_found" as const };

    const config = withDefaults(c.config);
    const connected = isConnected(c.lastSeen, config.ping_interval_s);
    const p = (params ?? {}) as Record<string, unknown>;

    switch (command) {
      case "pause":
        await ctx.db.patch(c._id, { paused: true });
        return { ok: true, state: "paused" };

      case "resume":
        await ctx.db.patch(c._id, { paused: false });
        return { ok: true, state: "running" };

      case "simulate":
        await ctx.db.patch(c._id, {
          simulationLatencyMs:
            typeof p.latency_ms === "number" ? p.latency_ms : c.simulationLatencyMs,
          simulationLossPct:
            typeof p.loss_pct === "number" ? p.loss_pct : c.simulationLossPct,
        });
        return {
          ok: true,
          simulation: {
            latency_ms:
              typeof p.latency_ms === "number" ? p.latency_ms : c.simulationLatencyMs,
            loss_pct:
              typeof p.loss_pct === "number" ? p.loss_pct : c.simulationLossPct,
          },
        };

      case "simulate_reset":
        await ctx.db.patch(c._id, { simulationLatencyMs: 0, simulationLossPct: 0 });
        return { ok: true, simulation: { latency_ms: 0, loss_pct: 0 } };

      case "update_config": {
        const merged = withDefaults({ ...config, ...pickAllowedConfig(p) });
        await ctx.db.patch(c._id, { config: merged });
        return { ok: true, config: merged };
      }

      case "disconnect": {
        const graceMs = (config.down_alert_grace_seconds ?? config.grace_period_s) * 1000;
        await ctx.db.patch(c._id, {
          adminDisconnectUntil: Date.now() + graceMs + 30_000,
        });
        return { ok: true, message: "Client disconnected" };
      }

      case "request_ping": {
        if (!connected) return { ok: false, reason: "not_connected" };
        await ctx.db.insert("commands", {
          clientId,
          command: "request_ping",
          createdAt: Date.now(),
        });
        return { ok: true };
      }

      case "speed_test": {
        if (!connected) return { ok: false, reason: "not_connected" };
        const testType = p.test_type === "probe" ? "probe" : "full";
        const target = p.target === "edge" ? "edge" : "worker";
        await ctx.db.insert("commands", {
          clientId,
          command: "speed_test",
          params: { test_type: testType, target },
          createdAt: Date.now(),
        });
        return { ok: true, test_type: testType, target };
      }

      case "self_update": {
        const version =
          (typeof p.version === "string" && p.version) ||
          process.env.LATEST_CLIENT_VERSION ||
          "";
        if (!version) return { error: "No version specified" as const };
        if (!connected) return { ok: false, reason: "not_connected" };
        await ctx.db.insert("commands", {
          clientId,
          command: "self_update",
          params: { version, repo: "BaruchEric/pingpulse" },
          createdAt: Date.now(),
        });
        return { ok: true, version };
      }

      case "deregister":
        await ctx.db.insert("commands", {
          clientId,
          command: "deregister",
          createdAt: Date.now(),
        });
        return { ok: true, message: "Client notified" };

      default:
        return { error: `Unknown command: ${command}` as const };
    }
  },
});

export const status = internalQuery({
  args: { clientId: v.string() },
  handler: async (ctx, { clientId }) => {
    const c = await getClientDoc(ctx, clientId);
    if (!c) return null;
    const config = withDefaults(c.config);
    const connected = isConnected(c.lastSeen, config.ping_interval_s);
    const pending = await ctx.db
      .query("commands")
      .withIndex("by_client", (q) => q.eq("clientId", clientId))
      .collect();
    return {
      connected,
      session_count: connected ? 1 : 0,
      paused: c.paused,
      simulation: {
        latency_ms: c.simulationLatencyMs,
        loss_pct: c.simulationLossPct,
      },
      pings_in_flight: 0,
      buffer_size: pending.length,
      disconnected_at: c.disconnectedAt
        ? new Date(c.disconnectedAt).toISOString()
        : null,
    };
  },
});

// Enqueue a speed test for a connected client (used by the dashboard's
// /api/speedtest/:id trigger). Mirrors the DO's trigger-speed-test fan-out.
export const triggerSpeedTest = internalMutation({
  args: { clientId: v.string() },
  handler: async (ctx, { clientId }) => {
    const c = await getClientDoc(ctx, clientId);
    if (!c) return { error: "not_found" as const };
    for (const target of ["worker", "edge"] as const) {
      await ctx.db.insert("commands", {
        clientId,
        command: "speed_test",
        params: { test_type: "full", target },
        createdAt: Date.now(),
      });
    }
    return { ok: true };
  },
});

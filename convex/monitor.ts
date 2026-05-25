import { internalMutation } from "./_generated/server";
import { triggerAlert } from "./alerts";
import { withDefaults } from "./lib/config";

/**
 * Scans for clients that have stopped sending heartbeats and records the
 * outage + client_down alert. Replaces the Durable Object's disconnect alarm.
 * A client is considered down once it has been silent for longer than
 * (2 × ping_interval) + the configured down-alert grace period.
 */
export const detectDownClients = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const clients = await ctx.db.query("clients").collect();

    for (const c of clients) {
      if (c.disconnectedAt != null) continue; // already flagged down

      const config = withDefaults(c.config);
      const grace = config.down_alert_grace_seconds ?? config.grace_period_s;
      const thresholdMs = (config.ping_interval_s * 2 + grace) * 1000;
      const lastSeenMs = new Date(c.lastSeen).getTime();
      const elapsedMs = now - lastSeenMs;
      if (elapsedMs <= thresholdMs) continue;

      const outageId = await ctx.db.insert("outages", {
        clientId: c.clientId,
        startTs: new Date(lastSeenMs).toISOString(),
        endTs: null,
        durationS: null,
      });
      await ctx.db.patch(c._id, {
        disconnectedAt: lastSeenMs,
        currentOutageId: outageId,
      });

      await triggerAlert(ctx, {
        clientId: c.clientId,
        type: "client_down",
        severity: "critical",
        value: elapsedMs / 1000,
        threshold: grace,
        downDurationS: elapsedMs / 1000,
      });
    }
  },
});

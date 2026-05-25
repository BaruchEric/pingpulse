import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { getClientDoc } from "./clients";
import { withDefaults } from "./lib/config";

const DEDUP_WINDOW_MS = 5 * 60_000;

export interface TriggerAlertParams {
  clientId: string;
  type: string;
  severity: "critical" | "warning" | "info";
  value: number;
  threshold: number;
  message?: string;
  // For client_down escalation: how long the client has been down, in seconds.
  downDurationS?: number;
}

/**
 * Insert an alert (deduped per type within a 5-minute window) and schedule
 * notification dispatch. Replaces the Durable Object's in-memory dedup map and
 * its alarm-based retry mechanism (retries now use ctx.scheduler).
 */
export async function triggerAlert(
  ctx: MutationCtx,
  params: TriggerAlertParams,
): Promise<void> {
  const nowMs = Date.now();
  const cutoff = new Date(nowMs - DEDUP_WINDOW_MS).toISOString();

  const recent = await ctx.db
    .query("alerts")
    .withIndex("by_client_ts", (q) =>
      q.eq("clientId", params.clientId).gte("timestamp", cutoff),
    )
    .collect();
  if (recent.some((a) => a.type === params.type)) return;

  const timestamp = new Date(nowMs).toISOString();
  const alertId = await ctx.db.insert("alerts", {
    clientId: params.clientId,
    type: params.type,
    severity: params.severity,
    value: params.value,
    threshold: params.threshold,
    deliveredEmail: 0,
    deliveredTelegram: 0,
    timestamp,
  });

  const client = await getClientDoc(ctx, params.clientId);
  const config = withDefaults(client?.config);
  if (!config.notifications_enabled) return;

  const channels = new Set(config.down_alert_channels ?? ["telegram"]);
  if (
    config.down_alert_escalation_enabled &&
    params.type === "client_down" &&
    (params.downDurationS ?? 0) >= (config.down_alert_escalate_after_seconds ?? 600)
  ) {
    for (const ch of config.down_alert_escalate_channels ?? ["email"]) {
      channels.add(ch);
    }
  }

  await ctx.scheduler.runAfter(0, internal.alertDispatch.dispatch, {
    alertId,
    clientId: params.clientId,
    clientName: client?.name,
    type: params.type,
    severity: params.severity,
    value: params.value,
    threshold: params.threshold,
    timestamp,
    message: params.message,
    channels: Array.from(channels),
    config,
  });
}

export const setDelivery = internalMutation({
  args: {
    alertId: v.id("alerts"),
    deliveredEmail: v.optional(v.number()),
    deliveredTelegram: v.optional(v.number()),
  },
  handler: async (ctx, { alertId, deliveredEmail, deliveredTelegram }) => {
    const patch: Record<string, number> = {};
    if (deliveredEmail !== undefined) patch.deliveredEmail = deliveredEmail;
    if (deliveredTelegram !== undefined) patch.deliveredTelegram = deliveredTelegram;
    if (Object.keys(patch).length > 0) await ctx.db.patch(alertId, patch);
  },
});

export const list = internalQuery({
  args: {
    clientId: v.optional(v.string()),
    limit: v.number(),
    offset: v.number(),
  },
  handler: async (ctx, { clientId, limit, offset }) => {
    let rows;
    if (clientId) {
      rows = await ctx.db
        .query("alerts")
        .withIndex("by_client_ts", (q) => q.eq("clientId", clientId))
        .order("desc")
        .collect();
    } else {
      rows = await ctx.db.query("alerts").order("desc").collect();
      rows.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    }

    const page = rows.slice(offset, offset + limit);
    const alerts = page.map((a) => ({
      id: a._id,
      client_id: a.clientId,
      type: a.type,
      severity: a.severity,
      value: a.value,
      threshold: a.threshold,
      delivered_email: a.deliveredEmail,
      delivered_telegram: a.deliveredTelegram,
      timestamp: a.timestamp,
    }));
    return { alerts };
  },
});

// Updates the latency/loss thresholds on every client (global defaults).
export const updateThresholds = internalMutation({
  args: {
    default_latency_threshold_ms: v.optional(v.number()),
    default_loss_threshold_pct: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const clients = await ctx.db.query("clients").collect();
    for (const c of clients) {
      const config = withDefaults(c.config);
      if (args.default_latency_threshold_ms !== undefined) {
        config.alert_latency_threshold_ms = args.default_latency_threshold_ms;
      }
      if (args.default_loss_threshold_pct !== undefined) {
        config.alert_loss_threshold_pct = args.default_loss_threshold_pct;
      }
      await ctx.db.patch(c._id, { config });
    }
    return { ok: true };
  },
});

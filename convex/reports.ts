import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { runAnalysis } from "./analysis";
import { formatTelegramReport, formatEmailReport } from "./lib/healthReport";
import { sendTelegramMessage, sendResendEmail } from "./lib/notify";

// POST /api/alerts/test — send a test notification through both channels.
export const testAlert = internalAction({
  args: {},
  handler: async () => {
    const message = "🟢 This is a test alert from PingPulse";
    await Promise.allSettled([
      sendTelegramMessage(message),
      sendResendEmail("[PingPulse] Test alert", { text: message }),
    ]);
    return { ok: true };
  },
});

// GET /api/metrics/:id/analysis — full deep-analysis payload.
export const analysis = internalAction({
  args: { clientId: v.string(), from: v.string(), to: v.string() },
  handler: async (ctx, { clientId, from, to }) => {
    return runAnalysis(ctx, clientId, from, to);
  },
});

// POST /api/metrics/:id/report — generate (and optionally send) a report.
export const generateReport = internalAction({
  args: {
    clientId: v.string(),
    send: v.optional(v.string()),
  },
  handler: async (ctx, { clientId, send }) => {
    const from = new Date(Date.now() - 86400_000).toISOString();
    const to = new Date().toISOString();

    const data = await runAnalysis(ctx, clientId, from, to);
    const client = await ctx.runQuery(internal.clients.getOne, { clientId });
    const clientName = client?.name || clientId;

    const sent: { telegram?: boolean; email?: boolean } = {};
    if (send === "telegram" || send === "all") {
      sent.telegram = await sendTelegramMessage(
        formatTelegramReport(clientName, from, to, data),
      );
    }
    if (send === "email" || send === "all") {
      sent.email = await sendResendEmail(`[PingPulse] Health Report — ${clientName}`, {
        html: formatEmailReport(clientName, from, to, data),
      });
    }

    return { report: data, sent };
  },
});

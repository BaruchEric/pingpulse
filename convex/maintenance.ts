import { internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { runAnalysis } from "./analysis";
import { formatTelegramReport, formatEmailReport } from "./lib/healthReport";
import { sendTelegramMessage, sendResendEmail } from "./lib/notify";

const PURGE_BATCH = 1000;
const MAX_PURGE_ITERATIONS = 50;

// Runs every 6 hours (replacing the Cloudflare cron trigger): fan out speed
// tests, apply retention, send scheduled health reports, and clean up.
export const sixHourly = internalAction({
  args: {},
  handler: async (ctx) => {
    const now = new Date();

    // 1. Trigger full speed tests on clients active in the last 24h.
    const active24h = await ctx.runQuery(internal.clients.listActiveSince, {
      since: new Date(now.getTime() - 86400_000).toISOString(),
    });
    for (const c of active24h) {
      await ctx.runMutation(internal.commands.triggerSpeedTest, {
        clientId: c.clientId,
      });
    }

    // 2. Apply per-client raw retention.
    const allActive = await ctx.runQuery(internal.clients.listActiveSince, {
      since: "0000",
    });
    for (const c of allActive) {
      const rawDays = c.config.retention_raw_days ?? 30;
      const cutoffMs = now.getTime() - rawDays * 86400_000;
      const cutoffIso = new Date(cutoffMs).toISOString();
      for (let i = 0; i < MAX_PURGE_ITERATIONS; i++) {
        const res = await ctx.runMutation(internal.clients.purgeOldRecords, {
          clientId: c.clientId,
          cutoffIso,
          cutoffMs,
          limit: PURGE_BATCH,
        });
        if (res.pings === 0 && res.probes === 0) break;
      }
    }

    // 3. Scheduled health reports.
    await sendHealthReports(ctx, now);

    // 4. Cleanup.
    await ctx.runMutation(internal.rateLimit.cleanup, { olderThanMs: 3600_000 });
    await ctx.runMutation(internal.botSettings.cleanupExpiredMute, {});
  },
});

async function sendHealthReports(ctx: ActionCtx, now: Date): Promise<void> {
  const utcHour = now.getUTCHours();
  const utcDay = now.getUTCDay();

  const clients = await ctx.runQuery(internal.clients.listActiveSince, {
    since: new Date(now.getTime() - 7 * 86400_000).toISOString(),
  });

  for (const client of clients) {
    const config = client.config;
    const schedule = config.report_schedule ?? "daily";
    const channels = config.report_channels ?? ["telegram", "email"];

    if (schedule === "off") continue;
    if (schedule === "daily" && utcHour !== 0) continue;
    if (schedule === "weekly" && (utcHour !== 0 || utcDay !== 1)) continue;
    // "6h" runs every tick.

    const windowMs =
      schedule === "weekly" ? 7 * 86400_000 : schedule === "6h" ? 6 * 3600_000 : 86400_000;
    const from = new Date(now.getTime() - windowMs).toISOString();
    const to = now.toISOString();

    try {
      const data = await runAnalysis(ctx, client.clientId, from, to);
      const gracePeriodMs =
        (config.down_alert_grace_seconds ?? config.grace_period_s ?? 60) * 1000;
      const isDown = Date.now() - new Date(client.lastSeen).getTime() > gracePeriodMs;

      if (channels.includes("telegram")) {
        await sendTelegramMessage(
          formatTelegramReport(client.name, from, to, data, isDown),
        );
      }
      if (channels.includes("email")) {
        await sendResendEmail(`[PingPulse] Health Report — ${client.name}`, {
          html: formatEmailReport(client.name, from, to, data, isDown),
        });
      }
    } catch (err) {
      console.error(`[maintenance] health report failed for ${client.clientId}:`, err);
    }
  }
}

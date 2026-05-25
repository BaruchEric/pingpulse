import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { clientConfigValidator } from "./schema";
import { DEFAULT_CLIENT_CONFIG } from "./lib/config";
import { sendTelegramMessage, sendResendEmail } from "./lib/notify";

const SEVERITY_EMOJI: Record<string, string> = {
  critical: "\u{1F534}",
  warning: "\u{1F7E1}",
  info: "\u{1F7E2}",
};

function formatLocalTime(isoTimestamp: string, timezone?: string): string {
  try {
    const tz = timezone && timezone !== "UTC" ? timezone : undefined;
    if (!tz) return isoTimestamp;
    return new Date(isoTimestamp).toLocaleString("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    });
  } catch {
    return isoTimestamp;
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const dispatchArgs = {
  alertId: v.id("alerts"),
  clientId: v.string(),
  clientName: v.optional(v.string()),
  type: v.string(),
  severity: v.union(v.literal("critical"), v.literal("warning"), v.literal("info")),
  value: v.number(),
  threshold: v.number(),
  timestamp: v.string(),
  message: v.optional(v.string()),
  channels: v.array(v.string()),
  config: v.optional(clientConfigValidator),
  // Internal: which channels to retry (set by the scheduled retry).
  retryEmail: v.optional(v.boolean()),
  retryTelegram: v.optional(v.boolean()),
};

export const dispatch = internalAction({
  args: dispatchArgs,
  handler: async (ctx, args) => {
    const config = args.config ?? DEFAULT_CLIENT_CONFIG;
    const channels = new Set(args.channels);

    const emoji = SEVERITY_EMOJI[args.severity] || "⚪";
    const headerName = args.clientName
      ? `「<b><u>${escapeHtml(args.clientName)}</u></b>」`
      : `<code>${escapeHtml(args.clientId)}</code>`;
    const timeStr = escapeHtml(formatLocalTime(args.timestamp, config.timezone));
    const lines = [
      `${emoji} ${headerName} — <b>${escapeHtml(args.type.toUpperCase().replace(/_/g, " "))}</b>`,
      ``,
      `⚠️ Severity: ${escapeHtml(args.severity.toUpperCase())}`,
      `📊 Value: <b>${args.value}</b> / ${args.threshold}`,
      `🕐 Time: ${timeStr}`,
    ];
    if (args.message) lines.push(`\n${escapeHtml(args.message)}`);
    const message = lines.join("\n");

    const isRetry = args.retryEmail !== undefined || args.retryTelegram !== undefined;
    const doEmail = isRetry ? !!args.retryEmail : channels.has("email");
    const doTelegram = isRetry ? !!args.retryTelegram : channels.has("telegram");

    let emailOk = false;
    let telegramOk = false;
    const promises: Promise<void>[] = [];

    if (doEmail) {
      promises.push(
        sendResendEmail(
          `[PingPulse] ${args.severity.toUpperCase()}: ${args.type.replace(/_/g, " ")}`,
          { text: message },
        ).then((ok) => {
          emailOk = ok;
        }),
      );
    }

    if (doTelegram) {
      const muteUntil = await ctx.runQuery(internal.botSettings.getMuteUntil, {});
      const isMuted = muteUntil !== null && args.severity !== "critical";
      const enabledConfig =
        config.telegram_notification_enabled ??
        DEFAULT_CLIENT_CONFIG.telegram_notification_enabled;
      const isEnabled = enabledConfig[args.type] ?? true;

      if (!isMuted && isEnabled) {
        const soundConfig =
          config.telegram_notification_sound ??
          DEFAULT_CLIENT_CONFIG.telegram_notification_sound;
        const isSilent = soundConfig[args.type] === "silent";
        promises.push(
          sendTelegramMessage(message, { silent: isSilent, parse_mode: "HTML" }).then(
            (ok) => {
              telegramOk = ok;
            },
          ),
        );
      } else {
        // Muted or disabled counts as "not attempted" rather than a failure.
        telegramOk = true;
      }
    }

    await Promise.allSettled(promises);

    const emailStatus = !doEmail ? 0 : emailOk ? 1 : -1;
    const telegramStatus = !doTelegram ? 0 : telegramOk ? 1 : -1;
    await ctx.runMutation(internal.alerts.setDelivery, {
      alertId: args.alertId,
      ...(doEmail ? { deliveredEmail: emailStatus } : {}),
      ...(doTelegram ? { deliveredTelegram: telegramStatus } : {}),
    });

    // Retry failed channels once for critical alerts (scheduler replaces the
    // old Durable Object alarm-based retry).
    if (!isRetry && args.severity === "critical" && (emailStatus === -1 || telegramStatus === -1)) {
      await ctx.scheduler.runAfter(5000, internal.alertDispatch.dispatch, {
        ...args,
        retryEmail: emailStatus === -1,
        retryTelegram: telegramStatus === -1,
      });
    }
  },
});

import type { Env } from "@/index";
import type { AlertType, AlertSeverity, ClientConfig } from "@/types";
import { DEFAULT_CLIENT_CONFIG } from "@/types";
import { sendTelegramMessage, sendResendEmail } from "@/services/notify";
import { getMuteUntil } from "@/services/bot-settings";

export interface AlertPayload {
  alert_id: string;
  client_id: string;
  client_name?: string;
  type: AlertType;
  severity: AlertSeverity;
  value: number;
  threshold: number;
  timestamp: string;
  message?: string;
  config?: Partial<ClientConfig>;
}

export interface DispatchResult {
  email: boolean;
  telegram: boolean;
}

const SEVERITY_EMOJI: Record<string, string> = {
  critical: "\u{1F534}",
  warning: "\u{1F7E1}",
  info: "\u{1F7E2}",
};

function formatLocalTime(isoTimestamp: string, timezone?: string): string {
  try {
    const tz = timezone && timezone !== "UTC" ? timezone : undefined;
    if (!tz) return isoTimestamp;
    const date = new Date(isoTimestamp);
    return date.toLocaleString("en-US", {
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

function formatMessage(alert: AlertPayload): string {
  const emoji = SEVERITY_EMOJI[alert.severity] || "\u26AA";
  const clientName = alert.client_name
    ? escapeHtml(alert.client_name)
    : null;
  const headerName = clientName
    ? `「<b><u>${clientName}</u></b>」`
    : `<code>${escapeHtml(alert.client_id)}</code>`;
  const tz = alert.config?.timezone;
  const timeStr = escapeHtml(formatLocalTime(alert.timestamp, tz));
  const lines = [
    `${emoji} ${headerName} — <b>${escapeHtml(alert.type.toUpperCase().replace(/_/g, " "))}</b>`,
    ``,
    `⚠️ Severity: ${escapeHtml(alert.severity.toUpperCase())}`,
    `📊 Value: <b>${alert.value}</b> / ${alert.threshold}`,
    `🕐 Time: ${timeStr}`,
  ];
  if (alert.message) lines.push(`\n${escapeHtml(alert.message)}`);
  return lines.join("\n");
}

export async function dispatchAlert(
  env: Env,
  alert: AlertPayload
): Promise<DispatchResult> {
  const message = formatMessage(alert);
  const result: DispatchResult = { email: false, telegram: false };

  const promises: Promise<void>[] = [];

  if (env.RESEND_API_KEY) {
    promises.push(
      sendResendEmail(env, `[PingPulse] ${alert.severity.toUpperCase()}: ${alert.type.replace(/_/g, " ")}`, { text: message })
        .then((ok) => { result.email = ok; })
    );
  }

  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    // Check mute status up-front so email promise can start in parallel
    const muteUntil = await getMuteUntil(env.DB);
    const isMuted = muteUntil !== null && alert.severity !== "critical";

    if (!isMuted) {
      const enabledConfig = alert.config?.telegram_notification_enabled
        ?? DEFAULT_CLIENT_CONFIG.telegram_notification_enabled;
      const isEnabled = enabledConfig[alert.type] ?? true;

      if (isEnabled) {
        const soundConfig = alert.config?.telegram_notification_sound
          ?? DEFAULT_CLIENT_CONFIG.telegram_notification_sound;
        const isSilent = soundConfig[alert.type] === "silent";

        promises.push(
          sendTelegramMessage(env, message, { silent: isSilent, parse_mode: "HTML" })
            .then((ok) => { result.telegram = ok; })
        );
      }
    }
  }

  await Promise.allSettled(promises);
  return result;
}

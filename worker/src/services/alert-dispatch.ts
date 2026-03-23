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

function formatMessage(alert: AlertPayload): string {
  const emoji = SEVERITY_EMOJI[alert.severity] || "\u26AA";
  const clientLabel = alert.client_name
    ? `${alert.client_name} (${alert.client_id})`
    : alert.client_id;
  const lines = [
    `${emoji} PingPulse Alert: ${alert.type.toUpperCase().replace(/_/g, " ")}`,
    `Severity: ${alert.severity.toUpperCase()}`,
    `Client: ${clientLabel}`,
    `Value: ${alert.value}`,
    `Threshold: ${alert.threshold}`,
    `Time: ${alert.timestamp}`,
  ];
  if (alert.message) lines.push(`\n${alert.message}`);
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
    // Check mute status (critical alerts always go through)
    const muteUntil = await getMuteUntil(env.DB);
    const isMuted = muteUntil !== null && alert.severity !== "critical";

    if (!isMuted) {
      const soundConfig = alert.config?.telegram_notification_sound
        ?? DEFAULT_CLIENT_CONFIG.telegram_notification_sound;
      const isSilent = soundConfig[alert.type] === "silent";

      // "silent" means don't send this alert type at all (not just mute sound)
      if (!isSilent) {
        promises.push(
          sendTelegramMessage(env, message)
            .then((ok) => { result.telegram = ok; })
        );
      }
    }
  }

  await Promise.allSettled(promises);
  return result;
}

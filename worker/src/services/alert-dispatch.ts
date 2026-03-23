import type { Env } from "@/index";
import type { AlertType, AlertSeverity } from "@/types";
import { sendTelegramMessage, sendResendEmail } from "@/services/notify";

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
    promises.push(
      sendTelegramMessage(env, message)
        .then((ok) => { result.telegram = ok; })
    );
  }

  await Promise.allSettled(promises);
  return result;
}

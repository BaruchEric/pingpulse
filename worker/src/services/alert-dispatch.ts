import type { Env } from "@/index";
import type { AlertType, AlertSeverity } from "@/types";

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
      sendEmail(env, alert, message)
        .then(() => { result.email = true; })
        .catch((err) => {
          console.error(`[alert-dispatch] Email failed for alert ${alert.alert_id}:`, err);
          result.email = false;
        })
    );
  }

  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    promises.push(
      sendTelegram(env, message)
        .then(() => { result.telegram = true; })
        .catch((err) => {
          console.error(`[alert-dispatch] Telegram failed for alert ${alert.alert_id}:`, err);
          result.telegram = false;
        })
    );
  }

  await Promise.allSettled(promises);
  return result;
}

async function sendEmail(
  env: Env,
  alert: AlertPayload,
  message: string
): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.ALERT_FROM_EMAIL || "PingPulse <alerts@ping.beric.ca>",
      to: [env.ALERT_TO_EMAIL || "admin@beric.ca"],
      subject: `[PingPulse] ${alert.severity.toUpperCase()}: ${alert.type.replace(/_/g, " ")}`,
      text: message,
    }),
  });
  if (!res.ok) {
    throw new Error(`Resend API returned ${res.status}: ${await res.text()}`);
  }
}

async function sendTelegram(env: Env, message: string): Promise<void> {
  const res = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: message,
      }),
    }
  );
  if (!res.ok) {
    throw new Error(`Telegram API returned ${res.status}: ${await res.text()}`);
  }
}

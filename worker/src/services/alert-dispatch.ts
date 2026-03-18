import type { Env } from "@/index";
import type { AlertType, AlertSeverity } from "@/types";

export interface AlertPayload {
  alert_id: string;
  client_id: string;
  type: AlertType;
  severity: AlertSeverity;
  value: number;
  threshold: number;
  timestamp: string;
  message?: string;
}

const SEVERITY_EMOJI: Record<string, string> = {
  critical: "\u{1F534}",
  warning: "\u{1F7E1}",
  info: "\u{1F7E2}",
};

function formatMessage(alert: AlertPayload): string {
  const emoji = SEVERITY_EMOJI[alert.severity] || "\u26AA";
  const lines = [
    `${emoji} PingPulse Alert: ${alert.type.toUpperCase().replace(/_/g, " ")}`,
    `Severity: ${alert.severity.toUpperCase()}`,
    `Client: ${alert.client_id}`,
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
): Promise<void> {
  const message = formatMessage(alert);
  const promises: Promise<void>[] = [];

  if (env.RESEND_API_KEY) {
    promises.push(sendEmail(env, alert, message));
  }

  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    promises.push(sendTelegram(env, message));
  }

  await Promise.allSettled(promises);
}

async function sendEmail(
  env: Env,
  alert: AlertPayload,
  message: string
): Promise<void> {
  try {
    await fetch("https://api.resend.com/emails", {
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
  } catch {
    // Best effort
  }
}

async function sendTelegram(env: Env, message: string): Promise<void> {
  try {
    await fetch(
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
  } catch {
    // Best effort
  }
}

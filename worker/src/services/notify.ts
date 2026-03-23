import type { Env } from "@/index";

export interface TelegramMessageOptions {
  silent?: boolean;
  parse_mode?: "HTML" | "MarkdownV2";
  reply_markup?: unknown;
}

export async function sendTelegramMessage(
  env: Env,
  text: string,
  options?: TelegramMessageOptions
): Promise<boolean> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return false;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text,
          disable_notification: options?.silent ?? false,
          parse_mode: options?.parse_mode,
          reply_markup: options?.reply_markup,
        }),
      }
    );
    if (!res.ok) throw new Error(`Telegram API returned ${res.status}`);
    return true;
  } catch (err) {
    console.error("[notify] Telegram send failed:", err);
    return false;
  }
}

export async function sendResendEmail(
  env: Env,
  subject: string,
  body: { text?: string; html?: string }
): Promise<boolean> {
  if (!env.RESEND_API_KEY) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.ALERT_FROM_EMAIL || "PingPulse <alerts@ping.beric.ca>",
        to: [env.ALERT_TO_EMAIL || "admin@beric.ca"],
        subject,
        ...body,
      }),
    });
    if (!res.ok) throw new Error(`Resend API returned ${res.status}`);
    return true;
  } catch (err) {
    console.error("[notify] Email send failed:", err);
    return false;
  }
}

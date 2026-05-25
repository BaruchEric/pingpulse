// External notification senders. Plain async helpers that use global fetch and
// read credentials from process.env; invoked from Convex actions.

export interface TelegramMessageOptions {
  silent?: boolean;
  parse_mode?: "HTML" | "MarkdownV2";
  reply_markup?: unknown;
}

export async function sendTelegramMessage(
  text: string,
  options?: TelegramMessageOptions,
): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_notification: options?.silent ?? false,
        parse_mode: options?.parse_mode,
        reply_markup: options?.reply_markup,
      }),
    });
    if (!res.ok) throw new Error(`Telegram API returned ${res.status}`);
    return true;
  } catch (err) {
    console.error("[notify] Telegram send failed:", err);
    return false;
  }
}

export async function sendResendEmail(
  subject: string,
  body: { text?: string; html?: string },
): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.ALERT_FROM_EMAIL || "PingPulse <alerts@ping.beric.ca>",
        to: [process.env.ALERT_TO_EMAIL || "admin@beric.ca"],
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

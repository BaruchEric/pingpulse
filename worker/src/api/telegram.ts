import { Hono } from "hono";
import type { AppEnv } from "@/middleware/auth-guard";
import { authGuard } from "@/middleware/auth-guard";
import { sendTelegramMessage } from "@/services/notify";
import { getMuteUntil, getDefaultClient, setDefaultClient, BOT_SETTING_KEYS } from "@/services/bot-settings";
import type { ClientRecord } from "@/types";

interface TelegramUpdate {
  message?: {
    chat: { id: number };
    message_id: number;
    text?: string;
    from?: { username?: string; first_name?: string };
  };
  callback_query?: {
    id: string;
    from: { username?: string; first_name?: string };
    message?: { chat: { id: number }; message_id: number };
    data?: string;
  };
}

interface BotContext {
  env: AppEnv["Bindings"];
  chatId: number;
}

type CommandHandler = (
  ctx: BotContext,
  args: string[]
) => Promise<string | null>;

async function sendDOCommand(
  env: AppEnv["Bindings"],
  clientId: string,
  command: string,
  params?: Record<string, unknown>
): Promise<boolean> {
  const doId = env.CLIENT_MONITOR.idFromName(clientId);
  const stub = env.CLIENT_MONITOR.get(doId);
  const resp = await stub.fetch("http://internal/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params ? { command, params } : { command }),
  });
  return resp.ok;
}

function buildClientKeyboard(
  clients: { id: string; name: string }[],
  defaultClientId: string | null
) {
  return clients.map((c) => {
    const isDefault = c.id === defaultClientId;
    const label = isDefault ? `\u{2B50} ${c.name} (selected)` : c.name;
    return [{ text: label, callback_data: `select_client:${c.id}` }];
  });
}

const handleClients: CommandHandler = async ({ env }) => {
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.name, c.location, c.last_seen,
      (SELECT COUNT(*) FROM ping_results p WHERE p.client_id = c.id AND p.timestamp > datetime('now', '-5 minutes')) as recent_pings,
      (SELECT rtt_ms FROM ping_results p WHERE p.client_id = c.id ORDER BY p.timestamp DESC LIMIT 1) as last_rtt
    FROM clients c ORDER BY c.name`
  ).all<{
    id: string;
    name: string;
    location: string;
    last_seen: string;
    recent_pings: number;
    last_rtt: number | null;
  }>();

  if (!results?.length) return "No clients registered.";

  const defaultClientId = await getDefaultClient(env.DB);

  const lines = results.map((c) => {
    const lastSeen = new Date(c.last_seen);
    const ago = timeSince(lastSeen);
    const online = Date.now() - lastSeen.getTime() < 120_000;
    const status = online ? "\u{1F7E2}" : "\u{1F534}";
    const rtt = c.last_rtt != null ? `${c.last_rtt.toFixed(1)}ms` : "\u{2014}";
    const loc = c.location ? ` (${c.location})` : "";
    const isDefault = c.id === defaultClientId ? " \u{2B50}" : "";
    return `${status} ${c.name}${loc}${isDefault}\n   RTT: ${rtt} | Last: ${ago}`;
  });

  const keyboard = buildClientKeyboard(results, defaultClientId);

  const text = `\u{1F4E1} Clients (${results.length})\n\n${lines.join("\n\n")}\n\nTap a client below to set it as default:`;

  await sendTelegramMessage(env, text, {
    reply_markup: { inline_keyboard: keyboard },
  });

  return null;
};

const handleStatus: CommandHandler = async ({ env }) => {
  const [stats, muteUntil] = await Promise.all([
    env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM clients) as total_clients,
        (SELECT COUNT(*) FROM clients WHERE last_seen > datetime('now', '-2 minutes')) as online_clients,
        (SELECT COUNT(*) FROM alerts WHERE timestamp > datetime('now', '-1 day')) as alerts_24h,
        (SELECT COUNT(*) FROM alerts WHERE severity = 'critical' AND timestamp > datetime('now', '-1 day')) as critical_24h,
        (SELECT COUNT(*) FROM outages WHERE end_ts IS NULL) as active_outages`
    ).first<{
      total_clients: number;
      online_clients: number;
      alerts_24h: number;
      critical_24h: number;
      active_outages: number;
    }>(),
    getMuteUntil(env.DB),
  ]);

  const muteStatus = muteUntil
    ? `\u{1F515} Muted until ${new Date(muteUntil).toLocaleTimeString()}`
    : "\u{1F514} Notifications active";

  return [
    "\u{1F4CA} PingPulse Status",
    "",
    `Clients: ${stats?.online_clients ?? 0}/${stats?.total_clients ?? 0} online`,
    `Active outages: ${stats?.active_outages ?? 0}`,
    `Alerts (24h): ${stats?.alerts_24h ?? 0} (${stats?.critical_24h ?? 0} critical)`,
    "",
    muteStatus,
  ].join("\n");
};

const handleStart: CommandHandler = async ({ env }, args) => {
  const client = await resolveClient(env.DB, args[0]);
  if (typeof client === "string") return client;
  const ok = await sendDOCommand(env, client.id, "resume");
  return ok
    ? `\u{25B6}\u{FE0F} Resumed monitoring for ${client.name}`
    : `\u{274C} Failed to resume ${client.name}`;
};

const handleStop: CommandHandler = async ({ env }, args) => {
  const client = await resolveClient(env.DB, args[0]);
  if (typeof client === "string") return client;
  const ok = await sendDOCommand(env, client.id, "pause");
  return ok
    ? `\u{23F8}\u{FE0F} Paused monitoring for ${client.name}`
    : `\u{274C} Failed to pause ${client.name}`;
};

const handleAlerts: CommandHandler = async ({ env }, args) => {
  const limit = Math.min(parseInt(args[0] || "5", 10) || 5, 20);

  const { results } = await env.DB.prepare(
    `SELECT a.type, a.severity, a.value, a.threshold, a.timestamp,
      c.name as client_name
    FROM alerts a
    LEFT JOIN clients c ON c.id = a.client_id
    ORDER BY a.timestamp DESC
    LIMIT ?`
  )
    .bind(limit)
    .all<{
      type: string;
      severity: string;
      value: number;
      threshold: number;
      timestamp: string;
      client_name: string | null;
    }>();

  if (!results?.length) return "No recent alerts.";

  const EMOJI: Record<string, string> = {
    critical: "\u{1F534}",
    warning: "\u{1F7E1}",
    info: "\u{1F7E2}",
  };

  const lines = results.map((a) => {
    const emoji = EMOJI[a.severity] || "\u{26AA}";
    const time = timeSince(new Date(a.timestamp));
    const label = a.type.replace(/_/g, " ").toUpperCase();
    return `${emoji} ${label} — ${a.client_name || "?"}\n   ${a.value} (threshold: ${a.threshold}) | ${time}`;
  });

  return `\u{1F6A8} Recent Alerts (${results.length})\n\n${lines.join("\n\n")}`;
};

const handleSpeedtest: CommandHandler = async ({ env }, args) => {
  const client = await resolveClient(env.DB, args[0]);
  if (typeof client === "string") return client;
  const ok = await sendDOCommand(env, client.id, "speed_test", { type: "probe" });
  return ok
    ? `\u{1F3CE}\u{FE0F} Speed test triggered for ${client.name}\nResults will appear shortly.`
    : `\u{274C} Failed to trigger speed test for ${client.name}`;
};

const handleMute: CommandHandler = async ({ env }, args) => {
  const minutes = Math.min(parseInt(args[0] || "30", 10) || 30, 1440);
  const until = Date.now() + minutes * 60_000;

  await env.DB.prepare(
    `INSERT INTO bot_settings (key, value, updated_at) VALUES ('${BOT_SETTING_KEYS.MUTED_UNTIL}', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
    .bind(String(until))
    .run();

  return `\u{1F515} Notifications muted for ${minutes} minutes\nUnmute with /unmute`;
};

const handleUnmute: CommandHandler = async ({ env }) => {
  await env.DB.prepare(
    `DELETE FROM bot_settings WHERE key = '${BOT_SETTING_KEYS.MUTED_UNTIL}'`
  ).run();

  return "\u{1F514} Notifications unmuted";
};

const handlePing: CommandHandler = async ({ env }, args) => {
  const client = await resolveClient(env.DB, args[0]);
  if (typeof client === "string") return client;
  const ok = await sendDOCommand(env, client.id, "request_ping");
  return ok
    ? `\u{1F3D3} Ping requested for ${client.name}`
    : `\u{274C} Failed to ping ${client.name}`;
};

const handleUptime: CommandHandler = async ({ env }, args) => {
  const client = await resolveClient(env.DB, args[0]);
  if (typeof client === "string") return client;

  const since = new Date(Date.now() - 24 * 3600_000).toISOString();

  const [pings, outages] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) as total, SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) as ok
       FROM ping_results WHERE client_id = ? AND timestamp > ?`
    )
      .bind(client.id, since)
      .first<{ total: number; ok: number }>(),
    env.DB.prepare(
      "SELECT COUNT(*) as cnt, COALESCE(SUM(duration_s), 0) as total_s FROM outages WHERE client_id = ? AND start_ts > ?"
    )
      .bind(client.id, since)
      .first<{ cnt: number; total_s: number }>(),
  ]);

  const total = pings?.total ?? 0;
  const ok = pings?.ok ?? 0;
  const uptimePct = total > 0 ? ((ok / total) * 100).toFixed(2) : "N/A";
  const outageCount = outages?.cnt ?? 0;
  const outageTime = formatDuration(outages?.total_s ?? 0);

  return [
    `\u{1F4C8} Uptime — ${client.name} (24h)`,
    "",
    `Uptime: ${uptimePct}%`,
    `Pings: ${ok}/${total} successful`,
    `Outages: ${outageCount} (${outageTime} total)`,
  ].join("\n");
};

const handleHelp: CommandHandler = async () => {
  return [
    "\u{1F916} PingPulse Bot Commands",
    "",
    "/clients — List all clients with status",
    "/status — System overview",
    "/start <name> — Resume monitoring",
    "/stop <name> — Pause monitoring",
    "/alerts [n] — Show last N alerts (default 5)",
    "/speedtest <name> — Trigger speed test",
    "/ping <name> — Force immediate ping",
    "/uptime <name> — 24h uptime stats",
    "/mute [min] — Mute notifications (default 30m)",
    "/unmute — Unmute notifications",
    "/help — This message",
    "",
    "Tap a client in /clients to set it as default.",
    "Commands use the default client if no name given.",
    "Client names are matched fuzzy (partial match OK).",
  ].join("\n");
};

const COMMANDS: Record<string, CommandHandler> = {
  clients: handleClients,
  status: handleStatus,
  start: handleStart,
  stop: handleStop,
  alerts: handleAlerts,
  speedtest: handleSpeedtest,
  mute: handleMute,
  unmute: handleUnmute,
  ping: handlePing,
  uptime: handleUptime,
  help: handleHelp,
};

export const telegramRoutes = new Hono<AppEnv>();

// Webhook — no auth guard, Telegram sends updates here
// Security: only respond if chat_id matches TELEGRAM_CHAT_ID
telegramRoutes.post("/webhook", async (c) => {
  const update: TelegramUpdate = await c.req.json();
  const allowedChat = c.env.TELEGRAM_CHAT_ID;

  // Handle callback queries (inline keyboard button presses)
  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message?.chat.id;

    if (String(chatId) !== allowedChat) return c.json({ ok: true });

    await handleCallbackQuery(c.env, cb);
    return c.json({ ok: true });
  }

  const msg = update.message;
  if (!msg?.text) return c.json({ ok: true });

  // Security: only respond to the configured chat
  if (String(msg.chat.id) !== allowedChat) {
    console.warn(`[telegram] Rejected message from chat ${msg.chat.id}`);
    return c.json({ ok: true });
  }

  // Parse command
  const text = msg.text.trim();
  if (!text.startsWith("/")) return c.json({ ok: true });

  // Strip bot mention (e.g., /status@PingPulseBot)
  const parts = text.slice(1).split(/\s+/);
  const [cmdWithMention = ""] = parts;
  const [cmdRaw = ""] = cmdWithMention.split("@");
  const cmd = cmdRaw.toLowerCase();
  const args = parts.slice(1);

  const handler = COMMANDS[cmd];
  if (!handler) {
    await sendTelegramMessage(
      c.env,
      `Unknown command: /${cmd}\nType /help for available commands.`
    );
    return c.json({ ok: true });
  }

  try {
    const response = await handler({ env: c.env, chatId: msg.chat.id }, args);
    if (response !== null) {
      await sendTelegramMessage(c.env, response);
    }
  } catch (err) {
    console.error(`[telegram] Command /${cmd} failed:`, err);
    await sendTelegramMessage(
      c.env,
      `\u{274C} Error executing /${cmd}: ${err instanceof Error ? err.message : "Unknown error"}`
    );
  }

  return c.json({ ok: true });
});

// Setup — registers webhook URL and bot commands with Telegram
telegramRoutes.post("/setup", authGuard, async (c) => {
  const token = c.env.TELEGRAM_BOT_TOKEN;
  if (!token) return c.json({ error: "TELEGRAM_BOT_TOKEN not set" }, 400);

  const body = await c.req.json<{ webhook_url?: string }>().catch(() => ({ webhook_url: undefined }));
  const webhookUrl =
    body.webhook_url || `${new URL(c.req.url).origin}/api/telegram/webhook`;

  // Set webhook
  const webhookRes = await fetch(
    `https://api.telegram.org/bot${token}/setWebhook`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: webhookUrl,
        allowed_updates: ["message", "callback_query"],
      }),
    }
  );
  const webhookResult = await webhookRes.json();

  // Register commands
  const commandsRes = await fetch(
    `https://api.telegram.org/bot${token}/setMyCommands`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commands: [
          { command: "clients", description: "List all clients with status" },
          { command: "status", description: "System overview" },
          { command: "start", description: "Resume monitoring for a client" },
          { command: "stop", description: "Pause monitoring for a client" },
          { command: "alerts", description: "Show recent alerts" },
          { command: "speedtest", description: "Trigger speed test" },
          { command: "ping", description: "Force immediate ping" },
          { command: "uptime", description: "24h uptime stats for a client" },
          { command: "mute", description: "Mute notifications (default 30m)" },
          { command: "unmute", description: "Unmute notifications" },
          { command: "help", description: "Show available commands" },
        ],
      }),
    }
  );
  const commandsResult = await commandsRes.json();

  return c.json({
    webhook: webhookResult,
    commands: commandsResult,
    webhook_url: webhookUrl,
  });
});

async function resolveClient(
  db: D1Database,
  nameOrId?: string
): Promise<ClientRecord | string> {
  // Fall back to default client if no name given
  if (!nameOrId) {
    const defaultId = await getDefaultClient(db);
    if (!defaultId) return "No client specified and no default set.\nUse /clients to select a default.";
    const defaultClient = await db
      .prepare("SELECT * FROM clients WHERE id = ?")
      .bind(defaultId)
      .first<ClientRecord>();
    if (!defaultClient) return "Default client no longer exists.\nUse /clients to select a new one.";
    return defaultClient;
  }

  // Try exact ID match first
  const byId = await db
    .prepare("SELECT * FROM clients WHERE id = ?")
    .bind(nameOrId)
    .first<ClientRecord>();
  if (byId) return byId;

  // Fuzzy match by name (case-insensitive, partial)
  const { results } = await db
    .prepare("SELECT * FROM clients WHERE LOWER(name) LIKE ?")
    .bind(`%${nameOrId.toLowerCase()}%`)
    .all<ClientRecord>();

  if (!results?.length)
    return `\u{274C} No client found matching "${nameOrId}"`;
  if (results.length > 1) {
    const names = results.map((c) => `  \u{2022} ${c.name}`).join("\n");
    return `Multiple clients match "${nameOrId}":\n${names}\nPlease be more specific.`;
  }
  const match = results[0];
  if (!match) return `\u{274C} No client found matching "${nameOrId}"`;
  return match;
}

async function handleCallbackQuery(
  env: AppEnv["Bindings"],
  cb: NonNullable<TelegramUpdate["callback_query"]>
): Promise<void> {
  const data = cb.data ?? "";
  const token = env.TELEGRAM_BOT_TOKEN;

  if (data.startsWith("select_client:")) {
    const clientId = data.slice("select_client:".length);
    const client = await env.DB.prepare("SELECT id, name FROM clients WHERE id = ?")
      .bind(clientId)
      .first<{ id: string; name: string }>();

    if (!client) {
      await answerCallbackQuery(token, cb.id, "Client not found");
      return;
    }

    await setDefaultClient(env.DB, clientId);
    await answerCallbackQuery(token, cb.id, `\u{2B50} ${client.name} set as default`);

    // Update the inline keyboard to reflect the new selection
    if (cb.message) {
      const { results } = await env.DB.prepare("SELECT id, name FROM clients ORDER BY name")
        .all<{ id: string; name: string }>();

      const keyboard = buildClientKeyboard(results ?? [], clientId);

      await fetch(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: cb.message.chat.id,
          message_id: cb.message.message_id,
          reply_markup: { inline_keyboard: keyboard },
        }),
      });
    }
    return;
  }

  await answerCallbackQuery(token, cb.id, "Unknown action");
}

async function answerCallbackQuery(token: string, callbackQueryId: string, text: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}

function timeSince(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

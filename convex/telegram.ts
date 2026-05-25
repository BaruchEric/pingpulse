import { v } from "convex/values";
import { internalAction, internalQuery } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { getClientDoc } from "./clients";
import { sendTelegramMessage } from "./lib/notify";

const EMOJI: Record<string, string> = {
  critical: "\u{1F534}",
  warning: "\u{1F7E1}",
  info: "\u{1F7E2}",
};

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

// ---- Data queries ----

export const tgClients = internalQuery({
  args: {},
  handler: async (ctx) => {
    const clients = await ctx.db.query("clients").collect();
    clients.sort((a, b) => a.name.localeCompare(b.name));
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();

    const rows = await Promise.all(
      clients.map(async (c) => {
        const recent = await ctx.db
          .query("pingResults")
          .withIndex("by_client_ts", (q) =>
            q.eq("clientId", c.clientId).gte("timestamp", fiveMinAgo),
          )
          .collect();
        const lastPing = await ctx.db
          .query("pingResults")
          .withIndex("by_client_ts", (q) => q.eq("clientId", c.clientId))
          .order("desc")
          .first();
        return {
          id: c.clientId,
          name: c.name,
          location: c.location,
          last_seen: c.lastSeen,
          recent_pings: recent.length,
          last_rtt: lastPing?.rttMs ?? null,
        };
      }),
    );

    const defaultClientId = await ctx.db
      .query("botSettings")
      .withIndex("by_key", (q) => q.eq("key", "default_client"))
      .unique();
    return { clients: rows, defaultClientId: defaultClientId?.value ?? null };
  },
});

export const tgStatus = internalQuery({
  args: {},
  handler: async (ctx) => {
    const clients = await ctx.db.query("clients").collect();
    const twoMinAgo = Date.now() - 2 * 60_000;
    const online = clients.filter(
      (c) => new Date(c.lastSeen).getTime() > twoMinAgo,
    ).length;

    const dayAgo = new Date(Date.now() - 86400_000).toISOString();
    let alerts24h = 0;
    let critical24h = 0;
    for (const c of clients) {
      const alerts = await ctx.db
        .query("alerts")
        .withIndex("by_client_ts", (q) =>
          q.eq("clientId", c.clientId).gte("timestamp", dayAgo),
        )
        .collect();
      alerts24h += alerts.length;
      critical24h += alerts.filter((a) => a.severity === "critical").length;
    }

    const activeOutages = clients.filter((c) => c.currentOutageId != null).length;

    const muteRow = await ctx.db
      .query("botSettings")
      .withIndex("by_key", (q) => q.eq("key", "muted_until"))
      .unique();
    const muteUntil =
      muteRow && parseInt(muteRow.value, 10) > Date.now()
        ? parseInt(muteRow.value, 10)
        : null;

    return {
      total_clients: clients.length,
      online_clients: online,
      alerts_24h: alerts24h,
      critical_24h: critical24h,
      active_outages: activeOutages,
      muteUntil,
    };
  },
});

export const tgAlerts = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, { limit }) => {
    const alerts = await ctx.db.query("alerts").order("desc").take(limit);
    return Promise.all(
      alerts.map(async (a) => {
        const c = await getClientDoc(ctx, a.clientId);
        return {
          type: a.type,
          severity: a.severity,
          value: a.value,
          threshold: a.threshold,
          timestamp: a.timestamp,
          client_name: c?.name ?? null,
        };
      }),
    );
  },
});

export const tgResolveClient = internalQuery({
  args: { nameOrId: v.optional(v.string()) },
  handler: async (ctx, { nameOrId }) => {
    if (!nameOrId) {
      const defaultRow = await ctx.db
        .query("botSettings")
        .withIndex("by_key", (q) => q.eq("key", "default_client"))
        .unique();
      if (!defaultRow) return { error: "no_default" as const };
      const c = await getClientDoc(ctx, defaultRow.value);
      if (!c) return { error: "default_missing" as const };
      return { ok: true as const, id: c.clientId, name: c.name };
    }

    const byId = await getClientDoc(ctx, nameOrId);
    if (byId) return { ok: true as const, id: byId.clientId, name: byId.name };

    const all = await ctx.db.query("clients").collect();
    const matches = all.filter((c) =>
      c.name.toLowerCase().includes(nameOrId.toLowerCase()),
    );
    if (matches.length === 0) return { error: "not_found" as const, nameOrId };
    if (matches.length > 1) {
      return {
        error: "ambiguous" as const,
        names: matches.map((c) => c.name),
        nameOrId,
      };
    }
    const m = matches[0]!;
    return { ok: true as const, id: m.clientId, name: m.name };
  },
});

export const tgUptime = internalQuery({
  args: { clientId: v.string() },
  handler: async (ctx, { clientId }) => {
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    const pings = await ctx.db
      .query("pingResults")
      .withIndex("by_client_ts", (q) =>
        q.eq("clientId", clientId).gte("timestamp", since),
      )
      .take(16000);
    const outages = await ctx.db
      .query("outages")
      .withIndex("by_client_start", (q) =>
        q.eq("clientId", clientId).gte("startTs", since),
      )
      .collect();

    const total = pings.length;
    const ok = pings.filter((p) => p.status === "ok").length;
    const outageTimeS = outages.reduce((s, o) => s + (o.durationS ?? 0), 0);
    return { total, ok, outageCount: outages.length, outageTimeS };
  },
});

// ---- Telegram API helpers ----

async function tgApi(method: string, body: unknown): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function buildClientKeyboard(
  clients: { id: string; name: string }[],
  defaultClientId: string | null,
) {
  return clients.map((c) => {
    const isDefault = c.id === defaultClientId;
    const label = isDefault ? `\u{2B50} ${c.name} (selected)` : c.name;
    return [{ text: label, callback_data: `select_client:${c.id}` }];
  });
}

const HELP = [
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

interface TelegramUpdate {
  message?: {
    chat: { id: number };
    text?: string;
  };
  callback_query?: {
    id: string;
    message?: { chat: { id: number }; message_id: number };
    data?: string;
  };
}

export const handleUpdate = internalAction({
  args: { update: v.any() },
  handler: async (ctx, { update }) => {
    const u = update as TelegramUpdate;
    const allowedChat = process.env.TELEGRAM_CHAT_ID;

    if (u.callback_query) {
      const cb = u.callback_query;
      if (String(cb.message?.chat.id) !== allowedChat) return;
      const data = cb.data ?? "";
      if (data.startsWith("select_client:")) {
        const clientId = data.slice("select_client:".length);
        const client = await ctx.runQuery(internal.clients.getOne, { clientId });
        if (!client) {
          await tgApi("answerCallbackQuery", { callback_query_id: cb.id, text: "Client not found" });
          return;
        }
        await ctx.runMutation(internal.botSettings.setDefaultClient, { clientId });
        await tgApi("answerCallbackQuery", {
          callback_query_id: cb.id,
          text: `\u{2B50} ${client.name} set as default`,
        });
        if (cb.message) {
          const { clients } = await ctx.runQuery(internal.telegram.tgClients, {});
          await tgApi("editMessageReplyMarkup", {
            chat_id: cb.message.chat.id,
            message_id: cb.message.message_id,
            reply_markup: { inline_keyboard: buildClientKeyboard(clients, clientId) },
          });
        }
      } else {
        await tgApi("answerCallbackQuery", { callback_query_id: cb.id, text: "Unknown action" });
      }
      return;
    }

    const msg = u.message;
    if (!msg?.text) return;
    if (String(msg.chat.id) !== allowedChat) return;
    const text = msg.text.trim();
    if (!text.startsWith("/")) return;

    const parts = text.slice(1).split(/\s+/);
    const cmd = (parts[0] ?? "").split("@")[0]!.toLowerCase();
    const args = parts.slice(1);

    try {
      const reply = await runCommand(ctx, cmd, args);
      if (reply !== null) await sendTelegramMessage(reply);
    } catch (err) {
      await sendTelegramMessage(
        `\u{274C} Error executing /${cmd}: ${err instanceof Error ? err.message : "Unknown error"}`,
      );
    }
  },
});

async function resolveOrMessage(
  ctx: ActionCtx,
  nameOrId?: string,
): Promise<{ id: string; name: string } | string> {
  const r = await ctx.runQuery(internal.telegram.tgResolveClient, { nameOrId });
  if ("ok" in r) return { id: r.id as string, name: r.name as string };
  switch (r.error) {
    case "no_default":
      return "No client specified and no default set.\nUse /clients to select a default.";
    case "default_missing":
      return "Default client no longer exists.\nUse /clients to select a new one.";
    case "ambiguous":
      return `Multiple clients match "${r.nameOrId}":\n${r.names.map((n) => `  • ${n}`).join("\n")}\nPlease be more specific.`;
    default:
      return `\u{274C} No client found matching "${r.nameOrId}"`;
  }
}

async function runCommand(
  ctx: ActionCtx,
  cmd: string,
  args: string[],
): Promise<string | null> {
  switch (cmd) {
    case "help":
      return HELP;

    case "clients": {
      const { clients, defaultClientId } = await ctx.runQuery(
        internal.telegram.tgClients,
        {},
      );
      if (clients.length === 0) return "No clients registered.";
      const lines = clients.map((c) => {
        const lastSeen = new Date(c.last_seen);
        const online = Date.now() - lastSeen.getTime() < 120_000;
        const status = online ? "\u{1F7E2}" : "\u{1F534}";
        const rtt = c.last_rtt != null ? `${c.last_rtt.toFixed(1)}ms` : "—";
        const loc = c.location ? ` (${c.location})` : "";
        const isDefault = c.id === defaultClientId ? " \u{2B50}" : "";
        return `${status} ${c.name}${loc}${isDefault}\n   RTT: ${rtt} | Last: ${timeSince(lastSeen)}`;
      });
      await tgApi("sendMessage", {
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text: `\u{1F4E1} Clients (${clients.length})\n\n${lines.join("\n\n")}\n\nTap a client below to set it as default:`,
        reply_markup: { inline_keyboard: buildClientKeyboard(clients, defaultClientId) },
      });
      return null;
    }

    case "status": {
      const s = await ctx.runQuery(internal.telegram.tgStatus, {});
      const muteStatus = s.muteUntil
        ? `\u{1F515} Muted until ${new Date(s.muteUntil).toLocaleTimeString()}`
        : "\u{1F514} Notifications active";
      return [
        "\u{1F4CA} PingPulse Status",
        "",
        `Clients: ${s.online_clients}/${s.total_clients} online`,
        `Active outages: ${s.active_outages}`,
        `Alerts (24h): ${s.alerts_24h} (${s.critical_24h} critical)`,
        "",
        muteStatus,
      ].join("\n");
    }

    case "start": {
      const c = await resolveOrMessage(ctx, args[0]);
      if (typeof c === "string") return c;
      await ctx.runMutation(internal.commands.enqueue, { clientId: c.id, command: "resume" });
      return `\u{25B6}\u{FE0F} Resumed monitoring for ${c.name}`;
    }

    case "stop": {
      const c = await resolveOrMessage(ctx, args[0]);
      if (typeof c === "string") return c;
      await ctx.runMutation(internal.commands.enqueue, { clientId: c.id, command: "pause" });
      return `\u{23F8}\u{FE0F} Paused monitoring for ${c.name}`;
    }

    case "speedtest": {
      const c = await resolveOrMessage(ctx, args[0]);
      if (typeof c === "string") return c;
      const res = await ctx.runMutation(internal.commands.enqueue, {
        clientId: c.id,
        command: "speed_test",
        params: { test_type: "probe" },
      });
      return "ok" in res && res.ok
        ? `\u{1F3CE}\u{FE0F} Speed test triggered for ${c.name}\nResults will appear shortly.`
        : `\u{274C} ${c.name} is not connected`;
    }

    case "ping": {
      const c = await resolveOrMessage(ctx, args[0]);
      if (typeof c === "string") return c;
      const res = await ctx.runMutation(internal.commands.enqueue, {
        clientId: c.id,
        command: "request_ping",
      });
      return "ok" in res && res.ok
        ? `\u{1F3D3} Ping requested for ${c.name}`
        : `\u{274C} ${c.name} is not connected`;
    }

    case "alerts": {
      const limit = Math.min(parseInt(args[0] || "5", 10) || 5, 20);
      const alerts = await ctx.runQuery(internal.telegram.tgAlerts, { limit });
      if (alerts.length === 0) return "No recent alerts.";
      const lines = alerts.map((a) => {
        const emoji = EMOJI[a.severity] || "⚪";
        const label = a.type.replace(/_/g, " ").toUpperCase();
        return `${emoji} ${label} — ${a.client_name || "?"}\n   ${a.value} (threshold: ${a.threshold}) | ${timeSince(new Date(a.timestamp))}`;
      });
      return `\u{1F6A8} Recent Alerts (${alerts.length})\n\n${lines.join("\n\n")}`;
    }

    case "uptime": {
      const c = await resolveOrMessage(ctx, args[0]);
      if (typeof c === "string") return c;
      const u = await ctx.runQuery(internal.telegram.tgUptime, { clientId: c.id });
      const uptimePct = u.total > 0 ? ((u.ok / u.total) * 100).toFixed(2) : "N/A";
      return [
        `\u{1F4C8} Uptime — ${c.name} (24h)`,
        "",
        `Uptime: ${uptimePct}%`,
        `Pings: ${u.ok}/${u.total} successful`,
        `Outages: ${u.outageCount} (${formatDuration(u.outageTimeS)} total)`,
      ].join("\n");
    }

    case "mute": {
      const minutes = Math.min(parseInt(args[0] || "30", 10) || 30, 1440);
      await ctx.runMutation(internal.botSettings.setMute, {
        until: Date.now() + minutes * 60_000,
      });
      return `\u{1F515} Notifications muted for ${minutes} minutes\nUnmute with /unmute`;
    }

    case "unmute": {
      await ctx.runMutation(internal.botSettings.clearMute, {});
      return "\u{1F514} Notifications unmuted";
    }

    default:
      return `Unknown command: /${cmd}\nType /help for available commands.`;
  }
}

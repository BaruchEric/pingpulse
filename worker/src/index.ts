import { createRouter } from "@/api/router";
import { ClientMonitor } from "@/durable-objects/client-monitor";
import { archiveOldRecords } from "@/services/archiver";
import { runAnalysis } from "@/services/analysis-queries";
import { formatTelegramReport, formatEmailReport } from "@/services/health-report";

export { ClientMonitor };

export interface Env {
  DB: D1Database;
  ARCHIVE: R2Bucket;
  METRICS: AnalyticsEngineDataset;
  CLIENT_MONITOR: DurableObjectNamespace;
  ADMIN_JWT_SECRET: string;
  RESEND_API_KEY: string;
  ALERT_FROM_EMAIL: string;
  ALERT_TO_EMAIL: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  LATEST_CLIENT_VERSION: string;
}

const app = createRouter();

async function applyPerClientRetention(env: Env): Promise<void> {
  const allClients = await env.DB.prepare(
    "SELECT id, config_json FROM clients"
  ).all<{ id: string; config_json: string }>();

  for (const client of allClients.results ?? []) {
    const config = JSON.parse(client.config_json || "{}");
    const rawDays = config.retention_raw_days ?? 30;
    const archiveToR2 = config.retention_archive_to_r2 ?? true;
    const cutoff = Date.now() - rawDays * 24 * 60 * 60 * 1000;

    if (archiveToR2) {
      const oldProbes = await env.DB.prepare(
        "SELECT * FROM client_probe_results WHERE client_id = ? AND timestamp < ?"
      ).bind(client.id, cutoff).all();

      if ((oldProbes.results?.length ?? 0) > 0) {
        const results = oldProbes.results ?? [];
        const firstRow = results[0];
        const headers = Object.keys(firstRow ?? {});
        const csv = [headers.join(","), ...results.map(row =>
          headers.map(h => JSON.stringify((row as Record<string, unknown>)[h] ?? "")).join(",")
        )].join("\n");
        const key = `archive/${client.id}/probes/${new Date().toISOString().slice(0, 10)}.csv`;
        await env.ARCHIVE.put(key, csv);
      }
    }

    await env.DB.prepare(
      "DELETE FROM client_probe_results WHERE client_id = ? AND timestamp < ?"
    ).bind(client.id, cutoff).run();

    await env.DB.prepare(
      "DELETE FROM ping_results WHERE client_id = ? AND timestamp < ?"
    ).bind(client.id, cutoff).run();
  }
}

async function generateHealthReports(env: Env): Promise<void> {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcDay = now.getUTCDay(); // 0 = Sunday, 1 = Monday

  // Query clients active in last 7 days (wider window for weekly reports)
  const { results: clients } = await env.DB.prepare(
    "SELECT id, name, config_json FROM clients WHERE last_seen > ?"
  )
    .bind(new Date(Date.now() - 7 * 86400_000).toISOString())
    .all<{ id: string; name: string; config_json: string }>();

  for (const client of clients ?? []) {
    const config = JSON.parse(client.config_json || "{}");
    const schedule: string = config.report_schedule ?? "daily";
    const channels: string[] = config.report_channels ?? ["telegram", "email"];

    if (schedule === "off") continue;
    if (schedule === "daily" && utcHour !== 0) continue;
    if (schedule === "weekly" && (utcHour !== 0 || utcDay !== 1)) continue;
    // "6h" runs every cron tick — no filter needed

    const windowMs = schedule === "weekly" ? 7 * 86400_000 : schedule === "6h" ? 6 * 3600_000 : 86400_000;
    const from = new Date(Date.now() - windowMs).toISOString();
    const to = now.toISOString();

    try {
      const data = await runAnalysis(env.DB, client.id, from, to);

      if (channels.includes("telegram") && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
        const message = formatTelegramReport(client.name, from, to, data);
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: message }),
        }).catch((err) => console.error(`[health-report] Telegram failed for ${client.id}:`, err));
      }

      if (channels.includes("email") && env.RESEND_API_KEY) {
        const html = formatEmailReport(client.name, from, to, data);
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.RESEND_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: env.ALERT_FROM_EMAIL || "PingPulse <alerts@ping.beric.ca>",
            to: [env.ALERT_TO_EMAIL || "admin@beric.ca"],
            subject: `[PingPulse] Health Report — ${client.name}`,
            html,
          }),
        }).catch((err) => console.error(`[health-report] Email failed for ${client.id}:`, err));
      }
    } catch (err) {
      console.error(`[health-report] Failed for client ${client.id}:`, err);
    }
  }
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade for client connections
    if (
      url.pathname.startsWith("/ws/") &&
      request.headers.get("Upgrade") === "websocket"
    ) {
      const clientId = url.pathname.split("/ws/")[1];
      if (!clientId) return new Response("Missing client ID", { status: 400 });

      const id = env.CLIENT_MONITOR.idFromName(clientId);
      const stub = env.CLIENT_MONITOR.get(id);
      return stub.fetch(request);
    }

    return app.fetch(request, env, ctx);
  },

  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    // Only fan out to recently active clients for speed tests
    const { results: activeClients } = await env.DB.prepare(
      "SELECT id FROM clients WHERE last_seen > ?"
    )
      .bind(new Date(Date.now() - 86400_000).toISOString())
      .all();

    // Push speed test triggers and archive work into waitUntil
    ctx.waitUntil(
      Promise.all([
        Promise.allSettled(
          activeClients.map((client) => {
            const doId = env.CLIENT_MONITOR.idFromName(client.id as string);
            const stub = env.CLIENT_MONITOR.get(doId);
            return stub.fetch("http://internal/trigger-speed-test", {
              method: "POST",
            });
          })
        ),
        archiveOldRecords(env, 30),
        env.DB.prepare(
          "DELETE FROM rate_limits WHERE window_start < ?"
        )
          .bind(new Date(Date.now() - 3600_000).toISOString())
          .run(),
        // Per-client retention policy
        applyPerClientRetention(env),
        generateHealthReports(env),
      ])
    );
  },
};

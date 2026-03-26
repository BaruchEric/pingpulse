import { createRouter } from "@/api/router";
import { ClientMonitor } from "@/durable-objects/client-monitor";
import { archiveOldRecords } from "@/services/archiver";
import { runAnalysis } from "@/services/analysis-queries";
import { formatTelegramReport, formatEmailReport } from "@/services/health-report";
import { sendTelegramMessage, sendResendEmail } from "@/services/notify";
import type { Env } from "@/types";

export { ClientMonitor };
export type { Env };

const app = createRouter();

async function applyPerClientRetention(env: Env): Promise<void> {
  const allClients = await env.DB.prepare(
    "SELECT id, config_json FROM clients"
  ).all<{ id: string; config_json: string }>();

  const stmts = (allClients.results ?? []).flatMap((client) => {
    const config = JSON.parse(client.config_json || "{}");
    const rawDays = config.retention_raw_days ?? 30;
    const cutoff = Date.now() - rawDays * 24 * 60 * 60 * 1000;
    return [
      env.DB.prepare("DELETE FROM client_probe_results WHERE client_id = ? AND timestamp < ?").bind(client.id, cutoff),
      env.DB.prepare("DELETE FROM ping_results WHERE client_id = ? AND timestamp < ?").bind(client.id, cutoff),
    ];
  });
  if (stmts.length > 0) await env.DB.batch(stmts);
}

async function generateHealthReports(env: Env): Promise<void> {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcDay = now.getUTCDay(); // 0 = Sunday, 1 = Monday

  // Query clients active in last 7 days (wider window for weekly reports)
  const { results: clients } = await env.DB.prepare(
    "SELECT id, name, config_json, last_seen FROM clients WHERE last_seen > ?"
  )
    .bind(new Date(Date.now() - 7 * 86400_000).toISOString())
    .all<{ id: string; name: string; config_json: string; last_seen: string }>();

  await Promise.allSettled(
    (clients ?? []).map(async (client) => {
      const config = JSON.parse(client.config_json || "{}");
      const schedule: string = config.report_schedule ?? "daily";
      const channels: ("telegram" | "email")[] = config.report_channels ?? ["telegram", "email"];

      if (schedule === "off") return;
      if (schedule === "daily" && utcHour !== 0) return;
      if (schedule === "weekly" && (utcHour !== 0 || utcDay !== 1)) return;
      // "6h" runs every cron tick — no filter needed

      const windowMs = schedule === "weekly" ? 7 * 86400_000 : schedule === "6h" ? 6 * 3600_000 : 86400_000;
      const from = new Date(now.getTime() - windowMs).toISOString();
      const to = now.toISOString();

      try {
        const data = await runAnalysis(env.DB, client.id, from, to);
        const gracePeriod = (config.down_alert_grace_seconds ?? config.grace_period_s ?? 60) * 1000;
        const isDown = Date.now() - new Date(client.last_seen).getTime() > gracePeriod;

        if (channels.includes("telegram")) {
          const message = formatTelegramReport(client.name, from, to, data, isDown);
          await sendTelegramMessage(env, message);
        }

        if (channels.includes("email")) {
          const html = formatEmailReport(client.name, from, to, data, isDown);
          await sendResendEmail(env, `[PingPulse] Health Report — ${client.name}`, { html });
        }
      } catch (err) {
        console.error(`[health-report] Failed for client ${client.id}:`, err);
      }
    })
  );
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
      Promise.allSettled([
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
        applyPerClientRetention(env),
        generateHealthReports(env),
      ])
    );
  },
};

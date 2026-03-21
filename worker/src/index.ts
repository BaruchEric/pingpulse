import { createRouter } from "@/api/router";
import { ClientMonitor } from "@/durable-objects/client-monitor";
import { archiveOldRecords } from "@/services/archiver";

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
      ])
    );
  },
};

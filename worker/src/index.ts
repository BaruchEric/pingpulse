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
}

const app = createRouter();

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
    // Only fan out to recently active clients
    const { results: clients } = await env.DB.prepare(
      "SELECT id FROM clients WHERE last_seen > ?"
    )
      .bind(new Date(Date.now() - 86400_000).toISOString())
      .all();

    // Push speed test triggers and archive work into waitUntil
    ctx.waitUntil(
      Promise.all([
        Promise.allSettled(
          clients.map((client) => {
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
      ])
    );
  },
};

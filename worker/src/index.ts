import { createRouter } from "@/api/router";
import { ClientMonitor } from "@/durable-objects/client-monitor";

export { ClientMonitor };

export interface Env {
  DB: D1Database;
  ARCHIVE: R2Bucket;
  METRICS: AnalyticsEngineDataset;
  CLIENT_MONITOR: DurableObjectNamespace;
  ADMIN_JWT_SECRET: string;
  RESEND_API_KEY: string;
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

    // Speed test payload endpoints (no auth — client uses these during test)
    if (url.pathname === "/speedtest/download") {
      const size = parseInt(url.searchParams.get("size") || "262144");
      const totalSize = Math.min(size, 25 * 1024 * 1024);
      const payload = new Uint8Array(totalSize);
      // getRandomValues() has a 64KB limit per call
      const CHUNK = 65536;
      for (let i = 0; i < totalSize; i += CHUNK) {
        const end = Math.min(i + CHUNK, totalSize);
        crypto.getRandomValues(payload.subarray(i, end));
      }
      return new Response(payload, {
        headers: { "Content-Type": "application/octet-stream" },
      });
    }

    if (url.pathname === "/speedtest/upload" && request.method === "POST") {
      const body = await request.arrayBuffer();
      return new Response(JSON.stringify({ received_bytes: body.byteLength }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return app.fetch(request, env, ctx);
  },

  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    const { archiveOldRecords } = await import("@/services/archiver");

    // Trigger full speed test on each connected client
    const { results: clients } = await env.DB.prepare(
      "SELECT id FROM clients"
    ).all();

    for (const client of clients) {
      const doId = env.CLIENT_MONITOR.idFromName(client.id as string);
      const stub = env.CLIENT_MONITOR.get(doId);
      try {
        await stub.fetch("http://internal/trigger-speed-test", {
          method: "POST",
        });
      } catch {
        // Client may not be connected
      }
    }

    // Archive old records + clean up rate limit table
    ctx.waitUntil(
      Promise.all([
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

import { Hono } from "hono";
import type { AppEnv } from "@/middleware/auth-guard";
import { authGuard } from "@/middleware/auth-guard";
import { rateLimit } from "@/middleware/rate-limit";

export const speedtestRoutes = new Hono<AppEnv>();

// Payload endpoints — no auth (client uses these during test)
speedtestRoutes.get("/download", (c) => {
  const size = parseInt(c.req.query("size") || "262144");
  const totalSize = Math.min(size, 25 * 1024 * 1024);
  const CHUNK = 65536;
  let remaining = totalSize;

  const stream = new ReadableStream({
    pull(controller) {
      const chunkSize = Math.min(CHUNK, remaining);
      const chunk = new Uint8Array(chunkSize);
      crypto.getRandomValues(chunk);
      controller.enqueue(chunk);
      remaining -= chunkSize;
      if (remaining <= 0) controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(totalSize),
    },
  });
});

speedtestRoutes.post("/upload", async (c) => {
  const body = await c.req.arrayBuffer();
  return c.json({ received_bytes: body.byteLength });
});

// Trigger speed test on a client — auth required
speedtestRoutes.post(
  "/:id",
  authGuard,
  rateLimit({ maxRequests: 10, windowMs: 60_000, prefix: "speedtest" }),
  async (c) => {
    const clientId = c.req.param("id");
    if (!clientId) return c.json({ error: "Missing client ID" }, 400);

    const client = await c.env.DB.prepare(
      "SELECT id FROM clients WHERE id = ?"
    )
      .bind(clientId)
      .first();
    if (!client) return c.json({ error: "Client not found" }, 404);

    const doId = c.env.CLIENT_MONITOR.idFromName(clientId);
    const stub = c.env.CLIENT_MONITOR.get(doId);

    try {
      await stub.fetch("http://internal/trigger-speed-test", {
        method: "POST",
      });
    } catch {
      // Client may not be connected
    }

    return c.json({ ok: true, message: "Speed test triggered" });
  }
);

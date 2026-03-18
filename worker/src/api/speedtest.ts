import { Hono } from "hono";
import type { AppEnv } from "@/middleware/auth-guard";
import { authGuard } from "@/middleware/auth-guard";
import { rateLimit } from "@/middleware/rate-limit";

export const speedtestRoutes = new Hono<AppEnv>();

// Payload endpoints — no auth (client uses these during test)
speedtestRoutes.get("/download", (c) => {
  const size = parseInt(c.req.query("size") || "262144");
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
});

speedtestRoutes.post("/upload", async (c) => {
  const body = await c.req.arrayBuffer();
  return c.json({ received_bytes: body.byteLength });
});

// Trigger speed test on a client — auth required
speedtestRoutes.post(
  "/:id",
  authGuard,
  rateLimit({ maxRequests: 1, windowMs: 300_000, prefix: "speedtest" }),
  async (c) => {
    const clientId = c.req.param("id")!;

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

import { Hono } from "hono";
import type { Env } from "@/index";
import { authGuard } from "@/middleware/auth-guard";
import { rateLimit } from "@/middleware/rate-limit";

export const speedtestRoutes = new Hono<{ Bindings: Env }>();

speedtestRoutes.use("*", authGuard);

speedtestRoutes.post(
  "/:id",
  rateLimit({ maxRequests: 1, windowMs: 300_000, prefix: "speedtest" }),
  async (c) => {
    const clientId = c.req.param("id");

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

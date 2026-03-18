import { Hono } from "hono";
import type { AppEnv } from "@/middleware/auth-guard";
import { rateLimit } from "@/middleware/rate-limit";
import { authRoutes } from "@/api/auth";
import { clientRoutes } from "@/api/clients";
import { metricsRoutes } from "@/api/metrics";
import { alertRoutes } from "@/api/alerts";
import { speedtestRoutes } from "@/api/speedtest";
import { exportRoutes } from "@/api/export";
import { commandRoutes } from "@/api/command";

export function createRouter() {
  const app = new Hono<AppEnv>();

  // Global rate limit: 60 req/min per IP
  app.use("/api/*", rateLimit({ maxRequests: 60, windowMs: 60_000 }));

  // Health check (no auth)
  app.get("/api/health", (c) =>
    c.json({ status: "ok", timestamp: new Date().toISOString() })
  );

  // Auth routes (handle their own auth internally)
  app.route("/api/auth", authRoutes);

  // Client self-delete (authenticated with client secret, not admin JWT)
  app.delete("/api/clients/:id/self", async (c) => {
    const id = c.req.param("id");
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "Missing or invalid Authorization header" }, 401);
    }
    const secret = authHeader.slice(7);

    const { hashString } = await import("@/utils/hash");
    const client = await c.env.DB.prepare(
      "SELECT id, secret_hash FROM clients WHERE id = ?"
    )
      .bind(id)
      .first<{ id: string; secret_hash: string }>();

    if (!client) {
      return c.json({ error: "Client not found" }, 404);
    }

    const secretHash = await hashString(secret);
    if (secretHash !== client.secret_hash) {
      return c.json({ error: "Invalid client secret" }, 403);
    }

    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM ping_results WHERE client_id = ?").bind(id),
      c.env.DB.prepare("DELETE FROM speed_tests WHERE client_id = ?").bind(id),
      c.env.DB.prepare("DELETE FROM outages WHERE client_id = ?").bind(id),
      c.env.DB.prepare("DELETE FROM alerts WHERE client_id = ?").bind(id),
      c.env.DB.prepare("DELETE FROM clients WHERE id = ?").bind(id),
    ]);

    return c.json({ ok: true });
  });

  // Protected routes — auth applied per-route-file via .use("*", authGuard)
  app.route("/api/clients", clientRoutes);
  app.route("/api/metrics", metricsRoutes);
  app.route("/api/alerts", alertRoutes);
  app.route("/api/speedtest", speedtestRoutes);
  // Also mount at /speedtest for client-facing payload endpoints (no /api prefix)
  app.route("/speedtest", speedtestRoutes);
  app.route("/api/export", exportRoutes);
  app.route("/api/command", commandRoutes);

  return app;
}

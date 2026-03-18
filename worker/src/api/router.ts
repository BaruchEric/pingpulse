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

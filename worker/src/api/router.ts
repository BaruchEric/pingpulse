import { Hono } from "hono";
import type { Env } from "@/index";
import { rateLimit } from "@/middleware/rate-limit";
import { authRoutes } from "@/api/auth";
import { clientRoutes } from "@/api/clients";
import { metricsRoutes } from "@/api/metrics";

export function createRouter() {
  const app = new Hono<{ Bindings: Env }>();

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
  app.route("/api/clients", metricsRoutes);

  return app;
}

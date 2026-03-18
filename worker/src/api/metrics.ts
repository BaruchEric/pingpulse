import { Hono } from "hono";
import type { AppEnv } from "@/middleware/auth-guard";
import { authGuard } from "@/middleware/auth-guard";

export const metricsRoutes = new Hono<AppEnv>();

metricsRoutes.use("*", authGuard);

// GET /api/metrics/:id?from=ISO&to=ISO
metricsRoutes.get("/:id", async (c) => {
  const id = c.req.param("id");
  const from =
    c.req.query("from") ||
    new Date(Date.now() - 3600_000).toISOString();
  const to = c.req.query("to") || new Date().toISOString();

  const [{ results: pings }, { results: speedTests }, { results: outages }] =
    await Promise.all([
      c.env.DB.prepare(
        "SELECT timestamp, rtt_ms, jitter_ms, direction, status FROM ping_results WHERE client_id = ? AND timestamp BETWEEN ? AND ? ORDER BY timestamp DESC"
      )
        .bind(id, from, to)
        .all(),
      c.env.DB.prepare(
        "SELECT timestamp, type, download_mbps, upload_mbps, payload_bytes, duration_ms FROM speed_tests WHERE client_id = ? AND timestamp BETWEEN ? AND ? ORDER BY timestamp DESC"
      )
        .bind(id, from, to)
        .all(),
      c.env.DB.prepare(
        "SELECT start_ts, end_ts, duration_s FROM outages WHERE client_id = ? AND start_ts BETWEEN ? AND ? ORDER BY start_ts DESC"
      )
        .bind(id, from, to)
        .all(),
    ]);

  // Calculate summary
  const okPings = pings.filter(
    (p: Record<string, unknown>) => p.status === "ok"
  );
  const rtts = okPings.map((p: Record<string, unknown>) => p.rtt_ms as number);
  const sorted = [...rtts].sort((a, b) => a - b);

  const summary = {
    total_pings: pings.length,
    ok_pings: okPings.length,
    timeout_pings: pings.filter(
      (p: Record<string, unknown>) => p.status === "timeout"
    ).length,
    loss_pct:
      pings.length > 0
        ? ((pings.length - okPings.length) / pings.length) * 100
        : 0,
    avg_rtt_ms:
      rtts.length > 0
        ? rtts.reduce((a, b) => a + b, 0) / rtts.length
        : 0,
    min_rtt_ms: sorted[0] || 0,
    max_rtt_ms: sorted[sorted.length - 1] || 0,
    p50_rtt_ms: sorted[Math.floor(sorted.length * 0.5)] || 0,
    p95_rtt_ms: sorted[Math.floor(sorted.length * 0.95)] || 0,
    p99_rtt_ms: sorted[Math.floor(sorted.length * 0.99)] || 0,
  };

  return c.json({ pings, speed_tests: speedTests, outages, summary });
});

// GET /api/metrics/:id/logs?limit=50&offset=0
metricsRoutes.get("/:id/logs", async (c) => {
  const id = c.req.param("id");
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") || "50") || 50, 1), 200);
  const offset = Math.max(parseInt(c.req.query("offset") || "0") || 0, 0);

  const countRow = await c.env.DB.prepare(
    "SELECT COUNT(*) as total FROM ping_results WHERE client_id = ?"
  )
    .bind(id)
    .first<{ total: number }>();

  const { results: logs } = await c.env.DB.prepare(
    "SELECT id, timestamp, rtt_ms, jitter_ms, direction, status FROM ping_results WHERE client_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?"
  )
    .bind(id, limit, offset)
    .all();

  return c.json({ logs, total: countRow?.total || 0, limit, offset });
});

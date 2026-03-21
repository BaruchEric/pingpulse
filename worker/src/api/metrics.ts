import { Hono } from "hono";
import type { AppEnv } from "@/middleware/auth-guard";
import { authGuard } from "@/middleware/auth-guard";
import { parsePagination } from "@/utils/pagination";

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
  const { limit, offset } = parsePagination((k) => c.req.query(k));

  const [countRow, { results: logs }] = await Promise.all([
    c.env.DB.prepare(
      "SELECT COUNT(*) as total FROM ping_results WHERE client_id = ?"
    )
      .bind(id)
      .first<{ total: number }>(),
    c.env.DB.prepare(
      "SELECT id, timestamp, rtt_ms, jitter_ms, direction, status FROM ping_results WHERE client_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?"
    )
      .bind(id, limit, offset)
      .all(),
  ]);

  return c.json({ logs, total: countRow?.total || 0, limit, offset });
});

// GET /api/metrics/:clientId/probes?from=&to=&type=
metricsRoutes.get("/:clientId/probes", async (c) => {
  const clientId = c.req.param("clientId");
  const from =
    c.req.query("from") ?? String(Date.now() - 24 * 60 * 60 * 1000);
  const to = c.req.query("to") ?? String(Date.now());
  const probeType = c.req.query("type"); // optional: "icmp" | "http"

  let sql = `SELECT timestamp, probe_type, target, rtt_ms, status_code, status, jitter_ms
             FROM client_probe_results
             WHERE client_id = ? AND timestamp >= ? AND timestamp <= ?`;
  const params: unknown[] = [clientId, Number(from), Number(to)];

  if (probeType) {
    sql += " AND probe_type = ?";
    params.push(probeType);
  }

  sql += " ORDER BY timestamp ASC LIMIT 10000";

  const results = await c.env.DB.prepare(sql)
    .bind(...params)
    .all();
  return c.json({ data: results.results ?? [] });
});

// GET /api/metrics/:clientId/sync-status
metricsRoutes.get("/:clientId/sync-status", async (c) => {
  const clientId = c.req.param("clientId");

  const latest = await c.env.DB.prepare(
    `SELECT MAX(received_at) as last_sync, COUNT(*) as total_records,
            MAX(timestamp) as latest_probe_ts
     FROM client_probe_results WHERE client_id = ?`
  )
    .bind(clientId)
    .first<{
      last_sync: number;
      total_records: number;
      latest_probe_ts: number;
    }>();

  return c.json({
    last_sync: latest?.last_sync ?? null,
    total_records: latest?.total_records ?? 0,
    latest_probe_ts: latest?.latest_probe_ts ?? null,
  });
});

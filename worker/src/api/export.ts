import { Hono } from "hono";
import type { AppEnv } from "@/middleware/auth-guard";
import { authGuard } from "@/middleware/auth-guard";
import { requireClient } from "@/utils/do-client";

export const exportRoutes = new Hono<AppEnv>();

exportRoutes.use("*", authGuard);

exportRoutes.get("/:id", async (c) => {
  const clientId = c.req.param("id");
  const format = c.req.query("format") || "json";
  const from =
    c.req.query("from") ||
    new Date(Date.now() - 7 * 86400_000).toISOString();
  const to = c.req.query("to") || new Date().toISOString();

  if (!await requireClient(c.env.DB, clientId)) return c.json({ error: "Client not found" }, 404);

  // Fetch pings and speed tests in parallel (limit to prevent OOM on large ranges)
  const MAX_EXPORT_ROWS = 100_000;
  const [{ results: pings }, { results: speedTests }] = await Promise.all([
    c.env.DB.prepare(
      `SELECT * FROM ping_results WHERE client_id = ? AND timestamp BETWEEN ? AND ? ORDER BY timestamp LIMIT ${MAX_EXPORT_ROWS}`
    )
      .bind(clientId, from, to)
      .all(),
    c.env.DB.prepare(
      `SELECT * FROM speed_tests WHERE client_id = ? AND timestamp BETWEEN ? AND ? ORDER BY timestamp LIMIT ${MAX_EXPORT_ROWS}`
    )
      .bind(clientId, from, to)
      .all(),
  ]);

  if (format === "csv") {
    let csv = "# Ping Results\n";
    const esc = (v: unknown) => JSON.stringify(String(v ?? ""));
    csv += "timestamp,rtt_ms,jitter_ms,direction,status\n";
    csv += pings
      .map(
        (p: Record<string, unknown>) =>
          [p.timestamp, p.rtt_ms, p.jitter_ms, p.direction, p.status].map(esc).join(",")
      )
      .join("\n");

    csv += "\n\n# Speed Tests\n";
    csv += "timestamp,type,download_mbps,upload_mbps,payload_bytes,duration_ms\n";
    csv += speedTests
      .map(
        (s: Record<string, unknown>) =>
          [s.timestamp, s.type, s.download_mbps, s.upload_mbps, s.payload_bytes, s.duration_ms].map(esc).join(",")
      )
      .join("\n");

    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="pingpulse-${clientId}.csv"`,
      },
    });
  }

  return c.json({
    client_id: clientId,
    from,
    to,
    ping_results: pings,
    speed_tests: speedTests,
  });
});

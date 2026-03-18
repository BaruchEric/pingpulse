import { Hono } from "hono";
import type { AppEnv } from "@/middleware/auth-guard";
import { authGuard } from "@/middleware/auth-guard";

export const exportRoutes = new Hono<AppEnv>();

exportRoutes.use("*", authGuard);

exportRoutes.get("/:id", async (c) => {
  const clientId = c.req.param("id");
  const format = c.req.query("format") || "json";
  const from =
    c.req.query("from") ||
    new Date(Date.now() - 7 * 86400_000).toISOString();
  const to = c.req.query("to") || new Date().toISOString();

  // Verify client exists
  const client = await c.env.DB.prepare(
    "SELECT id FROM clients WHERE id = ?"
  )
    .bind(clientId)
    .first();
  if (!client) return c.json({ error: "Client not found" }, 404);

  // Fetch pings and speed tests in parallel
  const [{ results: pings }, { results: speedTests }] = await Promise.all([
    c.env.DB.prepare(
      "SELECT * FROM ping_results WHERE client_id = ? AND timestamp BETWEEN ? AND ? ORDER BY timestamp"
    )
      .bind(clientId, from, to)
      .all(),
    c.env.DB.prepare(
      "SELECT * FROM speed_tests WHERE client_id = ? AND timestamp BETWEEN ? AND ? ORDER BY timestamp"
    )
      .bind(clientId, from, to)
      .all(),
  ]);

  if (format === "csv") {
    let csv = "# Ping Results\n";
    csv += "timestamp,rtt_ms,jitter_ms,direction,status\n";
    csv += pings
      .map(
        (p: Record<string, unknown>) =>
          `${p.timestamp},${p.rtt_ms},${p.jitter_ms},${p.direction},${p.status}`
      )
      .join("\n");

    csv += "\n\n# Speed Tests\n";
    csv += "timestamp,type,download_mbps,upload_mbps,payload_bytes,duration_ms\n";
    csv += speedTests
      .map(
        (s: Record<string, unknown>) =>
          `${s.timestamp},${s.type},${s.download_mbps},${s.upload_mbps},${s.payload_bytes},${s.duration_ms}`
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

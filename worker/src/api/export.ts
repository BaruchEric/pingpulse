import { Hono } from "hono";
import type { Env } from "@/index";
import { authGuard } from "@/middleware/auth-guard";

export const exportRoutes = new Hono<{ Bindings: Env }>();

exportRoutes.use("*", authGuard);

exportRoutes.get("/:id", async (c) => {
  const clientId = c.req.param("id");
  const format = c.req.query("format") || "json";
  const from =
    c.req.query("from") ||
    new Date(Date.now() - 7 * 86400_000).toISOString();
  const to = c.req.query("to") || new Date().toISOString();

  const { results: pings } = await c.env.DB.prepare(
    "SELECT * FROM ping_results WHERE client_id = ? AND timestamp BETWEEN ? AND ? ORDER BY timestamp"
  )
    .bind(clientId, from, to)
    .all();

  const { results: speedTests } = await c.env.DB.prepare(
    "SELECT * FROM speed_tests WHERE client_id = ? AND timestamp BETWEEN ? AND ? ORDER BY timestamp"
  )
    .bind(clientId, from, to)
    .all();

  const data = {
    client_id: clientId,
    from,
    to,
    ping_results: pings,
    speed_tests: speedTests,
  };

  if (format === "csv") {
    const header = "timestamp,rtt_ms,jitter_ms,direction,status\n";
    const rows = pings
      .map(
        (p: Record<string, unknown>) =>
          `${p.timestamp},${p.rtt_ms},${p.jitter_ms},${p.direction},${p.status}`
      )
      .join("\n");
    return new Response(header + rows, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="pingpulse-${clientId}.csv"`,
      },
    });
  }

  return c.json(data);
});

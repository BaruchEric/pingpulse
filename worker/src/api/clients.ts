import { Hono } from "hono";
import type { AppEnv } from "@/middleware/auth-guard";
import { authGuard } from "@/middleware/auth-guard";
import { deleteClientCascade } from "@/utils/client-db";

export const clientRoutes = new Hono<AppEnv>();

clientRoutes.use("*", authGuard);

clientRoutes.get("/", async (c) => {
  const [clientsResult, pingStatsResult, speedTestResult] = await c.env.DB.batch([
    c.env.DB.prepare(
      "SELECT id, name, location, config_json, created_at, last_seen FROM clients ORDER BY created_at DESC"
    ),
    c.env.DB.prepare(`
      SELECT
        client_id,
        AVG(rtt_ms) as avg_rtt_ms,
        CAST(SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END) AS REAL) * 100.0 / COUNT(*) as loss_pct
      FROM (
        SELECT client_id, rtt_ms, status
        FROM ping_results p1
        WHERE rowid IN (
          SELECT rowid FROM ping_results p2
          WHERE p2.client_id = p1.client_id
          ORDER BY timestamp DESC
          LIMIT 10
        )
      )
      GROUP BY client_id
    `),
    c.env.DB.prepare(`
      SELECT st.client_id, st.download_mbps, st.upload_mbps, st.timestamp
      FROM speed_tests st
      INNER JOIN (
        SELECT client_id, MAX(timestamp) as max_ts
        FROM speed_tests
        GROUP BY client_id
      ) latest ON st.client_id = latest.client_id AND st.timestamp = latest.max_ts
    `),
  ]);

  type PingStatRow = { client_id: string; avg_rtt_ms: number | null; loss_pct: number | null };
  type SpeedTestRow = { client_id: string; download_mbps: number; upload_mbps: number; timestamp: string };

  const pingStatsMap = new Map<string, PingStatRow>(
    (pingStatsResult.results as PingStatRow[]).map((r) => [r.client_id, r])
  );
  const speedTestMap = new Map<string, SpeedTestRow>(
    (speedTestResult.results as SpeedTestRow[]).map((r) => [r.client_id, r])
  );

  const clients = (clientsResult.results as Record<string, unknown>[]).map((r) => {
    const clientId = r.id as string;
    const pingStat = pingStatsMap.get(clientId);
    const speedTest = speedTestMap.get(clientId);

    return {
      id: r.id,
      name: r.name,
      location: r.location,
      config: JSON.parse(r.config_json as string),
      created_at: r.created_at,
      last_seen: r.last_seen,
      stats: {
        avg_rtt_ms: pingStat?.avg_rtt_ms ?? null,
        loss_pct: pingStat?.loss_pct ?? null,
        last_speed_test: speedTest
          ? {
              download_mbps: speedTest.download_mbps,
              upload_mbps: speedTest.upload_mbps,
              timestamp: speedTest.timestamp,
            }
          : null,
      },
    };
  });

  return c.json({ clients });
});

clientRoutes.get("/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare(
    "SELECT id, name, location, config_json, created_at, last_seen FROM clients WHERE id = ?"
  )
    .bind(id)
    .first();

  if (!row) return c.json({ error: "Client not found" }, 404);

  return c.json({
    ...row,
    config: JSON.parse(row.config_json as string),
  });
});

clientRoutes.put("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{
    name?: string;
    location?: string;
    config?: Record<string, unknown>;
  }>();

  const existing = await c.env.DB.prepare(
    "SELECT id, config_json FROM clients WHERE id = ?"
  )
    .bind(id)
    .first();
  if (!existing) return c.json({ error: "Client not found" }, 404);

  const updates: string[] = [];
  const values: unknown[] = [];

  if (body.name !== undefined) {
    updates.push("name = ?");
    values.push(body.name);
  }
  if (body.location !== undefined) {
    updates.push("location = ?");
    values.push(body.location);
  }
  if (body.config !== undefined) {
    const merged = {
      ...JSON.parse(existing.config_json as string),
      ...body.config,
    };
    updates.push("config_json = ?");
    values.push(JSON.stringify(merged));
  }

  if (updates.length === 0)
    return c.json({ error: "Nothing to update" }, 400);

  values.push(id);
  await c.env.DB.prepare(
    `UPDATE clients SET ${updates.join(", ")} WHERE id = ?`
  )
    .bind(...values)
    .run();

  return c.json({ ok: true });
});

clientRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");

  // Notify the connected agent BEFORE deleting data so the WebSocket
  // deregistration message reaches the client while auth records still exist
  try {
    const doId = c.env.CLIENT_MONITOR.idFromName(id);
    const stub = c.env.CLIENT_MONITOR.get(doId);
    await stub.fetch(new Request("http://do/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "deregister" }),
    }));
  } catch {
    // Best effort — agent may not be connected
  }

  const { deleted } = await deleteClientCascade(c.env.DB, id);
  if (!deleted) {
    return c.json({ error: "Client not found" }, 404);
  }
  return c.json({ ok: true });
});

import { Hono } from "hono";
import type { AppEnv } from "@/middleware/auth-guard";
import { authGuard } from "@/middleware/auth-guard";
import { dispatchAlert } from "@/services/alert-dispatch";
import { parsePagination } from "@/utils/pagination";

export const alertRoutes = new Hono<AppEnv>();

alertRoutes.use("*", authGuard);

alertRoutes.get("/", async (c) => {
  const { limit, offset } = parsePagination((k) => c.req.query(k));
  const clientId = c.req.query("client_id");

  let query = "SELECT * FROM alerts";
  const params: unknown[] = [];

  if (clientId) {
    query += " WHERE client_id = ?";
    params.push(clientId);
  }

  query += " ORDER BY timestamp DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);

  const { results } = await c.env.DB.prepare(query).bind(...params).all();
  return c.json({ alerts: results });
});

alertRoutes.put("/", async (c) => {
  const body = await c.req.json<{
    default_latency_threshold_ms?: number;
    default_loss_threshold_pct?: number;
  }>();

  if (
    body.default_latency_threshold_ms === undefined &&
    body.default_loss_threshold_pct === undefined
  ) {
    return c.json({ error: "Nothing to update" }, 400);
  }

  // Build a single UPDATE statement instead of N individual updates
  const updates: string[] = [];
  const values: unknown[] = [];

  // Update thresholds stored as JSON fields — use json_set for atomic update
  if (body.default_latency_threshold_ms !== undefined) {
    updates.push("config_json = json_set(config_json, '$.alert_latency_threshold_ms', ?)");
    values.push(body.default_latency_threshold_ms);
  }
  if (body.default_loss_threshold_pct !== undefined) {
    updates.push("config_json = json_set(config_json, '$.alert_loss_threshold_pct', ?)");
    values.push(body.default_loss_threshold_pct);
  }

  await c.env.DB.prepare(
    `UPDATE clients SET ${updates.join(", ")}`
  )
    .bind(...values)
    .run();

  return c.json({ ok: true });
});

alertRoutes.post("/test", async (c) => {
  await dispatchAlert(c.env, {
    alert_id: "test",
    client_id: "test",
    type: "high_latency",
    severity: "info",
    value: 0,
    threshold: 0,
    timestamp: new Date().toISOString(),
    message: "This is a test alert from PingPulse",
  });
  return c.json({ ok: true });
});

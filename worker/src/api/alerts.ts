import { Hono } from "hono";
import type { Env } from "@/index";
import { authGuard } from "@/middleware/auth-guard";

export const alertRoutes = new Hono<{ Bindings: Env }>();

alertRoutes.use("*", authGuard);

alertRoutes.get("/", async (c) => {
  const limit = parseInt(c.req.query("limit") || "50");
  const offset = parseInt(c.req.query("offset") || "0");
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
    body.default_latency_threshold_ms !== undefined ||
    body.default_loss_threshold_pct !== undefined
  ) {
    const { results: clients } = await c.env.DB.prepare(
      "SELECT id, config_json FROM clients"
    ).all();

    for (const client of clients) {
      const config = JSON.parse(client.config_json as string);
      if (body.default_latency_threshold_ms !== undefined) {
        config.alert_latency_threshold_ms = body.default_latency_threshold_ms;
      }
      if (body.default_loss_threshold_pct !== undefined) {
        config.alert_loss_threshold_pct = body.default_loss_threshold_pct;
      }
      await c.env.DB.prepare(
        "UPDATE clients SET config_json = ? WHERE id = ?"
      )
        .bind(JSON.stringify(config), client.id)
        .run();
    }
  }

  return c.json({ ok: true });
});

alertRoutes.post("/test", async (c) => {
  const { dispatchAlert } = await import("@/services/alert-dispatch");
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

import { Hono } from "hono";
import type { Env } from "@/index";
import { authGuard } from "@/middleware/auth-guard";

export const clientRoutes = new Hono<{ Bindings: Env }>();

clientRoutes.use("*", authGuard);

clientRoutes.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, name, location, config_json, created_at, last_seen FROM clients ORDER BY created_at DESC"
  ).all();

  const clients = results.map((r: Record<string, unknown>) => ({
    id: r.id,
    name: r.name,
    location: r.location,
    config: JSON.parse(r.config_json as string),
    created_at: r.created_at,
    last_seen: r.last_seen,
  }));

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

  const existing = await c.env.DB.prepare(
    "SELECT id FROM clients WHERE id = ?"
  )
    .bind(id)
    .first();
  if (!existing) return c.json({ error: "Client not found" }, 404);

  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM ping_results WHERE client_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM speed_tests WHERE client_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM outages WHERE client_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM alerts WHERE client_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM clients WHERE id = ?").bind(id),
  ]);

  return c.json({ ok: true });
});

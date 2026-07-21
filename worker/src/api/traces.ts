import { Hono } from "hono";
import type { AppEnv } from "@/middleware/auth-guard";
import { authGuard } from "@/middleware/auth-guard";

export const traceRoutes = new Hono<AppEnv>();

traceRoutes.use("*", authGuard);

// Recent path traces for a client (summary rows, newest first).
traceRoutes.get("/:id/traces", async (c) => {
  const clientId = c.req.param("id");
  const result = await c.env.DB.prepare(
    `SELECT id, target, protocol, started_at, trigger, received_at
     FROM traces WHERE client_id = ? ORDER BY started_at DESC LIMIT 20`
  )
    .bind(clientId)
    .all();
  return c.json({ traces: result.results ?? [] });
});

// A single trace with its hops, ordered by ttl.
traceRoutes.get("/:id/traces/:traceId", async (c) => {
  const clientId = c.req.param("id");
  const traceId = c.req.param("traceId");

  const trace = await c.env.DB.prepare(
    `SELECT id, target, protocol, started_at, trigger, received_at
     FROM traces WHERE id = ? AND client_id = ?`
  )
    .bind(traceId, clientId)
    .first();

  if (!trace) return c.json({ error: "Trace not found" }, 404);

  const hops = await c.env.DB.prepare(
    `SELECT ttl, addr, hostname, asn, asn_name, geo,
            loss_pct, samples, last_ms, avg_ms, best_ms, worst_ms, stddev_ms, jitter_ms
     FROM trace_hops WHERE trace_id = ? ORDER BY ttl ASC`
  )
    .bind(traceId)
    .all();

  return c.json({ trace, hops: hops.results ?? [] });
});

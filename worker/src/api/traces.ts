import { Hono } from "hono";
import type { AppEnv } from "@/middleware/auth-guard";
import { authGuard } from "@/middleware/auth-guard";
import { enrichAddrs, hasEnrichment, isPublicIpv4 } from "@/services/enrich";

interface TraceHopRow {
  flow_id: number;
  ttl: number;
  addr: string | null;
  hostname: string | null;
  asn: number | null;
  asn_name: string | null;
  geo: string | null;
  loss_pct: number | null;
  samples: number | null;
  last_ms: number | null;
  avg_ms: number | null;
  best_ms: number | null;
  worst_ms: number | null;
  stddev_ms: number | null;
  jitter_ms: number | null;
}

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

  const hopsRes = await c.env.DB.prepare(
    `SELECT flow_id, ttl, addr, hostname, asn, asn_name, geo,
            loss_pct, samples, last_ms, avg_ms, best_ms, worst_ms, stddev_ms, jitter_ms
     FROM trace_hops WHERE trace_id = ? ORDER BY flow_id ASC, ttl ASC`
  )
    .bind(traceId)
    .all<TraceHopRow>();

  const hops = hopsRes.results ?? [];

  // Lazily enrich hops with ASN / country / reverse-DNS the first time a trace
  // is viewed, then persist so later reads are free. Best-effort: lookup
  // failures leave the columns null and the trace is still returned.
  const pending = hops.filter(
    (h): h is TraceHopRow & { addr: string } =>
      h.asn == null && typeof h.addr === "string" && isPublicIpv4(h.addr)
  );
  if (pending.length > 0) {
    const enrichment = await enrichAddrs(pending.map((h) => h.addr));
    // Persist enrichment keyed by addr (deduped): enrichment is a function of
    // the address, and with multipath multiple flows can share a ttl with
    // different addrs — keying the UPDATE by ttl would corrupt them.
    const persisted = new Set<string>();
    const updates = [];
    for (const h of hops) {
      const e = h.addr ? enrichment.get(h.addr) : undefined;
      if (!e || !hasEnrichment(e)) continue;
      h.hostname = e.hostname;
      h.asn = e.asn;
      h.asn_name = e.asn_name;
      h.geo = e.geo;
      if (h.addr && !persisted.has(h.addr)) {
        persisted.add(h.addr);
        updates.push(
          c.env.DB.prepare(
            `UPDATE trace_hops SET hostname = ?, asn = ?, asn_name = ?, geo = ?
             WHERE trace_id = ? AND addr = ?`
          ).bind(e.hostname, e.asn, e.asn_name, e.geo, traceId, h.addr)
        );
      }
    }
    if (updates.length > 0) await c.env.DB.batch(updates);
  }

  return c.json({ trace, hops });
});

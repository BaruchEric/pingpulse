import { Hono } from "hono";
import type { AppEnv } from "@/middleware/auth-guard";
import type { SyncBatch, SyncResponse } from "@/types";
import { clientSecretAuth } from "@/middleware/client-auth";

export const syncRoutes = new Hono<AppEnv>();

syncRoutes.post("/:clientId/sync", clientSecretAuth, async (c) => {
  const clientId = c.req.param("clientId");
  const batch: SyncBatch = await c.req.json();

  if (!batch.session_id || !Array.isArray(batch.records) || batch.records.length === 0) {
    return c.json({ error: "Invalid sync batch" }, 400);
  }

  if (batch.records.length > 500) {
    return c.json({ error: "Batch too large, max 500" }, 400);
  }

  const now = Date.now();
  let maxSeq = 0;

  // Batch insert with ON CONFLICT IGNORE for idempotency
  const stmt = c.env.DB.prepare(
    `INSERT INTO client_probe_results
     (client_id, session_id, seq_id, probe_type, target, timestamp, rtt_ms, status_code, status, jitter_ms, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(client_id, session_id, seq_id) DO NOTHING`
  );

  const stmts = batch.records.map((r) => {
    if (r.seq_id > maxSeq) maxSeq = r.seq_id;
    return stmt.bind(
      clientId,
      batch.session_id,
      r.seq_id,
      r.probe_type,
      r.target,
      r.timestamp,
      r.rtt_ms,
      r.status_code,
      r.status,
      r.jitter_ms,
      now
    );
  });

  await c.env.DB.batch(stmts);

  // Also write to Analytics Engine for aggregated view
  for (const r of batch.records) {
    if (r.rtt_ms != null) {
      c.env.METRICS.writeDataPoint({
        blobs: [clientId, r.probe_type, r.target, r.status],
        doubles: [r.rtt_ms, r.jitter_ms ?? 0],
        indexes: [clientId],
      });
    }
  }

  const response: SyncResponse = { acked_seq: maxSeq };
  return c.json(response);
});

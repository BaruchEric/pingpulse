import type { D1Database } from "@cloudflare/workers-types";

/** Delete a client and all associated data (ping_results, speed_tests, outages, alerts). */
export async function deleteClientCascade(db: D1Database, id: string) {
  const results = await db.batch([
    db.prepare("DELETE FROM ping_results WHERE client_id = ?").bind(id),
    db.prepare("DELETE FROM speed_tests WHERE client_id = ?").bind(id),
    db.prepare("DELETE FROM outages WHERE client_id = ?").bind(id),
    db.prepare("DELETE FROM alerts WHERE client_id = ?").bind(id),
    db.prepare("DELETE FROM clients WHERE id = ?").bind(id),
  ]);

  const clientDeleteResult = results[results.length - 1];
  return { deleted: !!(clientDeleteResult?.meta.changes) };
}

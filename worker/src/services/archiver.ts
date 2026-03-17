import type { Env } from "@/index";

export async function archiveOldRecords(
  env: Env,
  retentionDays: number = 30
): Promise<number> {
  const cutoff = new Date(
    Date.now() - retentionDays * 86400_000
  ).toISOString();
  let totalArchived = 0;

  const { results: clients } = await env.DB.prepare(
    "SELECT id FROM clients"
  ).all();

  for (const client of clients) {
    const clientId = client.id as string;

    const { results: oldPings } = await env.DB.prepare(
      "SELECT * FROM ping_results WHERE client_id = ? AND timestamp < ? ORDER BY timestamp"
    )
      .bind(clientId, cutoff)
      .all();

    if (oldPings.length === 0) continue;

    const { results: oldSpeedTests } = await env.DB.prepare(
      "SELECT * FROM speed_tests WHERE client_id = ? AND timestamp < ? ORDER BY timestamp"
    )
      .bind(clientId, cutoff)
      .all();

    const archive = {
      client_id: clientId,
      archived_at: new Date().toISOString(),
      retention_days: retentionDays,
      ping_results: oldPings,
      speed_tests: oldSpeedTests,
    };

    // Write to R2 as gzipped JSON
    const now = new Date();
    const path = `archive/${clientId}/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")}.json.gz`;

    const jsonData = new TextEncoder().encode(JSON.stringify(archive));
    const cs = new CompressionStream("gzip");
    const writer = cs.writable.getWriter();
    writer.write(jsonData);
    writer.close();
    const gzipped = await new Response(cs.readable).arrayBuffer();

    await env.ARCHIVE.put(path, gzipped, {
      httpMetadata: { contentType: "application/gzip" },
    });

    // Delete archived records from D1
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM ping_results WHERE client_id = ? AND timestamp < ?"
      ).bind(clientId, cutoff),
      env.DB.prepare(
        "DELETE FROM speed_tests WHERE client_id = ? AND timestamp < ?"
      ).bind(clientId, cutoff),
    ]);

    totalArchived += oldPings.length;
  }

  return totalArchived;
}

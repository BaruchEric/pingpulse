import type { D1Database } from "@cloudflare/workers-types";
import type { Env } from "@/index";

const DELETE_BATCH_SIZE = 500;
const SELECT_PAGE_SIZE = 5000;

async function selectAllPaged(
  db: D1Database,
  sql: string,
  bindings: unknown[],
): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  let offset = 0;
  while (true) {
    const { results } = await db.prepare(`${sql} LIMIT ${SELECT_PAGE_SIZE} OFFSET ${offset}`)
      .bind(...bindings)
      .all();
    all.push(...results);
    if (results.length < SELECT_PAGE_SIZE) break;
    offset += SELECT_PAGE_SIZE;
  }
  return all;
}

async function archiveClient(
  env: Env,
  clientId: string,
  cutoff: string
): Promise<number> {
  const [oldPings, oldSpeedTests] = await Promise.all([
    selectAllPaged(env.DB, "SELECT * FROM ping_results WHERE client_id = ? AND timestamp < ?", [clientId, cutoff]),
    selectAllPaged(env.DB, "SELECT * FROM speed_tests WHERE client_id = ? AND timestamp < ?", [clientId, cutoff]),
  ]);

  if (oldPings.length === 0 && oldSpeedTests.length === 0) return 0;

  const archive = {
    client_id: clientId,
    archived_at: new Date().toISOString(),
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

  // Delete archived records in batches
  const deleteInBatches = async (table: string, idCol: string) => {
    const ids = (table === "ping_results" ? oldPings : oldSpeedTests).map(
      (r) => r.id as string
    );
    for (let i = 0; i < ids.length; i += DELETE_BATCH_SIZE) {
      const batch = ids.slice(i, i + DELETE_BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(",");
      await env.DB.prepare(
        `DELETE FROM ${table} WHERE ${idCol} IN (${placeholders})`
      )
        .bind(...batch)
        .run();
    }
  };

  await deleteInBatches("ping_results", "id");
  await deleteInBatches("speed_tests", "id");

  return oldPings.length + oldSpeedTests.length;
}

export async function archiveOldRecords(
  env: Env,
  retentionDays: number = 30
): Promise<number> {
  const cutoff = new Date(
    Date.now() - retentionDays * 86400_000
  ).toISOString();

  const { results: clients } = await env.DB.prepare(
    "SELECT id FROM clients"
  ).all();

  const results = await Promise.all(
    clients.map((client) => archiveClient(env, client.id as string, cutoff))
  );

  return results.reduce((sum, n) => sum + n, 0);
}

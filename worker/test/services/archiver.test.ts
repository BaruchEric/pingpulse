import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { archiveOldRecords } from "@/services/archiver";
import { hashString } from "@/utils/hash";

describe("archiveOldRecords", () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM clients");
    await env.DB.exec("DELETE FROM ping_results");
    await env.DB.exec("DELETE FROM speed_tests");

    const hash = await hashString("s");
    await env.DB.prepare(
      "INSERT INTO clients (id, name, location, secret_hash, config_json, created_at, last_seen) VALUES ('c1', 'Home', 'Toronto', ?, '{}', ?, ?)"
    )
      .bind(hash, new Date().toISOString(), new Date().toISOString())
      .run();

    // Insert old records (31 days ago)
    const oldDate = new Date(Date.now() - 31 * 86400_000).toISOString();
    for (let i = 0; i < 3; i++) {
      await env.DB.prepare(
        "INSERT INTO ping_results (id, client_id, timestamp, rtt_ms, jitter_ms, direction, status) VALUES (?, 'c1', ?, 25, 1, 'cf_to_client', 'ok')"
      )
        .bind(`old-${i}`, oldDate)
        .run();
    }

    // Insert recent record
    await env.DB.prepare(
      "INSERT INTO ping_results (id, client_id, timestamp, rtt_ms, jitter_ms, direction, status) VALUES ('recent', 'c1', ?, 25, 1, 'cf_to_client', 'ok')"
    )
      .bind(new Date().toISOString())
      .run();
  });

  it("archives old ping results to R2 and deletes from D1", async () => {
    const archived = await archiveOldRecords(env, 30);

    // Old records should be deleted from D1
    const { results } = await env.DB.prepare(
      "SELECT id FROM ping_results"
    ).all();
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("recent");

    // R2 should have an archive file
    const objects = await env.ARCHIVE.list({ prefix: "archive/c1/" });
    expect(objects.objects.length).toBeGreaterThan(0);

    // Verify the file is gzipped
    const key = objects.objects[0].key;
    expect(key).toContain(".json.gz");

    expect(archived).toBe(3);
  });

  it("skips clients with no old records", async () => {
    // Delete old records, keep only recent
    await env.DB.exec("DELETE FROM ping_results WHERE id != 'recent'");

    const archived = await archiveOldRecords(env, 30);
    expect(archived).toBe(0);
  });
});

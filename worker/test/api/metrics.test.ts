import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { createRouter } from "@/api/router";
import { hashString } from "@/utils/hash";

const app = createRouter();
let adminCookie: string;

async function setup() {
  await env.DB.exec("DELETE FROM admin");
  await env.DB.exec("DELETE FROM clients");
  await env.DB.exec("DELETE FROM ping_results");
  await env.DB.exec("DELETE FROM speed_tests");
  await env.DB.exec("DELETE FROM rate_limits");

  const hash = await hashString("testpass123");
  await env.DB.prepare(
    "INSERT INTO admin (id, password_hash, created_at) VALUES (1, ?, ?)"
  )
    .bind(hash, new Date().toISOString())
    .run();

  const res = await app.request(
    "/api/auth/login",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "testpass123" }),
    },
    env
  );
  const { token } = await res.json<{ token: string }>();
  adminCookie = `session=${token}`;

  // Seed client + ping data
  const secretHash = await hashString("s");
  await env.DB.prepare(
    "INSERT INTO clients (id, name, location, secret_hash, config_json, created_at, last_seen) VALUES ('c1', 'Home', 'Toronto', ?, '{}', ?, ?)"
  )
    .bind(secretHash, new Date().toISOString(), new Date().toISOString())
    .run();

  const now = new Date();
  for (let i = 0; i < 5; i++) {
    const ts = new Date(now.getTime() - i * 30_000).toISOString();
    await env.DB.prepare(
      "INSERT INTO ping_results (id, client_id, timestamp, rtt_ms, jitter_ms, direction, status) VALUES (?, 'c1', ?, ?, ?, 'cf_to_client', 'ok')"
    )
      .bind(crypto.randomUUID(), ts, 20 + i, 1.5)
      .run();
  }
}

describe("GET /api/clients/:id/metrics", () => {
  beforeEach(setup);

  it("returns metrics for time range", async () => {
    const from = new Date(Date.now() - 3600_000).toISOString();
    const to = new Date().toISOString();
    const res = await app.request(
      `/api/clients/c1/metrics?from=${from}&to=${to}`,
      { headers: { Cookie: adminCookie } },
      env
    );
    expect(res.status).toBe(200);
    const data = await res.json<{
      pings: unknown[];
      summary: { avg_rtt_ms: number };
    }>();
    expect(data.pings.length).toBeGreaterThan(0);
    expect(data.summary.avg_rtt_ms).toBeGreaterThan(0);
  });
});

describe("GET /api/clients/:id/logs", () => {
  beforeEach(setup);

  it("returns paginated logs", async () => {
    const res = await app.request(
      "/api/clients/c1/logs?limit=3&offset=0",
      { headers: { Cookie: adminCookie } },
      env
    );
    expect(res.status).toBe(200);
    const data = await res.json<{ logs: unknown[]; total: number }>();
    expect(data.logs).toHaveLength(3);
    expect(data.total).toBe(5);
  });
});

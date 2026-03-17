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

  const secretHash = await hashString("s");
  await env.DB.prepare(
    "INSERT INTO clients (id, name, location, secret_hash, config_json, created_at, last_seen) VALUES ('c1', 'Home', 'Toronto', ?, '{}', ?, ?)"
  )
    .bind(secretHash, new Date().toISOString(), new Date().toISOString())
    .run();

  await env.DB.prepare(
    "INSERT INTO ping_results (id, client_id, timestamp, rtt_ms, jitter_ms, direction, status) VALUES ('p1', 'c1', ?, 25, 1.5, 'cf_to_client', 'ok')"
  )
    .bind(new Date().toISOString())
    .run();
}

describe("GET /api/export/:id", () => {
  beforeEach(setup);

  it("exports as JSON by default", async () => {
    const res = await app.request(
      "/api/export/c1",
      { headers: { Cookie: adminCookie } },
      env
    );
    expect(res.status).toBe(200);
    const data = await res.json<{ ping_results: unknown[] }>();
    expect(data.ping_results.length).toBeGreaterThan(0);
  });

  it("exports as CSV when format=csv", async () => {
    const res = await app.request(
      "/api/export/c1?format=csv",
      { headers: { Cookie: adminCookie } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv");
    const text = await res.text();
    expect(text).toContain("timestamp,rtt_ms");
  });

  it("returns 401 without auth", async () => {
    const res = await app.request("/api/export/c1", {}, env);
    expect(res.status).toBe(401);
  });
});

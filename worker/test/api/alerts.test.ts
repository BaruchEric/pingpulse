import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { createRouter } from "@/api/router";
import { hashString } from "@/utils/hash";

const app = createRouter();
let adminCookie: string;

async function setup() {
  await env.DB.exec("DELETE FROM admin");
  await env.DB.exec("DELETE FROM clients");
  await env.DB.exec("DELETE FROM alerts");
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

  // Seed client
  const secretHash = await hashString("s");
  await env.DB.prepare(
    "INSERT INTO clients (id, name, location, secret_hash, config_json, created_at, last_seen) VALUES ('c1', 'Home', 'Toronto', ?, '{\"alert_latency_threshold_ms\":100}', ?, ?)"
  )
    .bind(secretHash, new Date().toISOString(), new Date().toISOString())
    .run();

  // Seed alert
  await env.DB.prepare(
    "INSERT INTO alerts (id, client_id, type, severity, value, threshold, timestamp) VALUES (?, 'c1', 'high_latency', 'warning', 150, 100, ?)"
  )
    .bind(crypto.randomUUID(), new Date().toISOString())
    .run();
}

describe("GET /api/alerts", () => {
  beforeEach(setup);

  it("lists all alerts", async () => {
    const res = await app.request(
      "/api/alerts",
      { headers: { Cookie: adminCookie } },
      env
    );
    expect(res.status).toBe(200);
    const data = await res.json<{ alerts: unknown[] }>();
    expect(data.alerts).toHaveLength(1);
  });
});

describe("PUT /api/alerts", () => {
  beforeEach(setup);

  it("updates default thresholds across all clients", async () => {
    const res = await app.request(
      "/api/alerts",
      {
        method: "PUT",
        headers: {
          Cookie: adminCookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ default_latency_threshold_ms: 200 }),
      },
      env
    );
    expect(res.status).toBe(200);

    // Verify client config was updated
    const client = await env.DB.prepare(
      "SELECT config_json FROM clients WHERE id = 'c1'"
    ).first<{ config_json: string }>();

    const config = JSON.parse(client!.config_json);
    expect(config.alert_latency_threshold_ms).toBe(200);
  });
});

describe("POST /api/speedtest/:id", () => {
  beforeEach(setup);

  it("triggers a speed test", async () => {
    const res = await app.request(
      "/api/speedtest/c1",
      {
        method: "POST",
        headers: { Cookie: adminCookie },
      },
      env
    );
    expect(res.status).toBe(200);
  });

  it("returns 404 for unknown client", async () => {
    const res = await app.request(
      "/api/speedtest/unknown",
      {
        method: "POST",
        headers: { Cookie: adminCookie },
      },
      env
    );
    expect(res.status).toBe(404);
  });
});

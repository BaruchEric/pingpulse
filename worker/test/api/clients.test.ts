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

  // Seed a client
  const secretHash = await hashString("client-secret");
  await env.DB.prepare(
    "INSERT INTO clients (id, name, location, secret_hash, config_json, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(
      "c1",
      "Home",
      "Toronto",
      secretHash,
      '{"ping_interval_s":30}',
      new Date().toISOString(),
      new Date().toISOString()
    )
    .run();
}

describe("GET /api/clients", () => {
  beforeEach(setup);

  it("lists all clients", async () => {
    const res = await app.request(
      "/api/clients",
      { headers: { Cookie: adminCookie } },
      env
    );
    expect(res.status).toBe(200);
    const data = await res.json<{ clients: unknown[] }>();
    expect(data.clients).toHaveLength(1);
  });

  it("returns 401 without auth", async () => {
    const res = await app.request("/api/clients", {}, env);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/clients/:id", () => {
  beforeEach(setup);

  it("returns client details", async () => {
    const res = await app.request(
      "/api/clients/c1",
      { headers: { Cookie: adminCookie } },
      env
    );
    expect(res.status).toBe(200);
    const data = await res.json<{ name: string }>();
    expect(data.name).toBe("Home");
  });

  it("returns 404 for unknown client", async () => {
    const res = await app.request(
      "/api/clients/unknown",
      { headers: { Cookie: adminCookie } },
      env
    );
    expect(res.status).toBe(404);
  });
});

describe("PUT /api/clients/:id", () => {
  beforeEach(setup);

  it("updates client config", async () => {
    const res = await app.request(
      "/api/clients/c1",
      {
        method: "PUT",
        headers: {
          Cookie: adminCookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Office",
          location: "Montreal",
          config: { ping_interval_s: 60 },
        }),
      },
      env
    );
    expect(res.status).toBe(200);

    const check = await app.request(
      "/api/clients/c1",
      { headers: { Cookie: adminCookie } },
      env
    );
    const data = await check.json<{ name: string }>();
    expect(data.name).toBe("Office");
  });
});

describe("DELETE /api/clients/:id", () => {
  beforeEach(setup);

  it("deletes a client", async () => {
    const res = await app.request(
      "/api/clients/c1",
      {
        method: "DELETE",
        headers: { Cookie: adminCookie },
      },
      env
    );
    expect(res.status).toBe(200);

    const check = await app.request(
      "/api/clients/c1",
      { headers: { Cookie: adminCookie } },
      env
    );
    expect(check.status).toBe(404);
  });
});

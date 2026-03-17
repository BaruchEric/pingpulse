import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { createRouter } from "@/api/router";
import { hashString } from "@/utils/hash";

const app = createRouter();

async function seedAdmin(password: string = "testpass123") {
  const hash = await hashString(password);
  await env.DB.prepare(
    "INSERT OR REPLACE INTO admin (id, password_hash, created_at) VALUES (1, ?, ?)"
  )
    .bind(hash, new Date().toISOString())
    .run();
}

async function loginAdmin(): Promise<string> {
  const res = await app.request(
    "/api/auth/login",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "testpass123" }),
    },
    env
  );
  const data = await res.json<{ token: string }>();
  return `session=${data.token}`;
}

describe("POST /api/auth/login", () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM admin; DELETE FROM rate_limits");
    await seedAdmin();
  });

  it("returns JWT on valid password", async () => {
    const res = await app.request(
      "/api/auth/login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "testpass123" }),
      },
      env
    );
    expect(res.status).toBe(200);
    const data = await res.json<{ token: string }>();
    expect(data.token).toBeTruthy();
    expect(res.headers.get("Set-Cookie")).toContain("session=");
  });

  it("returns 401 on wrong password", async () => {
    const res = await app.request(
      "/api/auth/login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "wrong" }),
      },
      env
    );
    expect(res.status).toBe(401);
  });
});

describe("GET /api/auth/me", () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM admin; DELETE FROM rate_limits");
    await seedAdmin();
  });

  it("returns 401 without session", async () => {
    const res = await app.request("/api/auth/me", {}, env);
    expect(res.status).toBe(401);
  });

  it("returns admin info with valid session", async () => {
    const cookie = await loginAdmin();
    const res = await app.request(
      "/api/auth/me",
      { headers: { Cookie: cookie } },
      env
    );
    expect(res.status).toBe(200);
    const data = await res.json<{ sub: string }>();
    expect(data.sub).toBe("admin");
  });
});

describe("POST /api/auth/logout", () => {
  it("clears session cookie", async () => {
    const res = await app.request(
      "/api/auth/logout",
      { method: "POST" },
      env
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toContain("session=;");
  });
});

describe("Client registration", () => {
  let adminCookie: string;

  beforeEach(async () => {
    await env.DB.exec(
      "DELETE FROM admin; DELETE FROM registration_tokens; DELETE FROM clients; DELETE FROM rate_limits"
    );
    await seedAdmin();
    adminCookie = await loginAdmin();
  });

  it("generates a registration token (admin required)", async () => {
    const res = await app.request(
      "/api/auth/register/token",
      {
        method: "POST",
        headers: { Cookie: adminCookie },
      },
      env
    );
    expect(res.status).toBe(200);
    const data = await res.json<{ token: string; expires_at: string }>();
    expect(data.token.length).toBeGreaterThanOrEqual(32);
    expect(data.expires_at).toBeTruthy();
  });

  it("exchanges valid token for client credentials", async () => {
    const genRes = await app.request(
      "/api/auth/register/token",
      {
        method: "POST",
        headers: { Cookie: adminCookie },
      },
      env
    );
    const { token } = await genRes.json<{ token: string }>();

    const regRes = await app.request(
      "/api/auth/register",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          name: "Home Office",
          location: "Toronto",
        }),
      },
      env
    );
    expect(regRes.status).toBe(200);
    const data = await regRes.json<{
      client_id: string;
      client_secret: string;
      ws_url: string;
    }>();
    expect(data.client_id).toBeTruthy();
    expect(data.client_secret).toBeTruthy();
    expect(data.ws_url).toContain("/ws/");
  });

  it("rejects expired token", async () => {
    const hash = await hashString("expired-token");
    const past = new Date(Date.now() - 60_000).toISOString();
    await env.DB.prepare(
      "INSERT INTO registration_tokens (id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)"
    )
      .bind("t1", hash, past, past)
      .run();

    const res = await app.request(
      "/api/auth/register",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: "expired-token",
          name: "Test",
          location: "Test",
        }),
      },
      env
    );
    expect(res.status).toBe(401);
  });

  it("rejects already-used token", async () => {
    const genRes = await app.request(
      "/api/auth/register/token",
      {
        method: "POST",
        headers: { Cookie: adminCookie },
      },
      env
    );
    const { token } = await genRes.json<{ token: string }>();

    // First use
    await app.request(
      "/api/auth/register",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, name: "Client1", location: "A" }),
      },
      env
    );

    // Second use — should fail
    const res = await app.request(
      "/api/auth/register",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, name: "Client2", location: "B" }),
      },
      env
    );
    expect(res.status).toBe(401);
  });
});

describe("GET /api/health", () => {
  it("returns 200 with status ok", async () => {
    await env.DB.exec("DELETE FROM rate_limits");
    const res = await app.request("/api/health", {}, env);
    expect(res.status).toBe(200);
    const data = await res.json<{ status: string }>();
    expect(data.status).toBe("ok");
  });
});

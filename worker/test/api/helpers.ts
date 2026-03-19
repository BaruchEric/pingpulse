import { expect } from "vitest";
import { env } from "cloudflare:test";
import { createRouter } from "@/api/router";
import { hashString } from "@/utils/hash";

export const app = createRouter();

let adminCookie = "";

export function getAdminCookie(): string {
  return adminCookie;
}

/** Reset all tables and create a fresh admin session. */
export async function setup() {
  await env.DB.exec(
    "DELETE FROM admin; DELETE FROM registration_tokens; DELETE FROM clients; DELETE FROM ping_results; DELETE FROM speed_tests; DELETE FROM alerts; DELETE FROM outages; DELETE FROM rate_limits"
  );

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
}

/** Admin generates a registration token. */
export async function generateToken(): Promise<string> {
  const res = await app.request(
    "/api/auth/register/token",
    { method: "POST", headers: { Cookie: adminCookie } },
    env
  );
  expect(res.status).toBe(200);
  return (await res.json<{ token: string }>()).token;
}

/** Exchange a registration token for client credentials. */
export async function registerClient(
  token: string,
  name: string,
  location: string
): Promise<{ client_id: string; client_secret: string; ws_url: string }> {
  const res = await app.request(
    "/api/auth/register",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, name, location }),
    },
    env
  );
  expect(res.status).toBe(200);
  return res.json();
}

import { Hono } from "hono";
import type { AppEnv } from "@/middleware/auth-guard";
import { authGuard } from "@/middleware/auth-guard";
import { rateLimit } from "@/middleware/rate-limit";
import { hashString } from "@/utils/hash";
import { DEFAULT_CLIENT_CONFIG } from "@/types";

export const authRoutes = new Hono<AppEnv>();

async function createJWT(secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = btoa(
    JSON.stringify({
      sub: "admin",
      iat: now,
      exp: now + 86400,
    })
  );

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${header}.${payload}`)
  );

  const sig = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return `${header}.${payload}.${sig}`;
}

function generateToken(length: number = 32): string {
  const chars =
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

// Login: 5 attempts/min
authRoutes.post(
  "/login",
  rateLimit({ maxRequests: 5, windowMs: 60_000, prefix: "login" }),
  async (c) => {
    const { password } = await c.req.json<{ password: string }>();
    const hash = await hashString(password);

    const admin = await c.env.DB.prepare(
      "SELECT password_hash FROM admin WHERE id = 1"
    ).first<{ password_hash: string }>();

    if (!admin || admin.password_hash !== hash) {
      return c.json({ error: "Invalid password" }, 401);
    }

    const token = await createJWT(c.env.ADMIN_JWT_SECRET);
    return c.json({ token }, 200, {
      "Set-Cookie": `session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
    });
  }
);

authRoutes.post("/logout", (c) => {
  return c.json({ ok: true }, 200, {
    "Set-Cookie": "session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
  });
});

authRoutes.get("/me", authGuard, async (c) => {
  const payload = c.get("jwtPayload");
  return c.json({ sub: payload.sub, exp: payload.exp });
});

// Generate registration token (admin only)
authRoutes.post("/register/token", authGuard, async (c) => {
  const token = generateToken(32);
  const tokenHash = await hashString(token);
  const id = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 15 * 60_000);

  await c.env.DB.prepare(
    "INSERT INTO registration_tokens (id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)"
  )
    .bind(id, tokenHash, now.toISOString(), expiresAt.toISOString())
    .run();

  return c.json({ token, expires_at: expiresAt.toISOString() });
});

// Exchange registration token for client credentials
authRoutes.post("/register", async (c) => {
  const { token, name, location } = await c.req.json<{
    token: string;
    name: string;
    location: string;
  }>();

  const tokenHash = await hashString(token);
  const row = await c.env.DB.prepare(
    "SELECT id, expires_at, used_at FROM registration_tokens WHERE token_hash = ?"
  )
    .bind(tokenHash)
    .first<{ id: string; expires_at: string; used_at: string | null }>();

  if (!row) return c.json({ error: "Invalid token" }, 401);
  if (row.used_at) return c.json({ error: "Token already used" }, 401);
  if (new Date(row.expires_at) < new Date())
    return c.json({ error: "Token expired" }, 401);

  const clientId = crypto.randomUUID();
  const clientSecret = generateToken(48);
  const secretHash = await hashString(clientSecret);
  const now = new Date().toISOString();

  await c.env.DB.prepare(
    "UPDATE registration_tokens SET used_at = ?, used_by_client_id = ? WHERE id = ?"
  )
    .bind(now, clientId, row.id)
    .run();

  await c.env.DB.prepare(
    "INSERT INTO clients (id, name, location, secret_hash, config_json, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(
      clientId,
      name,
      location,
      secretHash,
      JSON.stringify(DEFAULT_CLIENT_CONFIG),
      now,
      now
    )
    .run();

  const wsUrl = `/ws/${clientId}`;
  return c.json({ client_id: clientId, client_secret: clientSecret, ws_url: wsUrl });
});

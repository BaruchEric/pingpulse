import { Context, Next } from "hono";
import type { Env } from "@/index";

export async function authGuard(c: Context<{ Bindings: Env }>, next: Next) {
  const cookie = c.req.header("Cookie");
  const sessionEntry = cookie
    ?.split(";")
    .find((s) => s.trim().startsWith("session="));
  const token = sessionEntry?.trim().substring("session=".length);

  if (!token) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(c.env.ADMIN_JWT_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );

    const [headerB64, payloadB64, signatureB64] = token.split(".");
    const data = encoder.encode(`${headerB64}.${payloadB64}`);
    const signature = Uint8Array.from(
      atob(signatureB64.replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0)
    );

    const valid = await crypto.subtle.verify("HMAC", key, signature, data);
    if (!valid) {
      return c.json({ error: "Invalid token" }, 401);
    }

    const payload = JSON.parse(atob(payloadB64));
    if (payload.exp && payload.exp < Date.now() / 1000) {
      return c.json({ error: "Token expired" }, 401);
    }

    await next();
  } catch {
    return c.json({ error: "Invalid token" }, 401);
  }
}

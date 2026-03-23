import { createMiddleware } from "hono/factory";
import type { AppEnv } from "@/middleware/auth-guard";
import { hashString } from "@/utils/hash";

/**
 * Middleware that authenticates requests using a client secret (Bearer token).
 * Sets `clientId` and `secretHash` on the context for downstream handlers.
 */
export const clientSecretAuth = createMiddleware<AppEnv>(async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }
  const secret = authHeader.slice(7);

  const clientId = c.req.param("clientId") || c.req.param("id");
  if (!clientId) {
    return c.json({ error: "Missing client ID" }, 400);
  }

  const client = await c.env.DB.prepare(
    "SELECT id, secret_hash FROM clients WHERE id = ?"
  )
    .bind(clientId)
    .first<{ id: string; secret_hash: string }>();

  if (!client) {
    return c.json({ error: "Client not found" }, 404);
  }

  const secretHash = await hashString(secret);
  if (secretHash !== client.secret_hash) {
    return c.json({ error: "Invalid client secret" }, 403);
  }

  await next();
});

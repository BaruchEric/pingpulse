import { Hono } from "hono";
import type { AppEnv } from "@/middleware/auth-guard";
import { authGuard } from "@/middleware/auth-guard";
import { requireClient } from "@/utils/do-client";

export const commandRoutes = new Hono<AppEnv>();

commandRoutes.use("*", authGuard);

// Send a command to a connected client via the Durable Object
commandRoutes.post("/:id", async (c) => {
  const clientId = c.req.param("id");
  const body = await c.req.json<{ command: string; params?: Record<string, unknown> }>();

  if (!await requireClient(c.env.DB, clientId)) return c.json({ error: "Client not found" }, 404);

  const doId = c.env.CLIENT_MONITOR.idFromName(clientId);
  const stub = c.env.CLIENT_MONITOR.get(doId);

  const resp = await stub.fetch("http://internal/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const result = await resp.json();
  return c.json(result, resp.status as 200);
});

// Get current DO state (paused, simulation, connected sessions)
commandRoutes.get("/:id/status", async (c) => {
  const clientId = c.req.param("id");

  if (!await requireClient(c.env.DB, clientId)) return c.json({ error: "Client not found" }, 404);

  const doId = c.env.CLIENT_MONITOR.idFromName(clientId);
  const stub = c.env.CLIENT_MONITOR.get(doId);

  const resp = await stub.fetch("http://internal/status");
  const result = await resp.json();
  return c.json(result);
});

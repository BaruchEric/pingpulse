import type { AppEnv } from "@/middleware/auth-guard";

export async function sendDOCommand(
  env: AppEnv["Bindings"],
  clientId: string,
  command: string,
  params?: Record<string, unknown>
): Promise<boolean> {
  const doId = env.CLIENT_MONITOR.idFromName(clientId);
  const stub = env.CLIENT_MONITOR.get(doId);
  const resp = await stub.fetch("http://internal/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params ? { command, params } : { command }),
  });
  return resp.ok;
}

export async function requireClient(
  db: D1Database,
  id: string
): Promise<{ id: string } | null> {
  return db.prepare("SELECT id FROM clients WHERE id = ?").bind(id).first<{ id: string }>();
}

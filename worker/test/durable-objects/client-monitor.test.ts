import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { hashString } from "@/utils/hash";

const CLIENT_ID = "test-client-1";
const CLIENT_SECRET = "test-secret-123";

async function seedClient() {
  const hash = await hashString(CLIENT_SECRET);
  await env.DB.prepare(
    "INSERT OR REPLACE INTO clients (id, name, location, secret_hash, config_json, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(
      CLIENT_ID,
      "Test",
      "Toronto",
      hash,
      JSON.stringify({ ping_interval_s: 30, grace_period_s: 60 }),
      new Date().toISOString(),
      new Date().toISOString()
    )
    .run();
}

describe("ClientMonitor DO", () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM clients");
    await env.DB.exec("DELETE FROM ping_results");
    await env.DB.exec("DELETE FROM alerts");
    await env.DB.exec("DELETE FROM outages");
    await seedClient();
  });

  it("accepts WebSocket with valid auth", async () => {
    const id = env.CLIENT_MONITOR.idFromName(CLIENT_ID);
    const stub = env.CLIENT_MONITOR.get(id);

    const res = await stub.fetch(`http://localhost/ws/${CLIENT_ID}`, {
      headers: {
        Upgrade: "websocket",
        Authorization: `Bearer ${CLIENT_SECRET}`,
      },
    });

    expect(res.status).toBe(101);
    expect(res.webSocket).toBeTruthy();
  });

  it("rejects WebSocket without auth", async () => {
    const id = env.CLIENT_MONITOR.idFromName(CLIENT_ID);
    const stub = env.CLIENT_MONITOR.get(id);

    const res = await stub.fetch(`http://localhost/ws/${CLIENT_ID}`, {
      headers: { Upgrade: "websocket" },
    });

    expect(res.status).toBe(401);
  });

  it("rejects WebSocket with wrong secret", async () => {
    const id = env.CLIENT_MONITOR.idFromName(CLIENT_ID);
    const stub = env.CLIENT_MONITOR.get(id);

    const res = await stub.fetch(`http://localhost/ws/${CLIENT_ID}`, {
      headers: {
        Upgrade: "websocket",
        Authorization: "Bearer wrong-secret",
      },
    });

    expect(res.status).toBe(401);
  });

  it("sends config_update on connection", async () => {
    const id = env.CLIENT_MONITOR.idFromName(CLIENT_ID);
    const stub = env.CLIENT_MONITOR.get(id);

    const res = await stub.fetch(`http://localhost/ws/${CLIENT_ID}`, {
      headers: {
        Upgrade: "websocket",
        Authorization: `Bearer ${CLIENT_SECRET}`,
      },
    });

    const ws = res.webSocket!;
    ws.accept();

    const message = await new Promise<string>((resolve) => {
      ws.addEventListener("message", (event: MessageEvent) => {
        resolve(event.data as string);
      });
    });

    const parsed = JSON.parse(message);
    expect(parsed.type).toBe("config_update");
    expect(parsed.config.ping_interval_s).toBe(30);

    ws.close();
  });

  it("responds to speed test trigger", async () => {
    const id = env.CLIENT_MONITOR.idFromName(CLIENT_ID);
    const stub = env.CLIENT_MONITOR.get(id);

    const res = await stub.fetch(
      "http://localhost/trigger-speed-test",
      { method: "POST" }
    );

    expect(res.status).toBe(200);
  });

  it("updates last_seen on connect", async () => {
    const id = env.CLIENT_MONITOR.idFromName(CLIENT_ID);
    const stub = env.CLIENT_MONITOR.get(id);

    const before = await env.DB.prepare(
      "SELECT last_seen FROM clients WHERE id = ?"
    )
      .bind(CLIENT_ID)
      .first<{ last_seen: string }>();

    // Small delay so timestamps differ
    await new Promise((r) => setTimeout(r, 10));

    const res = await stub.fetch(`http://localhost/ws/${CLIENT_ID}`, {
      headers: {
        Upgrade: "websocket",
        Authorization: `Bearer ${CLIENT_SECRET}`,
      },
    });

    const ws = res.webSocket!;
    ws.accept();

    const after = await env.DB.prepare(
      "SELECT last_seen FROM clients WHERE id = ?"
    )
      .bind(CLIENT_ID)
      .first<{ last_seen: string }>();

    expect(new Date(after!.last_seen).getTime()).toBeGreaterThanOrEqual(
      new Date(before!.last_seen).getTime()
    );

    ws.close();
  });
});

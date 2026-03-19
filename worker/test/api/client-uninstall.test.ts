import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  app,
  setup,
  getAdminCookie,
  generateToken,
  registerClient,
} from "./helpers";

describe("Client uninstall lifecycle: register → pings → self-delete → assert gone", () => {
  beforeEach(setup);

  it("full uninstall lifecycle", async () => {
    const adminCookie = getAdminCookie();

    // 1. Register client
    const token = await generateToken();
    const { client_id, client_secret } = await registerClient(
      token,
      "Home Office",
      "Toronto, CA"
    );
    expect(client_id).toBeTruthy();

    // 2. Monitor pings — seed ping results and speed tests as if daemon was running
    const now = new Date();
    const pingIds = ["p1", "p2", "p3", "p4", "p5"];
    for (let i = 0; i < pingIds.length; i++) {
      const ts = new Date(now.getTime() - (5 - i) * 60_000).toISOString();
      const status = i === 2 ? "timeout" : "ok";
      const rtt = status === "ok" ? 10 + Math.random() * 5 : 0;
      await env.DB.prepare(
        "INSERT INTO ping_results (id, client_id, timestamp, rtt_ms, jitter_ms, direction, status) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
        .bind(pingIds[i], client_id, ts, rtt, 1.2, "cf_to_client", status)
        .run();
    }

    await env.DB.prepare(
      "INSERT INTO speed_tests (id, client_id, timestamp, type, download_mbps, upload_mbps, payload_bytes, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind("s1", client_id, now.toISOString(), "probe", 95.2, 42.1, 262144, 350)
      .run();

    await env.DB.prepare(
      "INSERT INTO alerts (id, client_id, type, severity, value, threshold, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
      .bind("a1", client_id, "high_latency", "warning", 150.0, 100.0, now.toISOString())
      .run();

    // Verify pings are visible via metrics API
    const metricsRes = await app.request(
      `/api/metrics/${client_id}?from=${new Date(now.getTime() - 3600_000).toISOString()}&to=${new Date(now.getTime() + 60_000).toISOString()}`,
      { headers: { Cookie: adminCookie } },
      env
    );
    expect(metricsRes.status).toBe(200);
    const metrics = await metricsRes.json<{
      pings: unknown[];
      speed_tests: unknown[];
      summary: { total_pings: number; ok_pings: number; timeout_pings: number; loss_pct: number };
    }>();
    expect(metrics.pings).toHaveLength(5);
    expect(metrics.speed_tests).toHaveLength(1);
    expect(metrics.summary.total_pings).toBe(5);
    expect(metrics.summary.ok_pings).toBe(4);
    expect(metrics.summary.timeout_pings).toBe(1);
    expect(metrics.summary.loss_pct).toBe(20);

    // 3. Delete from CF — client self-delete (what `pingpulse uninstall` calls)
    const selfDeleteRes = await app.request(
      `/api/clients/${client_id}/self`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${client_secret}` },
      },
      env
    );
    expect(selfDeleteRes.status).toBe(200);
    const selfDeleteBody = await selfDeleteRes.json<{ ok: boolean }>();
    expect(selfDeleteBody.ok).toBe(true);

    // 4. Assert client uninstall — everything is gone
    // Client record gone
    const clientCheck = await app.request(
      `/api/clients/${client_id}`,
      { headers: { Cookie: adminCookie } },
      env
    );
    expect(clientCheck.status).toBe(404);

    // Ping results gone
    const pingCount = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM ping_results WHERE client_id = ?"
    )
      .bind(client_id)
      .first<{ count: number }>();
    expect(pingCount?.count).toBe(0);

    // Speed tests gone
    const speedCount = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM speed_tests WHERE client_id = ?"
    )
      .bind(client_id)
      .first<{ count: number }>();
    expect(speedCount?.count).toBe(0);

    // Alerts gone
    const alertCount = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM alerts WHERE client_id = ?"
    )
      .bind(client_id)
      .first<{ count: number }>();
    expect(alertCount?.count).toBe(0);

    // Client list empty
    const listRes = await app.request(
      "/api/clients",
      { headers: { Cookie: adminCookie } },
      env
    );
    const { clients } = await listRes.json<{ clients: unknown[] }>();
    expect(clients).toHaveLength(0);

    // Self-delete again returns 404
    const retryRes = await app.request(
      `/api/clients/${client_id}/self`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${client_secret}` },
      },
      env
    );
    expect(retryRes.status).toBe(404);
  });

  it("self-delete with wrong secret returns 403", async () => {
    const token = await generateToken();
    const { client_id } = await registerClient(token, "Test", "Lab");
    const adminCookie = getAdminCookie();

    const res = await app.request(
      `/api/clients/${client_id}/self`,
      {
        method: "DELETE",
        headers: { Authorization: "Bearer wrong-secret-value" },
      },
      env
    );
    expect(res.status).toBe(403);

    // Client should still exist
    const check = await app.request(
      `/api/clients/${client_id}`,
      { headers: { Cookie: adminCookie } },
      env
    );
    expect(check.status).toBe(200);
  });

  it("self-delete without auth header returns 401", async () => {
    const token = await generateToken();
    const { client_id } = await registerClient(token, "Test", "Lab");

    const res = await app.request(
      `/api/clients/${client_id}/self`,
      { method: "DELETE" },
      env
    );
    expect(res.status).toBe(401);
  });

  it("self-delete does not affect other clients", async () => {
    const adminCookie = getAdminCookie();
    const t1 = await generateToken();
    const t2 = await generateToken();
    const c1 = await registerClient(t1, "Office", "Montreal");
    const c2 = await registerClient(t2, "Home", "Toronto");

    // Seed ping data for both
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO ping_results (id, client_id, timestamp, rtt_ms, jitter_ms, direction, status) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
      .bind("p-c1", c1.client_id, now, 12.0, 1.0, "cf_to_client", "ok")
      .run();
    await env.DB.prepare(
      "INSERT INTO ping_results (id, client_id, timestamp, rtt_ms, jitter_ms, direction, status) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
      .bind("p-c2", c2.client_id, now, 15.0, 1.5, "cf_to_client", "ok")
      .run();

    // c1 self-deletes
    const res = await app.request(
      `/api/clients/${c1.client_id}/self`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${c1.client_secret}` },
      },
      env
    );
    expect(res.status).toBe(200);

    // c1 gone
    const check1 = await app.request(
      `/api/clients/${c1.client_id}`,
      { headers: { Cookie: adminCookie } },
      env
    );
    expect(check1.status).toBe(404);

    // c2 still alive with its data
    const check2 = await app.request(
      `/api/clients/${c2.client_id}`,
      { headers: { Cookie: adminCookie } },
      env
    );
    expect(check2.status).toBe(200);

    const c2Pings = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM ping_results WHERE client_id = ?"
    )
      .bind(c2.client_id)
      .first<{ count: number }>();
    expect(c2Pings?.count).toBe(1);
  });
});

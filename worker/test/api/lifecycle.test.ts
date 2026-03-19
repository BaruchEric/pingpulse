import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  app,
  setup,
  getAdminCookie,
  generateToken,
  registerClient,
} from "./helpers";

describe("Client lifecycle: register → verify → delete → gone", () => {
  beforeEach(setup);

  it("full lifecycle", async () => {
    const adminCookie = getAdminCookie();

    // 1. Register a client
    const token = await generateToken();
    const { client_id, client_secret, ws_url } = await registerClient(
      token,
      "Home Office",
      "Toronto, CA"
    );
    expect(client_id).toBeTruthy();
    expect(client_secret.length).toBeGreaterThanOrEqual(48);
    expect(ws_url).toBe(`/ws/${client_id}`);

    // 2. Verify client is visible via API
    const getRes = await app.request(
      `/api/clients/${client_id}`,
      { headers: { Cookie: adminCookie } },
      env
    );
    expect(getRes.status).toBe(200);
    const clientData = await getRes.json<{
      name: string;
      location: string;
    }>();
    expect(clientData.name).toBe("Home Office");
    expect(clientData.location).toBe("Toronto, CA");

    // Verify it shows in client list
    const listRes = await app.request(
      "/api/clients",
      { headers: { Cookie: adminCookie } },
      env
    );
    expect(listRes.status).toBe(200);
    const { clients } = await listRes.json<{ clients: unknown[] }>();
    expect(clients).toHaveLength(1);

    // 3. Delete client from server
    const delRes = await app.request(
      `/api/clients/${client_id}`,
      {
        method: "DELETE",
        headers: { Cookie: adminCookie },
      },
      env
    );
    expect(delRes.status).toBe(200);

    // 4. Assert client is gone
    const checkRes = await app.request(
      `/api/clients/${client_id}`,
      { headers: { Cookie: adminCookie } },
      env
    );
    expect(checkRes.status).toBe(404);

    // Verify client list is empty
    const emptyListRes = await app.request(
      "/api/clients",
      { headers: { Cookie: adminCookie } },
      env
    );
    const { clients: remaining } = await emptyListRes.json<{
      clients: unknown[];
    }>();
    expect(remaining).toHaveLength(0);

    // Verify registration token was consumed (can't reuse)
    const reuseRes = await app.request(
      "/api/auth/register",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          name: "Ghost",
          location: "Nowhere",
        }),
      },
      env
    );
    expect(reuseRes.status).toBe(401);
  });

  it("delete cascades ping and speed test data", async () => {
    const adminCookie = getAdminCookie();
    const token = await generateToken();
    const { client_id } = await registerClient(token, "Test", "Lab");

    // Seed ping results and speed test data for this client
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO ping_results (id, client_id, timestamp, rtt_ms, jitter_ms, direction, status) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
      .bind("p1", client_id, now, 12.5, 2.1, "cf_to_client", "ok")
      .run();

    await env.DB.prepare(
      "INSERT INTO speed_tests (id, client_id, timestamp, type, download_mbps, upload_mbps, payload_bytes, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind("s1", client_id, now, "probe", 95.2, 42.1, 262144, 350)
      .run();

    // Delete the client
    const delRes = await app.request(
      `/api/clients/${client_id}`,
      {
        method: "DELETE",
        headers: { Cookie: adminCookie },
      },
      env
    );
    expect(delRes.status).toBe(200);

    // Verify cascade — associated data should be gone
    const pings = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM ping_results WHERE client_id = ?"
    )
      .bind(client_id)
      .first<{ count: number }>();
    expect(pings?.count).toBe(0);

    const speeds = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM speed_tests WHERE client_id = ?"
    )
      .bind(client_id)
      .first<{ count: number }>();
    expect(speeds?.count).toBe(0);
  });

  it("delete nonexistent client returns 404", async () => {
    const adminCookie = getAdminCookie();
    const res = await app.request(
      "/api/clients/nonexistent-id",
      {
        method: "DELETE",
        headers: { Cookie: adminCookie },
      },
      env
    );
    expect(res.status).toBe(404);
  });

  it("multiple clients are independent", async () => {
    const adminCookie = getAdminCookie();
    const token1 = await generateToken();
    const token2 = await generateToken();
    const c1 = await registerClient(token1, "Office", "Montreal");
    const c2 = await registerClient(token2, "Home", "Toronto");

    // Delete only c1
    await app.request(
      `/api/clients/${c1.client_id}`,
      {
        method: "DELETE",
        headers: { Cookie: adminCookie },
      },
      env
    );

    // c1 gone, c2 still alive
    const check1 = await app.request(
      `/api/clients/${c1.client_id}`,
      { headers: { Cookie: adminCookie } },
      env
    );
    expect(check1.status).toBe(404);

    const check2 = await app.request(
      `/api/clients/${c2.client_id}`,
      { headers: { Cookie: adminCookie } },
      env
    );
    expect(check2.status).toBe(200);
  });
});

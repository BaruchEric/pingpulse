import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import worker from "@/index";

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

describe("GET /api/health", () => {
  it("returns 200 with status ok", async () => {
    // Clear rate limits so health check isn't blocked
    await env.DB.exec("DELETE FROM rate_limits");
    const req = new Request("http://localhost/api/health");
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string };
    expect(data.status).toBe("ok");
  });
});

describe("GET /speedtest/download", () => {
  it("returns a payload of requested size", async () => {
    const req = new Request("http://localhost/speedtest/download?size=1024");
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);
    const body = await res.arrayBuffer();
    expect(body.byteLength).toBe(1024);
  });

  it("caps payload at 100MB", async () => {
    const req = new Request(
      "http://localhost/speedtest/download?size=999999999"
    );
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);
    const body = await res.arrayBuffer();
    expect(body.byteLength).toBe(100 * 1024 * 1024);
  });
});

describe("POST /speedtest/upload", () => {
  it("returns received byte count", async () => {
    const payload = new Uint8Array(2048);
    const req = new Request("http://localhost/speedtest/upload", {
      method: "POST",
      body: payload,
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { received_bytes: number };
    expect(data.received_bytes).toBe(2048);
  });
});

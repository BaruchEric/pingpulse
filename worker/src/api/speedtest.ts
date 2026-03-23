import { Hono } from "hono";
import type { AppEnv } from "@/middleware/auth-guard";
import { authGuard } from "@/middleware/auth-guard";
import { rateLimit } from "@/middleware/rate-limit";

export const speedtestRoutes = new Hono<AppEnv>();

// Payload endpoints — no auth (client uses these during test)

// Pre-allocate a single zero-filled chunk to avoid per-request crypto overhead.
// Random data is unnecessary for throughput measurement — zeroes saturate the
// pipe just as well and don't burn CPU time on the worker.
const CHUNK_SIZE = 65536;
const ZERO_CHUNK = new Uint8Array(CHUNK_SIZE);

speedtestRoutes.get("/download", (c) => {
  const size = parseInt(c.req.query("size") || "262144");
  const totalSize = Math.min(size, 100 * 1024 * 1024);
  let remaining = totalSize;

  const stream = new ReadableStream({
    pull(controller) {
      const chunkSize = Math.min(CHUNK_SIZE, remaining);
      controller.enqueue(
        chunkSize === CHUNK_SIZE ? ZERO_CHUNK : ZERO_CHUNK.slice(0, chunkSize)
      );
      remaining -= chunkSize;
      if (remaining <= 0) controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(totalSize),
    },
  });
});

speedtestRoutes.post("/upload", async (c) => {
  // Stream-consume the body to avoid buffering large uploads in memory
  const reader = c.req.raw.body?.getReader();
  let receivedBytes = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
    }
  }
  return c.json({ received_bytes: receivedBytes });
});

// Trigger speed test on a client — auth required
speedtestRoutes.post(
  "/:id",
  authGuard,
  rateLimit({ maxRequests: 10, windowMs: 60_000, prefix: "speedtest" }),
  async (c) => {
    const clientId = c.req.param("id");
    if (!clientId) return c.json({ error: "Missing client ID" }, 400);

    const client = await c.env.DB.prepare(
      "SELECT id FROM clients WHERE id = ?"
    )
      .bind(clientId)
      .first();
    if (!client) return c.json({ error: "Client not found" }, 404);

    const doId = c.env.CLIENT_MONITOR.idFromName(clientId);
    const stub = c.env.CLIENT_MONITOR.get(doId);

    try {
      await stub.fetch("http://internal/trigger-speed-test", {
        method: "POST",
      });
    } catch {
      // Client may not be connected
    }

    return c.json({ ok: true, message: "Speed test triggered" });
  }
);

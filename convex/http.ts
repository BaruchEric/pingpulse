import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  hashString,
  generateToken,
  createAdminJWT,
  verifyAdminJWT,
  adminSecret,
} from "./lib/crypto";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extra },
  });
}

function clientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  return xff ? xff.split(",")[0]!.trim() : "unknown";
}

async function rateLimited(
  ctx: ActionCtx,
  request: Request,
  prefix: string,
  maxRequests: number,
  windowMs: number,
): Promise<boolean> {
  const key = `rl:${prefix}:${clientIp(request)}`;
  const { allowed } = await ctx.runMutation(internal.rateLimit.check, {
    key,
    maxRequests,
    windowMs,
  });
  return !allowed;
}

function bearer(request: Request): string | null {
  const h = request.headers.get("Authorization");
  return h?.startsWith("Bearer ") ? h.slice(7) : null;
}

async function requireAdmin(request: Request): Promise<Response | null> {
  const token = bearer(request);
  if (!token) return json({ error: "Unauthorized" }, 401);
  const payload = await verifyAdminJWT(token, adminSecret());
  if (!payload) return json({ error: "Invalid token" }, 401);
  return null;
}

async function requireClientSecret(
  ctx: ActionCtx,
  request: Request,
  clientId: string,
): Promise<Response | null> {
  const secret = bearer(request);
  if (!secret) return json({ error: "Missing or invalid Authorization header" }, 401);
  const row = await ctx.runQuery(internal.clients.getSecretHash, { clientId });
  if (!row) return json({ error: "Client not found" }, 404);
  if ((await hashString(secret)) !== row.secretHash) {
    return json({ error: "Invalid client secret" }, 403);
  }
  return null;
}

function parsePagination(params: URLSearchParams): { limit: number; offset: number } {
  const limit = Math.min(Math.max(parseInt(params.get("limit") || "50") || 50, 1), 200);
  const offset = Math.max(parseInt(params.get("offset") || "0") || 0, 0);
  return { limit, offset };
}

const apiHandler = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const method = request.method;
  const path = url.pathname;
  const params = url.searchParams;

  if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  // Global rate limit (skip the Telegram webhook, which Telegram calls directly).
  if (path !== "/api/telegram/webhook") {
    if (await rateLimited(ctx, request, "global", 60, 60_000)) {
      return json({ error: "Rate limit exceeded" }, 429);
    }
  }

  // ---- health ----
  if (path === "/api/health" && method === "GET") {
    return json({ status: "ok", timestamp: new Date().toISOString() });
  }

  // ---- auth ----
  if (path === "/api/auth/login" && method === "POST") {
    if (await rateLimited(ctx, request, "login", 5, 60_000)) {
      return json({ error: "Rate limit exceeded" }, 429);
    }
    const { password } = await request.json();
    const admin = await ctx.runQuery(internal.auth.getAdminPasswordHash, {});
    if (!admin || admin.passwordHash !== (await hashString(password))) {
      return json({ error: "Invalid password" }, 401);
    }
    return json({ token: await createAdminJWT(adminSecret()) });
  }

  if (path === "/api/auth/logout" && method === "POST") {
    return json({ ok: true });
  }

  if (path === "/api/auth/bootstrap" && method === "POST") {
    const existing = await ctx.runQuery(internal.auth.getAdminPasswordHash, {});
    if (existing) return json({ error: "Already initialized" }, 403);
    const { password } = await request.json();
    if (!password || typeof password !== "string") {
      return json({ error: "password required" }, 400);
    }
    await ctx.runMutation(internal.auth.setAdminPasswordHash, {
      passwordHash: await hashString(password),
    });
    return json({ ok: true });
  }

  if (path === "/api/auth/me" && method === "GET") {
    const token = bearer(request);
    const payload = token ? await verifyAdminJWT(token, adminSecret()) : null;
    if (!payload) return json({ error: "Unauthorized" }, 401);
    return json({ sub: payload.sub, exp: payload.exp });
  }

  if (path === "/api/auth/password" && method === "PUT") {
    const unauth = await requireAdmin(request);
    if (unauth) return unauth;
    const { current_password, new_password } = await request.json();
    const admin = await ctx.runQuery(internal.auth.getAdminPasswordHash, {});
    if (!admin || admin.passwordHash !== (await hashString(current_password))) {
      return json({ error: "Invalid current password" }, 401);
    }
    if (!new_password || String(new_password).length < 8) {
      return json({ error: "New password must be at least 8 characters" }, 400);
    }
    await ctx.runMutation(internal.auth.setAdminPasswordHash, {
      passwordHash: await hashString(new_password),
    });
    return json({ ok: true });
  }

  if (path === "/api/auth/register/token" && method === "POST") {
    const unauth = await requireAdmin(request);
    if (unauth) return unauth;
    const token = generateToken(32);
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    await ctx.runMutation(internal.auth.createRegistrationToken, {
      tokenHash: await hashString(token),
      expiresAt,
    });
    return json({ token, expires_at: expiresAt });
  }

  if (path === "/api/auth/register" && method === "POST") {
    const { token, name, location } = await request.json();
    const clientId = crypto.randomUUID();
    const clientSecret = generateToken(48);
    const res = await ctx.runMutation(internal.auth.registerClient, {
      tokenHash: await hashString(token),
      name: name ?? "",
      location: location ?? "",
      clientId,
      secretHash: await hashString(clientSecret),
    });
    if ("error" in res) {
      const map: Record<string, string> = {
        invalid: "Invalid token",
        used: "Token already used",
        expired: "Token expired",
      };
      return json({ error: map[String(res.error)] ?? "Invalid token" }, 401);
    }
    return json({
      client_id: clientId,
      client_secret: clientSecret,
      heartbeat_url: `/api/clients/${clientId}/heartbeat`,
    });
  }

  // ---- telegram ----
  if (path === "/api/telegram/webhook" && method === "POST") {
    const update = await request.json().catch(() => null);
    if (update) await ctx.runAction(internal.telegram.handleUpdate, { update });
    return json({ ok: true });
  }

  if (path === "/api/telegram/setup" && method === "POST") {
    const unauth = await requireAdmin(request);
    if (unauth) return unauth;
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return json({ error: "TELEGRAM_BOT_TOKEN not set" }, 400);
    const body = await request.json().catch(() => ({}));
    const webhookUrl = body.webhook_url || `${url.origin}/api/telegram/webhook`;
    const webhookRes = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: webhookUrl, allowed_updates: ["message", "callback_query"] }),
    });
    const commandsRes = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commands: [
          { command: "clients", description: "List all clients with status" },
          { command: "status", description: "System overview" },
          { command: "start", description: "Resume monitoring for a client" },
          { command: "stop", description: "Pause monitoring for a client" },
          { command: "alerts", description: "Show recent alerts" },
          { command: "speedtest", description: "Trigger speed test" },
          { command: "ping", description: "Force immediate ping" },
          { command: "uptime", description: "24h uptime stats for a client" },
          { command: "mute", description: "Mute notifications (default 30m)" },
          { command: "unmute", description: "Unmute notifications" },
          { command: "help", description: "Show available commands" },
        ],
      }),
    });
    return json({
      webhook: await webhookRes.json(),
      commands: await commandsRes.json(),
      webhook_url: webhookUrl,
    });
  }

  // ---- client-authenticated endpoints (client secret) ----
  const syncMatch = path.match(/^\/api\/clients\/([^/]+)\/sync$/);
  if (syncMatch && method === "POST") {
    const clientId = syncMatch[1]!;
    const denied = await requireClientSecret(ctx, request, clientId);
    if (denied) return denied;
    const batch = await request.json();
    if (!batch.session_id || !Array.isArray(batch.records) || batch.records.length === 0) {
      return json({ error: "Invalid sync batch" }, 400);
    }
    if (batch.records.length > 500) return json({ error: "Batch too large, max 500" }, 400);
    const res = await ctx.runMutation(internal.ingest.syncProbeResults, {
      clientId,
      sessionId: batch.session_id,
      records: batch.records,
    });
    return json(res);
  }

  const connMatch = path.match(/^\/api\/clients\/([^/]+)\/connectivity$/);
  if (connMatch && method === "POST") {
    const clientId = connMatch[1]!;
    const denied = await requireClientSecret(ctx, request, clientId);
    if (denied) return denied;
    const batch = await request.json();
    if (!Array.isArray(batch.events) || batch.events.length === 0) {
      return json({ error: "No events provided" }, 400);
    }
    if (batch.events.length > 200) return json({ error: "Too many events, max 200" }, 400);
    const res = await ctx.runMutation(internal.ingest.processConnectivity, {
      clientId,
      events: batch.events,
    });
    if ("error" in res) return json({ error: "Client not found" }, 404);
    return json(res);
  }

  const heartbeatMatch = path.match(/^\/api\/clients\/([^/]+)\/heartbeat$/);
  if (heartbeatMatch && method === "POST") {
    const clientId = heartbeatMatch[1]!;
    const denied = await requireClientSecret(ctx, request, clientId);
    if (denied) return denied;
    const body = await request.json().catch(() => ({}));
    const res = await ctx.runMutation(internal.ingest.heartbeat, {
      clientId,
      rttMs: body.rtt_ms ?? null,
      jitterMs: body.jitter_ms,
      status: body.status,
      clientVersion: body.client_version,
      timezone: body.timezone,
      includeLogs: body.include_logs,
    });
    if ("deregistered" in res) return json({ error: "Client deleted" }, 410);
    if ("rejected" in res) return json({ error: "Admin disconnect in effect" }, 503);
    return json(res);
  }

  const speedResultMatch = path.match(/^\/api\/clients\/([^/]+)\/speedtest-result$/);
  if (speedResultMatch && method === "POST") {
    const clientId = speedResultMatch[1]!;
    const denied = await requireClientSecret(ctx, request, clientId);
    if (denied) return denied;
    const r = await request.json();
    await ctx.runMutation(internal.ingest.recordSpeedTest, {
      clientId,
      type: r.type === "probe" ? "probe" : "full",
      target: r.target === "edge" ? "edge" : "worker",
      downloadMbps: r.download_mbps,
      uploadMbps: r.upload_mbps,
      payloadBytes: r.payload_bytes,
      durationMs: r.duration_ms,
    });
    return json({ ok: true });
  }

  const probeMatch = path.match(/^\/api\/clients\/([^/]+)\/probe$/);
  if (probeMatch && method === "POST") {
    const clientId = probeMatch[1]!;
    const denied = await requireClientSecret(ctx, request, clientId);
    if (denied) return denied;
    const body = await request.json();
    await ctx.runMutation(internal.ingest.ingestProbeResult, {
      clientId,
      sessionId: body.session_id,
      record: body.record,
    });
    return json({ ok: true });
  }

  const selfMatch = path.match(/^\/api\/clients\/([^/]+)\/self$/);
  if (selfMatch && method === "DELETE") {
    const clientId = selfMatch[1]!;
    const denied = await requireClientSecret(ctx, request, clientId);
    if (denied) return denied;
    const { deleted } = await ctx.runMutation(internal.clients.remove, { clientId });
    return deleted ? json({ ok: true }) : json({ error: "Client not found" }, 404);
  }

  // ---- admin-authenticated endpoints ----
  if (path === "/api/clients" && method === "GET") {
    const unauth = await requireAdmin(request);
    if (unauth) return unauth;
    return json(await ctx.runQuery(internal.clients.listWithStats, {}));
  }

  const clientIdMatch = path.match(/^\/api\/clients\/([^/]+)$/);
  if (clientIdMatch) {
    const clientId = clientIdMatch[1]!;
    const unauth = await requireAdmin(request);
    if (unauth) return unauth;
    if (method === "GET") {
      const c = await ctx.runQuery(internal.clients.getOne, { clientId });
      return c ? json(c) : json({ error: "Client not found" }, 404);
    }
    if (method === "PUT") {
      const body = await request.json();
      const res = await ctx.runMutation(internal.clients.update, {
        clientId,
        name: body.name,
        location: body.location,
        config: body.config,
      });
      if ("notFound" in res && res.notFound) return json({ error: "Client not found" }, 404);
      if ("nothingToUpdate" in res && res.nothingToUpdate) {
        return json({ error: "Nothing to update" }, 400);
      }
      return json({ ok: true });
    }
    if (method === "DELETE") {
      const { deleted } = await ctx.runMutation(internal.clients.remove, { clientId });
      return deleted ? json({ ok: true }) : json({ error: "Client not found" }, 404);
    }
  }

  // ---- metrics ----
  const metricsBase = path.match(/^\/api\/metrics\/([^/]+)$/);
  if (metricsBase && method === "GET") {
    const unauth = await requireAdmin(request);
    if (unauth) return unauth;
    const from = params.get("from") || new Date(Date.now() - 3600_000).toISOString();
    const to = params.get("to") || new Date().toISOString();
    return json(
      await ctx.runQuery(internal.metrics.getMetrics, {
        clientId: metricsBase[1]!,
        from,
        to,
      }),
    );
  }

  const logsMatch = path.match(/^\/api\/metrics\/([^/]+)\/logs$/);
  if (logsMatch && method === "GET") {
    const unauth = await requireAdmin(request);
    if (unauth) return unauth;
    const { limit, offset } = parsePagination(params);
    return json(
      await ctx.runQuery(internal.metrics.getLogs, { clientId: logsMatch[1]!, limit, offset }),
    );
  }

  const probesMatch = path.match(/^\/api\/metrics\/([^/]+)\/probes$/);
  if (probesMatch && method === "GET") {
    const unauth = await requireAdmin(request);
    if (unauth) return unauth;
    const from = Number(params.get("from") ?? Date.now() - 24 * 60 * 60 * 1000);
    const to = Number(params.get("to") ?? Date.now());
    const typeParam = params.get("type");
    const type = typeParam === "icmp" || typeParam === "http" ? typeParam : undefined;
    return json(
      await ctx.runQuery(internal.metrics.getProbes, {
        clientId: probesMatch[1]!,
        from,
        to,
        type,
      }),
    );
  }

  const analysisMatch = path.match(/^\/api\/metrics\/([^/]+)\/analysis$/);
  if (analysisMatch && method === "GET") {
    const unauth = await requireAdmin(request);
    if (unauth) return unauth;
    const from = params.get("from") || new Date(Date.now() - 86400_000).toISOString();
    const to = params.get("to") || new Date().toISOString();
    return json(
      await ctx.runAction(internal.reports.analysis, { clientId: analysisMatch[1]!, from, to }),
    );
  }

  const syncStatusMatch = path.match(/^\/api\/metrics\/([^/]+)\/sync-status$/);
  if (syncStatusMatch && method === "GET") {
    const unauth = await requireAdmin(request);
    if (unauth) return unauth;
    return json(
      await ctx.runQuery(internal.metrics.getSyncStatus, { clientId: syncStatusMatch[1]! }),
    );
  }

  const reportMatch = path.match(/^\/api\/metrics\/([^/]+)\/report$/);
  if (reportMatch && method === "POST") {
    const unauth = await requireAdmin(request);
    if (unauth) return unauth;
    return json(
      await ctx.runAction(internal.reports.generateReport, {
        clientId: reportMatch[1]!,
        send: params.get("send") ?? undefined,
      }),
    );
  }

  // ---- alerts ----
  if (path === "/api/alerts" && method === "GET") {
    const unauth = await requireAdmin(request);
    if (unauth) return unauth;
    const { limit, offset } = parsePagination(params);
    return json(
      await ctx.runQuery(internal.alerts.list, {
        clientId: params.get("client_id") ?? undefined,
        limit,
        offset,
      }),
    );
  }

  if (path === "/api/alerts" && method === "PUT") {
    const unauth = await requireAdmin(request);
    if (unauth) return unauth;
    const body = await request.json();
    if (
      body.default_latency_threshold_ms === undefined &&
      body.default_loss_threshold_pct === undefined
    ) {
      return json({ error: "Nothing to update" }, 400);
    }
    return json(
      await ctx.runMutation(internal.alerts.updateThresholds, {
        default_latency_threshold_ms: body.default_latency_threshold_ms,
        default_loss_threshold_pct: body.default_loss_threshold_pct,
      }),
    );
  }

  if (path === "/api/alerts/test" && method === "POST") {
    const unauth = await requireAdmin(request);
    if (unauth) return unauth;
    await ctx.runAction(internal.reports.testAlert, {});
    return json({ ok: true });
  }

  // ---- speed test trigger ----
  const speedTrigger = path.match(/^\/api\/speedtest\/([^/]+)$/);
  if (speedTrigger && method === "POST") {
    const unauth = await requireAdmin(request);
    if (unauth) return unauth;
    if (await rateLimited(ctx, request, "speedtest", 10, 60_000)) {
      return json({ error: "Rate limit exceeded" }, 429);
    }
    const res = await ctx.runMutation(internal.commands.triggerSpeedTest, {
      clientId: speedTrigger[1]!,
    });
    if ("error" in res) return json({ error: "Client not found" }, 404);
    return json({ ok: true, message: "Speed test triggered" });
  }

  // ---- commands ----
  const cmdStatus = path.match(/^\/api\/command\/([^/]+)\/status$/);
  if (cmdStatus && method === "GET") {
    const unauth = await requireAdmin(request);
    if (unauth) return unauth;
    const res = await ctx.runQuery(internal.commands.status, { clientId: cmdStatus[1]! });
    return res ? json(res) : json({ error: "Client not found" }, 404);
  }

  const cmdMatch = path.match(/^\/api\/command\/([^/]+)$/);
  if (cmdMatch && method === "POST") {
    const unauth = await requireAdmin(request);
    if (unauth) return unauth;
    const body = await request.json();
    const res = await ctx.runMutation(internal.commands.enqueue, {
      clientId: cmdMatch[1]!,
      command: body.command,
      params: body.params,
    });
    if ("error" in res && res.error === "not_found") {
      return json({ error: "Client not found" }, 404);
    }
    if ("error" in res) return json({ error: res.error }, 400);
    return json(res);
  }

  // ---- export ----
  const exportMatch = path.match(/^\/api\/export\/([^/]+)$/);
  if (exportMatch && method === "GET") {
    const unauth = await requireAdmin(request);
    if (unauth) return unauth;
    const clientId = exportMatch[1]!;
    const format = params.get("format") || "json";
    const from = params.get("from") || new Date(Date.now() - 7 * 86400_000).toISOString();
    const to = params.get("to") || new Date().toISOString();
    const data = await ctx.runQuery(internal.metrics.exportData, { clientId, from, to });
    if (!data) return json({ error: "Client not found" }, 404);

    if (format === "csv") {
      const esc = (v: unknown) => JSON.stringify(String(v ?? ""));
      let csv = "# Ping Results\ntimestamp,rtt_ms,jitter_ms,direction,status\n";
      csv += data.ping_results
        .map((p) => [p.timestamp, p.rtt_ms, p.jitter_ms, p.direction, p.status].map(esc).join(","))
        .join("\n");
      csv += "\n\n# Speed Tests\ntimestamp,type,download_mbps,upload_mbps,payload_bytes,duration_ms\n";
      csv += data.speed_tests
        .map((s) =>
          [s.timestamp, s.type, s.download_mbps, s.upload_mbps, s.payload_bytes, s.duration_ms]
            .map(esc)
            .join(","),
        )
        .join("\n");
      return new Response(csv, {
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": `attachment; filename="pingpulse-${clientId}.csv"`,
          ...CORS_HEADERS,
        },
      });
    }

    return json({ client_id: clientId, from, to, ...data });
  }

  return json({ error: "Not found" }, 404);
});

// ---- Speed test payload endpoints (client-facing, no auth) ----
const CHUNK_SIZE = 65536;
const ZERO_CHUNK = new Uint8Array(CHUNK_SIZE);

const speedtestDownload = httpAction(async (_ctx, request) => {
  const url = new URL(request.url);
  const size = parseInt(url.searchParams.get("size") || "262144");
  const totalSize = Math.min(size, 100 * 1024 * 1024);
  let remaining = totalSize;
  const stream = new ReadableStream({
    pull(controller) {
      const chunkSize = Math.min(CHUNK_SIZE, remaining);
      controller.enqueue(chunkSize === CHUNK_SIZE ? ZERO_CHUNK : ZERO_CHUNK.slice(0, chunkSize));
      remaining -= chunkSize;
      if (remaining <= 0) controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(totalSize),
      ...CORS_HEADERS,
    },
  });
});

const speedtestUpload = httpAction(async (_ctx, request) => {
  const reader = request.body?.getReader();
  let receivedBytes = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
    }
  }
  return json({ received_bytes: receivedBytes });
});

const http = httpRouter();

for (const method of ["GET", "POST", "PUT", "DELETE", "OPTIONS"] as const) {
  http.route({ pathPrefix: "/api/", method, handler: apiHandler });
}

http.route({ path: "/speedtest/download", method: "GET", handler: speedtestDownload });
http.route({ path: "/speedtest/upload", method: "POST", handler: speedtestUpload });
http.route({
  path: "/speedtest/download",
  method: "OPTIONS",
  handler: httpAction(async () => new Response(null, { status: 204, headers: CORS_HEADERS })),
});

export default http;

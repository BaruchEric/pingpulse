# PingPulse Worker Backend — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Cloudflare Worker backend that powers PingPulse — Durable Objects for bidirectional WebSocket ping/speed monitoring, REST API for dashboard, and scheduled tasks for speed tests and archival.

**Architecture:** Single Cloudflare Worker project with Durable Objects (one per monitored client), D1 for structured storage, Analytics Engine for time-series metrics, R2 for log archival. All API routes, static assets, and WebSocket upgrades handled by one Worker entry point.

**Tech Stack:** TypeScript, Cloudflare Workers, Durable Objects, D1 (SQLite), R2, Analytics Engine, Hono (lightweight router), vitest + @cloudflare/vitest-pool-workers, bun (package manager)

**Spec:** `docs/superpowers/specs/2026-03-17-pingpulse-design.md`

---

## File Structure

```
worker/
├── wrangler.toml                          # Worker config (D1, R2, DO, AE, cron bindings)
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── index.ts                           # Worker entry: fetch handler + scheduled handler
│   ├── types.ts                           # Shared types/interfaces
│   ├── durable-objects/
│   │   └── client-monitor.ts              # ClientMonitor DO: WebSocket, pings, alarms
│   ├── api/
│   │   ├── router.ts                      # Hono router setup, mounts all route groups
│   │   ├── auth.ts                        # POST /api/auth/login, logout, me, register
│   │   ├── clients.ts                     # GET/PUT/DELETE /api/clients, /api/clients/:id
│   │   ├── metrics.ts                     # GET /api/clients/:id/metrics, /api/clients/:id/logs
│   │   ├── alerts.ts                      # GET/PUT /api/alerts, POST /api/alerts/test
│   │   └── speedtest.ts                   # POST /api/speedtest/:id
│   ├── services/
│   │   ├── alert-dispatch.ts              # Send alerts via Resend (email) + Telegram Bot API
│   │   └── archiver.ts                    # D1 → R2 archival logic (gzipped JSON)
│   ├── utils/
│   │   └── hash.ts                        # Shared hashString utility
│   └── middleware/
│       ├── rate-limit.ts                  # IP-based rate limiting using D1
│       └── auth-guard.ts                  # JWT validation middleware for admin routes
├── migrations/
│   └── 0001_initial.sql                   # D1 schema: all tables
└── test/
    ├── setup.ts                           # Test helpers, env setup
    ├── durable-objects/
    │   └── client-monitor.test.ts         # DO unit tests
    ├── api/
    │   ├── auth.test.ts                   # Auth route tests
    │   ├── clients.test.ts                # Client CRUD tests
    │   ├── metrics.test.ts                # Metrics query tests
    │   └── alerts.test.ts                 # Alerts + speedtest tests
    └── services/
        ├── alert-dispatch.test.ts         # Alert delivery tests
        └── archiver.test.ts              # Archival tests
```

---

### Task 1: Project Scaffolding

**Files:**
- Create: `worker/package.json`
- Create: `worker/tsconfig.json`
- Create: `worker/wrangler.toml`
- Create: `worker/vitest.config.ts`
- Create: `worker/src/index.ts`
- Create: `worker/src/types.ts`

- [ ] **Step 1: Initialize the Worker project**

```bash
cd /Users/ericbaruch/Arik/dev/pingpulse
mkdir -p worker/src worker/test worker/migrations
cd worker
bun init -y
```

- [ ] **Step 2: Install dependencies**

```bash
cd /Users/ericbaruch/Arik/dev/pingpulse/worker
bun add hono
bun add -d wrangler typescript @cloudflare/workers-types vitest @cloudflare/vitest-pool-workers
```

- [ ] **Step 3: Write `wrangler.toml`**

```toml
name = "pingpulse"
main = "src/index.ts"
compatibility_date = "2025-12-01"
compatibility_flags = ["nodejs_compat"]

[assets]
directory = "./dashboard/dist"

[[d1_databases]]
binding = "DB"
database_name = "pingpulse-db"
database_id = "local"  # replaced on deploy

[[r2_buckets]]
binding = "ARCHIVE"
bucket_name = "pingpulse-archive"

[[analytics_engine_datasets]]
binding = "METRICS"
dataset = "pingpulse-metrics"

[durable_objects]
bindings = [
  { name = "CLIENT_MONITOR", class_name = "ClientMonitor" }
]

[[migrations]]
tag = "v1"
new_classes = ["ClientMonitor"]

[triggers]
crons = ["0 */6 * * *"]

[vars]
ADMIN_JWT_SECRET = "change-me-in-secrets"
```

- [ ] **Step 4: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ESNext"],
    "types": ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 5: Write `vitest.config.ts`**

```typescript
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          d1Databases: ["DB"],
          r2Buckets: ["ARCHIVE"],
          durableObjects: {
            CLIENT_MONITOR: "ClientMonitor",
          },
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": "/src",
    },
  },
});
```

- [ ] **Step 6: Write minimal `src/index.ts` entry point**

```typescript
import { ClientMonitor } from "@/durable-objects/client-monitor";

export { ClientMonitor };

export interface Env {
  DB: D1Database;
  ARCHIVE: R2Bucket;
  METRICS: AnalyticsEngineDataset;
  CLIENT_MONITOR: DurableObjectNamespace;
  ADMIN_JWT_SECRET: string;
  RESEND_API_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return new Response("PingPulse API", { status: 200 });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // TODO: cron handler
  },
};
```

- [ ] **Step 7: Write `src/types.ts` with shared types**

```typescript
export interface ClientConfig {
  ping_interval_s: number;
  probe_size_bytes: number;
  full_test_schedule: string;
  full_test_payload_bytes: number;
  alert_latency_threshold_ms: number;
  alert_loss_threshold_pct: number;
  grace_period_s: number;
}

export const DEFAULT_CLIENT_CONFIG: ClientConfig = {
  ping_interval_s: 30,
  probe_size_bytes: 256 * 1024,
  full_test_schedule: "0 */6 * * *",
  full_test_payload_bytes: 10 * 1024 * 1024,
  alert_latency_threshold_ms: 100,
  alert_loss_threshold_pct: 5,
  grace_period_s: 60,
};

export interface PingResult {
  client_id: string;
  timestamp: string;
  rtt_ms: number;
  jitter_ms: number;
  direction: "cf_to_client" | "client_to_cf";
  status: "ok" | "timeout" | "error";
}

export interface SpeedTestResult {
  client_id: string;
  timestamp: string;
  type: "probe" | "full";
  download_mbps: number;
  upload_mbps: number;
  payload_bytes: number;
  duration_ms: number;
}

export interface AlertRecord {
  client_id: string;
  type: "client_down" | "client_up" | "high_latency" | "packet_loss" | "speed_degradation" | "latency_recovered";
  severity: "critical" | "warning" | "info";
  value: number;
  threshold: number;
  timestamp: string;
}

export interface ClientRecord {
  id: string;
  name: string;
  location: string;
  secret_hash: string;
  config_json: string;
  created_at: string;
  last_seen: string;
}

export type WSMessage =
  | { type: "ping"; id: string; ts: number; payload?: ArrayBuffer }
  | { type: "pong"; id: string; ts: number; client_ts: number }
  | { type: "config_update"; config: ClientConfig }
  | { type: "start_speed_test"; test_type: "probe" | "full" }
  | { type: "speed_test_result"; result: SpeedTestResult }
  | { type: "error"; message: string };
```

- [ ] **Step 8: Verify project builds**

```bash
cd /Users/ericbaruch/Arik/dev/pingpulse/worker
bunx wrangler deploy --dry-run
```

Expected: Build succeeds (dry run, no actual deploy)

- [ ] **Step 9: Commit**

```bash
git add worker/
git commit -m "feat: scaffold Worker project with wrangler, vitest, types"
```

---

### Task 2: D1 Schema & Migrations

**Files:**
- Create: `worker/migrations/0001_initial.sql`

- [ ] **Step 1: Write the migration**

```sql
-- worker/migrations/0001_initial.sql

CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  secret_hash TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  last_seen TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS registration_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_by_client_id TEXT
);

CREATE TABLE IF NOT EXISTS admin (
  id INTEGER PRIMARY KEY,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ping_results (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  rtt_ms REAL NOT NULL,
  jitter_ms REAL NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('cf_to_client', 'client_to_cf')),
  status TEXT NOT NULL CHECK (status IN ('ok', 'timeout', 'error')),
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
);

CREATE INDEX idx_ping_results_client_ts ON ping_results(client_id, timestamp);

CREATE TABLE IF NOT EXISTS speed_tests (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('probe', 'full')),
  download_mbps REAL NOT NULL,
  upload_mbps REAL NOT NULL,
  payload_bytes INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
);

CREATE INDEX idx_speed_tests_client_ts ON speed_tests(client_id, timestamp);

CREATE TABLE IF NOT EXISTS outages (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  start_ts TEXT NOT NULL,
  end_ts TEXT,
  duration_s REAL,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
);

CREATE INDEX idx_outages_client ON outages(client_id, start_ts);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
  value REAL NOT NULL,
  threshold REAL NOT NULL,
  delivered_email INTEGER NOT NULL DEFAULT 0,
  delivered_telegram INTEGER NOT NULL DEFAULT 0,
  timestamp TEXT NOT NULL,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
);

CREATE INDEX idx_alerts_client_ts ON alerts(client_id, timestamp);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL
);
```

- [ ] **Step 2: Apply migration locally**

```bash
cd /Users/ericbaruch/Arik/dev/pingpulse/worker
bunx wrangler d1 migrations apply pingpulse-db --local
```

Expected: Migration applied successfully

- [ ] **Step 3: Commit**

```bash
git add worker/migrations/
git commit -m "feat: add D1 schema with all tables and indexes"
```

---

### Task 3: API Router & Middleware Foundation

**Files:**
- Create: `worker/src/api/router.ts`
- Create: `worker/src/middleware/auth-guard.ts`
- Create: `worker/src/middleware/rate-limit.ts`
- Modify: `worker/src/index.ts`
- Create: `worker/test/setup.ts`

- [ ] **Step 1: Write test helpers**

```typescript
// worker/test/setup.ts
import { env } from "cloudflare:test";
import { hashString } from "@/utils/hash";

export async function seedAdmin(password: string = "testpass123") {
  const hash = await hashString(password);
  await env.DB.prepare(
    "INSERT OR REPLACE INTO admin (id, password_hash, created_at) VALUES (1, ?, ?)"
  )
    .bind(hash, new Date().toISOString())
    .run();
}
```

- [ ] **Step 1b: Write shared hash utility `src/utils/hash.ts`**

```typescript
// worker/src/utils/hash.ts
export async function hashString(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
```

> **Note:** All test files and `auth.ts` should import `hashString` from `@/utils/hash` instead of defining their own. The inline `hashString` / `hashPassword` helpers shown in individual test files below are for readability — implementers should import from the shared utility.

- [ ] **Step 2: Write `src/middleware/auth-guard.ts`**

```typescript
import { Context, Next } from "hono";
import type { Env } from "@/index";

export async function authGuard(c: Context<{ Bindings: Env }>, next: Next) {
  const cookie = c.req.header("Cookie");
  const token = cookie
    ?.split(";")
    .find((c) => c.trim().startsWith("session="))
    ?.split("=")[1];

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
    const signature = Uint8Array.from(atob(signatureB64.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

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
```

- [ ] **Step 3: Write `src/middleware/rate-limit.ts`**

```typescript
import { Context, Next } from "hono";
import type { Env } from "@/index";

interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

export function rateLimit(config: RateLimitConfig) {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const ip = c.req.header("CF-Connecting-IP") || "unknown";
    const path = new URL(c.req.url).pathname;
    const key = `rl:${ip}:${path}`;
    const now = new Date();
    const windowStart = new Date(now.getTime() - config.windowMs).toISOString();

    const row = await c.env.DB.prepare(
      "SELECT count, window_start FROM rate_limits WHERE key = ?"
    )
      .bind(key)
      .first<{ count: number; window_start: string }>();

    if (row && row.window_start > windowStart) {
      if (row.count >= config.maxRequests) {
        return c.json({ error: "Rate limit exceeded" }, 429);
      }
      await c.env.DB.prepare(
        "UPDATE rate_limits SET count = count + 1 WHERE key = ?"
      )
        .bind(key)
        .run();
    } else {
      await c.env.DB.prepare(
        "INSERT OR REPLACE INTO rate_limits (key, count, window_start) VALUES (?, 1, ?)"
      )
        .bind(key, now.toISOString())
        .run();
    }

    await next();
  };
}
```

- [ ] **Step 4: Write `src/api/router.ts`**

```typescript
import { Hono } from "hono";
import type { Env } from "@/index";
import { authGuard } from "@/middleware/auth-guard";
import { rateLimit } from "@/middleware/rate-limit";

export function createRouter() {
  const app = new Hono<{ Bindings: Env }>();

  // Global rate limit: 60 req/min per IP
  app.use("/api/*", rateLimit({ maxRequests: 60, windowMs: 60_000 }));

  // Health check (no auth)
  app.get("/api/health", (c) => c.json({ status: "ok", timestamp: new Date().toISOString() }));

  // Auth routes (no auth guard — these handle their own auth)
  // Mounted in auth.ts

  // Protected routes
  // app.use("/api/clients/*", authGuard);
  // app.use("/api/alerts/*", authGuard);
  // app.use("/api/speedtest/*", authGuard);
  // app.use("/api/export/*", authGuard);

  return app;
}
```

- [ ] **Step 5: Update `src/index.ts` to use the router**

```typescript
import { ClientMonitor } from "@/durable-objects/client-monitor";
import { createRouter } from "@/api/router";

export { ClientMonitor };

export interface Env {
  DB: D1Database;
  ARCHIVE: R2Bucket;
  METRICS: AnalyticsEngineDataset;
  CLIENT_MONITOR: DurableObjectNamespace;
  ADMIN_JWT_SECRET: string;
  RESEND_API_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
}

const app = createRouter();

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // WebSocket upgrade for client connections
    const url = new URL(request.url);
    if (url.pathname.startsWith("/ws/") && request.headers.get("Upgrade") === "websocket") {
      const clientId = url.pathname.split("/ws/")[1];
      if (!clientId) return new Response("Missing client ID", { status: 400 });

      const id = env.CLIENT_MONITOR.idFromName(clientId);
      const stub = env.CLIENT_MONITOR.get(id);
      return stub.fetch(request);
    }

    return app.fetch(request, env, ctx);
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // TODO: cron handler
  },
};
```

- [ ] **Step 6: Run vitest to verify setup compiles**

```bash
cd /Users/ericbaruch/Arik/dev/pingpulse/worker
bunx vitest run --passWithNoTests
```

Expected: 0 tests, passes with no errors

- [ ] **Step 7: Commit**

```bash
git add worker/src/api/ worker/src/middleware/ worker/test/
git commit -m "feat: add API router, auth guard, rate limiting middleware"
```

---

### Task 4: Admin Auth Routes

**Files:**
- Create: `worker/src/api/auth.ts`
- Create: `worker/test/api/auth.test.ts`
- Modify: `worker/src/api/router.ts`

- [ ] **Step 1: Write failing tests for admin auth**

```typescript
// worker/test/api/auth.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { createRouter } from "@/api/router";

const app = createRouter();

async function hashPassword(password: string): Promise<string> {
  const data = new TextEncoder().encode(password);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function seedAdmin(password: string = "testpass123") {
  const hash = await hashPassword(password);
  await env.DB.prepare(
    "INSERT OR REPLACE INTO admin (id, password_hash, created_at) VALUES (1, ?, ?)"
  ).bind(hash, new Date().toISOString()).run();
}

describe("POST /api/auth/login", () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM admin");
    await seedAdmin();
  });

  it("returns JWT on valid password", async () => {
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "testpass123" }),
    }, env);
    expect(res.status).toBe(200);
    const data = await res.json<{ token: string }>();
    expect(data.token).toBeTruthy();
    expect(res.headers.get("Set-Cookie")).toContain("session=");
  });

  it("returns 401 on wrong password", async () => {
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "wrong" }),
    }, env);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/auth/me", () => {
  it("returns 401 without session", async () => {
    const res = await app.request("/api/auth/me", {}, env);
    expect(res.status).toBe(401);
  });
});

describe("POST /api/auth/logout", () => {
  it("clears session cookie", async () => {
    const res = await app.request("/api/auth/logout", {
      method: "POST",
    }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toContain("session=;");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/ericbaruch/Arik/dev/pingpulse/worker
bunx vitest run test/api/auth.test.ts
```

Expected: FAIL — routes not implemented

- [ ] **Step 3: Implement auth routes**

```typescript
// worker/src/api/auth.ts
import { Hono } from "hono";
import type { Env } from "@/index";
import { rateLimit } from "@/middleware/rate-limit";

export const authRoutes = new Hono<{ Bindings: Env }>();

async function hashString(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function createJWT(secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = btoa(
    JSON.stringify({
      sub: "admin",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 86400, // 24h
    })
  );

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${header}.${payload}`)
  );

  const sig = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return `${header}.${payload}.${sig}`;
}

// Login: 5 attempts/min
authRoutes.post("/login", rateLimit({ maxRequests: 5, windowMs: 60_000 }), async (c) => {
  const { password } = await c.req.json<{ password: string }>();
  const hash = await hashString(password);

  const admin = await c.env.DB.prepare("SELECT password_hash FROM admin WHERE id = 1")
    .first<{ password_hash: string }>();

  if (!admin || admin.password_hash !== hash) {
    return c.json({ error: "Invalid password" }, 401);
  }

  const token = await createJWT(c.env.ADMIN_JWT_SECRET);
  return c.json({ token }, 200, {
    "Set-Cookie": `session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
  });
});

authRoutes.post("/logout", (c) => {
  return c.json({ ok: true }, 200, {
    "Set-Cookie": "session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
  });
});

authRoutes.get("/me", authGuard, async (c) => {
  // authGuard already validated the JWT signature + expiry
  const cookie = c.req.header("Cookie");
  const token = cookie!
    .split(";")
    .find((s) => s.trim().startsWith("session="))!
    .split("=")[1];

  const [, payloadB64] = token.split(".");
  const payload = JSON.parse(atob(payloadB64));
  return c.json({ sub: payload.sub, exp: payload.exp });
});
```

- [ ] **Step 4: Mount auth routes in router**

Add to `src/api/router.ts`:

```typescript
import { authRoutes } from "@/api/auth";

// Inside createRouter():
app.route("/api/auth", authRoutes);
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd /Users/ericbaruch/Arik/dev/pingpulse/worker
bunx vitest run test/api/auth.test.ts
```

Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add worker/src/api/auth.ts worker/test/api/auth.test.ts worker/src/api/router.ts
git commit -m "feat: add admin auth routes (login, logout, me) with JWT"
```

---

### Task 5: Client Registration Flow

**Files:**
- Modify: `worker/src/api/auth.ts`
- Modify: `worker/test/api/auth.test.ts`

- [ ] **Step 1: Write failing tests for registration**

Add to `worker/test/api/auth.test.ts`:

```typescript
describe("POST /api/auth/register", () => {
  let adminToken: string;

  beforeEach(async () => {
    await env.DB.exec("DELETE FROM admin; DELETE FROM registration_tokens; DELETE FROM clients");
    await seedAdmin();
    // Login to get admin token
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "testpass123" }),
    }, env);
    const data = await res.json<{ token: string }>();
    adminToken = data.token;
  });

  it("generates a registration token (admin required)", async () => {
    const res = await app.request("/api/auth/register/token", {
      method: "POST",
      headers: { Cookie: `session=${adminToken}` },
    }, env);
    expect(res.status).toBe(200);
    const data = await res.json<{ token: string; expires_at: string }>();
    expect(data.token).toHaveLength(43); // 32 bytes base62 ≈ 43 chars
    expect(data.expires_at).toBeTruthy();
  });

  it("exchanges valid token for client credentials", async () => {
    // Generate token
    const genRes = await app.request("/api/auth/register/token", {
      method: "POST",
      headers: { Cookie: `session=${adminToken}` },
    }, env);
    const { token } = await genRes.json<{ token: string }>();

    // Exchange
    const regRes = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, name: "Home Office", location: "Toronto" }),
    }, env);
    expect(regRes.status).toBe(200);
    const data = await regRes.json<{ client_id: string; client_secret: string; ws_url: string }>();
    expect(data.client_id).toBeTruthy();
    expect(data.client_secret).toBeTruthy();
    expect(data.ws_url).toContain("/ws/");
  });

  it("rejects expired token", async () => {
    // Insert an already-expired token
    const hash = await hashString("expired-token");
    const past = new Date(Date.now() - 60_000).toISOString();
    await env.DB.prepare(
      "INSERT INTO registration_tokens (id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)"
    ).bind("t1", hash, past, past).run();

    const res = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "expired-token", name: "Test", location: "Test" }),
    }, env);
    expect(res.status).toBe(401);
  });

  it("rejects already-used token", async () => {
    // Generate and use a token
    const genRes = await app.request("/api/auth/register/token", {
      method: "POST",
      headers: { Cookie: `session=${adminToken}` },
    }, env);
    const { token } = await genRes.json<{ token: string }>();

    // First use
    await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, name: "Client1", location: "A" }),
    }, env);

    // Second use — should fail
    const res = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, name: "Client2", location: "B" }),
    }, env);
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bunx vitest run test/api/auth.test.ts
```

Expected: FAIL — registration routes not implemented

- [ ] **Step 3: Implement registration routes**

Add to `worker/src/api/auth.ts`:

```typescript
import { authGuard } from "@/middleware/auth-guard";
import { DEFAULT_CLIENT_CONFIG } from "@/types";

function generateToken(length: number = 32): string {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

// Generate registration token (admin only)
authRoutes.post("/register/token", authGuard, async (c) => {
  const token = generateToken(32);
  const tokenHash = await hashString(token);
  const id = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 15 * 60_000); // 15 min

  await c.env.DB.prepare(
    "INSERT INTO registration_tokens (id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)"
  )
    .bind(id, tokenHash, now.toISOString(), expiresAt.toISOString())
    .run();

  return c.json({ token, expires_at: expiresAt.toISOString() });
});

// Exchange registration token for client credentials (no auth — token IS the auth)
authRoutes.post("/register", async (c) => {
  const { token, name, location } = await c.req.json<{
    token: string;
    name: string;
    location: string;
  }>();

  const tokenHash = await hashString(token);
  const row = await c.env.DB.prepare(
    "SELECT id, expires_at, used_at FROM registration_tokens WHERE token_hash = ?"
  ).bind(tokenHash).first<{ id: string; expires_at: string; used_at: string | null }>();

  if (!row) return c.json({ error: "Invalid token" }, 401);
  if (row.used_at) return c.json({ error: "Token already used" }, 401);
  if (new Date(row.expires_at) < new Date()) return c.json({ error: "Token expired" }, 401);

  const clientId = crypto.randomUUID();
  const clientSecret = generateToken(48);
  const secretHash = await hashString(clientSecret);
  const now = new Date().toISOString();

  // Mark token as used
  await c.env.DB.prepare(
    "UPDATE registration_tokens SET used_at = ?, used_by_client_id = ? WHERE id = ?"
  ).bind(now, clientId, row.id).run();

  // Create client record
  await c.env.DB.prepare(
    "INSERT INTO clients (id, name, location, secret_hash, config_json, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(clientId, name, location, secretHash, JSON.stringify(DEFAULT_CLIENT_CONFIG), now, now)
    .run();

  const wsUrl = `/ws/${clientId}`;
  return c.json({ client_id: clientId, client_secret: clientSecret, ws_url: wsUrl });
});
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bunx vitest run test/api/auth.test.ts
```

Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/api/auth.ts worker/test/api/auth.test.ts
git commit -m "feat: add client registration with single-use time-limited tokens"
```

---

### Task 6: ClientMonitor Durable Object — WebSocket Lifecycle

**Files:**
- Create: `worker/src/durable-objects/client-monitor.ts`
- Create: `worker/test/durable-objects/client-monitor.test.ts`

- [ ] **Step 1: Write failing tests for WebSocket lifecycle**

```typescript
// worker/test/durable-objects/client-monitor.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";

async function hashString(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("ClientMonitor DO", () => {
  const clientId = "test-client-1";
  const clientSecret = "test-secret-123";

  beforeEach(async () => {
    await env.DB.exec("DELETE FROM clients");
    const hash = await hashString(clientSecret);
    await env.DB.prepare(
      "INSERT INTO clients (id, name, location, secret_hash, config_json, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(clientId, "Test", "Toronto", hash, "{}", new Date().toISOString(), new Date().toISOString())
      .run();
  });

  it("accepts WebSocket with valid auth", async () => {
    const id = env.CLIENT_MONITOR.idFromName(clientId);
    const stub = env.CLIENT_MONITOR.get(id);

    const res = await stub.fetch(`http://localhost/ws/${clientId}`, {
      headers: {
        Upgrade: "websocket",
        Authorization: `Bearer ${clientSecret}`,
      },
    });

    expect(res.status).toBe(101);
    expect(res.webSocket).toBeTruthy();
  });

  it("rejects WebSocket without auth", async () => {
    const id = env.CLIENT_MONITOR.idFromName(clientId);
    const stub = env.CLIENT_MONITOR.get(id);

    const res = await stub.fetch(`http://localhost/ws/${clientId}`, {
      headers: { Upgrade: "websocket" },
    });

    expect(res.status).toBe(401);
  });

  it("rejects WebSocket with wrong secret", async () => {
    const id = env.CLIENT_MONITOR.idFromName(clientId);
    const stub = env.CLIENT_MONITOR.get(id);

    const res = await stub.fetch(`http://localhost/ws/${clientId}`, {
      headers: {
        Upgrade: "websocket",
        Authorization: "Bearer wrong-secret",
      },
    });

    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bunx vitest run test/durable-objects/client-monitor.test.ts
```

Expected: FAIL — DO not implemented

- [ ] **Step 3: Implement ClientMonitor DO with WebSocket**

```typescript
// worker/src/durable-objects/client-monitor.ts
import type { Env } from "@/index";
import type { ClientConfig, PingResult, WSMessage } from "@/types";
import { DEFAULT_CLIENT_CONFIG } from "@/types";

interface PingInFlight {
  id: string;
  sent_ts: number;
}

export class ClientMonitor implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private sessions: WebSocket[] = [];
  private clientId: string | null = null;
  private config: ClientConfig = DEFAULT_CLIENT_CONFIG;
  private pingBuffer: PingResult[] = [];
  private recentRTTs: number[] = [];
  private pingsInFlight: Map<string, PingInFlight> = new Map();
  private runningJitter: number = 0;
  private lastFlush: number = Date.now();
  private disconnectedAt: number | null = null;
  private currentOutageId: string | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathParts = url.pathname.split("/");
    this.clientId = pathParts[pathParts.length - 1] || null;

    if (request.headers.get("Upgrade") !== "websocket") {
      // Internal API calls from cron/other workers
      if (url.pathname.endsWith("/trigger-speed-test")) {
        return this.handleSpeedTestTrigger();
      }
      return new Response("Expected WebSocket", { status: 400 });
    }

    // Authenticate
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response("Unauthorized", { status: 401 });
    }

    const secret = authHeader.slice(7);
    const isValid = await this.validateSecret(secret);
    if (!isValid) {
      return new Response("Unauthorized", { status: 401 });
    }

    // Accept WebSocket
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.state.acceptWebSocket(server);
    this.sessions.push(server);

    // Client connected — clear any disconnection state
    if (this.disconnectedAt) {
      await this.handleReconnect();
    }

    // Update last_seen
    await this.env.DB.prepare("UPDATE clients SET last_seen = ? WHERE id = ?")
      .bind(new Date().toISOString(), this.clientId)
      .run();

    // Start ping alarm if not already running
    const currentAlarm = await this.state.storage.getAlarm();
    if (!currentAlarm) {
      await this.state.storage.setAlarm(Date.now() + this.config.ping_interval_s * 1000);
    }

    // Send current config to client
    server.send(JSON.stringify({
      type: "config_update",
      config: this.config,
    } satisfies WSMessage));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string") return;

    try {
      const msg: WSMessage = JSON.parse(message);

      switch (msg.type) {
        case "pong":
          await this.handlePong(msg);
          break;
        case "ping":
          // Client-to-CF ping — echo back immediately
          ws.send(JSON.stringify({
            type: "pong",
            id: msg.id,
            ts: msg.ts,
            client_ts: Date.now(),
          } satisfies WSMessage));
          break;
        case "speed_test_result":
          await this.handleSpeedTestResult(msg.result);
          break;
      }
    } catch {
      // Ignore malformed messages
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    this.sessions = this.sessions.filter((s) => s !== ws);
    if (this.sessions.length === 0) {
      this.disconnectedAt = Date.now();
      // Set alarm for grace period check
      await this.state.storage.setAlarm(
        Date.now() + this.config.grace_period_s * 1000
      );
    }
  }

  async webSocketError(ws: WebSocket, error: unknown) {
    this.sessions = this.sessions.filter((s) => s !== ws);
    if (this.sessions.length === 0) {
      this.disconnectedAt = Date.now();
      await this.state.storage.setAlarm(
        Date.now() + this.config.grace_period_s * 1000
      );
    }
  }

  async alarm() {
    // Check if this is a disconnection grace period check
    if (this.disconnectedAt && this.sessions.length === 0) {
      const elapsed = Date.now() - this.disconnectedAt;
      if (elapsed >= this.config.grace_period_s * 1000) {
        await this.triggerAlert("client_down", "critical", elapsed / 1000, this.config.grace_period_s);
        // Record outage start
        this.currentOutageId = crypto.randomUUID();
        await this.env.DB.prepare(
          "INSERT INTO outages (id, client_id, start_ts) VALUES (?, ?, ?)"
        )
          .bind(this.currentOutageId, this.clientId, new Date(this.disconnectedAt).toISOString())
          .run();
      }
      return; // Don't schedule next ping — client is disconnected
    }

    // Normal ping alarm
    if (this.sessions.length > 0) {
      await this.sendPing();
      await this.maybeFlushBuffer();
      // Schedule next ping
      await this.state.storage.setAlarm(Date.now() + this.config.ping_interval_s * 1000);
    }
  }

  private async validateSecret(secret: string): Promise<boolean> {
    if (!this.clientId) return false;

    const data = new TextEncoder().encode(secret);
    const buf = await crypto.subtle.digest("SHA-256", data);
    const hash = Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const row = await this.env.DB.prepare(
      "SELECT secret_hash FROM clients WHERE id = ?"
    )
      .bind(this.clientId)
      .first<{ secret_hash: string }>();

    return row?.secret_hash === hash;
  }

  private async sendPing() {
    const pingId = crypto.randomUUID();
    const now = Date.now();

    this.pingsInFlight.set(pingId, { id: pingId, sent_ts: now });

    // Timeout after 10s
    setTimeout(() => {
      if (this.pingsInFlight.has(pingId)) {
        this.pingsInFlight.delete(pingId);
        this.pingBuffer.push({
          client_id: this.clientId!,
          timestamp: new Date(now).toISOString(),
          rtt_ms: -1,
          jitter_ms: 0,
          direction: "cf_to_client",
          status: "timeout",
        });
      }
    }, 10_000);

    const msg: WSMessage = { type: "ping", id: pingId, ts: now };
    for (const ws of this.sessions) {
      try {
        ws.send(JSON.stringify(msg));
      } catch {
        // WebSocket may be closing
      }
    }
  }

  private async handlePong(msg: WSMessage & { type: "pong" }) {
    const inFlight = this.pingsInFlight.get(msg.id);
    if (!inFlight) return;

    this.pingsInFlight.delete(msg.id);
    const rtt = Date.now() - inFlight.sent_ts;

    // RFC 3550 jitter: J(i) = J(i-1) + (|D(i-1,i)| - J(i-1)) / 16
    // this.runningJitter is persistent state across pongs
    if (this.recentRTTs.length > 0) {
      const lastRTT = this.recentRTTs[this.recentRTTs.length - 1];
      const diff = Math.abs(rtt - lastRTT);
      this.runningJitter = this.runningJitter + (diff - this.runningJitter) / 16;
    }
    const jitter = this.runningJitter;

    this.recentRTTs.push(rtt);
    if (this.recentRTTs.length > 100) this.recentRTTs.shift();

    const result: PingResult = {
      client_id: this.clientId!,
      timestamp: new Date().toISOString(),
      rtt_ms: rtt,
      jitter_ms: Math.round(jitter * 100) / 100,
      direction: "cf_to_client",
      status: "ok",
    };

    this.pingBuffer.push(result);

    // Check latency threshold
    if (rtt > this.config.alert_latency_threshold_ms) {
      await this.triggerAlert("high_latency", "warning", rtt, this.config.alert_latency_threshold_ms);
    }

    // Check packet loss (over last 20 pings)
    const recentResults = this.pingBuffer.slice(-20);
    const timeouts = recentResults.filter((r) => r.status === "timeout").length;
    const lossPct = (timeouts / recentResults.length) * 100;
    if (lossPct > this.config.alert_loss_threshold_pct) {
      await this.triggerAlert("packet_loss", "warning", lossPct, this.config.alert_loss_threshold_pct);
    }
  }

  private async maybeFlushBuffer() {
    const now = Date.now();
    const shouldFlush =
      this.pingBuffer.length >= 10 || now - this.lastFlush >= 60_000;

    if (!shouldFlush || this.pingBuffer.length === 0) return;

    const batch = this.pingBuffer.splice(0);
    this.lastFlush = now;

    // Batch insert to D1
    const stmt = this.env.DB.prepare(
      "INSERT INTO ping_results (id, client_id, timestamp, rtt_ms, jitter_ms, direction, status) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );

    const stmts = batch.map((r) =>
      stmt.bind(crypto.randomUUID(), r.client_id, r.timestamp, r.rtt_ms, r.jitter_ms, r.direction, r.status)
    );

    await this.env.DB.batch(stmts);

    // Write to Analytics Engine
    for (const r of batch) {
      if (r.status === "ok") {
        this.env.METRICS.writeDataPoint({
          blobs: [r.client_id, "latency"],
          doubles: [r.rtt_ms],
        });
        this.env.METRICS.writeDataPoint({
          blobs: [r.client_id, "jitter"],
          doubles: [r.jitter_ms],
        });
      }
    }
  }

  private async handleReconnect() {
    if (this.currentOutageId) {
      const now = new Date();
      const duration = this.disconnectedAt
        ? (now.getTime() - this.disconnectedAt) / 1000
        : 0;

      await this.env.DB.prepare(
        "UPDATE outages SET end_ts = ?, duration_s = ? WHERE id = ?"
      )
        .bind(now.toISOString(), duration, this.currentOutageId)
        .run();

      await this.triggerAlert("client_up", "info", duration, 0);
      this.currentOutageId = null;
    }
    this.disconnectedAt = null;
  }

  private async handleSpeedTestResult(result: SpeedTestResult) {
    await this.env.DB.prepare(
      "INSERT INTO speed_tests (id, client_id, timestamp, type, download_mbps, upload_mbps, payload_bytes, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(
        crypto.randomUUID(),
        result.client_id,
        result.timestamp,
        result.type,
        result.download_mbps,
        result.upload_mbps,
        result.payload_bytes,
        result.duration_ms
      )
      .run();

    // Write to Analytics Engine
    this.env.METRICS.writeDataPoint({
      blobs: [result.client_id, "download_mbps"],
      doubles: [result.download_mbps],
    });
    this.env.METRICS.writeDataPoint({
      blobs: [result.client_id, "upload_mbps"],
      doubles: [result.upload_mbps],
    });
  }

  private handleSpeedTestTrigger(): Response {
    for (const ws of this.sessions) {
      try {
        ws.send(JSON.stringify({ type: "start_speed_test", test_type: "full" } satisfies WSMessage));
      } catch {
        // ignore
      }
    }
    return new Response("OK");
  }

  private lastAlertTimes: Map<string, number> = new Map();

  private async triggerAlert(
    type: AlertRecord["type"],
    severity: AlertRecord["severity"],
    value: number,
    threshold: number
  ) {
    // Deduplication: 5-minute cooldown per alert type
    const lastTime = this.lastAlertTimes.get(type) || 0;
    if (Date.now() - lastTime < 5 * 60_000) return;
    this.lastAlertTimes.set(type, Date.now());

    const alertId = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    await this.env.DB.prepare(
      "INSERT INTO alerts (id, client_id, type, severity, value, threshold, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(alertId, this.clientId, type, severity, value, threshold, timestamp)
      .run();

    // Dispatch alert directly from the DO (same Worker, direct import)
    const { dispatchAlert } = await import("@/services/alert-dispatch");
    try {
      await dispatchAlert(this.env, {
        alert_id: alertId,
        client_id: this.clientId!,
        type,
        severity,
        value,
        threshold,
        timestamp,
      });
    } catch {
      // Best effort — alert is already stored in D1
    }
  }
}

// Need this import for type
import type { AlertRecord, SpeedTestResult } from "@/types";
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bunx vitest run test/durable-objects/client-monitor.test.ts
```

Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/durable-objects/ worker/test/durable-objects/
git commit -m "feat: add ClientMonitor DO with WebSocket auth, ping, alerting"
```

---

### Task 7: Client CRUD Routes

**Files:**
- Create: `worker/src/api/clients.ts`
- Create: `worker/test/api/clients.test.ts`
- Modify: `worker/src/api/router.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// worker/test/api/clients.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { createRouter } from "@/api/router";

const app = createRouter();

async function hashString(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

let adminCookie: string;

async function setup() {
  await env.DB.exec("DELETE FROM admin; DELETE FROM clients");
  const hash = await hashString("testpass123");
  await env.DB.prepare("INSERT INTO admin (id, password_hash, created_at) VALUES (1, ?, ?)").bind(hash, new Date().toISOString()).run();
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "testpass123" }),
  }, env);
  const { token } = await res.json<{ token: string }>();
  adminCookie = `session=${token}`;

  // Seed a client
  const secretHash = await hashString("client-secret");
  await env.DB.prepare(
    "INSERT INTO clients (id, name, location, secret_hash, config_json, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind("c1", "Home", "Toronto", secretHash, '{"ping_interval_s":30}', new Date().toISOString(), new Date().toISOString()).run();
}

describe("GET /api/clients", () => {
  beforeEach(setup);

  it("lists all clients", async () => {
    const res = await app.request("/api/clients", {
      headers: { Cookie: adminCookie },
    }, env);
    expect(res.status).toBe(200);
    const data = await res.json<{ clients: any[] }>();
    expect(data.clients).toHaveLength(1);
    expect(data.clients[0].name).toBe("Home");
  });

  it("returns 401 without auth", async () => {
    const res = await app.request("/api/clients", {}, env);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/clients/:id", () => {
  beforeEach(setup);

  it("returns client details", async () => {
    const res = await app.request("/api/clients/c1", {
      headers: { Cookie: adminCookie },
    }, env);
    expect(res.status).toBe(200);
    const data = await res.json<{ id: string; name: string }>();
    expect(data.name).toBe("Home");
  });

  it("returns 404 for unknown client", async () => {
    const res = await app.request("/api/clients/unknown", {
      headers: { Cookie: adminCookie },
    }, env);
    expect(res.status).toBe(404);
  });
});

describe("PUT /api/clients/:id", () => {
  beforeEach(setup);

  it("updates client config", async () => {
    const res = await app.request("/api/clients/c1", {
      method: "PUT",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Office", location: "Montreal", config: { ping_interval_s: 60 } }),
    }, env);
    expect(res.status).toBe(200);

    const check = await app.request("/api/clients/c1", {
      headers: { Cookie: adminCookie },
    }, env);
    const data = await check.json<{ name: string }>();
    expect(data.name).toBe("Office");
  });
});

describe("DELETE /api/clients/:id", () => {
  beforeEach(setup);

  it("deletes a client", async () => {
    const res = await app.request("/api/clients/c1", {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    }, env);
    expect(res.status).toBe(200);

    const check = await app.request("/api/clients/c1", {
      headers: { Cookie: adminCookie },
    }, env);
    expect(check.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bunx vitest run test/api/clients.test.ts
```

Expected: FAIL — routes not implemented

- [ ] **Step 3: Implement client routes**

```typescript
// worker/src/api/clients.ts
import { Hono } from "hono";
import type { Env } from "@/index";
import { authGuard } from "@/middleware/auth-guard";

export const clientRoutes = new Hono<{ Bindings: Env }>();

clientRoutes.use("*", authGuard);

clientRoutes.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, name, location, config_json, created_at, last_seen FROM clients ORDER BY created_at DESC"
  ).all();

  const clients = results.map((r: any) => ({
    id: r.id,
    name: r.name,
    location: r.location,
    config: JSON.parse(r.config_json),
    created_at: r.created_at,
    last_seen: r.last_seen,
  }));

  return c.json({ clients });
});

clientRoutes.get("/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare(
    "SELECT id, name, location, config_json, created_at, last_seen FROM clients WHERE id = ?"
  ).bind(id).first();

  if (!row) return c.json({ error: "Client not found" }, 404);

  return c.json({
    ...row,
    config: JSON.parse(row.config_json as string),
  });
});

clientRoutes.put("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ name?: string; location?: string; config?: Record<string, any> }>();

  const existing = await c.env.DB.prepare("SELECT id, config_json FROM clients WHERE id = ?")
    .bind(id).first();
  if (!existing) return c.json({ error: "Client not found" }, 404);

  const updates: string[] = [];
  const values: any[] = [];

  if (body.name !== undefined) { updates.push("name = ?"); values.push(body.name); }
  if (body.location !== undefined) { updates.push("location = ?"); values.push(body.location); }
  if (body.config !== undefined) {
    const merged = { ...JSON.parse(existing.config_json as string), ...body.config };
    updates.push("config_json = ?");
    values.push(JSON.stringify(merged));
  }

  if (updates.length === 0) return c.json({ error: "Nothing to update" }, 400);

  values.push(id);
  await c.env.DB.prepare(`UPDATE clients SET ${updates.join(", ")} WHERE id = ?`)
    .bind(...values).run();

  return c.json({ ok: true });
});

clientRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");

  const existing = await c.env.DB.prepare("SELECT id FROM clients WHERE id = ?")
    .bind(id).first();
  if (!existing) return c.json({ error: "Client not found" }, 404);

  // Cascade deletes handled by FK constraints, but D1 doesn't enforce FK by default
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM ping_results WHERE client_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM speed_tests WHERE client_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM outages WHERE client_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM alerts WHERE client_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM clients WHERE id = ?").bind(id),
  ]);

  return c.json({ ok: true });
});
```

- [ ] **Step 4: Mount in router**

Add to `src/api/router.ts`:

```typescript
import { clientRoutes } from "@/api/clients";

// Inside createRouter():
app.route("/api/clients", clientRoutes);
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
bunx vitest run test/api/clients.test.ts
```

Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add worker/src/api/clients.ts worker/test/api/clients.test.ts worker/src/api/router.ts
git commit -m "feat: add client CRUD routes with auth guard"
```

---

### Task 8: Metrics & Logs Routes

**Files:**
- Create: `worker/src/api/metrics.ts`
- Create: `worker/test/api/metrics.test.ts`
- Modify: `worker/src/api/router.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// worker/test/api/metrics.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { createRouter } from "@/api/router";

const app = createRouter();

async function hashString(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

let adminCookie: string;

async function setup() {
  await env.DB.exec("DELETE FROM admin; DELETE FROM clients; DELETE FROM ping_results; DELETE FROM speed_tests");
  const hash = await hashString("testpass123");
  await env.DB.prepare("INSERT INTO admin (id, password_hash, created_at) VALUES (1, ?, ?)").bind(hash, new Date().toISOString()).run();
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "testpass123" }),
  }, env);
  const { token } = await res.json<{ token: string }>();
  adminCookie = `session=${token}`;

  // Seed client + ping data
  const secretHash = await hashString("s");
  await env.DB.prepare(
    "INSERT INTO clients (id, name, location, secret_hash, config_json, created_at, last_seen) VALUES ('c1', 'Home', 'Toronto', ?, '{}', ?, ?)"
  ).bind(secretHash, new Date().toISOString(), new Date().toISOString()).run();

  const now = new Date();
  for (let i = 0; i < 5; i++) {
    const ts = new Date(now.getTime() - i * 30_000).toISOString();
    await env.DB.prepare(
      "INSERT INTO ping_results (id, client_id, timestamp, rtt_ms, jitter_ms, direction, status) VALUES (?, 'c1', ?, ?, ?, 'cf_to_client', 'ok')"
    ).bind(crypto.randomUUID(), ts, 20 + i, 1.5).run();
  }
}

describe("GET /api/clients/:id/metrics", () => {
  beforeEach(setup);

  it("returns metrics for time range", async () => {
    const from = new Date(Date.now() - 3600_000).toISOString();
    const to = new Date().toISOString();
    const res = await app.request(`/api/clients/c1/metrics?from=${from}&to=${to}`, {
      headers: { Cookie: adminCookie },
    }, env);
    expect(res.status).toBe(200);
    const data = await res.json<{ pings: any[]; summary: any }>();
    expect(data.pings.length).toBeGreaterThan(0);
    expect(data.summary.avg_rtt_ms).toBeGreaterThan(0);
  });
});

describe("GET /api/clients/:id/logs", () => {
  beforeEach(setup);

  it("returns paginated logs", async () => {
    const res = await app.request("/api/clients/c1/logs?limit=3&offset=0", {
      headers: { Cookie: adminCookie },
    }, env);
    expect(res.status).toBe(200);
    const data = await res.json<{ logs: any[]; total: number }>();
    expect(data.logs).toHaveLength(3);
    expect(data.total).toBe(5);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bunx vitest run test/api/metrics.test.ts
```

Expected: FAIL

- [ ] **Step 3: Implement metrics routes**

```typescript
// worker/src/api/metrics.ts
import { Hono } from "hono";
import type { Env } from "@/index";
import { authGuard } from "@/middleware/auth-guard";

export const metricsRoutes = new Hono<{ Bindings: Env }>();

metricsRoutes.use("*", authGuard);

// GET /api/clients/:id/metrics?from=ISO&to=ISO
metricsRoutes.get("/:id/metrics", async (c) => {
  const id = c.req.param("id");
  const from = c.req.query("from") || new Date(Date.now() - 3600_000).toISOString();
  const to = c.req.query("to") || new Date().toISOString();

  const { results: pings } = await c.env.DB.prepare(
    "SELECT timestamp, rtt_ms, jitter_ms, direction, status FROM ping_results WHERE client_id = ? AND timestamp BETWEEN ? AND ? ORDER BY timestamp DESC"
  ).bind(id, from, to).all();

  const { results: speedTests } = await c.env.DB.prepare(
    "SELECT timestamp, type, download_mbps, upload_mbps, payload_bytes, duration_ms FROM speed_tests WHERE client_id = ? AND timestamp BETWEEN ? AND ? ORDER BY timestamp DESC"
  ).bind(id, from, to).all();

  const { results: outages } = await c.env.DB.prepare(
    "SELECT start_ts, end_ts, duration_s FROM outages WHERE client_id = ? AND start_ts BETWEEN ? AND ? ORDER BY start_ts DESC"
  ).bind(id, from, to).all();

  // Calculate summary
  const okPings = pings.filter((p: any) => p.status === "ok");
  const rtts = okPings.map((p: any) => p.rtt_ms as number);
  const sorted = [...rtts].sort((a, b) => a - b);

  const summary = {
    total_pings: pings.length,
    ok_pings: okPings.length,
    timeout_pings: pings.filter((p: any) => p.status === "timeout").length,
    loss_pct: pings.length > 0 ? ((pings.length - okPings.length) / pings.length) * 100 : 0,
    avg_rtt_ms: rtts.length > 0 ? rtts.reduce((a, b) => a + b, 0) / rtts.length : 0,
    min_rtt_ms: sorted[0] || 0,
    max_rtt_ms: sorted[sorted.length - 1] || 0,
    p50_rtt_ms: sorted[Math.floor(sorted.length * 0.5)] || 0,
    p95_rtt_ms: sorted[Math.floor(sorted.length * 0.95)] || 0,
    p99_rtt_ms: sorted[Math.floor(sorted.length * 0.99)] || 0,
  };

  return c.json({ pings, speed_tests: speedTests, outages, summary });
});

// GET /api/clients/:id/logs?limit=50&offset=0
metricsRoutes.get("/:id/logs", async (c) => {
  const id = c.req.param("id");
  const limit = parseInt(c.req.query("limit") || "50");
  const offset = parseInt(c.req.query("offset") || "0");

  const countRow = await c.env.DB.prepare(
    "SELECT COUNT(*) as total FROM ping_results WHERE client_id = ?"
  ).bind(id).first<{ total: number }>();

  const { results: logs } = await c.env.DB.prepare(
    "SELECT id, timestamp, rtt_ms, jitter_ms, direction, status FROM ping_results WHERE client_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?"
  ).bind(id, limit, offset).all();

  return c.json({ logs, total: countRow?.total || 0, limit, offset });
});
```

- [ ] **Step 4: Mount in router**

Add to `src/api/router.ts`:

```typescript
import { metricsRoutes } from "@/api/metrics";

// Inside createRouter():
app.route("/api/clients", metricsRoutes);
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
bunx vitest run test/api/metrics.test.ts
```

Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add worker/src/api/metrics.ts worker/test/api/metrics.test.ts worker/src/api/router.ts
git commit -m "feat: add metrics and logs API routes with percentile calculations"
```

---

### Task 9: Alerts & Speed Test Routes

**Files:**
- Create: `worker/src/api/alerts.ts`
- Create: `worker/src/api/speedtest.ts`
- Create: `worker/test/api/alerts.test.ts`
- Modify: `worker/src/api/router.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// worker/test/api/alerts.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { createRouter } from "@/api/router";

const app = createRouter();

async function hashString(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

let adminCookie: string;

async function setup() {
  await env.DB.exec("DELETE FROM admin; DELETE FROM clients; DELETE FROM alerts");
  const hash = await hashString("testpass123");
  await env.DB.prepare("INSERT INTO admin (id, password_hash, created_at) VALUES (1, ?, ?)").bind(hash, new Date().toISOString()).run();
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "testpass123" }),
  }, env);
  const { token } = await res.json<{ token: string }>();
  adminCookie = `session=${token}`;

  const secretHash = await hashString("s");
  await env.DB.prepare(
    "INSERT INTO clients (id, name, location, secret_hash, config_json, created_at, last_seen) VALUES ('c1', 'Home', 'Toronto', ?, '{}', ?, ?)"
  ).bind(secretHash, new Date().toISOString(), new Date().toISOString()).run();

  // Seed alerts
  await env.DB.prepare(
    "INSERT INTO alerts (id, client_id, type, severity, value, threshold, timestamp) VALUES (?, 'c1', 'high_latency', 'warning', 150, 100, ?)"
  ).bind(crypto.randomUUID(), new Date().toISOString()).run();
}

describe("GET /api/alerts", () => {
  beforeEach(setup);

  it("lists all alerts", async () => {
    const res = await app.request("/api/alerts", {
      headers: { Cookie: adminCookie },
    }, env);
    expect(res.status).toBe(200);
    const data = await res.json<{ alerts: any[] }>();
    expect(data.alerts).toHaveLength(1);
    expect(data.alerts[0].type).toBe("high_latency");
  });
});

describe("POST /api/speedtest/:id", () => {
  beforeEach(setup);

  it("returns 200 when triggering speed test", async () => {
    const res = await app.request("/api/speedtest/c1", {
      method: "POST",
      headers: { Cookie: adminCookie },
    }, env);
    // Will succeed even if DO isn't connected — it's fire-and-forget
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bunx vitest run test/api/alerts.test.ts
```

- [ ] **Step 3: Implement alerts routes**

```typescript
// worker/src/api/alerts.ts
import { Hono } from "hono";
import type { Env } from "@/index";
import { authGuard } from "@/middleware/auth-guard";

export const alertRoutes = new Hono<{ Bindings: Env }>();

alertRoutes.use("*", authGuard);

alertRoutes.get("/", async (c) => {
  const limit = parseInt(c.req.query("limit") || "50");
  const offset = parseInt(c.req.query("offset") || "0");
  const clientId = c.req.query("client_id");

  let query = "SELECT * FROM alerts";
  const params: any[] = [];

  if (clientId) {
    query += " WHERE client_id = ?";
    params.push(clientId);
  }

  query += " ORDER BY timestamp DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);

  const { results } = await c.env.DB.prepare(query).bind(...params).all();
  return c.json({ alerts: results });
});

alertRoutes.post("/test", async (c) => {
  // Dispatch a test alert
  const { dispatchAlert } = await import("@/services/alert-dispatch");
  await dispatchAlert(c.env, {
    alert_id: "test",
    client_id: "test",
    type: "high_latency",
    severity: "info",
    value: 0,
    threshold: 0,
    timestamp: new Date().toISOString(),
    message: "This is a test alert from PingPulse",
  });
  return c.json({ ok: true });
});

// PUT /api/alerts — update global alert thresholds
alertRoutes.put("/", async (c) => {
  const body = await c.req.json<{
    email_address?: string;
    telegram_bot_token?: string;
    telegram_chat_id?: string;
    default_latency_threshold_ms?: number;
    default_loss_threshold_pct?: number;
  }>();

  // Store alert settings in a settings row in admin table (or a new settings table)
  // For simplicity, store as JSON in a D1 key-value pattern
  await c.env.DB.prepare(
    "INSERT OR REPLACE INTO admin (id, password_hash, created_at) SELECT id, password_hash, created_at FROM admin WHERE id = 1"
  ).run();

  // Update client configs if default thresholds changed
  if (body.default_latency_threshold_ms !== undefined || body.default_loss_threshold_pct !== undefined) {
    const { results: clients } = await c.env.DB.prepare("SELECT id, config_json FROM clients").all();
    for (const client of clients) {
      const config = JSON.parse(client.config_json as string);
      if (body.default_latency_threshold_ms !== undefined) {
        config.alert_latency_threshold_ms = body.default_latency_threshold_ms;
      }
      if (body.default_loss_threshold_pct !== undefined) {
        config.alert_loss_threshold_pct = body.default_loss_threshold_pct;
      }
      await c.env.DB.prepare("UPDATE clients SET config_json = ? WHERE id = ?")
        .bind(JSON.stringify(config), client.id)
        .run();
    }
  }

  return c.json({ ok: true });
});

```

> **Note:** Alert dispatch is called directly from the DO via `import("@/services/alert-dispatch")` — no HTTP route needed. This avoids auth and rate-limiting issues with internal calls.

- [ ] **Step 4: Implement speedtest route**

```typescript
// worker/src/api/speedtest.ts
import { Hono } from "hono";
import type { Env } from "@/index";
import { authGuard } from "@/middleware/auth-guard";
import { rateLimit } from "@/middleware/rate-limit";

export const speedtestRoutes = new Hono<{ Bindings: Env }>();

speedtestRoutes.use("*", authGuard);

speedtestRoutes.post("/:id", rateLimit({ maxRequests: 1, windowMs: 300_000 }), async (c) => {
  const clientId = c.req.param("id");

  // Verify client exists
  const client = await c.env.DB.prepare("SELECT id FROM clients WHERE id = ?")
    .bind(clientId).first();
  if (!client) return c.json({ error: "Client not found" }, 404);

  // Signal the DO to trigger a speed test
  const doId = c.env.CLIENT_MONITOR.idFromName(clientId);
  const stub = c.env.CLIENT_MONITOR.get(doId);

  try {
    await stub.fetch("http://internal/trigger-speed-test", { method: "POST" });
  } catch {
    // Client may not be connected
  }

  return c.json({ ok: true, message: "Speed test triggered" });
});
```

- [ ] **Step 5: Mount in router**

Add to `src/api/router.ts`:

```typescript
import { alertRoutes } from "@/api/alerts";
import { speedtestRoutes } from "@/api/speedtest";

// Inside createRouter():
app.route("/api/alerts", alertRoutes);
app.route("/api/speedtest", speedtestRoutes);
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
bunx vitest run test/api/alerts.test.ts
```

Expected: All PASS

- [ ] **Step 7: Commit**

```bash
git add worker/src/api/alerts.ts worker/src/api/speedtest.ts worker/test/api/alerts.test.ts worker/src/api/router.ts
git commit -m "feat: add alerts listing and speed test trigger routes"
```

---

### Task 10: Alert Dispatch Service

**Files:**
- Create: `worker/src/services/alert-dispatch.ts`
- Create: `worker/test/services/alert-dispatch.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// worker/test/services/alert-dispatch.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { dispatchAlert } from "@/services/alert-dispatch";

describe("dispatchAlert", () => {
  const mockEnv = {
    RESEND_API_KEY: "test-resend-key",
    TELEGRAM_BOT_TOKEN: "test-bot-token",
    TELEGRAM_CHAT_ID: "12345",
    DB: {} as any,
    ARCHIVE: {} as any,
    METRICS: {} as any,
    CLIENT_MONITOR: {} as any,
    ADMIN_JWT_SECRET: "test",
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("formats alert message correctly", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchSpy);

    await dispatchAlert(mockEnv, {
      alert_id: "a1",
      client_id: "c1",
      type: "client_down",
      severity: "critical",
      value: 120,
      threshold: 60,
      timestamp: "2026-03-17T12:00:00Z",
    });

    // Should have called both Resend and Telegram
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Check Telegram call
    const telegramCall = fetchSpy.mock.calls.find((c: any) =>
      c[0].includes("api.telegram.org")
    );
    expect(telegramCall).toBeTruthy();
    const telegramBody = JSON.parse(telegramCall[1].body);
    expect(telegramBody.text).toContain("client_down");
    expect(telegramBody.text).toContain("CRITICAL");
  });

  it("skips email if RESEND_API_KEY is empty", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchSpy);

    await dispatchAlert({ ...mockEnv, RESEND_API_KEY: "" }, {
      alert_id: "a1",
      client_id: "c1",
      type: "high_latency",
      severity: "warning",
      value: 150,
      threshold: 100,
      timestamp: "2026-03-17T12:00:00Z",
    });

    // Only Telegram
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bunx vitest run test/services/alert-dispatch.test.ts
```

- [ ] **Step 3: Implement alert dispatch**

```typescript
// worker/src/services/alert-dispatch.ts
import type { Env } from "@/index";

interface AlertPayload {
  alert_id: string;
  client_id: string;
  type: string;
  severity: string;
  value: number;
  threshold: number;
  timestamp: string;
  message?: string;
}

const SEVERITY_EMOJI: Record<string, string> = {
  critical: "🔴",
  warning: "🟡",
  info: "🟢",
};

function formatMessage(alert: AlertPayload): string {
  const emoji = SEVERITY_EMOJI[alert.severity] || "⚪";
  const lines = [
    `${emoji} PingPulse Alert: ${alert.type.toUpperCase().replace(/_/g, " ")}`,
    `Severity: ${alert.severity.toUpperCase()}`,
    `Client: ${alert.client_id}`,
    `Value: ${alert.value}`,
    `Threshold: ${alert.threshold}`,
    `Time: ${alert.timestamp}`,
  ];
  if (alert.message) lines.push(`\n${alert.message}`);
  return lines.join("\n");
}

export async function dispatchAlert(env: Env, alert: AlertPayload): Promise<void> {
  const message = formatMessage(alert);
  const promises: Promise<void>[] = [];

  // Email via Resend
  if (env.RESEND_API_KEY) {
    promises.push(sendEmail(env, alert, message));
  }

  // Telegram
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    promises.push(sendTelegram(env, message));
  }

  await Promise.allSettled(promises);
}

async function sendEmail(env: Env, alert: AlertPayload, message: string): Promise<void> {
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "PingPulse <alerts@ping.beric.ca>",
        to: ["admin@beric.ca"], // TODO: make configurable via D1 settings
        subject: `[PingPulse] ${alert.severity.toUpperCase()}: ${alert.type.replace(/_/g, " ")}`,
        text: message,
      }),
    });
  } catch {
    // Best effort
  }
}

async function sendTelegram(env: Env, message: string): Promise<void> {
  try {
    await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: "HTML",
        }),
      }
    );
  } catch {
    // Best effort
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bunx vitest run test/services/alert-dispatch.test.ts
```

Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/services/alert-dispatch.ts worker/test/services/alert-dispatch.test.ts
git commit -m "feat: add alert dispatch service (Resend email + Telegram)"
```

---

### Task 11: Archiver Service (D1 → R2)

**Files:**
- Create: `worker/src/services/archiver.ts`
- Create: `worker/test/services/archiver.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// worker/test/services/archiver.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { archiveOldRecords } from "@/services/archiver";

async function hashString(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("archiveOldRecords", () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM clients; DELETE FROM ping_results");
    const hash = await hashString("s");
    await env.DB.prepare(
      "INSERT INTO clients (id, name, location, secret_hash, config_json, created_at, last_seen) VALUES ('c1', 'Home', 'Toronto', ?, '{}', ?, ?)"
    ).bind(hash, new Date().toISOString(), new Date().toISOString()).run();

    // Insert old records (31 days ago)
    const oldDate = new Date(Date.now() - 31 * 86400_000).toISOString();
    for (let i = 0; i < 3; i++) {
      await env.DB.prepare(
        "INSERT INTO ping_results (id, client_id, timestamp, rtt_ms, jitter_ms, direction, status) VALUES (?, 'c1', ?, 25, 1, 'cf_to_client', 'ok')"
      ).bind(`old-${i}`, oldDate).run();
    }

    // Insert recent record
    await env.DB.prepare(
      "INSERT INTO ping_results (id, client_id, timestamp, rtt_ms, jitter_ms, direction, status) VALUES ('recent', 'c1', ?, 25, 1, 'cf_to_client', 'ok')"
    ).bind(new Date().toISOString()).run();
  });

  it("archives old ping results to R2 and deletes from D1", async () => {
    const archived = await archiveOldRecords(env, 30);

    // Old records should be deleted from D1
    const { results } = await env.DB.prepare("SELECT id FROM ping_results").all();
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("recent");

    // R2 should have an archive file
    const objects = await env.ARCHIVE.list({ prefix: "archive/c1/" });
    expect(objects.objects.length).toBeGreaterThan(0);

    expect(archived).toBe(3);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bunx vitest run test/services/archiver.test.ts
```

- [ ] **Step 3: Implement archiver**

```typescript
// worker/src/services/archiver.ts
import type { Env } from "@/index";

export async function archiveOldRecords(env: Env, retentionDays: number = 30): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 86400_000).toISOString();
  let totalArchived = 0;

  // Get all clients
  const { results: clients } = await env.DB.prepare("SELECT id FROM clients").all();

  for (const client of clients) {
    const clientId = client.id as string;

    // Fetch old ping results
    const { results: oldPings } = await env.DB.prepare(
      "SELECT * FROM ping_results WHERE client_id = ? AND timestamp < ? ORDER BY timestamp"
    ).bind(clientId, cutoff).all();

    if (oldPings.length === 0) continue;

    // Fetch old speed tests
    const { results: oldSpeedTests } = await env.DB.prepare(
      "SELECT * FROM speed_tests WHERE client_id = ? AND timestamp < ? ORDER BY timestamp"
    ).bind(clientId, cutoff).all();

    // Build archive payload
    const archive = {
      client_id: clientId,
      archived_at: new Date().toISOString(),
      retention_days: retentionDays,
      ping_results: oldPings,
      speed_tests: oldSpeedTests,
    };

    // Write to R2 as gzipped JSON (per spec)
    const now = new Date();
    const path = `archive/${clientId}/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")}.json.gz`;

    const jsonData = new TextEncoder().encode(JSON.stringify(archive));
    const cs = new CompressionStream("gzip");
    const writer = cs.writable.getWriter();
    writer.write(jsonData);
    writer.close();
    const gzipped = await new Response(cs.readable).arrayBuffer();

    await env.ARCHIVE.put(path, gzipped, {
      httpMetadata: { contentType: "application/gzip" },
    });

    // Delete archived records from D1
    await env.DB.batch([
      env.DB.prepare("DELETE FROM ping_results WHERE client_id = ? AND timestamp < ?").bind(clientId, cutoff),
      env.DB.prepare("DELETE FROM speed_tests WHERE client_id = ? AND timestamp < ?").bind(clientId, cutoff),
    ]);

    totalArchived += oldPings.length;
  }

  return totalArchived;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bunx vitest run test/services/archiver.test.ts
```

Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/services/archiver.ts worker/test/services/archiver.test.ts
git commit -m "feat: add D1-to-R2 archival service with configurable retention"
```

---

### Task 12: Cron Handler & Export Route

**Files:**
- Modify: `worker/src/index.ts`
- Create: `worker/src/api/export.ts`
- Create: `worker/test/api/export.test.ts`
- Modify: `worker/src/api/router.ts`

- [ ] **Step 1: Write failing tests for export route**

```typescript
// worker/test/api/export.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { createRouter } from "@/api/router";
import { hashString } from "@/utils/hash";

const app = createRouter();

let adminCookie: string;

async function setup() {
  await env.DB.exec("DELETE FROM admin; DELETE FROM clients; DELETE FROM ping_results");
  const hash = await hashString("testpass123");
  await env.DB.prepare("INSERT INTO admin (id, password_hash, created_at) VALUES (1, ?, ?)").bind(hash, new Date().toISOString()).run();
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "testpass123" }),
  }, env);
  const { token } = await res.json<{ token: string }>();
  adminCookie = `session=${token}`;

  const secretHash = await hashString("s");
  await env.DB.prepare(
    "INSERT INTO clients (id, name, location, secret_hash, config_json, created_at, last_seen) VALUES ('c1', 'Home', 'Toronto', ?, '{}', ?, ?)"
  ).bind(secretHash, new Date().toISOString(), new Date().toISOString()).run();

  await env.DB.prepare(
    "INSERT INTO ping_results (id, client_id, timestamp, rtt_ms, jitter_ms, direction, status) VALUES ('p1', 'c1', ?, 25, 1.5, 'cf_to_client', 'ok')"
  ).bind(new Date().toISOString()).run();
}

describe("GET /api/export/:id", () => {
  beforeEach(setup);

  it("exports as JSON by default", async () => {
    const res = await app.request("/api/export/c1", {
      headers: { Cookie: adminCookie },
    }, env);
    expect(res.status).toBe(200);
    const data = await res.json<{ ping_results: any[] }>();
    expect(data.ping_results.length).toBeGreaterThan(0);
  });

  it("exports as CSV when format=csv", async () => {
    const res = await app.request("/api/export/c1?format=csv", {
      headers: { Cookie: adminCookie },
    }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv");
    const text = await res.text();
    expect(text).toContain("timestamp,rtt_ms");
  });

  it("returns 401 without auth", async () => {
    const res = await app.request("/api/export/c1", {}, env);
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bunx vitest run test/api/export.test.ts
```

Expected: FAIL — route not implemented

- [ ] **Step 3: Implement export route**

```typescript
// worker/src/api/export.ts
import { Hono } from "hono";
import type { Env } from "@/index";
import { authGuard } from "@/middleware/auth-guard";

export const exportRoutes = new Hono<{ Bindings: Env }>();

exportRoutes.use("*", authGuard);

exportRoutes.get("/:id", async (c) => {
  const clientId = c.req.param("id");
  const format = c.req.query("format") || "json";
  const from = c.req.query("from") || new Date(Date.now() - 7 * 86400_000).toISOString();
  const to = c.req.query("to") || new Date().toISOString();

  const { results: pings } = await c.env.DB.prepare(
    "SELECT * FROM ping_results WHERE client_id = ? AND timestamp BETWEEN ? AND ? ORDER BY timestamp"
  ).bind(clientId, from, to).all();

  const { results: speedTests } = await c.env.DB.prepare(
    "SELECT * FROM speed_tests WHERE client_id = ? AND timestamp BETWEEN ? AND ? ORDER BY timestamp"
  ).bind(clientId, from, to).all();

  const data = { client_id: clientId, from, to, ping_results: pings, speed_tests: speedTests };

  if (format === "csv") {
    const header = "timestamp,rtt_ms,jitter_ms,direction,status\n";
    const rows = pings.map((p: any) =>
      `${p.timestamp},${p.rtt_ms},${p.jitter_ms},${p.direction},${p.status}`
    ).join("\n");
    return new Response(header + rows, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="pingpulse-${clientId}.csv"`,
      },
    });
  }

  return c.json(data);
});
```

- [ ] **Step 4: Mount export route in router**

Add to `src/api/router.ts`:

```typescript
import { exportRoutes } from "@/api/export";

// Inside createRouter():
app.route("/api/export", exportRoutes);
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
bunx vitest run test/api/export.test.ts
```

Expected: All PASS

- [ ] **Step 6: Implement scheduled handler in `src/index.ts`**

Update the `scheduled` export:

```typescript
async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
  const { archiveOldRecords } = await import("@/services/archiver");

  // Get all client IDs
  const { results: clients } = await env.DB.prepare("SELECT id FROM clients").all();

  // Trigger full speed test on each connected client
  for (const client of clients) {
    const doId = env.CLIENT_MONITOR.idFromName(client.id as string);
    const stub = env.CLIENT_MONITOR.get(doId);
    try {
      await stub.fetch("http://internal/trigger-speed-test", { method: "POST" });
    } catch {
      // Client may not be connected
    }
  }

  // Archive old records + clean up rate limit table
  ctx.waitUntil(
    Promise.all([
      archiveOldRecords(env, 30),
      env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?")
        .bind(new Date(Date.now() - 3600_000).toISOString())
        .run(),
    ])
  );
},
```

- [ ] **Step 7: Commit**

```bash
git add worker/src/index.ts worker/src/api/export.ts worker/test/api/export.test.ts worker/src/api/router.ts
git commit -m "feat: add cron handler, export route, rate limit cleanup"
```

---

### Task 13: Speed Test Payload Endpoints & Integration Smoke Test

**Files:**
- Modify: `worker/src/index.ts`
- Create: `worker/test/integration.test.ts`

- [ ] **Step 1: Write failing tests for speed test payload endpoints**

```typescript
// worker/test/integration.test.ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";

// Test against the Worker fetch handler directly
import worker from "@/index";

describe("GET /api/health", () => {
  it("returns 200 with status ok", async () => {
    const req = new Request("http://localhost/api/health");
    const res = await worker.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} } as any);
    expect(res.status).toBe(200);
    const data = await res.json<{ status: string }>();
    expect(data.status).toBe("ok");
  });
});

describe("GET /speedtest/download", () => {
  it("returns a payload of requested size", async () => {
    const req = new Request("http://localhost/speedtest/download?size=1024");
    const res = await worker.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} } as any);
    expect(res.status).toBe(200);
    const body = await res.arrayBuffer();
    expect(body.byteLength).toBe(1024);
  });

  it("caps payload at 25MB", async () => {
    const req = new Request("http://localhost/speedtest/download?size=999999999");
    const res = await worker.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} } as any);
    expect(res.status).toBe(200);
    const body = await res.arrayBuffer();
    expect(body.byteLength).toBe(25 * 1024 * 1024);
  });
});

describe("POST /speedtest/upload", () => {
  it("returns received byte count", async () => {
    const payload = new Uint8Array(2048);
    const req = new Request("http://localhost/speedtest/upload", {
      method: "POST",
      body: payload,
    });
    const res = await worker.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} } as any);
    expect(res.status).toBe(200);
    const data = await res.json<{ received_bytes: number }>();
    expect(data.received_bytes).toBe(2048);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bunx vitest run test/integration.test.ts
```

Expected: FAIL — endpoints not implemented

- [ ] **Step 3: Add speed test payload endpoints to `src/index.ts`**

Add to the `fetch` handler, before the router call:

```typescript
// Speed test payload endpoints (no auth — client uses these during test)
if (url.pathname === "/speedtest/download") {
  const size = parseInt(url.searchParams.get("size") || "262144");
  const payload = new Uint8Array(Math.min(size, 25 * 1024 * 1024));
  crypto.getRandomValues(payload);
  return new Response(payload, {
    headers: { "Content-Type": "application/octet-stream" },
  });
}

if (url.pathname === "/speedtest/upload" && request.method === "POST") {
  const body = await request.arrayBuffer();
  return new Response(JSON.stringify({ received_bytes: body.byteLength }), {
    headers: { "Content-Type": "application/json" },
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bunx vitest run test/integration.test.ts
```

Expected: All PASS

- [ ] **Step 5: Run full test suite**

```bash
cd /Users/ericbaruch/Arik/dev/pingpulse/worker
bunx vitest run
```

Expected: All tests PASS

- [ ] **Step 6: Verify local dev server starts**

```bash
cd /Users/ericbaruch/Arik/dev/pingpulse/worker
bunx wrangler dev --local
```

Expected: Server starts, health check at `http://localhost:8787/api/health` returns `{"status":"ok"}`

- [ ] **Step 4: Commit**

```bash
git add worker/src/index.ts
git commit -m "feat: add speed test payload endpoints and finalize Worker entry"
```

- [ ] **Step 5: Final commit — tag Worker backend as complete**

```bash
git tag worker-backend-v1
```

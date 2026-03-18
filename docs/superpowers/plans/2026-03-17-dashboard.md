# PingPulse Dashboard — Implementation Plan (Plan 2 of 3)

> **For agentic workers:** REQUIRED: Use superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the React SPA dashboard at ping.beric.ca for real-time and historical network monitoring, client management, and alert configuration.

**Architecture:** React SPA built with Vite, served as Cloudflare Workers Static Assets. Communicates with the Worker API (Plan 1) via fetch. JWT auth via httpOnly cookie. Dark mode only. All routing is client-side via React Router.

**Tech Stack:** React 19, Vite, React Router, Tailwind CSS v4, uPlot (time-series charts), TypeScript, bun

**Spec:** `docs/superpowers/specs/2026-03-17-pingpulse-design.md`

**API Routes (from Worker backend):**
- `GET /api/health` — health check
- `POST /api/auth/login` — admin login, returns JWT in cookie
- `POST /api/auth/logout` — clears session
- `GET /api/auth/me` — current session info
- `POST /api/auth/register/token` — generate client registration token
- `POST /api/auth/register` — exchange token for client credentials
- `GET /api/clients` — list all clients
- `GET /api/clients/:id` — client detail
- `PUT /api/clients/:id` — update client config
- `DELETE /api/clients/:id` — delete client
- `GET /api/metrics/:id?from=&to=` — metrics with percentiles
- `GET /api/metrics/:id/logs?limit=&offset=` — paginated logs
- `GET /api/alerts?client_id=&limit=&offset=` — list alerts
- `PUT /api/alerts` — update default thresholds
- `POST /api/alerts/test` — send test alert
- `POST /api/speedtest/:id` — trigger speed test
- `GET /api/export/:id?format=json|csv&from=&to=` — export data

---

## File Structure

```
worker/dashboard/
├── index.html
├── package.json
├── vite.config.ts
├── tsconfig.json
├── src/
│   ├── main.tsx                    # React entry, mount App
│   ├── App.tsx                     # Router setup, auth context
│   ├── globals.css                 # Tailwind imports, dark theme vars
│   ├── lib/
│   │   ├── api.ts                  # Typed fetch wrapper for all API routes
│   │   ├── hooks.ts                # useSWR-like polling hooks (useClients, useMetrics, etc.)
│   │   └── types.ts                # Shared frontend types (mirrors backend)
│   ├── components/
│   │   ├── Layout.tsx              # App shell: sidebar nav, header, main area
│   │   ├── ProtectedRoute.tsx      # Redirects to /login if not authed
│   │   ├── ClientCard.tsx          # Client status card for overview grid
│   │   ├── StatusBadge.tsx         # Green/yellow/red status indicator
│   │   ├── StatsBar.tsx            # Global stats: total clients, up/down, avg latency
│   │   ├── Sparkline.tsx           # Tiny inline latency chart (canvas-based)
│   │   ├── LatencyChart.tsx        # uPlot time-series chart for latency
│   │   ├── ThroughputChart.tsx     # uPlot chart for speed test results
│   │   ├── OutageTimeline.tsx      # Horizontal bar showing up/down periods
│   │   ├── TimeRangeSelector.tsx   # 1h/6h/24h/7d/30d selector
│   │   ├── AlertRow.tsx            # Single alert in the alert list
│   │   ├── RegisterDialog.tsx      # Modal for generating registration token
│   │   └── EditClientDialog.tsx   # Modal for editing client name, location, config
│   └── pages/
│       ├── Login.tsx               # Password login form
│       ├── Overview.tsx            # Client grid + stats bar (home page)
│       ├── ClientDetail.tsx        # Charts, outage timeline, speed test history
│       ├── Clients.tsx             # Client management: list, register, edit, delete
│       ├── Alerts.tsx              # Alert history + threshold config
│       └── Settings.tsx            # Admin password, data retention, export
└── public/
    └── favicon.svg
```

---

### Task 1: Dashboard Scaffolding

**Files:**
- Create: `worker/dashboard/package.json`
- Create: `worker/dashboard/index.html`
- Create: `worker/dashboard/vite.config.ts`
- Create: `worker/dashboard/tsconfig.json`
- Create: `worker/dashboard/src/main.tsx`
- Create: `worker/dashboard/src/App.tsx`
- Create: `worker/dashboard/src/globals.css`
- Modify: `worker/wrangler.toml` — add `[assets]` section

- [ ] **Step 1: Initialize the dashboard project**

```bash
cd /Users/ericbaruch/Arik/dev/pingpulse/worker
mkdir -p dashboard/src/{lib,components,pages} dashboard/public
cd dashboard
bun init -y
bun add react react-dom react-router
bun add -d @types/react @types/react-dom @vitejs/plugin-react vite typescript tailwindcss @tailwindcss/vite
```

- [ ] **Step 2: Write `package.json` scripts**

Add to `worker/dashboard/package.json`:
```json
{
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  }
}
```

- [ ] **Step 3: Write `vite.config.ts`**

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": "/src",
    },
  },
  server: {
    proxy: {
      "/api": "http://localhost:8787",
      "/ws": { target: "ws://localhost:8787", ws: true },
    },
  },
  build: {
    outDir: "dist",
  },
});
```

- [ ] **Step 4: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src"]
}
```

- [ ] **Step 5: Write `index.html`**

```html
<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>PingPulse</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
</head>
<body class="bg-zinc-950 text-zinc-100 antialiased">
  <div id="root"></div>
  <script type="module" src="/src/main.tsx"></script>
</body>
</html>
```

- [ ] **Step 6: Write `src/globals.css`**

```css
@import "tailwindcss";

@theme {
  --color-accent: oklch(0.7 0.15 250);
  --color-accent-hover: oklch(0.75 0.15 250);
  --font-sans: "Geist Sans", system-ui, sans-serif;
  --font-mono: "Geist Mono", ui-monospace, monospace;
}

body {
  font-family: var(--font-sans);
}
```

- [ ] **Step 7: Write `src/main.tsx`**

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/App";
import "@/globals.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

- [ ] **Step 8: Write minimal `src/App.tsx`**

```tsx
import { BrowserRouter, Routes, Route } from "react-router";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<div>PingPulse Dashboard</div>} />
      </Routes>
    </BrowserRouter>
  );
}
```

- [ ] **Step 9: Write `public/favicon.svg`**

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <circle cx="16" cy="16" r="14" fill="#3b82f6" />
  <path d="M8 16h4l3-8 4 16 3-8h4" stroke="white" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
```

- [ ] **Step 10: Add `[assets]` to `wrangler.toml`**

Add to `worker/wrangler.toml`:
```toml
[assets]
directory = "./dashboard/dist"
```

- [ ] **Step 11: Verify dev server starts**

```bash
cd /Users/ericbaruch/Arik/dev/pingpulse/worker/dashboard
bun run dev
```

Expected: Vite dev server at http://localhost:5173 showing "PingPulse Dashboard"

- [ ] **Step 12: Commit**

```bash
git add worker/dashboard/ worker/wrangler.toml
git commit -m "feat: scaffold dashboard with Vite, React, Tailwind, React Router"
```

---

### Task 2: Types + API Client + Data Hooks

**Files:**
- Create: `worker/dashboard/src/lib/types.ts`
- Create: `worker/dashboard/src/lib/api.ts`
- Create: `worker/dashboard/src/lib/hooks.ts`

- [ ] **Step 1: Write shared frontend types**

```typescript
// worker/dashboard/src/lib/types.ts

export interface ClientConfig {
  ping_interval_s: number;
  probe_size_bytes: number;
  full_test_schedule: string;
  full_test_payload_bytes: number;
  alert_latency_threshold_ms: number;
  alert_loss_threshold_pct: number;
  grace_period_s: number;
}

export interface Client {
  id: string;
  name: string;
  location: string;
  config: ClientConfig;
  created_at: string;
  last_seen: string;
}

export interface PingResult {
  timestamp: string;
  rtt_ms: number;
  jitter_ms: number;
  direction: string;
  status: "ok" | "timeout" | "error";
}

export interface SpeedTest {
  timestamp: string;
  type: "probe" | "full";
  download_mbps: number;
  upload_mbps: number;
  payload_bytes: number;
  duration_ms: number;
}

export interface Outage {
  start_ts: string;
  end_ts: string | null;
  duration_s: number | null;
}

export interface MetricsSummary {
  total_pings: number;
  ok_pings: number;
  timeout_pings: number;
  loss_pct: number;
  avg_rtt_ms: number;
  min_rtt_ms: number;
  max_rtt_ms: number;
  p50_rtt_ms: number;
  p95_rtt_ms: number;
  p99_rtt_ms: number;
}

export interface MetricsResponse {
  pings: PingResult[];
  speed_tests: SpeedTest[];
  outages: Outage[];
  summary: MetricsSummary;
}

export interface Alert {
  id: string;
  client_id: string;
  type: string;
  severity: "critical" | "warning" | "info";
  value: number;
  threshold: number;
  timestamp: string;
}
```

- [ ] **Step 2: Write API client**

```typescript
// worker/dashboard/src/lib/api.ts

import type { Client, MetricsResponse, Alert } from "@/lib/types";

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  if (res.status === 401) {
    // Redirect to login if unauthorized
    if (window.location.pathname !== "/login") {
      window.location.href = "/login";
    }
    throw new ApiError(401, "Unauthorized");
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, body.error || res.statusText);
  }

  return res.json();
}

export const api = {
  // Auth
  login: (password: string) =>
    request<{ token: string }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),
  logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  me: () => request<{ sub: string; exp: number }>("/api/auth/me"),

  // Clients
  listClients: () => request<{ clients: Client[] }>("/api/clients"),
  getClient: (id: string) => request<Client>(`/api/clients/${id}`),
  updateClient: (id: string, data: { name?: string; location?: string; config?: Partial<Client["config"]> }) =>
    request<{ ok: boolean }>(`/api/clients/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  deleteClient: (id: string) =>
    request<{ ok: boolean }>(`/api/clients/${id}`, { method: "DELETE" }),

  // Registration
  generateToken: () =>
    request<{ token: string; expires_at: string }>("/api/auth/register/token", { method: "POST" }),

  // Metrics
  getMetrics: (id: string, from: string, to: string) =>
    request<MetricsResponse>(`/api/metrics/${id}?from=${from}&to=${to}`),
  getLogs: (id: string, limit: number, offset: number) =>
    request<{ logs: PingResult[]; total: number; limit: number; offset: number }>(
      `/api/metrics/${id}/logs?limit=${limit}&offset=${offset}`
    ),

  // Alerts
  listAlerts: (clientId?: string, limit = 50) =>
    request<{ alerts: Alert[] }>(
      `/api/alerts?limit=${limit}${clientId ? `&client_id=${clientId}` : ""}`
    ),
  updateThresholds: (data: { default_latency_threshold_ms?: number; default_loss_threshold_pct?: number }) =>
    request<{ ok: boolean }>("/api/alerts", {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  testAlert: () => request<{ ok: boolean }>("/api/alerts/test", { method: "POST" }),

  // Speed test
  triggerSpeedTest: (id: string) =>
    request<{ ok: boolean }>(`/api/speedtest/${id}`, { method: "POST" }),

  // Export
  exportData: (id: string, format: "json" | "csv", from?: string, to?: string) => {
    const params = new URLSearchParams({ format });
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    return `/api/export/${id}?${params}`;
  },
};
```

- [ ] **Step 3: Write data hooks**

```typescript
// worker/dashboard/src/lib/hooks.ts

import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "@/lib/api";
import type { Client, MetricsResponse, Alert } from "@/lib/types";

interface UsePollingResult<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  refresh: () => void;
}

function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs: number = 10_000,
  deps: unknown[] = []
): UsePollingResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const refresh = useCallback(() => {
    fetcherRef.current()
      .then((d) => { setData(d); setError(null); })
      .catch(setError)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, intervalMs);
    return () => clearInterval(id);
  }, [refresh, intervalMs, ...deps]);

  return { data, error, loading, refresh };
}

export function useClients(intervalMs = 10_000) {
  return usePolling(
    () => api.listClients().then((r) => r.clients),
    intervalMs
  );
}

export function useClient(id: string) {
  return usePolling(() => api.getClient(id), 10_000, [id]);
}

export function useMetrics(id: string, from: string, to: string) {
  return usePolling(() => api.getMetrics(id, from, to), 30_000, [id, from, to]);
}

export function useAlerts(clientId?: string, limit = 50) {
  return usePolling(
    () => api.listAlerts(clientId, limit).then((r) => r.alerts),
    30_000,
    [clientId, limit]
  );
}

export function useAuth() {
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    api.me()
      .then(() => setAuthed(true))
      .catch(() => setAuthed(false));
  }, []);

  const login = async (password: string) => {
    await api.login(password);
    setAuthed(true);
  };

  const logout = async () => {
    await api.logout();
    setAuthed(false);
    window.location.href = "/login";
  };

  return { authed, login, logout };
}

// Time range helpers
export type TimeRange = "1h" | "6h" | "24h" | "7d" | "30d";

const RANGE_MS: Record<TimeRange, number> = {
  "1h": 3600_000,
  "6h": 6 * 3600_000,
  "24h": 86400_000,
  "7d": 7 * 86400_000,
  "30d": 30 * 86400_000,
};

export function getTimeRange(range: TimeRange): { from: string; to: string } {
  const to = new Date().toISOString();
  const from = new Date(Date.now() - RANGE_MS[range]).toISOString();
  return { from, to };
}
```

- [ ] **Step 4: Commit**

```bash
git add worker/dashboard/src/lib/
git commit -m "feat: add API client, data hooks, and shared types"
```

---

### Task 3: Auth + Layout + Protected Routes

**Files:**
- Create: `worker/dashboard/src/pages/Login.tsx`
- Create: `worker/dashboard/src/components/Layout.tsx`
- Create: `worker/dashboard/src/components/ProtectedRoute.tsx`
- Modify: `worker/dashboard/src/App.tsx`

- [ ] **Step 1: Write Login page**

```tsx
// worker/dashboard/src/pages/Login.tsx

import { useState, type FormEvent } from "react";

export function Login({ onLogin }: { onLogin: (password: string) => Promise<void> }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      await onLogin(password);
    } catch {
      setError("Invalid password");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold tracking-tight">PingPulse</h1>
          <p className="mt-1 text-sm text-zinc-400">Network monitoring dashboard</p>
        </div>

        {error && (
          <div className="rounded-md bg-red-950/50 border border-red-900 px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        )}

        <div>
          <label htmlFor="password" className="block text-sm font-medium text-zinc-300">
            Admin Password
          </label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-[var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
            placeholder="Enter password"
            autoFocus
          />
        </div>

        <button
          type="submit"
          disabled={loading || !password}
          className="w-full rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? "Signing in..." : "Sign in"}
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Write Layout component**

```tsx
// worker/dashboard/src/components/Layout.tsx

import { NavLink, Outlet } from "react-router";

const NAV_ITEMS = [
  { to: "/", label: "Overview", icon: "◉" },
  { to: "/clients", label: "Clients", icon: "⊞" },
  { to: "/alerts", label: "Alerts", icon: "⚠" },
  { to: "/settings", label: "Settings", icon: "⚙" },
];

export function Layout({ onLogout }: { onLogout: () => void }) {
  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <nav className="flex w-56 flex-col border-r border-zinc-800 bg-zinc-950">
        <div className="flex h-14 items-center gap-2 border-b border-zinc-800 px-4">
          <span className="text-lg font-bold tracking-tight text-[var(--color-accent)]">PingPulse</span>
        </div>

        <div className="flex flex-1 flex-col gap-1 p-3">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-zinc-800 text-zinc-100"
                    : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
                }`
              }
            >
              <span className="text-base">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </div>

        <div className="border-t border-zinc-800 p-3">
          <button
            onClick={onLogout}
            className="w-full rounded-md px-3 py-2 text-left text-sm text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
          >
            Sign out
          </button>
        </div>
      </nav>

      {/* Main content */}
      <main className="flex-1 overflow-auto bg-zinc-950 p-6">
        <Outlet />
      </main>
    </div>
  );
}
```

- [ ] **Step 3: Write ProtectedRoute**

```tsx
// worker/dashboard/src/components/ProtectedRoute.tsx

import { Navigate } from "react-router";

export function ProtectedRoute({
  authed,
  children,
}: {
  authed: boolean | null;
  children: React.ReactNode;
}) {
  if (authed === null) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-sm text-zinc-400">Loading...</div>
      </div>
    );
  }

  if (!authed) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}
```

- [ ] **Step 4: Update App.tsx with auth + routing**

```tsx
// worker/dashboard/src/App.tsx

import { BrowserRouter, Routes, Route, Navigate } from "react-router";
import { useAuth } from "@/lib/hooks";
import { Layout } from "@/components/Layout";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { Login } from "@/pages/Login";
import { Overview } from "@/pages/Overview";
import { Clients } from "@/pages/Clients";
import { ClientDetail } from "@/pages/ClientDetail";
import { Alerts } from "@/pages/Alerts";
import { Settings } from "@/pages/Settings";

export function App() {
  const { authed, login, logout } = useAuth();

  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/login"
          element={
            authed ? <Navigate to="/" replace /> : <Login onLogin={login} />
          }
        />
        <Route
          element={
            <ProtectedRoute authed={authed}>
              <Layout onLogout={logout} />
            </ProtectedRoute>
          }
        >
          <Route index element={<Overview />} />
          <Route path="clients" element={<Clients />} />
          <Route path="client/:id" element={<ClientDetail />} />
          <Route path="alerts" element={<Alerts />} />
          <Route path="settings" element={<Settings />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
```

- [ ] **Step 5: Create placeholder pages**

Create each of these with a simple heading placeholder:

```tsx
// worker/dashboard/src/pages/Overview.tsx
export function Overview() {
  return <h1 className="text-xl font-semibold">Overview</h1>;
}
```

```tsx
// worker/dashboard/src/pages/Clients.tsx
export function Clients() {
  return <h1 className="text-xl font-semibold">Client Management</h1>;
}
```

```tsx
// worker/dashboard/src/pages/ClientDetail.tsx
export function ClientDetail() {
  return <h1 className="text-xl font-semibold">Client Detail</h1>;
}
```

```tsx
// worker/dashboard/src/pages/Alerts.tsx
export function Alerts() {
  return <h1 className="text-xl font-semibold">Alerts</h1>;
}
```

```tsx
// worker/dashboard/src/pages/Settings.tsx
export function Settings() {
  return <h1 className="text-xl font-semibold">Settings</h1>;
}
```

- [ ] **Step 6: Verify dev server shows login → dashboard flow**

```bash
cd /Users/ericbaruch/Arik/dev/pingpulse/worker/dashboard
bun run dev
```

Expected: Login page at /, sidebar navigation after login

- [ ] **Step 7: Commit**

```bash
git add worker/dashboard/
git commit -m "feat: add login page, layout with sidebar nav, protected routes"
```

---

### Task 4: Shared UI Components

**Files:**
- Create: `worker/dashboard/src/components/StatusBadge.tsx`
- Create: `worker/dashboard/src/components/StatsBar.tsx`
- Create: `worker/dashboard/src/components/Sparkline.tsx`
- Create: `worker/dashboard/src/components/TimeRangeSelector.tsx`
- Create: `worker/dashboard/src/components/AlertRow.tsx`

- [ ] **Step 1: Write StatusBadge**

```tsx
// worker/dashboard/src/components/StatusBadge.tsx

const THRESHOLD_STALE_MS = 120_000; // 2 minutes

type Status = "up" | "degraded" | "down";

function getStatus(lastSeen: string, latencyMs?: number, thresholdMs?: number): Status {
  const elapsed = Date.now() - new Date(lastSeen).getTime();
  if (elapsed > THRESHOLD_STALE_MS) return "down";
  if (latencyMs && thresholdMs && latencyMs > thresholdMs) return "degraded";
  return "up";
}

const STATUS_STYLES: Record<Status, { dot: string; label: string; text: string }> = {
  up: { dot: "bg-emerald-500", label: "Up", text: "text-emerald-400" },
  degraded: { dot: "bg-amber-500", label: "Degraded", text: "text-amber-400" },
  down: { dot: "bg-red-500", label: "Down", text: "text-red-400" },
};

export function StatusBadge({
  lastSeen,
  latencyMs,
  thresholdMs,
}: {
  lastSeen: string;
  latencyMs?: number;
  thresholdMs?: number;
}) {
  const status = getStatus(lastSeen, latencyMs, thresholdMs);
  const { dot, label, text } = STATUS_STYLES[status];

  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${text}`}>
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      {label}
    </span>
  );
}
```

- [ ] **Step 2: Write StatsBar**

```tsx
// worker/dashboard/src/components/StatsBar.tsx

import type { Client } from "@/lib/types";

export function StatsBar({ clients }: { clients: Client[] }) {
  const total = clients.length;
  const now = Date.now();
  const up = clients.filter((c) => now - new Date(c.last_seen).getTime() < 120_000).length;
  const down = total - up;

  return (
    <div className="flex gap-6 rounded-lg border border-zinc-800 bg-zinc-900/50 px-6 py-3">
      <Stat label="Total Clients" value={total} />
      <Stat label="Up" value={up} className="text-emerald-400" />
      <Stat label="Down" value={down} className={down > 0 ? "text-red-400" : "text-zinc-400"} />
    </div>
  );
}

function Stat({ label, value, className = "" }: { label: string; value: number; className?: string }) {
  return (
    <div className="text-center">
      <div className={`text-2xl font-bold font-mono ${className}`}>{value}</div>
      <div className="text-xs text-zinc-500">{label}</div>
    </div>
  );
}
```

- [ ] **Step 3: Write Sparkline**

A tiny canvas-based sparkline for the overview cards.

```tsx
// worker/dashboard/src/components/Sparkline.tsx

import { useRef, useEffect } from "react";

export function Sparkline({
  data,
  width = 120,
  height = 32,
  color = "#3b82f6",
}: {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || data.length < 2) return;

    const ctx = canvas.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;
    const pad = 2;

    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";

    data.forEach((v, i) => {
      const x = (i / (data.length - 1)) * (width - pad * 2) + pad;
      const y = height - pad - ((v - min) / range) * (height - pad * 2);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });

    ctx.stroke();
  }, [data, width, height, color]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width, height }}
      className="opacity-80"
    />
  );
}
```

- [ ] **Step 4: Write TimeRangeSelector**

```tsx
// worker/dashboard/src/components/TimeRangeSelector.tsx

import type { TimeRange } from "@/lib/hooks";

const RANGES: TimeRange[] = ["1h", "6h", "24h", "7d", "30d"];

export function TimeRangeSelector({
  value,
  onChange,
}: {
  value: TimeRange;
  onChange: (range: TimeRange) => void;
}) {
  return (
    <div className="flex gap-1 rounded-md border border-zinc-800 bg-zinc-900 p-1">
      {RANGES.map((range) => (
        <button
          key={range}
          onClick={() => onChange(range)}
          className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
            value === range
              ? "bg-zinc-700 text-zinc-100"
              : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          {range}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 5: Write AlertRow**

```tsx
// worker/dashboard/src/components/AlertRow.tsx

import type { Alert } from "@/lib/types";

const SEVERITY_STYLES: Record<string, string> = {
  critical: "text-red-400 bg-red-950/30 border-red-900/50",
  warning: "text-amber-400 bg-amber-950/30 border-amber-900/50",
  info: "text-blue-400 bg-blue-950/30 border-blue-900/50",
};

export function AlertRow({ alert }: { alert: Alert }) {
  const style = SEVERITY_STYLES[alert.severity] || SEVERITY_STYLES.info;
  const time = new Date(alert.timestamp).toLocaleString();
  const label = alert.type.replace(/_/g, " ");

  return (
    <div className={`flex items-center justify-between rounded-md border px-4 py-3 ${style}`}>
      <div>
        <span className="text-sm font-medium capitalize">{label}</span>
        <span className="ml-3 text-xs opacity-60">
          {alert.value.toFixed(1)} / {alert.threshold.toFixed(1)}
        </span>
      </div>
      <div className="text-xs font-mono opacity-60">{time}</div>
    </div>
  );
}
```

- [ ] **Step 6: Commit**

```bash
git add worker/dashboard/src/components/
git commit -m "feat: add StatusBadge, StatsBar, Sparkline, TimeRangeSelector, AlertRow"
```

---

### Task 5: Overview Page

**Files:**
- Create: `worker/dashboard/src/components/ClientCard.tsx`
- Modify: `worker/dashboard/src/pages/Overview.tsx`

- [ ] **Step 1: Write ClientCard**

```tsx
// worker/dashboard/src/components/ClientCard.tsx

import { Link } from "react-router";
import type { Client } from "@/lib/types";
import { StatusBadge } from "@/components/StatusBadge";
import { Sparkline } from "@/components/Sparkline";

export function ClientCard({
  client,
  latencyHistory,
}: {
  client: Client;
  latencyHistory?: number[];
}) {
  const timeSince = formatTimeSince(client.last_seen);

  return (
    <Link
      to={`/client/${client.id}`}
      className="flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 transition-colors hover:border-zinc-700 hover:bg-zinc-900"
    >
      <div className="flex items-start justify-between">
        <div>
          <h3 className="font-medium">{client.name}</h3>
          <p className="text-xs text-zinc-500">{client.location}</p>
        </div>
        <StatusBadge
          lastSeen={client.last_seen}
          thresholdMs={client.config.alert_latency_threshold_ms}
        />
      </div>

      <div className="flex items-end justify-between">
        <div className="space-y-1">
          <div className="text-xs text-zinc-500">
            Ping: <span className="font-mono text-zinc-300">{client.config.ping_interval_s}s</span>
          </div>
          <div className="text-xs text-zinc-500">
            Last seen: <span className="font-mono text-zinc-300">{timeSince}</span>
          </div>
        </div>
        {latencyHistory && latencyHistory.length > 1 && (
          <Sparkline data={latencyHistory} />
        )}
      </div>
    </Link>
  );
}

function formatTimeSince(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
```

- [ ] **Step 2: Implement Overview page**

```tsx
// worker/dashboard/src/pages/Overview.tsx

import { useClients } from "@/lib/hooks";
import { ClientCard } from "@/components/ClientCard";
import { StatsBar } from "@/components/StatsBar";

export function Overview() {
  const { data: clients, loading, error } = useClients(10_000);

  if (loading && !clients) {
    return <div className="text-sm text-zinc-400">Loading clients...</div>;
  }

  if (error) {
    return <div className="text-sm text-red-400">Failed to load clients: {error.message}</div>;
  }

  if (!clients || clients.length === 0) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">Overview</h1>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-8 text-center">
          <p className="text-zinc-400">No clients registered yet.</p>
          <p className="mt-1 text-sm text-zinc-500">
            Go to <a href="/clients" className="text-[var(--color-accent)] hover:underline">Client Management</a> to register your first client.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Overview</h1>
      </div>

      <StatsBar clients={clients} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {clients.map((client) => (
          <ClientCard key={client.id} client={client} />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify overview page renders with cards**

```bash
cd /Users/ericbaruch/Arik/dev/pingpulse/worker/dashboard
bun run dev
```

Expected: Overview page shows stats bar and client cards (or empty state if no clients)

- [ ] **Step 4: Commit**

```bash
git add worker/dashboard/
git commit -m "feat: add overview page with client cards, stats bar, sparklines"
```

---

### Task 6: Client Detail Page with Charts

**Files:**
- Create: `worker/dashboard/src/components/LatencyChart.tsx`
- Create: `worker/dashboard/src/components/ThroughputChart.tsx`
- Create: `worker/dashboard/src/components/OutageTimeline.tsx`
- Modify: `worker/dashboard/src/pages/ClientDetail.tsx`

- [ ] **Step 1: Install uPlot**

```bash
cd /Users/ericbaruch/Arik/dev/pingpulse/worker/dashboard
bun add uplot
```

- [ ] **Step 2: Write LatencyChart**

```tsx
// worker/dashboard/src/components/LatencyChart.tsx

import { useRef, useEffect } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { PingResult } from "@/lib/types";

export function LatencyChart({ pings }: { pings: PingResult[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<uPlot | null>(null);

  useEffect(() => {
    if (!containerRef.current || pings.length === 0) return;

    const okPings = pings.filter((p) => p.status === "ok").reverse();
    if (okPings.length === 0) return;

    const timestamps = okPings.map((p) => new Date(p.timestamp).getTime() / 1000);
    const rtts = okPings.map((p) => p.rtt_ms);
    const jitters = okPings.map((p) => p.jitter_ms);

    const opts: uPlot.Options = {
      width: containerRef.current.clientWidth,
      height: 280,
      class: "uplot-dark",
      cursor: { show: true },
      scales: {
        x: { time: true },
        y: { auto: true },
      },
      axes: [
        { stroke: "#71717a", grid: { stroke: "#27272a" }, ticks: { stroke: "#27272a" } },
        { stroke: "#71717a", grid: { stroke: "#27272a" }, ticks: { stroke: "#27272a" }, label: "ms" },
      ],
      series: [
        {},
        { label: "RTT", stroke: "#3b82f6", width: 1.5 },
        { label: "Jitter", stroke: "#f59e0b", width: 1, dash: [4, 4] },
      ],
    };

    if (chartRef.current) chartRef.current.destroy();
    chartRef.current = new uPlot(opts, [timestamps, rtts, jitters], containerRef.current);

    const observer = new ResizeObserver(() => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.setSize({
          width: containerRef.current.clientWidth,
          height: 280,
        });
      }
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [pings]);

  if (pings.length === 0) {
    return <div className="flex h-[280px] items-center justify-center text-sm text-zinc-500">No ping data</div>;
  }

  return <div ref={containerRef} />;
}
```

- [ ] **Step 3: Write ThroughputChart**

```tsx
// worker/dashboard/src/components/ThroughputChart.tsx

import { useRef, useEffect } from "react";
import uPlot from "uplot";
import type { SpeedTest } from "@/lib/types";

export function ThroughputChart({ tests }: { tests: SpeedTest[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<uPlot | null>(null);

  useEffect(() => {
    if (!containerRef.current || tests.length === 0) return;

    const sorted = [...tests].reverse();
    const timestamps = sorted.map((t) => new Date(t.timestamp).getTime() / 1000);
    const download = sorted.map((t) => t.download_mbps);
    const upload = sorted.map((t) => t.upload_mbps);

    const opts: uPlot.Options = {
      width: containerRef.current.clientWidth,
      height: 200,
      class: "uplot-dark",
      scales: { x: { time: true }, y: { auto: true } },
      axes: [
        { stroke: "#71717a", grid: { stroke: "#27272a" }, ticks: { stroke: "#27272a" } },
        { stroke: "#71717a", grid: { stroke: "#27272a" }, ticks: { stroke: "#27272a" }, label: "Mbps" },
      ],
      series: [
        {},
        { label: "Download", stroke: "#10b981", width: 2, fill: "#10b98120" },
        { label: "Upload", stroke: "#8b5cf6", width: 2, fill: "#8b5cf620" },
      ],
    };

    if (chartRef.current) chartRef.current.destroy();
    chartRef.current = new uPlot(opts, [timestamps, download, upload], containerRef.current);

    return () => { chartRef.current?.destroy(); chartRef.current = null; };
  }, [tests]);

  if (tests.length === 0) {
    return <div className="flex h-[200px] items-center justify-center text-sm text-zinc-500">No speed tests</div>;
  }

  return <div ref={containerRef} />;
}
```

- [ ] **Step 4: Write OutageTimeline**

```tsx
// worker/dashboard/src/components/OutageTimeline.tsx

import type { Outage } from "@/lib/types";

export function OutageTimeline({
  outages,
  from,
  to,
}: {
  outages: Outage[];
  from: string;
  to: string;
}) {
  const startMs = new Date(from).getTime();
  const endMs = new Date(to).getTime();
  const totalMs = endMs - startMs;

  if (totalMs <= 0) return null;

  return (
    <div className="space-y-2">
      <div className="text-xs text-zinc-500">Uptime Timeline</div>
      <div className="relative h-6 w-full overflow-hidden rounded-md bg-emerald-950/30 border border-emerald-900/30">
        {/* Green = up (background), red segments = down */}
        {outages.map((outage, i) => {
          const oStart = new Date(outage.start_ts).getTime();
          const oEnd = outage.end_ts ? new Date(outage.end_ts).getTime() : endMs;
          const left = ((Math.max(oStart, startMs) - startMs) / totalMs) * 100;
          const width = ((Math.min(oEnd, endMs) - Math.max(oStart, startMs)) / totalMs) * 100;

          return (
            <div
              key={i}
              className="absolute inset-y-0 bg-red-500/60"
              style={{ left: `${left}%`, width: `${Math.max(width, 0.5)}%` }}
              title={`Down: ${outage.duration_s ? `${Math.round(outage.duration_s)}s` : "ongoing"}`}
            />
          );
        })}
      </div>
      <div className="flex justify-between text-xs text-zinc-600 font-mono">
        <span>{new Date(from).toLocaleTimeString()}</span>
        <span>{new Date(to).toLocaleTimeString()}</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Implement ClientDetail page**

```tsx
// worker/dashboard/src/pages/ClientDetail.tsx

import { useState } from "react";
import { useParams, Link } from "react-router";
import { useClient, useMetrics, useAlerts, getTimeRange, type TimeRange } from "@/lib/hooks";
import { api } from "@/lib/api";
import { StatusBadge } from "@/components/StatusBadge";
import { TimeRangeSelector } from "@/components/TimeRangeSelector";
import { LatencyChart } from "@/components/LatencyChart";
import { ThroughputChart } from "@/components/ThroughputChart";
import { OutageTimeline } from "@/components/OutageTimeline";
import { AlertRow } from "@/components/AlertRow";

export function ClientDetail() {
  const { id } = useParams<{ id: string }>();
  const [range, setRange] = useState<TimeRange>("24h");
  const { from, to } = getTimeRange(range);

  const { data: client, loading: clientLoading } = useClient(id!);
  const { data: metrics, loading: metricsLoading } = useMetrics(id!, from, to);
  const { data: alerts } = useAlerts(id, 10);

  if (clientLoading && !client) {
    return <div className="text-sm text-zinc-400">Loading...</div>;
  }

  if (!client) {
    return <div className="text-sm text-red-400">Client not found</div>;
  }

  const handleSpeedTest = async () => {
    try {
      await api.triggerSpeedTest(id!);
    } catch {
      // ignore
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link to="/" className="text-zinc-500 hover:text-zinc-300">&larr;</Link>
          <div>
            <h1 className="text-xl font-semibold">{client.name}</h1>
            <p className="text-sm text-zinc-500">{client.location}</p>
          </div>
          <StatusBadge lastSeen={client.last_seen} thresholdMs={client.config.alert_latency_threshold_ms} />
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleSpeedTest}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800"
          >
            Run Speed Test
          </button>
          <TimeRangeSelector value={range} onChange={setRange} />
        </div>
      </div>

      {/* Summary stats */}
      {metrics && (
        <div className="grid grid-cols-5 gap-4">
          {[
            ["Avg RTT", `${metrics.summary.avg_rtt_ms.toFixed(1)}ms`],
            ["P95 RTT", `${metrics.summary.p95_rtt_ms.toFixed(1)}ms`],
            ["Packet Loss", `${metrics.summary.loss_pct.toFixed(1)}%`],
            ["Pings", `${metrics.summary.ok_pings}/${metrics.summary.total_pings}`],
            ["Outages", `${metrics.outages.length}`],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 text-center">
              <div className="text-lg font-bold font-mono">{value}</div>
              <div className="text-xs text-zinc-500">{label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Latency chart */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
        <h2 className="mb-3 text-sm font-medium text-zinc-400">Latency & Jitter</h2>
        {metricsLoading && !metrics ? (
          <div className="flex h-[280px] items-center justify-center text-sm text-zinc-500">Loading...</div>
        ) : (
          <LatencyChart pings={metrics?.pings || []} />
        )}
      </div>

      {/* Throughput chart */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
        <h2 className="mb-3 text-sm font-medium text-zinc-400">Throughput</h2>
        <ThroughputChart tests={metrics?.speed_tests || []} />
      </div>

      {/* Outage timeline */}
      {metrics && metrics.outages.length > 0 && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
          <OutageTimeline outages={metrics.outages} from={from} to={to} />
        </div>
      )}

      {/* Recent alerts */}
      {alerts && alerts.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-zinc-400">Recent Alerts</h2>
          <div className="space-y-2">
            {alerts.map((alert) => (
              <AlertRow key={alert.id} alert={alert} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Commit**

```bash
git add worker/dashboard/
git commit -m "feat: add client detail page with latency, throughput, outage charts"
```

---

### Task 7: Client Management Page

**Files:**
- Create: `worker/dashboard/src/components/RegisterDialog.tsx`
- Modify: `worker/dashboard/src/pages/Clients.tsx`

- [ ] **Step 1: Write RegisterDialog**

```tsx
// worker/dashboard/src/components/RegisterDialog.tsx

import { useState } from "react";
import { api } from "@/lib/api";

export function RegisterDialog({ onClose }: { onClose: () => void }) {
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleGenerate = async () => {
    setLoading(true);
    try {
      const { token } = await api.generateToken();
      setToken(token);
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = () => {
    if (!token) return;
    const cmd = `pingpulse register --token ${token}`;
    navigator.clipboard.writeText(cmd);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="w-full max-w-md rounded-lg border border-zinc-800 bg-zinc-900 p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold">Register New Client</h2>
        <p className="mt-1 text-sm text-zinc-400">Generate a registration token, then run the command on the target machine.</p>

        {!token ? (
          <button
            onClick={handleGenerate}
            disabled={loading}
            className="mt-4 w-full rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
          >
            {loading ? "Generating..." : "Generate Token"}
          </button>
        ) : (
          <div className="mt-4 space-y-3">
            <div className="rounded-md bg-zinc-950 p-3 font-mono text-xs text-zinc-300 break-all">
              pingpulse register --token {token}
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleCopy}
                className="flex-1 rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
              >
                {copied ? "Copied!" : "Copy command"}
              </button>
              <button
                onClick={onClose}
                className="flex-1 rounded-md bg-zinc-800 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-700"
              >
                Done
              </button>
            </div>
            <p className="text-xs text-zinc-500">Token expires in 15 minutes and can only be used once.</p>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write EditClientDialog**

```tsx
// worker/dashboard/src/components/EditClientDialog.tsx

import { useState, type FormEvent } from "react";
import { api } from "@/lib/api";
import type { Client } from "@/lib/types";

export function EditClientDialog({
  client,
  onClose,
}: {
  client: Client;
  onClose: () => void;
}) {
  const [name, setName] = useState(client.name);
  const [location, setLocation] = useState(client.location);
  const [pingInterval, setPingInterval] = useState(String(client.config.ping_interval_s));
  const [latencyThreshold, setLatencyThreshold] = useState(String(client.config.alert_latency_threshold_ms));
  const [lossThreshold, setLossThreshold] = useState(String(client.config.alert_loss_threshold_pct));
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.updateClient(client.id, {
        name,
        location,
        config: {
          ping_interval_s: parseInt(pingInterval),
          alert_latency_threshold_ms: parseFloat(latencyThreshold),
          alert_loss_threshold_pct: parseFloat(lossThreshold),
        },
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md space-y-4 rounded-lg border border-zinc-800 bg-zinc-900 p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">Edit Client</h2>
        <div>
          <label className="block text-xs text-zinc-500">Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 focus:border-[var(--color-accent)] focus:outline-none" />
        </div>
        <div>
          <label className="block text-xs text-zinc-500">Location</label>
          <input value={location} onChange={(e) => setLocation(e.target.value)}
            className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 focus:border-[var(--color-accent)] focus:outline-none" />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="block text-xs text-zinc-500">Ping (s)</label>
            <input type="number" value={pingInterval} onChange={(e) => setPingInterval(e.target.value)}
              className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm font-mono text-zinc-100 focus:border-[var(--color-accent)] focus:outline-none" />
          </div>
          <div>
            <label className="block text-xs text-zinc-500">Latency (ms)</label>
            <input type="number" value={latencyThreshold} onChange={(e) => setLatencyThreshold(e.target.value)}
              className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm font-mono text-zinc-100 focus:border-[var(--color-accent)] focus:outline-none" />
          </div>
          <div>
            <label className="block text-xs text-zinc-500">Loss (%)</label>
            <input type="number" value={lossThreshold} onChange={(e) => setLossThreshold(e.target.value)}
              className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm font-mono text-zinc-100 focus:border-[var(--color-accent)] focus:outline-none" />
          </div>
        </div>
        <div className="flex gap-2 pt-2">
          <button type="submit" disabled={saving}
            className="flex-1 rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
            {saving ? "Saving..." : "Save"}
          </button>
          <button type="button" onClick={onClose}
            className="flex-1 rounded-md bg-zinc-800 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-700">
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
```

- [ ] **Step 3: Implement Clients page**

```tsx
// worker/dashboard/src/pages/Clients.tsx

import { useState } from "react";
import { Link } from "react-router";
import { useClients } from "@/lib/hooks";
import { api } from "@/lib/api";
import type { Client } from "@/lib/types";
import { StatusBadge } from "@/components/StatusBadge";
import { RegisterDialog } from "@/components/RegisterDialog";
import { EditClientDialog } from "@/components/EditClientDialog";

export function Clients() {
  const { data: clients, refresh } = useClients(10_000);
  const [showRegister, setShowRegister] = useState(false);
  const [editingClient, setEditingClient] = useState<Client | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const handleBulkSpeedTest = async () => {
    if (!clients) return;
    await Promise.allSettled(clients.map((c) => api.triggerSpeedTest(c.id)));
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete client "${name}"? This removes all its data.`)) return;
    setDeleting(id);
    try {
      await api.deleteClient(id);
      refresh();
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Client Management</h1>
        <div className="flex gap-2">
          <button
            onClick={handleBulkSpeedTest}
            className="rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
          >
            Speed Test All
          </button>
          <button
            onClick={() => setShowRegister(true)}
            className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-accent-hover)]"
          >
            Register Client
          </button>
        </div>
      </div>

      {clients && clients.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900/80 text-left text-xs text-zinc-500">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Location</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Ping Interval</th>
                <th className="px-4 py-3">Last Seen</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {clients.map((client) => (
                <tr key={client.id} className="hover:bg-zinc-900/50">
                  <td className="px-4 py-3">
                    <Link to={`/client/${client.id}`} className="font-medium hover:text-[var(--color-accent)]">
                      {client.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-zinc-400">{client.location}</td>
                  <td className="px-4 py-3">
                    <StatusBadge lastSeen={client.last_seen} />
                  </td>
                  <td className="px-4 py-3 font-mono text-zinc-400">{client.config.ping_interval_s}s</td>
                  <td className="px-4 py-3 font-mono text-xs text-zinc-500">
                    {new Date(client.last_seen).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right space-x-3">
                    <button
                      onClick={() => setEditingClient(client)}
                      className="text-xs text-zinc-400 hover:text-zinc-200"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleDelete(client.id, client.name)}
                      disabled={deleting === client.id}
                      className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50"
                    >
                      {deleting === client.id ? "Deleting..." : "Delete"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-8 text-center text-zinc-400">
          No clients registered yet.
        </div>
      )}

      {showRegister && <RegisterDialog onClose={() => { setShowRegister(false); refresh(); }} />}
      {editingClient && <EditClientDialog client={editingClient} onClose={() => { setEditingClient(null); refresh(); }} />}
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add worker/dashboard/
git commit -m "feat: add client management with register, edit, delete, bulk speed test"
```

---

### Task 8: Alerts Page

**Files:**
- Modify: `worker/dashboard/src/pages/Alerts.tsx`

- [ ] **Step 1: Implement Alerts page**

```tsx
// worker/dashboard/src/pages/Alerts.tsx

import { useState } from "react";
import { useAlerts } from "@/lib/hooks";
import { api } from "@/lib/api";
import { AlertRow } from "@/components/AlertRow";

export function Alerts() {
  const { data: alerts, loading, refresh } = useAlerts(undefined, 100);
  const [latencyThreshold, setLatencyThreshold] = useState("");
  const [lossThreshold, setLossThreshold] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSaveThresholds = async () => {
    setSaving(true);
    try {
      await api.updateThresholds({
        ...(latencyThreshold ? { default_latency_threshold_ms: parseFloat(latencyThreshold) } : {}),
        ...(lossThreshold ? { default_loss_threshold_pct: parseFloat(lossThreshold) } : {}),
      });
      setLatencyThreshold("");
      setLossThreshold("");
    } finally {
      setSaving(false);
    }
  };

  const handleTestAlert = async () => {
    await api.testAlert();
  };

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Alerts</h1>

      {/* Threshold config */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
        <h2 className="mb-3 text-sm font-medium text-zinc-400">Default Alert Thresholds</h2>
        <div className="flex items-end gap-4">
          <div>
            <label className="block text-xs text-zinc-500">Latency (ms)</label>
            <input
              type="number"
              value={latencyThreshold}
              onChange={(e) => setLatencyThreshold(e.target.value)}
              placeholder="100"
              className="mt-1 w-32 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 font-mono placeholder:text-zinc-600 focus:border-[var(--color-accent)] focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-500">Packet Loss (%)</label>
            <input
              type="number"
              value={lossThreshold}
              onChange={(e) => setLossThreshold(e.target.value)}
              placeholder="5"
              className="mt-1 w-32 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 font-mono placeholder:text-zinc-600 focus:border-[var(--color-accent)] focus:outline-none"
            />
          </div>
          <button
            onClick={handleSaveThresholds}
            disabled={saving || (!latencyThreshold && !lossThreshold)}
            className="rounded-md bg-[var(--color-accent)] px-4 py-1.5 text-sm font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save"}
          </button>
          <button
            onClick={handleTestAlert}
            className="rounded-md border border-zinc-700 px-4 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
          >
            Send Test Alert
          </button>
        </div>
      </div>

      {/* Alert history */}
      <div className="space-y-2">
        <h2 className="text-sm font-medium text-zinc-400">Alert History</h2>
        {loading && !alerts ? (
          <div className="text-sm text-zinc-500">Loading...</div>
        ) : alerts && alerts.length > 0 ? (
          <div className="space-y-2">
            {alerts.map((alert) => (
              <AlertRow key={alert.id} alert={alert} />
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 text-center text-sm text-zinc-500">
            No alerts yet
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add worker/dashboard/src/pages/Alerts.tsx
git commit -m "feat: add alerts page with threshold config and history"
```

---

### Task 9: Settings Page

**Files:**
- Modify: `worker/dashboard/src/pages/Settings.tsx`

- [ ] **Step 1: Implement Settings page**

```tsx
// worker/dashboard/src/pages/Settings.tsx

import { useState, type FormEvent } from "react";
import { useClients } from "@/lib/hooks";
import { api } from "@/lib/api";

export function Settings() {
  const { data: clients } = useClients();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordMsg, setPasswordMsg] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);

  const handlePasswordChange = async (e: FormEvent) => {
    e.preventDefault();
    setSavingPassword(true);
    setPasswordMsg("");
    try {
      // NOTE: Requires backend route `PUT /api/auth/password` — add to Worker if missing
      await fetch("/api/auth/password", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
      });
      setPasswordMsg("Password updated");
      setCurrentPassword("");
      setNewPassword("");
    } catch {
      setPasswordMsg("Failed to update password");
    } finally {
      setSavingPassword(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-8">
      <h1 className="text-xl font-semibold">Settings</h1>

      {/* Change Password */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-zinc-400">Account</h2>
        <form onSubmit={handlePasswordChange} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 space-y-3">
          <div>
            <label className="block text-xs text-zinc-500">Current Password</label>
            <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)}
              className="mt-1 w-full max-w-xs rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 focus:border-[var(--color-accent)] focus:outline-none" />
          </div>
          <div>
            <label className="block text-xs text-zinc-500">New Password</label>
            <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
              className="mt-1 w-full max-w-xs rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 focus:border-[var(--color-accent)] focus:outline-none" />
          </div>
          <div className="flex items-center gap-3">
            <button type="submit" disabled={savingPassword || !currentPassword || !newPassword}
              className="rounded-md bg-[var(--color-accent)] px-4 py-1.5 text-sm font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
              {savingPassword ? "Updating..." : "Change Password"}
            </button>
            {passwordMsg && <span className="text-xs text-zinc-400">{passwordMsg}</span>}
          </div>
        </form>
      </section>

      {/* Data Retention (informational — retention is configured in Worker env/code) */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-zinc-400">Data Retention</h2>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 space-y-2 text-sm text-zinc-400">
          <div className="flex justify-between">
            <span>D1 (ping results, speed tests)</span>
            <span className="font-mono text-zinc-300">30 days</span>
          </div>
          <div className="flex justify-between">
            <span>Analytics Engine (time-series metrics)</span>
            <span className="font-mono text-zinc-300">90 days</span>
          </div>
          <div className="flex justify-between">
            <span>R2 Archive (gzipped exports)</span>
            <span className="font-mono text-zinc-300">Unlimited</span>
          </div>
          <p className="pt-2 text-xs text-zinc-600">
            Retention periods are managed by the cron job. Adjust in Worker configuration.
          </p>
        </div>
      </section>

      {/* Export */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-zinc-400">Export Data</h2>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 space-y-3">
          {clients && clients.length > 0 ? (
            clients.map((client) => (
              <div key={client.id} className="flex items-center justify-between">
                <span className="text-sm">{client.name}</span>
                <div className="flex gap-2">
                  <a href={api.exportData(client.id, "json")}
                    className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800" download>
                    JSON
                  </a>
                  <a href={api.exportData(client.id, "csv")}
                    className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800" download>
                    CSV
                  </a>
                </div>
              </div>
            ))
          ) : (
            <p className="text-sm text-zinc-500">No clients to export</p>
          )}
        </div>
      </section>

      {/* About */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-zinc-400">About</h2>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 text-sm text-zinc-400">
          <p>PingPulse — Bidirectional network monitoring</p>
          <p className="mt-1 font-mono text-xs text-zinc-600">Dashboard served from Cloudflare Workers</p>
        </div>
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add worker/dashboard/src/pages/Settings.tsx
git commit -m "feat: add settings page with password change, retention info, export"
```

---

### Task 10: Build Integration + Final Verification

**Files:**
- Modify: `worker/wrangler.toml`
- Modify: `worker/package.json`

- [ ] **Step 1: Add dashboard build to worker package.json**

Add to `worker/package.json` scripts:
```json
{
  "scripts": {
    "dev": "wrangler dev",
    "dev:dashboard": "cd dashboard && bun run dev",
    "build": "cd dashboard && bun run build && cd .. && wrangler deploy --dry-run",
    "deploy": "cd dashboard && bun run build && cd .. && wrangler deploy",
    "test": "vitest run"
  }
}
```

- [ ] **Step 2: Build the dashboard**

```bash
cd /Users/ericbaruch/Arik/dev/pingpulse/worker/dashboard
bun run build
```

Expected: Build output in `worker/dashboard/dist/`

- [ ] **Step 3: Verify wrangler dry-run with assets**

```bash
cd /Users/ericbaruch/Arik/dev/pingpulse/worker
bunx wrangler deploy --dry-run
```

Expected: Dry run succeeds, shows static assets would be deployed

- [ ] **Step 4: Add `dashboard/dist` to `.gitignore`**

Add to `worker/.gitignore`:
```
dashboard/dist
dashboard/node_modules
```

- [ ] **Step 5: Run full worker test suite to ensure nothing broke**

```bash
cd /Users/ericbaruch/Arik/dev/pingpulse/worker
bunx vitest run
```

Expected: All 37 tests still passing

- [ ] **Step 6: Final commit**

```bash
git add worker/
git commit -m "feat: integrate dashboard build with wrangler deploy"
```

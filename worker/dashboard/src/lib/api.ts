import type { Client, MetricsResponse, Alert, PingResult, AnalysisResponse } from "@/lib/types";

// Base URL of the Convex HTTP actions deployment. Empty string keeps requests
// same-origin (e.g. behind the Vite dev proxy).
export const API_BASE = import.meta.env.VITE_API_URL ?? "";

const TOKEN_KEY = "pp_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(apiUrl(path), {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });

  if (res.status === 401) {
    clearToken();
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
  login: async (password: string) => {
    const res = await request<{ token: string }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
    setToken(res.token);
    return res;
  },
  logout: async () => {
    try {
      await request<{ ok: boolean }>("/api/auth/logout", { method: "POST" });
    } finally {
      clearToken();
    }
    return { ok: true };
  },
  me: () => request<{ sub: string; exp: number }>("/api/auth/me"),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: boolean }>("/api/auth/password", {
      method: "PUT",
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    }),

  // Clients
  listClients: () => request<{ clients: Client[]; latest_client_version: string }>("/api/clients"),
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
  getSyncStatus: (id: string) =>
    request<{ last_sync: number | null; total_records: number; latest_probe_ts: number | null }>(
      `/api/metrics/${id}/sync-status`
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

  // Commands
  sendCommand: (id: string, command: string, params?: Record<string, unknown>) =>
    request<Record<string, unknown>>(`/api/command/${id}`, {
      method: "POST",
      body: JSON.stringify({ command, params }),
    }),
  getClientStatus: (id: string) =>
    request<{
      connected: boolean;
      session_count: number;
      paused: boolean;
      simulation: { latency_ms: number; loss_pct: number };
      pings_in_flight: number;
      buffer_size: number;
      disconnected_at: string | null;
    }>(`/api/command/${id}/status`),

  // Probes
  getProbes: (id: string, from: string, to: string, type?: string) => {
    const params = new URLSearchParams({ from, to });
    if (type) params.set("type", type);
    return request<{ data: unknown[] }>(`/api/metrics/${id}/probes?${params}`);
  },

  // Analysis
  getAnalysis: (id: string, from: string, to: string) =>
    request<AnalysisResponse>(`/api/metrics/${id}/analysis?from=${from}&to=${to}`),

  // Reports
  generateReport: (id: string) =>
    request<{ report: Record<string, unknown[]>; sent: Record<string, boolean> }>(
      `/api/metrics/${id}/report`,
      { method: "POST" }
    ),
  sendReport: (id: string, channel: "telegram" | "email" | "all") =>
    request<{ report: Record<string, unknown[]>; sent: Record<string, boolean> }>(
      `/api/metrics/${id}/report?send=${channel}`,
      { method: "POST" }
    ),

  // Export — returns a download URL. The admin token is passed as a query
  // param because the browser can't attach an Authorization header to a plain
  // <a download> navigation.
  exportData: (id: string, format: "json" | "csv", from?: string, to?: string) => {
    const params = new URLSearchParams({ format });
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const token = getToken();
    if (token) params.set("token", token);
    return apiUrl(`/api/export/${id}?${params}`);
  },
};

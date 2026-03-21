import type { Client, MetricsResponse, Alert, PingResult } from "@/lib/types";

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  if (res.status === 401) {
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

  // Export
  exportData: (id: string, format: "json" | "csv", from?: string, to?: string) => {
    const params = new URLSearchParams({ format });
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    return `/api/export/${id}?${params}`;
  },
};

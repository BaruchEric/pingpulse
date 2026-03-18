const AGENT_BASE = "http://localhost:9111";
const AGENT_TIMEOUT = 2000;

export interface AgentStatus {
  client_id: string;
  server_url: string;
  daemon_running: boolean;
  agent_version: string;
  uptime_s: number;
}

export interface AgentActionResponse {
  ok: boolean;
  error?: string;
  warnings?: string[];
}

export interface AgentLogs {
  lines: string[];
  file: string;
}

async function agentRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AGENT_TIMEOUT);

  try {
    const res = await fetch(`${AGENT_BASE}${path}`, {
      ...init,
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error((body as { error?: string }).error || res.statusText);
    }
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

export const localAgent = {
  detect: async (): Promise<AgentStatus | null> => {
    try {
      return await agentRequest<AgentStatus>("/status");
    } catch {
      return null;
    }
  },
  status: () => agentRequest<AgentStatus>("/status"),
  daemonStart: () => agentRequest<AgentActionResponse>("/daemon/start", { method: "POST" }),
  daemonStop: () => agentRequest<AgentActionResponse>("/daemon/stop", { method: "POST" }),
  daemonRestart: () => agentRequest<AgentActionResponse>("/daemon/restart", { method: "POST" }),
  serviceRemove: () => agentRequest<AgentActionResponse>("/service/remove", { method: "POST" }),
  serviceUninstall: () => agentRequest<AgentActionResponse>("/service/uninstall", { method: "POST" }),
  logs: () => agentRequest<AgentLogs>("/logs"),
};

import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "@/lib/api";

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
  const lastJsonRef = useRef("");

  const refresh = useCallback(() => {
    fetcherRef.current()
      .then((d) => {
        const json = JSON.stringify(d);
        if (json !== lastJsonRef.current) {
          lastJsonRef.current = json;
          setData(d);
        }
        setError(null);
      })
      .catch(setError)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
    if (intervalMs <= 0) return;
    const id = setInterval(refresh, intervalMs);
    // Immediately refresh when tab becomes visible again
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, intervalMs, ...deps]);

  return { data, error, loading, refresh };
}

export function useClients(intervalMs = 10_000) {
  return usePolling(
    () => api.listClients().then((r) => ({ clients: r.clients, latest_client_version: r.latest_client_version })),
    intervalMs
  );
}

export function useClient(id: string) {
  return usePolling(() => api.getClient(id), 10_000, [id]);
}

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

export function useMetrics(id: string, range: TimeRange) {
  return usePolling(
    () => {
      const { from, to } = getTimeRange(range);
      return api.getMetrics(id, from, to);
    },
    10_000,
    [id, range]
  );
}

export function useAlerts(clientId?: string, limit = 50) {
  return usePolling(
    () => api.listAlerts(clientId, limit).then((r) => r.alerts),
    10_000,
    [clientId, limit]
  );
}

export function useClientStatus(id: string) {
  return usePolling(() => api.getClientStatus(id), 5_000, [id]);
}

export function useLogs(clientId: string, page: number, perPage = 50) {
  return usePolling(
    () => api.getLogs(clientId, perPage, page * perPage),
    0,
    [clientId, page, perPage]
  );
}

export function useAnalysis(clientId: string, range: TimeRange, enabled = true) {
  // No auto-poll — analysis data is historical. Fetch once on mount / range change.
  return usePolling(
    () => {
      if (!enabled) return Promise.resolve(null);
      const { from, to } = getTimeRange(range);
      return api.getAnalysis(clientId, from, to);
    },
    0,  // intervalMs = 0 disables polling
    [clientId, range, enabled]
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

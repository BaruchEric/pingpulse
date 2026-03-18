import { useState, useEffect, useRef, useCallback } from "react";
import { localAgent, type AgentStatus, type AgentLogs } from "@/lib/local-agent";

interface Props {
  onUninstalled: () => void;
}

export function LocalClientPanel({ onUninstalled }: Props) {
  const [detected, setDetected] = useState<boolean | null>(null); // null = loading
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [logs, setLogs] = useState<AgentLogs | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const showToast = (msg: string) => {
    setToast(msg);
    clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 3500);
  };

  const fetchStatus = useCallback(async () => {
    try {
      const s = await localAgent.status();
      setStatus((prev) => {
        if (prev && prev.daemon_running === s.daemon_running && prev.uptime_s === s.uptime_s) {
          return prev;
        }
        return s;
      });
      setDetected(true);
    } catch {
      setDetected(false);
    }
  }, []);

  useEffect(() => {
    localAgent.detect().then((s) => {
      if (s) {
        setDetected(true);
        setStatus(s);
        pollRef.current = setInterval(fetchStatus, 5000);
      } else {
        setDetected(false);
      }
    });

    // Pause polling when tab is hidden
    const onVisibility = () => {
      if (document.hidden) {
        clearInterval(pollRef.current);
      } else {
        fetchStatus();
        pollRef.current = setInterval(fetchStatus, 5000);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      clearInterval(pollRef.current);
      clearTimeout(toastTimerRef.current);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [fetchStatus]);

  const runAction = async (label: string, action: () => Promise<{ ok: boolean; error?: string; warnings?: string[] }>) => {
    setBusy(label);
    try {
      const res = await action();
      if (!res.ok) {
        showToast(`Error: ${res.error ?? "unknown error"}`);
      } else {
        showToast(`${label} succeeded`);
        if (res.warnings?.length) {
          res.warnings.forEach((w) => console.warn("[local-agent]", w));
        }
        await fetchStatus();
      }
    } catch (e) {
      showToast(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const handleRemoveService = () => {
    if (!confirm("Remove the PingPulse system service from this machine? The binary will remain.")) return;
    runAction("Remove Service", localAgent.serviceRemove);
  };

  const handleFullUninstall = () => {
    if (!confirm("This will remove all PingPulse services, config, and logs from this machine and delete the client from the server. This cannot be undone. Continue?")) return;
    runAction("Full Uninstall", async () => {
      const res = await localAgent.serviceUninstall();
      if (res.ok) {
        setDetected(false);
        setStatus(null);
        clearInterval(pollRef.current);
        onUninstalled();
      }
      return res;
    });
  };

  const handleViewLogs = async () => {
    try {
      const l = await localAgent.logs();
      setLogs(l);
    } catch (e) {
      showToast(`Failed to fetch logs: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  if (detected === null || detected === false) return null;

  const running = status?.daemon_running ?? false;
  const isBusy = busy !== null;

  return (
    <>
      {/* Toast */}
      {toast && (
        <div className="fixed top-4 right-4 z-50 rounded-md border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-200 shadow-lg">
          {toast}
        </div>
      )}

      {/* Logs Modal */}
      {logs && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
          onClick={() => setLogs(null)}
        >
          <div
            className="w-full max-w-2xl rounded-lg border border-zinc-800 bg-zinc-900 p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-200">Agent Logs</h3>
              <span className="font-mono text-xs text-zinc-500">{logs.file}</span>
            </div>
            <div className="max-h-96 overflow-y-auto rounded-md bg-zinc-950 p-3 font-mono text-xs text-zinc-300">
              {logs.lines.length === 0 ? (
                <span className="text-zinc-500">No log entries.</span>
              ) : (
                logs.lines.map((line, i) => (
                  <div key={i} className="leading-5">{line}</div>
                ))
              )}
            </div>
            <button
              onClick={() => setLogs(null)}
              className="mt-4 rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
            >
              Close
            </button>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-emerald-800/50 bg-emerald-950/20 p-5">
        {/* Header */}
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-zinc-200">
                {status?.client_id ? `Client ${status.client_id.slice(0, 8)}` : "Local Client"}
              </h2>
              <span className="rounded-full border border-emerald-700/60 bg-emerald-900/40 px-2 py-0.5 text-xs text-emerald-400">
                local
              </span>
            </div>
            {status && (
              <p className="mt-0.5 font-mono text-xs text-zinc-500">
                v{status.agent_version} · uptime {formatUptime(status.uptime_s)}
              </p>
            )}
          </div>

          {/* Status badge */}
          <div className="flex items-center gap-2">
            {running ? (
              <span className="flex items-center gap-1.5 rounded-full border border-emerald-700/50 bg-emerald-900/30 px-3 py-1 text-xs font-medium text-emerald-400">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
                Daemon running
              </span>
            ) : (
              <span className="flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-800/50 px-3 py-1 text-xs font-medium text-zinc-400">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-zinc-500" />
                Daemon stopped
              </span>
            )}
          </div>
        </div>

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => runAction("Start", localAgent.daemonStart)}
            disabled={isBusy || running}
            className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-40"
          >
            {busy === "Start" ? "Starting…" : "Start"}
          </button>
          <button
            onClick={() => runAction("Stop", localAgent.daemonStop)}
            disabled={isBusy || !running}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
          >
            {busy === "Stop" ? "Stopping…" : "Stop"}
          </button>
          <button
            onClick={() => runAction("Restart", localAgent.daemonRestart)}
            disabled={isBusy}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
          >
            {busy === "Restart" ? "Restarting…" : "Restart"}
          </button>
          <button
            onClick={handleViewLogs}
            disabled={isBusy}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
          >
            View Logs
          </button>

          {/* Danger zone */}
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={handleRemoveService}
              disabled={isBusy}
              className="rounded-md border border-red-800 px-3 py-1.5 text-xs text-red-400 hover:bg-red-950/40 disabled:opacity-40"
            >
              {busy === "Remove Service" ? "Removing…" : "Remove Service"}
            </button>
            <button
              onClick={handleFullUninstall}
              disabled={isBusy}
              className="rounded-md bg-red-900 px-3 py-1.5 text-xs font-medium text-red-200 hover:bg-red-800 disabled:opacity-40"
            >
              {busy === "Full Uninstall" ? "Uninstalling…" : "Full Uninstall"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

import { useState, useEffect, useRef } from "react";
import { RegisterDialog } from "@/components/RegisterDialog";
import { useParams, Link } from "react-router";
import { api } from "@/lib/api";
import { useClient, useClientStatus } from "@/lib/hooks";
import { StatusBadge } from "@/components/StatusBadge";
import { SectionHeader } from "@/components/SectionHeader";

const INPUT_CLASS = "w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm font-mono text-zinc-100 focus:border-[var(--color-accent)] focus:outline-none";

export function ControlPanel() {
  const { id } = useParams<{ id: string }>();
  const clientId = id ?? "";
  const { data: client, refresh: refreshClient } = useClient(clientId);
  const { data: status, refresh: refreshStatus } = useClientStatus(clientId);
  const [busy, setBusy] = useState<string | null>(null);
  const [simLatency, setSimLatency] = useState("0");
  const [simLoss, setSimLoss] = useState("0");
  const [toast, setToast] = useState<string | null>(null);
  const simInitialized = useRef(false);

  // Initialize sim values from first status fetch only
  useEffect(() => {
    if (status && !simInitialized.current) {
      setSimLatency(String(status.simulation.latency_ms));
      setSimLoss(String(status.simulation.loss_pct));
      simInitialized.current = true;
    }
  }, [status]);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const runCommand = async (command: string, params?: Record<string, unknown>, label?: string) => {
    setBusy(command);
    try {
      await api.sendCommand(clientId, command, params);
      showToast(`${label || command} sent`);
      refreshStatus();
      refreshClient();
    } catch (e) {
      showToast(`Failed: ${e instanceof Error ? e.message : "unknown"}`);
    } finally {
      setBusy(null);
    }
  };

  if (!client) {
    return <div className="text-sm text-zinc-400">Loading...</div>;
  }

  const btnClass = "rounded-md px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
  const btnPrimary = `${btnClass} bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)]`;
  const btnSecondary = `${btnClass} border border-zinc-700 text-zinc-300 hover:bg-zinc-800`;
  const btnDanger = `${btnClass} border border-red-800 text-red-400 hover:bg-red-950`;

  return (
    <div className="space-y-6">
      {/* Toast */}
      {toast && (
        <div className="fixed top-4 right-4 z-50 rounded-md border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-200 shadow-lg">
          {toast}
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link to={`/client/${id}`} className="text-zinc-400 hover:text-zinc-300">&larr;</Link>
          <div>
            <h1 className="text-xl font-semibold">{client.name} — Control Panel</h1>
            <p className="text-sm text-zinc-400">{client.location}</p>
          </div>
          <StatusBadge
            lastSeen={client.last_seen}
            pingIntervalMs={client.config.ping_interval_s * 1000}
          />
        </div>
      </div>

      {/* Live Status */}
      {status && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
          {[
            ["Connection", status.connected ? "Connected" : "Disconnected", status.connected ? "text-emerald-400" : "text-red-400"],
            ["Sessions", String(status.session_count), "text-zinc-200"],
            ["State", status.paused ? "Paused" : "Running", status.paused ? "text-amber-400" : "text-emerald-400"],
            ["Buffer", String(status.buffer_size), "text-zinc-200"],
          ].map(([label, value, color]) => (
            <div key={label} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 text-center">
              <div className={`text-lg font-bold font-mono ${color}`}>{value}</div>
              <div className="text-xs text-zinc-400">{label}</div>
            </div>
          ))}
        </div>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        {/* Monitoring Control */}
        <div className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
          <h2 className="text-sm font-medium text-zinc-400">Monitoring Control</h2>
          <div className="flex gap-2">
            <button
              onClick={() => runCommand("pause", undefined, "Pause")}
              disabled={busy !== null || status?.paused}
              className={btnSecondary}
            >
              {busy === "pause" ? "Pausing..." : "Pause"}
            </button>
            <button
              onClick={() => runCommand("resume", undefined, "Resume")}
              disabled={busy !== null || !status?.paused}
              className={btnPrimary}
            >
              {busy === "resume" ? "Resuming..." : "Resume"}
            </button>
            <button
              onClick={() => runCommand("disconnect", undefined, "Disconnect")}
              disabled={busy !== null || !status?.connected}
              className={btnDanger}
            >
              {busy === "disconnect" ? "Disconnecting..." : "Force Disconnect"}
            </button>
          </div>
          <p className="text-xs text-zinc-400">
            Pause stops server-side pings. Disconnect closes the WebSocket (client will auto-reconnect).
          </p>
        </div>

        {/* Speed Tests */}
        <div className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
          <h2 className="text-sm font-medium text-zinc-400">Speed Tests</h2>
          <div className="flex gap-2">
            <button
              onClick={() => runCommand("speed_test", { test_type: "probe" }, "Probe test")}
              disabled={busy !== null || !status?.connected}
              className={btnSecondary}
            >
              {busy === "speed_test" ? "Running..." : "Probe (256KB)"}
            </button>
            <button
              onClick={() => runCommand("speed_test", { test_type: "full" }, "Full test")}
              disabled={busy !== null || !status?.connected}
              className={btnPrimary}
            >
              Full Test (10MB)
            </button>
          </div>
          <p className="text-xs text-zinc-400">
            Probe is a quick bandwidth check. Full test provides accurate throughput measurement.
          </p>
        </div>

        {/* Simulation */}
        <div className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
          <h2 className="text-sm font-medium text-zinc-400">Simulation</h2>
          {status && (status.simulation.latency_ms > 0 || status.simulation.loss_pct > 0) && (
            <div className="rounded-md border border-amber-800/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-400">
              Active: +{status.simulation.latency_ms}ms latency, {status.simulation.loss_pct}% loss
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-zinc-400">Added Latency (ms)</label>
              <input
                type="number"
                min="0"
                value={simLatency}
                onChange={(e) => setSimLatency(e.target.value)}
                className={INPUT_CLASS}
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-400">Packet Loss (%)</label>
              <input
                type="number"
                min="0"
                max="100"
                value={simLoss}
                onChange={(e) => setSimLoss(e.target.value)}
                className={INPUT_CLASS}
              />
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => runCommand("simulate", {
                latency_ms: parseInt(simLatency) || 0,
                loss_pct: parseInt(simLoss) || 0,
              }, "Simulation")}
              disabled={busy !== null}
              className={btnPrimary}
            >
              Apply
            </button>
            <button
              onClick={() => runCommand("simulate_reset", undefined, "Reset simulation")}
              disabled={busy !== null}
              className={btnSecondary}
            >
              Reset
            </button>
          </div>
          <p className="text-xs text-zinc-400">
            Inject artificial latency and packet loss to test alerting. Server-side only — doesn't affect actual network.
          </p>
        </div>

        <div className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
          <SectionHeader color="green" label="Client Config" description="pushed to agent" />
          <ConfigEditor
            key={`${client.config.ping_interval_s}-${client.config.speed_test_interval_s}-${client.config.alert_latency_threshold_ms}-${client.config.alert_loss_threshold_pct}-${client.config.grace_period_s}`}
            config={client.config}
            onSave={async (config) => {
              setBusy("update_config");
              try {
                await api.updateClient(clientId, { config });
                showToast("Config update pushed");
                refreshStatus();
                refreshClient();
              } catch (e) {
                showToast(`Failed: ${e instanceof Error ? e.message : "unknown"}`);
              } finally {
                setBusy(null);
              }
            }}
            busy={busy !== null}
          />
          <p className="text-xs text-zinc-400">
            Updates are pushed to the client immediately via WebSocket. No restart needed.
          </p>
        </div>
      </div>

      {/* Registration */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
        <h2 className="mb-3 text-sm font-medium text-zinc-400">Client Registration</h2>
        <RegisterInline />
      </div>
    </div>
  );
}

function ConfigEditor({
  config,
  onSave,
  busy,
}: {
  config: { ping_interval_s: number; speed_test_interval_s: number; alert_latency_threshold_ms: number; alert_loss_threshold_pct: number; grace_period_s: number; notifications_enabled: boolean };
  onSave: (c: Record<string, unknown>) => void;
  busy: boolean;
}) {
  const [interval, setInterval_] = useState(String(config.ping_interval_s));
  const [speedInterval, setSpeedInterval] = useState(String(config.speed_test_interval_s));
  const [latency, setLatency] = useState(String(config.alert_latency_threshold_ms));
  const [loss, setLoss] = useState(String(config.alert_loss_threshold_pct));
  const [grace, setGrace] = useState(String(config.grace_period_s));

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-zinc-400">Ping Interval (s)</label>
          <input type="number" min="5" value={interval} onChange={(e) => setInterval_(e.target.value)} className={INPUT_CLASS} />
        </div>
        <div>
          <label className="block text-xs text-zinc-400">Speed Test Interval (s)</label>
          <input type="number" min="60" value={speedInterval} onChange={(e) => setSpeedInterval(e.target.value)} className={INPUT_CLASS} />
        </div>
        <div>
          <label className="block text-xs text-zinc-400">Grace Period (s)</label>
          <input type="number" min="30" value={grace} onChange={(e) => setGrace(e.target.value)} className={INPUT_CLASS} />
        </div>
        <div>
          <label className="block text-xs text-zinc-400">Latency Threshold (ms)</label>
          <input type="number" min="1" value={latency} onChange={(e) => setLatency(e.target.value)} className={INPUT_CLASS} />
        </div>
        <div>
          <label className="block text-xs text-zinc-400">Loss Threshold (%)</label>
          <input type="number" min="0" max="100" value={loss} onChange={(e) => setLoss(e.target.value)} className={INPUT_CLASS} />
        </div>
      </div>
      <button
        onClick={() => onSave({
          ping_interval_s: parseInt(interval),
          speed_test_interval_s: parseInt(speedInterval),
          alert_latency_threshold_ms: parseFloat(latency),
          alert_loss_threshold_pct: parseFloat(loss),
          grace_period_s: parseInt(grace),
        })}
        disabled={busy}
        className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
      >
        Push Config
      </button>
    </div>
  );
}

function RegisterInline() {
  const [show, setShow] = useState(false);
  if (show) return <RegisterDialog onClose={() => setShow(false)} />;
  return (
    <div className="flex items-center gap-4">
      <button
        onClick={() => setShow(true)}
        className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-accent-hover)]"
      >
        Generate Registration Token
      </button>
      <span className="text-xs text-zinc-400">Creates a one-time token for a new client (expires in 15 min)</span>
    </div>
  );
}

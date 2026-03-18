import { useState } from "react";
import { useAlerts } from "@/lib/hooks";
import { api } from "@/lib/api";
import { AlertRow } from "@/components/AlertRow";

export function Alerts() {
  const { data: alerts, loading } = useAlerts(undefined, 100);
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

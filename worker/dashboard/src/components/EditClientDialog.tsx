import { useState } from "react";
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

  const handleSubmit = async (e: React.FormEvent) => {
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

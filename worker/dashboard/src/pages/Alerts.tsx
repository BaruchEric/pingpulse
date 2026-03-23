import { useState, useEffect, useRef } from "react";
import { useAlerts, useClients } from "@/lib/hooks";
import { api } from "@/lib/api";
import { AlertRow } from "@/components/AlertRow";
import type { AlertType } from "@/lib/types";

const ALERT_TYPES: { key: AlertType; label: string }[] = [
  { key: "client_down", label: "Client Down" },
  { key: "client_up", label: "Client Up" },
  { key: "high_latency", label: "High Latency" },
  { key: "packet_loss", label: "Packet Loss" },
  { key: "speed_degradation", label: "Speed Degradation" },
  { key: "latency_recovered", label: "Latency Recovered" },
];

const DEFAULT_SOUNDS: Record<AlertType, "default" | "silent"> = {
  client_down: "default",
  client_up: "silent",
  high_latency: "default",
  packet_loss: "default",
  speed_degradation: "silent",
  latency_recovered: "silent",
};

const DEFAULT_ENABLED: Record<AlertType, boolean> = {
  client_down: true,
  client_up: true,
  high_latency: true,
  packet_loss: true,
  speed_degradation: true,
  latency_recovered: true,
};

export function Alerts() {
  const { data: alerts, loading } = useAlerts(undefined, 100);
  const { data: clientsData } = useClients(0);
  const [latencyThreshold, setLatencyThreshold] = useState("");
  const [lossThreshold, setLossThreshold] = useState("");
  const [saving, setSaving] = useState(false);
  const [notifMsg, setNotifMsg] = useState("");
  const [reportSchedule, setReportSchedule] = useState<string>("daily");
  const [reportTelegram, setReportTelegram] = useState(true);
  const [reportEmail, setReportEmail] = useState(true);
  const [sounds, setSounds] = useState<Record<AlertType, "default" | "silent">>({ ...DEFAULT_SOUNDS });
  const [notifyEnabled, setNotifyEnabled] = useState<Record<AlertType, boolean>>({ ...DEFAULT_ENABLED });
  const [savingSounds, setSavingSounds] = useState(false);
  const notifTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Auto-clear notification messages
  useEffect(() => {
    if (!notifMsg) return;
    notifTimerRef.current = setTimeout(() => setNotifMsg(""), 2000);
    return () => clearTimeout(notifTimerRef.current);
  }, [notifMsg]);

  // Load sound + report config from first client
  useEffect(() => {
    const clients = clientsData?.clients;
    if (!clients?.length) return;
    const first = clients[0];
    if (!first) return;
    const cfg = first.config.telegram_notification_sound;
    if (cfg) setSounds({ ...DEFAULT_SOUNDS, ...cfg });
    const en = first.config.telegram_notification_enabled;
    if (en) setNotifyEnabled({ ...DEFAULT_ENABLED, ...en });
    if (first.config.report_schedule) setReportSchedule(first.config.report_schedule);
    const channels = first.config.report_channels;
    if (channels) {
      setReportTelegram(channels.includes("telegram"));
      setReportEmail(channels.includes("email"));
    }
  }, [clientsData]);

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

  const handleSaveSounds = async () => {
    const clients = clientsData?.clients;
    if (!clients?.length) return;
    setSavingSounds(true);
    try {
      await Promise.all(
        clients.map((c) =>
          api.updateClient(c.id, { config: { telegram_notification_sound: sounds, telegram_notification_enabled: notifyEnabled } })
        )
      );
      setNotifMsg("Notification sounds saved");
    } finally {
      setSavingSounds(false);
    }
  };

  const toggleSound = (key: AlertType) => {
    setSounds((prev) => ({
      ...prev,
      [key]: prev[key] === "default" ? "silent" : "default",
    }));
  };

  const [testingAlert, setTestingAlert] = useState(false);
  const handleTestAlert = async () => {
    setTestingAlert(true);
    try {
      await api.testAlert();
      setNotifMsg("Test alert sent");
    } catch {
      setNotifMsg("Failed to send test alert");
    } finally {
      setTestingAlert(false);
    }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Alerts</h1>

      {/* Threshold config */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
        <h2 className="mb-3 text-sm font-medium text-zinc-400">Default Alert Thresholds</h2>
        <div className="flex items-end gap-4">
          <div>
            <label className="block text-xs text-zinc-400">Latency (ms)</label>
            <input
              type="number"
              value={latencyThreshold}
              onChange={(e) => setLatencyThreshold(e.target.value)}
              placeholder="100"
              className="mt-1 w-32 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 font-mono placeholder:text-zinc-400 focus:border-[var(--color-accent)] focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-400">Packet Loss (%)</label>
            <input
              type="number"
              value={lossThreshold}
              onChange={(e) => setLossThreshold(e.target.value)}
              placeholder="5"
              className="mt-1 w-32 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 font-mono placeholder:text-zinc-400 focus:border-[var(--color-accent)] focus:outline-none"
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
            disabled={testingAlert}
            className="rounded-md border border-zinc-700 px-4 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
          >
            {testingAlert ? "Sending..." : "Send Test Alert"}
          </button>
        </div>
      </div>

      {/* Telegram notifications */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
        <h2 className="mb-1 text-sm font-medium text-zinc-400">Telegram Notifications</h2>
        <p className="mb-3 text-xs text-zinc-400">Control which alerts send and whether they play sound. Critical alerts always send regardless of mute.</p>
        <div className="flex items-center justify-end gap-1 px-3 pb-1">
          <span className="text-[10px] uppercase tracking-wider text-zinc-400 w-14 text-center">Sound</span>
          <span className="text-[10px] uppercase tracking-wider text-zinc-400 w-14 text-center">Notify</span>
        </div>
        <div className="space-y-2">
          {ALERT_TYPES.map(({ key, label }) => {
            const enabled = notifyEnabled[key];
            return (
              <div key={key} className={`flex items-center justify-between rounded-md border border-zinc-800 px-3 py-2 ${!enabled ? "opacity-50" : ""}`}>
                <span className="text-sm text-zinc-200">{label}</span>
                <div className="flex items-center gap-2">
                  {/* Sound toggle */}
                  <button
                    type="button"
                    disabled={!enabled}
                    onClick={() => toggleSound(key)}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                      sounds[key] === "default" && enabled ? "bg-[var(--color-accent)]" : "bg-zinc-700"
                    } ${!enabled ? "cursor-not-allowed" : ""}`}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                        sounds[key] === "default" ? "translate-x-4" : "translate-x-0.5"
                      }`}
                    />
                  </button>
                  {/* Notify toggle */}
                  <button
                    type="button"
                    onClick={() => setNotifyEnabled((prev) => ({ ...prev, [key]: !prev[key] }))}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                      enabled ? "bg-[var(--color-accent)]" : "bg-zinc-700"
                    }`}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                        enabled ? "translate-x-4" : "translate-x-0.5"
                      }`}
                    />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-3 flex items-center gap-3">
          <button
            onClick={handleSaveSounds}
            disabled={savingSounds}
            className="rounded-md bg-[var(--color-accent)] px-4 py-1.5 text-sm font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
          >
            {savingSounds ? "Saving..." : "Save Notification Settings"}
          </button>
          {notifMsg && <span className="text-xs text-zinc-400">{notifMsg}</span>}
        </div>
      </div>

      {/* Health Reports */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
        <h2 className="mb-3 text-sm font-medium text-zinc-400">Health Reports</h2>
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-zinc-400">Schedule</label>
            <select
              value={reportSchedule}
              onChange={(e) => setReportSchedule(e.target.value)}
              className="mt-1 w-full max-w-xs rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 focus:border-[var(--color-accent)] focus:outline-none"
            >
              <option value="daily">Daily</option>
              <option value="6h">Every 6 hours</option>
              <option value="weekly">Weekly</option>
              <option value="off">Off</option>
            </select>
          </div>
          <div className="flex gap-4">
            <label className="flex items-center gap-2 text-sm text-zinc-300">
              <input type="checkbox" checked={reportTelegram} onChange={(e) => setReportTelegram(e.target.checked)} className="rounded border-zinc-600" />
              Telegram
            </label>
            <label className="flex items-center gap-2 text-sm text-zinc-300">
              <input type="checkbox" checked={reportEmail} onChange={(e) => setReportEmail(e.target.checked)} className="rounded border-zinc-600" />
              Email
            </label>
          </div>
          <button
            onClick={async () => {
              const clients = clientsData?.clients;
              if (!clients?.length) return;
              setSaving(true);
              try {
                await Promise.all(
                  clients.map((c) =>
                    api.updateClient(c.id, {
                      config: {
                        report_schedule: reportSchedule as "daily" | "6h" | "weekly" | "off",
                        report_channels: [
                          ...(reportTelegram ? ["telegram" as const] : []),
                          ...(reportEmail ? ["email" as const] : []),
                        ],
                      },
                    })
                  )
                );
                setNotifMsg("Report settings saved");
              } finally {
                setSaving(false);
              }
            }}
            disabled={saving}
            className="rounded-md bg-[var(--color-accent)] px-4 py-1.5 text-sm font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save Report Settings"}
          </button>
        </div>
      </div>

      {/* Alert history */}
      <div className="space-y-2">
        <h2 className="text-sm font-medium text-zinc-400">Alert History</h2>
        {loading && !alerts ? (
          <div className="text-sm text-zinc-400">Loading...</div>
        ) : alerts && alerts.length > 0 ? (
          <div className="space-y-2">
            {alerts.map((alert) => (
              <AlertRow key={alert.id} alert={alert} />
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 text-center text-sm text-zinc-400">
            No alerts yet
          </div>
        )}
      </div>
    </div>
  );
}

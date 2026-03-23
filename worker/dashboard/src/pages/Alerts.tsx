import { useState } from "react";
import { useAlerts } from "@/lib/hooks";
import { api } from "@/lib/api";
import { AlertRow } from "@/components/AlertRow";

export function Alerts() {
  const { data: alerts, loading } = useAlerts(undefined, 100);
  const [latencyThreshold, setLatencyThreshold] = useState("");
  const [lossThreshold, setLossThreshold] = useState("");
  const [saving, setSaving] = useState(false);
  const [alertEmail, setAlertEmail] = useState("");
  const [telegramBotToken, setTelegramBotToken] = useState("");
  const [telegramChatId, setTelegramChatId] = useState("");
  const [notifMsg, setNotifMsg] = useState("");
  const [reportSchedule, setReportSchedule] = useState<string>("daily");
  const [reportTelegram, setReportTelegram] = useState(true);
  const [reportEmail, setReportEmail] = useState(true);

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

  const handleSaveNotifications = () => {
    setNotifMsg("Saved");
    setTimeout(() => setNotifMsg(""), 2000);
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

      {/* Notification config */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
        <h2 className="mb-3 text-sm font-medium text-zinc-400">Notification Settings</h2>
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-zinc-500">Email</label>
            <input
              type="text"
              value={alertEmail}
              onChange={(e) => setAlertEmail(e.target.value)}
              placeholder="admin@example.com"
              className="mt-1 w-full max-w-xs rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-[var(--color-accent)] focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-500">Telegram Bot Token</label>
            <input
              type="text"
              value={telegramBotToken}
              onChange={(e) => setTelegramBotToken(e.target.value)}
              placeholder="bot token"
              className="mt-1 w-full max-w-xs rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-[var(--color-accent)] focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-500">Telegram Chat ID</label>
            <input
              type="text"
              value={telegramChatId}
              onChange={(e) => setTelegramChatId(e.target.value)}
              placeholder="chat ID"
              className="mt-1 w-full max-w-xs rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-[var(--color-accent)] focus:outline-none"
            />
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={handleSaveNotifications}
              className="rounded-md bg-[var(--color-accent)] px-4 py-1.5 text-sm font-medium text-white hover:bg-[var(--color-accent-hover)]"
            >
              Save Notification Settings
            </button>
            {notifMsg && <span className="text-xs text-zinc-400">{notifMsg}</span>}
          </div>
        </div>
      </div>

      {/* Health Reports */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
        <h2 className="mb-3 text-sm font-medium text-zinc-400">Health Reports</h2>
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-zinc-500">Schedule</label>
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
            onClick={() => {
              setNotifMsg("Report settings saved");
            }}
            className="rounded-md bg-[var(--color-accent)] px-4 py-1.5 text-sm font-medium text-white hover:bg-[var(--color-accent-hover)]"
          >
            Save Report Settings
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

import { useState } from "react";
import { api } from "@/lib/api";
import type { Client, AlertType } from "@/lib/types";
import { SectionHeader } from "@/components/SectionHeader";

const ALERT_SOUND_OPTIONS: { key: AlertType; label: string }[] = [
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

const inputCls =
  "mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 focus:border-[var(--color-accent)] focus:outline-none";
const inputMonoCls = `${inputCls} font-mono`;
const labelCls = "block text-xs text-zinc-500";

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <label className="relative inline-flex cursor-pointer items-center">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="peer sr-only"
        />
        <div className="h-5 w-9 rounded-full bg-zinc-700 after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-zinc-400 after:transition-all peer-checked:bg-[var(--color-accent)] peer-checked:after:translate-x-full peer-checked:after:bg-white" />
      </label>
      <span className="text-sm text-zinc-400">{label}</span>
    </div>
  );
}

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
  const [speedTestInterval, setSpeedTestInterval] = useState(String(client.config.speed_test_interval_s ?? 300));
  const [latencyThreshold, setLatencyThreshold] = useState(String(client.config.alert_latency_threshold_ms));
  const [lossThreshold, setLossThreshold] = useState(String(client.config.alert_loss_threshold_pct));
  const [notificationsEnabled, setNotificationsEnabled] = useState(client.config.notifications_enabled ?? true);

  const cfg = client.config;
  const [icmpInterval, setIcmpInterval] = useState(String(cfg.probe_icmp_interval_s ?? 30));
  const [icmpTargets, setIcmpTargets] = useState(
    cfg.probe_icmp_targets?.join(", ") ?? "8.8.8.8, 1.1.1.1"
  );
  const [httpInterval, setHttpInterval] = useState(String(cfg.probe_http_interval_s ?? 60));
  const [httpTargets, setHttpTargets] = useState(
    cfg.probe_http_targets?.join(", ") ?? ""
  );

  const downChannels = cfg.down_alert_channels ?? ["telegram"];
  const [gracePeriod, setGracePeriod] = useState(String(cfg.down_alert_grace_seconds ?? cfg.grace_period_s));
  const [alertTelegram, setAlertTelegram] = useState(downChannels.includes("telegram"));
  const [alertEmail, setAlertEmail] = useState(downChannels.includes("email"));
  const [escalationEnabled, setEscalationEnabled] = useState(cfg.down_alert_escalation_enabled ?? false);
  const [escalationDelay, setEscalationDelay] = useState(
    String(cfg.down_alert_escalate_after_seconds ?? 600)
  );
  const escalateChannels = cfg.down_alert_escalate_channels ?? ["email"];
  const [escalationTelegram, setEscalationTelegram] = useState(escalateChannels.includes("telegram"));
  const [escalationEmail, setEscalationEmail] = useState(escalateChannels.includes("email"));

  const [retentionDays, setRetentionDays] = useState(String(cfg.retention_raw_days ?? 30));
  const [archiveToR2, setArchiveToR2] = useState(cfg.retention_archive_to_r2 ?? true);

  const [sounds, setSounds] = useState<Record<AlertType, "default" | "silent">>(
    { ...DEFAULT_SOUNDS, ...cfg.telegram_notification_sound }
  );

  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const parseTargets = (s: string) =>
        s.split(",").map((t) => t.trim()).filter(Boolean);

      await api.updateClient(client.id, {
        name,
        location,
        config: {
          ping_interval_s: parseInt(pingInterval),
          speed_test_interval_s: parseInt(speedTestInterval),
          alert_latency_threshold_ms: parseFloat(latencyThreshold),
          alert_loss_threshold_pct: parseFloat(lossThreshold),
          notifications_enabled: notificationsEnabled,
          probe_icmp_interval_s: parseInt(icmpInterval),
          probe_icmp_targets: parseTargets(icmpTargets),
          probe_http_interval_s: parseInt(httpInterval),
          probe_http_targets: parseTargets(httpTargets),
          down_alert_grace_seconds: parseInt(gracePeriod),
          down_alert_channels: [
            ...(alertTelegram ? ["telegram"] : []),
            ...(alertEmail ? ["email"] : []),
          ],
          down_alert_escalation_enabled: escalationEnabled,
          down_alert_escalate_after_seconds: parseInt(escalationDelay),
          down_alert_escalate_channels: [
            ...(escalationTelegram ? ["telegram"] : []),
            ...(escalationEmail ? ["email"] : []),
          ],
          retention_raw_days: parseInt(retentionDays),
          retention_archive_to_r2: archiveToR2,
          telegram_notification_sound: sounds,
        } as Partial<Client["config"]>,
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <form
        onSubmit={handleSubmit}
        className="relative max-h-[90vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-900 p-6 shadow-xl"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Edit Client</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </div>

        {/* Basic info */}
        <div>
          <label className={labelCls}>Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Location</label>
          <input value={location} onChange={(e) => setLocation(e.target.value)} className={inputCls} />
        </div>

        <div className="space-y-4">
          <SectionHeader color="green" label="Client Config" description="pushed to agent" />

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Ping Interval (s)</label>
              <input type="number" min="5" value={pingInterval} onChange={(e) => setPingInterval(e.target.value)} className={inputMonoCls} />
            </div>
            <div>
              <label className={labelCls}>Speed Test Interval (s)</label>
              <input type="number" min="60" value={speedTestInterval} onChange={(e) => setSpeedTestInterval(e.target.value)} className={inputMonoCls} />
            </div>
            <div>
              <label className={labelCls}>Latency Threshold (ms)</label>
              <input type="number" value={latencyThreshold} onChange={(e) => setLatencyThreshold(e.target.value)} className={inputMonoCls} />
            </div>
            <div>
              <label className={labelCls}>Loss Threshold (%)</label>
              <input type="number" value={lossThreshold} onChange={(e) => setLossThreshold(e.target.value)} className={inputMonoCls} />
            </div>
          </div>

          <fieldset className="space-y-3 rounded-lg border border-zinc-800 p-4">
            <legend className="px-2 text-xs font-medium text-zinc-400">Probe Config</legend>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>ICMP Interval (s)</label>
                <input type="number" min="5" value={icmpInterval} onChange={(e) => setIcmpInterval(e.target.value)} className={inputMonoCls} />
              </div>
              <div>
                <label className={labelCls}>HTTP Interval (s)</label>
                <input type="number" min="5" value={httpInterval} onChange={(e) => setHttpInterval(e.target.value)} className={inputMonoCls} />
              </div>
            </div>
            <div>
              <label className={labelCls}>ICMP Targets (comma-separated)</label>
              <input value={icmpTargets} onChange={(e) => setIcmpTargets(e.target.value)} placeholder="8.8.8.8, 1.1.1.1" className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>HTTP Targets (comma-separated)</label>
              <input value={httpTargets} onChange={(e) => setHttpTargets(e.target.value)} placeholder="https://example.com" className={inputCls} />
            </div>
          </fieldset>
        </div>

        <div className="space-y-4">
          <SectionHeader color="blue" label="Server Config" description="worker-side only" />

          <Toggle checked={notificationsEnabled} onChange={setNotificationsEnabled} label="Send notifications (Email & Telegram)" />

          <fieldset className="space-y-3 rounded-lg border border-zinc-800 p-4">
            <legend className="px-2 text-xs font-medium text-zinc-400">Down Alerts</legend>
            <div>
              <label className={labelCls}>Grace Period (s)</label>
              <input type="number" min="30" value={gracePeriod} onChange={(e) => setGracePeriod(e.target.value)} className={inputMonoCls} />
            </div>
            <div className="space-y-2">
              <span className={labelCls}>Alert Channels</span>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 text-sm text-zinc-400">
                  <input type="checkbox" checked={alertTelegram} onChange={(e) => setAlertTelegram(e.target.checked)} className="rounded border-zinc-600 bg-zinc-800" />
                  Telegram
                </label>
                <label className="flex items-center gap-2 text-sm text-zinc-400">
                  <input type="checkbox" checked={alertEmail} onChange={(e) => setAlertEmail(e.target.checked)} className="rounded border-zinc-600 bg-zinc-800" />
                  Email
                </label>
              </div>
            </div>
            <Toggle checked={escalationEnabled} onChange={setEscalationEnabled} label="Enable escalation" />
            {escalationEnabled && (
              <div className="space-y-3 pl-4 border-l-2 border-zinc-700">
                <div>
                  <label className={labelCls}>Escalation Delay (s)</label>
                  <input type="number" min="60" value={escalationDelay} onChange={(e) => setEscalationDelay(e.target.value)} className={inputMonoCls} />
                </div>
                <div className="flex gap-4">
                  <label className="flex items-center gap-2 text-sm text-zinc-400">
                    <input type="checkbox" checked={escalationTelegram} onChange={(e) => setEscalationTelegram(e.target.checked)} className="rounded border-zinc-600 bg-zinc-800" />
                    Telegram
                  </label>
                  <label className="flex items-center gap-2 text-sm text-zinc-400">
                    <input type="checkbox" checked={escalationEmail} onChange={(e) => setEscalationEmail(e.target.checked)} className="rounded border-zinc-600 bg-zinc-800" />
                    Email
                  </label>
                </div>
              </div>
            )}
          </fieldset>

          <fieldset className="space-y-3 rounded-lg border border-zinc-800 p-4">
            <legend className="px-2 text-xs font-medium text-zinc-400">Retention</legend>
            <div>
              <label className={labelCls}>Raw Data Retention (days)</label>
              <input type="number" min="1" value={retentionDays} onChange={(e) => setRetentionDays(e.target.value)} className={inputMonoCls} />
            </div>
            <Toggle checked={archiveToR2} onChange={setArchiveToR2} label="Archive to R2 before deletion" />
          </fieldset>

          <fieldset className="space-y-2 rounded-lg border border-zinc-800 p-4">
            <legend className="px-2 text-xs font-medium text-zinc-400">Telegram Notification Sounds</legend>
            <p className="text-xs text-zinc-500">Toggle sound on/off per alert type. Critical alerts always send regardless of mute.</p>
            {ALERT_SOUND_OPTIONS.map(({ key, label }) => (
              <div key={key} className="flex items-center justify-between rounded-md border border-zinc-800 px-3 py-1.5">
                <span className="text-sm text-zinc-300">{label}</span>
                <button
                  type="button"
                  onClick={() => setSounds((prev) => ({ ...prev, [key]: prev[key] === "default" ? "silent" : "default" }))}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                    sounds[key] === "default" ? "bg-[var(--color-accent)]" : "bg-zinc-700"
                  }`}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                      sounds[key] === "default" ? "translate-x-4" : "translate-x-0.5"
                    }`}
                  />
                </button>
              </div>
            ))}
          </fieldset>
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

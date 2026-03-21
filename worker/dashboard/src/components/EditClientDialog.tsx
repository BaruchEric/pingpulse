import { useState } from "react";
import { api } from "@/lib/api";
import type { Client } from "@/lib/types";

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

  // Probe config
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cfg = client.config as any;
  const [icmpInterval, setIcmpInterval] = useState(String(cfg.icmp_interval_s ?? 30));
  const [icmpTargets, setIcmpTargets] = useState(
    Array.isArray(cfg.icmp_targets) ? (cfg.icmp_targets as string[]).join(", ") : "8.8.8.8, 1.1.1.1"
  );
  const [httpInterval, setHttpInterval] = useState(String(cfg.http_interval_s ?? 60));
  const [httpTargets, setHttpTargets] = useState(
    Array.isArray(cfg.http_targets) ? (cfg.http_targets as string[]).join(", ") : ""
  );

  // Down alert config
  const [gracePeriod, setGracePeriod] = useState(String(client.config.grace_period_s));
  const [alertTelegram, setAlertTelegram] = useState(
    cfg.alert_channels_telegram !== false
  );
  const [alertEmail, setAlertEmail] = useState(
    (cfg.alert_channels_email as boolean | undefined) ?? false
  );
  const [escalationEnabled, setEscalationEnabled] = useState(
    (cfg.escalation_enabled as boolean | undefined) ?? false
  );
  const [escalationDelay, setEscalationDelay] = useState(
    String(cfg.escalation_delay_s ?? 300)
  );
  const [escalationTelegram, setEscalationTelegram] = useState(
    (cfg.escalation_telegram as boolean | undefined) ?? true
  );
  const [escalationEmail, setEscalationEmail] = useState(
    (cfg.escalation_email as boolean | undefined) ?? false
  );

  // Retention config
  const [retentionDays, setRetentionDays] = useState(String(cfg.retention_days ?? 90));
  const [archiveToR2, setArchiveToR2] = useState(
    (cfg.archive_to_r2 as boolean | undefined) ?? false
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
          // Probe config
          icmp_interval_s: parseInt(icmpInterval),
          icmp_targets: parseTargets(icmpTargets),
          http_interval_s: parseInt(httpInterval),
          http_targets: parseTargets(httpTargets),
          // Down alert config
          grace_period_s: parseInt(gracePeriod),
          alert_channels_telegram: alertTelegram,
          alert_channels_email: alertEmail,
          escalation_enabled: escalationEnabled,
          escalation_delay_s: parseInt(escalationDelay),
          escalation_telegram: escalationTelegram,
          escalation_email: escalationEmail,
          // Retention
          retention_days: parseInt(retentionDays),
          archive_to_r2: archiveToR2,
        } as Partial<Client["config"]>,
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
        className="max-h-[90vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-900 p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">Edit Client</h2>

        {/* Basic info */}
        <div>
          <label className={labelCls}>Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Location</label>
          <input value={location} onChange={(e) => setLocation(e.target.value)} className={inputCls} />
        </div>
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
        <Toggle checked={notificationsEnabled} onChange={setNotificationsEnabled} label="Send notifications (Email & Telegram)" />

        {/* Probe Config */}
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

        {/* Down Alerts */}
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

        {/* Retention */}
        <fieldset className="space-y-3 rounded-lg border border-zinc-800 p-4">
          <legend className="px-2 text-xs font-medium text-zinc-400">Retention</legend>
          <div>
            <label className={labelCls}>Raw Data Retention (days)</label>
            <input type="number" min="1" value={retentionDays} onChange={(e) => setRetentionDays(e.target.value)} className={inputMonoCls} />
          </div>
          <Toggle checked={archiveToR2} onChange={setArchiveToR2} label="Archive to R2 before deletion" />
        </fieldset>

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

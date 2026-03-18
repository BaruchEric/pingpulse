import { useState } from "react";
import { useClients } from "@/lib/hooks";
import { api } from "@/lib/api";

export function Settings() {
  const { data: clients } = useClients();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordMsg, setPasswordMsg] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);
  const [exportFrom, setExportFrom] = useState("");
  const [exportTo, setExportTo] = useState("");

  const handlePasswordChange = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingPassword(true);
    setPasswordMsg("");
    try {
      await api.changePassword(currentPassword, newPassword);
      setPasswordMsg("Password updated");
      setCurrentPassword("");
      setNewPassword("");
    } catch {
      setPasswordMsg("Failed to update password");
    } finally {
      setSavingPassword(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-8">
      <h1 className="text-xl font-semibold">Settings</h1>

      {/* Change Password */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-zinc-400">Account</h2>
        <form onSubmit={handlePasswordChange} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 space-y-3">
          <div>
            <label className="block text-xs text-zinc-500">Current Password</label>
            <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)}
              className="mt-1 w-full max-w-xs rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 focus:border-[var(--color-accent)] focus:outline-none" />
          </div>
          <div>
            <label className="block text-xs text-zinc-500">New Password</label>
            <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
              className="mt-1 w-full max-w-xs rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 focus:border-[var(--color-accent)] focus:outline-none" />
          </div>
          <div className="flex items-center gap-3">
            <button type="submit" disabled={savingPassword || !currentPassword || !newPassword}
              className="rounded-md bg-[var(--color-accent)] px-4 py-1.5 text-sm font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
              {savingPassword ? "Updating..." : "Change Password"}
            </button>
            {passwordMsg && <span className="text-xs text-zinc-400">{passwordMsg}</span>}
          </div>
        </form>
      </section>

      {/* Data Retention */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-zinc-400">Data Retention</h2>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 space-y-2 text-sm text-zinc-400">
          <div className="flex justify-between">
            <span>D1 (ping results, speed tests)</span>
            <span className="font-mono text-zinc-300">30 days</span>
          </div>
          <div className="flex justify-between">
            <span>Analytics Engine (time-series metrics)</span>
            <span className="font-mono text-zinc-300">90 days</span>
          </div>
          <div className="flex justify-between">
            <span>R2 Archive (gzipped exports)</span>
            <span className="font-mono text-zinc-300">Unlimited</span>
          </div>
          <p className="pt-2 text-xs text-zinc-600">
            Retention periods are managed by the cron job. Adjust in Worker configuration.
          </p>
        </div>
      </section>

      {/* Export */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-zinc-400">Export Data</h2>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 space-y-3">
          <div className="flex items-end gap-4">
            <div>
              <label className="block text-xs text-zinc-500">From</label>
              <input
                type="date"
                value={exportFrom}
                onChange={(e) => setExportFrom(e.target.value)}
                className="mt-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 focus:border-[var(--color-accent)] focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-500">To</label>
              <input
                type="date"
                value={exportTo}
                onChange={(e) => setExportTo(e.target.value)}
                className="mt-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 focus:border-[var(--color-accent)] focus:outline-none"
              />
            </div>
          </div>
          {clients && clients.length > 0 ? (
            clients.map((client) => (
              <div key={client.id} className="flex items-center justify-between">
                <span className="text-sm">{client.name}</span>
                <div className="flex gap-2">
                  <a href={api.exportData(client.id, "json", exportFrom || undefined, exportTo || undefined)}
                    className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800" download>
                    JSON
                  </a>
                  <a href={api.exportData(client.id, "csv", exportFrom || undefined, exportTo || undefined)}
                    className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800" download>
                    CSV
                  </a>
                </div>
              </div>
            ))
          ) : (
            <p className="text-sm text-zinc-500">No clients to export</p>
          )}
        </div>
      </section>

      {/* About */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-zinc-400">About</h2>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 text-sm text-zinc-400">
          <p>PingPulse — Bidirectional network monitoring</p>
          <p className="mt-1 font-mono text-xs text-zinc-600">Dashboard served from Cloudflare Workers</p>
        </div>
      </section>
    </div>
  );
}

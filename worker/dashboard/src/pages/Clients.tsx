import { useState } from "react";
import { Link } from "react-router";
import { useClients } from "@/lib/hooks";
import { api } from "@/lib/api";
import type { Client } from "@/lib/types";
import { StatusBadge } from "@/components/StatusBadge";
import { RegisterDialog } from "@/components/RegisterDialog";
import { EditClientDialog } from "@/components/EditClientDialog";
import { LocalClientPanel } from "@/components/LocalClientPanel";

export function Clients() {
  const { data: clients, refresh } = useClients(10_000);
  const [showRegister, setShowRegister] = useState(false);
  const [editingClient, setEditingClient] = useState<Client | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const handleBulkSpeedTest = async () => {
    if (!clients) return;
    await Promise.allSettled(clients.map((c) => api.triggerSpeedTest(c.id)));
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete client "${name}"? This removes all its data.`)) return;
    setDeleting(id);
    try {
      await api.deleteClient(id);
      refresh();
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-xl font-semibold">Client Management</h1>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={handleBulkSpeedTest}
            className="rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
          >
            Speed Test All
          </button>
          <button
            onClick={() => setShowRegister(true)}
            className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-accent-hover)]"
          >
            Register Client
          </button>
        </div>
      </div>

      <LocalClientPanel onUninstalled={refresh} />

      {clients && clients.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900/80 text-left text-xs text-zinc-500">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Location</th>
                <th className="px-4 py-3">Version</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Ping Interval</th>
                <th className="px-4 py-3">Last Seen</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {clients.map((client) => (
                <tr key={client.id} className="hover:bg-zinc-900/50">
                  <td className="px-4 py-3">
                    <Link to={`/client/${client.id}`} className="font-medium hover:text-[var(--color-accent)]">
                      {client.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-zinc-400">{client.location}</td>
                  <td className="px-4 py-3 font-mono text-zinc-400">{client.client_version || "—"}</td>
                  <td className="px-4 py-3">
                    <StatusBadge lastSeen={client.last_seen} />
                  </td>
                  <td className="px-4 py-3 font-mono text-zinc-400">{client.config.ping_interval_s}s</td>
                  <td className="px-4 py-3 font-mono text-xs text-zinc-500">
                    {new Date(client.last_seen).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right space-x-3">
                    <button
                      onClick={() => setEditingClient(client)}
                      className="text-xs text-zinc-400 hover:text-zinc-200"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleDelete(client.id, client.name)}
                      disabled={deleting === client.id}
                      className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50"
                    >
                      {deleting === client.id ? "Deleting..." : "Delete"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-8 text-center text-zinc-400">
          No clients registered yet.
        </div>
      )}

      {showRegister && <RegisterDialog onClose={() => { setShowRegister(false); refresh(); }} />}
      {editingClient && <EditClientDialog client={editingClient} onClose={() => { setEditingClient(null); refresh(); }} />}
    </div>
  );
}

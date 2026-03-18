import { useClients } from "@/lib/hooks";
import { ClientCard } from "@/components/ClientCard";
import { StatsBar } from "@/components/StatsBar";

export function Overview() {
  const { data: clients, loading, error } = useClients(10_000);

  if (loading && !clients) {
    return <div className="text-sm text-zinc-400">Loading clients...</div>;
  }

  if (error) {
    return <div className="text-sm text-red-400">Failed to load clients: {error.message}</div>;
  }

  if (!clients || clients.length === 0) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">Overview</h1>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-8 text-center">
          <p className="text-zinc-400">No clients registered yet.</p>
          <p className="mt-1 text-sm text-zinc-500">
            Go to <a href="/clients" className="text-[var(--color-accent)] hover:underline">Client Management</a> to register your first client.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Overview</h1>
      </div>

      <StatsBar clients={clients} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {clients.map((client) => (
          <ClientCard key={client.id} client={client} />
        ))}
      </div>
    </div>
  );
}

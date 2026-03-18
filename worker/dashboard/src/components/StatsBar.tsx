import type { Client } from "@/lib/types";
import { THRESHOLD_STALE_MS } from "@/components/StatusBadge";

export function StatsBar({ clients }: { clients: Client[] }) {
  const total = clients.length;
  const now = Date.now();
  const up = clients.filter((c) => now - new Date(c.last_seen).getTime() < THRESHOLD_STALE_MS).length;
  const down = total - up;

  return (
    <div className="flex gap-6 rounded-lg border border-zinc-800 bg-zinc-900/50 px-6 py-3">
      <Stat label="Total Clients" value={total} />
      <Stat label="Up" value={up} className="text-emerald-400" />
      <Stat label="Down" value={down} className={down > 0 ? "text-red-400" : "text-zinc-400"} />
    </div>
  );
}

function Stat({ label, value, className = "" }: { label: string; value: number; className?: string }) {
  return (
    <div className="text-center">
      <div className={`text-2xl font-bold font-mono ${className}`}>{value}</div>
      <div className="text-xs text-zinc-500">{label}</div>
    </div>
  );
}

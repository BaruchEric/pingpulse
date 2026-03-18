import type { Client } from "@/lib/types";
import { getClientStatus } from "@/components/StatusBadge";

export function StatsBar({ clients }: { clients: Client[] }) {
  const total = clients.length;
  const up = clients.filter(
    (c) => getClientStatus(c.last_seen, c.config.grace_period_s * 1000) === "up"
  ).length;
  const down = total - up;

  const rtts = clients
    .map((c) => c.stats?.avg_rtt_ms)
    .filter((v): v is number => v != null);
  const avgLatency = rtts.length > 0
    ? (rtts.reduce((a, b) => a + b, 0) / rtts.length).toFixed(1)
    : "—";

  return (
    <div className="flex gap-6 rounded-lg border border-zinc-800 bg-zinc-900/50 px-6 py-3">
      <Stat label="Total Clients" value={total} />
      <Stat label="Up" value={up} className="text-emerald-400" />
      <Stat label="Down" value={down} className={down > 0 ? "text-red-400" : "text-zinc-400"} />
      <Stat label="Avg Latency" value={`${avgLatency}ms`} />
    </div>
  );
}

function Stat({ label, value, className = "" }: { label: string; value: number | string; className?: string }) {
  return (
    <div className="text-center">
      <div className={`text-2xl font-bold font-mono ${className}`}>{value}</div>
      <div className="text-xs text-zinc-500">{label}</div>
    </div>
  );
}

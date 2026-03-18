import { Link } from "react-router";
import type { Client } from "@/lib/types";
import { StatusBadge } from "@/components/StatusBadge";
import { Sparkline } from "@/components/Sparkline";

export function ClientCard({
  client,
  latencyHistory,
}: {
  client: Client;
  latencyHistory?: number[];
}) {
  const timeSince = formatTimeSince(client.last_seen);

  return (
    <Link
      to={`/client/${client.id}`}
      className="flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 transition-colors hover:border-zinc-700 hover:bg-zinc-900"
    >
      <div className="flex items-start justify-between">
        <div>
          <h3 className="font-medium">{client.name}</h3>
          <p className="text-xs text-zinc-500">{client.location}</p>
        </div>
        <StatusBadge
          lastSeen={client.last_seen}
          gracePeriodMs={client.config.grace_period_s * 1000}
          thresholdMs={client.config.alert_latency_threshold_ms}
        />
      </div>

      <div className="flex items-end justify-between">
        <div className="space-y-1">
          <div className="text-xs text-zinc-500">
            Ping: <span className="font-mono text-zinc-300">{client.config.ping_interval_s}s</span>
          </div>
          <div className="text-xs text-zinc-500">
            Last seen: <span className="font-mono text-zinc-300">{timeSince}</span>
          </div>
        </div>
        {latencyHistory && latencyHistory.length > 1 && (
          <Sparkline data={latencyHistory} />
        )}
      </div>
    </Link>
  );
}

function formatTimeSince(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

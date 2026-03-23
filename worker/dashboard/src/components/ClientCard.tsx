import { Link } from "react-router";
import type { Client } from "@/lib/types";
import { StatusBadge } from "@/components/StatusBadge";
import { Sparkline } from "@/components/Sparkline";
import { formatTimeSince } from "@/lib/format";

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
          <p className="text-xs text-zinc-500">
            {client.location}
            {client.client_version && <span className="ml-2 text-zinc-600">v{client.client_version}</span>}
          </p>
        </div>
        <StatusBadge
          lastSeen={client.last_seen}
          pingIntervalMs={client.config.ping_interval_s * 1000}
          thresholdMs={client.config.alert_latency_threshold_ms}
        />
      </div>

      {/* Stats row */}
      {client.stats && (
        <div className="flex gap-4 text-xs">
          <div className="text-zinc-500">
            RTT: <span className="font-mono text-zinc-300">
              {client.stats.avg_rtt_ms != null ? `${client.stats.avg_rtt_ms.toFixed(1)}ms` : "—"}
            </span>
          </div>
          <div className="text-zinc-500">
            Loss: <span className="font-mono text-zinc-300">
              {client.stats.loss_pct != null ? `${client.stats.loss_pct.toFixed(1)}%` : "—"}
            </span>
          </div>
          {client.stats.last_speed_test && (
            <div className="text-zinc-500">
              DL: <span className="font-mono text-zinc-300">
                {client.stats.last_speed_test.download_mbps.toFixed(0)} Mbps
              </span>
            </div>
          )}
        </div>
      )}

      <div className="flex items-end justify-between">
        <div className="text-xs text-zinc-500">
          Last seen: <span className="font-mono text-zinc-300">{timeSince}</span>
        </div>
        {latencyHistory && latencyHistory.length > 1 && (
          <Sparkline data={latencyHistory} />
        )}
      </div>
    </Link>
  );
}

import { useState } from "react";
import { useParams, Link } from "react-router";
import { useClient, useMetrics, useAlerts, getTimeRange, type TimeRange } from "@/lib/hooks";
import { api } from "@/lib/api";
import { StatusBadge } from "@/components/StatusBadge";
import { TimeRangeSelector } from "@/components/TimeRangeSelector";
import { LatencyChart } from "@/components/LatencyChart";
import { ThroughputChart } from "@/components/ThroughputChart";
import { OutageTimeline } from "@/components/OutageTimeline";
import { AlertRow } from "@/components/AlertRow";

export function ClientDetail() {
  const { id } = useParams<{ id: string }>();
  const [range, setRange] = useState<TimeRange>("24h");

  const { data: client, loading: clientLoading } = useClient(id!);
  const { data: metrics, loading: metricsLoading } = useMetrics(id!, range);
  const { data: alerts } = useAlerts(id, 10);

  if (clientLoading && !client) {
    return <div className="text-sm text-zinc-400">Loading...</div>;
  }

  if (!client) {
    return <div className="text-sm text-red-400">Client not found</div>;
  }

  const handleSpeedTest = async () => {
    try {
      await api.triggerSpeedTest(id!);
    } catch {
      // ignore
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link to="/" className="text-zinc-500 hover:text-zinc-300">&larr;</Link>
          <div>
            <h1 className="text-xl font-semibold">{client.name}</h1>
            <p className="text-sm text-zinc-500">{client.location}</p>
          </div>
          <StatusBadge
            lastSeen={client.last_seen}
            gracePeriodMs={client.config.grace_period_s * 1000}
            thresholdMs={client.config.alert_latency_threshold_ms}
          />
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleSpeedTest}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800"
          >
            Run Speed Test
          </button>
          <TimeRangeSelector value={range} onChange={setRange} />
        </div>
      </div>

      {/* Summary stats */}
      {metrics && (
        <div className="grid grid-cols-5 gap-4">
          {[
            ["Avg RTT", `${metrics.summary.avg_rtt_ms.toFixed(1)}ms`],
            ["P95 RTT", `${metrics.summary.p95_rtt_ms.toFixed(1)}ms`],
            ["Packet Loss", `${metrics.summary.loss_pct.toFixed(1)}%`],
            ["Pings", `${metrics.summary.ok_pings}/${metrics.summary.total_pings}`],
            ["Outages", `${metrics.outages.length}`],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 text-center">
              <div className="text-lg font-bold font-mono">{value}</div>
              <div className="text-xs text-zinc-500">{label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Latency chart */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
        <h2 className="mb-3 text-sm font-medium text-zinc-400">Latency & Jitter</h2>
        {metricsLoading && !metrics ? (
          <div className="flex h-[280px] items-center justify-center text-sm text-zinc-500">Loading...</div>
        ) : (
          <LatencyChart pings={metrics?.pings || []} />
        )}
      </div>

      {/* Throughput chart */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
        <h2 className="mb-3 text-sm font-medium text-zinc-400">Throughput</h2>
        <ThroughputChart tests={metrics?.speed_tests || []} />
      </div>

      {/* Speed test history table */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
        <h2 className="mb-3 text-sm font-medium text-zinc-400">Speed Test History</h2>
        {metrics?.speed_tests && metrics.speed_tests.length > 0 ? (
          <table className="w-full">
            <thead className="bg-zinc-900/80">
              <tr>
                {["Date/Time", "Type", "Download (Mbps)", "Upload (Mbps)", "Duration (ms)"].map((h) => (
                  <th key={h} className="px-3 py-2 text-left text-xs text-zinc-500 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {metrics.speed_tests.map((st, i) => (
                <tr key={i} className="hover:bg-zinc-800/30">
                  <td className="px-3 py-2 text-sm text-zinc-300 font-mono">{new Date(st.timestamp).toLocaleString()}</td>
                  <td className="px-3 py-2 text-sm text-zinc-400">{st.type}</td>
                  <td className="px-3 py-2 text-sm text-zinc-300 font-mono">{st.download_mbps.toFixed(1)}</td>
                  <td className="px-3 py-2 text-sm text-zinc-300 font-mono">{st.upload_mbps.toFixed(1)}</td>
                  <td className="px-3 py-2 text-sm text-zinc-300 font-mono">{st.duration_ms}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-zinc-500">No speed tests recorded</p>
        )}
      </div>

      {/* Outage timeline */}
      {metrics && metrics.outages.length > 0 && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
          <OutageTimeline outages={metrics.outages} {...getTimeRange(range)} />
        </div>
      )}

      {/* Recent alerts */}
      {alerts && alerts.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-zinc-400">Recent Alerts</h2>
          <div className="space-y-2">
            {alerts.map((alert) => (
              <AlertRow key={alert.id} alert={alert} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

import { useState, useEffect, useRef } from "react";
import { useParams, Link } from "react-router";
import { useClient, useMetrics, useAlerts, getTimeRange, type TimeRange } from "@/lib/hooks";
import { api } from "@/lib/api";
import { StatusBadge } from "@/components/StatusBadge";
import { SyncStatusBadge } from "@/components/SyncStatusBadge";
import { TimeRangeSelector } from "@/components/TimeRangeSelector";
import { LatencyChart } from "@/components/LatencyChart";
import { ThroughputChart } from "@/components/ThroughputChart";
import { WanQualityChart } from "@/components/WanQualityChart";
import { OutageTimeline } from "@/components/OutageTimeline";
import { AlertRow } from "@/components/AlertRow";

export function ClientDetail() {
  const { id } = useParams<{ id: string }>();
  const [range, setRange] = useState<TimeRange>("24h");

  const [speedTestRunning, setSpeedTestRunning] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const baseCountRef = useRef<number>(0);
  const clientId = id ?? "";
  const { data: client, loading: clientLoading } = useClient(clientId);
  const { data: metrics, loading: metricsLoading, refresh: refreshMetrics } = useMetrics(clientId, range);
  const { data: alerts } = useAlerts(id, 10);

  const stopPolling = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    setSpeedTestRunning(false);
  };

  // Stop polling when new speed test results arrive
  useEffect(() => {
    if (speedTestRunning && (metrics?.speed_tests?.length ?? 0) > baseCountRef.current) {
      stopPolling();
    }
  }, [metrics?.speed_tests?.length, speedTestRunning]);

  // Cleanup on unmount
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  if (clientLoading && !client) {
    return <div className="text-sm text-zinc-400">Loading...</div>;
  }

  if (!client) {
    return <div className="text-sm text-red-400">Client not found</div>;
  }

  const handleSpeedTest = async () => {
    if (speedTestRunning) return;
    try {
      baseCountRef.current = metrics?.speed_tests?.length ?? 0;
      setSpeedTestRunning(true);
      await api.triggerSpeedTest(clientId);
      // Poll every 3s for up to 60s waiting for results
      let attempts = 0;
      pollRef.current = setInterval(() => {
        attempts++;
        refreshMetrics();
        if (attempts >= 20) stopPolling();
      }, 3_000);
    } catch {
      setSpeedTestRunning(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <Link to="/" className="text-zinc-500 hover:text-zinc-300">&larr;</Link>
          <div>
            <h1 className="text-xl font-semibold">{client.name}</h1>
            <p className="text-sm text-zinc-500">
              {client.location}
              {client.client_version && <span className="ml-2 text-zinc-600">v{client.client_version}</span>}
            </p>
          </div>
          <StatusBadge
            lastSeen={client.last_seen}
            gracePeriodMs={client.config.grace_period_s * 1000}
            thresholdMs={client.config.alert_latency_threshold_ms}
          />
          <SyncStatusBadge clientId={clientId} />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Link
            to={`/client/${id}/control`}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800"
          >
            Control Panel
          </Link>
          <button
            onClick={handleSpeedTest}
            disabled={speedTestRunning}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {speedTestRunning ? "Running..." : "Run Speed Test"}
          </button>
          <TimeRangeSelector value={range} onChange={setRange} />
        </div>
      </div>

      {/* Summary stats */}
      {metrics && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6 lg:gap-4">
          {[
            { label: "Avg RTT", value: `${metrics.summary.avg_rtt_ms.toFixed(1)}ms` },
            { label: "P95 RTT", value: `${metrics.summary.p95_rtt_ms.toFixed(1)}ms` },
            { label: "Packet Loss", value: `${metrics.summary.loss_pct.toFixed(1)}%` },
            { label: "Pings", value: `${metrics.summary.ok_pings}/${metrics.summary.total_pings}` },
            {
              label: "Timeouts",
              value: `${metrics.summary.timeout_pings}`,
              highlight: metrics.summary.timeout_pings > 0,
            },
            { label: "Outages", value: `${metrics.outages.length}` },
          ].map(({ label, value, highlight }) => (
            <div
              key={label}
              className={`rounded-lg border p-3 text-center ${
                highlight
                  ? "border-red-700 bg-red-950/30"
                  : "border-zinc-800 bg-zinc-900/50"
              }`}
            >
              <div className={`text-lg font-bold font-mono ${highlight ? "text-red-400" : ""}`}>{value}</div>
              <div className={`text-xs ${highlight ? "font-semibold text-red-400/70" : "text-zinc-500"}`}>{label}</div>
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

      {/* WAN Quality chart */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
        <WanQualityChart clientId={clientId} {...getTimeRange(range)} />
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
          <div className="overflow-x-auto">
          <table className="w-full min-w-[600px]">
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
          </div>
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

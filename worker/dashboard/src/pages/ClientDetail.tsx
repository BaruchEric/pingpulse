import { useState, useEffect, useRef } from "react";
import { useParams, Link } from "react-router";
import { useClient, useMetrics, useAlerts, useLogs, useAnalysis, getTimeRange, type TimeRange } from "@/lib/hooks";
import { api } from "@/lib/api";
import { StatusBadge } from "@/components/StatusBadge";
import { SyncStatusBadge } from "@/components/SyncStatusBadge";
import { TimeRangeSelector } from "@/components/TimeRangeSelector";
import { LatencyChart } from "@/components/LatencyChart";
import { ThroughputChart } from "@/components/ThroughputChart";
import { WanQualityChart } from "@/components/WanQualityChart";
import { ConnectionStateChart } from "@/components/ConnectionStateChart";
import { OutageTimeline } from "@/components/OutageTimeline";
import { AlertRow } from "@/components/AlertRow";
import { LogsChart } from "@/components/LogsChart";
import { AnalysisSummaryCard } from "@/components/AnalysisSummaryCard";
import { ProbeStatsTable } from "@/components/ProbeStatsTable";
import { HourlyHeatmap } from "@/components/HourlyHeatmap";
import { DirectionAsymmetry } from "@/components/DirectionAsymmetry";
import { AlertStormSummary } from "@/components/AlertStormSummary";
import { SpeedTestStats } from "@/components/SpeedTestStats";
import { ReportModal } from "@/components/ReportModal";
import { FullAnalysisReport } from "@/components/FullAnalysisReport";

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
  const [tab, setTab] = useState<"overview" | "analysis">(
    window.location.hash === "#analysis" ? "analysis" : "overview"
  );
  const { data: analysis, loading: analysisLoading, refresh: refreshAnalysis } = useAnalysis(clientId, range, tab === "analysis");
  const [showReportModal, setShowReportModal] = useState(false);

  // Ping logs
  const LOGS_PER_PAGE = 50;
  const [logsPage, setLogsPage] = useState(0);
  const { data: logsData, loading: logsLoading } = useLogs(clientId, logsPage, LOGS_PER_PAGE);
  const logs = logsData?.logs ?? [];
  const logsTotal = logsData?.total ?? 0;

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
            pingIntervalMs={client.config.ping_interval_s * 1000}
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

      {/* Tab bar */}
      <div className="flex gap-1 rounded-lg bg-zinc-900/50 border border-zinc-800 p-1">
        <button
          onClick={() => { setTab("overview"); window.location.hash = ""; }}
          className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${tab === "overview" ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}
        >
          Overview
        </button>
        <button
          onClick={() => { setTab("analysis"); window.location.hash = "analysis"; }}
          className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${tab === "analysis" ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}
        >
          Analysis
        </button>
      </div>

      {tab === "overview" && (
        <>

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

      {/* Connection State chart */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
        <ConnectionStateChart
          pings={metrics?.pings || []}
          outages={metrics?.outages || []}
        />
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

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium text-zinc-400">Server Logs</h2>
          <span className="text-xs text-zinc-500">{logsTotal.toLocaleString()} total</span>
        </div>
        <LogsChart logs={logs} />
        {logsLoading && logs.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-sm text-zinc-500">Loading...</div>
        ) : logs.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-sm text-zinc-500">No logs</div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[600px]">
                <thead className="bg-zinc-900/80">
                  <tr>
                    {["Timestamp", "Direction", "Status", "RTT (ms)", "Jitter (ms)"].map((h) => (
                      <th key={h} className="px-3 py-2 text-left text-xs text-zinc-500 font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {logs.map((log, i) => (
                    <tr key={i} className="hover:bg-zinc-800/30">
                      <td className="px-3 py-1.5 text-sm text-zinc-300 font-mono">
                        {new Date(log.timestamp).toLocaleString()}
                      </td>
                      <td className="px-3 py-1.5 text-sm text-zinc-400">
                        {log.direction === "cf_to_client" ? "CF → Client" : "Client → CF"}
                      </td>
                      <td className="px-3 py-1.5 text-sm">
                        <span className={
                          log.status === "ok" ? "text-emerald-400" :
                          log.status === "timeout" ? "text-amber-400" : "text-red-400"
                        }>
                          {log.status}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-sm text-zinc-300 font-mono">
                        {log.status === "ok" ? log.rtt_ms.toFixed(1) : "—"}
                      </td>
                      <td className="px-3 py-1.5 text-sm text-zinc-300 font-mono">
                        {log.status === "ok" ? log.jitter_ms.toFixed(1) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {logsTotal > LOGS_PER_PAGE && (
              <div className="mt-3 flex items-center justify-between">
                <button
                  onClick={() => setLogsPage((p) => Math.max(0, p - 1))}
                  disabled={logsPage === 0}
                  className="rounded px-3 py-1 text-xs font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Prev
                </button>
                <span className="text-xs text-zinc-500">
                  Page {logsPage + 1} of {Math.ceil(logsTotal / LOGS_PER_PAGE)}
                </span>
                <button
                  onClick={() => setLogsPage((p) => p + 1)}
                  disabled={(logsPage + 1) * LOGS_PER_PAGE >= logsTotal}
                  className="rounded px-3 py-1 text-xs font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Next
                </button>
              </div>
            )}
          </>
        )}
      </div>
        </>
      )}

      {tab === "analysis" && (
        <div className="space-y-6 print:space-y-4" id="analysis-content">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-zinc-400">Deep Analysis</h2>
            <div className="flex gap-2 print:hidden">
              <button onClick={refreshAnalysis} className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700">Refresh</button>
              <button onClick={() => setShowReportModal(true)} className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--color-accent-hover)]">Generate Report</button>
              <button onClick={() => {
                if (!analysis) return;
                const blob = new Blob([JSON.stringify(analysis, null, 2)], { type: "application/json" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `analysis-${clientId}-${new Date().toISOString().slice(0, 10)}.json`;
                a.click();
                URL.revokeObjectURL(url);
              }} className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700">Export JSON</button>
              <button onClick={() => window.print()} className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700">Print</button>
            </div>
          </div>

          {analysisLoading && !analysis ? (
            <div className="text-sm text-zinc-500">Loading analysis...</div>
          ) : analysis ? (
            <>
              <AnalysisSummaryCard data={analysis} />
              <FullAnalysisReport data={analysis} client={client} />

              <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
                <h3 className="mb-3 text-sm font-medium text-zinc-400">Direction Asymmetry</h3>
                <DirectionAsymmetry data={analysis.direction_asymmetry} />
              </div>

              <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
                <h3 className="mb-3 text-sm font-medium text-zinc-400">Hourly Pattern</h3>
                <HourlyHeatmap pattern={analysis.hourly_pattern} />
              </div>

              <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
                <h3 className="mb-3 text-sm font-medium text-zinc-400">Probe Statistics</h3>
                <ProbeStatsTable stats={analysis.probe_stats} />
              </div>

              <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
                <h3 className="mb-3 text-sm font-medium text-zinc-400">Speed Test Statistics</h3>
                <SpeedTestStats stats={analysis.speed_test_stats} />
              </div>

              <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
                <h3 className="mb-3 text-sm font-medium text-zinc-400">Alert Summary</h3>
                <AlertStormSummary summary={analysis.alert_summary} />
              </div>
            </>
          ) : (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 text-center text-sm text-zinc-500">
              Failed to load analysis data
              <button onClick={refreshAnalysis} className="ml-2 text-[var(--color-accent)] hover:underline">Retry</button>
            </div>
          )}

          {showReportModal && <ReportModal clientId={clientId} onClose={() => setShowReportModal(false)} />}
        </div>
      )}

      <style>{`
        @media print {
          nav, .print\\:hidden, .fixed { display: none !important; }
          body { background: white !important; color: black !important; -webkit-print-color-adjust: exact; }
          #analysis-content { color: #111 !important; }
          #analysis-content * { border-color: #ddd !important; color: #222 !important; }
          #analysis-content h3 { color: #000 !important; font-weight: 600 !important; }
          #analysis-content .bg-amber-950\\/20, #analysis-content .bg-zinc-900\\/50 {
            background: #f5f5f5 !important;
          }
          #analysis-content table { font-size: 11px !important; }
        }
      `}</style>
    </div>
  );
}

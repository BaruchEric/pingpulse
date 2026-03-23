import type { AnalysisResponse } from "@/lib/types";
import type { PageId } from "@/components/FullAnalysisReport";

export function AnalysisSummaryCard({
  data,
  onNavigate,
}: {
  data: AnalysisResponse;
  onNavigate?: (page: PageId) => void;
}) {
  const cfTo = data.ping_stats.find((p) => p.direction === "cf_to_client" && p.status === "ok");
  const toCf = data.ping_stats.find((p) => p.direction === "client_to_cf" && p.status === "ok");
  const totalProbes = data.record_counts.probe_results;
  const totalErrors = data.recent_errors.length;
  const errorRate = totalProbes > 0 ? ((totalErrors / totalProbes) * 100).toFixed(2) : "0.00";
  const totalAlerts = data.alert_summary.reduce((sum, a) => sum + a.count, 0);

  const cards: { label: string; value: string; highlight?: boolean; navigateTo?: PageId }[] = [
    { label: "Pings", value: data.record_counts.ping_results.toLocaleString() },
    { label: "Probes", value: data.record_counts.probe_results.toLocaleString() },
    { label: "Speed Tests", value: data.record_counts.speed_tests.toLocaleString() },
    { label: "Outages", value: data.record_counts.outages.toString(), highlight: data.record_counts.outages > 0, navigateTo: "reliability" },
    { label: "CF → Client", value: cfTo ? `${cfTo.avg_rtt.toFixed(1)}ms` : "N/A" },
    { label: "Client → CF", value: toCf ? `${toCf.avg_rtt.toFixed(1)}ms` : "N/A" },
    { label: "Error Rate", value: `${errorRate}%`, highlight: parseFloat(errorRate) > 1 },
    { label: "Alerts", value: totalAlerts.toString(), highlight: totalAlerts > 10, navigateTo: "speed" },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {cards.map((c) => {
        const target = c.navigateTo;
        const clickable = target && onNavigate;
        return (
          <div
            key={c.label}
            onClick={clickable ? () => onNavigate(target) : undefined}
            className={`rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 ${
              clickable ? "cursor-pointer hover:border-zinc-600 hover:bg-zinc-800/60 transition-colors" : ""
            }`}
          >
            <div className={`text-lg font-bold font-mono ${c.highlight ? "text-red-400" : "text-zinc-100"}`}>{c.value}</div>
            <div className={`text-xs ${c.highlight ? "text-red-400/70 font-semibold" : "text-zinc-500"}`}>
              {c.label}
              {clickable && <span className="ml-1 text-zinc-600">→</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

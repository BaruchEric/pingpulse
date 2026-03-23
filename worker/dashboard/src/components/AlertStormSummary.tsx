import type { AnalysisResponse } from "@/lib/types";

export function AlertStormSummary({ summary }: { summary: AnalysisResponse["alert_summary"] }) {
  if (summary.length === 0) return <div className="text-sm text-zinc-500">No alerts in this period</div>;

  const totalAlerts = summary.reduce((sum, a) => sum + a.count, 0);

  return (
    <div>
      <div className="mb-3 text-sm text-zinc-400">
        <span className="font-mono text-zinc-100">{totalAlerts}</span> alerts total
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-zinc-500 border-b border-zinc-800">
              <th className="py-2 pr-3">Type</th>
              <th className="py-2 pr-3">Severity</th>
              <th className="py-2 pr-3 text-right">Count</th>
              <th className="py-2 pr-3 text-right">Avg Value</th>
              <th className="py-2 pr-3 text-right">Max Value</th>
              <th className="py-2 pr-3">First</th>
              <th className="py-2">Last</th>
            </tr>
          </thead>
          <tbody>
            {summary.map((a, i) => (
              <tr key={i} className="border-b border-zinc-800/50">
                <td className="py-2 pr-3 font-mono text-zinc-300">{a.type.replace(/_/g, " ")}</td>
                <td className={`py-2 pr-3 font-medium ${a.severity === "critical" ? "text-red-400" : a.severity === "warning" ? "text-amber-400" : "text-blue-400"}`}>{a.severity}</td>
                <td className="py-2 pr-3 text-right font-mono text-zinc-300">{a.count}</td>
                <td className="py-2 pr-3 text-right font-mono text-zinc-300">{a.avg_value.toFixed(1)}</td>
                <td className="py-2 pr-3 text-right font-mono text-zinc-300">{a.max_value}</td>
                <td className="py-2 pr-3 text-xs font-mono text-zinc-500">{new Date(a.first_alert).toLocaleTimeString()}</td>
                <td className="py-2 text-xs font-mono text-zinc-500">{new Date(a.last_alert).toLocaleTimeString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

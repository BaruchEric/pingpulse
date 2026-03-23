import type { AnalysisResponse } from "@/lib/types";

const STATUS_COLORS: Record<string, string> = {
  ok: "text-emerald-400",
  timeout: "text-amber-400",
  error: "text-red-400",
};

export function ProbeStatsTable({ stats }: { stats: AnalysisResponse["probe_stats"] }) {
  if (stats.length === 0) return <div className="text-sm text-zinc-400">No probe data</div>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-zinc-400 border-b border-zinc-800">
            <th className="py-2 pr-3">Type</th>
            <th className="py-2 pr-3">Target</th>
            <th className="py-2 pr-3">Status</th>
            <th className="py-2 pr-3 text-right">Count</th>
            <th className="py-2 pr-3 text-right">Avg RTT</th>
            <th className="py-2 pr-3 text-right">Min</th>
            <th className="py-2 text-right">Max</th>
          </tr>
        </thead>
        <tbody>
          {stats.map((s, i) => (
            <tr key={i} className="border-b border-zinc-800/50">
              <td className="py-2 pr-3 font-mono text-zinc-300">{s.probe_type}</td>
              <td className="py-2 pr-3 font-mono text-zinc-400 text-xs">{s.target}</td>
              <td className={`py-2 pr-3 font-medium ${STATUS_COLORS[s.status] || "text-zinc-400"}`}>{s.status}</td>
              <td className="py-2 pr-3 text-right font-mono text-zinc-300">{s.count}</td>
              <td className="py-2 pr-3 text-right font-mono text-zinc-300">{s.avg_rtt?.toFixed(1) ?? "—"}ms</td>
              <td className="py-2 pr-3 text-right font-mono text-zinc-400">{s.min_rtt?.toFixed(1) ?? "—"}</td>
              <td className="py-2 text-right font-mono text-zinc-400">{s.max_rtt?.toFixed(1) ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

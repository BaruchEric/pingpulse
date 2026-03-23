import type { AnalysisResponse } from "@/lib/types";

export function SpeedTestStats({ stats }: { stats: AnalysisResponse["speed_test_stats"] }) {
  if (stats.length === 0) return <div className="text-sm text-zinc-500">No speed test data</div>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-zinc-500 border-b border-zinc-800">
            <th className="py-2 pr-3">Type</th>
            <th className="py-2 pr-3 text-right">Count</th>
            <th className="py-2 pr-3 text-right">Avg DL</th>
            <th className="py-2 pr-3 text-right">Max DL</th>
            <th className="py-2 pr-3 text-right">Avg UL</th>
            <th className="py-2 text-right">Max UL</th>
          </tr>
        </thead>
        <tbody>
          {stats.map((s, i) => (
            <tr key={i} className="border-b border-zinc-800/50">
              <td className="py-2 pr-3 font-medium text-zinc-300">{s.type}</td>
              <td className="py-2 pr-3 text-right font-mono text-zinc-300">{s.count}</td>
              <td className="py-2 pr-3 text-right font-mono text-zinc-300">{s.avg_dl.toFixed(1)} Mbps</td>
              <td className="py-2 pr-3 text-right font-mono text-zinc-400">{s.max_dl.toFixed(1)}</td>
              <td className="py-2 pr-3 text-right font-mono text-zinc-300">{s.avg_ul.toFixed(1)} Mbps</td>
              <td className="py-2 text-right font-mono text-zinc-400">{s.max_ul.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

import type { TraceHop } from "@/lib/types";

function fmt(v: number | null | undefined): string {
  return v == null ? "—" : v.toFixed(1);
}

function lossColor(loss: number | null): string {
  if (loss == null) return "text-zinc-400";
  if (loss >= 50) return "text-red-400";
  if (loss > 0) return "text-amber-400";
  return "text-emerald-400";
}

export function TraceHopTable({ hops }: { hops: TraceHop[] }) {
  if (hops.length === 0) return <div className="text-sm text-zinc-400">No hops recorded</div>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-zinc-400 border-b border-zinc-800">
            <th className="py-2 pr-3 text-right">TTL</th>
            <th className="py-2 pr-3">Host</th>
            <th className="py-2 pr-3 text-right">Loss%</th>
            <th className="py-2 pr-3 text-right">Avg</th>
            <th className="py-2 pr-3 text-right">Best</th>
            <th className="py-2 pr-3 text-right">Worst</th>
            <th className="py-2 pr-3 text-right">StdDev</th>
            <th className="py-2 text-right">Jitter</th>
          </tr>
        </thead>
        <tbody>
          {hops.map((h) => {
            const label = h.hostname || h.addr || "*";
            const asn = h.asn_name || (h.asn ? `AS${h.asn}` : null);
            return (
              <tr key={h.ttl} className="border-b border-zinc-800/50">
                <td className="py-2 pr-3 text-right font-mono text-zinc-400">{h.ttl}</td>
                <td className="py-2 pr-3 font-mono text-xs text-zinc-300">
                  {label}
                  {(asn || h.geo) && (
                    <span className="ml-2 text-zinc-500">
                      {[asn, h.geo].filter(Boolean).join(" · ")}
                    </span>
                  )}
                </td>
                <td className={`py-2 pr-3 text-right font-mono ${lossColor(h.loss_pct)}`}>
                  {h.loss_pct == null ? "—" : `${h.loss_pct.toFixed(0)}%`}
                </td>
                <td className="py-2 pr-3 text-right font-mono text-zinc-300">{fmt(h.avg_ms)}</td>
                <td className="py-2 pr-3 text-right font-mono text-zinc-400">{fmt(h.best_ms)}</td>
                <td className="py-2 pr-3 text-right font-mono text-zinc-400">{fmt(h.worst_ms)}</td>
                <td className="py-2 pr-3 text-right font-mono text-zinc-400">{fmt(h.stddev_ms)}</td>
                <td className="py-2 text-right font-mono text-zinc-400">{fmt(h.jitter_ms)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

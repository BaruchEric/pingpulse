import type { Outage } from "@/lib/types";

export function OutageTimeline({
  outages,
  from,
  to,
}: {
  outages: Outage[];
  from: string;
  to: string;
}) {
  const startMs = new Date(from).getTime();
  const endMs = new Date(to).getTime();
  const totalMs = endMs - startMs;

  if (totalMs <= 0) return null;

  return (
    <div className="space-y-2">
      <div className="text-xs text-zinc-500">Uptime Timeline</div>
      <div className="relative h-6 w-full overflow-hidden rounded-md bg-emerald-950/30 border border-emerald-900/30">
        {outages.map((outage, i) => {
          const oStart = new Date(outage.start_ts).getTime();
          const oEnd = outage.end_ts ? new Date(outage.end_ts).getTime() : endMs;
          const left = ((Math.max(oStart, startMs) - startMs) / totalMs) * 100;
          const width = ((Math.min(oEnd, endMs) - Math.max(oStart, startMs)) / totalMs) * 100;

          return (
            <div
              key={i}
              className="absolute inset-y-0 bg-red-500/60"
              style={{ left: `${left}%`, width: `${Math.max(width, 0.5)}%` }}
              title={`Down: ${outage.duration_s ? `${Math.round(outage.duration_s)}s` : "ongoing"}`}
            />
          );
        })}
      </div>
      <div className="flex justify-between text-xs text-zinc-600 font-mono">
        <span>{new Date(from).toLocaleTimeString()}</span>
        <span>{new Date(to).toLocaleTimeString()}</span>
      </div>
    </div>
  );
}

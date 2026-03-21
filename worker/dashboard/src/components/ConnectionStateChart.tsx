import { useRef, useMemo } from "react";
import type uPlot from "uplot";
import type { PingResult, Outage } from "@/lib/types";
import { useUPlotChart } from "@/components/useUPlotChart";

const OPTS: Omit<uPlot.Options, "width"> = {
  height: 220,
  class: "uplot-dark",
  cursor: { show: true },
  scales: { x: { time: true }, y: { auto: true } },
  axes: [
    { stroke: "#71717a", grid: { stroke: "#27272a" }, ticks: { stroke: "#27272a" } },
    { stroke: "#71717a", grid: { stroke: "#27272a" }, ticks: { stroke: "#27272a" }, label: "RTT (ms)" },
  ],
  series: [
    {},
    {
      label: "Connection RTT",
      stroke: "#a78bfa",
      width: 1.5,
      fill: "#a78bfa15",
    },
  ],
};

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function ConnectionStateChart({
  pings,
  outages,
}: {
  pings: PingResult[];
  outages: Outage[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  const data = useMemo(() => {
    const okPings = pings.filter((p) => p.status === "ok").reverse();
    if (okPings.length === 0) return null;
    return [
      okPings.map((p) => new Date(p.timestamp).getTime() / 1000),
      okPings.map((p) => p.rtt_ms),
    ] as uPlot.AlignedData;
  }, [pings]);

  useUPlotChart(containerRef, () => OPTS, data);

  const recentOutages = outages.slice(0, 10);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="mb-3 text-sm font-medium text-zinc-400">Connection State</h2>
        {pings.length === 0 ? (
          <div className="flex h-[220px] items-center justify-center text-sm text-zinc-500">
            No connection data
          </div>
        ) : (
          <div ref={containerRef} />
        )}
      </div>

      {recentOutages.length > 0 && (
        <div>
          <h3 className="mb-2 text-xs font-medium text-zinc-500">Recent Outages</h3>
          <div className="space-y-1">
            {recentOutages.map((outage, i) => {
              const start = new Date(outage.start_ts);
              const end = outage.end_ts ? new Date(outage.end_ts) : null;
              const duration = outage.duration_s;

              return (
                <div
                  key={i}
                  className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-900/50 px-3 py-2"
                >
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-red-500" />
                    <span className="text-xs font-mono text-zinc-300">
                      {start.toLocaleDateString()}{" "}
                      {start.toLocaleTimeString()}
                    </span>
                    {end && (
                      <span className="text-xs text-zinc-600">
                        &rarr; {end.toLocaleTimeString()}
                      </span>
                    )}
                  </div>
                  <span className="text-xs font-mono text-zinc-400">
                    {duration !== null
                      ? formatDuration(duration)
                      : "ongoing"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

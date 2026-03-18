import { useRef, useMemo } from "react";
import type uPlot from "uplot";
import type { PingResult } from "@/lib/types";
import { useUPlotChart } from "@/components/useUPlotChart";

const OPTS: Omit<uPlot.Options, "width"> = {
  height: 280,
  class: "uplot-dark",
  cursor: { show: true },
  scales: { x: { time: true }, y: { auto: true } },
  axes: [
    { stroke: "#71717a", grid: { stroke: "#27272a" }, ticks: { stroke: "#27272a" } },
    { stroke: "#71717a", grid: { stroke: "#27272a" }, ticks: { stroke: "#27272a" }, label: "ms" },
  ],
  series: [
    {},
    { label: "RTT", stroke: "#3b82f6", width: 1.5 },
    { label: "Jitter", stroke: "#f59e0b", width: 1, dash: [4, 4] },
  ],
};

export function LatencyChart({ pings }: { pings: PingResult[] }) {
  const containerRef = useRef<HTMLDivElement>(null);

  const data = useMemo(() => {
    const okPings = pings.filter((p) => p.status === "ok").reverse();
    if (okPings.length === 0) return null;
    return [
      okPings.map((p) => new Date(p.timestamp).getTime() / 1000),
      okPings.map((p) => p.rtt_ms),
      okPings.map((p) => p.jitter_ms),
    ] as uPlot.AlignedData;
  }, [pings]);

  useUPlotChart(containerRef, () => OPTS, data);

  if (pings.length === 0) {
    return <div className="flex h-[280px] items-center justify-center text-sm text-zinc-500">No ping data</div>;
  }

  return <div ref={containerRef} />;
}

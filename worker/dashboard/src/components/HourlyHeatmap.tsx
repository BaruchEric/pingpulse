import { useRef, useMemo } from "react";
import type uPlot from "uplot";
import type { AnalysisResponse } from "@/lib/types";
import { useUPlotChart } from "@/components/useUPlotChart";

const OPTS: Omit<uPlot.Options, "width"> = {
  height: 280,
  class: "uplot-dark",
  cursor: { show: true },
  scales: { x: { time: false }, y: { auto: true } },
  axes: [
    { stroke: "#71717a", grid: { stroke: "#27272a" }, ticks: { stroke: "#27272a" }, label: "Hour" },
    { stroke: "#71717a", grid: { stroke: "#27272a" }, ticks: { stroke: "#27272a" }, label: "ms" },
  ],
  series: [
    {},
    { label: "Avg RTT", stroke: "#3b82f6", width: 2, fill: "rgba(59,130,246,0.1)" },
    { label: "Max RTT", stroke: "#ef4444", width: 1, dash: [4, 4] },
    { label: "Errors", stroke: "#f59e0b", width: 1.5, scale: "errors" },
  ],
};

export function HourlyHeatmap({ pattern }: { pattern: AnalysisResponse["hourly_pattern"] }) {
  const containerRef = useRef<HTMLDivElement>(null);

  const data = useMemo(() => {
    if (pattern.length === 0) return null;
    return [
      pattern.map((_, i) => i),
      pattern.map((p) => p.avg_rtt),
      pattern.map((p) => p.max_rtt),
      pattern.map((p) => p.errors),
    ] as uPlot.AlignedData;
  }, [pattern]);

  useUPlotChart(containerRef, () => OPTS, data);

  if (pattern.length === 0) {
    return <div className="flex h-[280px] items-center justify-center text-sm text-zinc-500">No hourly data</div>;
  }

  return <div ref={containerRef} />;
}

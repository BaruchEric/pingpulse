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
    { label: "CF → Client", stroke: "#3b82f6", width: 2 },
    { label: "Client → CF", stroke: "#ef4444", width: 2 },
  ],
};

export function DirectionAsymmetry({ data: raw }: { data: AnalysisResponse["direction_asymmetry"] }) {
  const containerRef = useRef<HTMLDivElement>(null);

  const chartData = useMemo(() => {
    if (raw.length === 0) return null;
    const hours = [...new Set(raw.map((d) => d.hour))].sort();
    const cfToClient = new Map(
      raw.filter((d) => d.direction === "cf_to_client").map((d) => [d.hour, d.avg_rtt])
    );
    const clientToCf = new Map(
      raw.filter((d) => d.direction === "client_to_cf").map((d) => [d.hour, d.avg_rtt])
    );

    return [
      hours.map((_, i) => i),
      hours.map((h) => cfToClient.get(h) ?? 0),
      hours.map((h) => clientToCf.get(h) ?? 0),
    ] as uPlot.AlignedData;
  }, [raw]);

  useUPlotChart(containerRef, () => OPTS, chartData);

  if (raw.length === 0) {
    return <div className="flex h-[280px] items-center justify-center text-sm text-zinc-500">No direction data</div>;
  }

  return <div ref={containerRef} />;
}

import { useRef, useMemo } from "react";
import type uPlot from "uplot";
import type { SpeedTest } from "@/lib/types";
import { useUPlotChart } from "@/components/useUPlotChart";
import { DARK_AXIS } from "@/lib/chart-defaults";

const OPTS: Omit<uPlot.Options, "width"> = {
  height: 200,
  class: "uplot-dark",
  scales: { x: { time: true }, y: { auto: true } },
  axes: [
    { ...DARK_AXIS },
    { ...DARK_AXIS, label: "Mbps" },
  ],
  series: [
    {},
    { label: "Download", stroke: "#10b981", width: 2, fill: "#10b98120" },
    { label: "Upload", stroke: "#8b5cf6", width: 2, fill: "#8b5cf620" },
  ],
};

export function ThroughputChart({ tests }: { tests: SpeedTest[] }) {
  const containerRef = useRef<HTMLDivElement>(null);

  const data = useMemo(() => {
    const sorted = [...tests].reverse();
    if (sorted.length === 0) return null;
    return [
      sorted.map((t) => new Date(t.timestamp).getTime() / 1000),
      sorted.map((t) => t.download_mbps),
      sorted.map((t) => t.upload_mbps),
    ] as uPlot.AlignedData;
  }, [tests]);

  useUPlotChart(containerRef, () => OPTS, data);

  if (tests.length === 0) {
    return <div className="flex h-[200px] items-center justify-center text-sm text-zinc-400">No speed tests</div>;
  }

  return <div ref={containerRef} />;
}

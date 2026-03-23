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
    { label: "Worker DL", stroke: "#3b82f6", width: 2, fill: "#3b82f620" },
    { label: "Worker UL", stroke: "#93c5fd", width: 2, fill: "#93c5fd20" },
    { label: "Edge DL", stroke: "#f59e0b", width: 2, fill: "#f59e0b20" },
    { label: "Edge UL", stroke: "#fcd34d", width: 2, fill: "#fcd34d20" },
  ],
};

export function ThroughputChart({ tests }: { tests: SpeedTest[] }) {
  const containerRef = useRef<HTMLDivElement>(null);

  const data = useMemo(() => {
    if (tests.length === 0) return null;
    const ts: number[] = [];
    const wDl: (number | null)[] = [];
    const wUl: (number | null)[] = [];
    const eDl: (number | null)[] = [];
    const eUl: (number | null)[] = [];
    for (let i = tests.length - 1; i >= 0; i--) {
      const t = tests[i];
      if (!t) continue;
      ts.push(new Date(t.timestamp).getTime() / 1000);
      const isEdge = t.target === "edge";
      wDl.push(isEdge ? null : t.download_mbps);
      wUl.push(isEdge ? null : t.upload_mbps);
      eDl.push(isEdge ? t.download_mbps : null);
      eUl.push(isEdge ? t.upload_mbps : null);
    }
    return [ts, wDl, wUl, eDl, eUl] as uPlot.AlignedData;
  }, [tests]);

  useUPlotChart(containerRef, () => OPTS, data);

  if (tests.length === 0) {
    return <div className="flex h-[200px] items-center justify-center text-sm text-zinc-400">No speed tests</div>;
  }

  return <div ref={containerRef} />;
}

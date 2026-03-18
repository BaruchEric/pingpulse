import { useRef, useEffect } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { SpeedTest } from "@/lib/types";

export function ThroughputChart({ tests }: { tests: SpeedTest[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<uPlot | null>(null);

  useEffect(() => {
    if (!containerRef.current || tests.length === 0) return;

    const sorted = [...tests].reverse();
    const timestamps = sorted.map((t) => new Date(t.timestamp).getTime() / 1000);
    const download = sorted.map((t) => t.download_mbps);
    const upload = sorted.map((t) => t.upload_mbps);
    const newData: uPlot.AlignedData = [timestamps, download, upload];

    if (chartRef.current) {
      chartRef.current.setData(newData);
      return;
    }

    const opts: uPlot.Options = {
      width: containerRef.current.clientWidth,
      height: 200,
      class: "uplot-dark",
      scales: { x: { time: true }, y: { auto: true } },
      axes: [
        { stroke: "#71717a", grid: { stroke: "#27272a" }, ticks: { stroke: "#27272a" } },
        { stroke: "#71717a", grid: { stroke: "#27272a" }, ticks: { stroke: "#27272a" }, label: "Mbps" },
      ],
      series: [
        {},
        { label: "Download", stroke: "#10b981", width: 2, fill: "#10b98120" },
        { label: "Upload", stroke: "#8b5cf6", width: 2, fill: "#8b5cf620" },
      ],
    };

    chartRef.current = new uPlot(opts, newData, containerRef.current);

    const observer = new ResizeObserver(() => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.setSize({
          width: containerRef.current.clientWidth,
          height: 200,
        });
      }
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [tests]);

  if (tests.length === 0) {
    return <div className="flex h-[200px] items-center justify-center text-sm text-zinc-500">No speed tests</div>;
  }

  return <div ref={containerRef} />;
}

import { useRef, useEffect } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { PingResult } from "@/lib/types";

export function LatencyChart({ pings }: { pings: PingResult[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<uPlot | null>(null);

  useEffect(() => {
    if (!containerRef.current || pings.length === 0) return;

    const okPings = pings.filter((p) => p.status === "ok").reverse();
    if (okPings.length === 0) return;

    const timestamps = okPings.map((p) => new Date(p.timestamp).getTime() / 1000);
    const rtts = okPings.map((p) => p.rtt_ms);
    const jitters = okPings.map((p) => p.jitter_ms);
    const newData: uPlot.AlignedData = [timestamps, rtts, jitters];

    if (chartRef.current) {
      chartRef.current.setData(newData);
      return;
    }

    const opts: uPlot.Options = {
      width: containerRef.current.clientWidth,
      height: 280,
      class: "uplot-dark",
      cursor: { show: true },
      scales: {
        x: { time: true },
        y: { auto: true },
      },
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

    chartRef.current = new uPlot(opts, newData, containerRef.current);

    const observer = new ResizeObserver(() => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.setSize({
          width: containerRef.current.clientWidth,
          height: 280,
        });
      }
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [pings]);

  if (pings.length === 0) {
    return <div className="flex h-[280px] items-center justify-center text-sm text-zinc-500">No ping data</div>;
  }

  return <div ref={containerRef} />;
}

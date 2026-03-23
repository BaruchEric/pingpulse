import { useRef, useMemo } from "react";
import type uPlot from "uplot";
import { useUPlotChart } from "@/components/useUPlotChart";
import { DARK_AXIS } from "@/lib/chart-defaults";
import type { PingResult } from "@/lib/types";

export function LogsChart({ logs }: { logs: PingResult[] }) {
  const containerRef = useRef<HTMLDivElement>(null);

  const { data, opts } = useMemo(() => {
    if (logs.length === 0) return { data: null, opts: null };

    // Sort by timestamp ascending for chart
    const sorted = [...logs].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    const timestamps = new Float64Array(sorted.map((l) => new Date(l.timestamp).getTime() / 1000));

    // Split RTT by direction
    const cfToClient = sorted.map((l) =>
      l.status === "ok" && l.direction === "cf_to_client" ? l.rtt_ms : null
    );
    const clientToCf = sorted.map((l) =>
      l.status === "ok" && l.direction === "client_to_cf" ? l.rtt_ms : null
    );

    // Timeout/error markers (show at y=0 as dots)
    const failures = sorted.map((l) =>
      l.status !== "ok" ? 0 : null
    );

    const chartOpts: Omit<uPlot.Options, "width"> = {
      height: 160,
      class: "uplot-dark",
      cursor: { show: true },
      scales: { x: { time: true }, y: { auto: true } },
      axes: [
        { ...DARK_AXIS },
        { ...DARK_AXIS, label: "RTT (ms)", size: 50 },
      ],
      series: [
        {},
        {
          label: "CF → Client",
          stroke: "#3b82f6",
          width: 1.5,
          points: { show: true, size: 3 },
        },
        {
          label: "Client → CF",
          stroke: "#10b981",
          width: 1.5,
          points: { show: true, size: 3 },
        },
        {
          label: "Timeout/Error",
          stroke: "#ef4444",
          width: 0,
          points: { show: true, size: 6, fill: "#ef4444" },
        },
      ],
    };

    return {
      data: [timestamps, cfToClient, clientToCf, failures] as uPlot.AlignedData,
      opts: chartOpts,
    };
  }, [logs]);

  useUPlotChart(containerRef, () => opts ?? { height: 160, series: [{}], axes: [] }, data);

  if (logs.length === 0) return null;

  return <div ref={containerRef} />;
}

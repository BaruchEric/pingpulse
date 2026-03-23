import { useState, useRef, useMemo, useEffect, useCallback } from "react";
import type uPlot from "uplot";
import { useUPlotChart } from "@/components/useUPlotChart";
import { api } from "@/lib/api";
import { DARK_AXIS } from "@/lib/chart-defaults";

interface ProbeResult {
  timestamp: number;
  probe_type: "icmp" | "http";
  target: string;
  rtt_ms: number;
  status_code: number | null;
  status: "ok" | "timeout" | "error";
  jitter_ms: number;
}

type ProbeFilter = "all" | "icmp" | "http";

const TARGET_COLORS = [
  "#3b82f6", // blue
  "#10b981", // emerald
  "#f59e0b", // amber
  "#ef4444", // red
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#06b6d4", // cyan
  "#f97316", // orange
];

export function WanQualityChart({
  clientId,
  from,
  to,
}: {
  clientId: string;
  from: string;
  to: string;
}) {
  const [filter, setFilter] = useState<ProbeFilter>("all");
  const [probes, setProbes] = useState<ProbeResult[]>([]);
  const [loading, setLoading] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);

  const fetchProbes = useCallback(async () => {
    setLoading(true);
    try {
      const fromMs = String(new Date(from).getTime());
      const toMs = String(new Date(to).getTime());
      const json = await api.getProbes(clientId, fromMs, toMs, filter !== "all" ? filter : undefined) as { data: ProbeResult[] };
      setProbes(json.data);
    } catch {
      setProbes([]);
    } finally {
      setLoading(false);
    }
  }, [clientId, from, to, filter]);

  useEffect(() => {
    void fetchProbes();
  }, [fetchProbes]);

  // Group by target, build uPlot data
  const { data, opts } = useMemo(() => {
    const okProbes = probes.filter((p) => p.status === "ok");
    if (okProbes.length === 0) return { data: null, opts: null };

    // Collect unique targets
    const targetSet = new Set<string>();
    for (const p of okProbes) targetSet.add(p.target);
    const targets = [...targetSet].sort();

    // Build a unified timestamp array and per-target rtt maps
    const tsMap = new Map<number, Record<string, number | null>>();
    for (const p of okProbes) {
      const ts = Math.floor(p.timestamp / 1000); // seconds for uPlot
      let entry = tsMap.get(ts);
      if (!entry) {
        entry = {};
        tsMap.set(ts, entry);
      }
      entry[p.target] = p.rtt_ms;
    }

    const sortedTs = [...tsMap.keys()].sort((a, b) => a - b);
    const timestamps = new Float64Array(sortedTs);

    const series: uPlot.Series[] = [{}];
    const aligned: (Float64Array | (number | null)[])[] = [timestamps];

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i] ?? "";
      const color = TARGET_COLORS[i % TARGET_COLORS.length] ?? "#3b82f6";
      series.push({
        label: target,
        stroke: color,
        width: 1.5,
        points: { show: false },
      });
      aligned.push(
        sortedTs.map((ts) => tsMap.get(ts)?.[target] ?? null)
      );
    }

    const chartOpts: Omit<uPlot.Options, "width"> = {
      height: 280,
      class: "uplot-dark",
      cursor: { show: true },
      scales: { x: { time: true }, y: { auto: true } },
      axes: [
        { ...DARK_AXIS },
        { ...DARK_AXIS, label: "RTT (ms)" },
      ],
      series,
    };

    return { data: aligned as uPlot.AlignedData, opts: chartOpts };
  }, [probes]);

  useUPlotChart(containerRef, () => opts ?? {
    height: 280,
    class: "uplot-dark",
    scales: { x: { time: true }, y: { auto: true } },
    axes: [
      { ...DARK_AXIS },
      { ...DARK_AXIS, label: "RTT (ms)" },
    ],
    series: [{}],
  }, data, filter);

  const filters: { label: string; value: ProbeFilter }[] = [
    { label: "ALL", value: "all" },
    { label: "ICMP", value: "icmp" },
    { label: "HTTP", value: "http" },
  ];

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium text-zinc-400">WAN Quality</h2>
        <div className="flex gap-1">
          {filters.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                filter === f.value
                  ? "bg-zinc-700 text-zinc-100"
                  : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>
      {loading && probes.length === 0 ? (
        <div className="flex h-[280px] items-center justify-center text-sm text-zinc-400">Loading...</div>
      ) : probes.length === 0 ? (
        <div className="flex h-[280px] items-center justify-center text-sm text-zinc-400">No probe data</div>
      ) : (
        <div ref={containerRef} />
      )}
    </div>
  );
}

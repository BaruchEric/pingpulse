import type { TimeRange } from "@/lib/hooks";

const RANGES: TimeRange[] = ["1h", "6h", "24h", "7d", "30d"];

export function TimeRangeSelector({
  value,
  onChange,
}: {
  value: TimeRange;
  onChange: (range: TimeRange) => void;
}) {
  return (
    <div className="flex gap-1 rounded-md border border-zinc-800 bg-zinc-900 p-1">
      {RANGES.map((range) => (
        <button
          key={range}
          onClick={() => onChange(range)}
          className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
            value === range
              ? "bg-zinc-700 text-zinc-100"
              : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          {range}
        </button>
      ))}
    </div>
  );
}

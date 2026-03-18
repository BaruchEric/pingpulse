export const THRESHOLD_STALE_MS = 120_000; // 2 minutes

type Status = "up" | "degraded" | "down";

function getStatus(lastSeen: string, latencyMs?: number, thresholdMs?: number): Status {
  const elapsed = Date.now() - new Date(lastSeen).getTime();
  if (elapsed > THRESHOLD_STALE_MS) return "down";
  if (latencyMs && thresholdMs && latencyMs > thresholdMs) return "degraded";
  return "up";
}

const STATUS_STYLES: Record<Status, { dot: string; label: string; text: string }> = {
  up: { dot: "bg-emerald-500", label: "Up", text: "text-emerald-400" },
  degraded: { dot: "bg-amber-500", label: "Degraded", text: "text-amber-400" },
  down: { dot: "bg-red-500", label: "Down", text: "text-red-400" },
};

export function StatusBadge({
  lastSeen,
  latencyMs,
  thresholdMs,
}: {
  lastSeen: string;
  latencyMs?: number;
  thresholdMs?: number;
}) {
  const status = getStatus(lastSeen, latencyMs, thresholdMs);
  const { dot, label, text } = STATUS_STYLES[status];

  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${text}`}>
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

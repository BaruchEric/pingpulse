export type Status = "up" | "degraded" | "down";

const DEFAULT_GRACE_PERIOD_MS = 120_000;

export function getClientStatus(
  lastSeen: string,
  gracePeriodMs = DEFAULT_GRACE_PERIOD_MS,
  latencyMs?: number,
  thresholdMs?: number,
): Status {
  const elapsed = Date.now() - new Date(lastSeen).getTime();
  if (elapsed > gracePeriodMs) return "down";
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
  gracePeriodMs,
  latencyMs,
  thresholdMs,
}: {
  lastSeen: string;
  gracePeriodMs?: number;
  latencyMs?: number;
  thresholdMs?: number;
}) {
  const status = getClientStatus(lastSeen, gracePeriodMs, latencyMs, thresholdMs);
  const { dot, label, text } = STATUS_STYLES[status];

  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${text}`}>
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

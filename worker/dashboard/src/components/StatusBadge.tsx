export type Status = "up" | "degraded" | "down";

// Default ping interval assumed when none is provided (30s)
const DEFAULT_PING_INTERVAL_MS = 30_000;

/**
 * Derive the display grace period from the ping interval.
 * last_seen updates every ping_interval/2 (throttled), so the staleness
 * can be up to ~1.5x the ping interval during normal operation.
 * We use 3x the ping interval as a safe margin before showing "down".
 */
function displayGracePeriodMs(pingIntervalMs?: number): number {
  return (pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS) * 3;
}

export function getClientStatus(
  lastSeen: string,
  pingIntervalMs?: number,
  latencyMs?: number,
  thresholdMs?: number,
): Status {
  const elapsed = Date.now() - new Date(lastSeen).getTime();
  if (elapsed > displayGracePeriodMs(pingIntervalMs)) return "down";
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
  pingIntervalMs,
  latencyMs,
  thresholdMs,
}: {
  lastSeen: string;
  pingIntervalMs?: number;
  latencyMs?: number;
  thresholdMs?: number;
}) {
  const status = getClientStatus(lastSeen, pingIntervalMs, latencyMs, thresholdMs);
  const { dot, label, text } = STATUS_STYLES[status];

  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${text}`}>
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

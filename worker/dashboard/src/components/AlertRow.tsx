import type { Alert } from "@/lib/types";

const SEVERITY_STYLES: Record<string, string> = {
  critical: "text-red-400 bg-red-950/30 border-red-900/50",
  warning: "text-amber-400 bg-amber-950/30 border-amber-900/50",
  info: "text-blue-400 bg-blue-950/30 border-blue-900/50",
};

export function AlertRow({ alert }: { alert: Alert }) {
  const style = SEVERITY_STYLES[alert.severity] || SEVERITY_STYLES.info;
  const time = new Date(alert.timestamp).toLocaleString();
  const label = alert.type.replace(/_/g, " ");

  return (
    <div className={`flex items-center justify-between rounded-md border px-4 py-3 ${style}`}>
      <div>
        <span className="text-sm font-medium capitalize">{label}</span>
        <span className="ml-3 text-xs opacity-60">
          {alert.value.toFixed(1)} / {alert.threshold.toFixed(1)}
        </span>
      </div>
      <div className="text-xs font-mono opacity-60">{time}</div>
    </div>
  );
}

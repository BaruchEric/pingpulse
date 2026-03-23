import type { Alert, AlertSeverity } from "@/lib/types";

const SEVERITY_STYLES: Record<AlertSeverity, string> = {
  critical: "text-red-400 bg-red-950/30 border-red-900/50",
  warning: "text-amber-400 bg-amber-950/30 border-amber-900/50",
  info: "text-blue-400 bg-blue-950/30 border-blue-900/50",
};

function DeliveryDot({ status }: { status: number }) {
  if (status === 1) return <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" title="Delivered" />;
  if (status === -1) return <span className="inline-block h-2 w-2 rounded-full bg-red-400" title="Failed" />;
  return <span className="inline-block h-2 w-2 rounded-full bg-zinc-600" title="Not attempted" />;
}

function EmailIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
      <path d="M3 4a2 2 0 00-2 2v1.161l8.441 4.221a1.25 1.25 0 001.118 0L19 7.162V6a2 2 0 00-2-2H3z" />
      <path d="M19 8.839l-7.77 3.885a2.75 2.75 0 01-2.46 0L1 8.839V14a2 2 0 002 2h14a2 2 0 002-2V8.839z" />
    </svg>
  );
}

function TelegramIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
    </svg>
  );
}

export function AlertRow({ alert }: { alert: Alert }) {
  const style = SEVERITY_STYLES[alert.severity];
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
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5 text-zinc-400">
          <div className="flex items-center gap-1" title={`Email: ${alert.delivered_email === 1 ? "delivered" : alert.delivered_email === -1 ? "failed" : "not sent"}`}>
            <EmailIcon />
            <DeliveryDot status={alert.delivered_email} />
          </div>
          <div className="flex items-center gap-1" title={`Telegram: ${alert.delivered_telegram === 1 ? "delivered" : alert.delivered_telegram === -1 ? "failed" : "not sent"}`}>
            <TelegramIcon />
            <DeliveryDot status={alert.delivered_telegram} />
          </div>
        </div>
        <div className="text-xs font-mono opacity-60">{time}</div>
      </div>
    </div>
  );
}

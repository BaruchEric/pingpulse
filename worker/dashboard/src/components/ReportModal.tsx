import { useState } from "react";
import { api } from "@/lib/api";

interface ReportModalProps {
  clientId: string;
  onClose: () => void;
}

export function ReportModal({ clientId, onClose }: ReportModalProps) {
  const [sending, setSending] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, boolean> | null>(null);

  const handleSend = async (channel: "telegram" | "email" | "all") => {
    setSending(channel);
    setResult(null);
    try {
      const res = await api.sendReport(clientId, channel);
      setResult(res.sent);
    } catch {
      setResult({ error: true });
    } finally {
      setSending(null);
    }
  };

  const handleExportJson = async () => {
    try {
      const res = await api.generateReport(clientId);
      const blob = new Blob([JSON.stringify(res.report, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `pingpulse-report-${clientId}-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // silently fail
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="w-full max-w-md rounded-lg border border-zinc-800 bg-zinc-900 p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-medium text-zinc-100 mb-4">Send Health Report</h3>

        <div className="space-y-3">
          <button
            onClick={() => handleSend("telegram")}
            disabled={sending !== null}
            className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-sm text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
          >
            {sending === "telegram" ? "Sending..." : "Send via Telegram"}
          </button>

          <button
            onClick={() => handleSend("email")}
            disabled={sending !== null}
            className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-sm text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
          >
            {sending === "email" ? "Sending..." : "Send via Email"}
          </button>

          <button
            onClick={handleExportJson}
            className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-sm text-zinc-200 hover:bg-zinc-700"
          >
            Download JSON
          </button>

          <button
            onClick={() => { onClose(); requestAnimationFrame(() => window.print()); }}
            className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-sm text-zinc-200 hover:bg-zinc-700"
          >
            Print Report
          </button>
        </div>

        {result && (
          <div className="mt-4 rounded-md bg-zinc-800/50 p-3 text-xs text-zinc-400">
            {result.error
              ? "Failed to send report"
              : Object.entries(result)
                  .map(([k, v]) => `${k}: ${v ? "sent" : "failed"}`)
                  .join(", ")}
          </div>
        )}

        <button
          onClick={onClose}
          className="mt-4 w-full rounded-md bg-zinc-800 px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200"
        >
          Close
        </button>
      </div>
    </div>
  );
}

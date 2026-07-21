import { useState, useEffect } from "react";
import { useTraces } from "@/lib/hooks";
import { api } from "@/lib/api";
import type { TraceDetail } from "@/lib/types";
import { TraceHopTable } from "@/components/TraceHopTable";

export function TracesCard({ clientId }: { clientId: string }) {
  const { data: traces } = useTraces(clientId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TraceDetail | null>(null);

  // Default to the newest trace when nothing is explicitly selected (derived, not stored).
  const effectiveId = selectedId ?? traces?.[0]?.id ?? null;

  useEffect(() => {
    if (!effectiveId) return;
    let cancelled = false;
    api.getTrace(clientId, effectiveId)
      .then((d) => { if (!cancelled) setDetail(d); })
      .catch(() => { /* keep previous detail on error */ });
    return () => { cancelled = true; };
  }, [clientId, effectiveId]);

  if (!traces || traces.length === 0) return null;

  const showing = detail && detail.trace.id === effectiveId ? detail : null;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
      <h2 className="mb-3 text-sm font-medium text-zinc-400">Path Traces</h2>

      <div className="mb-3 flex flex-wrap gap-2">
        {traces.map((t) => (
          <button
            key={t.id}
            onClick={() => setSelectedId(t.id)}
            className={`rounded-md border px-2.5 py-1 text-xs font-mono transition-colors ${
              effectiveId === t.id
                ? "border-[var(--color-accent)] bg-zinc-800 text-zinc-100"
                : "border-zinc-700 text-zinc-400 hover:bg-zinc-800"
            }`}
            title={`${t.protocol} · ${t.trigger}`}
          >
            {t.target}
            <span className="ml-1.5 text-zinc-500">{new Date(t.started_at).toLocaleString()}</span>
            {t.trigger === "alert" && (
              <span className="ml-1.5 rounded bg-amber-500/20 px-1 py-0.5 text-[10px] font-medium text-amber-400">
                alert
              </span>
            )}
          </button>
        ))}
      </div>

      {showing ? (
        <TraceHopTable hops={showing.hops} />
      ) : (
        <div className="text-sm text-zinc-400">Loading trace…</div>
      )}
    </div>
  );
}

import { memo, useMemo, useState } from "react";
import type { AnalysisResponse, Client } from "@/lib/types";

function fmt(ms: number | null | undefined): string {
  if (ms == null) return "—";
  return `${Math.round(ms)}ms`;
}

function fmtDuration(seconds: number | null): string {
  if (seconds == null) return "ongoing";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s > 0 ? `${m} min ${s} sec` : `${m} min`;
}

function fmtTs(ts: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function pct(count: number, total: number): string {
  if (total === 0) return "0%";
  return `${((count / total) * 100).toFixed(1)}%`;
}

function detectErrorBursts(
  errors: AnalysisResponse["recent_errors"]
): { start: number; end: number; count: number; targets: string[] }[] {
  if (errors.length === 0) return [];
  const sorted = [...errors].sort((a, b) => a.timestamp - b.timestamp);
  const bursts: { start: number; end: number; count: number; targets: Set<string> }[] = [];
  const first = sorted[0];
  if (!first) return [];
  let current = { start: first.timestamp, end: first.timestamp, count: 1, targets: new Set([first.target]) };

  for (let i = 1; i < sorted.length; i++) {
    const row = sorted[i];
    if (!row) continue;
    const gap = row.timestamp - current.end;
    if (gap <= 120_000) {
      current.end = row.timestamp;
      current.count++;
      current.targets.add(row.target);
    } else {
      if (current.count >= 3) bursts.push({ ...current, targets: current.targets });
      current = { start: row.timestamp, end: row.timestamp, count: 1, targets: new Set([row.target]) };
    }
  }
  if (current.count >= 3) bursts.push({ ...current, targets: current.targets });

  return bursts.map((b) => ({ start: b.start, end: b.end, count: b.count, targets: [...b.targets] }));
}

const TH = "px-3 py-2 text-left text-xs text-zinc-500 font-medium";
const TH_R = "px-3 py-2 text-right text-xs text-zinc-500 font-medium";
const TD = "px-3 py-2 text-sm text-zinc-300 font-mono";
const TD_R = "px-3 py-2 text-sm text-zinc-300 font-mono text-right";
const TD_MUTED = "px-3 py-2 text-sm text-zinc-500 font-mono";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
      <h3 className="mb-3 text-sm font-medium text-zinc-400">{title}</h3>
      {children}
    </div>
  );
}

function LatencyDistTable({
  title,
  color,
  dist,
}: {
  title: string;
  color: string;
  dist: AnalysisResponse["latency_distribution"];
}) {
  const total = dist.reduce((s, d) => s + d.count, 0);
  return (
    <Section title={title}>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-zinc-800">
              <th className={TH}>Bucket</th>
              <th className={TH_R}>Count</th>
              <th className={TH_R}>%</th>
              <th className={TH} style={{ width: "40%" }}>
                <span className="sr-only">Bar</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {dist.map((d) => (
              <tr key={d.bucket} className="border-b border-zinc-800/50">
                <td className={TD}>{d.bucket}</td>
                <td className={TD_R}>{d.count.toLocaleString()}</td>
                <td className={TD_R}>{pct(d.count, total)}</td>
                <td className="px-3 py-2">
                  <div className={`h-3 rounded-sm ${color}/30`}>
                    <div
                      className={`h-full rounded-sm ${color}`}
                      style={{ width: `${(d.count / total) * 100}%` }}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

type PageId = "overview" | "latency" | "reliability" | "speed";

const PAGES: { id: PageId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "latency", label: "Latency" },
  { id: "reliability", label: "Reliability" },
  { id: "speed", label: "Speed & Alerts" },
];

export const FullAnalysisReport = memo(function FullAnalysisReport({
  data,
  client,
}: {
  data: AnalysisResponse;
  client: Client;
}) {
  const [page, setPage] = useState<PageId>("overview");

  const { cfTo, toCf, totalOkPings, lossPct, asymmetryRatio, totalAlerts } = useMemo(() => {
    const cfTo = data.ping_stats.find((p) => p.direction === "cf_to_client" && p.status === "ok");
    const toCf = data.ping_stats.find((p) => p.direction === "client_to_cf" && p.status === "ok");
    const totalOkPings = (cfTo?.count ?? 0) + (toCf?.count ?? 0);
    const timeoutPings = data.ping_stats
      .filter((p) => p.status === "timeout")
      .reduce((s, p) => s + p.count, 0);
    const lossPct = totalOkPings + timeoutPings > 0
      ? ((timeoutPings / (totalOkPings + timeoutPings)) * 100).toFixed(1)
      : "0.0";
    const asymmetryRatio =
      cfTo && toCf && cfTo.avg_rtt > 0 ? (toCf.avg_rtt / cfTo.avg_rtt).toFixed(1) : null;
    const totalAlerts = data.alert_summary.reduce((s, a) => s + a.count, 0);
    return { cfTo, toCf, totalOkPings, lossPct, asymmetryRatio, totalAlerts };
  }, [data]);

  const { cfToDist, toCfDist } = useMemo(() => ({
    cfToDist: data.latency_distribution?.filter((d) => d.direction === "cf_to_client") ?? [],
    toCfDist: data.latency_distribution?.filter((d) => d.direction === "client_to_cf") ?? [],
  }), [data]);

  const hourlyRows = useMemo(() => {
    const hourlyMap = new Map<string, { cfTo?: number; toCf?: number; cfToCount?: number; toCfCount?: number }>();
    for (const row of data.direction_asymmetry) {
      const entry = hourlyMap.get(row.hour) ?? {};
      if (row.direction === "cf_to_client") {
        entry.cfTo = row.avg_rtt;
        entry.cfToCount = row.count;
      } else {
        entry.toCf = row.avg_rtt;
        entry.toCfCount = row.count;
      }
      hourlyMap.set(row.hour, entry);
    }
    return [...hourlyMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [data]);

  const bursts = useMemo(() => detectErrorBursts(data.recent_errors), [data]);
  const probeErrors = useMemo(() => data.probe_stats.filter((p) => p.status !== "ok"), [data]);

  const findings = useMemo(() => {
    const findings: string[] = [];

    if (asymmetryRatio && parseFloat(asymmetryRatio) > 1.5) {
      findings.push(
        `Upstream asymmetry — Client→CF is ${asymmetryRatio}x slower than CF→Client (${fmt(toCf?.avg_rtt)} vs ${fmt(cfTo?.avg_rtt)}). This suggests upload path congestion or asymmetric ISP provisioning.`
      );
    }

    if (data.outage_events?.length > 0) {
      const totalMin = data.outage_events.reduce((s, o) => s + (o.duration_s ?? 0), 0) / 60;
      findings.push(
        `${data.outage_events.length} outage${data.outage_events.length > 1 ? "s" : ""} totaling ${totalMin.toFixed(0)} minutes of downtime in this period.`
      );
    }

    if (bursts.length > 0) {
      findings.push(
        `${bursts.length} probe error burst${bursts.length > 1 ? "s" : ""} detected — simultaneous failures across all targets indicate client-side internet loss, not target-specific issues.`
      );
    }

    const latencyAlerts = data.alert_summary.find((a) => a.type === "high_latency");
    if (latencyAlerts && latencyAlerts.count > 10) {
      findings.push(
        `${latencyAlerts.count} high-latency alerts — chronic threshold breaches averaging ${fmt(latencyAlerts.avg_value)} (max ${fmt(latencyAlerts.max_value)}).`
      );
    }

    if (data.full_speed_tests?.length >= 2) {
      const dls = data.full_speed_tests.map((t) => t.download_mbps);
      const maxDl = Math.max(...dls);
      const minDl = Math.min(...dls);
      if (maxDl > 0 && minDl / maxDl < 0.5) {
        findings.push(
          `Speed varies significantly — download ranges from ${minDl.toFixed(0)} to ${maxDl.toFixed(0)} Mbps, suggesting time-of-day congestion.`
        );
      }
    }

    if (parseFloat(lossPct) === 0 && totalAlerts <= 5 && (data.outage_events?.length ?? 0) === 0) {
      findings.push("Connection is healthy — zero packet loss, minimal alerts, no outages.");
    }

    return findings;
  }, [data, asymmetryRatio, cfTo, toCf, bursts, lossPct, totalAlerts]);

  const pageIdx = PAGES.findIndex((p) => p.id === page);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900/50 p-1">
        {PAGES.map((p) => (
          <button
            key={p.id}
            onClick={() => setPage(p.id)}
            className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              page === p.id
                ? "bg-zinc-700 text-zinc-100"
                : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {page === "overview" && (
        <>
          <Section title={`Deep Analysis: ${client.name}${client.location ? ` (${client.location})` : ""}`}>
            <div className="grid grid-cols-1 gap-x-8 gap-y-1 text-sm sm:grid-cols-2">
              <div>
                <span className="text-zinc-500">Client: </span>
                <span className="font-mono text-zinc-400 text-xs">{client.id}</span>
              </div>
              <div>
                <span className="text-zinc-500">Version: </span>
                <span className="text-zinc-300">{client.client_version || "—"}</span>
              </div>
              <div>
                <span className="text-zinc-500">Created: </span>
                <span className="text-zinc-300">{fmtTs(client.created_at)}</span>
              </div>
              <div>
                <span className="text-zinc-500">Last seen: </span>
                <span className="text-zinc-300">{fmtTs(client.last_seen)}</span>
              </div>
              <div className="sm:col-span-2">
                <span className="text-zinc-500">Config: </span>
                <span className="text-zinc-400 text-xs">
                  {client.config.ping_interval_s}s ping interval,{" "}
                  {client.config.speed_test_interval_s}s probe speed tests,{" "}
                  full speed test {client.config.full_test_schedule},{" "}
                  alert threshold {client.config.alert_latency_threshold_ms}ms latency / {client.config.alert_loss_threshold_pct}% loss
                </span>
              </div>
            </div>
          </Section>

          <Section title={`Ping Latency (${totalOkPings.toLocaleString()} total pings — ${lossPct}% packet loss)`}>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-zinc-800">
                    <th className={TH}>Direction</th>
                    <th className={TH_R}>Count</th>
                    <th className={TH_R}>Avg</th>
                    <th className={TH_R}>Min</th>
                    <th className={TH_R}>Max</th>
                    <th className={TH_R}>Avg Jitter</th>
                  </tr>
                </thead>
                <tbody>
                  {cfTo && (
                    <tr className="border-b border-zinc-800/50">
                      <td className={TD}>CF → Client</td>
                      <td className={TD_R}>{cfTo.count.toLocaleString()}</td>
                      <td className={TD_R}>{fmt(cfTo.avg_rtt)}</td>
                      <td className={TD_R}>{fmt(cfTo.min_rtt)}</td>
                      <td className={TD_R}>{fmt(cfTo.max_rtt)}</td>
                      <td className={TD_R}>{fmt(cfTo.avg_jitter)}</td>
                    </tr>
                  )}
                  {toCf && (
                    <tr className="border-b border-zinc-800/50">
                      <td className={TD}>Client → CF</td>
                      <td className={TD_R}>{toCf.count.toLocaleString()}</td>
                      <td className={TD_R}>{fmt(toCf.avg_rtt)}</td>
                      <td className={TD_R}>{fmt(toCf.min_rtt)}</td>
                      <td className={TD_R}>{fmt(toCf.max_rtt)}</td>
                      <td className={TD_R}>{fmt(toCf.avg_jitter)}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {asymmetryRatio && parseFloat(asymmetryRatio) > 1.3 && (
              <p className="mt-2 text-xs text-amber-400/80">
                Asymmetry: upstream (Client→CF) is {asymmetryRatio}x slower than downstream (CF→Client).
              </p>
            )}
          </Section>

          {findings.length > 0 && (
            <Section title="Key Findings">
              <ol className="list-decimal list-inside space-y-2">
                {findings.map((f, i) => (
                  <li key={i} className="text-sm text-zinc-300 leading-relaxed">
                    {f}
                  </li>
                ))}
              </ol>
            </Section>
          )}
        </>
      )}

      {page === "latency" && (
        <>
          {(cfToDist.length > 0 || toCfDist.length > 0) && (
            <div className="grid gap-4 lg:grid-cols-2">
              {cfToDist.length > 0 && (
                <LatencyDistTable title="Latency Distribution — CF → Client" color="bg-emerald-500" dist={cfToDist} />
              )}
              {toCfDist.length > 0 && (
                <LatencyDistTable title="Latency Distribution — Client → CF" color="bg-blue-500" dist={toCfDist} />
              )}
            </div>
          )}

          {hourlyRows.length > 0 && (
            <Section title="Hourly Pattern">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-zinc-800">
                      <th className={TH}>Hour</th>
                      <th className={TH_R}>CF→Client</th>
                      <th className={TH_R}>Client→CF</th>
                      <th className={TH_R}>Samples</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hourlyRows.map(([hour, vals]) => {
                      const toCfRtt = vals.toCf ?? 0;
                      const highUpstream = toCfRtt > 150;
                      return (
                        <tr key={hour} className={`border-b border-zinc-800/50 ${highUpstream ? "bg-amber-950/20" : ""}`}>
                          <td className={TD}>{hour}</td>
                          <td className={TD_R}>{fmt(vals.cfTo)}</td>
                          <td className={`${TD_R} ${highUpstream ? "text-amber-400" : ""}`}>{fmt(vals.toCf)}</td>
                          <td className={TD_MUTED + " text-right"}>{((vals.cfToCount ?? 0) + (vals.toCfCount ?? 0)).toLocaleString()}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Section>
          )}

          {cfToDist.length === 0 && toCfDist.length === 0 && hourlyRows.length === 0 && (
            <Section title="Latency">
              <p className="text-sm text-zinc-500">No latency distribution or hourly data available.</p>
            </Section>
          )}
        </>
      )}

      {page === "reliability" && (
        <>
          {data.outage_events && data.outage_events.length > 0 && (
            <Section title={`Outage Events (${data.outage_events.length})`}>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-zinc-800">
                      <th className={TH}>Start</th>
                      <th className={TH}>End</th>
                      <th className={TH_R}>Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.outage_events.map((o, i) => (
                      <tr key={i} className="border-b border-zinc-800/50">
                        <td className={TD}>{fmtTs(o.start_ts)}</td>
                        <td className={TD}>{o.end_ts ? fmtTs(o.end_ts) : <span className="text-red-400">ongoing</span>}</td>
                        <td className={TD_R}>{fmtDuration(o.duration_s)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          )}

          {bursts.length > 0 && (
            <Section title={`Probe Error Bursts (${bursts.length})`}>
              <div className="space-y-3">
                {bursts.map((b, i) => (
                  <div key={i} className="rounded border border-amber-800/50 bg-amber-950/20 p-3">
                    <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                      <div>
                        <span className="text-zinc-500">Window: </span>
                        <span className="font-mono text-zinc-300">
                          {new Date(b.start).toLocaleTimeString()} — {new Date(b.end).toLocaleTimeString()}
                        </span>
                        <span className="ml-2 text-zinc-500">({fmtDuration((b.end - b.start) / 1000)})</span>
                      </div>
                      <div>
                        <span className="text-zinc-500">Errors: </span>
                        <span className="font-mono text-amber-400">{b.count}</span>
                      </div>
                    </div>
                    <div className="mt-1 text-xs text-zinc-500">
                      Targets: {b.targets.join(", ")}
                    </div>
                    {b.targets.length >= 3 && (
                      <p className="mt-1 text-xs text-amber-400/70">
                        All targets failed simultaneously — indicates total internet loss at the client.
                      </p>
                    )}
                  </div>
                ))}
              </div>

              {probeErrors.length > 0 && (
                <div className="mt-4">
                  <h4 className="mb-2 text-xs font-medium text-zinc-500">Error Totals by Target</h4>
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-zinc-800">
                          <th className={TH}>Type</th>
                          <th className={TH}>Target</th>
                          <th className={TH}>Status</th>
                          <th className={TH_R}>Count</th>
                        </tr>
                      </thead>
                      <tbody>
                        {probeErrors.map((p, i) => (
                          <tr key={i} className="border-b border-zinc-800/50">
                            <td className={TD}>{p.probe_type}</td>
                            <td className="px-3 py-2 text-sm font-mono text-zinc-400">{p.target}</td>
                            <td className={`px-3 py-2 text-sm font-medium ${p.status === "timeout" ? "text-amber-400" : "text-red-400"}`}>
                              {p.status}
                            </td>
                            <td className={TD_R}>{p.count}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </Section>
          )}

          {(!data.outage_events || data.outage_events.length === 0) && bursts.length === 0 && (
            <Section title="Reliability">
              <p className="text-sm text-emerald-400">No outages or error bursts detected in this period.</p>
            </Section>
          )}
        </>
      )}

      {page === "speed" && (
        <>
          {data.alert_summary.length > 0 && (
            <Section title={`Alerts Summary (${totalAlerts} total)`}>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-zinc-800">
                      <th className={TH}>Type</th>
                      <th className={TH}>Severity</th>
                      <th className={TH_R}>Count</th>
                      <th className={TH}>Period</th>
                      <th className={TH_R}>Avg Value</th>
                      <th className={TH_R}>Max Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.alert_summary.map((a, i) => (
                      <tr key={i} className="border-b border-zinc-800/50">
                        <td className={TD}>{a.type.replace(/_/g, " ")}</td>
                        <td className={`px-3 py-2 text-sm font-medium ${
                          a.severity === "critical" ? "text-red-400" : a.severity === "warning" ? "text-amber-400" : "text-blue-400"
                        }`}>
                          {a.severity}
                        </td>
                        <td className={TD_R}>{a.count}</td>
                        <td className="px-3 py-2 text-xs font-mono text-zinc-500">
                          {fmtTs(a.first_alert)} → {fmtTs(a.last_alert)}
                        </td>
                        <td className={TD_R}>{fmt(a.avg_value)}</td>
                        <td className={TD_R}>{fmt(a.max_value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          )}

          {(data.full_speed_tests?.length > 0 || data.speed_test_stats.length > 0) && (
            <Section title="Speed Tests">
              {data.full_speed_tests && data.full_speed_tests.length > 0 && (
                <div className="mb-4">
                  <h4 className="mb-2 text-xs font-medium text-zinc-500">
                    Full Tests ({data.full_speed_tests.length})
                  </h4>
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-zinc-800">
                          <th className={TH}>Time</th>
                          <th className={TH_R}>Download</th>
                          <th className={TH_R}>Upload</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.full_speed_tests.map((t, i) => (
                          <tr key={i} className="border-b border-zinc-800/50">
                            <td className={TD}>{fmtTs(t.timestamp)}</td>
                            <td className={TD_R}>{t.download_mbps.toFixed(0)} Mbps</td>
                            <td className={TD_R}>{t.upload_mbps.toFixed(0)} Mbps</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {data.speed_test_stats.length > 0 && (
                <div>
                  <h4 className="mb-2 text-xs font-medium text-zinc-500">Aggregate by Type</h4>
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-zinc-800">
                          <th className={TH}>Type</th>
                          <th className={TH_R}>Count</th>
                          <th className={TH_R}>Avg DL</th>
                          <th className={TH_R}>Min DL</th>
                          <th className={TH_R}>Max DL</th>
                          <th className={TH_R}>Avg UL</th>
                          <th className={TH_R}>Min UL</th>
                          <th className={TH_R}>Max UL</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.speed_test_stats.map((s, i) => (
                          <tr key={i} className="border-b border-zinc-800/50">
                            <td className={TD}>{s.type}</td>
                            <td className={TD_R}>{s.count.toLocaleString()}</td>
                            <td className={TD_R}>{s.avg_dl.toFixed(1)} Mbps</td>
                            <td className={TD_R}>{s.min_dl.toFixed(1)}</td>
                            <td className={TD_R}>{s.max_dl.toFixed(1)}</td>
                            <td className={TD_R}>{s.avg_ul.toFixed(1)} Mbps</td>
                            <td className={TD_R}>{s.min_ul.toFixed(1)}</td>
                            <td className={TD_R}>{s.max_ul.toFixed(1)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </Section>
          )}

          {data.alert_summary.length === 0 && (data.full_speed_tests?.length ?? 0) === 0 && data.speed_test_stats.length === 0 && (
            <Section title="Speed & Alerts">
              <p className="text-sm text-zinc-500">No speed test or alert data available.</p>
            </Section>
          )}
        </>
      )}

      <div className="flex items-center justify-between pt-2">
        <button
          onClick={() => { const prev = PAGES[pageIdx - 1]; if (prev) setPage(prev.id); }}
          disabled={pageIdx === 0}
          className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Previous
        </button>
        <span className="text-xs text-zinc-500">
          {pageIdx + 1} / {PAGES.length}
        </span>
        <button
          onClick={() => { const next = PAGES[pageIdx + 1]; if (next) setPage(next.id); }}
          disabled={pageIdx === PAGES.length - 1}
          className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Next
        </button>
      </div>
    </div>
  );
});

interface PingStat {
  direction: string;
  status: string;
  count: number;
  avg_rtt: number;
  min_rtt: number;
  max_rtt: number;
  avg_jitter: number;
}

interface AlertSummary {
  type: string;
  severity: string;
  count: number;
  first_alert: string;
  last_alert: string;
  avg_value: number;
  max_value: number;
}

interface SpeedStat {
  type: string;
  count: number;
  avg_dl: number;
  min_dl: number;
  max_dl: number;
  avg_ul: number;
  min_ul: number;
  max_ul: number;
}

interface RecordCount {
  tbl: string;
  cnt: number;
}

function fmtDate(iso: string): string {
  return iso.replace("T", " ").replace(/\.\d+Z$/, " UTC").replace("Z", " UTC");
}

export function formatTelegramReport(
  clientName: string,
  from: string,
  to: string,
  data: Record<string, unknown[]>
): string {
  const pings = (data.ping_stats || []) as PingStat[];
  const cfTo = pings.find((p) => p.direction === "cf_to_client" && p.status === "ok");
  const toCf = pings.find((p) => p.direction === "client_to_cf" && p.status === "ok");
  const alerts = (data.alert_summary || []) as AlertSummary[];
  const totalAlerts = alerts.reduce((sum, a) => sum + a.count, 0);
  const alertBreakdown = alerts.map((a) => `${a.type}: ${a.count}`).join(", ");
  const speeds = (data.speed_test_stats || []) as SpeedStat[];
  const fullSpeed = speeds.find((s) => s.type === "full");
  const probeSpeed = speeds.find((s) => s.type === "probe");
  const speed = fullSpeed || probeSpeed;
  const counts = (data.record_counts || []) as RecordCount[];
  const outageCount = counts.find((c) => c.tbl === "outages")?.cnt || 0;
  const totalProbes = counts.find((c) => c.tbl === "client_probe_results")?.cnt || 0;
  const totalErrors = (data.recent_errors as unknown[])?.length || 0;
  const errorPct = totalProbes > 0 ? ((totalErrors / totalProbes) * 100).toFixed(2) : "0";

  const lines = [
    `\u{1F4CA} PingPulse Daily Report \u2014 ${clientName}`,
    `\u23F1 Period: ${fmtDate(from)} \u2192 ${fmtDate(to)}`,
    "",
    `\u{1F4E1} Latency: ${cfTo?.avg_rtt?.toFixed(1) || "N/A"}ms (CF\u2192) / ${toCf?.avg_rtt?.toFixed(1) || "N/A"}ms (\u2192CF)`,
    `\u26A1 Speed: ${speed ? `${speed.avg_dl.toFixed(0)} Mbps \u2193 / ${speed.avg_ul.toFixed(0)} Mbps \u2191` : "N/A"}`,
    `\u26A0\uFE0F Alerts: ${totalAlerts}${alertBreakdown ? ` (${alertBreakdown})` : ""}`,
    `\u274C Errors: ${totalErrors} probes failed (${errorPct}%)`,
    `\u{1F4CB} Outages: ${outageCount}`,
  ];

  return lines.join("\n");
}

export function formatEmailReport(
  clientName: string,
  from: string,
  to: string,
  data: Record<string, unknown[]>
): string {
  const pings = (data.ping_stats || []) as PingStat[];
  const alerts = (data.alert_summary || []) as AlertSummary[];
  const speeds = (data.speed_test_stats || []) as SpeedStat[];
  const probeStats = data.probe_stats as { probe_type: string; target: string; status: string; count: number; avg_rtt: number | null }[];

  const tableStyle = `style="border-collapse:collapse;width:100%;font-family:monospace;font-size:13px;"`;
  const thStyle = `style="text-align:left;padding:6px 10px;border-bottom:2px solid #333;color:#999;"`;
  const tdStyle = `style="padding:6px 10px;border-bottom:1px solid #222;color:#ddd;"`;

  let html = `<html><body style="background:#0a0a0a;color:#e4e4e7;font-family:system-ui,sans-serif;padding:20px;">`;
  html += `<h1 style="color:#fff;font-size:18px;">PingPulse Health Report \u2014 ${clientName}</h1>`;
  html += `<p style="color:#71717a;font-size:13px;">Period: ${fmtDate(from)} \u2192 ${fmtDate(to)}</p>`;

  // Ping stats
  if (pings.length > 0) {
    html += `<h2 style="color:#a1a1aa;font-size:14px;margin-top:24px;">Ping Latency</h2>`;
    html += `<table ${tableStyle}><tr><th ${thStyle}>Direction</th><th ${thStyle}>Count</th><th ${thStyle}>Avg RTT</th><th ${thStyle}>Min</th><th ${thStyle}>Max</th></tr>`;
    for (const p of pings) {
      html += `<tr><td ${tdStyle}>${p.direction}</td><td ${tdStyle}>${p.count}</td><td ${tdStyle}>${p.avg_rtt?.toFixed(1) || "N/A"}ms</td><td ${tdStyle}>${p.min_rtt}ms</td><td ${tdStyle}>${p.max_rtt}ms</td></tr>`;
    }
    html += `</table>`;
  }

  // Probe stats
  if (probeStats && probeStats.length > 0) {
    html += `<h2 style="color:#a1a1aa;font-size:14px;margin-top:24px;">Probe Results</h2>`;
    html += `<table ${tableStyle}><tr><th ${thStyle}>Type</th><th ${thStyle}>Target</th><th ${thStyle}>Status</th><th ${thStyle}>Count</th><th ${thStyle}>Avg RTT</th></tr>`;
    for (const p of probeStats) {
      html += `<tr><td ${tdStyle}>${p.probe_type}</td><td ${tdStyle}>${p.target}</td><td ${tdStyle}>${p.status}</td><td ${tdStyle}>${p.count}</td><td ${tdStyle}>${p.avg_rtt?.toFixed(1) || "N/A"}ms</td></tr>`;
    }
    html += `</table>`;
  }

  // Speed tests
  if (speeds.length > 0) {
    html += `<h2 style="color:#a1a1aa;font-size:14px;margin-top:24px;">Speed Tests</h2>`;
    html += `<table ${tableStyle}><tr><th ${thStyle}>Type</th><th ${thStyle}>Count</th><th ${thStyle}>Avg DL</th><th ${thStyle}>Max DL</th><th ${thStyle}>Avg UL</th><th ${thStyle}>Max UL</th></tr>`;
    for (const s of speeds) {
      html += `<tr><td ${tdStyle}>${s.type}</td><td ${tdStyle}>${s.count}</td><td ${tdStyle}>${s.avg_dl.toFixed(1)} Mbps</td><td ${tdStyle}>${s.max_dl.toFixed(1)} Mbps</td><td ${tdStyle}>${s.avg_ul.toFixed(1)} Mbps</td><td ${tdStyle}>${s.max_ul.toFixed(1)} Mbps</td></tr>`;
    }
    html += `</table>`;
  }

  // Alerts
  if (alerts.length > 0) {
    html += `<h2 style="color:#a1a1aa;font-size:14px;margin-top:24px;">Alert Summary</h2>`;
    html += `<table ${tableStyle}><tr><th ${thStyle}>Type</th><th ${thStyle}>Severity</th><th ${thStyle}>Count</th><th ${thStyle}>Avg Value</th><th ${thStyle}>Max Value</th></tr>`;
    for (const a of alerts) {
      html += `<tr><td ${tdStyle}>${a.type}</td><td ${tdStyle}>${a.severity}</td><td ${tdStyle}>${a.count}</td><td ${tdStyle}>${a.avg_value.toFixed(1)}</td><td ${tdStyle}>${a.max_value}</td></tr>`;
    }
    html += `</table>`;
  }

  html += `<p style="color:#52525b;font-size:11px;margin-top:32px;">Generated by PingPulse at ${new Date().toISOString()}</p>`;
  html += `</body></html>`;

  return html;
}

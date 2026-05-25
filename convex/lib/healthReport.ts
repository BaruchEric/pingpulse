// Telegram and email health-report formatting. Ported from the Worker's
// health-report service and adapted to the structured analysis object that
// analysis.runAnalysis now returns (record_counts is an object, not rows).

export interface AnalysisData {
  record_counts: {
    ping_results: number;
    probe_results: number;
    speed_tests: number;
    outages: number;
  };
  ping_stats: {
    direction: string;
    status: string;
    count: number;
    avg_rtt: number;
    min_rtt: number;
    max_rtt: number;
    avg_jitter: number;
  }[];
  probe_stats: {
    probe_type: string;
    target: string;
    status: string;
    count: number;
    avg_rtt: number | null;
  }[];
  hourly_pattern: { errors: number }[];
  speed_test_stats: {
    type: string;
    count: number;
    avg_dl: number;
    max_dl: number;
    avg_ul: number;
    max_ul: number;
  }[];
  alert_summary: {
    type: string;
    severity: string;
    count: number;
    avg_value: number;
    max_value: number;
  }[];
  outage_events: { start_ts: string; end_ts: string | null; duration_s: number | null }[];
}

function fmtDate(iso: string): string {
  return iso.replace("T", " ").replace(/\.\d+Z$/, " UTC").replace("Z", " UTC");
}

function fmtDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function fmtTime(iso: string): string {
  return iso.replace("T", " ").replace(/:\d{2}\.\d+Z$/, " UTC").replace(/:\d{2}Z$/, " UTC");
}

export function formatTelegramReport(
  clientName: string,
  from: string,
  to: string,
  data: AnalysisData,
  isDown?: boolean,
): string {
  const cfTo = data.ping_stats.find((p) => p.direction === "cf_to_client" && p.status === "ok");
  const toCf = data.ping_stats.find((p) => p.direction === "client_to_cf" && p.status === "ok");
  const totalAlerts = data.alert_summary.reduce((sum, a) => sum + a.count, 0);
  const alertBreakdown = data.alert_summary.map((a) => `${a.type}: ${a.count}`).join(", ");
  const fullSpeed = data.speed_test_stats.find((s) => s.type === "full");
  const probeSpeed = data.speed_test_stats.find((s) => s.type === "probe");
  const speed = fullSpeed || probeSpeed;
  const outageCount = data.record_counts.outages;
  const totalProbes = data.record_counts.probe_results;
  const totalErrors = data.hourly_pattern.reduce((sum, h) => sum + (h.errors ?? 0), 0);
  const errorPct = totalProbes > 0 ? ((totalErrors / totalProbes) * 100).toFixed(2) : "0";

  const statusLine = isDown ? "\u{1F534} Status: DOWN" : "\u{1F7E2} Status: Online";

  const lines = [
    `\u{1F4CA} PingPulse Daily Report — ${clientName}`,
    `⏱ Period: ${fmtDate(from)} → ${fmtDate(to)}`,
    "",
    statusLine,
    `\u{1F4E1} Latency: ${cfTo?.avg_rtt?.toFixed(1) || "N/A"}ms (CF→) / ${toCf?.avg_rtt?.toFixed(1) || "N/A"}ms (→CF)`,
    `⚡ Speed: ${speed ? `${speed.avg_dl.toFixed(0)} Mbps ↓ / ${speed.avg_ul.toFixed(0)} Mbps ↑` : "N/A"}`,
    `⚠️ Alerts: ${totalAlerts}${alertBreakdown ? ` (${alertBreakdown})` : ""}`,
    `❌ Errors: ${totalErrors} probes failed (${errorPct}%)`,
    `\u{1F4CB} Outages: ${outageCount}`,
  ];

  if (data.outage_events.length > 0) {
    lines.push("");
    lines.push("\u{1F6A8} Outage Details:");
    for (const o of data.outage_events) {
      const start = fmtTime(o.start_ts);
      const end = o.end_ts ? fmtTime(o.end_ts) : "ongoing";
      const dur = o.duration_s != null ? ` (${fmtDuration(o.duration_s)})` : "";
      lines.push(`  • ${start} → ${end}${dur}`);
    }
  }

  return lines.join("\n");
}

export function formatEmailReport(
  clientName: string,
  from: string,
  to: string,
  data: AnalysisData,
  isDown?: boolean,
): string {
  const tableStyle = `style="border-collapse:collapse;width:100%;font-family:monospace;font-size:13px;"`;
  const thStyle = `style="text-align:left;padding:6px 10px;border-bottom:2px solid #333;color:#999;"`;
  const tdStyle = `style="padding:6px 10px;border-bottom:1px solid #222;color:#ddd;"`;

  const statusColor = isDown ? "#ef4444" : "#22c55e";
  const statusText = isDown ? "DOWN" : "Online";

  let html = `<html><body style="background:#0a0a0a;color:#e4e4e7;font-family:system-ui,sans-serif;padding:20px;">`;
  html += `<h1 style="color:#fff;font-size:18px;">PingPulse Health Report — ${clientName}</h1>`;
  html += `<p style="color:#71717a;font-size:13px;">Period: ${fmtDate(from)} → ${fmtDate(to)}</p>`;
  html += `<p style="font-size:14px;font-weight:600;color:${statusColor};">● ${statusText}</p>`;

  if (data.ping_stats.length > 0) {
    html += `<h2 style="color:#a1a1aa;font-size:14px;margin-top:24px;">Ping Latency</h2>`;
    html += `<table ${tableStyle}><tr><th ${thStyle}>Direction</th><th ${thStyle}>Count</th><th ${thStyle}>Avg RTT</th><th ${thStyle}>Min</th><th ${thStyle}>Max</th></tr>`;
    for (const p of data.ping_stats) {
      html += `<tr><td ${tdStyle}>${p.direction}</td><td ${tdStyle}>${p.count}</td><td ${tdStyle}>${p.avg_rtt?.toFixed(1) || "N/A"}ms</td><td ${tdStyle}>${p.min_rtt}ms</td><td ${tdStyle}>${p.max_rtt}ms</td></tr>`;
    }
    html += `</table>`;
  }

  if (data.probe_stats.length > 0) {
    html += `<h2 style="color:#a1a1aa;font-size:14px;margin-top:24px;">Probe Results</h2>`;
    html += `<table ${tableStyle}><tr><th ${thStyle}>Type</th><th ${thStyle}>Target</th><th ${thStyle}>Status</th><th ${thStyle}>Count</th><th ${thStyle}>Avg RTT</th></tr>`;
    for (const p of data.probe_stats) {
      html += `<tr><td ${tdStyle}>${p.probe_type}</td><td ${tdStyle}>${p.target}</td><td ${tdStyle}>${p.status}</td><td ${tdStyle}>${p.count}</td><td ${tdStyle}>${p.avg_rtt?.toFixed(1) || "N/A"}ms</td></tr>`;
    }
    html += `</table>`;
  }

  if (data.speed_test_stats.length > 0) {
    html += `<h2 style="color:#a1a1aa;font-size:14px;margin-top:24px;">Speed Tests</h2>`;
    html += `<table ${tableStyle}><tr><th ${thStyle}>Type</th><th ${thStyle}>Count</th><th ${thStyle}>Avg DL</th><th ${thStyle}>Max DL</th><th ${thStyle}>Avg UL</th><th ${thStyle}>Max UL</th></tr>`;
    for (const s of data.speed_test_stats) {
      html += `<tr><td ${tdStyle}>${s.type}</td><td ${tdStyle}>${s.count}</td><td ${tdStyle}>${s.avg_dl.toFixed(1)} Mbps</td><td ${tdStyle}>${s.max_dl.toFixed(1)} Mbps</td><td ${tdStyle}>${s.avg_ul.toFixed(1)} Mbps</td><td ${tdStyle}>${s.max_ul.toFixed(1)} Mbps</td></tr>`;
    }
    html += `</table>`;
  }

  if (data.alert_summary.length > 0) {
    html += `<h2 style="color:#a1a1aa;font-size:14px;margin-top:24px;">Alert Summary</h2>`;
    html += `<table ${tableStyle}><tr><th ${thStyle}>Type</th><th ${thStyle}>Severity</th><th ${thStyle}>Count</th><th ${thStyle}>Avg Value</th><th ${thStyle}>Max Value</th></tr>`;
    for (const a of data.alert_summary) {
      html += `<tr><td ${tdStyle}>${a.type}</td><td ${tdStyle}>${a.severity}</td><td ${tdStyle}>${a.count}</td><td ${tdStyle}>${a.avg_value.toFixed(1)}</td><td ${tdStyle}>${a.max_value}</td></tr>`;
    }
    html += `</table>`;
  }

  html += `<p style="color:#52525b;font-size:11px;margin-top:32px;">Generated by PingPulse at ${new Date().toISOString()}</p>`;
  html += `</body></html>`;
  return html;
}

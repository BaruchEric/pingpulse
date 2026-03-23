export interface AnalysisQuery {
  key: string;
  sql: string;
  params: unknown[];
}

export function buildAnalysisQueries(
  clientId: string,
  from: string,
  to: string
): AnalysisQuery[] {
  return [
    {
      key: "record_counts",
      sql: `SELECT 'ping_results' as tbl, COUNT(*) as cnt FROM ping_results WHERE client_id = ? AND timestamp BETWEEN ? AND ?
            UNION ALL SELECT 'client_probe_results', COUNT(*) FROM client_probe_results WHERE client_id = ? AND timestamp BETWEEN ? AND ?
            UNION ALL SELECT 'speed_tests', COUNT(*) FROM speed_tests WHERE client_id = ? AND timestamp BETWEEN ? AND ?
            UNION ALL SELECT 'outages', COUNT(*) FROM outages WHERE client_id = ? AND start_ts BETWEEN ? AND ?`,
      params: [clientId, from, to, clientId, from, to, clientId, from, to, clientId, from, to],
    },
    {
      key: "ping_stats",
      sql: `SELECT direction, status, COUNT(*) as count, AVG(rtt_ms) as avg_rtt, MIN(rtt_ms) as min_rtt, MAX(rtt_ms) as max_rtt, AVG(jitter_ms) as avg_jitter
            FROM ping_results WHERE client_id = ? AND timestamp BETWEEN ? AND ? GROUP BY direction, status`,
      params: [clientId, from, to],
    },
    {
      key: "probe_stats",
      sql: `SELECT probe_type, target, status, COUNT(*) as count, AVG(rtt_ms) as avg_rtt, MIN(rtt_ms) as min_rtt, MAX(rtt_ms) as max_rtt
            FROM client_probe_results WHERE client_id = ? AND timestamp BETWEEN ? AND ? GROUP BY probe_type, target, status`,
      params: [clientId, from, to],
    },
    {
      key: "hourly_pattern",
      sql: `SELECT strftime('%Y-%m-%d %H:00', datetime(timestamp/1000, 'unixepoch')) as hour, COUNT(*) as count,
            AVG(rtt_ms) as avg_rtt, MAX(rtt_ms) as max_rtt, SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END) as errors
            FROM client_probe_results WHERE client_id = ? AND timestamp BETWEEN ? AND ? GROUP BY hour ORDER BY hour`,
      params: [clientId, from, to],
    },
    {
      key: "direction_asymmetry",
      sql: `SELECT strftime('%H:00', timestamp) as hour, direction, AVG(rtt_ms) as avg_rtt, COUNT(*) as count
            FROM ping_results WHERE client_id = ? AND timestamp BETWEEN ? AND ? GROUP BY hour, direction ORDER BY hour, direction`,
      params: [clientId, from, to],
    },
    {
      key: "speed_test_stats",
      sql: `SELECT type, COUNT(*) as count, AVG(download_mbps) as avg_dl, MIN(download_mbps) as min_dl, MAX(download_mbps) as max_dl,
            AVG(upload_mbps) as avg_ul, MIN(upload_mbps) as min_ul, MAX(upload_mbps) as max_ul
            FROM speed_tests WHERE client_id = ? AND timestamp BETWEEN ? AND ? GROUP BY type`,
      params: [clientId, from, to],
    },
    {
      key: "alert_summary",
      sql: `SELECT type, severity, COUNT(*) as count, MIN(timestamp) as first_alert, MAX(timestamp) as last_alert,
            AVG(value) as avg_value, MAX(value) as max_value
            FROM alerts WHERE client_id = ? AND timestamp BETWEEN ? AND ? GROUP BY type, severity`,
      params: [clientId, from, to],
    },
    {
      key: "recent_errors",
      sql: `SELECT timestamp, probe_type, target, status FROM client_probe_results
            WHERE client_id = ? AND status != 'ok' AND timestamp BETWEEN ? AND ? ORDER BY timestamp DESC LIMIT 50`,
      params: [clientId, from, to],
    },
  ];
}

export async function runAnalysis(
  db: D1Database,
  clientId: string,
  from: string,
  to: string
): Promise<Record<string, unknown[]>> {
  const queries = buildAnalysisQueries(clientId, from, to);
  const results = await Promise.all(
    queries.map((q) => db.prepare(q.sql).bind(...q.params).all())
  );

  const output: Record<string, unknown[]> = {};
  queries.forEach((q, i) => {
    output[q.key] = results[i]!.results ?? [];
  });
  return output;
}

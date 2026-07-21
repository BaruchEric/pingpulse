-- Path traces (traceroute/mtr-style) produced by the client via trippy-core.
-- One row per trace run; one row per hop in trace_hops.

CREATE TABLE IF NOT EXISTS traces (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  target TEXT NOT NULL,
  protocol TEXT NOT NULL DEFAULT 'icmp',
  started_at TEXT NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'manual',
  received_at TEXT NOT NULL,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_traces_client ON traces(client_id, started_at);

CREATE TABLE IF NOT EXISTS trace_hops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id TEXT NOT NULL,
  ttl INTEGER NOT NULL,
  addr TEXT,
  -- Enrichment columns (populated in Phase 2: ASN / GeoIP / reverse-DNS)
  hostname TEXT,
  asn INTEGER,
  asn_name TEXT,
  geo TEXT,
  loss_pct REAL,
  samples INTEGER,
  last_ms REAL,
  avg_ms REAL,
  best_ms REAL,
  worst_ms REAL,
  stddev_ms REAL,
  jitter_ms REAL,
  FOREIGN KEY (trace_id) REFERENCES traces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_trace_hops_trace ON trace_hops(trace_id, ttl);

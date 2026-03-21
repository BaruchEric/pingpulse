CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  secret_hash TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  last_seen TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS registration_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_by_client_id TEXT
);

CREATE TABLE IF NOT EXISTS admin (
  id INTEGER PRIMARY KEY,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ping_results (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  rtt_ms REAL NOT NULL,
  jitter_ms REAL NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('cf_to_client', 'client_to_cf')),
  status TEXT NOT NULL CHECK (status IN ('ok', 'timeout', 'error')),
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ping_results_client_ts ON ping_results(client_id, timestamp);

CREATE TABLE IF NOT EXISTS speed_tests (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('probe', 'full')),
  download_mbps REAL NOT NULL,
  upload_mbps REAL NOT NULL,
  payload_bytes INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_speed_tests_client_ts ON speed_tests(client_id, timestamp);

CREATE TABLE IF NOT EXISTS outages (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  start_ts TEXT NOT NULL,
  end_ts TEXT,
  duration_s REAL,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_outages_client ON outages(client_id, start_ts);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
  value REAL NOT NULL,
  threshold REAL NOT NULL,
  delivered_email INTEGER NOT NULL DEFAULT 0,
  delivered_telegram INTEGER NOT NULL DEFAULT 0,
  timestamp TEXT NOT NULL,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_alerts_client_ts ON alerts(client_id, timestamp);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL
);

CREATE TABLE client_probe_results (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id     TEXT    NOT NULL,
    session_id    TEXT    NOT NULL,
    seq_id        INTEGER NOT NULL,
    probe_type    TEXT    NOT NULL CHECK (probe_type IN ('icmp', 'http')),
    target        TEXT    NOT NULL,
    timestamp     INTEGER NOT NULL,
    rtt_ms        REAL,
    status_code   INTEGER,
    status        TEXT    NOT NULL CHECK (status IN ('ok', 'timeout', 'error')),
    jitter_ms     REAL,
    received_at   INTEGER NOT NULL,
    UNIQUE(client_id, session_id, seq_id)
);

CREATE INDEX idx_client_probes_client_ts ON client_probe_results (client_id, timestamp);
CREATE INDEX idx_client_probes_client_type ON client_probe_results (client_id, probe_type, timestamp);

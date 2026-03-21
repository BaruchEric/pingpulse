#![allow(dead_code)]

use anyhow::Result;
use rusqlite::Connection;
use std::path::Path;
use uuid::Uuid;

/// Thread-safe wrapper. `rusqlite::Connection` is not `Send`, so we use
/// `Arc<Mutex<>>` to share across tokio tasks.
pub struct ProbeStore {
    conn: std::sync::Arc<std::sync::Mutex<Connection>>,
    session_id: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ProbeRecord {
    pub seq_id: i64,
    pub probe_type: String, // "icmp" | "http"
    pub target: String,
    pub timestamp: i64, // unix millis
    pub rtt_ms: Option<f64>,
    pub status_code: Option<i32>,
    pub status: String, // "ok" | "timeout" | "error"
    pub jitter_ms: Option<f64>,
}

impl ProbeStore {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS probe_results (
                seq_id        INTEGER PRIMARY KEY AUTOINCREMENT,
                probe_type    TEXT    NOT NULL,
                target        TEXT    NOT NULL,
                timestamp     INTEGER NOT NULL,
                rtt_ms        REAL,
                status_code   INTEGER,
                status        TEXT    NOT NULL,
                jitter_ms     REAL,
                synced        INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS sync_state (
                key   TEXT PRIMARY KEY,
                value TEXT
            );",
        )?;

        let session_id = Self::get_or_create_session_id(&conn)?;

        Ok(Self {
            conn: std::sync::Arc::new(std::sync::Mutex::new(conn)),
            session_id,
        })
    }

    /// Clone the Arc for sharing across tasks. Both handles share the same
    /// underlying `Mutex<Connection>`.
    pub fn clone_handle(&self) -> Self {
        Self {
            conn: self.conn.clone(),
            session_id: self.session_id.clone(),
        }
    }

    fn get_or_create_session_id(conn: &Connection) -> Result<String> {
        let existing: Option<String> = conn
            .query_row(
                "SELECT value FROM sync_state WHERE key = 'session_id'",
                [],
                |row| row.get(0),
            )
            .ok();

        if let Some(id) = existing {
            Ok(id)
        } else {
            let id = Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO sync_state (key, value) VALUES ('session_id', ?1)",
                [&id],
            )?;
            Ok(id)
        }
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn insert_probe(&self, record: &ProbeRecord) -> Result<i64> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock poisoned: {e}"))?;
        conn.execute(
            "INSERT INTO probe_results (probe_type, target, timestamp, rtt_ms, status_code, status, jitter_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                record.probe_type,
                record.target,
                record.timestamp,
                record.rtt_ms,
                record.status_code,
                record.status,
                record.jitter_ms,
            ],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn get_unsynced(&self, limit: usize) -> Result<Vec<ProbeRecord>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock poisoned: {e}"))?;
        let mut stmt = conn.prepare(
            "SELECT seq_id, probe_type, target, timestamp, rtt_ms, status_code, status, jitter_ms
             FROM probe_results WHERE synced = 0 ORDER BY seq_id LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit as i64], |row| {
            Ok(ProbeRecord {
                seq_id: row.get(0)?,
                probe_type: row.get(1)?,
                target: row.get(2)?,
                timestamp: row.get(3)?,
                rtt_ms: row.get(4)?,
                status_code: row.get(5)?,
                status: row.get(6)?,
                jitter_ms: row.get(7)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn mark_synced(&self, seq_ids: &[i64]) -> Result<()> {
        if seq_ids.is_empty() {
            return Ok(());
        }
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock poisoned: {e}"))?;
        let placeholders: Vec<String> = seq_ids.iter().map(|_| "?".to_string()).collect();
        let sql = format!(
            "UPDATE probe_results SET synced = 1 WHERE seq_id IN ({})",
            placeholders.join(",")
        );
        let params: Vec<Box<dyn rusqlite::types::ToSql>> = seq_ids
            .iter()
            .map(|id| Box::new(*id) as Box<dyn rusqlite::types::ToSql>)
            .collect();
        conn.execute(
            &sql,
            rusqlite::params_from_iter(params.iter().map(std::convert::AsRef::as_ref)),
        )?;
        Ok(())
    }

    pub fn cleanup_old(&self, retention_days: u32) -> Result<usize> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("lock poisoned: {e}"))?;
        let cutoff_ms =
            chrono::Utc::now().timestamp_millis() - (i64::from(retention_days) * 24 * 60 * 60 * 1000);
        let deleted = conn.execute(
            "DELETE FROM probe_results WHERE timestamp < ?1 AND synced = 1",
            [cutoff_ms],
        )?;
        Ok(deleted)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn test_store() -> (ProbeStore, TempDir) {
        let dir = TempDir::new().unwrap();
        let store = ProbeStore::open(&dir.path().join("test.db")).unwrap();
        (store, dir)
    }

    #[test]
    fn test_session_id_persists() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.db");
        let id1 = ProbeStore::open(&path).unwrap().session_id().to_string();
        let id2 = ProbeStore::open(&path).unwrap().session_id().to_string();
        assert_eq!(id1, id2);
    }

    #[test]
    fn test_new_db_gets_new_session_id() {
        let (store1, _d1) = test_store();
        let (store2, _d2) = test_store();
        assert_ne!(store1.session_id(), store2.session_id());
    }

    #[test]
    fn test_insert_and_query_unsynced() {
        let (store, _dir) = test_store();
        let record = ProbeRecord {
            seq_id: 0,
            probe_type: "icmp".into(),
            target: "8.8.8.8".into(),
            timestamp: 1_234_567_890_000,
            rtt_ms: Some(15.5),
            status_code: None,
            status: "ok".into(),
            jitter_ms: Some(2.1),
        };
        store.insert_probe(&record).unwrap();
        let unsynced = store.get_unsynced(100).unwrap();
        assert_eq!(unsynced.len(), 1);
        assert_eq!(unsynced[0].probe_type, "icmp");
        assert_eq!(unsynced[0].target, "8.8.8.8");
    }

    #[test]
    fn test_mark_synced() {
        let (store, _dir) = test_store();
        let record = ProbeRecord {
            seq_id: 0,
            probe_type: "icmp".into(),
            target: "8.8.8.8".into(),
            timestamp: 1_234_567_890_000,
            rtt_ms: Some(15.5),
            status_code: None,
            status: "ok".into(),
            jitter_ms: None,
        };
        let id = store.insert_probe(&record).unwrap();
        store.mark_synced(&[id]).unwrap();
        let unsynced = store.get_unsynced(100).unwrap();
        assert_eq!(unsynced.len(), 0);
    }

    #[test]
    fn test_cleanup_respects_synced() {
        let (store, _dir) = test_store();
        let old_ts = chrono::Utc::now().timestamp_millis() - (8 * 24 * 60 * 60 * 1000);
        let record = ProbeRecord {
            seq_id: 0,
            probe_type: "icmp".into(),
            target: "8.8.8.8".into(),
            timestamp: old_ts,
            rtt_ms: Some(10.0),
            status_code: None,
            status: "ok".into(),
            jitter_ms: None,
        };
        store.insert_probe(&record).unwrap();

        let deleted = store.cleanup_old(7).unwrap();
        assert_eq!(deleted, 0);

        let unsynced = store.get_unsynced(100).unwrap();
        store.mark_synced(&[unsynced[0].seq_id]).unwrap();
        let deleted = store.cleanup_old(7).unwrap();
        assert_eq!(deleted, 1);
    }
}

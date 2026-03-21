use anyhow::Result;
use reqwest::Client as HttpClient;
use tracing::{debug, info, warn};

use crate::store::{ProbeRecord, ProbeStore};

#[derive(Debug, serde::Serialize)]
struct SyncBatch {
    session_id: String,
    records: Vec<ProbeRecord>,
}

#[derive(Debug, serde::Deserialize)]
struct SyncResponse {
    acked_seq: i64,
    #[serde(default)]
    throttle_ms: Option<u64>,
}

pub struct SyncClient {
    http: HttpClient,
    base_url: String,
    client_id: String,
    client_secret: String,
    batch_size: usize,
}

impl SyncClient {
    pub fn new(base_url: &str, client_id: &str, client_secret: &str, batch_size: usize) -> Self {
        Self {
            http: HttpClient::new(),
            base_url: base_url.trim_end_matches('/').to_string(),
            client_id: client_id.to_string(),
            client_secret: client_secret.to_string(),
            batch_size,
        }
    }

    /// Drain all unsynced records to the server. Returns total records synced.
    pub async fn sync_all(&self, store: &ProbeStore) -> Result<usize> {
        let mut total_synced = 0;

        loop {
            let unsynced = store.get_unsynced(self.batch_size)?;
            if unsynced.is_empty() {
                break;
            }

            let seq_ids: Vec<i64> = unsynced.iter().map(|r| r.seq_id).collect();
            let batch_len = unsynced.len();

            let batch = SyncBatch {
                session_id: store.session_id().to_string(),
                records: unsynced,
            };

            let url = format!("{}/api/clients/{}/sync", self.base_url, self.client_id);
            let resp = self.http
                .post(&url)
                .header("Authorization", format!("Bearer {}", self.client_secret))
                .json(&batch)
                .send()
                .await?;

            if !resp.status().is_success() {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                warn!(status = %status, body, "Sync request failed");
                anyhow::bail!("Sync failed with status {status}");
            }

            let sync_resp: SyncResponse = resp.json().await?;
            store.mark_synced(&seq_ids)?;
            total_synced += batch_len;

            info!(synced = batch_len, total = total_synced, acked_seq = sync_resp.acked_seq, "Sync batch complete");

            if let Some(throttle) = sync_resp.throttle_ms {
                debug!(throttle_ms = throttle, "Server requested throttle");
                tokio::time::sleep(tokio::time::Duration::from_millis(throttle)).await;
            }

            if batch_len < self.batch_size {
                break;
            }
        }

        Ok(total_synced)
    }
}

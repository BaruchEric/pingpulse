use std::time::{Duration, Instant};

use reqwest::Client;
use tracing::info;

use crate::messages::{SpeedTestResult, SpeedTestType};

#[allow(clippy::cast_precision_loss)]
fn bytes_to_mbps(bytes: u64, elapsed: Duration) -> f64 {
    (bytes as f64 * 8.0) / (elapsed.as_secs_f64() * 1_000_000.0)
}

fn log_result(result: &SpeedTestResult) {
    let test_type = match result.test_type {
        SpeedTestType::Probe => "probe",
        SpeedTestType::Full => "full",
    };
    info!(
        event = "speed_test_complete",
        test_type,
        download_mbps = result.download_mbps,
        upload_mbps = result.upload_mbps,
        duration_ms = result.duration_ms,
    );
}

/// Run a probe speed test: single sequential download + upload.
pub async fn run_probe(
    http: &Client,
    base_url: &str,
    client_id: &str,
    payload_size: u64,
) -> anyhow::Result<SpeedTestResult> {
    info!(
        event = "speed_test_start",
        test_type = "probe",
        payload_bytes = payload_size
    );

    let start = Instant::now();

    // Download
    let download_url = format!("{base_url}/api/speedtest/download?size={payload_size}");
    let dl_start = Instant::now();
    let dl_bytes = http.get(&download_url).send().await?.bytes().await?;
    let dl_elapsed = dl_start.elapsed();
    #[allow(clippy::cast_possible_truncation)]
    let download_mbps = bytes_to_mbps(dl_bytes.len() as u64, dl_elapsed);

    // Upload — allocate before starting the timer
    let upload_url = format!("{base_url}/api/speedtest/upload");
    #[allow(clippy::cast_possible_truncation)]
    let payload = vec![0u8; payload_size as usize];
    let ul_start = Instant::now();
    http.post(&upload_url).body(payload).send().await?;
    let ul_elapsed = ul_start.elapsed();
    let upload_mbps = bytes_to_mbps(payload_size, ul_elapsed);

    let total_elapsed = start.elapsed();

    let result = SpeedTestResult {
        client_id: client_id.to_string(),
        timestamp: chrono::Utc::now().to_rfc3339(),
        test_type: SpeedTestType::Probe,
        download_mbps,
        upload_mbps,
        payload_bytes: payload_size,
        #[allow(clippy::cast_possible_truncation)]
        duration_ms: total_elapsed.as_millis() as u64,
    };

    log_result(&result);
    Ok(result)
}

/// Run a full speed test: 4 parallel connections for download, then 4 for upload.
pub async fn run_full(
    http: &Client,
    base_url: &str,
    client_id: &str,
    total_payload: u64,
) -> anyhow::Result<SpeedTestResult> {
    const STREAMS: u64 = 4;
    let chunk_size = total_payload / STREAMS;

    info!(
        event = "speed_test_start",
        test_type = "full",
        payload_bytes = total_payload
    );

    let start = Instant::now();

    // Parallel download
    let download_url = format!("{base_url}/api/speedtest/download?size={chunk_size}");
    let dl_start = Instant::now();
    let dl_tasks: Vec<_> = (0..STREAMS)
        .map(|_| {
            let http = http.clone();
            let url = download_url.clone();
            tokio::spawn(async move {
                let resp = http.get(&url).send().await?;
                let bytes = resp.bytes().await?;
                Ok::<usize, anyhow::Error>(bytes.len())
            })
        })
        .collect();

    let mut total_dl_bytes = 0usize;
    for task in dl_tasks {
        total_dl_bytes += task.await??;
    }
    let dl_elapsed = dl_start.elapsed();
    #[allow(clippy::cast_possible_truncation)]
    let download_mbps = bytes_to_mbps(total_dl_bytes as u64, dl_elapsed);

    // Parallel upload
    let upload_url = format!("{base_url}/api/speedtest/upload");
    let ul_start = Instant::now();
    let ul_tasks: Vec<_> = (0..STREAMS)
        .map(|_| {
            let http = http.clone();
            let url = upload_url.clone();
            #[allow(clippy::cast_possible_truncation)]
            let payload = vec![0u8; chunk_size as usize];
            tokio::spawn(async move {
                http.post(&url).body(payload).send().await?;
                Ok::<(), anyhow::Error>(())
            })
        })
        .collect();

    for task in ul_tasks {
        task.await??;
    }
    let ul_elapsed = ul_start.elapsed();
    let upload_mbps = bytes_to_mbps(total_payload, ul_elapsed);

    let total_elapsed = start.elapsed();

    let result = SpeedTestResult {
        client_id: client_id.to_string(),
        timestamp: chrono::Utc::now().to_rfc3339(),
        test_type: SpeedTestType::Full,
        download_mbps,
        upload_mbps,
        payload_bytes: total_payload,
        #[allow(clippy::cast_possible_truncation)]
        duration_ms: total_elapsed.as_millis() as u64,
    };

    log_result(&result);
    Ok(result)
}

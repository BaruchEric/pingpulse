use std::time::Instant;

use reqwest::Client;
use tracing::info;

use crate::messages::{SpeedTestResult, SpeedTestType};

/// Run a probe speed test: single sequential download + upload.
pub async fn run_probe(
    http: &Client,
    base_url: &str,
    client_id: &str,
    payload_size: u64,
) -> anyhow::Result<SpeedTestResult> {
    info!(event = "speed_test_start", test_type = "probe", payload_bytes = payload_size);

    let start = Instant::now();

    // Download
    let download_url = format!("{base_url}/api/speedtest/download?size={payload_size}");
    let dl_start = Instant::now();
    let dl_bytes = http.get(&download_url).send().await?.bytes().await?;
    let dl_elapsed = dl_start.elapsed();
    let download_mbps = (dl_bytes.len() as f64 * 8.0) / (dl_elapsed.as_secs_f64() * 1_000_000.0);

    // Upload
    let upload_url = format!("{base_url}/api/speedtest/upload");
    let ul_start = Instant::now();
    let payload = vec![0u8; payload_size as usize];
    http.post(&upload_url).body(payload).send().await?;
    let ul_elapsed = ul_start.elapsed();
    let upload_mbps = (payload_size as f64 * 8.0) / (ul_elapsed.as_secs_f64() * 1_000_000.0);

    let total_elapsed = start.elapsed();

    let result = SpeedTestResult {
        client_id: client_id.to_string(),
        timestamp: chrono::Local::now().to_rfc3339(),
        test_type: SpeedTestType::Probe,
        download_mbps,
        upload_mbps,
        payload_bytes: payload_size,
        duration_ms: total_elapsed.as_millis() as u64,
    };

    info!(
        event = "speed_test_complete",
        test_type = "probe",
        download_mbps = format!("{:.1}", result.download_mbps),
        upload_mbps = format!("{:.1}", result.upload_mbps),
        duration_ms = result.duration_ms,
    );

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

    info!(event = "speed_test_start", test_type = "full", payload_bytes = total_payload);

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
    let download_mbps = (total_dl_bytes as f64 * 8.0) / (dl_elapsed.as_secs_f64() * 1_000_000.0);

    // Parallel upload
    let upload_url = format!("{base_url}/api/speedtest/upload");
    let ul_start = Instant::now();
    let ul_tasks: Vec<_> = (0..STREAMS)
        .map(|_| {
            let http = http.clone();
            let url = upload_url.clone();
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
    let upload_mbps = (total_payload as f64 * 8.0) / (ul_elapsed.as_secs_f64() * 1_000_000.0);

    let total_elapsed = start.elapsed();

    let result = SpeedTestResult {
        client_id: client_id.to_string(),
        timestamp: chrono::Local::now().to_rfc3339(),
        test_type: SpeedTestType::Full,
        download_mbps,
        upload_mbps,
        payload_bytes: total_payload,
        duration_ms: total_elapsed.as_millis() as u64,
    };

    info!(
        event = "speed_test_complete",
        test_type = "full",
        download_mbps = format!("{:.1}", result.download_mbps),
        upload_mbps = format!("{:.1}", result.upload_mbps),
        duration_ms = result.duration_ms,
    );

    Ok(result)
}

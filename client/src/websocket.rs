use std::net::IpAddr;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio::time::{self};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{error, info, warn};

use crate::config::Config;
use crate::messages::{IncomingMessage, LogLevel, OutgoingMessage, SpeedTestType};
use crate::probe::{HttpTarget, IcmpTarget, ProbeEngine};
use crate::speed_test;
use crate::store::ProbeStore;
use crate::sync::SyncClient;

type WsSink = futures_util::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    Message,
>;

#[allow(clippy::cast_possible_truncation)]
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

/// Run the main WebSocket event loop with auto-reconnect.
/// Max consecutive connection failures (401/auth errors) before assuming deregistered.
const MAX_AUTH_FAILURES: u32 = 3;

#[allow(clippy::too_many_lines)]
pub async fn run(config: Config) -> anyhow::Result<()> {
    let http = reqwest::Client::new();
    let mut config = config;
    let mut backoff = Backoff::new();
    let mut consecutive_auth_failures: u32 = 0;

    // --- Initialize probe store ---
    let store = ProbeStore::open(&config.resolved_db_path())?;

    // --- Build probe targets ---
    let icmp_targets: Vec<IcmpTarget> = config
        .probes
        .icmp
        .targets
        .iter()
        .filter_map(|t| {
            t.parse::<IpAddr>()
                .ok()
                .map(|addr| IcmpTarget { addr, label: t.clone() })
        })
        .collect();

    let http_targets: Vec<HttpTarget> = config
        .probes
        .http
        .targets
        .iter()
        .map(|url| HttpTarget { url: url.clone() })
        .collect();

    // --- Spawn single background probe task with mpsc channel ---
    let (probe_tx, mut probe_rx) = mpsc::channel::<crate::store::ProbeRecord>(256);

    let probe_store = store.clone_handle();
    let _probe_handle = tokio::spawn({
        let icmp_targets = icmp_targets.clone();
        let http_targets = http_targets.clone();
        let icmp_interval_s = config.probes.icmp.interval_s;
        let http_interval_s = config.probes.http.interval_s;
        let icmp_timeout = config.probes.icmp.timeout_ms;
        let http_timeout = config.probes.http.timeout_ms;
        let icmp_enabled = config.probes.icmp.enabled;
        let http_enabled = config.probes.http.enabled;
        let retention_days = config.storage.retention_days;
        let engine = ProbeEngine::new().unwrap();
        let tx = probe_tx;

        async move {
            let mut icmp_tick =
                tokio::time::interval(Duration::from_secs(u64::from(icmp_interval_s)));
            let mut http_tick =
                tokio::time::interval(Duration::from_secs(u64::from(http_interval_s)));
            let mut cleanup_tick = tokio::time::interval(Duration::from_secs(3600));

            // Skip the immediate first tick for all intervals
            icmp_tick.tick().await;
            http_tick.tick().await;
            cleanup_tick.tick().await;

            loop {
                tokio::select! {
                    _ = icmp_tick.tick() => {
                        if icmp_enabled {
                            for target in &icmp_targets {
                                let record = engine.probe_icmp(target, icmp_timeout).await;
                                if let Ok(seq_id) = probe_store.insert_probe(&record) {
                                    let mut stored = record.clone();
                                    stored.seq_id = seq_id;
                                    tx.send(stored).await.ok();
                                }
                            }
                        }
                    }
                    _ = http_tick.tick() => {
                        if http_enabled {
                            for target in &http_targets {
                                let record = engine.probe_http(target, http_timeout).await;
                                if let Ok(seq_id) = probe_store.insert_probe(&record) {
                                    let mut stored = record.clone();
                                    stored.seq_id = seq_id;
                                    tx.send(stored).await.ok();
                                }
                            }
                        }
                    }
                    _ = cleanup_tick.tick() => {
                        probe_store.cleanup_old(retention_days).ok();
                    }
                }
            }
        }
    });

    loop {
        match connect_and_run(&mut config, &http, &mut backoff, &store, &mut probe_rx).await {
            Ok(Shutdown::Graceful) => {
                info!(event = "shutdown", reason = "signal");
                return Ok(());
            }
            Ok(Shutdown::Deregistered) => {
                warn!(
                    event = "deregistered",
                    message = "Client has been deleted from the server, stopping"
                );
                stop_service();
                return Ok(());
            }
            Ok(Shutdown::Disconnected) => {
                consecutive_auth_failures = 0;
                let delay = backoff.next_delay();
                #[allow(clippy::cast_possible_truncation)]
                let delay_ms = delay.as_millis() as u64;
                warn!(
                    event = "ws_disconnected",
                    reconnect_in_ms = delay_ms,
                );
                time::sleep(delay).await;
            }
            Err(e) => {
                let err_str = e.to_string();

                // 410 Gone = server confirmed client was deleted
                let is_gone = err_str.contains("410") || err_str.contains("Client deleted");
                if is_gone {
                    warn!(
                        event = "deregistered_confirmed",
                        message = "Server returned 410 Gone — client was deleted"
                    );
                    stop_service();
                    return Ok(());
                }

                let is_auth_failure = err_str.contains("401")
                    || err_str.contains("Unauthorized")
                    || err_str.contains("403");

                if is_auth_failure {
                    consecutive_auth_failures += 1;
                    warn!(
                        event = "ws_auth_failure",
                        consecutive = consecutive_auth_failures,
                        max = MAX_AUTH_FAILURES,
                    );
                    if consecutive_auth_failures >= MAX_AUTH_FAILURES {
                        warn!(
                            event = "deregistered_inferred",
                            message =
                                "Too many consecutive auth failures, assuming client was deleted"
                        );
                        stop_service();
                        return Ok(());
                    }
                } else {
                    consecutive_auth_failures = 0;
                }

                let delay = backoff.next_delay();
                #[allow(clippy::cast_possible_truncation)]
                let delay_ms = delay.as_millis() as u64;
                error!(
                    event = "ws_error",
                    error = %e,
                    reconnect_in_ms = delay_ms,
                );
                time::sleep(delay).await;
            }
        }
    }
}

/// Best-effort self-removal: delete plists and clean up data without
/// sending SIGTERM to ourselves via `launchctl remove`.
fn stop_service() {
    info!(event = "stopping_service", message = "Self-removing daemon");
    if let Err(e) = crate::service::self_remove() {
        warn!(event = "self_remove_error", error = %e);
    }
}

enum Shutdown {
    Graceful,
    Disconnected,
    Deregistered,
}

#[allow(clippy::too_many_lines)]
async fn connect_and_run(
    config: &mut Config,
    http: &reqwest::Client,
    backoff: &mut Backoff,
    store: &ProbeStore,
    probe_rx: &mut mpsc::Receiver<crate::store::ProbeRecord>,
) -> anyhow::Result<Shutdown> {
    // Build WebSocket URL
    let base = &config.server.base_url;
    let ws_path = &config.server.ws_url;
    let ws_url = base
        .replace("https://", "wss://")
        .replace("http://", "ws://")
        + ws_path
        + "?v="
        + env!("CARGO_PKG_VERSION");

    info!(event = "ws_connecting", url = %ws_url);

    // Build request with auth header
    let request = http::Request::builder()
        .uri(&ws_url)
        .header(
            "Authorization",
            format!("Bearer {}", config.server.client_secret),
        )
        .header("Host", url::Url::parse(base)?.host_str().unwrap_or(""))
        .header("X-Client-Version", env!("CARGO_PKG_VERSION"))
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header(
            "Sec-WebSocket-Key",
            tokio_tungstenite::tungstenite::handshake::client::generate_key(),
        )
        .body(())?;

    let (ws_stream, _) = connect_async(request).await?;
    let (mut sink, mut stream) = ws_stream.split();

    info!(event = "ws_connected");
    backoff.reset();

    // Trigger sync drain on reconnect (fire-and-forget)
    tokio::spawn({
        let sync_store = store.clone_handle();
        let base_url = config.server.base_url.clone();
        let client_id = config.server.client_id.clone();
        let client_secret = config.server.client_secret.clone();
        let batch_size = config.sync.batch_size;
        async move {
            let sc = SyncClient::new(&base_url, &client_id, &client_secret, batch_size);
            match sc.sync_all(&sync_store).await {
                Ok(n) if n > 0 => info!(records = n, "Reconnect sync complete"),
                Ok(_) => {}
                Err(e) => warn!(error = %e, "Reconnect sync failed"),
            }
        }
    });

    let mut ping_interval = time::interval(Duration::from_secs(u64::from(config.ping.interval_s)));
    ping_interval.tick().await; // Skip the immediate first tick
    let mut ping_counter: u64 = 0;

    let mut speed_test_interval = time::interval(Duration::from_secs(u64::from(config.speed_test.interval_s)));
    speed_test_interval.tick().await; // Skip the immediate first tick

    let mut sync_interval = time::interval(Duration::from_secs(u64::from(config.sync.interval_s)));
    sync_interval.tick().await; // Skip the immediate first tick

    let (speed_tx, mut speed_rx) = mpsc::unbounded_channel::<OutgoingMessage>();

    let shutdown = shutdown_signal();
    tokio::pin!(shutdown);

    loop {
        tokio::select! {
            msg = stream.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        match serde_json::from_str::<IncomingMessage>(text.as_ref()) {
                            Ok(incoming) => {
                                if let Some(shutdown) = handle_message(
                                    incoming,
                                    config,
                                    http,
                                    &mut sink,
                                    &mut ping_interval,
                                    &mut speed_test_interval,
                                    &speed_tx,
                                ).await {
                                    return Ok(shutdown);
                                }
                            }
                            Err(e) => {
                                warn!(event = "ws_parse_error", error = %e, raw = %text);
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        return Ok(Shutdown::Disconnected);
                    }
                    Some(Err(e)) => {
                        return Err(e.into());
                    }
                    _ => {} // Ignore binary, ping/pong frames (handled by tungstenite)
                }
            }

            _ = ping_interval.tick() => {
                ping_counter += 1;
                let ts = now_ms();
                let msg = OutgoingMessage::Ping {
                    id: format!("client-{ping_counter}"),
                    ts,
                };
                let json = serde_json::to_string(&msg).unwrap();
                if let Err(e) = sink.send(Message::Text(json.into())).await {
                    error!(event = "ping_send_error", error = %e);
                    return Ok(Shutdown::Disconnected);
                }
                info!(event = "ping_sent", id = format!("client-{ping_counter}"));
            }

            _ = speed_test_interval.tick() => {
                info!(event = "speed_test_interval_trigger", test_type = "probe");
                let http = http.clone();
                let base_url = config.server.base_url.clone();
                let client_id = config.server.client_id.clone();
                let probe_size = config.speed_test.probe_size_bytes;
                let tx = speed_tx.clone();

                tokio::spawn(async move {
                    let result = speed_test::run_probe(&http, &base_url, &client_id, probe_size).await;
                    let msg = match result {
                        Ok(result) => OutgoingMessage::SpeedTestResult { result },
                        Err(e) => {
                            error!(event = "speed_test_interval_error", error = %e);
                            OutgoingMessage::Error {
                                message: format!("Speed test failed: {e}"),
                            }
                        }
                    };
                    if tx.send(msg).is_err() {
                        warn!(event = "speed_test_channel_closed");
                    }
                });
            }

            Some(msg) = speed_rx.recv() => {
                let json = serde_json::to_string(&msg).unwrap();
                if let Err(e) = sink.send(Message::Text(json.into())).await {
                    error!(event = "speed_test_send_error", error = %e);
                    return Ok(Shutdown::Disconnected);
                }
            }

            // Forward real-time probe results over WebSocket
            Some(record) = probe_rx.recv() => {
                let msg = OutgoingMessage::ProbeResult {
                    session_id: store.session_id().to_string(),
                    record,
                };
                if let Ok(json) = serde_json::to_string(&msg) {
                    sink.send(Message::Text(json.into())).await.ok();
                }
            }

            // Periodic sync of accumulated probe results
            _ = sync_interval.tick() => {
                let sync_store = store.clone_handle();
                let sync_client = SyncClient::new(
                    &config.server.base_url,
                    &config.server.client_id,
                    &config.server.client_secret,
                    config.sync.batch_size,
                );
                if let Err(e) = sync_client.sync_all(&sync_store).await {
                    warn!(error = %e, "Sync failed, will retry next interval");
                }
            }

            () = &mut shutdown => {
                let _ = sink.close().await;
                return Ok(Shutdown::Graceful);
            }
        }
    }
}

#[allow(clippy::too_many_lines)]
async fn handle_message(
    msg: IncomingMessage,
    config: &mut Config,
    http: &reqwest::Client,
    sink: &mut WsSink,
    ping_interval: &mut time::Interval,
    speed_test_interval: &mut time::Interval,
    speed_tx: &mpsc::UnboundedSender<OutgoingMessage>,
) -> Option<Shutdown> {
    match msg {
        IncomingMessage::Ping { id, ts, .. } => {
            let pong = OutgoingMessage::Pong {
                id: id.clone(),
                ts,
                client_ts: now_ms(),
            };
            let json = serde_json::to_string(&pong).unwrap();
            if let Err(e) = sink.send(Message::Text(json.into())).await {
                error!(event = "pong_send_error", error = %e);
            }
            info!(event = "ping_reply", ping_id = %id);
        }

        IncomingMessage::Pong {
            id,
            ts,
            client_ts: _,
        } => {
            let rtt_ms = now_ms().saturating_sub(ts);
            info!(event = "pong_received", ping_id = %id, rtt_ms = rtt_ms);
        }

        IncomingMessage::ConfigUpdate { config: remote } => {
            let old_interval = config.ping.interval_s;
            let old_speed_interval = config.speed_test.interval_s;
            let old_probe = config.speed_test.probe_size_bytes;
            let old_full = config.speed_test.full_test_payload_bytes;
            let old_latency = config.alerts.latency_threshold_ms;
            let old_loss = config.alerts.loss_threshold_pct;
            let old_grace = config.ping.grace_period_s;

            config.apply_remote(&remote);
            if let Err(e) = config.save().await {
                error!(event = "config_save_error", error = %e);
            }
            if config.ping.interval_s != old_interval {
                *ping_interval = time::interval(Duration::from_secs(u64::from(config.ping.interval_s)));
                ping_interval.tick().await; // Skip immediate tick
            }
            if config.speed_test.interval_s != old_speed_interval {
                *speed_test_interval = time::interval(Duration::from_secs(u64::from(config.speed_test.interval_s)));
                speed_test_interval.tick().await; // Skip immediate tick
            }
            info!(
                event = "config_updated",
                ping_interval_s = config.ping.interval_s,
                speed_test_interval_s = config.speed_test.interval_s,
                interval_changed = (config.ping.interval_s != old_interval),
                speed_test_interval_changed = (config.speed_test.interval_s != old_speed_interval),
                probe_changed = (config.speed_test.probe_size_bytes != old_probe),
                full_payload_changed = (config.speed_test.full_test_payload_bytes != old_full),
                latency_threshold_changed = ((config.alerts.latency_threshold_ms - old_latency).abs() > f64::EPSILON),
                loss_threshold_changed = ((config.alerts.loss_threshold_pct - old_loss).abs() > f64::EPSILON),
                grace_period_changed = (config.ping.grace_period_s != old_grace),
            );
        }

        IncomingMessage::Deregistered { reason } => {
            warn!(event = "deregistered_by_server", reason = %reason);
            return Some(Shutdown::Deregistered);
        }

        IncomingMessage::ServerLogs { entries } => {
            info!(event = "server_logs_received", count = entries.len());
            for entry in &entries {
                let detail = entry.detail.as_deref().unwrap_or("");
                macro_rules! log_entry {
                    ($macro:ident) => {
                        $macro!(
                            event = "server_log",
                            server_event = %entry.event,
                            server_ts = %entry.ts,
                            detail = %detail,
                        )
                    };
                }
                match entry.level {
                    LogLevel::Error => log_entry!(error),
                    LogLevel::Warning => log_entry!(warn),
                    LogLevel::Info => log_entry!(info),
                }
            }
        }

        IncomingMessage::StartSpeedTest { test_type } => {
            let http = http.clone();
            let base_url = config.server.base_url.clone();
            let client_id = config.server.client_id.clone();
            let probe_size = config.speed_test.probe_size_bytes;
            let full_size = config.speed_test.full_test_payload_bytes;
            let tx = speed_tx.clone();

            tokio::spawn(async move {
                let result = match test_type {
                    SpeedTestType::Probe => {
                        speed_test::run_probe(&http, &base_url, &client_id, probe_size).await
                    }
                    SpeedTestType::Full => {
                        speed_test::run_full(&http, &base_url, &client_id, full_size).await
                    }
                };

                let msg = match result {
                    Ok(result) => OutgoingMessage::SpeedTestResult { result },
                    Err(e) => {
                        error!(event = "speed_test_error", error = %e);
                        OutgoingMessage::Error {
                            message: format!("Speed test failed: {e}"),
                        }
                    }
                };

                if tx.send(msg).is_err() {
                    warn!(event = "speed_test_channel_closed");
                }
            });
        }
    }
    None
}

// --- Backoff ---

struct Backoff {
    current_ms: u64,
}

impl Backoff {
    const INITIAL_MS: u64 = 1_000;
    const MAX_MS: u64 = 60_000;

    fn new() -> Self {
        Self {
            current_ms: Self::INITIAL_MS,
        }
    }

    fn reset(&mut self) {
        self.current_ms = Self::INITIAL_MS;
    }

    #[allow(clippy::cast_possible_wrap, clippy::cast_sign_loss)]
    fn next_delay(&mut self) -> Duration {
        let jitter_range = self.current_ms / 4; // ±25%
        let jitter = if jitter_range > 0 {
            rand::random_range(0..jitter_range * 2) as i64 - jitter_range as i64
        } else {
            0
        };
        let delay_ms = (self.current_ms as i64 + jitter).max(100) as u64;
        self.current_ms = (self.current_ms * 2).min(Self::MAX_MS);
        Duration::from_millis(delay_ms)
    }
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("Failed to install SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = sigterm.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c().await.ok();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_backoff_increases() {
        let mut b = Backoff::new();
        let d1 = b.next_delay();
        let d2 = b.next_delay();
        assert!(d2.as_millis() > d1.as_millis());
    }

    #[test]
    fn test_backoff_caps_at_max() {
        let mut b = Backoff::new();
        for _ in 0..20 {
            b.next_delay();
        }
        let d = b.next_delay();
        assert!(d.as_millis() <= (Backoff::MAX_MS + Backoff::MAX_MS / 4) as u128);
    }

    #[test]
    fn test_backoff_reset() {
        let mut b = Backoff::new();
        b.next_delay();
        b.next_delay();
        b.next_delay();
        b.reset();
        let d = b.next_delay();
        assert!(d.as_millis() < 2000);
    }
}

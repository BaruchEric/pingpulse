use std::net::IpAddr;
use std::time::{Duration, Instant};

use tokio::time;
use tracing::{error, info, warn};

use crate::config::Config;
use crate::messages::{Heartbeat, HeartbeatResponse, LogLevel, SpeedTestTarget, SpeedTestType};
use crate::probe::{HttpTarget, IcmpTarget, ProbeEngine};
use crate::speed_test;
use crate::store::ProbeStore;
use crate::sync::SyncClient;

const CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");
/// Consecutive auth failures (401/403) before assuming the client was deleted.
const MAX_AUTH_FAILURES: u32 = 3;

#[allow(clippy::cast_possible_truncation)]
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn semver_lt(a: &str, b: &str) -> bool {
    let pa: Vec<u32> = a.split('.').filter_map(|s| s.parse().ok()).collect();
    let pb: Vec<u32> = b.split('.').filter_map(|s| s.parse().ok()).collect();
    for i in 0..pa.len().max(pb.len()) {
        let na = pa.get(i).copied().unwrap_or(0);
        let nb = pb.get(i).copied().unwrap_or(0);
        if na < nb {
            return true;
        }
        if na > nb {
            return false;
        }
    }
    false
}

enum Outcome {
    Live(Box<HeartbeatResponse>),
    Deregistered,
    AdminDisconnect,
}

/// Run the HTTP heartbeat loop. The client POSTs a heartbeat every ping
/// interval, reporting the round-trip latency it measured for the previous
/// beat, and applies the config / commands the server returns.
#[allow(clippy::too_many_lines)]
pub async fn run(config: Config) -> anyhow::Result<()> {
    let http = reqwest::Client::new();
    let mut config = config;

    let store = ProbeStore::open(&config.resolved_db_path())?;
    spawn_probe_task(&config, &store);

    let sync_client = SyncClient::new(
        &config.server.base_url,
        &config.server.client_id,
        &config.server.client_secret,
        config.sync.batch_size,
    );

    let mut heartbeat_interval =
        time::interval(Duration::from_secs(u64::from(config.ping.interval_s)));
    // Do NOT skip the first tick — fire an immediate heartbeat on startup.
    let mut speed_test_interval =
        time::interval(Duration::from_secs(u64::from(config.speed_test.interval_s)));
    speed_test_interval.tick().await;
    let mut sync_interval =
        time::interval(Duration::from_secs(u64::from(config.sync.interval_s)));
    sync_interval.tick().await;

    let mut last_rtt: Option<f64> = None;
    let mut connected = false;
    let mut auth_failures: u32 = 0;
    let mut first = true;

    let shutdown = shutdown_signal();
    tokio::pin!(shutdown);

    loop {
        tokio::select! {
            _ = heartbeat_interval.tick() => {
                match do_heartbeat(&http, &config, &mut last_rtt, first).await {
                    Ok(Outcome::Deregistered) => {
                        warn!(event = "deregistered_confirmed", message = "Server returned 410 — client deleted");
                        stop_service();
                        return Ok(());
                    }
                    Ok(Outcome::AdminDisconnect) => {
                        info!(event = "admin_disconnect", message = "Heartbeat rejected during admin disconnect window");
                        last_rtt = None;
                    }
                    Ok(Outcome::Live(resp)) => {
                        first = false;
                        auth_failures = 0;
                        if !connected {
                            connected = true;
                            #[allow(clippy::cast_possible_wrap)]
                            let ts = now_ms() as i64;
                            store.insert_connectivity_event("connected", ts, None).ok();
                            spawn_reconnect_sync(&config, &store);
                            info!(event = "connected");
                        }

                        let old_ping = config.ping.interval_s;
                        let old_speed = config.speed_test.interval_s;
                        config.apply_remote(&resp.config);
                        if let Err(e) = config.save().await {
                            error!(event = "config_save_error", error = %e);
                        }
                        if config.ping.interval_s != old_ping {
                            heartbeat_interval =
                                time::interval(Duration::from_secs(u64::from(config.ping.interval_s)));
                        }
                        if config.speed_test.interval_s != old_speed {
                            speed_test_interval =
                                time::interval(Duration::from_secs(u64::from(config.speed_test.interval_s)));
                            speed_test_interval.tick().await;
                        }

                        if !resp.latest_version.is_empty()
                            && resp.latest_version != CLIENT_VERSION
                            && semver_lt(CLIENT_VERSION, &resp.latest_version)
                        {
                            info!(event = "update_available", latest = %resp.latest_version, current = CLIENT_VERSION);
                        }

                        log_server_entries(&resp);

                        if dispatch_commands(&resp, &config, &http) == CommandOutcome::Deregister {
                            warn!(event = "deregistered_by_command");
                            stop_service();
                            return Ok(());
                        }
                    }
                    Err(e) => {
                        last_rtt = None;
                        let err_str = e.to_string();
                        let is_auth = err_str.contains("401") || err_str.contains("403")
                            || err_str.contains("Unauthorized");
                        if is_auth {
                            auth_failures += 1;
                            warn!(event = "heartbeat_auth_failure", consecutive = auth_failures, max = MAX_AUTH_FAILURES);
                            if auth_failures >= MAX_AUTH_FAILURES {
                                warn!(event = "deregistered_inferred", message = "Too many auth failures, assuming deleted");
                                stop_service();
                                return Ok(());
                            }
                        }
                        if connected {
                            connected = false;
                            #[allow(clippy::cast_possible_wrap)]
                            let ts = now_ms() as i64;
                            store.insert_connectivity_event("disconnected", ts, Some(&err_str)).ok();
                        }
                        warn!(event = "heartbeat_error", error = %e);
                    }
                }
            }

            _ = speed_test_interval.tick() => {
                if connected {
                    for target in [SpeedTestTarget::Worker, SpeedTestTarget::Edge] {
                        spawn_speed_test(&http, &config, SpeedTestType::Probe, target);
                    }
                }
            }

            _ = sync_interval.tick() => {
                let sync_store = store.clone_handle();
                if let Err(e) = sync_client.sync_all(&sync_store).await {
                    warn!(error = %e, "Sync failed, will retry next interval");
                }
            }

            () = &mut shutdown => {
                info!(event = "shutdown", reason = "signal");
                return Ok(());
            }
        }
    }
}

async fn do_heartbeat(
    http: &reqwest::Client,
    config: &Config,
    last_rtt: &mut Option<f64>,
    include_logs: bool,
) -> anyhow::Result<Outcome> {
    let url = format!(
        "{}/api/clients/{}/heartbeat",
        config.server.base_url.trim_end_matches('/'),
        config.server.client_id
    );
    let body = Heartbeat {
        rtt_ms: *last_rtt,
        jitter_ms: None,
        status: last_rtt.map(|_| "ok".to_string()),
        client_version: CLIENT_VERSION.to_string(),
        timezone: None,
        include_logs,
    };

    let start = Instant::now();
    let resp = http
        .post(&url)
        .header("Authorization", format!("Bearer {}", config.server.client_secret))
        .json(&body)
        .send()
        .await?;

    let status = resp.status();
    if status.as_u16() == 410 {
        return Ok(Outcome::Deregistered);
    }
    if status.as_u16() == 503 {
        return Ok(Outcome::AdminDisconnect);
    }
    if status.as_u16() == 401 || status.as_u16() == 403 {
        anyhow::bail!("heartbeat auth failed: {status}");
    }
    if !status.is_success() {
        anyhow::bail!("heartbeat returned {status}");
    }

    *last_rtt = Some(start.elapsed().as_secs_f64() * 1000.0);
    let parsed: HeartbeatResponse = resp.json().await?;
    Ok(Outcome::Live(Box::new(parsed)))
}

#[derive(PartialEq)]
enum CommandOutcome {
    Continue,
    Deregister,
}

fn dispatch_commands(
    resp: &HeartbeatResponse,
    config: &Config,
    http: &reqwest::Client,
) -> CommandOutcome {
    for cmd in &resp.commands {
        match cmd.command.as_str() {
            "speed_test" => {
                let test_type = if cmd.params.get("test_type").and_then(|v| v.as_str())
                    == Some("probe")
                {
                    SpeedTestType::Probe
                } else {
                    SpeedTestType::Full
                };
                let target = if cmd.params.get("target").and_then(|v| v.as_str()) == Some("edge") {
                    SpeedTestTarget::Edge
                } else {
                    SpeedTestTarget::Worker
                };
                spawn_speed_test(http, config, test_type, target);
            }
            "self_update" => {
                let version = cmd
                    .params
                    .get("version")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&resp.latest_version)
                    .to_string();
                let repo = cmd
                    .params
                    .get("repo")
                    .and_then(|v| v.as_str())
                    .unwrap_or("BaruchEric/pingpulse")
                    .to_string();
                if !version.is_empty() {
                    let http = http.clone();
                    tokio::spawn(async move {
                        match self_update(&http, &version, &repo).await {
                            Ok(()) => info!(event = "self_update_complete", version = %version),
                            Err(e) => error!(event = "self_update_failed", error = %e),
                        }
                    });
                }
            }
            "deregister" => return CommandOutcome::Deregister,
            "request_ping" => info!(event = "request_ping_ack"),
            other => warn!(event = "unknown_command", command = %other),
        }
    }
    CommandOutcome::Continue
}

fn log_server_entries(resp: &HeartbeatResponse) {
    if resp.server_logs.is_empty() {
        return;
    }
    info!(event = "server_logs_received", count = resp.server_logs.len());
    for entry in &resp.server_logs {
        let detail = entry.detail.as_deref().unwrap_or("");
        macro_rules! log_entry {
            ($macro:ident) => {
                $macro!(event = "server_log", server_event = %entry.event, server_ts = %entry.ts, detail = %detail)
            };
        }
        match entry.level {
            LogLevel::Error => log_entry!(error),
            LogLevel::Warning => log_entry!(warn),
            LogLevel::Info => log_entry!(info),
        }
    }
}

fn spawn_speed_test(
    http: &reqwest::Client,
    config: &Config,
    test_type: SpeedTestType,
    target: SpeedTestTarget,
) {
    let http = http.clone();
    let base_url = config.server.base_url.clone();
    let client_id = config.server.client_id.clone();
    let client_secret = config.server.client_secret.clone();
    let probe_size = config.speed_test.probe_size_bytes;
    let full_size = config.speed_test.full_test_payload_bytes;

    tokio::spawn(async move {
        let result = match test_type {
            SpeedTestType::Probe => {
                speed_test::run_probe(&http, &base_url, &client_id, probe_size, target).await
            }
            SpeedTestType::Full => {
                speed_test::run_full(&http, &base_url, &client_id, full_size, target).await
            }
        };
        match result {
            Ok(r) => {
                if let Err(e) =
                    speed_test::report(&http, &base_url, &client_id, &client_secret, &r).await
                {
                    warn!(event = "speed_test_report_failed", error = %e);
                }
            }
            Err(e) => error!(event = "speed_test_error", target = ?target, error = %e),
        }
    });
}

fn spawn_reconnect_sync(config: &Config, store: &ProbeStore) {
    let sync_store = store.clone_handle();
    let base_url = config.server.base_url.clone();
    let client_id = config.server.client_id.clone();
    let client_secret = config.server.client_secret.clone();
    let batch_size = config.sync.batch_size;
    tokio::spawn(async move {
        let sc = SyncClient::new(&base_url, &client_id, &client_secret, batch_size);
        match sc.sync_connectivity(&sync_store).await {
            Ok(n) if n > 0 => info!(records = n, "Connectivity sync complete"),
            Ok(_) => {}
            Err(e) => warn!(error = %e, "Connectivity sync failed"),
        }
        match sc.sync_all(&sync_store).await {
            Ok(n) if n > 0 => info!(records = n, "Reconnect sync complete"),
            Ok(_) => {}
            Err(e) => warn!(error = %e, "Reconnect sync failed"),
        }
    });
}

#[allow(clippy::too_many_lines)]
fn spawn_probe_task(config: &Config, store: &ProbeStore) {
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

    let probe_store = store.clone_handle();
    let icmp_interval_s = config.probes.icmp.interval_s;
    let http_interval_s = config.probes.http.interval_s;
    let icmp_timeout = config.probes.icmp.timeout_ms;
    let http_timeout = config.probes.http.timeout_ms;
    let icmp_enabled = config.probes.icmp.enabled;
    let http_enabled = config.probes.http.enabled;
    let retention_days = config.storage.retention_days;

    tokio::spawn(async move {
        let engine = ProbeEngine::new().unwrap();
        let mut icmp_tick = time::interval(Duration::from_secs(u64::from(icmp_interval_s)));
        let mut http_tick = time::interval(Duration::from_secs(u64::from(http_interval_s)));
        let mut cleanup_tick = time::interval(Duration::from_secs(3600));
        icmp_tick.tick().await;
        http_tick.tick().await;
        cleanup_tick.tick().await;

        loop {
            tokio::select! {
                _ = icmp_tick.tick() => {
                    if icmp_enabled {
                        for target in &icmp_targets {
                            let record = engine.probe_icmp(target, icmp_timeout).await;
                            probe_store.insert_probe(&record).ok();
                        }
                    }
                }
                _ = http_tick.tick() => {
                    if http_enabled {
                        for target in &http_targets {
                            let record = engine.probe_http(target, http_timeout).await;
                            probe_store.insert_probe(&record).ok();
                        }
                    }
                }
                _ = cleanup_tick.tick() => {
                    probe_store.cleanup_old(retention_days).ok();
                }
            }
        }
    });
}

/// Best-effort self-removal of the OS service.
fn stop_service() {
    info!(event = "stopping_service", message = "Self-removing daemon");
    if let Err(e) = crate::service::self_remove() {
        warn!(event = "self_remove_error", error = %e);
    }
}

// --- Self-update ---

#[allow(clippy::too_many_lines)]
async fn self_update(http: &reqwest::Client, version: &str, repo: &str) -> anyhow::Result<()> {
    let (os, arch, ext) = platform_triple();
    let artifact = format!("pingpulse-{os}-{arch}.{ext}");
    let url = format!("https://github.com/{repo}/releases/download/client-v{version}/{artifact}");

    info!(event = "self_update_downloading", url = %url);
    let bytes = http.get(&url).send().await?.error_for_status()?.bytes().await?;

    let current_exe = std::env::current_exe()?;
    let tmp_dir = std::env::temp_dir().join(format!("pingpulse-update-{version}"));
    std::fs::create_dir_all(&tmp_dir)?;

    let archive_path = tmp_dir.join(&artifact);
    std::fs::write(&archive_path, &bytes)?;

    let new_binary = tmp_dir.join(if cfg!(windows) { "pingpulse.exe" } else { "pingpulse" });

    #[cfg(not(target_os = "windows"))]
    {
        use std::process::Command;
        let status = Command::new("tar")
            .args(["xzf", archive_path.to_str().unwrap(), "-C", tmp_dir.to_str().unwrap()])
            .status()?;
        if !status.success() {
            anyhow::bail!("Failed to extract archive");
        }
    }

    #[cfg(target_os = "windows")]
    {
        let status = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                &format!(
                    "Expand-Archive -Path '{}' -DestinationPath '{}' -Force",
                    archive_path.display(),
                    tmp_dir.display()
                ),
            ])
            .status()?;
        if !status.success() {
            anyhow::bail!("Failed to extract archive");
        }
    }

    if !new_binary.exists() {
        anyhow::bail!("Extracted binary not found at {}", new_binary.display());
    }

    #[cfg(not(target_os = "windows"))]
    {
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("xattr")
                .args(["-cr", new_binary.to_str().unwrap()])
                .status()
                .ok();
            let sign_status = std::process::Command::new("codesign")
                .args(["-s", "-", "-f", new_binary.to_str().unwrap()])
                .status();
            if let Ok(s) = sign_status {
                if !s.success() {
                    warn!(event = "codesign_failed", path = %new_binary.display());
                }
            }
        }

        let _ = std::fs::remove_file(&current_exe);
        std::fs::copy(&new_binary, &current_exe)
            .map_err(|e| anyhow::anyhow!("Failed to replace binary at {}: {e}", current_exe.display()))?;

        std::process::Command::new("chmod")
            .args(["+x", current_exe.to_str().unwrap()])
            .status()
            .ok();
    }

    #[cfg(target_os = "windows")]
    {
        let backup = current_exe.with_extension("old.exe");
        let _ = std::fs::remove_file(&backup);
        std::fs::rename(&current_exe, &backup)?;
        std::fs::copy(&new_binary, &current_exe)?;
    }

    let _ = std::fs::remove_dir_all(&tmp_dir);
    info!(event = "self_update_restarting");

    #[cfg(target_os = "macos")]
    {
        let uid = std::process::Command::new("id")
            .arg("-u")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .unwrap_or_default()
            .trim()
            .to_string();
        std::process::Command::new("launchctl")
            .args(["kickstart", "-k", &format!("gui/{uid}/ca.beric.pingpulse")])
            .spawn()
            .ok();
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("systemctl")
            .args(["--user", "restart", "pingpulse"])
            .spawn()
            .ok();
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new(&current_exe)
            .args(["start", "--foreground"])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .ok();
        std::process::exit(0);
    }

    #[cfg(not(target_os = "windows"))]
    Ok(())
}

fn platform_triple() -> (&'static str, &'static str, &'static str) {
    let os = if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "amd64"
    };
    let ext = if cfg!(target_os = "windows") { "zip" } else { "tar.gz" };
    (os, arch, ext)
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
    fn test_semver_lt() {
        assert!(semver_lt("1.0.5", "1.0.6"));
        assert!(semver_lt("1.0.5", "1.1.0"));
        assert!(!semver_lt("1.0.6", "1.0.5"));
        assert!(!semver_lt("1.0.5", "1.0.5"));
    }
}

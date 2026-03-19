#[cfg(not(target_os = "windows"))]
use std::path::PathBuf;
#[cfg(not(target_os = "windows"))]
use std::process::Command;

use anyhow::{bail, Context, Result};
use tracing::info;

/// Install and start the daemon as a system service.
pub fn install_and_start(#[cfg_attr(target_os = "windows", allow(unused))] binary_path: &str) -> Result<()> {
    #[cfg(target_os = "macos")]
    return install_launchd(binary_path);

    #[cfg(target_os = "linux")]
    return install_systemd(binary_path);

    #[cfg(target_os = "windows")]
    {
        eprintln!("Windows service installation not yet supported. Use --foreground.");
        bail!("Windows service not supported in v1");
    }
}

/// Self-removal for when the daemon wants to uninstall itself.
///
/// This does NOT call `launchctl remove` which would send SIGTERM to our
/// own process. Instead it just deletes the plist files and cleans up data.
/// The caller should then exit with code 0.
/// With `SuccessfulExit=false`, launchd won't restart. Even with older
/// plists that have `KeepAlive=true`, the missing config file will cause
/// an immediate crash on restart, and launchd's built-in throttle will
/// eventually give up.
pub fn self_remove() -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        // Delete plist files (don't call launchctl remove — that's us)
        let _ = std::fs::remove_file(plist_path());
        let _ = std::fs::remove_file(legacy_agent_plist_path());
    }
    #[cfg(target_os = "linux")]
    {
        // Disable without stopping (we ARE the running process)
        let _ = std::process::Command::new("systemctl")
            .args(["--user", "disable", "pingpulse"])
            .output();
        let _ = std::fs::remove_file(service_path());
        let _ = std::process::Command::new("systemctl")
            .args(["--user", "daemon-reload"])
            .output();
    }
    cleanup_data()?;
    reset_btm();
    Ok(())
}

/// Best-effort reset of the macOS Background Task Management cache so stale
/// entries disappear from System Settings → Login Items.
#[cfg(target_os = "macos")]
fn reset_btm() {
    let _ = Command::new("sfltool").arg("resetbtm").output();
}

#[cfg(not(target_os = "macos"))]
fn reset_btm() {}

/// Remove the PingPulse data directory.
pub fn cleanup_data() -> Result<()> {
    let dir = crate::config::Config::config_dir();
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => info!(event = "data_cleaned", path = %dir.display()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(anyhow::Error::new(e).context("Failed to remove PingPulse data directory")),
    }
    Ok(())
}

/// Stop and uninstall the daemon service.
pub fn stop() -> Result<()> {
    #[cfg(target_os = "macos")]
    return stop_launchd();

    #[cfg(target_os = "linux")]
    return stop_systemd();

    #[cfg(target_os = "windows")]
    {
        bail!("Windows service not supported in v1");
    }
}

/// Check if the service is currently running.
pub fn status() -> Result<bool> {
    #[cfg(target_os = "macos")]
    return status_launchd();

    #[cfg(target_os = "linux")]
    return status_systemd();

    #[cfg(target_os = "windows")]
    {
        bail!("Windows service not supported in v1");
    }
}

// --- macOS (launchd) ---

#[cfg(target_os = "macos")]
const PLIST_LABEL: &str = "ca.beric.pingpulse";

/// Legacy agent plist from when the agent ran as a separate launchd service.
/// Now the agent is spawned inside the daemon process, so this plist is stale.
#[cfg(target_os = "macos")]
const LEGACY_AGENT_PLIST_LABEL: &str = "ca.beric.pingpulse.agent";

#[cfg(target_os = "macos")]
fn plist_path() -> PathBuf {
    dirs::home_dir()
        .expect("No home directory")
        .join(format!("Library/LaunchAgents/{PLIST_LABEL}.plist"))
}

#[cfg(target_os = "macos")]
fn legacy_agent_plist_path() -> PathBuf {
    dirs::home_dir()
        .expect("No home directory")
        .join(format!("Library/LaunchAgents/{LEGACY_AGENT_PLIST_LABEL}.plist"))
}

#[cfg(target_os = "macos")]
fn install_launchd(binary_path: &str) -> Result<()> {
    let logs_dir = crate::config::Config::logs_dir();
    std::fs::create_dir_all(&logs_dir)?;

    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{PLIST_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{binary_path}</string>
        <string>start</string>
        <string>--foreground</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>{stdout}</string>
    <key>StandardErrorPath</key>
    <string>{stderr}</string>
</dict>
</plist>"#,
        stdout = logs_dir.join("stdout.log").display(),
        stderr = logs_dir.join("stderr.log").display(),
    );

    let path = plist_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, plist)?;

    let output = Command::new("launchctl")
        .args(["load", path.to_str().unwrap()])
        .output()
        .context("Failed to run launchctl")?;

    if !output.status.success() {
        bail!(
            "launchctl load failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    info!(event = "service_installed", method = "launchd");
    println!("PingPulse service installed and started.");
    Ok(())
}

/// Delete a launchd plist and tell launchd to forget the service.
///
/// The plist is removed *before* `launchctl remove` because the remove
/// command sends SIGTERM to the managed process — which may be us.
#[cfg(target_os = "macos")]
fn remove_launchd_service(path: PathBuf, label: &str, description: &str) -> Result<()> {
    if !path.exists() {
        bail!("{description} plist not found at {}", path.display());
    }

    std::fs::remove_file(&path)?;

    let _ = Command::new("launchctl")
        .args(["remove", label])
        .output();
    println!("PingPulse {description} stopped and removed.");
    Ok(())
}

#[cfg(target_os = "macos")]
fn stop_launchd() -> Result<()> {
    // Clean up legacy agent plist if it exists (agent now runs inside daemon)
    let legacy = legacy_agent_plist_path();
    if legacy.exists() {
        let _ = remove_launchd_service(legacy, LEGACY_AGENT_PLIST_LABEL, "legacy agent");
    }
    remove_launchd_service(plist_path(), PLIST_LABEL, "service")
}

#[cfg(target_os = "macos")]
fn status_launchd() -> Result<bool> {
    let output = Command::new("launchctl")
        .args(["list", PLIST_LABEL])
        .output()
        .context("Failed to run launchctl")?;

    Ok(output.status.success())
}

// --- Linux (systemd) ---

#[cfg(target_os = "linux")]
fn service_path() -> PathBuf {
    dirs::home_dir()
        .expect("No home directory")
        .join(".config/systemd/user/pingpulse.service")
}

#[cfg(target_os = "linux")]
fn install_systemd(binary_path: &str) -> Result<()> {
    let unit = format!(
        r#"[Unit]
Description=PingPulse Network Monitor
After=network-online.target

[Service]
ExecStart={binary_path} start --foreground
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
"#
    );

    let path = service_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, unit)?;

    Command::new("systemctl")
        .args(["--user", "daemon-reload"])
        .output()?;

    let output = Command::new("systemctl")
        .args(["--user", "enable", "--now", "pingpulse"])
        .output()
        .context("Failed to run systemctl")?;

    if !output.status.success() {
        bail!(
            "systemctl enable failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    println!("PingPulse service installed and started.");
    Ok(())
}

#[cfg(target_os = "linux")]
fn stop_systemd() -> Result<()> {
    Command::new("systemctl")
        .args(["--user", "stop", "pingpulse"])
        .output()?;

    Command::new("systemctl")
        .args(["--user", "disable", "pingpulse"])
        .output()?;

    let path = service_path();
    if path.exists() {
        std::fs::remove_file(&path)?;
    }

    Command::new("systemctl")
        .args(["--user", "daemon-reload"])
        .output()?;

    println!("PingPulse service stopped and removed.");
    Ok(())
}

#[cfg(target_os = "linux")]
fn status_systemd() -> Result<bool> {
    let output = Command::new("systemctl")
        .args(["--user", "is-active", "--quiet", "pingpulse"])
        .output()
        .context("Failed to run systemctl")?;

    Ok(output.status.success())
}


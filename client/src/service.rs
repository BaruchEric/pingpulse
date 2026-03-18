use std::path::PathBuf;
use std::process::Command;

use anyhow::{bail, Context, Result};
use tracing::info;

/// Install and start the daemon as a system service.
pub fn install_and_start(binary_path: &str) -> Result<()> {
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

#[cfg(target_os = "macos")]
fn plist_path() -> PathBuf {
    dirs::home_dir()
        .expect("No home directory")
        .join("Library/LaunchAgents/ca.beric.pingpulse.plist")
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
    <true/>
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

#[cfg(target_os = "macos")]
fn stop_launchd() -> Result<()> {
    let path = plist_path();
    if !path.exists() {
        bail!("Service plist not found at {}", path.display());
    }

    let output = Command::new("launchctl")
        .args(["unload", path.to_str().unwrap()])
        .output()
        .context("Failed to run launchctl")?;

    if !output.status.success() {
        bail!(
            "launchctl unload failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    std::fs::remove_file(&path)?;
    println!("PingPulse service stopped and removed.");
    Ok(())
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

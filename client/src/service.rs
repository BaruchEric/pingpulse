#[cfg(not(target_os = "windows"))]
use std::path::PathBuf;
#[cfg(not(target_os = "windows"))]
use std::process::Command;

use anyhow::{bail, Context, Result};
use tracing::info;

/// Install and start the daemon as a system service.
pub fn install_and_start(
    #[cfg_attr(target_os = "windows", allow(unused))] binary_path: &str,
) -> Result<()> {
    #[cfg(target_os = "macos")]
    return install_launchd(binary_path);

    #[cfg(target_os = "linux")]
    return install_systemd(binary_path);

    #[cfg(target_os = "windows")]
    return install_windows_task(binary_path);
}

/// Full uninstall: stop service, remove binary, config, data, and Login Item.
///
/// On Unix the running binary can be unlinked while executing — the kernel
/// keeps the inode alive until the process exits, so this is safe.
pub fn uninstall() {
    // 1. Stop the service (ignore errors — may not be running)
    let _ = stop();

    // 2. Remove plist/service files that stop() might have missed
    #[cfg(target_os = "macos")]
    {
        let _ = std::fs::remove_file(plist_path());
        let _ = std::fs::remove_file(legacy_agent_plist_path());
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::fs::remove_file(service_path());
    }
    #[cfg(target_os = "windows")]
    {
        let _ = delete_windows_task();
    }

    // 3. Remove data directory (~/.pingpulse)
    let _ = cleanup_data();

    // 4. Remove the binary — both the current exe and the known install path
    let current = std::env::current_exe().ok();
    #[cfg(not(target_os = "windows"))]
    let install_path = std::path::PathBuf::from("/usr/local/bin/pingpulse");
    #[cfg(target_os = "windows")]
    let install_path = {
        let mut p = dirs::data_local_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
        p.push("pingpulse");
        p.push("pingpulse.exe");
        p
    };

    let paths: Vec<&std::path::Path> = [current.as_deref(), Some(install_path.as_path())]
        .into_iter()
        .flatten()
        .collect();
    remove_binaries(&paths);

    // 5. Clear the Login Item ghost from System Settings
    reset_btm();

    println!("PingPulse has been completely uninstalled.");
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
    #[cfg(target_os = "windows")]
    {
        let _ = delete_windows_task();
    }
    cleanup_data()?;
    reset_btm();
    Ok(())
}

/// Best-effort reset of the macOS Background Task Management cache so stale
/// entries disappear from System Settings → Login Items.
/// Uses a short timeout because `sfltool resetbtm` can hang indefinitely.
#[cfg(target_os = "macos")]
fn reset_btm() {
    use std::thread;
    use std::time::{Duration, Instant};

    let Ok(mut child) = Command::new("sfltool").arg("resetbtm").spawn() else {
        return;
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    return;
                }
                thread::sleep(Duration::from_millis(200));
            }
            Ok(Some(_)) | Err(_) => return,
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn reset_btm() {}

/// Remove the `PingPulse` data directory.
pub fn cleanup_data() -> Result<()> {
    cleanup_data_at(&crate::config::Config::config_dir())
}

/// Remove a directory tree. Returns Ok for missing directories.
fn cleanup_data_at(dir: &std::path::Path) -> Result<()> {
    match std::fs::remove_dir_all(dir) {
        Ok(()) => info!(event = "data_cleaned", path = %dir.display()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(anyhow::Error::new(e).context("Failed to remove data directory")),
    }
    Ok(())
}

/// Stop and uninstall the daemon service.
pub fn stop() -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        let result = stop_launchd();
        reset_btm();
        result
    }

    #[cfg(target_os = "linux")]
    return stop_systemd();

    #[cfg(target_os = "windows")]
    return stop_windows_task();
}

/// Check if the service is currently running.
pub fn status() -> Result<bool> {
    #[cfg(target_os = "macos")]
    return status_launchd();

    #[cfg(target_os = "linux")]
    return status_systemd();

    #[cfg(target_os = "windows")]
    return status_windows_task();
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
    dirs::home_dir().expect("No home directory").join(format!(
        "Library/LaunchAgents/{LEGACY_AGENT_PLIST_LABEL}.plist"
    ))
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
fn remove_launchd_service(path: &std::path::Path, label: &str, description: &str) -> Result<()> {
    if !path.exists() {
        bail!("{description} plist not found at {}", path.display());
    }

    std::fs::remove_file(path)?;

    let _ = Command::new("launchctl").args(["remove", label]).output();
    println!("PingPulse {description} stopped and removed.");
    Ok(())
}

#[cfg(target_os = "macos")]
fn stop_launchd() -> Result<()> {
    // Clean up legacy agent plist if it exists (agent now runs inside daemon)
    let legacy = legacy_agent_plist_path();
    if legacy.exists() {
        let _ = remove_launchd_service(&legacy, LEGACY_AGENT_PLIST_LABEL, "legacy agent");
    }
    remove_launchd_service(&plist_path(), PLIST_LABEL, "service")
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

/// Remove a list of binary paths, falling back to sudo on permission errors.
fn remove_binaries(paths: &[&std::path::Path]) {
    for path in paths {
        match std::fs::remove_file(path) {
            Ok(()) => println!("Removed {}", path.display()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
                println!("Removing {} (requires sudo)...", path.display());
                let status = std::process::Command::new("sudo")
                    .args(["rm", "-f"])
                    .arg(path)
                    .status();
                match status {
                    Ok(s) if s.success() => println!("Removed {}", path.display()),
                    _ => eprintln!("Could not remove {}: {e}", path.display()),
                }
            }
            Err(e) => eprintln!("Could not remove {}: {e}", path.display()),
        }
    }
}

// --- Windows (Task Scheduler) ---

#[cfg(target_os = "windows")]
const TASK_NAME: &str = "PingPulse";

#[cfg(target_os = "windows")]
fn install_windows_task(binary_path: &str) -> Result<()> {
    use std::process::Command;

    let logs_dir = crate::config::Config::logs_dir();
    std::fs::create_dir_all(&logs_dir)?;

    // Create a scheduled task that runs at logon and restarts on failure
    let xml = format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Settings>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Hidden>false</Hidden>
  </Settings>
  <Actions>
    <Exec>
      <Command>{binary_path}</Command>
      <Arguments>start --foreground</Arguments>
    </Exec>
  </Actions>
</Task>"#
    );

    let xml_path = logs_dir.join("task.xml");
    std::fs::write(&xml_path, &xml)?;

    let output = Command::new("schtasks")
        .args([
            "/Create",
            "/TN", TASK_NAME,
            "/XML", xml_path.to_str().unwrap(),
            "/F",
        ])
        .output()
        .context("Failed to run schtasks")?;

    let _ = std::fs::remove_file(&xml_path);

    if !output.status.success() {
        bail!(
            "schtasks /Create failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    // Start immediately
    let output = Command::new("schtasks")
        .args(["/Run", "/TN", TASK_NAME])
        .output()
        .context("Failed to start task")?;

    if !output.status.success() {
        bail!(
            "schtasks /Run failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    info!(event = "service_installed", method = "task_scheduler");
    println!("PingPulse service installed and started.");
    Ok(())
}

#[cfg(target_os = "windows")]
fn stop_windows_task() -> Result<()> {
    use std::process::Command;

    let _ = Command::new("schtasks")
        .args(["/End", "/TN", TASK_NAME])
        .output();

    delete_windows_task()?;
    println!("PingPulse service stopped and removed.");
    Ok(())
}

#[cfg(target_os = "windows")]
fn delete_windows_task() -> Result<()> {
    use std::process::Command;

    let output = Command::new("schtasks")
        .args(["/Delete", "/TN", TASK_NAME, "/F"])
        .output()
        .context("Failed to run schtasks")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !stderr.contains("does not exist") {
            bail!("schtasks /Delete failed: {stderr}");
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn status_windows_task() -> Result<bool> {
    use std::process::Command;

    let output = Command::new("schtasks")
        .args(["/Query", "/TN", TASK_NAME, "/FO", "CSV", "/NH"])
        .output()
        .context("Failed to run schtasks")?;

    if !output.status.success() {
        return Ok(false);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout.contains("Running"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn test_cleanup_data_removes_directory() {
        let tmp = TempDir::new().unwrap();
        let data_dir = tmp.path().join("pingpulse-test");
        fs::create_dir_all(data_dir.join("logs")).unwrap();
        fs::write(data_dir.join("config.toml"), "test").unwrap();
        fs::write(data_dir.join("logs/stdout.log"), "log").unwrap();

        cleanup_data_at(&data_dir).unwrap();

        assert!(!data_dir.exists());
    }

    #[test]
    fn test_cleanup_data_missing_dir_is_ok() {
        let tmp = TempDir::new().unwrap();
        let missing = tmp.path().join("does-not-exist");

        assert!(cleanup_data_at(&missing).is_ok());
    }

    #[test]
    fn test_remove_binaries_removes_files() {
        let tmp = TempDir::new().unwrap();
        let bin1 = tmp.path().join("pingpulse");
        let bin2 = tmp.path().join("pingpulse-copy");
        fs::write(&bin1, "binary1").unwrap();
        fs::write(&bin2, "binary2").unwrap();

        remove_binaries(&[bin1.as_path(), bin2.as_path()]);

        assert!(!bin1.exists());
        assert!(!bin2.exists());
    }

    #[test]
    fn test_remove_binaries_missing_is_silent() {
        let tmp = TempDir::new().unwrap();
        let missing = tmp.path().join("no-such-binary");

        remove_binaries(&[missing.as_path()]);
    }

    #[test]
    fn test_remove_binaries_deduplicates_same_path() {
        let tmp = TempDir::new().unwrap();
        let bin = tmp.path().join("pingpulse");
        fs::write(&bin, "binary").unwrap();

        // Second removal of same path is NotFound — should be silent
        remove_binaries(&[bin.as_path(), bin.as_path()]);

        assert!(!bin.exists());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn test_plist_path_is_under_launch_agents() {
        let path = plist_path();
        assert!(path.ends_with("Library/LaunchAgents/ca.beric.pingpulse.plist"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn test_legacy_agent_plist_path() {
        let path = legacy_agent_plist_path();
        assert!(path.ends_with("Library/LaunchAgents/ca.beric.pingpulse.agent.plist"));
    }
}

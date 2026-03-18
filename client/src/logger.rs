use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use chrono::Local;
use tracing_subscriber::fmt::MakeWriter;

/// A tracing writer that rotates log files daily.
/// Files are named `pingpulse-YYYY-MM-DD.log` in the configured logs directory.
pub struct DailyFileWriter {
    logs_dir: PathBuf,
    state: Mutex<WriterState>,
}

struct WriterState {
    current_date: String,
    file: Option<File>,
}

impl DailyFileWriter {
    pub fn new(logs_dir: PathBuf) -> Self {
        fs::create_dir_all(&logs_dir).ok();
        Self {
            logs_dir,
            state: Mutex::new(WriterState {
                current_date: String::new(),
                file: None,
            }),
        }
    }

    fn log_path(&self, date: &str) -> PathBuf {
        self.logs_dir.join(format!("pingpulse-{date}.log"))
    }

    /// Delete log files older than `retention_days`.
    pub fn cleanup_old_logs(&self, retention_days: u32) {
        let cutoff = Local::now() - chrono::Duration::days(retention_days as i64);
        let cutoff_str = cutoff.format("%Y-%m-%d").to_string();

        let entries = match fs::read_dir(&self.logs_dir) {
            Ok(e) => e,
            Err(_) => return,
        };

        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            // Match pingpulse-YYYY-MM-DD.log
            if let Some(date) = name
                .strip_prefix("pingpulse-")
                .and_then(|s| s.strip_suffix(".log"))
            {
                if date < cutoff_str.as_str() {
                    fs::remove_file(entry.path()).ok();
                }
            }
        }
    }
}

/// Wrapper that implements `Write` for a single log write operation.
pub struct DailyFileWriteGuard<'a> {
    writer: &'a DailyFileWriter,
}

impl<'a> Write for DailyFileWriteGuard<'a> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let today = Local::now().format("%Y-%m-%d").to_string();
        let mut state = self.writer.state.lock().unwrap();

        if state.current_date != today || state.file.is_none() {
            let path = self.writer.log_path(&today);
            state.file = Some(
                OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(path)?,
            );
            state.current_date = today;
        }

        if let Some(ref mut file) = state.file {
            file.write(buf)
        } else {
            Err(std::io::Error::other("No log file"))
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        let state = self.writer.state.lock().unwrap();
        if let Some(ref _file) = state.file {
            drop(state);
        }
        Ok(())
    }
}

impl<'a> MakeWriter<'a> for DailyFileWriter {
    type Writer = DailyFileWriteGuard<'a>;

    fn make_writer(&'a self) -> Self::Writer {
        DailyFileWriteGuard { writer: self }
    }
}

/// Initialize the tracing subscriber with daily-rotating JSON output.
pub fn init(logs_dir: PathBuf, level: &str, retention_days: u32) {
    let writer = DailyFileWriter::new(logs_dir);
    writer.cleanup_old_logs(retention_days);

    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(level));

    tracing_subscriber::fmt()
        .json()
        .with_env_filter(env_filter)
        .with_writer(writer)
        .with_target(false)
        .flatten_event(true)
        .init();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::Path;

    fn test_writer(dir: &Path) -> DailyFileWriter {
        DailyFileWriter::new(dir.to_path_buf())
    }

    #[test]
    fn test_log_path_format() {
        let dir = tempfile::TempDir::new().unwrap();
        let writer = test_writer(dir.path());
        let path = writer.log_path("2026-03-17");
        assert_eq!(
            path.file_name().unwrap().to_str().unwrap(),
            "pingpulse-2026-03-17.log"
        );
    }

    #[test]
    fn test_write_creates_file() {
        let dir = tempfile::TempDir::new().unwrap();
        let writer = test_writer(dir.path());
        let mut guard = DailyFileWriteGuard { writer: &writer };
        guard.write_all(b"test line\n").unwrap();

        let today = Local::now().format("%Y-%m-%d").to_string();
        let log_path = dir.path().join(format!("pingpulse-{today}.log"));
        assert!(log_path.exists());
        let contents = fs::read_to_string(log_path).unwrap();
        assert_eq!(contents, "test line\n");
    }

    #[test]
    fn test_cleanup_old_logs() {
        let dir = tempfile::TempDir::new().unwrap();
        let writer = test_writer(dir.path());

        // Create some fake log files
        File::create(dir.path().join("pingpulse-2020-01-01.log")).unwrap();
        File::create(dir.path().join("pingpulse-2020-06-15.log")).unwrap();
        // Today's log should survive
        let today = Local::now().format("%Y-%m-%d").to_string();
        File::create(dir.path().join(format!("pingpulse-{today}.log"))).unwrap();

        writer.cleanup_old_logs(30);

        assert!(!dir.path().join("pingpulse-2020-01-01.log").exists());
        assert!(!dir.path().join("pingpulse-2020-06-15.log").exists());
        assert!(dir.path().join(format!("pingpulse-{today}.log")).exists());
    }
}

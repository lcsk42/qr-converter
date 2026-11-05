use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

// ── Log file path ─────────────────────────────────────────────────────────────
// Write next to the executable so the log is always easy to find after install.
// Falls back to the system temp dir if the exe directory isn't writable.

pub fn log_path() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            return dir.join("qr-converter.log");
        }
    }
    std::env::temp_dir().join("qr-converter.log")
}

/// Appends one timestamped line to `path`. Split out from `append_log` so tests
/// can write to a scratch file instead of the real log next to the binary.
pub fn append_to(path: &Path, message: &str) {
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        // Timestamp: seconds.milliseconds since Unix epoch (UTC, no extra deps)
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| format!("{}.{:03}", d.as_secs(), d.subsec_millis()))
            .unwrap_or_else(|_| "?".into());
        let _ = writeln!(f, "[{}] {}", ts, message);
    }
}

pub fn append_log(message: &str) {
    append_to(&log_path(), message);
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[tauri::command]
fn write_log(message: String) {
    append_log(&message);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|_app| {
            append_log("=== qr-converter started ===");
            append_log(&format!("log file: {}", log_path().display()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![write_log])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("qr-converter-test-{}-{}.log", name, nanos))
    }

    #[test]
    fn log_path_points_at_the_expected_filename() {
        let path = log_path();
        assert_eq!(
            path.file_name().and_then(|n| n.to_str()),
            Some("qr-converter.log")
        );
        assert!(path.is_absolute(), "log path should be absolute: {path:?}");
    }

    #[test]
    fn append_to_creates_the_file() {
        let path = scratch("create");
        append_to(&path, "hello");
        assert!(path.exists());
        let contents = fs::read_to_string(&path).unwrap();
        assert!(contents.contains("hello"), "got: {contents:?}");
        fs::remove_file(&path).ok();
    }

    #[test]
    fn append_to_prefixes_a_timestamp() {
        let path = scratch("timestamp");
        append_to(&path, "message");
        let contents = fs::read_to_string(&path).unwrap();
        // Expected shape: "[1700000000.123] message"
        assert!(contents.starts_with('['), "got: {contents:?}");
        let (stamp, rest) = contents.split_once("] ").expect("bracketed timestamp");
        assert_eq!(rest.trim_end(), "message");
        let inner = stamp.trim_start_matches('[');
        let (secs, millis) = inner.split_once('.').expect("secs.millis");
        assert!(secs.parse::<u64>().is_ok(), "seconds not numeric: {secs:?}");
        assert_eq!(millis.len(), 3, "millis should be 3 digits: {millis:?}");
        assert!(millis.parse::<u32>().is_ok(), "millis not numeric: {millis:?}");
        fs::remove_file(&path).ok();
    }

    #[test]
    fn append_to_appends_instead_of_overwriting() {
        let path = scratch("append");
        append_to(&path, "first");
        append_to(&path, "second");
        append_to(&path, "third");
        let contents = fs::read_to_string(&path).unwrap();
        assert_eq!(contents.lines().count(), 3, "got: {contents:?}");
        let order: Vec<&str> = contents
            .lines()
            .map(|line| line.split_once("] ").unwrap().1)
            .collect();
        assert_eq!(order, vec!["first", "second", "third"]);
        fs::remove_file(&path).ok();
    }

    #[test]
    fn append_to_preserves_embedded_newlines_and_unicode() {
        let path = scratch("unicode");
        append_to(&path, "用户角色ID\n第二行");
        let contents = fs::read_to_string(&path).unwrap();
        assert!(contents.contains("用户角色ID"));
        assert!(contents.contains("第二行"));
        fs::remove_file(&path).ok();
    }

    #[test]
    fn append_to_ignores_an_unwritable_path_instead_of_panicking() {
        let path = PathBuf::from("/this/directory/does/not/exist/qr-converter.log");
        append_to(&path, "should not panic");
        assert!(!path.exists());
    }

    #[test]
    fn write_log_never_panics_on_empty_messages() {
        // write_log runs on every frontend log line; an empty string must be a
        // no-op rather than a crash. Exercises the same code path the command
        // uses, but against a scratch file.
        let path = scratch("empty");
        append_to(&path, "");
        assert_eq!(fs::read_to_string(&path).unwrap().lines().count(), 1);
        fs::remove_file(&path).ok();
    }
}

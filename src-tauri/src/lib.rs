use std::fs::OpenOptions;
use std::io::Write;

// ── Log file path ─────────────────────────────────────────────────────────────
// Write next to the executable so the log is always easy to find after install.
// Falls back to the system temp dir if the exe directory isn't writable.

fn log_path() -> std::path::PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            return dir.join("qr-converter.log");
        }
    }
    std::env::temp_dir().join("qr-converter.log")
}

fn append_log(message: &str) {
    let path = log_path();
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        // Timestamp: seconds.milliseconds since Unix epoch (UTC, no extra deps)
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| format!("{}.{:03}", d.as_secs(), d.subsec_millis()))
            .unwrap_or_else(|_| "?".into());
        let _ = writeln!(f, "[{}] {}", ts, message);
    }
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

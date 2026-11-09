//! An out-of-process watchdog for the Risuai desktop app.
//!
//! When the webview runs out of memory, its renderer process dies and nothing inside the
//! page can record why. This crate runs a second copy of the app's own executable that
//! watches from outside: the page sends heartbeats (through the host's stdin pipe to the
//! watchdog), and the watchdog samples the memory of the host and the webview processes.
//! If the heartbeats stop, or the host disappears without saying goodbye, it writes a
//! report with the last samples, which the app picks up on its next start.
//!
//! The same binary is reused so there is nothing extra to bundle, sign or update.
//! `main` must call [`run_if_requested`] before anything else.

pub mod monitor;
mod probe;

use monitor::{Action, Config, Monitor};
use serde_json::{json, Value};
use std::ffi::OsString;
use std::fs;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const WATCHDOG_ARG: &str = "--risu-watchdog";
const TICK: Duration = Duration::from_secs(2);
const MAX_REPORT_FILES: usize = 20;
const REPORT_PREFIX: &str = "watchdog-";
const LAST_SESSION_FILE: &str = "last-session.json";
/// Heartbeats larger than this are dropped instead of relayed
pub const MAX_BEAT_BYTES: usize = 16 * 1024;

fn wall_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

// ---------------------------------------------------------------- watchdog side

/// Runs the watchdog if this process was started as one, returning its exit code.
/// Returns `None` for a normal app start.
pub fn run_if_requested() -> Option<i32> {
    let args: Vec<OsString> = std::env::args_os().collect();
    if args.get(1).map(|a| a == WATCHDOG_ARG) != Some(true) {
        return None;
    }
    let host_pid = args.get(2).and_then(|a| a.to_str()).and_then(|a| a.parse::<u32>().ok());
    let (Some(host_pid), Some(dir), Some(version), Some(session)) = (
        host_pid,
        args.get(3).map(PathBuf::from),
        args.get(4).and_then(|a| a.to_str()).map(String::from),
        args.get(5).and_then(|a| a.to_str()).map(String::from),
    ) else {
        return Some(2);
    };
    run(host_pid, &dir, version, session);
    Some(0)
}

enum Msg {
    Beat(Value),
    Bye,
    Closed,
}

fn run(host_pid: u32, dir: &Path, version: String, session: String) {
    let _ = fs::create_dir_all(dir);
    write_last_session(dir, &session, "running");

    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let stdin = io::stdin();
        for line in stdin.lock().lines() {
            let Ok(line) = line else { break };
            let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
            let sent = match msg.get("t").and_then(Value::as_str) {
                Some("beat") => tx.send(Msg::Beat(msg.get("p").cloned().unwrap_or(Value::Null))),
                Some("bye") => tx.send(Msg::Bye),
                _ => Ok(()),
            };
            if sent.is_err() {
                return;
            }
        }
        let _ = tx.send(Msg::Closed);
    });

    let start = Instant::now();
    let mono = || start.elapsed().as_millis() as u64;
    let mut monitor = Monitor::new(Config::default(), session.clone(), version);
    let mut probe = probe::Probe::new(host_pid);
    let mut next_tick = Instant::now();

    loop {
        let wait = next_tick.saturating_duration_since(Instant::now());
        let actions = match rx.recv_timeout(wait) {
            Ok(Msg::Beat(p)) => monitor.beat(mono(), wall_ms(), p),
            Ok(Msg::Bye) => {
                write_last_session(dir, &session, "clean");
                monitor.bye(mono(), wall_ms())
            }
            Ok(Msg::Closed) | Err(RecvTimeoutError::Disconnected) => {
                write_last_session(dir, &session, "unexpected");
                monitor.host_gone(mono(), wall_ms())
            }
            Err(RecvTimeoutError::Timeout) => {
                next_tick = Instant::now() + TICK;
                let snap = probe.snapshot();
                if !snap.host_alive {
                    write_last_session(dir, &session, "unexpected");
                }
                monitor.tick(mono(), wall_ms(), snap)
            }
        };
        for action in actions {
            match action {
                Action::Write { id, report } => write_report(dir, &id, &report),
                Action::Exit => return,
            }
        }
    }
}

fn write_atomic(path: &Path, value: &Value) {
    let tmp = path.with_extension("tmp");
    let ok = fs::write(&tmp, serde_json::to_vec(value).unwrap_or_default()).is_ok();
    if ok && fs::rename(&tmp, path).is_err() {
        let _ = fs::remove_file(&tmp);
    }
}

fn write_last_session(dir: &Path, session: &str, exit: &str) {
    write_atomic(&dir.join(LAST_SESSION_FILE), &json!({ "session": session, "exit": exit, "at": wall_ms() }));
}

fn report_files(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|e| e.path())
                .filter(|p| {
                    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    name.starts_with(REPORT_PREFIX) && name.ends_with(".json")
                })
                .collect()
        })
        .unwrap_or_default();
    // ids start with the detection time, so names sort oldest first
    files.sort();
    files
}

fn write_report(dir: &Path, id: &str, report: &Value) {
    write_atomic(&dir.join(format!("{REPORT_PREFIX}{id}.json")), report);
    let files = report_files(dir);
    if files.len() > MAX_REPORT_FILES {
        for old in &files[..files.len() - MAX_REPORT_FILES] {
            let _ = fs::remove_file(old);
        }
    }
}

// ---------------------------------------------------------------- host side

/// The host's end of the watchdog: owns the child process and its stdin pipe.
pub struct WatchdogHandle {
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
}

impl WatchdogHandle {
    /// Starts the watchdog as a copy of the current executable.
    pub fn spawn(report_dir: &Path, app_version: &str, session: &str) -> io::Result<Self> {
        let exe = std::env::current_exe()?;
        let mut cmd = Command::new(exe);
        cmd.arg(WATCHDOG_ARG)
            .arg(std::process::id().to_string())
            .arg(report_dir)
            .arg(app_version)
            .arg(session)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn()?;
        let stdin = child.stdin.take();
        Ok(Self { stdin: Mutex::new(stdin), child: Mutex::new(Some(child)) })
    }

    fn send(&self, msg: &Value) {
        let Ok(mut guard) = self.stdin.lock() else { return };
        let Some(stdin) = guard.as_mut() else { return };
        let mut line = msg.to_string();
        line.push('\n');
        if stdin.write_all(line.as_bytes()).and_then(|_| stdin.flush()).is_err() {
            // The watchdog is gone; stop trying
            *guard = None;
        }
    }

    /// Relays a heartbeat from the page.
    pub fn beat(&self, payload: Value) {
        self.send(&json!({ "t": "beat", "p": payload }));
    }

    /// Tells the watchdog this is a normal exit and waits briefly for it to finish.
    /// Safe to call more than once.
    pub fn stop(&self) {
        self.send(&json!({ "t": "bye" }));
        if let Ok(mut guard) = self.stdin.lock() {
            *guard = None;
        }
        let Ok(mut guard) = self.child.lock() else { return };
        let Some(mut child) = guard.take() else { return };
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
                _ => break,
            }
        }
        // It must not outlive us: on Windows it would keep the executable locked during updates
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// A session id for [`WatchdogHandle::spawn`].
pub fn new_session_id() -> String {
    format!("{}-{}", wall_ms(), std::process::id())
}

/// How the previous session ended, as its watchdog last recorded it:
/// `{ session, exit: "clean" | "unexpected" | "running", at }`.
/// "running" means the watchdog itself was killed (for example by a system shutdown).
/// Read it before spawning a new watchdog, which overwrites it.
pub fn read_last_session(dir: &Path) -> Option<Value> {
    let bytes = fs::read(dir.join(LAST_SESSION_FILE)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Reads and deletes the reports written by watchdogs of other sessions.
pub fn take_reports(dir: &Path, current_session: &str) -> Vec<Value> {
    let mut reports = Vec::new();
    for path in report_files(dir) {
        let Some(report) = fs::read(&path).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) else {
            let _ = fs::remove_file(&path);
            continue;
        };
        if report.get("session").and_then(Value::as_str) == Some(current_session) {
            continue;
        }
        let _ = fs::remove_file(&path);
        reports.push(report);
    }
    reports
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("risu-watchdog-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reports_are_capped_and_taken_once() {
        let dir = temp_dir("cap");
        for i in 0..25u64 {
            write_report(&dir, &format!("{}-1", 1_000_000 + i), &json!({ "session": "old", "n": i }));
        }
        write_report(&dir, "2000000-1", &json!({ "session": "now" }));
        let taken = take_reports(&dir, "now");
        assert_eq!(taken.len(), MAX_REPORT_FILES - 1);
        // the oldest were dropped
        assert_eq!(taken[0]["n"], 25 - (MAX_REPORT_FILES as u64 - 1));
        assert!(take_reports(&dir, "now").is_empty());
        // the current session's report stays
        assert_eq!(take_reports(&dir, "other").len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn last_session_round_trips() {
        let dir = temp_dir("last");
        assert!(read_last_session(&dir).is_none());
        write_last_session(&dir, "abc", "clean");
        let last = read_last_session(&dir).unwrap();
        assert_eq!(last["session"], "abc");
        assert_eq!(last["exit"], "clean");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_normal_start_is_not_the_watchdog() {
        assert!(run_if_requested().is_none());
    }

    #[test]
    fn the_probe_sees_this_process() {
        let snap = probe::Probe::new(std::process::id()).snapshot();
        assert!(snap.host_alive);
        assert!(snap.host_rss_mb > 0.0);
        assert!(snap.sys_total_mb > 0.0);
    }
}

//! Out-of-memory watchdog for the Tauri build.
//!
//! The frontend reports what it is doing (running tasks, recent activity, JS heap) through
//! `watchdog_heartbeat`, and a monitor thread samples the memory of the app process and of
//! its webview processes. Both go into a small "black box" file,
//! `<AppData>/watchdog/session.json`, so the last known state survives when a process dies.
//!
//! A report is written to `<AppData>/watchdog/reports/` when
//! - the previous run ended without a clean exit (checked at startup),
//! - the webview renderer process is terminated (WebView2, WebKitGTK and WKWebView hooks),
//! - the frontend catches a JavaScript out-of-memory error, or
//! - the app is closed while the frontend is not responding.
//!
//! Reports that point at a memory problem are shown to the user on the next page load, or in
//! a native dialog when the page cannot be brought back.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::alloc::{GlobalAlloc, Layout, System};
use std::collections::{HashMap, VecDeque};
use std::fmt::Write as _;
use std::fs::{self, File};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock, TryLockError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, Runtime};

const SESSION_VERSION: u32 = 1;
/// How often the monitor thread samples memory and checks the heartbeat
const SAMPLE_INTERVAL: Duration = Duration::from_secs(2);
/// Must match the frontend (src/ts/watchdog.svelte.ts)
const HEARTBEAT_INTERVAL_MS: u64 = 2000;
/// Two minutes of samples
const MAX_SAMPLES: usize = 60;
const MAX_EVENTS: usize = 40;
const MAX_REPORT_FILES: usize = 20;
/// Reports older than this are no longer shown
const REPORT_NOTIFY_WINDOW_MS: u64 = 7 * 24 * 60 * 60 * 1000;
/// The frontend counts as unresponsive after this long without a heartbeat
const STALL_VISIBLE: Duration = Duration::from_secs(20);
/// Hidden pages get their timers throttled hard, so they get much longer
const STALL_HIDDEN: Duration = Duration::from_secs(10 * 60);
/// A gap this long between monitor ticks means the machine was asleep
const SUSPEND_GAP: Duration = Duration::from_secs(15);
/// Write the black box at least this often, even when nothing changes much
const PERSIST_MAX_AGE: Duration = Duration::from_secs(30);
/// At most MAX_RELOADS_IN_WINDOW automatic reloads after renderer crashes, so a page that
/// runs out of memory while loading does not crash in a loop
const RELOAD_WINDOW: Duration = Duration::from_secs(5 * 60);
const MAX_RELOADS_IN_WINDOW: usize = 2;
const MAX_FRONTEND_SNAPSHOT_BYTES: usize = 64 * 1024;
const MAX_ALLOC_FAILURE_RECORDS: u64 = 8;
const MIB: u64 = 1024 * 1024;

// ---------------------------------------------------------------------------------------------
// Native allocation failures
// ---------------------------------------------------------------------------------------------

/// Global allocator that records failed allocations before Rust aborts the process.
///
/// Stable Rust has no hook for allocation failure, so the failure is written here instead,
/// to a file opened in advance and without allocating.
pub struct WatchdogAllocator;

static ALLOC_FAILURE_LOG: OnceLock<File> = OnceLock::new();
static ALLOC_FAILURE_COUNT: AtomicU64 = AtomicU64::new(0);

unsafe impl GlobalAlloc for WatchdogAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let ptr = System.alloc(layout);
        if ptr.is_null() {
            record_alloc_failure(layout.size());
        }
        ptr
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let ptr = System.alloc_zeroed(layout);
        if ptr.is_null() {
            record_alloc_failure(layout.size());
        }
        ptr
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let new_ptr = System.realloc(ptr, layout, new_size);
        if new_ptr.is_null() {
            record_alloc_failure(new_size);
        }
        new_ptr
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout)
    }
}

/// Fixed-size buffer to format into without allocating
struct StackBuf<const N: usize> {
    buf: [u8; N],
    len: usize,
}

impl<const N: usize> StackBuf<N> {
    fn new() -> Self {
        Self {
            buf: [0; N],
            len: 0,
        }
    }

    fn as_bytes(&self) -> &[u8] {
        &self.buf[..self.len]
    }

    /// Writes `s` as a JSON string, cut short (on a char boundary) before `limit` bytes
    fn write_json_str(&mut self, s: &str, limit: usize) {
        let _ = self.write_char('"');
        for c in s.chars() {
            if self.len + 8 >= limit.min(N) {
                break;
            }
            let _ = match c {
                '"' => self.write_str("\\\""),
                '\\' => self.write_str("\\\\"),
                c if (c as u32) < 0x20 => self.write_char(' '),
                c => self.write_char(c),
            };
        }
        let _ = self.write_char('"');
    }
}

impl<const N: usize> std::fmt::Write for StackBuf<N> {
    fn write_str(&mut self, s: &str) -> std::fmt::Result {
        let n = s.len().min(N - self.len);
        self.buf[self.len..self.len + n].copy_from_slice(&s.as_bytes()[..n]);
        self.len += n;
        if n == s.len() {
            Ok(())
        } else {
            Err(std::fmt::Error)
        }
    }
}

/// Called from inside the allocator: must not allocate
fn record_alloc_failure(size: usize) {
    if ALLOC_FAILURE_COUNT.fetch_add(1, Ordering::Relaxed) >= MAX_ALLOC_FAILURE_RECORDS {
        return;
    }
    let Some(file) = ALLOC_FAILURE_LOG.get() else {
        return;
    };
    let mut out = StackBuf::<2048>::new();
    let _ = write!(
        out,
        "{{\"at\":{},\"size\":{},\"operations\":[",
        now_ms(),
        size
    );
    // try_lock: the failed allocation may come from this thread while it holds the lock
    if let Some(ops) = try_lock(&NATIVE_OPS) {
        for (i, op) in ops.iter().take(8).enumerate() {
            if out.len > 1700 {
                break;
            }
            if i > 0 {
                let _ = out.write_char(',');
            }
            out.write_json_str(&op.label, 1800);
        }
    }
    let _ = out.write_str("]}\n");
    let _ = (&*file).write_all(out.as_bytes());
}

// ---------------------------------------------------------------------------------------------
// Native operations
// ---------------------------------------------------------------------------------------------

struct NativeOp {
    id: u64,
    label: String,
    started_at: u64,
}

static NATIVE_OPS: Mutex<Vec<NativeOp>> = Mutex::new(Vec::new());
static NEXT_NATIVE_OP_ID: AtomicU64 = AtomicU64::new(1);

/// Keeps a native operation listed as running until dropped
pub struct NativeOpGuard(u64);

/// Lists a native operation (e.g. a request) as running, so a report can name it
pub fn track_native_op(label: String) -> NativeOpGuard {
    let id = NEXT_NATIVE_OP_ID.fetch_add(1, Ordering::Relaxed);
    lock(&NATIVE_OPS).push(NativeOp {
        id,
        label,
        started_at: now_ms(),
    });
    NativeOpGuard(id)
}

impl Drop for NativeOpGuard {
    fn drop(&mut self) {
        lock(&NATIVE_OPS).retain(|op| op.id != self.0);
    }
}

fn native_ops_snapshot() -> Vec<NativeOpInfo> {
    lock(&NATIVE_OPS)
        .iter()
        .map(|op| NativeOpInfo {
            label: op.label.clone(),
            started_at: op.started_at,
        })
        .collect()
}

/// Drops the query, fragment and credentials, which may hold API keys
pub fn redact_url(raw: &str) -> String {
    let redacted = match url::Url::parse(raw) {
        Ok(mut url) => {
            url.set_query(None);
            url.set_fragment(None);
            let _ = url.set_username("");
            let _ = url.set_password(None);
            url.to_string()
        }
        Err(_) => raw.split(['?', '#']).next().unwrap_or_default().to_string(),
    };
    truncate(&redacted, 200)
}

// ---------------------------------------------------------------------------------------------
// Black box data
// ---------------------------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Copy, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct MemSample {
    at: u64,
    /// Resident memory of the app process itself
    native_rss: u64,
    /// Resident memory of all webview processes started by the app (not visible on macOS)
    webview_rss: u64,
    webview_processes: u32,
    largest_webview_rss: u64,
    system_total: u64,
    system_available: u64,
}

impl MemSample {
    fn app_total(&self) -> u64 {
        self.native_rss + self.webview_rss
    }
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct NativeEvent {
    at: u64,
    kind: String,
    detail: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct NativeOpInfo {
    label: String,
    started_at: u64,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Session {
    version: u32,
    app_version: String,
    os: String,
    arch: String,
    pid: u32,
    started_at: u64,
    updated_at: u64,
    clean_exit: bool,
    exited_at: Option<u64>,
    /// Last snapshot sent by the frontend: running tasks, recent activity, JS heap...
    frontend: Option<Value>,
    last_heartbeat_at: Option<u64>,
    frontend_stalled_since: Option<u64>,
    samples: VecDeque<MemSample>,
    peak: Option<MemSample>,
    events: VecDeque<NativeEvent>,
    native_operations: Vec<NativeOpInfo>,
}

impl Session {
    fn lang(&self) -> &str {
        self.frontend
            .as_ref()
            .and_then(|f| f.get("lang"))
            .and_then(Value::as_str)
            .unwrap_or("en")
    }
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Report {
    id: String,
    created_at: u64,
    /// What happened, e.g. `rendererOutOfMemory` (see `build_report`)
    verdict: String,
    likely_out_of_memory: bool,
    /// Whether the user should be told about it
    notify: bool,
    notified: bool,
    /// Memory signs found in the black box, e.g. `jsHeapNearLimit`
    evidence: Vec<String>,
    /// One line in English, for logs
    summary: String,
    trigger: Value,
    native_alloc_failures: Vec<Value>,
    file: Option<String>,
    session: Session,
}

/// A webview process that went away
pub struct RendererFailure {
    pub engine: &'static str,
    pub kind: Option<String>,
    pub reason: Option<String>,
    pub out_of_memory: bool,
    pub exit_code: Option<i32>,
    pub description: Option<String>,
    /// Only a subframe (such as a plugin iframe) died; the page itself is alive
    pub frame_only: bool,
    /// The page can come back with a reload
    pub reloadable: bool,
}

impl RendererFailure {
    fn describe(&self) -> String {
        let mut text = self.engine.to_string();
        for part in [&self.kind, &self.reason, &self.description]
            .into_iter()
            .flatten()
        {
            text.push(' ');
            text.push_str(part);
        }
        if let Some(code) = self.exit_code {
            let _ = write!(text, " exit={code}");
        }
        truncate(&text, 400)
    }
}

enum Trigger<'a> {
    PreviousRunEnded,
    Renderer(&'a RendererFailure),
    JsError {
        message: String,
        stack: Option<String>,
    },
    ExitWhileUnresponsive,
}

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

struct Watchdog {
    dir: PathBuf,
    session: Session,
    pending: Vec<Report>,
    dirty: bool,
    last_persist: Instant,
    last_persisted_sample: Option<MemSample>,
    last_heartbeat: Option<Instant>,
    frontend_visible: bool,
    frontend_rev: Option<(String, u64)>,
    last_tick: Instant,
    reloads: VecDeque<Instant>,
}

impl Watchdog {
    fn push_event(&mut self, kind: &str, detail: String) {
        self.session.events.push_back(NativeEvent {
            at: now_ms(),
            kind: kind.to_string(),
            detail,
        });
        while self.session.events.len() > MAX_EVENTS {
            self.session.events.pop_front();
        }
        self.dirty = true;
    }

    fn session_snapshot(&self) -> Session {
        let mut session = self.session.clone();
        session.native_operations = native_ops_snapshot();
        session.updated_at = now_ms();
        session
    }

    fn allow_reload(&mut self) -> bool {
        let now = Instant::now();
        self.reloads
            .retain(|at| now.duration_since(*at) < RELOAD_WINDOW);
        if self.reloads.len() >= MAX_RELOADS_IN_WINDOW {
            return false;
        }
        self.reloads.push_back(now);
        true
    }

    /// Returns whether the black box should be written now
    fn tick(&mut self, sample: MemSample) -> bool {
        let now = Instant::now();
        let gap = now.duration_since(self.last_tick);
        self.last_tick = now;
        if gap > SUSPEND_GAP {
            // Nobody could send heartbeats while the machine was asleep
            if self.last_heartbeat.is_some() {
                self.last_heartbeat = Some(now);
            }
            self.push_event(
                "suspended",
                format!("monitor paused for {}s", gap.as_secs()),
            );
        }

        let significant = self
            .last_persisted_sample
            .is_none_or(|previous| sample_changed(&previous, &sample));
        if self
            .session
            .peak
            .is_none_or(|peak| sample.app_total() > peak.app_total())
        {
            self.session.peak = Some(sample);
        }
        self.session.samples.push_back(sample);
        while self.session.samples.len() > MAX_SAMPLES {
            self.session.samples.pop_front();
        }

        if let Some(last) = self.last_heartbeat {
            let threshold = if self.frontend_visible {
                STALL_VISIBLE
            } else {
                STALL_HIDDEN
            };
            let silent = now.duration_since(last);
            if silent > threshold && self.session.frontend_stalled_since.is_none() {
                self.session.frontend_stalled_since =
                    Some(now_ms().saturating_sub(silent.as_millis() as u64));
                self.push_event(
                    "frontendUnresponsive",
                    format!("no heartbeat for {}s", silent.as_secs()),
                );
            }
        }

        self.dirty || significant || self.last_persist.elapsed() > PERSIST_MAX_AGE
    }

    fn on_heartbeat(&mut self, snapshot: Value) {
        if let Some(since) = self.session.frontend_stalled_since.take() {
            self.push_event(
                "frontendResponsive",
                format!(
                    "responsive again after {}s",
                    now_ms().saturating_sub(since) / 1000
                ),
            );
        }
        self.last_heartbeat = Some(Instant::now());
        self.session.last_heartbeat_at = Some(now_ms());
        self.frontend_visible = snapshot
            .get("visible")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        // The frontend bumps `rev` when its tasks or activity change
        let rev = (
            snapshot
                .get("pageId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            snapshot.get("rev").and_then(Value::as_u64).unwrap_or(0),
        );
        if self.frontend_rev.as_ref() != Some(&rev) {
            self.frontend_rev = Some(rev);
            self.dirty = true;
        }
        self.session.frontend = Some(limit_snapshot(snapshot));
    }
}

static WATCHDOG: OnceLock<Mutex<Watchdog>> = OnceLock::new();
/// Taken before WATCHDOG while writing session.json, so writes land in order
static PERSIST_LOCK: Mutex<()> = Mutex::new(());

fn with_watchdog<T>(f: impl FnOnce(&mut Watchdog) -> T) -> Option<T> {
    WATCHDOG.get().map(|state| f(&mut lock(state)))
}

// ---------------------------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------------------------

/// Starts the watchdog. Reads what the previous run left behind before anything else.
pub fn init<R: Runtime>(app: &AppHandle<R>) {
    if WATCHDOG.get().is_some() {
        return;
    }
    let dir = match app.path().app_data_dir() {
        Ok(dir) => dir.join("watchdog"),
        Err(error) => {
            eprintln!("watchdog: no app data directory: {error}");
            return;
        }
    };
    if let Err(error) = fs::create_dir_all(dir.join("reports")) {
        eprintln!("watchdog: cannot create {}: {error}", dir.display());
        return;
    }

    let session_path = dir.join("session.json");
    let alloc_log_path = dir.join("native-alloc-failures.log");

    if let Some(previous) = read_json::<Session>(&session_path) {
        if !previous.clean_exit {
            let failures = read_alloc_failures(&alloc_log_path);
            let report = build_report(previous, Trigger::PreviousRunEnded, failures);
            eprintln!(
                "watchdog: previous run did not exit cleanly: {}",
                report.summary
            );
            save_report(&dir, report);
        }
    }
    let pending = load_pending_reports(&dir);

    match File::create(&alloc_log_path) {
        Ok(file) => {
            let _ = ALLOC_FAILURE_LOG.set(file);
        }
        Err(error) => eprintln!("watchdog: cannot open allocation log: {error}"),
    }
    // Let the lock and the list allocate now rather than while recording a failure
    lock(&NATIVE_OPS).reserve(16);

    let now = now_ms();
    let session = Session {
        version: SESSION_VERSION,
        app_version: app.package_info().version.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        pid: std::process::id(),
        started_at: now,
        updated_at: now,
        ..Default::default()
    };
    let _ = WATCHDOG.set(Mutex::new(Watchdog {
        dir,
        session,
        pending,
        dirty: true,
        last_persist: Instant::now(),
        last_persisted_sample: None,
        last_heartbeat: None,
        frontend_visible: true,
        frontend_rev: None,
        last_tick: Instant::now(),
        reloads: VecDeque::new(),
    }));
    persist();

    if let Err(error) = std::thread::Builder::new()
        .name("watchdog".into())
        .spawn(monitor_loop)
    {
        eprintln!("watchdog: cannot start monitor thread: {error}");
    }
}

/// Marks the run as finished cleanly. Called on `RunEvent::Exit`.
pub fn on_exit() {
    let Some((dir, session, stalled)) = with_watchdog(|w| {
        (
            w.dir.clone(),
            w.session_snapshot(),
            w.session.frontend_stalled_since.is_some(),
        )
    }) else {
        return;
    };
    if stalled {
        save_report(
            &dir,
            build_report(session, Trigger::ExitWhileUnresponsive, Vec::new()),
        );
    }
    with_watchdog(|w| {
        w.session.clean_exit = true;
        w.session.exited_at = Some(now_ms());
        w.push_event("exit", String::new());
    });
    persist();
}

pub fn on_page_load<R: Runtime>(
    _webview: &tauri::Webview<R>,
    payload: &tauri::webview::PageLoadPayload<'_>,
) {
    let kind = match payload.event() {
        tauri::webview::PageLoadEvent::Started => "pageLoadStarted",
        tauri::webview::PageLoadEvent::Finished => "pageLoadFinished",
    };
    let url = redact_url(payload.url().as_str());
    with_watchdog(|w| {
        if kind == "pageLoadStarted" && w.last_heartbeat.is_some() {
            // Give the new page time to boot before it counts as unresponsive
            w.last_heartbeat = Some(Instant::now());
        }
        w.push_event(kind, url);
    });
}

fn monitor_loop() {
    // sysinfo keeps /proc/<pid>/stat files open on Linux unless told otherwise
    sysinfo::set_open_files_limit(0);
    let mut sampler = MemorySampler::new();
    loop {
        std::thread::sleep(SAMPLE_INTERVAL);
        let sample = sampler.sample();
        if with_watchdog(|w| w.tick(sample)).unwrap_or(false) {
            persist();
        }
    }
}

fn persist() {
    let _guard = lock(&PERSIST_LOCK);
    let Some((path, bytes)) = with_watchdog(|w| {
        w.session.updated_at = now_ms();
        w.session.native_operations = native_ops_snapshot();
        w.dirty = false;
        w.last_persist = Instant::now();
        w.last_persisted_sample = w.session.samples.back().copied();
        (w.dir.join("session.json"), serde_json::to_vec(&w.session))
    }) else {
        return;
    };
    if let Ok(bytes) = bytes {
        let _ = write_atomic(&path, &bytes);
    }
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

/// Called by each page load. Returns the reports the user has not seen yet; they stay pending
/// until `watchdog_ack_reports`, so a page that goes away while showing one shows it again.
#[tauri::command]
pub async fn watchdog_start(page_id: String) -> Value {
    let Some((reports, dir)) = with_watchdog(|w| {
        w.last_heartbeat = Some(Instant::now());
        w.session.frontend_stalled_since = None;
        w.session.frontend = None;
        w.frontend_rev = None;
        w.push_event("pageStarted", truncate(&page_id, 64));
        (w.pending.clone(), w.dir.clone())
    }) else {
        return json!({ "enabled": false });
    };
    persist();
    json!({
        "enabled": true,
        "reports": reports,
        "directory": dir,
        "heartbeatIntervalMs": HEARTBEAT_INTERVAL_MS,
    })
}

/// The user closed the reports with these ids
#[tauri::command]
pub async fn watchdog_ack_reports(ids: Vec<String>) {
    let acked = with_watchdog(|w| {
        let (acked, kept): (Vec<Report>, Vec<Report>) = std::mem::take(&mut w.pending)
            .into_iter()
            .partition(|report| ids.contains(&report.id));
        w.pending = kept;
        acked
    })
    .unwrap_or_default();
    for report in &acked {
        mark_notified(report);
    }
}

/// Latest frontend state. It reaches disk on the next monitor tick when its tasks or activity
/// changed; renderer crash reports are built from memory and do not wait for that.
#[tauri::command]
pub async fn watchdog_heartbeat(snapshot: Value) {
    with_watchdog(|w| w.on_heartbeat(snapshot));
}

/// The frontend caught an out-of-memory error. Returns the saved report.
#[tauri::command]
pub async fn watchdog_report_js_error(
    message: String,
    stack: Option<String>,
    snapshot: Option<Value>,
) -> Option<Report> {
    let (dir, session) = with_watchdog(|w| {
        if let Some(snapshot) = snapshot {
            w.on_heartbeat(snapshot);
        }
        w.push_event("jsOutOfMemory", truncate(&message, 300));
        (w.dir.clone(), w.session_snapshot())
    })?;
    let trigger = Trigger::JsError {
        message: truncate(&message, 2000),
        stack: stack.map(|stack| truncate(&stack, 8000)),
    };
    let mut report = build_report(session, trigger, Vec::new());
    // The page shows it right away
    report.notified = true;
    let report = save_report(&dir, report);
    persist();
    Some(report)
}

// ---------------------------------------------------------------------------------------------
// Renderer termination
// ---------------------------------------------------------------------------------------------

/// Hooks the platform's "webview process terminated" event for this window.
/// On macOS this goes through `Builder::on_web_content_process_terminate` in main.rs instead.
pub fn attach<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    #[cfg(windows)]
    attach_webview2(window);
    #[cfg(target_os = "linux")]
    attach_webkitgtk(window);
    #[cfg(not(any(windows, target_os = "linux")))]
    let _ = window;
}

pub fn on_renderer_terminated<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    failure: RendererFailure,
) {
    let Some((dir, session, reload)) = with_watchdog(|w| {
        let kind = if failure.frame_only {
            "frameTerminated"
        } else {
            "rendererTerminated"
        };
        w.push_event(kind, failure.describe());
        let session = w.session_snapshot();
        let mut reload = false;
        if !failure.frame_only {
            // The dead page sends no more heartbeats; the next page starts over
            w.last_heartbeat = None;
            w.session.frontend_stalled_since = None;
            reload = failure.reloadable && w.allow_reload();
        }
        (w.dir.clone(), session, reload)
    }) else {
        return;
    };

    let mut report = build_report(session, Trigger::Renderer(&failure), Vec::new());
    eprintln!("watchdog: {}", report.summary);
    if failure.frame_only {
        // The page is alive and shows it right away
        report.notified = true;
    }
    let report = save_report(&dir, report);
    if !failure.frame_only && reload {
        with_watchdog(|w| w.pending.push(report.clone()));
    }
    persist();

    if failure.frame_only {
        let _ = app.emit("watchdog_report", &report);
        return;
    }
    let reloaded = reload
        && app
            .get_webview_window(label)
            .is_some_and(|window| window.reload().is_ok());
    if !reloaded {
        show_native_dialog(app, &report);
    }
}

/// Records something that is worth keeping but is not a report on its own
#[cfg(any(windows, target_os = "linux"))]
fn note_event(kind: &str, detail: String) {
    with_watchdog(|w| w.push_event(kind, truncate(&detail, 400)));
}

#[cfg(windows)]
fn attach_webview2<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    use webview2_com::ProcessFailedEventHandler;

    let app = window.app_handle().clone();
    let label = window.label().to_string();
    let result = window.with_webview(move |platform| unsafe {
        let core = match platform.controller().CoreWebView2() {
            Ok(core) => core,
            Err(error) => {
                eprintln!("watchdog: no CoreWebView2: {error}");
                return;
            }
        };
        let handler = ProcessFailedEventHandler::create(Box::new(move |_sender, args| {
            if let Some(args) = args {
                handle_webview2_failure(&app, &label, &args);
            }
            Ok(())
        }));
        let mut token = 0i64;
        if let Err(error) = core.add_ProcessFailed(&handler, &mut token) {
            eprintln!("watchdog: cannot listen for ProcessFailed: {error}");
        }
    });
    if let Err(error) = result {
        eprintln!("watchdog: cannot reach the webview: {error}");
    }
}

#[cfg(windows)]
unsafe fn handle_webview2_failure<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    args: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2ProcessFailedEventArgs,
) {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use windows_core::{Interface, PWSTR};

    let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
    let _ = args.ProcessFailedKind(&mut kind);

    let mut reason = None;
    let mut exit_code = None;
    let mut description = None;
    let mut frames = Vec::new();
    if let Ok(args2) = args.cast::<ICoreWebView2ProcessFailedEventArgs2>() {
        let mut value = COREWEBVIEW2_PROCESS_FAILED_REASON::default();
        if args2.Reason(&mut value).is_ok() {
            reason = Some(value);
        }
        let mut code = 0i32;
        if args2.ExitCode(&mut code).is_ok() {
            exit_code = Some(code);
        }
        let mut text = PWSTR::null();
        if args2.ProcessDescription(&mut text).is_ok() {
            let text = webview2_com::take_pwstr(text);
            if !text.is_empty() {
                description = Some(text);
            }
        }
        frames = webview2_failed_frames(&args2);
    }

    let kind_name = match kind {
        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED => "BROWSER_PROCESS_EXITED",
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED => "RENDER_PROCESS_EXITED",
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE => {
            "RENDER_PROCESS_UNRESPONSIVE"
        }
        COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED => {
            "FRAME_RENDER_PROCESS_EXITED"
        }
        COREWEBVIEW2_PROCESS_FAILED_KIND_UTILITY_PROCESS_EXITED => "UTILITY_PROCESS_EXITED",
        COREWEBVIEW2_PROCESS_FAILED_KIND_SANDBOX_HELPER_PROCESS_EXITED => {
            "SANDBOX_HELPER_PROCESS_EXITED"
        }
        COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED => "GPU_PROCESS_EXITED",
        _ => "UNKNOWN_PROCESS_EXITED",
    };
    let reason_name = reason.map(|reason| match reason {
        COREWEBVIEW2_PROCESS_FAILED_REASON_UNRESPONSIVE => "UNRESPONSIVE",
        COREWEBVIEW2_PROCESS_FAILED_REASON_TERMINATED => "TERMINATED",
        COREWEBVIEW2_PROCESS_FAILED_REASON_CRASHED => "CRASHED",
        COREWEBVIEW2_PROCESS_FAILED_REASON_LAUNCH_FAILED => "LAUNCH_FAILED",
        COREWEBVIEW2_PROCESS_FAILED_REASON_OUT_OF_MEMORY => "OUT_OF_MEMORY",
        COREWEBVIEW2_PROCESS_FAILED_REASON_PROFILE_DELETED => "PROFILE_DELETED",
        _ => "UNEXPECTED",
    });
    if !frames.is_empty() {
        let frames = format!("frames: {}", frames.join(", "));
        description = Some(match description {
            Some(text) => format!("{text}; {frames}"),
            None => frames,
        });
    }

    let failure = RendererFailure {
        engine: "WebView2",
        kind: Some(kind_name.to_string()),
        reason: reason_name.map(str::to_string),
        out_of_memory: reason == Some(COREWEBVIEW2_PROCESS_FAILED_REASON_OUT_OF_MEMORY),
        exit_code,
        description,
        frame_only: kind == COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED,
        reloadable: kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
    };
    match kind {
        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED
        | COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED
        | COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED => {
            on_renderer_terminated(app, label, failure)
        }
        // GPU and utility processes are restarted by WebView2; a hung renderer shows up as a
        // frontend stall as well
        _ => note_event("webviewProcessFailed", failure.describe()),
    }
}

/// Names and (redacted) sources of the frames that lived in the failed process
#[cfg(windows)]
unsafe fn webview2_failed_frames(
    args: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2ProcessFailedEventArgs2,
) -> Vec<String> {
    use windows_core::{BOOL, PWSTR};

    let mut frames = Vec::new();
    let Ok(iterator) = args
        .FrameInfosForFailedProcess()
        .and_then(|collection| collection.GetIterator())
    else {
        return frames;
    };
    while frames.len() < 8 {
        let mut has_current = BOOL::default();
        if iterator.HasCurrent(&mut has_current).is_err() || !has_current.as_bool() {
            break;
        }
        if let Ok(info) = iterator.GetCurrent() {
            let mut name = PWSTR::null();
            let mut source = PWSTR::null();
            let name = if info.Name(&mut name).is_ok() {
                webview2_com::take_pwstr(name)
            } else {
                String::new()
            };
            let source = if info.Source(&mut source).is_ok() {
                redact_url(&webview2_com::take_pwstr(source))
            } else {
                String::new()
            };
            frames.push(if name.is_empty() {
                source
            } else {
                format!("{name} <{source}>")
            });
        }
        let mut moved = BOOL::default();
        if iterator.MoveNext(&mut moved).is_err() || !moved.as_bool() {
            break;
        }
    }
    frames
}

#[cfg(target_os = "linux")]
fn attach_webkitgtk<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    use webkit2gtk::{WebProcessTerminationReason, WebViewExt};

    let app = window.app_handle().clone();
    let label = window.label().to_string();
    let result = window.with_webview(move |platform| {
        platform
            .inner()
            .connect_web_process_terminated(move |_view, reason| {
                let (reason_name, out_of_memory) = match reason {
                    WebProcessTerminationReason::ExceededMemoryLimit => {
                        ("EXCEEDED_MEMORY_LIMIT", true)
                    }
                    WebProcessTerminationReason::Crashed => ("CRASHED", false),
                    WebProcessTerminationReason::TerminatedByApi => {
                        // Somebody asked for it; not a failure
                        note_event("webProcessTerminated", "TERMINATED_BY_API".into());
                        return;
                    }
                    _ => ("UNKNOWN", false),
                };
                on_renderer_terminated(
                    &app,
                    &label,
                    RendererFailure {
                        engine: "WebKitGTK",
                        kind: Some("WEB_PROCESS_TERMINATED".into()),
                        reason: Some(reason_name.into()),
                        out_of_memory,
                        exit_code: None,
                        description: None,
                        frame_only: false,
                        reloadable: true,
                    },
                );
            });
    });
    if let Err(error) = result {
        eprintln!("watchdog: cannot reach the webview: {error}");
    }
}

/// `Builder::on_web_content_process_terminate` handler. WKWebView gives no reason.
#[cfg(target_os = "macos")]
pub fn on_web_content_process_terminate<R: Runtime>(webview: &tauri::Webview<R>) {
    on_renderer_terminated(
        webview.app_handle(),
        webview.label(),
        RendererFailure {
            engine: "WKWebView",
            kind: Some("WEB_CONTENT_PROCESS_TERMINATED".into()),
            reason: None,
            out_of_memory: false,
            exit_code: None,
            description: None,
            frame_only: false,
            reloadable: true,
        },
    );
}

fn show_native_dialog<R: Runtime>(app: &AppHandle<R>, report: &Report) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

    let korean = report.session.lang() == "ko";
    let location = describe_location(&report.session);
    let file = report.file.as_deref().unwrap_or("-");
    let message = if korean {
        format!(
            "{}\n\n발생 위치: {}\n\n보고서 파일: {}\n\n앱을 다시 시작해 주세요.",
            verdict_text(&report.verdict, true),
            location,
            file
        )
    } else {
        format!(
            "{}\n\nWhere: {}\n\nReport file: {}\n\nPlease restart the app.",
            verdict_text(&report.verdict, false),
            location,
            file
        )
    };
    app.dialog()
        .message(message)
        .title("RisuAI")
        .kind(MessageDialogKind::Error)
        .show(|_| {});
}

// ---------------------------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------------------------

fn build_report(session: Session, trigger: Trigger<'_>, alloc_failures: Vec<Value>) -> Report {
    let evidence = memory_evidence(&session);
    let memory_critical = !evidence.is_empty();
    let stalled = session.frontend_stalled_since.is_some();
    // A hidden page may just have been throttled or frozen by the webview, so a stall there
    // is not worth bothering the user about on its own
    let visible = session
        .frontend
        .as_ref()
        .and_then(|f| f.get("visible"))
        .and_then(Value::as_bool)
        .unwrap_or(true);

    let (verdict, likely_out_of_memory, notify, trigger) = match trigger {
        Trigger::PreviousRunEnded => {
            let trigger = json!({ "type": "previousRunEnded" });
            if !alloc_failures.is_empty() {
                ("nativeOutOfMemory", true, true, trigger)
            } else if memory_critical {
                ("likelyOutOfMemory", true, true, trigger)
            } else if stalled {
                ("unresponsiveThenTerminated", false, visible, trigger)
            } else {
                // Killed, power loss, OS shutdown... nothing points at memory, so stay quiet
                ("unexpectedTermination", false, false, trigger)
            }
        }
        Trigger::Renderer(failure) => {
            let verdict = match (failure.frame_only, failure.out_of_memory) {
                (true, true) => "frameOutOfMemory",
                (true, false) => "frameCrashed",
                (false, true) => "rendererOutOfMemory",
                (false, false) => "rendererCrashed",
            };
            let trigger = json!({
                "type": "renderer",
                "engine": failure.engine,
                "kind": failure.kind,
                "reason": failure.reason,
                "exitCode": failure.exit_code,
                "description": failure.description,
            });
            (
                verdict,
                failure.out_of_memory || memory_critical,
                true,
                trigger,
            )
        }
        Trigger::JsError { message, stack } => (
            "jsOutOfMemory",
            true,
            true,
            json!({ "type": "jsError", "message": message, "stack": stack }),
        ),
        Trigger::ExitWhileUnresponsive => (
            "unresponsiveAtExit",
            memory_critical,
            visible || memory_critical,
            json!({ "type": "exitWhileUnresponsive" }),
        ),
    };

    let created_at = now_ms();
    let summary = format!(
        "{} Where: {}",
        verdict_text(verdict, false),
        describe_location(&session)
    );
    Report {
        id: format!("{created_at}-{verdict}"),
        created_at,
        verdict: verdict.to_string(),
        likely_out_of_memory,
        notify,
        notified: false,
        evidence,
        summary,
        trigger,
        native_alloc_failures: alloc_failures,
        file: None,
        session,
    }
}

fn memory_evidence(session: &Session) -> Vec<String> {
    let mut evidence = Vec::new();
    if let Some(heap) = session.frontend.as_ref().and_then(|f| f.get("heap")) {
        let used = heap.get("used").and_then(Value::as_f64).unwrap_or(0.0);
        let limit = heap.get("limit").and_then(Value::as_f64).unwrap_or(0.0);
        if limit > 0.0 && used / limit >= 0.85 {
            evidence.push("jsHeapNearLimit".to_string());
        }
    }
    if let Some(last) = session.samples.back() {
        let percent_of_system =
            |bytes: u64| bytes.saturating_mul(100).checked_div(last.system_total);
        if percent_of_system(last.system_available).is_some_and(|percent| percent < 8) {
            evidence.push("systemMemoryLow".to_string());
        }
        if percent_of_system(last.app_total()).is_some_and(|percent| percent >= 70) {
            evidence.push("appMemoryHigh".to_string());
        }
        let window_start = last.at.saturating_sub(60_000);
        if let Some(first) = session.samples.iter().find(|s| s.at >= window_start) {
            let before = first.app_total();
            let now = last.app_total();
            if now >= before + 1024 * MIB && now >= before.saturating_mul(3) / 2 {
                evidence.push("memoryRisingFast".to_string());
            }
        }
    }
    evidence
}

/// Short description of what was running, newest first
fn describe_location(session: &Session) -> String {
    let mut parts = Vec::new();
    let frontend = session.frontend.as_ref();
    if let Some(tasks) = frontend
        .and_then(|f| f.get("tasks"))
        .and_then(Value::as_array)
    {
        for task in tasks.iter().rev().take(3) {
            let label = task.get("label").and_then(Value::as_str).unwrap_or("?");
            match task.get("detail").and_then(Value::as_str) {
                Some(detail) if !detail.is_empty() => parts.push(format!("{label} ({detail})")),
                _ => parts.push(label.to_string()),
            }
        }
    }
    for op in session.native_operations.iter().take(3) {
        parts.push(format!("native: {}", op.label));
    }
    if parts.is_empty() {
        let loaded = frontend
            .and_then(|f| f.get("loaded"))
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let stage = frontend
            .and_then(|f| f.get("stage"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !loaded && !stage.is_empty() {
            parts.push(format!("while loading: {stage}"));
        }
    }
    if parts.is_empty() {
        let last = frontend
            .and_then(|f| f.get("breadcrumbs"))
            .and_then(Value::as_array)
            .and_then(|crumbs| crumbs.last())
            .and_then(|crumb| crumb.get("message"))
            .and_then(Value::as_str);
        if let Some(last) = last {
            parts.push(format!("last activity: {last}"));
        }
    }
    if parts.is_empty() {
        "unknown".to_string()
    } else {
        truncate(&parts.join("; "), 600)
    }
}

fn verdict_text(verdict: &str, korean: bool) -> &'static str {
    match (verdict, korean) {
        ("nativeOutOfMemory", false) => {
            "The app process failed to allocate memory and was terminated."
        }
        ("nativeOutOfMemory", true) => "앱 프로세스가 메모리를 할당하지 못해 종료되었습니다.",
        ("rendererOutOfMemory", false) => "The webview ran out of memory and was terminated.",
        ("rendererOutOfMemory", true) => "웹뷰가 메모리 부족으로 종료되었습니다.",
        ("rendererCrashed", false) => "The webview process was terminated.",
        ("rendererCrashed", true) => "웹뷰 프로세스가 종료되었습니다.",
        ("frameOutOfMemory", false) => "A frame (such as a plugin) ran out of memory.",
        ("frameOutOfMemory", true) => "프레임(플러그인 등)이 메모리 부족으로 종료되었습니다.",
        ("frameCrashed", false) => "A frame process (such as a plugin) was terminated.",
        ("frameCrashed", true) => "프레임(플러그인 등) 프로세스가 종료되었습니다.",
        ("likelyOutOfMemory", false) => "The app was terminated while memory was running out.",
        ("likelyOutOfMemory", true) => "메모리가 부족한 상태에서 앱이 종료되었습니다.",
        ("unresponsiveThenTerminated", false) => {
            "The app stopped responding and was then terminated."
        }
        ("unresponsiveThenTerminated", true) => "앱이 응답하지 않다가 종료되었습니다.",
        ("unresponsiveAtExit", false) => "The app was closed while it was not responding.",
        ("unresponsiveAtExit", true) => "앱이 응답하지 않는 상태에서 닫혔습니다.",
        ("jsOutOfMemory", false) => "A script ran out of memory.",
        ("jsOutOfMemory", true) => "스크립트 실행 중 메모리가 부족했습니다.",
        (_, false) => "The app was terminated unexpectedly.",
        (_, true) => "앱이 예기치 않게 종료되었습니다.",
    }
}

fn save_report(dir: &Path, mut report: Report) -> Report {
    let reports_dir = dir.join("reports");
    let path = reports_dir.join(format!("{}.json", report.id));
    report.file = Some(path.to_string_lossy().into_owned());
    match serde_json::to_vec_pretty(&report) {
        Ok(bytes) => {
            if let Err(error) = write_atomic(&path, &bytes) {
                eprintln!("watchdog: cannot write {}: {error}", path.display());
            }
        }
        Err(error) => eprintln!("watchdog: cannot serialize report: {error}"),
    }
    prune_reports(&reports_dir);
    report
}

fn report_files(reports_dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = fs::read_dir(reports_dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
                .collect()
        })
        .unwrap_or_default();
    // Names start with the creation time in milliseconds
    files.sort();
    files
}

fn prune_reports(reports_dir: &Path) {
    let files = report_files(reports_dir);
    if files.len() > MAX_REPORT_FILES {
        for path in &files[..files.len() - MAX_REPORT_FILES] {
            let _ = fs::remove_file(path);
        }
    }
}

fn load_pending_reports(dir: &Path) -> Vec<Report> {
    let oldest = now_ms().saturating_sub(REPORT_NOTIFY_WINDOW_MS);
    report_files(&dir.join("reports"))
        .iter()
        .filter_map(|path| read_json::<Report>(path))
        .filter(|report| report.notify && !report.notified && report.created_at >= oldest)
        .collect()
}

fn mark_notified(report: &Report) {
    let Some(path) = report.file.as_deref().map(Path::new) else {
        return;
    };
    if let Some(mut saved) = read_json::<Report>(path) {
        saved.notified = true;
        if let Ok(bytes) = serde_json::to_vec_pretty(&saved) {
            let _ = write_atomic(path, &bytes);
        }
    }
}

fn read_alloc_failures(path: &Path) -> Vec<Value> {
    let Ok(bytes) = fs::read(path) else {
        return Vec::new();
    };
    String::from_utf8_lossy(&bytes)
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect()
}

// ---------------------------------------------------------------------------------------------
// Memory sampling
// ---------------------------------------------------------------------------------------------

struct MemorySampler {
    system: sysinfo::System,
    pid: sysinfo::Pid,
}

impl MemorySampler {
    fn new() -> Self {
        Self {
            system: sysinfo::System::new(),
            pid: sysinfo::Pid::from_u32(std::process::id()),
        }
    }

    fn sample(&mut self) -> MemSample {
        use sysinfo::{ProcessRefreshKind, ProcessesToUpdate};

        self.system.refresh_memory();
        // Parent links of every process, to find the webview processes we started. Those are
        // descendants on Windows (msedgewebview2) and Linux (WebKitWebProcess); macOS runs
        // them as XPC services, which do not show up here. Threads are left out: on Linux
        // sysinfo would otherwise list each one as a child process with the RSS of the whole
        // process, counting the same memory many times over.
        self.system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().without_tasks(),
        );
        let descendants = self.descendants();
        let mut family = descendants.clone();
        family.push(self.pid);
        self.system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&family),
            false,
            ProcessRefreshKind::nothing().with_memory().without_tasks(),
        );

        let mut sample = MemSample {
            at: now_ms(),
            native_rss: self.system.process(self.pid).map_or(0, |p| p.memory()),
            system_total: self.system.total_memory(),
            system_available: self.system.available_memory(),
            ..Default::default()
        };
        for pid in &descendants {
            if let Some(process) = self.system.process(*pid) {
                let memory = process.memory();
                sample.webview_rss += memory;
                sample.largest_webview_rss = sample.largest_webview_rss.max(memory);
                sample.webview_processes += 1;
            }
        }
        sample
    }

    fn descendants(&self) -> Vec<sysinfo::Pid> {
        let mut children: HashMap<sysinfo::Pid, Vec<sysinfo::Pid>> = HashMap::new();
        for (pid, process) in self.system.processes() {
            if process.thread_kind().is_some() {
                continue;
            }
            if let Some(parent) = process.parent() {
                if parent != *pid {
                    children.entry(parent).or_default().push(*pid);
                }
            }
        }
        let mut found = Vec::new();
        let mut queue = vec![self.pid];
        while let Some(pid) = queue.pop() {
            if let Some(kids) = children.get(&pid) {
                for kid in kids {
                    if *kid != self.pid && !found.contains(kid) && found.len() < 256 {
                        found.push(*kid);
                        queue.push(*kid);
                    }
                }
            }
        }
        found
    }
}

fn sample_changed(previous: &MemSample, current: &MemSample) -> bool {
    previous.native_rss.abs_diff(current.native_rss) > 32 * MIB
        || previous.webview_rss.abs_diff(current.webview_rss) > 64 * MIB
        || previous.system_available.abs_diff(current.system_available) > 256 * MIB
        || previous.webview_processes != current.webview_processes
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn try_lock<T>(mutex: &Mutex<T>) -> Option<MutexGuard<'_, T>> {
    match mutex.try_lock() {
        Ok(guard) => Some(guard),
        Err(TryLockError::Poisoned(poisoned)) => Some(poisoned.into_inner()),
        Err(TryLockError::WouldBlock) => None,
    }
}

fn truncate(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        text.to_string()
    } else {
        let mut cut: String = text.chars().take(max_chars).collect();
        cut.push('…');
        cut
    }
}

/// Keeps a misbehaving frontend from bloating the black box
fn limit_snapshot(mut snapshot: Value) -> Value {
    let too_big = serde_json::to_vec(&snapshot)
        .map(|bytes| bytes.len() > MAX_FRONTEND_SNAPSHOT_BYTES)
        .unwrap_or(true);
    if too_big {
        if let Some(object) = snapshot.as_object_mut() {
            object.remove("breadcrumbs");
            if let Some(tasks) = object.get_mut("tasks").and_then(Value::as_array_mut) {
                tasks.truncate(10);
            }
            object.insert("truncated".into(), Value::Bool(true));
        }
    }
    snapshot
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(at: u64, native: u64, webview: u64, available: u64) -> MemSample {
        MemSample {
            at,
            native_rss: native,
            webview_rss: webview,
            webview_processes: 1,
            largest_webview_rss: webview,
            system_total: 16 * 1024 * MIB,
            system_available: available,
        }
    }

    fn session_with(frontend: Value, samples: Vec<MemSample>) -> Session {
        Session {
            frontend: Some(frontend),
            samples: samples.into(),
            ..Default::default()
        }
    }

    #[test]
    fn stack_buf_writes_json_without_allocating() {
        let mut out = StackBuf::<64>::new();
        let _ = out.write_str("[");
        out.write_json_str("a\"b\\c\nd", 64);
        let _ = out.write_str("]");
        let parsed: Value = serde_json::from_slice(out.as_bytes()).unwrap();
        assert_eq!(parsed, json!(["a\"b\\c d"]));

        // Long text is cut short but stays valid JSON
        let mut out = StackBuf::<32>::new();
        out.write_json_str(&"한".repeat(40), 32);
        let parsed: Value = serde_json::from_slice(out.as_bytes()).unwrap();
        assert!(parsed.as_str().unwrap().starts_with('한'));
    }

    #[test]
    fn redact_url_drops_secrets() {
        assert_eq!(
            redact_url("https://user:pass@api.example.com/v1/chat?key=secret#frag"),
            "https://api.example.com/v1/chat"
        );
        assert_eq!(redact_url("not a url?key=secret"), "not a url");
    }

    #[test]
    fn memory_evidence_finds_heap_and_system_pressure() {
        let session = session_with(
            json!({ "heap": { "used": 3_900_000_000u64, "limit": 4_000_000_000u64 } }),
            vec![
                sample(0, 500 * MIB, 1024 * MIB, 8 * 1024 * MIB),
                sample(30_000, 600 * MIB, 13 * 1024 * MIB, 512 * MIB),
            ],
        );
        let evidence = memory_evidence(&session);
        for code in [
            "jsHeapNearLimit",
            "systemMemoryLow",
            "appMemoryHigh",
            "memoryRisingFast",
        ] {
            assert!(evidence.iter().any(|e| e == code), "missing {code}");
        }

        let calm = session_with(
            json!({ "heap": { "used": 100, "limit": 4000 } }),
            vec![sample(0, 300 * MIB, 700 * MIB, 8 * 1024 * MIB)],
        );
        assert!(memory_evidence(&calm).is_empty());
    }

    #[test]
    fn location_prefers_running_tasks_then_stage_then_activity() {
        let with_tasks = session_with(
            json!({
                "tasks": [
                    { "label": "Send chat", "startedAt": 1 },
                    { "label": "Request", "detail": "model", "startedAt": 2 }
                ],
                "breadcrumbs": [{ "at": 1, "message": "App loaded" }]
            }),
            vec![],
        );
        assert_eq!(describe_location(&with_tasks), "Request (model); Send chat");

        let loading = session_with(
            json!({ "loaded": false, "stage": "Decoding Save File...", "tasks": [] }),
            vec![],
        );
        assert_eq!(
            describe_location(&loading),
            "while loading: Decoding Save File..."
        );

        let idle = session_with(
            json!({ "loaded": true, "tasks": [], "breadcrumbs": [{ "message": "Opened character #2" }] }),
            vec![],
        );
        assert_eq!(
            describe_location(&idle),
            "last activity: Opened character #2"
        );
        assert_eq!(describe_location(&Session::default()), "unknown");
    }

    #[test]
    fn previous_run_reports_stay_quiet_without_memory_signs() {
        let calm = session_with(
            json!({ "visible": true }),
            vec![sample(0, 300 * MIB, 700 * MIB, 8 * 1024 * MIB)],
        );
        let report = build_report(calm.clone(), Trigger::PreviousRunEnded, Vec::new());
        assert_eq!(report.verdict, "unexpectedTermination");
        assert!(!report.notify);

        let failures = vec![json!({ "at": 1, "size": 1024, "operations": [] })];
        let report = build_report(calm.clone(), Trigger::PreviousRunEnded, failures);
        assert_eq!(report.verdict, "nativeOutOfMemory");
        assert!(report.notify && report.likely_out_of_memory);

        let mut hidden_stall = session_with(
            json!({ "visible": false }),
            vec![sample(0, 300 * MIB, 700 * MIB, 8 * 1024 * MIB)],
        );
        hidden_stall.frontend_stalled_since = Some(1);
        let report = build_report(hidden_stall.clone(), Trigger::PreviousRunEnded, Vec::new());
        assert_eq!(report.verdict, "unresponsiveThenTerminated");
        assert!(!report.notify);
        let report = build_report(hidden_stall, Trigger::ExitWhileUnresponsive, Vec::new());
        assert!(!report.notify);
    }

    #[test]
    fn renderer_reports_name_the_failure() {
        let failure = RendererFailure {
            engine: "WebView2",
            kind: Some("RENDER_PROCESS_EXITED".into()),
            reason: Some("OUT_OF_MEMORY".into()),
            out_of_memory: true,
            exit_code: Some(-1),
            description: None,
            frame_only: false,
            reloadable: true,
        };
        let report = build_report(Session::default(), Trigger::Renderer(&failure), Vec::new());
        assert_eq!(report.verdict, "rendererOutOfMemory");
        assert!(report.notify && report.likely_out_of_memory);
        assert_eq!(report.trigger["reason"], "OUT_OF_MEMORY");

        let frame = RendererFailure {
            frame_only: true,
            out_of_memory: false,
            reason: Some("CRASHED".into()),
            ..failure
        };
        let report = build_report(Session::default(), Trigger::Renderer(&frame), Vec::new());
        assert_eq!(report.verdict, "frameCrashed");
    }

    #[test]
    fn oversized_snapshots_are_trimmed() {
        let crumbs: Vec<Value> = (0..2000)
            .map(|i| json!({ "message": format!("{i:0>64}") }))
            .collect();
        let limited = limit_snapshot(json!({ "breadcrumbs": crumbs, "tasks": [] }));
        assert!(limited.get("breadcrumbs").is_none());
        assert_eq!(limited["truncated"], true);
    }
}

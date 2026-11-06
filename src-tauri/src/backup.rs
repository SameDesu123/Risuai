//! Tauri commands for writing local backups natively.
//!
//! The webview used to read every asset over IPC and append it to the backup with four
//! separate `writeFile` calls, each reopening the file. These commands keep one buffered
//! file handle open in Rust and stream assets from disk straight into it.
//!
//! The save path is chosen with a dialog opened here, never passed in from the webview,
//! so the commands cannot be used to write arbitrary files.

use crate::backup_format::{write_assets, write_entry};
use base64::{engine::general_purpose, Engine as _};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

const WRITE_BUFFER_SIZE: usize = 1 << 20;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

struct Session {
    path: PathBuf,
    writer: BufWriter<File>,
}

static SESSIONS: LazyLock<Mutex<HashMap<u64, Session>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn err(e: impl ToString) -> String {
    e.to_string()
}

fn take_session(id: u64) -> Result<Session, String> {
    SESSIONS
        .lock()
        .unwrap()
        .remove(&id)
        .ok_or_else(|| format!("backup session {id} is not open"))
}

fn put_session(id: u64, session: Session) {
    SESSIONS.lock().unwrap().insert(id, session);
}

/// Asks where to save the backup and opens the file. Returns `None` if the dialog was cancelled.
#[tauri::command]
pub async fn backup_open(app: AppHandle) -> Result<Option<u64>, String> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("Binary", &["bin"])
            .blocking_save_file()
    })
    .await
    .map_err(err)?;

    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(err)?;
    let file = File::create(&path).map_err(err)?;
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    put_session(
        id,
        Session {
            path,
            writer: BufWriter::with_capacity(WRITE_BUFFER_SIZE, file),
        },
    );
    Ok(Some(id))
}

/// Streams `.png` files from `$APPDATA/assets` into the backup.
///
/// `only` limits the backup to those file names (without the `assets/` prefix).
/// Emits `backup_progress` events with `{ id, done, total }`.
/// Resolves to `{ written, missing }`.
#[tauri::command]
pub async fn backup_write_assets(
    app: AppHandle,
    id: u64,
    only: Option<Vec<String>>,
) -> Result<Value, String> {
    let assets_dir = app.path().app_data_dir().map_err(err)?.join("assets");
    let mut session = take_session(id)?;

    let (session, result) = tauri::async_runtime::spawn_blocking(move || {
        let mut last_emit: Option<Instant> = None;
        let result = write_assets(
            &mut session.writer,
            &assets_dir,
            only.as_deref(),
            |done, total| {
                if done == total || last_emit.is_none_or(|t| t.elapsed() >= PROGRESS_INTERVAL) {
                    last_emit = Some(Instant::now());
                    let _ = app.emit(
                        "backup_progress",
                        json!({ "id": id, "done": done, "total": total }),
                    );
                }
            },
        );
        (session, result)
    })
    .await
    .map_err(err)?;

    put_session(id, session);
    let report = result.map_err(err)?;
    Ok(json!({ "written": report.written, "missing": report.missing }))
}

fn header<'a>(request: &'a Request<'_>, name: &str) -> Result<&'a str, String> {
    request
        .headers()
        .get(name)
        .ok_or_else(|| format!("missing {name} header"))?
        .to_str()
        .map_err(err)
}

/// Appends one entry. The data is sent as the raw invoke body, so no base64 or JSON encoding
/// is needed. Headers: `x-risu-backup-id` and `x-risu-backup-name` (base64 of the UTF-8 name).
#[tauri::command]
pub async fn backup_write_entry(request: Request<'_>) -> Result<(), String> {
    let id: u64 = header(&request, "x-risu-backup-id")?.parse().map_err(err)?;
    let name = general_purpose::STANDARD
        .decode(header(&request, "x-risu-backup-name")?)
        .map_err(err)?;
    let name = String::from_utf8(name).map_err(err)?;
    let InvokeBody::Raw(data) = request.body() else {
        return Err("backup entry data must be sent as raw bytes".into());
    };

    let mut sessions = SESSIONS.lock().unwrap();
    let session = sessions
        .get_mut(&id)
        .ok_or_else(|| format!("backup session {id} is not open"))?;
    write_entry(&mut session.writer, &name, data).map_err(err)
}

/// Finishes the backup. With `discard`, the partly written file is deleted instead.
#[tauri::command]
pub async fn backup_close(id: u64, discard: bool) -> Result<(), String> {
    let Session { path, mut writer } = take_session(id)?;
    if discard {
        drop(writer);
        return fs::remove_file(&path).map_err(err);
    }
    writer.flush().map_err(err)?;
    let file = writer.into_inner().map_err(err)?;
    file.sync_all().map_err(err)
}

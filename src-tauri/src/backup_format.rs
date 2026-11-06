//! Writer for Risuai's local backup format (`.bin`).
//!
//! A backup is a flat sequence of entries, each laid out as
//! `[u32 LE name length][UTF-8 name][u32 LE data length][data]`.
//! This is the same layout `LocalWriter.writeBackup` produces and
//! `LoadLocalBackup` reads in `src/ts/drive/backuplocal.ts`.
//!
//! Nothing in this module depends on Tauri, so it can be tested on its own.

use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::Path;

/// Returns the part of `name` after the last `/` or `\`, like `getBasename` in backuplocal.ts.
pub fn entry_name(name: &str) -> &str {
    name.rsplit(['/', '\\']).next().unwrap_or(name)
}

fn length_u32(len: u64, what: &str) -> io::Result<u32> {
    u32::try_from(len).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{what} is larger than 4 GiB and cannot be stored in a backup"),
        )
    })
}

fn write_header<W: Write>(w: &mut W, name: &str, data_len: u64) -> io::Result<()> {
    let name = entry_name(name).as_bytes();
    w.write_all(&length_u32(name.len() as u64, "entry name")?.to_le_bytes())?;
    w.write_all(name)?;
    w.write_all(&length_u32(data_len, "entry data")?.to_le_bytes())?;
    Ok(())
}

/// Writes one in-memory entry.
pub fn write_entry<W: Write>(w: &mut W, name: &str, data: &[u8]) -> io::Result<()> {
    write_header(w, name, data.len() as u64)?;
    w.write_all(data)
}

#[derive(Debug, Default, PartialEq)]
pub struct AssetReport {
    pub written: usize,
    /// Asset file names (without the `assets/` prefix) that could not be read.
    pub missing: Vec<String>,
}

/// An asset name is a plain `.png` file name inside the assets folder.
fn is_valid_asset_name(name: &str) -> bool {
    name.ends_with(".png")
        && name != ".png"
        && !name.contains(['/', '\\'])
        && name != "."
        && name != ".."
}

fn list_png_assets(assets_dir: &Path) -> io::Result<Vec<String>> {
    let mut names = Vec::new();
    let entries = match fs::read_dir(assets_dir) {
        Ok(entries) => entries,
        // No assets saved yet
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(names),
        Err(e) => return Err(e),
    };
    for entry in entries {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        if let Some(name) = entry.file_name().to_str() {
            if is_valid_asset_name(name) {
                names.push(name.to_string());
            }
        }
    }
    names.sort();
    Ok(names)
}

/// Streams `.png` assets from `assets_dir` into `w` without loading them fully into memory.
///
/// With `only = None`, every `.png` file in the folder is written. With `only = Some(names)`,
/// just those file names are written, and any that are invalid or cannot be opened are
/// reported in `missing`. `progress(done, total)` is called after each asset.
///
/// A file that cannot be opened is skipped. A file that fails or changes size after its
/// header was written is an error, since the backup would otherwise be corrupt.
pub fn write_assets<W: Write>(
    w: &mut W,
    assets_dir: &Path,
    only: Option<&[String]>,
    mut progress: impl FnMut(usize, usize),
) -> io::Result<AssetReport> {
    let mut report = AssetReport::default();

    let names: Vec<String> = match only {
        None => list_png_assets(assets_dir)?,
        Some(only) => {
            let mut seen = BTreeSet::new();
            let mut names = Vec::new();
            for name in only {
                if !seen.insert(name.as_str()) {
                    continue;
                }
                if is_valid_asset_name(name) {
                    names.push(name.clone());
                } else {
                    report.missing.push(name.clone());
                }
            }
            names
        }
    };

    let total = names.len();
    for (i, name) in names.into_iter().enumerate() {
        let opened = File::open(assets_dir.join(&name))
            .and_then(|file| file.metadata().map(|meta| (file, meta)));
        match opened {
            Ok((file, meta)) if meta.is_file() => {
                let len = meta.len();
                write_header(w, &name, len)?;
                let copied = io::copy(&mut file.take(len), w)?;
                if copied != len {
                    return Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        format!("asset {name} shrank while it was being backed up"),
                    ));
                }
                report.written += 1;
            }
            _ => report.missing.push(name),
        }
        progress(i + 1, total);
    }

    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Parses a backup the same way `LoadLocalBackup` does.
    fn parse(mut buf: &[u8]) -> Vec<(String, Vec<u8>)> {
        let mut out = Vec::new();
        while !buf.is_empty() {
            let name_len = u32::from_le_bytes(buf[0..4].try_into().unwrap()) as usize;
            let name = String::from_utf8(buf[4..4 + name_len].to_vec()).unwrap();
            let rest = &buf[4 + name_len..];
            let data_len = u32::from_le_bytes(rest[0..4].try_into().unwrap()) as usize;
            out.push((name, rest[4..4 + data_len].to_vec()));
            buf = &rest[4 + data_len..];
        }
        out
    }

    fn temp_assets(files: &[(&str, &[u8])]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "risu-backup-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        for (name, data) in files {
            fs::write(dir.join(name), data).unwrap();
        }
        dir
    }

    #[test]
    fn entry_name_matches_get_basename() {
        assert_eq!(entry_name("assets/a.png"), "a.png");
        assert_eq!(entry_name("C:\\x\\y\\b.png"), "b.png");
        assert_eq!(entry_name("database.risudat"), "database.risudat");
    }

    #[test]
    fn entry_layout_matches_js_writer() {
        let mut buf = Vec::new();
        write_entry(&mut buf, "assets/한글.png", &[1, 2, 3]).unwrap();
        let name = "한글.png".as_bytes();
        let mut expected = (name.len() as u32).to_le_bytes().to_vec();
        expected.extend_from_slice(name);
        expected.extend_from_slice(&3u32.to_le_bytes());
        expected.extend_from_slice(&[1, 2, 3]);
        assert_eq!(buf, expected);
    }

    #[test]
    fn writes_all_png_assets_sorted() {
        let dir = temp_assets(&[("b.png", b"bb"), ("a.png", b"a"), ("note.txt", b"x")]);
        fs::create_dir(dir.join("sub.png")).unwrap();
        let mut buf = Vec::new();
        let mut calls = Vec::new();
        let report = write_assets(&mut buf, &dir, None, |d, t| calls.push((d, t))).unwrap();
        assert_eq!(
            report,
            AssetReport {
                written: 2,
                missing: vec![]
            }
        );
        assert_eq!(calls, vec![(1, 2), (2, 2)]);
        assert_eq!(
            parse(&buf),
            vec![
                ("a.png".into(), b"a".to_vec()),
                ("b.png".into(), b"bb".to_vec())
            ]
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn selected_assets_report_missing_and_reject_traversal() {
        let dir = temp_assets(&[("a.png", b"a"), ("b.png", b"b")]);
        let only: Vec<String> = ["a.png", "a.png", "gone.png", "../a.png", "x/a.png", "a.txt"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let mut buf = Vec::new();
        let report = write_assets(&mut buf, &dir, Some(&only), |_, _| {}).unwrap();
        assert_eq!(report.written, 1);
        assert_eq!(
            report.missing,
            vec!["../a.png", "x/a.png", "a.txt", "gone.png"]
        );
        assert_eq!(parse(&buf), vec![("a.png".into(), b"a".to_vec())]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn missing_assets_folder_writes_nothing() {
        let dir = std::env::temp_dir().join("risu-backup-test-does-not-exist");
        let mut buf = Vec::new();
        let report = write_assets(&mut buf, &dir, None, |_, _| {}).unwrap();
        assert_eq!(report, AssetReport::default());
        assert!(buf.is_empty());
    }
}

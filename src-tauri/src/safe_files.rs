//! Portable local-file safety. No desktop or network dependencies, so these failure
//! paths can be tested without an OAuth session or a Tauri window.
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static NEXT_ID: AtomicU64 = AtomicU64::new(0);
pub const TEMP_PREFIX: &str = ".save-sync-";

fn unique_name() -> String {
    format!(
        "{}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    )
}

fn is_link(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Includes junctions/reparse points, which is_symlink alone does not cover.
        meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}

fn reject_links(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(meta) if is_link(&meta) => {
                return Err(format!("Refusing linked save path: {}", ancestor.display()))
            }
            Ok(_) => (),
            Err(e) if e.kind() == io::ErrorKind::NotFound => (),
            Err(e) => return Err(format!("Cannot validate {}: {e}", ancestor.display())),
        }
    }
    Ok(())
}

/// Interpret Drive metadata as a relative portable path on Windows AND Unix.
/// Reject Windows drive prefixes, ADS, device names, traversal and link escapes
/// even when the current machine happens to be running Linux.
pub fn safe_join(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let mut result = root.to_path_buf();
    if relative.is_empty() || relative.contains('\\') {
        return Err(format!("Invalid cloud save path: {relative:?}"));
    }
    for part in relative.split('/') {
        let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || (stem.len() == 4
                && (stem.starts_with("COM") || stem.starts_with("LPT"))
                && matches!(stem.as_bytes()[3], b'1'..=b'9'));
        if part.is_empty()
            || part == "."
            || part == ".."
            || reserved
            || part.ends_with(['.', ' '])
            || part
                .chars()
                .any(|c| c.is_control() || ":<>\"|?*".contains(c))
        {
            return Err(format!("Invalid cloud save path: {relative:?}"));
        }
        result.push(part);
    }
    reject_links(&result)?;
    Ok(result)
}

struct StagedFile(PathBuf);
impl Drop for StagedFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

/// A durable, unique recovery copy plus its original path. Kept outside the save
/// tree so backups can never become game files or be uploaded as saves.
fn preserve_original(target: &Path, recovery_root: &Path) -> Result<(), String> {
    if !target.exists() {
        return Ok(());
    }
    let folder = recovery_root.join(unique_name());
    fs::create_dir_all(&folder).map_err(|e| format!("Cannot create recovery backup: {e}"))?;
    let mut source = File::open(target).map_err(|e| format!("Cannot read original save: {e}"))?;
    let mut backup = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(folder.join("save.bak"))
        .map_err(|e| format!("Cannot create recovery copy: {e}"))?;
    io::copy(&mut source, &mut backup).map_err(|e| format!("Cannot back up original save: {e}"))?;
    backup
        .sync_all()
        .map_err(|e| format!("Cannot flush recovery copy: {e}"))?;
    atomic_write(
        &folder.join("original-path.txt"),
        target.to_string_lossy().as_bytes(),
    )?;
    Ok(())
}

pub fn atomic_write(target: &Path, bytes: &[u8]) -> Result<(), String> {
    replace_from_reader(target, &mut &bytes[..], Some(bytes.len() as u64), None)
}

/// Complete and flush a sibling temporary file BEFORE touching the destination.
/// Renaming replaces the old file on Windows and Unix. If replacement is denied
/// (e.g. a game holds the file open), the old file is retained: never delete it.
pub fn replace_from_reader(
    target: &Path,
    reader: &mut impl Read,
    expected_size: Option<u64>,
    recovery_root: Option<&Path>,
) -> Result<(), String> {
    reject_links(target)?;
    let parent = target.parent().ok_or("Destination has no parent")?;
    fs::create_dir_all(parent).map_err(|e| format!("Cannot create save directory: {e}"))?;
    let temp = StagedFile(parent.join(format!("{TEMP_PREFIX}{}.tmp", unique_name())));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp.0)
        .map_err(|e| format!("Cannot stage save: {e}"))?;
    let copied =
        io::copy(reader, &mut file).map_err(|e| format!("Save download interrupted: {e}"))?;
    if let Some(expected) = expected_size {
        if expected != copied {
            return Err(format!(
                "Incomplete save: expected {expected} bytes, received {copied}"
            ));
        }
    }
    file.flush()
        .and_then(|_| file.sync_all())
        .map_err(|e| format!("Cannot flush staged save: {e}"))?;
    drop(file);
    reject_links(target)?;
    if let Some(root) = recovery_root {
        preserve_original(target, root)?;
    }
    fs::rename(&temp.0, target)
        .map_err(|e| format!("Cannot replace save safely; original retained: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDir(PathBuf);
    impl TestDir {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("save-sync-test-{}", unique_name()));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    struct InterruptedReader(bool);
    impl Read for InterruptedReader {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            if self.0 {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "network lost",
                ));
            }
            self.0 = true;
            buf[..3].copy_from_slice(b"new");
            Ok(3)
        }
    }

    #[test]
    fn interrupted_download_keeps_original_and_cleans_temp() {
        let dir = TestDir::new();
        let target = dir.0.join("slot.sav");
        fs::write(&target, b"original").unwrap();
        assert!(replace_from_reader(&target, &mut InterruptedReader(false), None, None).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"original");
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
    }

    #[test]
    fn short_download_and_failed_backup_never_replace_original() {
        let dir = TestDir::new();
        let target = dir.0.join("slot.sav");
        fs::write(&target, b"original").unwrap();
        assert!(replace_from_reader(&target, &mut &b"new"[..], Some(10), None).is_err());
        let blocked = dir.0.join("blocked");
        fs::write(&blocked, b"not a directory").unwrap();
        assert!(replace_from_reader(&target, &mut &b"new"[..], Some(3), Some(&blocked)).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"original");
    }

    #[test]
    fn successful_replace_keeps_recoverable_original_outside_save_tree() {
        let dir = TestDir::new();
        let target = dir.0.join("saves/slot.sav");
        atomic_write(&target, b"old").unwrap();
        let recovery = dir.0.join("recovery");
        replace_from_reader(&target, &mut &b"new"[..], Some(3), Some(&recovery)).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new");
        let backup = fs::read_dir(&recovery)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(fs::read(backup.join("save.bak")).unwrap(), b"old");
        assert_eq!(
            fs::read_to_string(backup.join("original-path.txt")).unwrap(),
            target.to_string_lossy()
        );
        assert_eq!(fs::read_dir(target.parent().unwrap()).unwrap().count(), 1);
    }

    #[test]
    fn rejects_untrusted_paths_on_every_os() {
        let dir = TestDir::new();
        for path in [
            "",
            "../outside",
            "/absolute",
            "a/../../x",
            "C:/save",
            "C:save",
            "a\\..\\x",
            "//host/share",
            "slot:stream",
            "a//b",
            "CON.txt",
            "LPT1",
            "a./save",
        ] {
            assert!(safe_join(&dir.0, path).is_err(), "accepted {path:?}");
        }
        assert_eq!(
            safe_join(&dir.0, "profile/slot.sav").unwrap(),
            dir.0.join("profile/slot.sav")
        );
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlink_escape_without_touching_external_save() {
        let dir = TestDir::new();
        let outside = TestDir::new();
        fs::write(outside.0.join("slot.sav"), b"external").unwrap();
        std::os::unix::fs::symlink(&outside.0, dir.0.join("link")).unwrap();
        assert!(safe_join(&dir.0, "link/slot.sav").is_err());
        assert!(atomic_write(&dir.0.join("link/slot.sav"), b"bad").is_err());
        assert_eq!(fs::read(outside.0.join("slot.sav")).unwrap(), b"external");
    }

    #[test]
    fn failed_rename_does_not_delete_destination() {
        let dir = TestDir::new();
        let target = dir.0.join("occupied");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("keep"), b"old").unwrap();
        assert!(atomic_write(&target, b"new").is_err());
        assert_eq!(fs::read(target.join("keep")).unwrap(), b"old");
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
    }
}

//! Recoverable multi-file replacement, including the local sync baseline.
//! Completed journals retain the before/after bytes outside the game's folders.
use crate::{safe_files, sync_v2};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    io,
    path::{Path, PathBuf},
};

pub struct Change {
    pub root: PathBuf,
    pub relative: String,
    pub expected: Option<String>,
    /// None means delete; the original is retained in the journal.
    pub source: Option<PathBuf>,
}

#[derive(Serialize, Deserialize)]
struct Record {
    root: PathBuf,
    relative: String,
    before: Option<String>,
    after: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct Journal {
    committed: bool,
    records: Vec<Record>,
}

fn digest(path: &Path) -> Result<Option<String>, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => sync_v2::hash_file(path).map(|(h, _)| Some(h)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Cannot inspect transaction target: {e}")),
    }
}
fn persist(dir: &Path, journal: &Journal) -> Result<(), String> {
    safe_files::atomic_write(
        &dir.join("journal.json"),
        &serde_json::to_vec(journal).map_err(|e| e.to_string())?,
    )
}
fn copy_durable(from: &Path, to: &Path) -> Result<(), String> {
    let mut input = File::open(from).map_err(|e| format!("Cannot stage save: {e}"))?;
    safe_files::replace_from_reader(
        to,
        &mut input,
        Some(fs::metadata(from).map_err(|e| e.to_string())?.len()),
        None,
    )
}
fn archive(dir: &Path) -> Result<(), String> {
    let target = dir.with_file_name(format!(
        "recovery-{}-{:016x}",
        std::process::id(),
        fastrand::u64(..)
    ));
    fs::rename(dir, &target).map_err(|e| format!("Cannot retain completed recovery journal: {e}"))
}

/// Recover before scanning saves. If another program edited an interrupted
/// transaction's files, stop and keep every recovery copy for manual review.
pub fn recover(dir: &Path) -> Result<(), String> {
    let path = dir.join("journal.json");
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            if dir.exists() {
                fs::remove_dir_all(dir).map_err(|e| e.to_string())?;
            }
            return Ok(());
        }
        Err(e) => return Err(format!("Cannot read pending save transaction: {e}")),
    };
    let journal: Journal = serde_json::from_slice(&bytes)
        .map_err(|e| format!("Damaged recovery journal; no saves changed: {e}"))?;
    if journal.committed {
        return archive(dir);
    }
    // Validate every target and backup before changing any target.
    for (i, record) in journal.records.iter().enumerate() {
        let target = safe_files::safe_join(&record.root, &record.relative)?;
        let current = digest(&target)?;
        if current != record.before && current != record.after {
            return Err(format!(
                "Recovery stopped: {} was edited after interrupted sync. Recovery copies: {}",
                target.display(),
                dir.display()
            ));
        }
        if record.before.is_some() && digest(&dir.join(format!("before-{i}")))? != record.before {
            return Err(format!(
                "Recovery copy failed verification: {}",
                dir.display()
            ));
        }
    }
    for (i, record) in journal.records.iter().enumerate().rev() {
        let target = safe_files::safe_join(&record.root, &record.relative)?;
        if digest(&target)? == record.before {
            continue;
        }
        if record.before.is_some() {
            copy_durable(&dir.join(format!("before-{i}")), &target)?;
        } else {
            fs::remove_file(&target).map_err(|e| format!("Cannot roll back new save: {e}"))?;
        }
    }
    archive(dir)
}

/// Stage and flush ALL new bytes and original copies before touching live saves.
pub fn prepare(dir: &Path, changes: &[Change]) -> Result<(), String> {
    if dir.exists() {
        return Err("Pending save transaction must be recovered before preparing another".into());
    }
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut journal = Journal {
        committed: false,
        records: Vec::new(),
    };
    let mut targets = std::collections::BTreeSet::new();
    for (i, change) in changes.iter().enumerate() {
        let target = safe_files::safe_join(&change.root, &change.relative)?;
        if !targets.insert(target.to_string_lossy().to_lowercase()) {
            return Err("Overlapping save paths produce duplicate transaction targets".into());
        }
        if digest(&target)? != change.expected {
            return Err(format!(
                "Save changed while syncing: {}. Retry after closing the game.",
                target.display()
            ));
        }
        if change.expected.is_some() {
            copy_durable(&target, &dir.join(format!("before-{i}")))?;
            if digest(&dir.join(format!("before-{i}")))? != change.expected {
                return Err("Original save changed while preparing recovery copy".into());
            }
        }
        let after = if let Some(source) = &change.source {
            copy_durable(source, &dir.join(format!("after-{i}")))?;
            digest(&dir.join(format!("after-{i}")))?
        } else {
            None
        };
        journal.records.push(Record {
            root: change.root.clone(),
            relative: change.relative.clone(),
            before: change.expected.clone(),
            after,
        });
    }
    persist(dir, &journal)
}

pub fn apply(dir: &Path) -> Result<(), String> {
    let mut journal: Journal =
        serde_json::from_slice(&fs::read(dir.join("journal.json")).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let result = (|| {
        // A game may have been started externally during the network transfer.
        for record in &journal.records {
            let target = safe_files::safe_join(&record.root, &record.relative)?;
            if digest(&target)? != record.before {
                return Err(format!("Save changed before commit: {}", target.display()));
            }
        }
        for (i, record) in journal.records.iter().enumerate() {
            let target = safe_files::safe_join(&record.root, &record.relative)?;
            if digest(&target)? != record.before {
                return Err(format!("Save changed during commit: {}", target.display()));
            }
            if record.after.is_some() {
                if digest(&dir.join(format!("after-{i}")))? != record.after {
                    return Err("Staged save failed verification".into());
                }
                copy_durable(&dir.join(format!("after-{i}")), &target)?;
            } else if record.before.is_some() {
                fs::remove_file(&target)
                    .map_err(|e| format!("Cannot apply versioned deletion: {e}"))?;
            }
        }
        Ok::<_, String>(())
    })();
    if let Err(error) = result {
        return match recover(dir) {
            Ok(()) => Err(format!(
                "{error}. Local transaction rolled back; previous saves retained."
            )),
            Err(recovery) => Err(format!("{error}. {recovery}")),
        };
    }
    journal.committed = true;
    // If this write fails, leave the prepared journal: next sync restores BOTH
    // saves and baseline. Never acknowledge an unrecorded local commit.
    persist(dir, &journal)?;
    archive(dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("save-txn-{:016x}", fastrand::u64(..)));
            fs::create_dir_all(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn change(root: &Path, name: &str, source: Option<&Path>) -> Change {
        Change {
            root: root.into(),
            relative: name.into(),
            expected: digest(&root.join(name)).unwrap(),
            source: source.map(PathBuf::from),
        }
    }
    #[test]
    fn multiple_paths_and_baseline_commit_together() {
        let t = Temp::new();
        let root = &t.0;
        fs::write(root.join("card"), b"old-card").unwrap();
        fs::write(root.join("state"), b"old-state").unwrap();
        fs::write(root.join("new"), b"new-bytes").unwrap();
        let pending = root.join("pending");
        prepare(
            &pending,
            &[
                change(root, "card", Some(&root.join("new"))),
                change(root, "state", None),
                change(root, "baseline", Some(&root.join("new"))),
            ],
        )
        .unwrap();
        apply(&pending).unwrap();
        assert_eq!(fs::read(root.join("card")).unwrap(), b"new-bytes");
        assert!(!root.join("state").exists());
        assert!(root.join("baseline").exists());
        assert!(!pending.exists());
        assert!(fs::read_dir(root).unwrap().any(|e| e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("recovery-")));
    }
    #[test]
    fn crash_after_first_file_restores_all_originals_and_baseline() {
        let t = Temp::new();
        let root = &t.0;
        fs::write(root.join("old"), b"old").unwrap();
        fs::write(root.join("new"), b"new").unwrap();
        let pending = root.join("pending");
        prepare(
            &pending,
            &[
                change(root, "old", Some(&root.join("new"))),
                change(root, "baseline", Some(&root.join("new"))),
            ],
        )
        .unwrap();
        copy_durable(&pending.join("after-0"), &root.join("old")).unwrap();
        copy_durable(&pending.join("after-1"), &root.join("baseline")).unwrap();
        recover(&pending).unwrap();
        assert_eq!(fs::read(root.join("old")).unwrap(), b"old");
        assert!(!root.join("baseline").exists());
    }
    #[test]
    fn externally_edited_save_stops_recovery_without_overwrite() {
        let t = Temp::new();
        let root = &t.0;
        fs::write(root.join("old"), b"old").unwrap();
        fs::write(root.join("new"), b"new").unwrap();
        let pending = root.join("pending");
        prepare(&pending, &[change(root, "old", Some(&root.join("new")))]).unwrap();
        fs::write(root.join("old"), b"played-after-crash").unwrap();
        assert!(recover(&pending).is_err());
        assert_eq!(fs::read(root.join("old")).unwrap(), b"played-after-crash");
        assert!(pending.join("before-0").exists());
    }
    #[test]
    fn failed_later_file_rolls_back_completed_replacement() {
        let t = Temp::new();
        let root = &t.0;
        fs::write(root.join("a"), b"old").unwrap();
        fs::write(root.join("b"), b"old").unwrap();
        fs::write(root.join("new"), b"new").unwrap();
        let pending = root.join("pending");
        prepare(
            &pending,
            &[
                change(root, "a", Some(&root.join("new"))),
                change(root, "b", Some(&root.join("new"))),
            ],
        )
        .unwrap();
        fs::remove_file(pending.join("after-1")).unwrap();
        assert!(apply(&pending).is_err());
        assert_eq!(fs::read(root.join("a")).unwrap(), b"old");
        assert_eq!(fs::read(root.join("b")).unwrap(), b"old");
    }
    #[test]
    fn original_edit_during_staging_is_refused() {
        let t = Temp::new();
        let root = &t.0;
        fs::write(root.join("a"), b"old").unwrap();
        let c = change(root, "a", None);
        fs::write(root.join("a"), b"edited").unwrap();
        assert!(prepare(&root.join("pending"), &[c]).is_err());
        assert_eq!(fs::read(root.join("a")).unwrap(), b"edited");
    }
}

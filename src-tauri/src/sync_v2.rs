//! Content-based three-way reconciliation. No desktop, clocks or network.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    io::Read,
    path::Path,
};

pub const PROTOCOL: u32 = 2;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Key {
    pub path_index: usize,
    pub relative_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub key: Key,
    pub hash: Option<String>,
    pub object_id: Option<String>,
    pub size: u64,
    pub revision: u64,
    pub deleted: bool,
}

impl Entry {
    pub fn content(&self) -> Option<&str> {
        if self.deleted {
            None
        } else {
            self.hash.as_deref()
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub protocol: u32,
    pub game_id: String,
    pub revision: u64,
    pub commit_id: String,
    pub path_labels: Vec<String>,
    pub files: Vec<Entry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BaselineFile {
    pub key: Key,
    pub local_hash: Option<String>,
    pub cloud_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Baseline {
    pub protocol: u32,
    pub game_id: String,
    /// Includes roots and filters: changing a folder must never look like deletion.
    pub scope: String,
    pub revision: u64,
    pub files: Vec<BaselineFile>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Merge,
    Push,
    Restore,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Keep,
    Upload,
    Download,
    DeleteCloud,
    DeleteLocal,
    Conflict,
}

pub fn hash_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn hash_file(path: &Path) -> Result<(String, u64), String> {
    let mut file =
        File::open(path).map_err(|e| format!("Cannot open save {}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 65536];
    let mut size = 0u64;
    loop {
        let n = file
            .read(&mut buffer)
            .map_err(|e| format!("Cannot hash save: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
        size = size.checked_add(n as u64).ok_or("Save size overflow")?;
    }
    Ok((format!("{:x}", hasher.finalize()), size))
}

pub fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

pub fn validate(manifest: &Manifest, game_id: &str, labels: &[String]) -> Result<(), String> {
    if manifest.protocol != PROTOCOL
        || manifest.game_id != game_id
        || manifest.path_labels != labels
    {
        return Err("Unsupported save protocol or changed save-path order/labels. Restore the original path layout before syncing.".into());
    }
    let mut seen = BTreeSet::new();
    for entry in &manifest.files {
        crate::safe_files::safe_join(Path::new("."), &entry.key.relative_path)?;
        if entry
            .key
            .relative_path
            .split('/')
            .any(|p| p.starts_with(crate::safe_files::TEMP_PREFIX))
            || entry.key.path_index >= labels.len()
            || !seen.insert((entry.key.path_index, entry.key.relative_path.to_lowercase()))
            || entry.revision == 0
            || entry.revision > manifest.revision
        {
            return Err("Invalid or duplicate save manifest entry".into());
        }
        if entry.deleted {
            if entry.hash.is_some() || entry.object_id.is_some() || entry.size != 0 {
                return Err("Invalid versioned deletion record".into());
            }
        } else if !entry.hash.as_deref().is_some_and(valid_hash)
            || !entry.object_id.as_deref().is_some_and(|s| {
                !s.is_empty()
                    && s.bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
            })
        {
            return Err("Invalid save content hash or Drive object ID".into());
        }
    }
    for (index, path) in &seen {
        let mut parent = path.as_str();
        while let Some((prefix, _)) = parent.rsplit_once('/') {
            if seen.contains(&(*index, prefix.to_string())) {
                return Err("Cloud save paths contain a file/directory collision".into());
            }
            parent = prefix;
        }
    }
    Ok(())
}

/// No timestamps are used. A missing baseline never authorizes overwriting a
/// different existing copy, including a stale save on a newly joined device.
pub fn decide(
    local: Option<&str>,
    remote: Option<&Entry>,
    base: Option<&BaselineFile>,
    mode: Mode,
) -> Action {
    let cloud = remote.and_then(Entry::content);
    if local == cloud {
        return Action::Keep;
    }
    if mode == Mode::Push {
        return if local.is_some() {
            Action::Upload
        } else if base.is_some_and(|b| b.local_hash.is_some()) && cloud.is_some() {
            Action::DeleteCloud
        } else {
            Action::Keep
        };
    }
    if mode == Mode::Restore {
        return if cloud.is_some() {
            Action::Download
        } else if remote.is_some_and(|r| r.deleted) && local.is_some() {
            Action::DeleteLocal
        } else {
            Action::Keep
        };
    }
    let Some(base) = base else {
        return match (local, remote) {
            (Some(_), Some(_)) => Action::Conflict,
            (Some(_), None) => Action::Upload,
            (None, Some(e)) if !e.deleted => Action::Download,
            _ => Action::Keep,
        };
    };
    let local_changed = local != base.local_hash.as_deref();
    let cloud_changed = cloud != base.cloud_hash.as_deref();
    match (local_changed, cloud_changed) {
        (true, true) => Action::Conflict,
        (true, false) => {
            if local.is_some() {
                Action::Upload
            } else {
                Action::DeleteCloud
            }
        }
        (false, true) => {
            if cloud.is_some() {
                Action::Download
            } else {
                Action::DeleteLocal
            }
        }
        (false, false) => Action::Keep,
    }
}

pub fn plan(
    local: &BTreeMap<Key, String>,
    cloud: &Manifest,
    baseline: Option<&Baseline>,
    mode: Mode,
) -> Vec<(Key, Action)> {
    let remote: BTreeMap<_, _> = cloud.files.iter().map(|e| (e.key.clone(), e)).collect();
    let previous: BTreeMap<_, _> = baseline
        .into_iter()
        .flat_map(|b| &b.files)
        .map(|e| (e.key.clone(), e))
        .collect();
    let keys: BTreeSet<_> = local
        .keys()
        .chain(remote.keys())
        .chain(previous.keys())
        .cloned()
        .collect();
    keys.into_iter()
        .map(|key| {
            let action = decide(
                local.get(&key).map(String::as_str),
                remote.get(&key).copied(),
                previous.get(&key).copied(),
                mode,
            );
            (key, action)
        })
        .collect()
}

/// Many games write one logical save across several files. Do not silently
/// combine two independently advanced save sets, even for disjoint file edits.
pub fn coherent_plan(mut actions: Vec<(Key, Action)>, mode: Mode) -> Vec<(Key, Action)> {
    if mode == Mode::Merge
        && actions
            .iter()
            .any(|(_, a)| matches!(a, Action::Upload | Action::DeleteCloud))
        && actions
            .iter()
            .any(|(_, a)| matches!(a, Action::Download | Action::DeleteLocal))
    {
        for (_, action) in &mut actions {
            if *action != Action::Keep {
                *action = Action::Conflict;
            }
        }
    }
    actions
}

#[cfg(test)]
mod tests {
    use super::*;
    fn entry(content: Option<&str>) -> Entry {
        Entry {
            key: Key {
                path_index: 0,
                relative_path: "slot.sav".into(),
            },
            hash: content.map(hash_bytes_str),
            object_id: content.map(|_| "object".into()),
            size: content.map_or(0, |s| s.len() as u64),
            revision: 1,
            deleted: content.is_none(),
        }
    }
    fn hash_bytes_str(s: &str) -> String {
        hash_bytes(s.as_bytes())
    }
    fn baseline(l: Option<&str>, c: Option<&str>) -> BaselineFile {
        BaselineFile {
            key: entry(None).key,
            local_hash: l.map(hash_bytes_str),
            cloud_hash: c.map(hash_bytes_str),
        }
    }
    #[test]
    fn equal_content_ignores_clock_and_file_id() {
        let cloud = entry(Some("same"));
        assert_eq!(
            decide(cloud.content(), Some(&cloud), None, Mode::Merge),
            Action::Keep
        );
    }
    #[test]
    fn same_size_edits_on_two_devices_conflict() {
        let base = baseline(Some("old"), Some("old"));
        assert_eq!(
            decide(
                Some(&hash_bytes_str("AAA")),
                Some(&entry(Some("BBB"))),
                Some(&base),
                Mode::Merge
            ),
            Action::Conflict
        );
    }
    #[test]
    fn local_deletion_propagates_only_with_baseline() {
        let cloud = entry(Some("old"));
        assert_eq!(
            decide(
                None,
                Some(&cloud),
                Some(&baseline(Some("old"), Some("old"))),
                Mode::Merge
            ),
            Action::DeleteCloud
        );
        assert_eq!(
            decide(None, Some(&cloud), None, Mode::Merge),
            Action::Download
        );
    }
    #[test]
    fn tombstone_deletes_unchanged_local_but_conflicts_with_edit() {
        let base = baseline(Some("old"), Some("old"));
        assert_eq!(
            decide(
                Some(&hash_bytes_str("old")),
                Some(&entry(None)),
                Some(&base),
                Mode::Merge
            ),
            Action::DeleteLocal
        );
        assert_eq!(
            decide(
                Some(&hash_bytes_str("new")),
                Some(&entry(None)),
                Some(&base),
                Mode::Merge
            ),
            Action::Conflict
        );
        assert_eq!(
            decide(
                Some(&hash_bytes_str("old")),
                Some(&entry(None)),
                None,
                Mode::Merge
            ),
            Action::Conflict
        );
    }
    #[test]
    fn deletion_and_remote_edit_conflict() {
        assert_eq!(
            decide(
                None,
                Some(&entry(Some("new"))),
                Some(&baseline(Some("old"), Some("old"))),
                Mode::Merge
            ),
            Action::Conflict
        );
    }
    #[test]
    fn known_deletion_can_be_recreated() {
        assert_eq!(
            decide(
                Some(&hash_bytes_str("new")),
                Some(&entry(None)),
                Some(&baseline(None, None)),
                Mode::Merge
            ),
            Action::Upload
        );
    }
    #[test]
    fn first_sync_requires_choice_for_different_copies() {
        assert_eq!(
            decide(
                Some(&hash_bytes_str("local")),
                Some(&entry(Some("cloud"))),
                None,
                Mode::Merge
            ),
            Action::Conflict
        );
    }
    #[test]
    fn explicit_restore_and_push_choose_requested_side() {
        let cloud = entry(Some("cloud"));
        let local = hash_bytes_str("local");
        assert_eq!(
            decide(Some(&local), Some(&cloud), None, Mode::Push),
            Action::Upload
        );
        assert_eq!(
            decide(Some(&local), Some(&cloud), None, Mode::Restore),
            Action::Download
        );
        assert_eq!(decide(None, Some(&cloud), None, Mode::Push), Action::Keep);
    }
    #[test]
    fn path_indices_distinguish_identical_leaf_names() {
        let cloud = Manifest {
            protocol: PROTOCOL,
            game_id: "g".into(),
            revision: 1,
            commit_id: "c".into(),
            path_labels: vec!["cards".into(), "states".into()],
            files: vec![
                entry(Some("a")),
                Entry {
                    key: Key {
                        path_index: 1,
                        relative_path: "slot.sav".into(),
                    },
                    ..entry(Some("b"))
                },
            ],
        };
        assert!(validate(&cloud, "g", &cloud.path_labels).is_ok());
        assert_eq!(plan(&BTreeMap::new(), &cloud, None, Mode::Merge).len(), 2);
    }
    #[test]
    fn invalid_or_reordered_manifest_fails_closed() {
        let mut cloud = Manifest {
            protocol: PROTOCOL,
            game_id: "g".into(),
            revision: 1,
            commit_id: "c".into(),
            path_labels: vec!["cards".into()],
            files: vec![entry(Some("a"))],
        };
        assert!(validate(&cloud, "g", &["states".into()]).is_err());
        cloud.files[0].key.relative_path = "../escape".into();
        assert!(validate(&cloud, "g", &cloud.path_labels).is_err());
    }
}

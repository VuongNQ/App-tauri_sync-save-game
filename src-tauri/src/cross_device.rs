//! V2 orchestration: immutable Drive blobs + one Firestore CAS per whole game.
use crate::{
    firestore, gdrive, gdrive_auth,
    models::{
        BackupMeta, DriveFileFlatItem, DriveVersionBackup, GameEntry, SyncResult, SyncStructureDiff,
    },
    safe_files,
    save_transaction::{self, Change},
    settings,
    sync_v2::{self, Action, Baseline, BaselineFile, Entry, Key, Manifest, Mode, PROTOCOL},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

const SNAPSHOT: &str = ".snapshot-v2.json";
const OBJECTS: &str = ".save-sync-v2";
fn operation_id() -> String {
    format!("{:016x}{:016x}", fastrand::u64(..), fastrand::u64(..))
}

struct Working(PathBuf);
impl Drop for Working {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
struct Local {
    path: PathBuf,
    hash: String,
    size: u64,
}
struct Context<'a> {
    app: &'a AppHandle,
    user: String,
    game: GameEntry,
    roots: Vec<Option<PathBuf>>,
    labels: Vec<String>,
    scope: String,
    store: PathBuf,
    work: Working,
    _lock: File,
}

fn included(path: &str, filters: &[String]) -> bool {
    filters.is_empty()
        || filters
            .iter()
            .any(|f| path == f || path.starts_with(&format!("{}/", f.trim_end_matches('/'))))
}

impl<'a> Context<'a> {
    fn new(app: &'a AppHandle, game_id: &str) -> Result<Self, String> {
        crate::watcher::ensure_game_stopped(app, game_id)?;
        let user = gdrive_auth::get_current_user_id(app).ok_or("Not authenticated")?;
        let state = settings::load_state(app)?;
        let game = settings::find_game(&state, game_id)?.clone();
        let roots: Vec<_> = settings::effective_save_paths(&game, &state.settings)
            .into_iter()
            .map(|p| p.map(|v| PathBuf::from(settings::expand_env_vars(&v))))
            .collect();
        for root in roots.iter().flatten() {
            if !root.is_absolute() {
                return Err("Save folders must use absolute paths on this device".into());
            }
            safe_files::safe_join(root, "save-path-check")?;
        }
        for (i, left) in roots.iter().enumerate() {
            for right in roots.iter().skip(i + 1) {
                if let (Some(a), Some(b)) = (left, right) {
                    let a = a
                        .to_string_lossy()
                        .replace('\\', "/")
                        .trim_end_matches('/')
                        .to_lowercase();
                    let b = b
                        .to_string_lossy()
                        .replace('\\', "/")
                        .trim_end_matches('/')
                        .to_lowercase();
                    if a == b || a.starts_with(&format!("{b}/")) || b.starts_with(&format!("{a}/"))
                    {
                        return Err("Save folders overlap. Configure separate folders before multi-path sync.".into());
                    }
                }
            }
        }
        let labels = game.save_paths.iter().map(|p| p.label.clone()).collect();
        let scope = sync_v2::hash_bytes(
            &serde_json::to_vec(&(
                &roots,
                game.save_paths
                    .iter()
                    .map(|p| &p.sync_includes)
                    .collect::<Vec<_>>(),
            ))
            .map_err(|e| e.to_string())?,
        );
        // Hash local directory components: game IDs may contain portable path
        // characters and must never become an app-data traversal opportunity.
        let store = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("sync-v2")
            .join(sync_v2::hash_bytes(user.as_bytes()))
            .join(sync_v2::hash_bytes(game_id.as_bytes()));
        fs::create_dir_all(&store).map_err(|e| e.to_string())?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(store.join("operation.lock"))
            .map_err(|e| e.to_string())?;
        lock.try_lock()
            .map_err(|_| "This game's saves are in use by another app process")?;
        save_transaction::recover(&store.join("pending"))?;
        let work = Working(store.join(format!("work-{}", operation_id())));
        fs::create_dir_all(&work.0).map_err(|e| e.to_string())?;
        Ok(Self {
            app,
            user,
            game,
            roots,
            labels,
            scope,
            store,
            work,
            _lock: lock,
        })
    }
    fn active(&self, key: &Key) -> bool {
        self.roots.get(key.path_index).is_some_and(Option::is_some)
            && self
                .game
                .save_paths
                .get(key.path_index)
                .is_some_and(|p| included(&key.relative_path, &p.sync_includes))
    }
    fn baseline(&self) -> Result<Option<Baseline>, String> {
        let data = match fs::read(self.store.join("baseline.json")) {
            Ok(d) => d,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(format!("Cannot read sync baseline: {e}")),
        };
        let baseline: Baseline = serde_json::from_slice(&data)
            .map_err(|e| format!("Damaged sync baseline; saves unchanged: {e}"))?;
        if baseline.protocol != PROTOCOL || baseline.game_id != self.game.id {
            return Err("Invalid sync baseline identity".into());
        }
        if baseline.scope != self.scope {
            return Ok(None);
        }
        let mut seen = BTreeSet::new();
        for file in &baseline.files {
            safe_files::safe_join(Path::new("."), &file.key.relative_path)?;
            if file.key.path_index >= self.labels.len()
                || !seen.insert(file.key.clone())
                || file
                    .local_hash
                    .as_deref()
                    .is_some_and(|h| !sync_v2::valid_hash(h))
                || file
                    .cloud_hash
                    .as_deref()
                    .is_some_and(|h| !sync_v2::valid_hash(h))
            {
                return Err("Invalid sync baseline entry".into());
            }
        }
        Ok(Some(baseline))
    }
    fn collect(&self, baseline: Option<&Baseline>) -> Result<BTreeMap<Key, Local>, String> {
        let mut files = BTreeMap::new();
        let mut seen = BTreeSet::new();
        for (i, root) in self.roots.iter().enumerate() {
            let Some(root) = root else {
                continue;
            };
            if !root.exists() {
                if baseline.is_some_and(|b| {
                    b.files
                        .iter()
                        .any(|f| f.key.path_index == i && f.local_hash.is_some())
                }) {
                    return Err(format!(
                        "Previously synced folder is unavailable: {}. No deletions were published.",
                        root.display()
                    ));
                }
                continue;
            }
            for item in walkdir::WalkDir::new(root).follow_links(false) {
                let item = item.map_err(|e| format!("Cannot scan complete save folder: {e}"))?;
                if item.file_type().is_symlink() {
                    return Err("Linked files or folders cannot be synced".into());
                }
                if !item.file_type().is_file() {
                    continue;
                }
                let relative = item
                    .path()
                    .strip_prefix(root)
                    .map_err(|e| e.to_string())?
                    .to_str()
                    .ok_or("Save path is not valid Unicode")?
                    .replace('\\', "/");
                if relative
                    .split('/')
                    .any(|p| p.starts_with(safe_files::TEMP_PREFIX))
                {
                    continue;
                }
                let key = Key {
                    path_index: i,
                    relative_path: relative,
                };
                if !self.active(&key) {
                    continue;
                }
                let path = safe_files::safe_join(root, &key.relative_path)?;
                if !seen.insert((i, key.relative_path.to_lowercase())) {
                    return Err("Save paths collide on Windows".into());
                }
                let (hash, size) = sync_v2::hash_file(&path)?;
                files.insert(key, Local { path, hash, size });
            }
        }
        Ok(files)
    }
    fn load_cloud(&self) -> Result<(Manifest, Option<String>), String> {
        if let Some((manifest, version)) =
            firestore::load_v2_manifest(self.app, &self.user, &self.game.id)?
        {
            sync_v2::validate(&manifest, &self.game.id, &self.labels)?;
            return Ok((manifest, Some(version)));
        }
        // Import legacy per-path manifests conservatively. Hash the actual bytes,
        // never infer identity from file names, sizes or machine clocks.
        let (_, folder) = gdrive::ensure_game_folders(self.app, &self.game.id)?;
        let mut manifest = Manifest {
            protocol: PROTOCOL,
            game_id: self.game.id.clone(),
            revision: 1,
            commit_id: String::new(),
            path_labels: self.labels.clone(),
            files: Vec::new(),
        };
        let root_items = gdrive::list_drive_items(self.app, &folder)?;
        for i in 0..self.labels.len() {
            let path_folder = if i == 0 {
                folder.clone()
            } else {
                let name = format!("path-{i}");
                let Some(item) = root_items.iter().find(|f| f.is_folder && f.name == name) else {
                    continue;
                };
                item.id.clone()
            };
            let (meta, _) = gdrive::download_sync_meta(self.app, &path_folder)?;
            if let Some(meta) = meta {
                for entry in meta.files {
                    safe_files::safe_join(Path::new("."), &entry.path_file)?;
                    let object_id = entry
                        .drive_file_id
                        .ok_or("Legacy cloud save has no tracked file ID; no data changed")?;
                    let target = self.work.0.join(format!("legacy-{}", manifest.files.len()));
                    gdrive::download_file(self.app, &object_id, &target)?;
                    let (hash, size) = sync_v2::hash_file(&target)?;
                    manifest.files.push(Entry {
                        key: Key {
                            path_index: i,
                            relative_path: entry.path_file,
                        },
                        hash: Some(hash),
                        object_id: Some(object_id),
                        size,
                        revision: 1,
                        deleted: false,
                    });
                }
            }
        }
        sync_v2::validate(&manifest, &self.game.id, &self.labels)?;
        Ok((manifest, None))
    }
    fn materialize_legacy(&self, manifest: &mut Manifest) -> Result<(), String> {
        for (i, entry) in manifest.files.iter_mut().enumerate() {
            let source = self.work.0.join(format!("legacy-{i}"));
            let staged =
                self.upload_verified(&source, entry.hash.as_deref().ok_or("Legacy hash missing")?)?;
            entry.object_id = Some(staged);
        }
        Ok(())
    }
    fn upload_verified(&self, source: &Path, expected: &str) -> Result<String, String> {
        let (_, folder) = gdrive::ensure_game_folders(self.app, &self.game.id)?;
        let objects = gdrive::ensure_subfolder(self.app, &folder, OBJECTS)?;
        let staged = self.work.0.join(format!("blob-{}", operation_id()));
        let mut input = File::open(source).map_err(|e| e.to_string())?;
        safe_files::replace_from_reader(&staged, &mut input, None, None)?;
        if sync_v2::hash_file(&staged)?.0 != expected {
            return Err("Save changed while staging upload; retry after closing the game".into());
        }
        // No existing_file_id: shared published blobs are NEVER overwritten.
        let uploaded = gdrive::upload_file(self.app, &objects, &staged, None)?;
        Ok(uploaded.id)
    }
    fn download_verified(&self, entry: &Entry) -> Result<PathBuf, String> {
        let target = self.work.0.join(format!("download-{}", operation_id()));
        gdrive::download_file(
            self.app,
            entry
                .object_id
                .as_deref()
                .ok_or("Cloud object ID missing")?,
            &target,
        )?;
        let (hash, size) = sync_v2::hash_file(&target)?;
        if Some(hash.as_str()) != entry.content() || size != entry.size {
            return Err(
                "Downloaded save failed SHA-256/size verification; live saves unchanged".into(),
            );
        }
        Ok(target)
    }
    fn snapshot(
        &self,
        manifest: &Manifest,
        label: Option<String>,
    ) -> Result<DriveVersionBackup, String> {
        let (_, folder) = gdrive::ensure_game_folders(self.app, &self.game.id)?;
        let backups = gdrive::ensure_subfolder(self.app, &folder, "backups")?;
        let now = chrono::Utc::now().to_rfc3339();
        let label = label
            .map(|s| s.trim().chars().take(80).collect::<String>())
            .filter(|s| !s.is_empty());
        let name = format!(
            "{now} — {} [{}]",
            label.as_deref().unwrap_or("all save paths"),
            operation_id()
        );
        let id = gdrive::ensure_subfolder(self.app, &backups, &name)?;
        let total_files = manifest.files.iter().filter(|e| !e.deleted).count() as u32;
        let total_size = manifest
            .files
            .iter()
            .filter(|e| !e.deleted)
            .try_fold(0u64, |s, e| {
                s.checked_add(e.size).ok_or("Snapshot size overflow")
            })?;
        // The snapshot pins all immutable object IDs, including nested files and
        // every path. Mark complete only after the full manifest is uploaded.
        gdrive::upload_json_to_folder(
            self.app,
            &id,
            SNAPSHOT,
            &serde_json::to_vec(manifest).map_err(|e| e.to_string())?,
            None,
        )?;
        let meta = BackupMeta {
            created_time: now.clone(),
            label,
            total_files,
            total_size,
        };
        gdrive::upload_json_to_folder(
            self.app,
            &id,
            ".backup-meta.json",
            &serde_json::to_vec(&meta).map_err(|e| e.to_string())?,
            None,
        )?;
        Ok(DriveVersionBackup {
            id,
            name,
            created_time: now,
            total_files,
            total_size,
        })
    }
}

pub fn execute(app: &AppHandle, game_id: &str, mode: Mode) -> Result<SyncResult, String> {
    let context = Context::new(app, game_id)?;
    execute_context(&context, mode, None)
}

fn execute_context(
    context: &Context<'_>,
    mode: Mode,
    snapshot: Option<Manifest>,
) -> Result<SyncResult, String> {
    if context.roots.iter().all(Option::is_none) {
        return Err("Save path is not set for this game".into());
    }
    let baseline = context.baseline()?;
    let scan_baseline = if mode == Mode::Restore {
        None
    } else {
        baseline.as_ref()
    };
    let local = context.collect(scan_baseline)?;
    let (mut cloud, version) = context.load_cloud()?;
    if baseline
        .as_ref()
        .is_some_and(|b| b.revision > cloud.revision)
    {
        return Err("Cloud save revision moved backwards or was removed; no files changed. Review recovery snapshots before reconnecting.".into());
    }
    let restoring_snapshot = snapshot.is_some();
    let mut desired = snapshot.unwrap_or_else(|| cloud.clone());
    if restoring_snapshot {
        // A snapshot restores the complete tracked set: files introduced after
        // the snapshot become versioned deletions rather than resurrecting later.
        for entry in &cloud.files {
            if !desired.files.iter().any(|e| e.key == entry.key) {
                desired.files.push(Entry {
                    key: entry.key.clone(),
                    hash: None,
                    object_id: None,
                    size: 0,
                    revision: desired.revision.max(1),
                    deleted: true,
                });
            }
        }
    }
    let mut active_cloud = desired.clone();
    active_cloud.files.retain(|e| context.active(&e.key));
    let hashes = local
        .iter()
        .map(|(k, v)| (k.clone(), v.hash.clone()))
        .collect();
    let actions: Vec<_> = sync_v2::coherent_plan(
        sync_v2::plan(&hashes, &active_cloud, baseline.as_ref(), mode)
            .into_iter()
            .filter(|(k, _)| context.active(k))
            .collect(),
        mode,
    );
    let conflicts: Vec<_> = actions
        .iter()
        .filter(|(_, a)| *a == Action::Conflict)
        .map(|(k, _)| format!("[path-{}] {}", k.path_index, k.relative_path))
        .collect();
    if !conflicts.is_empty() {
        return Err(format!("SAVE_CONFLICT: {}. Both copies were retained. Choose Push local or Restore cloud explicitly.", conflicts.join(", ")));
    }
    // Check projected LIVE bytes before uploading. Recovery/snapshot retention
    // is intentionally not reclaimed automatically and consumes extra Drive space.
    let mut projected: BTreeMap<_, _> = desired
        .files
        .iter()
        .filter(|e| !e.deleted)
        .map(|e| (e.key.clone(), e.size))
        .collect();
    for (key, action) in &actions {
        if *action == Action::Upload {
            projected.insert(key.clone(), local.get(key).ok_or("Missing upload")?.size);
        }
        if *action == Action::DeleteCloud {
            projected.remove(key);
        }
    }
    let projected_total = projected
        .values()
        .try_fold(0u64, |s, n| s.checked_add(*n).ok_or("Cloud quota overflow"))?;
    let state = settings::load_state(context.app)?;
    let others = state
        .games
        .iter()
        .filter(|g| g.id != context.game.id)
        .try_fold(0u64, |s, g| {
            s.checked_add(g.cloud_storage_bytes.unwrap_or(0))
                .ok_or("Cloud quota overflow")
        })?;
    let limit = firestore::load_admin_config(context.app)
        .map(|c| c.drive_quota_bytes)
        .unwrap_or(crate::models::DEFAULT_DRIVE_QUOTA_BYTES);
    if others
        .checked_add(projected_total)
        .ok_or("Cloud quota overflow")?
        > limit
    {
        return Err("Storage limit exceeded; no new save objects uploaded".into());
    }
    if version.is_none() {
        context.materialize_legacy(&mut cloud)?;
        // Swap legacy IDs for immutable IDs without replacing a chosen snapshot.
        if !restoring_snapshot {
            desired = cloud.clone();
        }
    }
    let revision = cloud
        .revision
        .checked_add(1)
        .ok_or("Save revision overflow")?;
    let mut next = cloud.clone();
    next.revision = revision;
    next.commit_id = operation_id();
    if restoring_snapshot {
        for entry in &desired.files {
            if context.active(&entry.key) {
                next.files.retain(|e| e.key != entry.key);
                let mut replacement = entry.clone();
                replacement.revision = revision;
                next.files.push(replacement);
            }
        }
    }
    let mut changes = Vec::new();
    let mut uploaded = 0;
    let mut downloaded = 0;
    let mut skipped = 0;
    for (key, action) in &actions {
        match action {
            Action::Upload => {
                let file = local.get(key).ok_or("Local upload disappeared")?;
                let id = context.upload_verified(&file.path, &file.hash)?;
                next.files.retain(|e| e.key != *key);
                next.files.push(Entry {
                    key: key.clone(),
                    hash: Some(file.hash.clone()),
                    object_id: Some(id),
                    size: file.size,
                    revision,
                    deleted: false,
                });
                uploaded += 1;
            }
            Action::DeleteCloud => {
                next.files.retain(|e| e.key != *key);
                next.files.push(Entry {
                    key: key.clone(),
                    hash: None,
                    object_id: None,
                    size: 0,
                    revision,
                    deleted: true,
                });
                uploaded += 1;
            }
            Action::Download | Action::DeleteLocal => {
                let root = context.roots[key.path_index]
                    .as_ref()
                    .ok_or("Save folder not configured")?;
                let source = if *action == Action::Download {
                    let entry = next
                        .files
                        .iter()
                        .find(|e| e.key == *key)
                        .ok_or("Missing cloud entry")?;
                    Some(context.download_verified(entry)?)
                } else {
                    None
                };
                changes.push(Change {
                    root: root.clone(),
                    relative: key.relative_path.clone(),
                    expected: local.get(key).map(|f| f.hash.clone()),
                    source,
                });
                downloaded += 1;
            }
            Action::Keep => skipped += 1,
            Action::Conflict => unreachable!(),
        }
    }
    sync_v2::validate(&next, &context.game.id, &context.labels)?;
    let total = next
        .files
        .iter()
        .filter(|f| !f.deleted)
        .try_fold(0u64, |sum, f| {
            sum.checked_add(f.size).ok_or("Cloud size overflow")
        })?;
    if others.checked_add(total).ok_or("Cloud quota overflow")? > limit {
        return Err("Storage limit exceeded; new cloud revision was not published".into());
    }
    // Re-scan after all network transfers to catch edits, new files and deletions.
    crate::watcher::ensure_game_stopped(context.app, &context.game.id)?;
    let observed = context.collect(scan_baseline)?;
    if observed.len() != local.len()
        || observed
            .iter()
            .any(|(k, f)| local.get(k).is_none_or(|old| old.hash != f.hash))
    {
        return Err("Save changed during transfer. Retry after closing the game; no cloud revision published.".into());
    }
    let after_files = actions
        .iter()
        .map(|(key, action)| {
            let cloud_hash = next
                .files
                .iter()
                .find(|e| e.key == *key)
                .and_then(Entry::content)
                .map(String::from);
            let local_hash = match action {
                Action::Download => cloud_hash.clone(),
                Action::DeleteLocal => None,
                _ => local.get(key).map(|f| f.hash.clone()),
            };
            BaselineFile {
                key: key.clone(),
                local_hash,
                cloud_hash,
            }
        })
        .collect();
    let next_baseline = Baseline {
        protocol: PROTOCOL,
        game_id: context.game.id.clone(),
        scope: context.scope.clone(),
        revision,
        files: after_files,
    };
    let baseline_source = context.work.0.join("baseline-next.json");
    safe_files::atomic_write(
        &baseline_source,
        &serde_json::to_vec(&next_baseline).map_err(|e| e.to_string())?,
    )?;
    let baseline_path = context.store.join("baseline.json");
    let expected = if baseline_path.exists() {
        Some(sync_v2::hash_file(&baseline_path)?.0)
    } else {
        None
    };
    changes.push(Change {
        root: context.store.clone(),
        relative: "baseline.json".into(),
        expected,
        source: Some(baseline_source),
    });
    save_transaction::prepare(&context.store.join("pending"), &changes)?;
    if next.files != cloud.files && !cloud.files.is_empty() {
        context.snapshot(&cloud, Some("Before sync".into()))?;
    }
    crate::watcher::ensure_game_stopped(context.app, &context.game.id)?;
    let before_publish = context.collect(scan_baseline)?;
    if before_publish.len() != local.len()
        || before_publish
            .iter()
            .any(|(k, f)| local.get(k).is_none_or(|old| old.hash != f.hash))
    {
        return Err(
            "Save changed while creating the recovery snapshot; no new cloud revision published"
                .into(),
        );
    }
    // Only the winner can publish. A losing device keeps all local originals;
    // uploaded orphan blobs are intentionally retained for recovery.
    firestore::commit_v2_manifest(
        context.app,
        &context.user,
        &context.game.id,
        version.as_deref(),
        &next,
    )?;
    crate::watcher::ensure_game_stopped(context.app, &context.game.id)?;
    save_transaction::apply(&context.store.join("pending"))?;
    settings::update_game_field(context.app, &context.game.id, |g| {
        g.last_cloud_modified = Some(chrono::Utc::now().to_rfc3339());
        g.cloud_storage_bytes = Some(total);
    })?;
    Ok(SyncResult {
        game_id: context.game.id.clone(),
        uploaded,
        downloaded,
        skipped,
        error: None,
    })
}

pub fn diff(app: &AppHandle, game_id: &str) -> Result<SyncStructureDiff, String> {
    let context = Context::new(app, game_id)?;
    let baseline = context.baseline()?;
    let local = context.collect(None)?;
    let (mut cloud, _) = context.load_cloud()?;
    cloud.files.retain(|e| context.active(&e.key));
    let hashes = local
        .iter()
        .map(|(k, f)| (k.clone(), f.hash.clone()))
        .collect();
    let mut result = SyncStructureDiff {
        game_id: game_id.into(),
        cloud_has_data: !cloud.files.is_empty(),
        local_only_files: vec![],
        cloud_only_files: vec![],
        local_newer_files: vec![],
        cloud_newer_files: vec![],
        conflict_files: vec![],
        local_deleted_files: vec![],
        cloud_deleted_files: vec![],
        has_diff: false,
    };
    let actions = sync_v2::coherent_plan(
        sync_v2::plan(&hashes, &cloud, baseline.as_ref(), Mode::Merge)
            .into_iter()
            .filter(|(k, _)| context.active(k))
            .collect(),
        Mode::Merge,
    );
    for (key, action) in actions {
        let name = format!("[path-{}] {}", key.path_index, key.relative_path);
        match action {
            Action::Conflict => result.conflict_files.push(name),
            Action::Upload if !cloud.files.iter().any(|e| e.key == key && !e.deleted) => {
                result.local_only_files.push(name)
            }
            Action::Upload => result.local_newer_files.push(name),
            Action::DeleteCloud => result.local_deleted_files.push(name),
            Action::Download if !local.contains_key(&key) => result.cloud_only_files.push(name),
            Action::Download => result.cloud_newer_files.push(name),
            Action::DeleteLocal => result.cloud_deleted_files.push(name),
            _ => (),
        }
    }
    result.has_diff = !result.local_only_files.is_empty()
        || !result.cloud_only_files.is_empty()
        || !result.local_newer_files.is_empty()
        || !result.cloud_newer_files.is_empty()
        || !result.conflict_files.is_empty()
        || !result.local_deleted_files.is_empty()
        || !result.cloud_deleted_files.is_empty();
    Ok(result)
}

pub fn create_backup(
    app: &AppHandle,
    game_id: &str,
    label: Option<String>,
) -> Result<DriveVersionBackup, String> {
    let context = Context::new(app, game_id)?;
    let (mut cloud, version) = context.load_cloud()?;
    if context
        .baseline()?
        .is_some_and(|b| b.revision > cloud.revision)
    {
        return Err("Cloud manifest was removed or moved backwards. Recovery snapshots were retained; no new cloud manifest was created.".into());
    }
    if version.is_none() {
        context.materialize_legacy(&mut cloud)?;
        cloud.commit_id = operation_id();
        firestore::commit_v2_manifest(app, &context.user, game_id, None, &cloud)?;
    }
    context.snapshot(&cloud, label)
}

/// Return None for a legacy snapshot so its existing conservative restore path
/// can still be used on a game that has never adopted the v2 protocol.
pub fn restore_backup(
    app: &AppHandle,
    game_id: &str,
    folder_id: &str,
) -> Result<Option<SyncResult>, String> {
    let context = Context::new(app, game_id)?;
    let (_, game_folder) = gdrive::ensure_game_folders(app, game_id)?;
    let root = gdrive::list_drive_items(app, &game_folder)?;
    let backups = root
        .iter()
        .find(|e| e.is_folder && e.name == "backups")
        .ok_or("No snapshots for this game")?;
    if !gdrive::list_drive_items(app, &backups.id)?
        .iter()
        .any(|e| e.is_folder && e.id == folder_id)
    {
        return Err("Snapshot does not belong to this game".into());
    }
    let items = gdrive::list_drive_items(app, folder_id)?;
    let Some(file) = items.iter().find(|e| !e.is_folder && e.name == SNAPSHOT) else {
        if firestore::load_v2_manifest(app, &context.user, game_id)?.is_some() {
            return Err("This legacy snapshot lacks a multi-path manifest. Recover its files manually; current versioned saves were kept.".into());
        }
        return Ok(None);
    };
    let manifest: Manifest =
        serde_json::from_str(&gdrive::download_json_from_drive(app, &file.id)?)
            .map_err(|e| format!("Damaged snapshot: {e}"))?;
    sync_v2::validate(&manifest, game_id, &context.labels)?;
    Ok(Some(execute_context(
        &context,
        Mode::Restore,
        Some(manifest),
    )?))
}

pub fn has_manifest(app: &AppHandle, game_id: &str) -> Result<bool, String> {
    let user = gdrive_auth::get_current_user_id(app).ok_or("Not authenticated")?;
    Ok(firestore::load_v2_manifest(app, &user, game_id)?.is_some())
}

pub fn list_files(
    app: &AppHandle,
    game_id: &str,
) -> Result<Option<Vec<DriveFileFlatItem>>, String> {
    let user = gdrive_auth::get_current_user_id(app).ok_or("Not authenticated")?;
    let Some((manifest, _)) = firestore::load_v2_manifest(app, &user, game_id)? else {
        return Ok(None);
    };
    let state = settings::load_state(app)?;
    let game = settings::find_game(&state, game_id)?;
    let labels: Vec<_> = game.save_paths.iter().map(|p| p.label.clone()).collect();
    sync_v2::validate(&manifest, game_id, &labels)?;
    let folder = game.gdrive_folder_id.clone().unwrap_or_default();
    Ok(Some(
        manifest
            .files
            .into_iter()
            .filter(|e| !e.deleted)
            .map(|e| {
                let path = if e.key.path_index == 0 {
                    e.key.relative_path.clone()
                } else {
                    format!("path-{}/{}", e.key.path_index, e.key.relative_path)
                };
                DriveFileFlatItem {
                    id: e.object_id.unwrap_or_default(),
                    name: e.key.relative_path.rsplit('/').next().unwrap_or("").into(),
                    relative_path: path,
                    size: Some(e.size),
                    modified_time: None,
                    is_folder: false,
                    parent_folder_id: folder.clone(),
                    content_protected: true,
                    sync_path: Some(format!(
                        "[{}] {}",
                        labels[e.key.path_index], e.key.relative_path
                    )),
                }
            })
            .collect(),
    ))
}

pub fn delete_file(app: &AppHandle, game_id: &str, object_id: &str) -> Result<bool, String> {
    let context = Context::new(app, game_id)?;
    let Some((mut cloud, version)) = firestore::load_v2_manifest(app, &context.user, game_id)?
    else {
        return Ok(false);
    };
    sync_v2::validate(&cloud, game_id, &context.labels)?;
    let position = cloud.files.iter().position(|e| !e.deleted && e.object_id.as_deref() == Some(object_id)).ok_or("This item is not a current save. Immutable recovery objects cannot be deleted from the file manager.")?;
    context.snapshot(&cloud, Some("Before cloud deletion".into()))?;
    cloud.revision = cloud
        .revision
        .checked_add(1)
        .ok_or("Save revision overflow")?;
    cloud.commit_id = operation_id();
    let entry = &mut cloud.files[position];
    entry.deleted = true;
    entry.hash = None;
    entry.object_id = None;
    entry.size = 0;
    entry.revision = cloud.revision;
    firestore::commit_v2_manifest(app, &context.user, game_id, Some(&version), &cloud)?;
    Ok(true)
}

pub fn clean_excluded(app: &AppHandle, game_id: &str) -> Result<u32, String> {
    let context = Context::new(app, game_id)?;
    let (mut cloud, version) = context.load_cloud()?;
    if version.is_none() {
        context.materialize_legacy(&mut cloud)?;
    }
    let keys: BTreeSet<_> = cloud
        .files
        .iter()
        .filter(|e| {
            !e.deleted
                && context
                    .game
                    .save_paths
                    .get(e.key.path_index)
                    .is_some_and(|p| !included(&e.key.relative_path, &p.sync_includes))
        })
        .map(|e| e.key.clone())
        .collect();
    if keys.is_empty() {
        return Ok(0);
    }
    context.snapshot(&cloud, Some("Before removing excluded files".into()))?;
    cloud.revision = cloud
        .revision
        .checked_add(1)
        .ok_or("Save revision overflow")?;
    cloud.commit_id = operation_id();
    for entry in &mut cloud.files {
        if keys.contains(&entry.key) {
            entry.deleted = true;
            entry.hash = None;
            entry.object_id = None;
            entry.size = 0;
            entry.revision = cloud.revision;
        }
    }
    firestore::commit_v2_manifest(app, &context.user, game_id, version.as_deref(), &cloud)?;
    Ok(keys.len() as u32)
}

/// Only for explicit Remove game / Clear all cloud data. Retain the previous
/// baseline and recovery journals, but let a subsequently re-added game start fresh.
pub fn reset_local_baseline(app: &AppHandle, game_id: &str) -> Result<(), String> {
    let context = Context::new(app, game_id)?;
    let baseline = context.store.join("baseline.json");
    if baseline.exists() {
        fs::rename(
            &baseline,
            context
                .store
                .join(format!("removed-baseline-{}.json", operation_id())),
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

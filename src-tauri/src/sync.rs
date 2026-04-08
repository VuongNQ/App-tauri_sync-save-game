use std::{
    fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

use crate::{
    gdrive,
    models::{SaveFileInfo, SaveInfo, SyncFileMeta, SyncMeta, SyncResult, SyncStructureDiff},
    settings,
};

// ── Local file info ───────────────────────────────────────

struct LocalFileInfo {
    relative_path: String,
    absolute_path: PathBuf,
    modified_iso: String,
    size: u64,
}

/// Collect all files under `save_path` with their metadata.
fn collect_local_files(save_path: &Path) -> Result<Vec<LocalFileInfo>, String> {
    if !save_path.exists() {
        return Err(format!("Save path does not exist: {}", save_path.display()));
    }

    let mut files = Vec::new();
    for entry in WalkDir::new(save_path)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
    {
        let abs = entry.path().to_path_buf();
        let rel = abs
            .strip_prefix(save_path)
            .map_err(|e| format!("Strip prefix error: {e}"))?
            .to_string_lossy()
            // Normalize to forward slashes for cross-platform Drive storage
            .replace('\\', "/");

        let meta = fs::metadata(&abs)
            .map_err(|e| format!("Cannot stat {}: {e}", abs.display()))?;

        let modified = meta
            .modified()
            .map_err(|e| format!("Cannot get modified time: {e}"))?;
        let duration = modified
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default();
        let dt = chrono::DateTime::from_timestamp(duration.as_secs() as i64, 0)
            .unwrap_or_default();
        let modified_iso = dt.to_rfc3339();

        files.push(LocalFileInfo {
            relative_path: rel,
            absolute_path: abs,
            modified_iso,
            size: meta.len(),
        });
    }

    Ok(files)
}

// ── Public functions ──────────────────────────────────────

/// Maximum total cloud storage allowed per user across all games (200 MB).
const STORAGE_LIMIT_BYTES: u64 = 200 * 1024 * 1024;

/// Check whether a relative path matches any exclusion entry.
/// An entry ending with `/` is treated as a folder prefix; otherwise it is
/// an exact file match (or a folder where the path starts with `<entry>/`).
fn is_excluded(rel_path: &str, excludes: &[String]) -> bool {
    for ex in excludes {
        if ex.ends_with('/') {
            // Folder prefix — match anything under this directory
            if rel_path.starts_with(ex.as_str()) {
                return true;
            }
        } else {
            // Exact file match OR path starts with `<entry>/` (entry is a folder without trailing slash)
            if rel_path == ex.as_str() || rel_path.starts_with(&format!("{ex}/")) {
                return true;
            }
        }
    }
    false
}

/// Compute the projected total cloud bytes for one game after a sync completes.
/// Uses local file sizes for files that will be uploaded, and existing cloud
/// sizes for files that are cloud-only (will be downloaded, not re-uploaded).
fn projected_game_cloud_bytes(local_files: &[LocalFileInfo], cloud_meta: &SyncMeta) -> u64 {
    // All local files will either be uploaded (local size) or stay in sync
    // (local size is what Drive will hold after upload/keep).
    let local_total: u64 = local_files.iter().map(|f| f.size).sum();

    // Cloud-only files (not present locally) will be downloaded; their size
    // counts toward cloud usage until the next sync writes the local copy back.
    let cloud_only: u64 = cloud_meta
        .files
        .iter()
        .filter(|(rel, _)| !local_files.iter().any(|l| l.relative_path == **rel))
        .map(|(_, cm)| cm.size)
        .sum();

    local_total + cloud_only
}
pub fn get_save_info(app: &AppHandle, game_id: &str) -> Result<SaveInfo, String> {
    let state = settings::load_state(app)?;
    let game = state
        .games
        .iter()
        .find(|g| g.id == game_id)
        .ok_or_else(|| format!("Game not found: {game_id}"))?;

    let save_path = game
        .save_path
        .as_deref()
        .ok_or("Save path is not set for this game")?;
    let expanded_path = settings::expand_env_vars(save_path);
    let save_dir = Path::new(&expanded_path);

    let local_files = collect_local_files(save_dir)?;

    let total_files = local_files.len() as u32;
    let total_size: u64 = local_files.iter().map(|f| f.size).sum();
    let last_modified = local_files
        .iter()
        .map(|f| f.modified_iso.as_str())
        .max()
        .map(String::from);

    let files: Vec<SaveFileInfo> = local_files
        .iter()
        .map(|f| SaveFileInfo {
            relative_path: f.relative_path.clone(),
            size: f.size,
            modified_time: f.modified_iso.clone(),
        })
        .collect();

    Ok(SaveInfo {
        game_id: game_id.to_string(),
        save_path: save_path.to_string(),
        total_files,
        total_size,
        last_modified,
        files,
    })
}

// ── Public sync functions ─────────────────────────────────

/// Sync a single game's save files with Google Drive.
pub fn sync_game(app: &AppHandle, game_id: &str) -> Result<SyncResult, String> {
    let _ = app.emit("sync-started", game_id);
    println!("[sync] Starting sync for game: {game_id}");

    let result = sync_game_inner(app, game_id);

    match &result {
        Ok(r) => {
            println!(
                "[sync] Completed {game_id}: {} up, {} down, {} skipped",
                r.uploaded, r.downloaded, r.skipped
            );
            let _ = app.emit("sync-completed", r);
        }
        Err(e) => {
            println!("[sync] Error for {game_id}: {e}");
            let err_result = SyncResult {
                game_id: game_id.to_string(),
                uploaded: 0,
                downloaded: 0,
                skipped: 0,
                error: Some(e.clone()),
            };
            let _ = app.emit("sync-error", &err_result);
        }
    }

    result
}

/// Download a Drive file to a local path.
/// If the stored `drive_file_id` returns HTTP 404 (stale ID), re-lists the
/// folder, finds the file by the last component of `rel_path`, and retries.
/// Returns `Some(id_used)` on success, `None` if the file can't be found.
fn download_with_fallback(
    app: &AppHandle,
    folder_id: &str,
    cached_files: &mut Vec<crate::models::DriveFile>,
    drive_file_id: &str,
    rel_path: &str,
    dest: &Path,
) -> Result<Option<String>, String> {
    match gdrive::download_file(app, drive_file_id, dest) {
        Ok(()) => return Ok(Some(drive_file_id.to_string())),
        Err(ref e) if !e.contains("404") => return Err(e.clone()),
        Err(_) => {} // 404 — fall through to re-list
    }

    eprintln!(
        "[sync] drive_file_id {drive_file_id} stale for '{rel_path}'; re-listing folder {folder_id}"
    );
    let refreshed = gdrive::list_files(app, folder_id)?;
    *cached_files = refreshed;

    let file_name = Path::new(rel_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(rel_path);

    match cached_files.iter().find(|f| f.name == file_name) {
        Some(f) => {
            let fid = f.id.clone();
            gdrive::download_file(app, &fid, dest)?;
            Ok(Some(fid))
        }
        None => {
            eprintln!("[sync] '{rel_path}' not found on Drive after re-list — skipping");
            Ok(None)
        }
    }
}

fn sync_game_inner(app: &AppHandle, game_id: &str) -> Result<SyncResult, String> {
    // 1. Load game entry
    let state = settings::load_state(app)?;
    let game = state
        .games
        .iter()
        .find(|g| g.id == game_id)
        .ok_or_else(|| format!("Game not found: {game_id}"))?
        .clone();

    let save_path = game
        .save_path
        .as_deref()
        .ok_or("Save path is not set for this game")?;
    let expanded_path = settings::expand_env_vars(save_path);
    let save_dir = Path::new(&expanded_path);

    // 2. Ensure Drive folders exist
    let root_folder_id = gdrive::ensure_root_folder(app)?;
    let game_folder_id = gdrive::ensure_game_folder(app, &root_folder_id, game_id)?;

    // 3. Get cloud sync metadata
    let (cloud_meta_opt, meta_file_id) = gdrive::download_sync_meta(app, &game_folder_id)?;
    let cloud_meta = cloud_meta_opt.unwrap_or_default();

    // 4. List existing Drive files (for looking up file IDs by name)
    let mut drive_files = gdrive::list_files(app, &game_folder_id)?;

    // 5. Collect local files — excluding paths the user has opted out of syncing
    let all_local_files = collect_local_files(save_dir)?;
    let local_files: Vec<LocalFileInfo> = all_local_files
        .into_iter()
        .filter(|f| !is_excluded(&f.relative_path, &game.sync_excludes))
        .collect();

    // ── Storage limit guard ───────────────────────────────────────────────────
    let projected_this_game = projected_game_cloud_bytes(&local_files, &cloud_meta);
    let other_games_bytes: u64 = state
        .games
        .iter()
        .filter(|g| g.id != game_id)
        .map(|g| g.cloud_storage_bytes.unwrap_or(0))
        .sum();
    let projected_total = other_games_bytes + projected_this_game;
    if projected_total > STORAGE_LIMIT_BYTES {
        return Err(format!(
            "Storage limit exceeded: this sync would use {:.1} MB but the 200 MB per-user limit would be reached. \
             Free up space by removing games or reducing save file sizes.",
            projected_total as f64 / 1_048_576.0
        ));
    }
    println!(
        "[sync] Storage check passed for {game_id}: {:.1} MB / {:.1} MB used",
        projected_total as f64 / 1_048_576.0,
        STORAGE_LIMIT_BYTES as f64 / 1_048_576.0
    );
    // ─────────────────────────────────────────────────────────────────────────

    let mut uploaded = 0u32;
    let mut downloaded = 0u32;
    let mut skipped = 0u32;
    let mut new_meta = SyncMeta {
        last_synced: Some(chrono::Utc::now().to_rfc3339()),
        files: cloud_meta.files.clone(),
    };

    // 6. Per-file comparison: local files vs cloud meta
    for local in &local_files {
        let cloud_entry = cloud_meta.files.get(&local.relative_path);

        let should_upload = match cloud_entry {
            None => true, // New file, not on cloud
            Some(cm) => local.modified_iso > cm.modified_time,
        };

        if should_upload {
            // Find existing Drive file ID for update (PATCH) vs new upload (POST)
            let existing_id = cloud_entry
                .and_then(|cm| cm.drive_file_id.as_deref())
                .or_else(|| {
                    // Also check drive_files list by name (for files uploaded outside meta)
                    let file_name = Path::new(&local.relative_path)
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or(&local.relative_path);
                    drive_files.iter().find(|f| f.name == file_name).map(|f| f.id.as_str())
                });

            let result = gdrive::upload_file(app, &game_folder_id, &local.absolute_path, existing_id)?;

            new_meta.files.insert(
                local.relative_path.clone(),
                SyncFileMeta {
                    modified_time: local.modified_iso.clone(),
                    size: local.size,
                    drive_file_id: Some(result.id),
                },
            );
            uploaded += 1;
        } else if let Some(cm) = cloud_entry {
            if cm.modified_time > local.modified_iso {
                // Cloud is newer → download
                let drive_file_id = cm
                    .drive_file_id
                    .as_deref()
                    .ok_or_else(|| format!("No Drive file ID for {}", local.relative_path))?;

                let dest = save_dir.join(local.relative_path.replace('/', "\\"));
                let used_id = download_with_fallback(
                    app,
                    &game_folder_id,
                    &mut drive_files,
                    drive_file_id,
                    &local.relative_path,
                    &dest,
                )?;
                if let Some(fid) = used_id {
                    new_meta.files.insert(
                        local.relative_path.clone(),
                        SyncFileMeta {
                            modified_time: cm.modified_time.clone(),
                            size: cm.size,
                            drive_file_id: Some(fid),
                        },
                    );
                    downloaded += 1;
                } else {
                    // File no longer exists on Drive — treat local copy as authoritative
                    skipped += 1;
                }
            } else {
                skipped += 1;
            }
        } else {
            skipped += 1;
        }
    }

    // 7. Check for files that exist only on the cloud (not locally) → download
    for (rel_path, cm) in &cloud_meta.files {
        if local_files.iter().any(|l| l.relative_path == *rel_path) {
            continue; // Already handled above
        }

        // File exists on cloud but not locally → download it
        if let Some(ref drive_file_id) = cm.drive_file_id {
            let dest = save_dir.join(rel_path.replace('/', "\\"));
            let used_id = download_with_fallback(
                app,
                &game_folder_id,
                &mut drive_files,
                drive_file_id,
                rel_path,
                &dest,
            )?;
            if let Some(fid) = used_id {
                new_meta.files.insert(
                    rel_path.clone(),
                    SyncFileMeta {
                        modified_time: cm.modified_time.clone(),
                        size: cm.size,
                        drive_file_id: Some(fid),
                    },
                );
                downloaded += 1;
            }
        }
    }

    // 8. Upload updated sync metadata
    gdrive::upload_sync_meta(app, &game_folder_id, &new_meta, meta_file_id.as_deref())?;

    // 9. Update game entry timestamps and cloud storage size in state
    let now_iso = chrono::Utc::now().to_rfc3339();
    let new_cloud_bytes: u64 = new_meta.files.values().map(|f| f.size).sum();
    let _ = settings::update_game_field(app, game_id, |g| {
        g.last_local_modified = Some(now_iso.clone());
        g.last_cloud_modified = Some(now_iso.clone());
        g.cloud_storage_bytes = Some(new_cloud_bytes);
    });

    Ok(SyncResult {
        game_id: game_id.to_string(),
        uploaded,
        downloaded,
        skipped,
        error: None,
    })
}

/// Sync all games that have a save_path set (regardless of track_changes).
pub fn sync_all_games(app: &AppHandle) -> Result<Vec<SyncResult>, String> {
    let state = settings::load_state(app)?;
    let game_ids: Vec<String> = state
        .games
        .iter()
        .filter(|g| g.save_path.is_some())
        .map(|g| g.id.clone())
        .collect();

    let mut results = Vec::new();
    for gid in game_ids {
        results.push(sync_game(app, &gid));
    }

    // Collect, treating individual failures as part of the results
    Ok(results
        .into_iter()
        .map(|r| {
            r.unwrap_or_else(|e| SyncResult {
                game_id: "unknown".to_string(),
                uploaded: 0,
                downloaded: 0,
                skipped: 0,
                error: Some(e),
            })
        })
        .collect())
}

// ── Diff check ────────────────────────────────────────────

/// Check the difference between local save files and Drive sync metadata.
/// Returns a detailed diff without performing any file transfers.
pub fn check_sync_structure_diff(
    app: &AppHandle,
    game_id: &str,
) -> Result<SyncStructureDiff, String> {
    // 1. Load game entry
    let state = settings::load_state(app)?;
    let game = state
        .games
        .iter()
        .find(|g| g.id == game_id)
        .ok_or_else(|| format!("Game not found: {game_id}"))?
        .clone();

    let save_path = game
        .save_path
        .as_deref()
        .ok_or("Save path is not set for this game")?;
    let expanded_path = settings::expand_env_vars(save_path);
    let save_dir = Path::new(&expanded_path);

    // 2. Ensure Drive folders exist (idempotent — creates only if absent)
    let root_folder_id = gdrive::ensure_root_folder(app)?;
    let game_folder_id = gdrive::ensure_game_folder(app, &root_folder_id, game_id)?;

    // 3. Download sync metadata
    let (cloud_meta_opt, _) = gdrive::download_sync_meta(app, &game_folder_id)?;
    let cloud_has_data = cloud_meta_opt.is_some();
    let cloud_meta = cloud_meta_opt.unwrap_or_default();

    // 4. Collect local files — excluding paths the user has opted out of syncing
    let local_files = if save_dir.exists() {
        collect_local_files(save_dir)?
            .into_iter()
            .filter(|f| !is_excluded(&f.relative_path, &game.sync_excludes))
            .collect()
    } else {
        Vec::new()
    };

    // 5. Classify files into diff categories
    let mut local_only_files = Vec::new();
    let mut local_newer_files = Vec::new();
    let mut cloud_newer_files = Vec::new();

    for local in &local_files {
        match cloud_meta.files.get(&local.relative_path) {
            None => local_only_files.push(local.relative_path.clone()),
            Some(cm) => {
                if local.modified_iso > cm.modified_time {
                    local_newer_files.push(local.relative_path.clone());
                } else if cm.modified_time > local.modified_iso {
                    cloud_newer_files.push(local.relative_path.clone());
                }
                // equal timestamps → no diff for this file
            }
        }
    }

    let cloud_only_files: Vec<String> = cloud_meta
        .files
        .keys()
        .filter(|rel_path| !local_files.iter().any(|l| l.relative_path == **rel_path))
        .cloned()
        .collect();

    let has_diff = !local_only_files.is_empty()
        || !cloud_only_files.is_empty()
        || !local_newer_files.is_empty()
        || !cloud_newer_files.is_empty();

    Ok(SyncStructureDiff {
        game_id: game_id.to_string(),
        cloud_has_data,
        local_only_files,
        cloud_only_files,
        local_newer_files,
        cloud_newer_files,
        has_diff,
    })
}

// ── Restore from cloud ────────────────────────────────────

/// Force-download all Drive save files to local, regardless of timestamps.
/// Local-only files are left untouched (non-destructive restore).
pub fn restore_from_cloud(app: &AppHandle, game_id: &str) -> Result<SyncResult, String> {
    let _ = app.emit("sync-started", game_id);
    println!("[sync] Starting restore-from-cloud for game: {game_id}");

    let result = restore_from_cloud_inner(app, game_id);

    match &result {
        Ok(r) => {
            println!("[sync] Restore complete {game_id}: {} down, {} skipped", r.downloaded, r.skipped);
            let _ = app.emit("sync-completed", r);
        }
        Err(e) => {
            println!("[sync] Restore error for {game_id}: {e}");
            let err_result = SyncResult {
                game_id: game_id.to_string(),
                uploaded: 0,
                downloaded: 0,
                skipped: 0,
                error: Some(e.clone()),
            };
            let _ = app.emit("sync-error", &err_result);
        }
    }

    result
}

fn restore_from_cloud_inner(app: &AppHandle, game_id: &str) -> Result<SyncResult, String> {
    // 1. Load game entry
    let state = settings::load_state(app)?;
    let game = state
        .games
        .iter()
        .find(|g| g.id == game_id)
        .ok_or_else(|| format!("Game not found: {game_id}"))?
        .clone();

    let save_path = game
        .save_path
        .as_deref()
        .ok_or("Save path is not set for this game")?;
    let expanded_path = settings::expand_env_vars(save_path);
    let save_dir = Path::new(&expanded_path);

    // 2. Ensure Drive folders exist
    let root_folder_id = gdrive::ensure_root_folder(app)?;
    let game_folder_id = gdrive::ensure_game_folder(app, &root_folder_id, game_id)?;

    // 3. Get cloud sync metadata — required for a restore
    let (cloud_meta_opt, meta_file_id) = gdrive::download_sync_meta(app, &game_folder_id)?;
    let cloud_meta = cloud_meta_opt
        .ok_or("No Drive data found for this game. Sync to Drive first.")?;

    let mut downloaded = 0u32;
    let mut skipped = 0u32;
    let mut new_meta = SyncMeta {
        last_synced: Some(chrono::Utc::now().to_rfc3339()),
        files: cloud_meta.files.clone(),
    };

    // 4. Force-download ALL cloud-tracked files
    for (rel_path, cm) in &cloud_meta.files {
        if let Some(ref drive_file_id) = cm.drive_file_id {
            let dest = save_dir.join(rel_path.replace('/', "\\"));
            gdrive::download_file(app, drive_file_id, &dest)?;
            new_meta.files.insert(
                rel_path.clone(),
                SyncFileMeta {
                    modified_time: cm.modified_time.clone(),
                    size: cm.size,
                    drive_file_id: Some(drive_file_id.clone()),
                },
            );
            downloaded += 1;
        } else {
            // Tracked in meta but no Drive file ID — cannot restore
            skipped += 1;
        }
    }

    // 5. Upload updated sync metadata
    gdrive::upload_sync_meta(app, &game_folder_id, &new_meta, meta_file_id.as_deref())?;

    // 6. Update game entry timestamps and cloud storage size
    let now_iso = chrono::Utc::now().to_rfc3339();
    let new_cloud_bytes: u64 = new_meta.files.values().map(|f| f.size).sum();
    let _ = settings::update_game_field(app, game_id, |g| {
        g.last_local_modified = Some(now_iso.clone());
        g.last_cloud_modified = Some(now_iso.clone());
        g.cloud_storage_bytes = Some(new_cloud_bytes);
    });

    Ok(SyncResult {
        game_id: game_id.to_string(),
        uploaded: 0,
        downloaded,
        skipped,
        error: None,
    })
}

// ── Push to cloud ─────────────────────────────────────────

/// Force-upload all local save files to Drive, regardless of timestamps.
/// Cloud-only files are left in place (non-destructive push).
pub fn push_to_cloud(app: &AppHandle, game_id: &str) -> Result<SyncResult, String> {
    let _ = app.emit("sync-started", game_id);
    println!("[sync] Starting push-to-cloud for game: {game_id}");

    let result = push_to_cloud_inner(app, game_id);

    match &result {
        Ok(r) => {
            println!("[sync] Push complete {game_id}: {} up, {} skipped", r.uploaded, r.skipped);
            let _ = app.emit("sync-completed", r);
        }
        Err(e) => {
            println!("[sync] Push error for {game_id}: {e}");
            let err_result = SyncResult {
                game_id: game_id.to_string(),
                uploaded: 0,
                downloaded: 0,
                skipped: 0,
                error: Some(e.clone()),
            };
            let _ = app.emit("sync-error", &err_result);
        }
    }

    result
}

fn push_to_cloud_inner(app: &AppHandle, game_id: &str) -> Result<SyncResult, String> {
    // 1. Load game entry
    let state = settings::load_state(app)?;
    let game = state
        .games
        .iter()
        .find(|g| g.id == game_id)
        .ok_or_else(|| format!("Game not found: {game_id}"))?
        .clone();

    let save_path = game
        .save_path
        .as_deref()
        .ok_or("Save path is not set for this game")?;
    let expanded_path = settings::expand_env_vars(save_path);
    let save_dir = Path::new(&expanded_path);

    // 2. Ensure Drive folders exist
    let root_folder_id = gdrive::ensure_root_folder(app)?;
    let game_folder_id = gdrive::ensure_game_folder(app, &root_folder_id, game_id)?;

    // 3. Get cloud meta + existing Drive file list
    let (cloud_meta_opt, meta_file_id) = gdrive::download_sync_meta(app, &game_folder_id)?;
    let cloud_meta = cloud_meta_opt.unwrap_or_default();
    let drive_files = gdrive::list_files(app, &game_folder_id)?;

    // 4. Collect local files — excluding paths the user has opted out of syncing
    let all_local_files = collect_local_files(save_dir)?;
    let local_files: Vec<LocalFileInfo> = all_local_files
        .into_iter()
        .filter(|f| !is_excluded(&f.relative_path, &game.sync_excludes))
        .collect();

    // ── Storage limit guard ───────────────────────────────────────────────────
    let projected_this_game = projected_game_cloud_bytes(&local_files, &cloud_meta);
    let other_games_bytes: u64 = state
        .games
        .iter()
        .filter(|g| g.id != game_id)
        .map(|g| g.cloud_storage_bytes.unwrap_or(0))
        .sum();
    let projected_total = other_games_bytes + projected_this_game;
    if projected_total > STORAGE_LIMIT_BYTES {
        return Err(format!(
            "Storage limit exceeded: this push would use {:.1} MB but the 200 MB per-user limit would be reached.",
            projected_total as f64 / 1_048_576.0
        ));
    }
    // ─────────────────────────────────────────────────────────────────────────

    let mut uploaded = 0u32;
    let mut skipped = 0u32;
    let mut new_meta = SyncMeta {
        last_synced: Some(chrono::Utc::now().to_rfc3339()),
        files: cloud_meta.files.clone(),
    };

    // 5. Force-upload ALL local files
    for local in &local_files {
        let cloud_entry = cloud_meta.files.get(&local.relative_path);
        // Look up existing Drive file ID for PATCH vs new POST
        let existing_id = cloud_entry
            .and_then(|cm| cm.drive_file_id.as_deref())
            .or_else(|| {
                let file_name = Path::new(&local.relative_path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or(&local.relative_path);
                drive_files.iter().find(|f| f.name == file_name).map(|f| f.id.as_str())
            });

        let result = gdrive::upload_file(app, &game_folder_id, &local.absolute_path, existing_id)?;
        new_meta.files.insert(
            local.relative_path.clone(),
            SyncFileMeta {
                modified_time: local.modified_iso.clone(),
                size: local.size,
                drive_file_id: Some(result.id),
            },
        );
        uploaded += 1;
    }

    // 6. Cloud-only files are left in Drive (non-destructive) → counted as skipped
    for (rel_path, _) in &cloud_meta.files {
        if !local_files.iter().any(|l| l.relative_path == *rel_path) {
            skipped += 1;
        }
    }

    // 7. Upload updated sync metadata
    gdrive::upload_sync_meta(app, &game_folder_id, &new_meta, meta_file_id.as_deref())?;

    // 8. Update game entry timestamps and cloud storage size
    let now_iso = chrono::Utc::now().to_rfc3339();
    let new_cloud_bytes: u64 = new_meta.files.values().map(|f| f.size).sum();
    let _ = settings::update_game_field(app, game_id, |g| {
        g.last_local_modified = Some(now_iso.clone());
        g.last_cloud_modified = Some(now_iso.clone());
        g.cloud_storage_bytes = Some(new_cloud_bytes);
    });

    Ok(SyncResult {
        game_id: game_id.to_string(),
        uploaded,
        downloaded: 0,
        skipped,
        error: None,
    })
}

// ── Cleanup excluded files from Cloud ────────────────────

/// Delete files from Google Drive that the user has newly added to `sync_excludes`.
/// Updates `.sync-meta.json` to remove the deleted entries.
/// Called in a background thread from the `update_game` command handler.
pub fn cleanup_excluded_from_cloud(
    app: &AppHandle,
    game_id: &str,
    newly_excluded: Vec<String>,
) -> Result<(), String> {
    if newly_excluded.is_empty() {
        return Ok(());
    }

    println!(
        "[sync] Cleaning up {} newly-excluded path(s) from Drive for game {game_id}",
        newly_excluded.len()
    );

    // 1. Ensure Drive folder exists
    let root_folder_id = gdrive::ensure_root_folder(app)?;
    let game_folder_id = gdrive::ensure_game_folder(app, &root_folder_id, game_id)?;

    // 2. Download sync metadata
    let (cloud_meta_opt, meta_file_id) = gdrive::download_sync_meta(app, &game_folder_id)?;
    let mut cloud_meta = match cloud_meta_opt {
        Some(m) => m,
        None => {
            println!("[sync] No cloud meta for {game_id} — nothing to clean up");
            return Ok(());
        }
    };

    // 3. For each excluded path, delete its Drive file and remove it from meta
    let expandable_excludes: Vec<String> = newly_excluded;
    // We need sync_excludes from GameEntry to evaluate is_excluded properly.
    // Since newly_excluded already contains only the new entries, we use them directly.
    let keys_to_remove: Vec<String> = cloud_meta
        .files
        .keys()
        .filter(|rel_path| is_excluded(rel_path, &expandable_excludes))
        .cloned()
        .collect();

    for rel_path in &keys_to_remove {
        if let Some(file_meta) = cloud_meta.files.get(rel_path) {
            if let Some(ref drive_file_id) = file_meta.drive_file_id {
                println!("[sync] Deleting excluded Drive file '{rel_path}' (id={drive_file_id})");
                if let Err(e) = gdrive::delete_drive_file(app, drive_file_id) {
                    // Log but continue — meta cleanup still happens
                    eprintln!("[sync] Failed to delete Drive file '{rel_path}': {e}");
                }
            }
        }
        cloud_meta.files.remove(rel_path);
    }

    // 4. Re-upload updated sync metadata
    gdrive::upload_sync_meta(app, &game_folder_id, &cloud_meta, meta_file_id.as_deref())?;

    // 5. Update cloud_storage_bytes to reflect new total
    let new_cloud_bytes: u64 = cloud_meta.files.values().map(|f| f.size).sum();
    let _ = settings::update_game_field(app, game_id, |g| {
        g.cloud_storage_bytes = Some(new_cloud_bytes);
    });

    println!(
        "[sync] Cleanup complete for {game_id}: removed {} path(s) from Drive",
        keys_to_remove.len()
    );

    Ok(())
}

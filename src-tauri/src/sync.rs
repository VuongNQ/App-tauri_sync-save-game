use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use tauri::{AppHandle, Emitter, Manager};
use walkdir::WalkDir;

use crate::{
    gdrive, gdrive_auth,
    models::{
        LocalFileRecord, LocalSyncState, PathSaveInfo, SaveFileInfo, SaveInfo, SyncFileEntry,
        SyncMeta, SyncResult, SyncStructureDiff,
    },
    settings,
};

// ── Local file info ───────────────────────────────────────

struct LocalFileInfo {
    relative_path: String,
    absolute_path: PathBuf,
    modified_iso: String,
    size: u64,
}

/// Per-path sync counters used by the multi-path loop.
struct PathSyncResult {
    uploaded: u32,
    downloaded: u32,
    skipped: u32,
    cloud_bytes: u64,
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
        .filter(|f| !local_files.iter().any(|l| l.relative_path == f.path_file))
        .map(|f| f.size)
        .sum();

    local_total + cloud_only
}

/// Scan a save directory and return the ISO 8601 timestamp of the most recently
/// modified file.  Returns `None` if the directory does not exist, is empty, or
/// cannot be read.
pub fn scan_last_modified(save_path: &Path) -> Option<String> {
    let files = collect_local_files(save_path).ok()?;
    files
        .iter()
        .map(|f| f.modified_iso.as_str())
        .max()
        .map(String::from)
}

pub fn get_save_info(app: &AppHandle, game_id: &str) -> Result<SaveInfo, String> {
    let state = settings::load_state(app)?;
    let game = settings::find_game(&state, game_id)?;

    let effectives = settings::effective_save_paths(game, &state.settings);

    // Require at least one configured path.
    let primary_path = effectives
        .iter()
        .find_map(|p| p.clone())
        .ok_or("Save path is not set for this game")?;

    let mut all_files: Vec<SaveFileInfo> = Vec::new();
    let mut path_infos: Vec<PathSaveInfo> = Vec::new();

    for (i, effective) in effectives.iter().enumerate() {
        let save_path = match effective {
            Some(p) => p,
            None => continue,
        };
        let label = game
            .save_paths
            .get(i)
            .map(|e| e.label.clone())
            .filter(|l| !l.is_empty())
            .unwrap_or_else(|| format!("Path {}", i + 1));
        let expanded_path = settings::expand_env_vars(save_path);
        let save_dir = Path::new(&expanded_path);
        if !save_dir.exists() {
            continue;
        }
        let local_files = collect_local_files(save_dir)?;
        let path_files: Vec<SaveFileInfo> = local_files
            .iter()
            .map(|f| SaveFileInfo {
                relative_path: f.relative_path.clone(),
                size: f.size,
                modified_time: f.modified_iso.clone(),
            })
            .collect();
        let path_size: u64 = path_files.iter().map(|f| f.size).sum();
        path_infos.push(PathSaveInfo {
            label,
            save_path: save_path.clone(),
            total_size: path_size,
            files: path_files.clone(),
        });
        all_files.extend(path_files);
    }

    let total_files = all_files.len() as u32;
    let total_size: u64 = all_files.iter().map(|f| f.size).sum();
    let last_modified = all_files
        .iter()
        .map(|f| f.modified_time.as_str())
        .max()
        .map(String::from);

    // Only populate path_infos when there are multiple paths — single-path stays flat.
    let path_infos_out = if path_infos.len() > 1 { path_infos } else { vec![] };

    Ok(SaveInfo {
        game_id: game_id.to_string(),
        save_path: primary_path,
        total_files,
        total_size,
        last_modified,
        files: all_files,
        path_infos: path_infos_out,
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

/// Sync a single save-path directory to a specific Drive folder.
/// Returns per-path counters and the total cloud bytes after sync.
fn sync_single_path(
    app: &AppHandle,
    game_id: &str,
    path_index: usize,
    user_id: &str,
    save_dir: &Path,
    drive_folder_id: &str,
    sync_excludes: &[String],
    other_games_bytes: u64,
    current_game_cloud_bytes: u64,
) -> Result<PathSyncResult, String> {
    // 1. Get cloud sync metadata
    let (cloud_meta_opt, meta_file_id) = gdrive::download_sync_meta(app, drive_folder_id)?;
    let cloud_meta = cloud_meta_opt.unwrap_or_default();

    // 2. List existing Drive files (for live timestamps + file IDs)
    let mut drive_files = gdrive::list_files(app, drive_folder_id)?;

    // 3. Collect local files — excluding per-path exclusions
    let all_local_files = collect_local_files(save_dir)?;
    let local_files: Vec<LocalFileInfo> = all_local_files
        .into_iter()
        .filter(|f| !is_excluded(&f.relative_path, sync_excludes))
        .collect();

    // ── Storage limit guard ───────────────────────────────────────────────────
    let projected_this_path = projected_game_cloud_bytes(&local_files, &cloud_meta);
    let projected_total = other_games_bytes + current_game_cloud_bytes + projected_this_path;
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

    let meta_lookup: HashMap<&str, &SyncFileEntry> =
        cloud_meta.files.iter().map(|f| (f.path_file.as_str(), f)).collect();

    // Load the per-device, per-path tracker to know what was last synced.
    // Empty on first sync — all files will be treated as new and uploaded.
    let tracker = load_local_tracker(app, user_id, game_id, path_index);
    let tracker_lookup: HashMap<&str, &LocalFileRecord> =
        tracker.files.iter().map(|f| (f.path_file.as_str(), f)).collect();

    let mut uploaded = 0u32;
    let mut downloaded = 0u32;
    let mut skipped = 0u32;
    let mut new_meta = SyncMeta {
        last_synced: Some(chrono::Utc::now().to_rfc3339()),
        files: cloud_meta.files.clone(),
    };

    // 4. Per-file delta comparison: local files vs cloud meta + local tracker
    for local in &local_files {
        let cloud_entry = meta_lookup.get(local.relative_path.as_str()).copied();
        let tracker_entry = tracker_lookup.get(local.relative_path.as_str()).copied();
        let file_name = Path::new(&local.relative_path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&local.relative_path);

        // Has the local file changed since our last sync?
        let local_changed = tracker_entry
            .map(|t| t.modified_time.as_str() != local.modified_iso.as_str() || t.size != local.size)
            .unwrap_or(true); // no tracker entry → treat as new

        // Is there a cloud version newer than what we last saw?
        let cloud_ts = cloud_entry.and_then(|e| e.modified_time.as_deref()).unwrap_or("");
        let last_known_ts = tracker_entry.map(|t| t.modified_time.as_str()).unwrap_or("");
        let cloud_newer = !cloud_ts.is_empty() && cloud_ts > last_known_ts;

        if local_changed && cloud_newer {
            // Conflict: both sides changed since last sync — pick the newer absolute timestamp
            if local.modified_iso.as_str() >= cloud_ts {
                // Local wins — upload
                let existing_id = cloud_entry
                    .and_then(|e| e.drive_file_id.as_deref())
                    .or_else(|| {
                        drive_files.iter().find(|f| f.name == file_name).map(|f| f.id.as_str())
                    });
                let result =
                    gdrive::upload_file(app, drive_folder_id, &local.absolute_path, existing_id)?;
                new_meta.files.retain(|f| f.path_file != local.relative_path);
                new_meta.files.push(SyncFileEntry {
                    path_file: local.relative_path.clone(),
                    size: local.size,
                    drive_file_id: Some(result.id),
                    modified_time: Some(local.modified_iso.clone()),
                });
                uploaded += 1;
            } else {
                // Cloud wins — download
                let drive_file_id_owned: Option<String> = cloud_entry
                    .and_then(|e| e.drive_file_id.clone())
                    .or_else(|| {
                        drive_files.iter().find(|f| f.name == file_name).map(|f| f.id.clone())
                    });
                if let Some(ref drive_file_id) = drive_file_id_owned {
                    let dest = save_dir.join(local.relative_path.replace('/', "\\"));
                    let used_id = download_with_fallback(
                        app,
                        drive_folder_id,
                        &mut drive_files,
                        drive_file_id,
                        &local.relative_path,
                        &dest,
                    )?;
                    if let Some(fid) = used_id {
                        new_meta.files.retain(|f| f.path_file != local.relative_path);
                        new_meta.files.push(SyncFileEntry {
                            path_file: local.relative_path.clone(),
                            size: cloud_entry.map(|e| e.size).unwrap_or(0),
                            drive_file_id: Some(fid),
                            modified_time: Some(cloud_ts.to_string()),
                        });
                        downloaded += 1;
                    } else {
                        skipped += 1;
                    }
                } else {
                    skipped += 1;
                }
            }
        } else if local_changed {
            // Only local changed — upload
            let existing_id = cloud_entry
                .and_then(|e| e.drive_file_id.as_deref())
                .or_else(|| {
                    drive_files.iter().find(|f| f.name == file_name).map(|f| f.id.as_str())
                });
            let result =
                gdrive::upload_file(app, drive_folder_id, &local.absolute_path, existing_id)?;
            new_meta.files.retain(|f| f.path_file != local.relative_path);
            new_meta.files.push(SyncFileEntry {
                path_file: local.relative_path.clone(),
                size: local.size,
                drive_file_id: Some(result.id),
                modified_time: Some(local.modified_iso.clone()),
            });
            uploaded += 1;
        } else if cloud_newer {
            // Only cloud changed — download
            let drive_file_id_owned: Option<String> = cloud_entry
                .and_then(|e| e.drive_file_id.clone())
                .or_else(|| {
                    drive_files.iter().find(|f| f.name == file_name).map(|f| f.id.clone())
                });
            if let Some(ref drive_file_id) = drive_file_id_owned {
                let dest = save_dir.join(local.relative_path.replace('/', "\\"));
                let used_id = download_with_fallback(
                    app,
                    drive_folder_id,
                    &mut drive_files,
                    drive_file_id,
                    &local.relative_path,
                    &dest,
                )?;
                if let Some(fid) = used_id {
                    new_meta.files.retain(|f| f.path_file != local.relative_path);
                    new_meta.files.push(SyncFileEntry {
                        path_file: local.relative_path.clone(),
                        size: cloud_entry.map(|e| e.size).unwrap_or(0),
                        drive_file_id: Some(fid),
                        modified_time: Some(cloud_ts.to_string()),
                    });
                    downloaded += 1;
                } else {
                    skipped += 1;
                }
            } else {
                skipped += 1;
            }
        } else {
            // Neither side changed since last sync — skip
            skipped += 1;
        }
    }

    // 5. Handle files that exist only on Drive (not present locally)
    for entry in cloud_meta.files.iter() {
        if local_files.iter().any(|l| l.relative_path == entry.path_file) {
            continue;
        }
        let tracker_entry = tracker_lookup.get(entry.path_file.as_str()).copied();
        let cloud_ts = entry.modified_time.as_deref().unwrap_or("");
        let last_known_ts = tracker_entry.map(|t| t.modified_time.as_str()).unwrap_or("");

        // If we've seen this file before and cloud hasn't changed since then, the user
        // likely deleted it locally — skip to avoid re-downloading a deliberately deleted file.
        if tracker_entry.is_some() && (cloud_ts.is_empty() || cloud_ts <= last_known_ts) {
            skipped += 1;
            continue;
        }

        // New cloud-only file (never seen locally) or cloud has a newer version → download
        if let Some(ref drive_file_id) = entry.drive_file_id {
            let dest = save_dir.join(entry.path_file.replace('/', "\\"));
            let used_id = download_with_fallback(
                app,
                drive_folder_id,
                &mut drive_files,
                drive_file_id,
                &entry.path_file,
                &dest,
            )?;
            if let Some(fid) = used_id {
                new_meta.files.retain(|f| f.path_file != entry.path_file);
                new_meta.files.push(SyncFileEntry {
                    path_file: entry.path_file.clone(),
                    size: entry.size,
                    drive_file_id: Some(fid),
                    modified_time: entry.modified_time.clone(),
                });
                downloaded += 1;
            }
        }
    }

    // 6. Upload updated sync metadata
    gdrive::upload_sync_meta(app, drive_folder_id, &new_meta, meta_file_id.as_deref())?;
    spawn_sync_meta_mirror(app, game_id, new_meta.clone());

    // 7. Save local tracker: re-scan to capture the actual post-sync file states
    //    (downloaded files get OS-assigned mtimes, so we must re-read them).
    if !user_id.is_empty() {
        let final_files = collect_local_files(save_dir).unwrap_or_default();
        let updated_tracker = LocalSyncState {
            game_id: game_id.to_string(),
            path_index,
            last_updated: chrono::Utc::now().to_rfc3339(),
            files: final_files
                .into_iter()
                .filter(|f| !is_excluded(&f.relative_path, sync_excludes))
                .map(|f| LocalFileRecord {
                    path_file: f.relative_path,
                    size: f.size,
                    modified_time: f.modified_iso,
                })
                .collect(),
        };
        if let Err(e) = save_local_tracker(app, user_id, &updated_tracker) {
            eprintln!("[sync] Failed to save local tracker for {game_id}-p{path_index}: {e}");
        }
    }

    let cloud_bytes: u64 = new_meta.files.iter().map(|f| f.size).sum();
    Ok(PathSyncResult {
        uploaded,
        downloaded,
        skipped,
        cloud_bytes,
    })
}

fn sync_game_inner(app: &AppHandle, game_id: &str) -> Result<SyncResult, String> {
    // 1. Load game entry
    let state = settings::load_state(app)?;
    let game = settings::find_game(&state, game_id)?.clone();

    let effectives = settings::effective_save_paths(&game, &state.settings);

    if effectives.iter().all(|p| p.is_none()) {
        return Err("Save path is not set for this game".into());
    }

    // 2. Ensure root + game Drive folders exist (idempotent)
    let (_root_folder_id, game_folder_id) = gdrive::ensure_game_folders(app, game_id)?;

    let user_id = gdrive_auth::get_current_user_id(app).unwrap_or_default();

    let other_games_bytes: u64 = state
        .games
        .iter()
        .filter(|g| g.id != game_id)
        .map(|g| g.cloud_storage_bytes.unwrap_or(0))
        .sum();

    let mut total_uploaded = 0u32;
    let mut total_downloaded = 0u32;
    let mut total_skipped = 0u32;
    let mut total_cloud_bytes = 0u64;

    // 3. Iterate over each configured save path
    for (i, effective) in effectives.iter().enumerate() {
        let save_path = match effective {
            Some(p) => p,
            None => continue, // device-specific path not configured on this machine
        };
        let expanded_path = settings::expand_env_vars(save_path);
        let save_dir_owned = expanded_path.clone();
        let save_dir = Path::new(&save_dir_owned);

        // Resolve the Drive folder for this path index.
        // Always call ensure_subfolder (search-or-create) so that a stale or
        // incorrectly-placed cached folder ID is never used blindly.
        let drive_folder_id = if i == 0 {
            game_folder_id.clone()
        } else {
            let fid =
                gdrive::ensure_subfolder(app, &game_folder_id, &format!("path-{i}"))?;
            // Update the cache with the verified correct ID.
            let _ = settings::update_game_field(app, game_id, |g| {
                if let Some(entry) = g.save_paths.get_mut(i) {
                    entry.gdrive_folder_id = Some(fid.clone());
                }
            });
            fid
        };

        let sync_excludes = game
            .save_paths
            .get(i)
            .map(|e| e.sync_excludes.as_slice())
            .unwrap_or(&[]);

        let path_result = sync_single_path(
            app,
            game_id,
            i,
            &user_id,
            save_dir,
            &drive_folder_id,
            sync_excludes,
            other_games_bytes,
            total_cloud_bytes,
        )?;

        total_uploaded += path_result.uploaded;
        total_downloaded += path_result.downloaded;
        total_skipped += path_result.skipped;
        total_cloud_bytes += path_result.cloud_bytes;
    }

    // 4. Update game entry timestamps and total cloud storage size
    let now_iso = chrono::Utc::now().to_rfc3339();
    let _ = settings::update_game_field(app, game_id, |g| {
        g.last_cloud_modified = Some(now_iso.clone());
        g.cloud_storage_bytes = Some(total_cloud_bytes);
    });

    Ok(SyncResult {
        game_id: game_id.to_string(),
        uploaded: total_uploaded,
        downloaded: total_downloaded,
        skipped: total_skipped,
        error: None,
    })
}

/// Sync all games that have at least one save path set (regardless of track_changes).
pub fn sync_all_games(app: &AppHandle) -> Result<Vec<SyncResult>, String> {
    let state = settings::load_state(app)?;
    let game_ids: Vec<String> = state
        .games
        .iter()
        .filter(|g| !g.save_paths.is_empty())
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
    let game = settings::find_game(&state, game_id)?.clone();

    let effectives = settings::effective_save_paths(&game, &state.settings);

    // 2. Ensure Drive folders exist (idempotent — creates only if absent)
    let (_root_folder_id, game_folder_id) = gdrive::ensure_game_folders(app, game_id)?;

    let mut cloud_has_data = false;
    let mut local_only_files = Vec::new();
    let mut cloud_only_files = Vec::new();
    let mut local_newer_files = Vec::new();
    let mut cloud_newer_files = Vec::new();

    for (i, effective) in effectives.iter().enumerate() {
        let save_path = match effective {
            Some(p) => p,
            None => continue,
        };
        let expanded_path = settings::expand_env_vars(save_path);
        let save_dir_owned = expanded_path.clone();
        let save_dir = Path::new(&save_dir_owned);

        let drive_folder_id = if i == 0 {
            game_folder_id.clone()
        } else {
            gdrive::ensure_subfolder(app, &game_folder_id, &format!("path-{i}"))?
        };

        let sync_excludes = game
            .save_paths
            .get(i)
            .map(|e| e.sync_excludes.as_slice())
            .unwrap_or(&[]);

        // 3. Download sync metadata
        let (cloud_meta_opt, _) = gdrive::download_sync_meta(app, &drive_folder_id)?;
        if cloud_meta_opt.is_some() {
            cloud_has_data = true;
        }
        let cloud_meta = cloud_meta_opt.unwrap_or_default();

        // 4. List Drive files for live modification timestamps
        let drive_files = gdrive::list_files(app, &drive_folder_id)?;
        let drive_file_map: HashMap<&str, &str> = drive_files
            .iter()
            .filter_map(|f| f.modified_time.as_deref().map(|ts| (f.name.as_str(), ts)))
            .collect();

        // 5. Collect local files (with exclusions)
        let local_files = if save_dir.exists() {
            collect_local_files(save_dir)?
                .into_iter()
                .filter(|f| !is_excluded(&f.relative_path, sync_excludes))
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };

        let meta_lookup: HashMap<&str, &SyncFileEntry> =
            cloud_meta.files.iter().map(|f| (f.path_file.as_str(), f)).collect();

        // 6. Classify diff — prefix with path-i for non-zero paths so UI can display origin
        let prefix = if i == 0 {
            String::new()
        } else {
            format!("[path-{i}] ")
        };

        for local in &local_files {
            let rel = format!("{}{}", prefix, local.relative_path);
            match meta_lookup.get(local.relative_path.as_str()) {
                None => local_only_files.push(rel),
                Some(_) => {
                    let file_name = Path::new(&local.relative_path)
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or(&local.relative_path);
                    let cloud_ts = drive_file_map.get(file_name).copied().unwrap_or("");
                    if local.modified_iso.as_str() > cloud_ts {
                        local_newer_files.push(rel);
                    } else if cloud_ts > local.modified_iso.as_str() {
                        cloud_newer_files.push(rel);
                    }
                }
            }
        }

        for f in cloud_meta.files.iter() {
            if !local_files.iter().any(|l| l.relative_path == f.path_file) {
                cloud_only_files.push(format!("{}{}", prefix, f.path_file));
            }
        }
    }

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
    let game = settings::find_game(&state, game_id)?.clone();

    let effectives = settings::effective_save_paths(&game, &state.settings);
    if effectives.iter().all(|p| p.is_none()) {
        return Err("Save path is not set for this game".into());
    }

    // 2. Ensure Drive folders exist
    let (_root_folder_id, game_folder_id) = gdrive::ensure_game_folders(app, game_id)?;

    let user_id = gdrive_auth::get_current_user_id(app).unwrap_or_default();

    let mut total_downloaded = 0u32;
    let mut total_skipped = 0u32;
    let mut total_cloud_bytes = 0u64;

    for (i, effective) in effectives.iter().enumerate() {
        let save_path = match effective {
            Some(p) => p,
            None => continue,
        };
        let expanded_path = settings::expand_env_vars(save_path);
        let save_dir_owned = expanded_path.clone();
        let save_dir = Path::new(&save_dir_owned);

        let drive_folder_id = if i == 0 {
            game_folder_id.clone()
        } else {
            gdrive::ensure_subfolder(app, &game_folder_id, &format!("path-{i}"))?
        };

        // 3. Get cloud sync metadata — required for a restore
        let (cloud_meta_opt, meta_file_id) = gdrive::download_sync_meta(app, &drive_folder_id)?;
        let cloud_meta = match cloud_meta_opt {
            Some(m) => m,
            None => {
                // No data for this path — skip it
                continue;
            }
        };

        let mut downloaded = 0u32;
        let mut skipped = 0u32;
        let mut new_meta = SyncMeta {
            last_synced: Some(chrono::Utc::now().to_rfc3339()),
            files: cloud_meta.files.clone(),
        };

        // 4. Force-download ALL cloud-tracked files
        for entry in cloud_meta.files.iter() {
            if let Some(ref drive_file_id) = entry.drive_file_id {
                let dest = save_dir.join(entry.path_file.replace('/', "\\"));
                gdrive::download_file(app, drive_file_id, &dest)?;
                new_meta.files.retain(|f| f.path_file != entry.path_file);
                new_meta.files.push(SyncFileEntry {
                    path_file: entry.path_file.clone(),
                    size: entry.size,
                    drive_file_id: Some(drive_file_id.clone()),
                    modified_time: entry.modified_time.clone(),
                });
                downloaded += 1;
            } else {
                skipped += 1;
            }
        }

        // 5. Upload updated sync metadata
        gdrive::upload_sync_meta(app, &drive_folder_id, &new_meta, meta_file_id.as_deref())?;
        spawn_sync_meta_mirror(app, game_id, new_meta.clone());

        // 6. Save local tracker from post-restore file states
        if !user_id.is_empty() {
            let final_files = collect_local_files(save_dir).unwrap_or_default();
            let updated_tracker = LocalSyncState {
                game_id: game_id.to_string(),
                path_index: i,
                last_updated: chrono::Utc::now().to_rfc3339(),
                files: final_files
                    .into_iter()
                    .map(|f| LocalFileRecord {
                        path_file: f.relative_path,
                        size: f.size,
                        modified_time: f.modified_iso,
                    })
                    .collect(),
            };
            if let Err(e) = save_local_tracker(app, &user_id, &updated_tracker) {
                eprintln!("[sync] Failed to save local tracker for {game_id}-p{i}: {e}");
            }
        }

        let cloud_bytes: u64 = new_meta.files.iter().map(|f| f.size).sum();
        total_downloaded += downloaded;
        total_skipped += skipped;
        total_cloud_bytes += cloud_bytes;
    }

    // 6. Update game entry timestamps and cloud storage size
    let now_iso = chrono::Utc::now().to_rfc3339();
    let _ = settings::update_game_field(app, game_id, |g| {
        g.last_cloud_modified = Some(now_iso.clone());
        g.cloud_storage_bytes = Some(total_cloud_bytes);
    });

    Ok(SyncResult {
        game_id: game_id.to_string(),
        uploaded: 0,
        downloaded: total_downloaded,
        skipped: total_skipped,
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
    let game = settings::find_game(&state, game_id)?.clone();

    let effectives = settings::effective_save_paths(&game, &state.settings);
    if effectives.iter().all(|p| p.is_none()) {
        return Err("Save path is not set for this game".into());
    }

    // 2. Ensure Drive folders exist
    let (_root_folder_id, game_folder_id) = gdrive::ensure_game_folders(app, game_id)?;

    let user_id = gdrive_auth::get_current_user_id(app).unwrap_or_default();

    let other_games_bytes: u64 = state
        .games
        .iter()
        .filter(|g| g.id != game_id)
        .map(|g| g.cloud_storage_bytes.unwrap_or(0))
        .sum();

    let mut total_uploaded = 0u32;
    let mut total_skipped = 0u32;
    let mut total_cloud_bytes = 0u64;

    for (i, effective) in effectives.iter().enumerate() {
        let save_path = match effective {
            Some(p) => p,
            None => continue,
        };
        let expanded_path = settings::expand_env_vars(save_path);
        let save_dir_owned = expanded_path.clone();
        let save_dir = Path::new(&save_dir_owned);

        let drive_folder_id = if i == 0 {
            game_folder_id.clone()
        } else {
            let fid =
                gdrive::ensure_subfolder(app, &game_folder_id, &format!("path-{i}"))?;
            let _ = settings::update_game_field(app, game_id, |g| {
                if let Some(entry) = g.save_paths.get_mut(i) {
                    entry.gdrive_folder_id = Some(fid.clone());
                }
            });
            fid
        };

        let sync_excludes = game
            .save_paths
            .get(i)
            .map(|e| e.sync_excludes.as_slice())
            .unwrap_or(&[]);

        // 3. Get cloud meta + existing Drive file list
        let (cloud_meta_opt, meta_file_id) = gdrive::download_sync_meta(app, &drive_folder_id)?;
        let cloud_meta = cloud_meta_opt.unwrap_or_default();
        let drive_files = gdrive::list_files(app, &drive_folder_id)?;

        // 4. Collect local files
        let all_local_files = collect_local_files(save_dir)?;
        let local_files: Vec<LocalFileInfo> = all_local_files
            .into_iter()
            .filter(|f| !is_excluded(&f.relative_path, sync_excludes))
            .collect();

        // ── Storage limit guard ────────────────────────────────────────────────
        let projected_this_path = projected_game_cloud_bytes(&local_files, &cloud_meta);
        let projected_total = other_games_bytes + total_cloud_bytes + projected_this_path;
        if projected_total > STORAGE_LIMIT_BYTES {
            return Err(format!(
                "Storage limit exceeded: this push would use {:.1} MB but the 200 MB per-user limit would be reached.",
                projected_total as f64 / 1_048_576.0
            ));
        }
        // ──────────────────────────────────────────────────────────────────────

        let mut uploaded = 0u32;
        let mut skipped = 0u32;
        let mut new_meta = SyncMeta {
            last_synced: Some(chrono::Utc::now().to_rfc3339()),
            files: cloud_meta.files.clone(),
        };

        let meta_lookup: HashMap<&str, &SyncFileEntry> =
            cloud_meta.files.iter().map(|f| (f.path_file.as_str(), f)).collect();

        // 5. Force-upload ALL local files
        for local in &local_files {
            let cloud_entry = meta_lookup.get(local.relative_path.as_str()).copied();
            let file_name = Path::new(&local.relative_path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(&local.relative_path);
            let existing_id = cloud_entry
                .and_then(|e| e.drive_file_id.as_deref())
                .or_else(|| {
                    drive_files
                        .iter()
                        .find(|f| f.name == file_name)
                        .map(|f| f.id.as_str())
                });

            let result =
                gdrive::upload_file(app, &drive_folder_id, &local.absolute_path, existing_id)?;
            new_meta.files.retain(|f| f.path_file != local.relative_path);
            new_meta.files.push(SyncFileEntry {
                path_file: local.relative_path.clone(),
                size: local.size,
                drive_file_id: Some(result.id),
                modified_time: Some(local.modified_iso.clone()),
            });
            uploaded += 1;
        }

        // 6. Cloud-only files are left in Drive (non-destructive)
        for entry in &cloud_meta.files {
            if !local_files.iter().any(|l| l.relative_path == entry.path_file) {
                skipped += 1;
            }
        }

        // 7. Upload updated sync metadata
        gdrive::upload_sync_meta(app, &drive_folder_id, &new_meta, meta_file_id.as_deref())?;
        spawn_sync_meta_mirror(app, game_id, new_meta.clone());

        // 8. Save local tracker from post-push file states
        if !user_id.is_empty() {
            let final_files = collect_local_files(save_dir).unwrap_or_default();
            let updated_tracker = LocalSyncState {
                game_id: game_id.to_string(),
                path_index: i,
                last_updated: chrono::Utc::now().to_rfc3339(),
                files: final_files
                    .into_iter()
                    .filter(|f| !is_excluded(&f.relative_path, sync_excludes))
                    .map(|f| LocalFileRecord {
                        path_file: f.relative_path,
                        size: f.size,
                        modified_time: f.modified_iso,
                    })
                    .collect(),
            };
            if let Err(e) = save_local_tracker(app, &user_id, &updated_tracker) {
                eprintln!("[sync] Failed to save local tracker for {game_id}-p{i}: {e}");
            }
        }

        let cloud_bytes: u64 = new_meta.files.iter().map(|f| f.size).sum();
        total_uploaded += uploaded;
        total_skipped += skipped;
        total_cloud_bytes += cloud_bytes;
    }

    // 8. Update game entry timestamps and cloud storage size
    let now_iso = chrono::Utc::now().to_rfc3339();
    let _ = settings::update_game_field(app, game_id, |g| {
        g.last_cloud_modified = Some(now_iso.clone());
        g.cloud_storage_bytes = Some(total_cloud_bytes);
    });

    Ok(SyncResult {
        game_id: game_id.to_string(),
        uploaded: total_uploaded,
        downloaded: 0,
        skipped: total_skipped,
        error: None,
    })
}

// ── Cleanup excluded files from Cloud ────────────────────

/// Delete files from Google Drive that the user has newly added to `sync_excludes`.
/// Updates `.sync-meta.json` to remove the deleted entries.
/// Called in a background thread from the `update_game` command handler.
/// `drive_folder_id` is the specific Drive folder for the affected save-path entry.
pub fn cleanup_excluded_from_cloud(
    app: &AppHandle,
    game_id: &str,
    drive_folder_id: &str,
    newly_excluded: Vec<String>,
) -> Result<(), String> {
    if newly_excluded.is_empty() {
        return Ok(());
    }

    println!(
        "[sync] Cleaning up {} newly-excluded path(s) from Drive for game {game_id}",
        newly_excluded.len()
    );

    // 1. Download sync metadata
    let (cloud_meta_opt, meta_file_id) = gdrive::download_sync_meta(app, drive_folder_id)?;
    let mut cloud_meta = match cloud_meta_opt {
        Some(m) => m,
        None => {
            println!("[sync] No cloud meta for {game_id} — nothing to clean up");
            return Ok(());
        }
    };

    // 2. For each excluded path, delete its Drive file and remove it from meta
    let keys_to_remove: Vec<String> = cloud_meta
        .files
        .iter()
        .filter(|f| is_excluded(&f.path_file, &newly_excluded))
        .map(|f| f.path_file.clone())
        .collect();

    for rel_path in &keys_to_remove {
        if let Some(file_entry) = cloud_meta.files.iter().find(|f| f.path_file == *rel_path).cloned() {
            if let Some(ref drive_file_id) = file_entry.drive_file_id {
                println!("[sync] Deleting excluded Drive file '{rel_path}' (id={drive_file_id})");
                if let Err(e) = gdrive::delete_drive_file(app, drive_file_id) {
                    eprintln!("[sync] Failed to delete Drive file '{rel_path}': {e}");
                }
            }
        }
        cloud_meta.files.retain(|f| f.path_file != *rel_path);
    }

    // 3. Re-upload updated sync metadata
    gdrive::upload_sync_meta(app, drive_folder_id, &cloud_meta, meta_file_id.as_deref())?;
    spawn_sync_meta_mirror(app, game_id, cloud_meta.clone());

    // 4. Update cloud_storage_bytes to reflect new total
    let new_cloud_bytes: u64 = cloud_meta.files.iter().map(|f| f.size).sum();
    let _ = settings::update_game_field(app, game_id, |g| {
        g.cloud_storage_bytes = Some(new_cloud_bytes);
    });

    println!(
        "[sync] Cleanup complete for {game_id}: removed {} path(s) from Drive",
        keys_to_remove.len()
    );

    Ok(())
}

// ── Firestore mirror helpers ──────────────────────────────────

/// After every successful `upload_sync_meta` to Drive, spawn a background thread
/// to mirror the same data to Firestore. Drive remains the authoritative read
/// source — this is a write-only mirror for future cross-device querying.
fn spawn_sync_meta_mirror(app: &AppHandle, game_id: &str, meta: crate::models::SyncMeta) {
    let game_id = game_id.to_string();
    settings::spawn_firestore_task(app, move |app, user_id| {
        crate::firestore::save_sync_meta(app, user_id, &game_id, &meta)
    });
}

// ── Local tracker I/O ─────────────────────────────────────

/// Build the path for the per-device, per-path tracker file.
/// Format: `{app_data_dir}/local-sync-{user_id}/{game_id}-p{path_index}.json`
fn local_tracker_path(
    app: &AppHandle,
    user_id: &str,
    game_id: &str,
    path_index: usize,
) -> std::path::PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_default()
        .join(format!("local-sync-{user_id}"))
        .join(format!("{game_id}-p{path_index}.json"))
}

/// Load the local tracker for a game path.
/// Returns an empty default when the file does not exist (first sync on this device).
fn load_local_tracker(
    app: &AppHandle,
    user_id: &str,
    game_id: &str,
    path_index: usize,
) -> LocalSyncState {
    let path = local_tracker_path(app, user_id, game_id, path_index);
    match fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_else(|_| LocalSyncState {
            game_id: game_id.to_string(),
            path_index,
            last_updated: String::new(),
            files: Vec::new(),
        }),
        Err(_) => LocalSyncState {
            game_id: game_id.to_string(),
            path_index,
            last_updated: String::new(),
            files: Vec::new(),
        },
    }
}

/// Persist the local tracker for a game path to disk.
fn save_local_tracker(
    app: &AppHandle,
    user_id: &str,
    state: &LocalSyncState,
) -> Result<(), String> {
    let path = local_tracker_path(app, user_id, &state.game_id, state.path_index);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Cannot create tracker directory: {e}"))?;
    }
    let json = serde_json::to_string_pretty(state)
        .map_err(|e| format!("Cannot serialise LocalSyncState: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("Cannot write local tracker: {e}"))?;
    Ok(())
}

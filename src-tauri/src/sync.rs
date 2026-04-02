use std::{
    fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

use crate::{
    gdrive,
    models::{SaveFileInfo, SaveInfo, SyncFileMeta, SyncMeta, SyncResult},
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
    let save_dir = Path::new(save_path);

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
    let save_dir = Path::new(save_path);

    // 2. Ensure Drive folders exist
    let root_folder_id = gdrive::ensure_root_folder(app)?;
    let game_folder_id = gdrive::ensure_game_folder(app, &root_folder_id, game_id)?;

    // 3. Get cloud sync metadata
    let (cloud_meta_opt, meta_file_id) = gdrive::download_sync_meta(app, &game_folder_id)?;
    let cloud_meta = cloud_meta_opt.unwrap_or_default();

    // 4. List existing Drive files (for looking up file IDs)
    let drive_files = gdrive::list_files(app, &game_folder_id)?;

    // 5. Collect local files
    let local_files = collect_local_files(save_dir)?;

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
                gdrive::download_file(app, drive_file_id, &dest)?;

                new_meta.files.insert(
                    local.relative_path.clone(),
                    SyncFileMeta {
                        modified_time: cm.modified_time.clone(),
                        size: cm.size,
                        drive_file_id: Some(drive_file_id.to_string()),
                    },
                );
                downloaded += 1;
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

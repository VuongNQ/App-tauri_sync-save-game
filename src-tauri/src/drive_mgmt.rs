use std::path::Path;

use chrono::SecondsFormat;

use tauri::AppHandle;

use crate::{
    gdrive,
    models::{BackupMeta, DriveFileFlatItem, DriveFileItem, DriveVersionBackup, SyncFileEntry, SyncMeta, SyncResult},
    settings,
};

const BACKUP_FOLDER_NAME: &str = "backups";
const BACKUP_META_NAME: &str = ".backup-meta.json";
const SYNC_META_NAME: &str = ".sync-meta.json";

// ── Helpers ───────────────────────────────────────────────

/// Load a game's cached Drive folder ID or return an error asking the user to sync first.
fn require_game_folder(app: &AppHandle, game_id: &str) -> Result<String, String> {
    let state = settings::load_state(app)?;
    let game = state
        .games
        .iter()
        .find(|g| g.id == game_id)
        .ok_or_else(|| format!("Game not found: {game_id}"))?;
    game.gdrive_folder_id
        .clone()
        .ok_or_else(|| "Sync this game at least once to enable Drive file management".to_string())
}

// ── Drive file management commands ───────────────────────

/// Recursively list every item in the game's Drive folder with relative paths.
/// Files inside subfolders are included; each item's `relative_path` is relative
/// to the game's Drive root folder (e.g. `"76561197960271872/Default_0.sav"`).
/// Each item's `sync_path` is populated from SyncMeta when its Drive file ID
/// matches a tracked entry (e.g. `"76561198241997832/UserMetaData.sav"`).
pub fn list_game_drive_files_flat(
    app: &AppHandle,
    game_id: &str,
) -> Result<Vec<DriveFileFlatItem>, String> {
    let folder_id = require_game_folder(app, game_id)?;
    let mut items = gdrive::list_drive_items_recursive(app, &folder_id, "")?;

    // Build a Drive-file-ID → pathFile lookup from SyncMeta so we can show
    // the real save path (e.g. `76561198241997832/UserMetaData.sav`) for each
    // Drive file, even when multiple files share the same name at root level.
    let id_to_path: std::collections::HashMap<String, String> =
        match gdrive::download_sync_meta(app, &folder_id) {
            Ok((Some(meta), _)) => meta
                .files
                .into_iter()
                .filter_map(|e| e.drive_file_id.map(|id| (id, e.path_file)))
                .collect(),
            _ => std::collections::HashMap::new(),
        };

    for item in &mut items {
        item.sync_path = id_to_path.get(&item.id).cloned();
    }

    Ok(items)
}

/// List all items (files + folders) in the game's Google Drive folder root,
/// or in a specific subfolder when `folder_id` is provided.
pub fn list_game_drive_files(
    app: &AppHandle,
    game_id: &str,
    folder_id: Option<&str>,
) -> Result<Vec<DriveFileItem>, String> {
    let target = match folder_id {
        Some(id) => id.to_string(),
        None => require_game_folder(app, game_id)?,
    };
    gdrive::list_drive_items(app, &target)
}

/// Rename a Drive file (or folder) inside the game's Drive folder.
/// Protected items: `.sync-meta.json` and the `backups` folder cannot be renamed.
/// For regular files, the `.sync-meta.json` key is updated to match the new name.
pub fn rename_game_drive_file(
    app: &AppHandle,
    game_id: &str,
    file_id: &str,
    old_name: &str,
    new_name: &str,
    is_folder: bool,
) -> Result<(), String> {
    if old_name == SYNC_META_NAME || old_name == BACKUP_FOLDER_NAME {
        return Err(format!("Cannot rename protected item '{old_name}'"));
    }
    if new_name.is_empty() || new_name.contains('/') || new_name.contains('\\') {
        return Err("File name cannot be empty or contain path separators".to_string());
    }

    gdrive::rename_drive_item(app, file_id, new_name)?;

    // Update .sync-meta.json key for synced files (not folders).
    if !is_folder {
        let folder_id = require_game_folder(app, game_id)?;
        let (meta_opt, meta_id) = gdrive::download_sync_meta(app, &folder_id)?;
        if let Some(mut meta) = meta_opt {
        if let Some(pos) = meta.files.iter().position(|f| f.path_file == old_name) {
                let mut entry = meta.files.remove(pos);
                entry.path_file = new_name.to_string();
                meta.files.push(entry);
                gdrive::upload_sync_meta(app, &folder_id, &meta, meta_id.as_deref())?;
                spawn_sync_meta_mirror(app, game_id, meta.clone());
                println!("[gdrive] Renamed sync-meta key '{old_name}' → '{new_name}'");
            }
        }
    }

    println!("[gdrive] Renamed Drive item '{old_name}' → '{new_name}' for game {game_id}");
    Ok(())
}

/// Move a Drive file to a different subfolder within the game's Drive folder.
/// The `new_parent_id` must be either the game folder root or a direct subfolder of it.
/// Moving a file OUT of the root removes its `.sync-meta.json` entry (sync no longer manages it).
/// Moving a file INTO the root: sync will detect it on next sync as a cloud-only file.
pub fn move_game_drive_file(
    app: &AppHandle,
    game_id: &str,
    file_id: &str,
    file_name: &str,
    new_parent_id: &str,
    old_parent_id: &str,
) -> Result<(), String> {
    if file_name == SYNC_META_NAME {
        return Err("Cannot move '.sync-meta.json'".to_string());
    }
    if file_name == BACKUP_FOLDER_NAME {
        return Err("Cannot move the 'backups' folder".to_string());
    }

    let game_folder_id = require_game_folder(app, game_id)?;

    // Validate new_parent_id: must be the game root or one of its direct subfolders.
    if new_parent_id != game_folder_id {
        let root_items = gdrive::list_drive_items(app, &game_folder_id)?;
        let is_valid = root_items
            .iter()
            .any(|item| item.is_folder && item.id == new_parent_id);
        if !is_valid {
            return Err(
                "Target folder must be the game's Drive root or a direct subfolder of it"
                    .to_string(),
            );
        }
    }

    gdrive::move_drive_file(app, file_id, new_parent_id, old_parent_id)?;

    // If moving away from the root, remove the entry from .sync-meta.json so the local
    // copy (original path) can be re-uploaded on next sync instead of being orphaned.
    if old_parent_id == game_folder_id && new_parent_id != game_folder_id {
        let (meta_opt, meta_id) = gdrive::download_sync_meta(app, &game_folder_id)?;
        if let Some(mut meta) = meta_opt {
            let before = meta.files.len();
            meta.files.retain(|f| f.path_file != file_name);
            if meta.files.len() < before {
                gdrive::upload_sync_meta(app, &game_folder_id, &meta, meta_id.as_deref())?;
                spawn_sync_meta_mirror(app, game_id, meta.clone());
                println!("[gdrive] Removed '{file_name}' from sync-meta after move");
            }
        }
    }

    println!("[gdrive] Moved Drive file '{file_name}' to {new_parent_id} (game: {game_id})");
    Ok(())
}

/// Delete a Drive file (or folder) from the game's Drive folder.
/// Protected items: `.sync-meta.json` and the `backups` folder cannot be deleted.
/// For regular files, the `.sync-meta.json` entry is removed so the next sync
/// does not re-download the file.
pub fn delete_game_drive_file(
    app: &AppHandle,
    game_id: &str,
    file_id: &str,
    file_name: &str,
    is_folder: bool,
) -> Result<(), String> {
    if file_name == SYNC_META_NAME {
        return Err("Cannot delete '.sync-meta.json'".to_string());
    }
    if file_name == BACKUP_FOLDER_NAME {
        return Err(
            "Cannot delete the whole backups folder — delete individual backups instead"
                .to_string(),
        );
    }

    gdrive::delete_drive_file(app, file_id)?;

    // Remove from .sync-meta.json so next sync doesn't re-download the file.
    if !is_folder {
        let folder_id = require_game_folder(app, game_id)?;
        let (meta_opt, meta_id) = gdrive::download_sync_meta(app, &folder_id)?;
        if let Some(mut meta) = meta_opt {
            let before = meta.files.len();
            meta.files.retain(|f| f.path_file != file_name);
            if meta.files.len() < before {
                gdrive::upload_sync_meta(app, &folder_id, &meta, meta_id.as_deref())?;
                spawn_sync_meta_mirror(app, game_id, meta.clone());
                println!("[gdrive] Removed '{file_name}' from sync-meta after delete");
            }
        }
    }

    println!("[gdrive] Deleted Drive item '{file_name}' for game {game_id}");
    Ok(())
}

// ── Version backup commands ───────────────────────────────

/// Create a manual version backup: server-side copy all current save files to a
/// timestamped subfolder inside `backups/` under the game's Drive folder.
/// Returns the new `DriveVersionBackup` descriptor.
pub fn create_version_backup(
    app: &AppHandle,
    game_id: &str,
    label: Option<String>,
) -> Result<DriveVersionBackup, String> {
    let game_folder_id = require_game_folder(app, game_id)?;

    // 1. Ensure backups/ subfolder exists.
    let backups_folder_id = gdrive::ensure_subfolder(app, &game_folder_id, BACKUP_FOLDER_NAME)?;

    // 2. Build backup folder name: ISO timestamp (+ optional label).
    let now_iso = chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let backup_folder_name = match label.as_deref() {
        Some(l) if !l.trim().is_empty() => format!("{now_iso} — {}", l.trim()),
        _ => now_iso.clone(),
    };

    // 3. Create timestamped backup subfolder (always unique because of ISO timestamp).
    let backup_folder_id =
        gdrive::ensure_subfolder(app, &backups_folder_id, &backup_folder_name)?;

    // 4. List root files in the game folder (exclude .sync-meta.json and folders).
    let root_items = gdrive::list_drive_items(app, &game_folder_id)?;
    let files_to_copy: Vec<&DriveFileItem> = root_items
        .iter()
        .filter(|f| !f.is_folder && f.name != SYNC_META_NAME)
        .collect();

    // 5. Server-side copy each file into the backup folder.
    let total_files = files_to_copy.len() as u32;
    let mut total_size: u64 = 0;

    for file_item in &files_to_copy {
        let copied = gdrive::copy_drive_file(app, &file_item.id, &backup_folder_id)?;
        total_size += copied.size.unwrap_or(0);
        println!("[gdrive] Backup: copied '{}' to {backup_folder_id}", file_item.name);
    }

    // 6. Write .backup-meta.json into the backup folder.
    let backup_meta = BackupMeta {
        created_time: now_iso.clone(),
        label: label.map(|l| l.trim().to_string()).filter(|l| !l.is_empty()),
        total_files,
        total_size,
    };
    let meta_bytes = serde_json::to_vec_pretty(&backup_meta)
        .map_err(|e| format!("Cannot serialize BackupMeta: {e}"))?;
    gdrive::upload_json_to_folder(app, &backup_folder_id, BACKUP_META_NAME, &meta_bytes, None)?;

    println!(
        "[gdrive] Version backup '{backup_folder_name}' created for game {game_id} ({total_files} files)"
    );

    Ok(DriveVersionBackup {
        id: backup_folder_id,
        name: backup_folder_name,
        created_time: now_iso,
        total_files,
        total_size,
    })
}

/// List all version backups for a game, sorted newest-first.
pub fn list_version_backups(
    app: &AppHandle,
    game_id: &str,
) -> Result<Vec<DriveVersionBackup>, String> {
    let game_folder_id = require_game_folder(app, game_id)?;

    // Find the backups/ folder — return empty list if it doesn't exist yet.
    let root_items = gdrive::list_drive_items(app, &game_folder_id)?;
    let backups_folder = match root_items
        .iter()
        .find(|f| f.is_folder && f.name == BACKUP_FOLDER_NAME)
    {
        Some(f) => f.id.clone(),
        None => return Ok(vec![]),
    };

    // Each subfolder of backups/ is one snapshot.
    let snapshot_folders = gdrive::list_drive_items(app, &backups_folder)?;
    let mut backups: Vec<DriveVersionBackup> = Vec::new();

    for folder in snapshot_folders.iter().filter(|f| f.is_folder) {
        let snapshot_items = gdrive::list_drive_items(app, &folder.id)?;
        let meta_file = snapshot_items
            .iter()
            .find(|f| !f.is_folder && f.name == BACKUP_META_NAME);

        if let Some(meta_file) = meta_file {
            match gdrive::download_json_from_drive(app, &meta_file.id) {
                Ok(json) => match serde_json::from_str::<BackupMeta>(&json) {
                    Ok(meta) => backups.push(DriveVersionBackup {
                        id: folder.id.clone(),
                        name: folder.name.clone(),
                        created_time: meta.created_time,
                        total_files: meta.total_files,
                        total_size: meta.total_size,
                    }),
                    Err(e) => eprintln!(
                        "[gdrive] Failed to parse backup meta for '{}': {e}",
                        folder.name
                    ),
                },
                Err(e) => eprintln!(
                    "[gdrive] Failed to download backup meta for '{}': {e}",
                    folder.name
                ),
            }
        }
    }

    // Newest first.
    backups.sort_by(|a, b| b.created_time.cmp(&a.created_time));
    Ok(backups)
}

/// Restore a version backup: server-side copy all backup files to the game's Drive root,
/// then download them to the local save path.
/// Existing files with the same name are replaced (deleted first, then copied).
/// Returns a `SyncResult` with the download count.
pub fn restore_version_backup(
    app: &AppHandle,
    game_id: &str,
    backup_folder_id: &str,
) -> Result<SyncResult, String> {
    let state = settings::load_state(app)?;
    let game = state
        .games
        .iter()
        .find(|g| g.id == game_id)
        .ok_or_else(|| format!("Game not found: {game_id}"))?
        .clone();

    let game_folder_id = game
        .gdrive_folder_id
        .as_deref()
        .ok_or("Game has no Drive folder")?
        .to_string();

    let save_path = game.save_path.as_deref().ok_or("Game has no save path")?;
    let expanded = settings::expand_env_vars(save_path);
    let save_dir = Path::new(&expanded);

    // Snapshot files (excluding .backup-meta.json).
    let backup_items = gdrive::list_drive_items(app, backup_folder_id)?;
    let backup_files: Vec<&DriveFileItem> = backup_items
        .iter()
        .filter(|f| !f.is_folder && f.name != BACKUP_META_NAME)
        .collect();

    // Current root items (for replacing duplicates).
    let root_items = gdrive::list_drive_items(app, &game_folder_id)?;

    let mut downloaded: u32 = 0;

    for backup_file in &backup_files {
        // Delete any existing file with the same name from the game folder root.
        if let Some(existing) = root_items
            .iter()
            .find(|f| !f.is_folder && f.name == backup_file.name)
        {
            gdrive::delete_drive_file(app, &existing.id)?;
        }

        // Server-side copy backup file → game root on Drive.
        gdrive::copy_drive_file(app, &backup_file.id, &game_folder_id)?;

        // Download backup file → local save folder.
        let local_dest = save_dir.join(&backup_file.name);
        if let Some(parent) = local_dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Cannot create directory: {e}"))?;
        }
        // Download from the backup file directly (same bytes as the copy).
        gdrive::download_file(app, &backup_file.id, &local_dest)?;
        downloaded += 1;
    }

    // Rebuild .sync-meta.json from the updated game folder root.
    let now_iso = chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let updated_root = gdrive::list_drive_items(app, &game_folder_id)?;
    let mut new_sync_meta = SyncMeta {
        last_synced: Some(now_iso.clone()),
        files: Vec::new(),
    };
    for item in updated_root.iter().filter(|f| !f.is_folder && f.name != SYNC_META_NAME) {
        new_sync_meta.files.push(SyncFileEntry {
            path_file: item.name.clone(),
            size: item.size.unwrap_or(0),
            drive_file_id: Some(item.id.clone()),
        });
    }
    let (_, meta_id) = gdrive::download_sync_meta(app, &game_folder_id)?;
    gdrive::upload_sync_meta(app, &game_folder_id, &new_sync_meta, meta_id.as_deref())?;
    spawn_sync_meta_mirror(app, game_id, new_sync_meta.clone());

    // Update game timestamps.
    settings::update_game_field(app, game_id, |g| {
        g.last_cloud_modified = Some(now_iso.clone());
    })?;

    println!(
        "[gdrive] Restored backup {backup_folder_id} for game {game_id}: {downloaded} file(s)"
    );

    Ok(SyncResult {
        game_id: game_id.to_string(),
        uploaded: 0,
        downloaded,
        skipped: 0,
        error: None,
    })
}

/// Delete a version backup folder (and all its files) from Drive.
/// Validates that `backup_folder_id` belongs to the game's `backups/` subfolder.
pub fn delete_version_backup(
    app: &AppHandle,
    game_id: &str,
    backup_folder_id: &str,
) -> Result<(), String> {
    let game_folder_id = require_game_folder(app, game_id)?;

    // Find backups/ folder under the game folder.
    let root_items = gdrive::list_drive_items(app, &game_folder_id)?;
    let backups_folder_id = root_items
        .iter()
        .find(|f| f.is_folder && f.name == BACKUP_FOLDER_NAME)
        .map(|f| f.id.clone())
        .ok_or("No backups folder found for this game")?;

    // Verify backup_folder_id is a direct child of backups/.
    let backup_children = gdrive::list_drive_items(app, &backups_folder_id)?;
    let is_valid = backup_children
        .iter()
        .any(|f| f.is_folder && f.id == backup_folder_id);
    if !is_valid {
        return Err("Backup not found or does not belong to this game".to_string());
    }

    // Delete all files inside the backup folder, then the folder itself.
    let snapshot_items = gdrive::list_drive_items(app, backup_folder_id)?;
    for file in snapshot_items.iter().filter(|f| !f.is_folder) {
        gdrive::delete_drive_file(app, &file.id)?;
    }
    gdrive::delete_drive_file(app, backup_folder_id)?;

    println!("[gdrive] Deleted backup {backup_folder_id} for game {game_id}");
    Ok(())
}

// ── Firestore mirror helpers ──────────────────────────────────

/// After every successful `upload_sync_meta` to Drive, spawn a background thread
/// to mirror the same data to Firestore. Drive remains the authoritative read
/// source — this is a write-only mirror for future cross-device querying.
fn spawn_sync_meta_mirror(app: &AppHandle, game_id: &str, meta: SyncMeta) {
    let app = app.clone();
    let game_id = game_id.to_string();
    std::thread::spawn(move || {
        if let Some(user_id) = crate::gdrive_auth::get_current_user_id(&app) {
            if let Err(e) = crate::firestore::save_sync_meta(&app, &user_id, &game_id, &meta) {
                eprintln!("[firestore] SyncMeta mirror failed for '{game_id}': {e}");
            }
        }
    });
}

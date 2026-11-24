//! Public sync entry points. Every direction uses the same versioned engine.
use crate::{
    models::{
        CloudState, CloudStatus, PathSaveInfo, SaveFileInfo, SaveInfo, SyncResult,
        SyncStructureDiff,
    },
    settings,
    sync_v2::Mode,
};
use std::{
    collections::HashMap,
    fs,
    path::Path,
    sync::{Mutex, OnceLock},
};
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;
struct LocalFileInfo {
    relative_path: String,
    modified_iso: String,
    size: u64,
}
/// Collect all files under `save_path` with their metadata.
fn collect_local_files(save_path: &Path) -> Result<Vec<LocalFileInfo>, String> {
    if !save_path.exists() {
        return Err(format!("Save path does not exist: {}", save_path.display()));
    }

    let mut files = Vec::new();
    for entry in WalkDir::new(save_path) {
        let entry = entry.map_err(|e| format!("Cannot scan all save files: {e}"))?;
        if !entry.file_type().is_file()
            || entry
                .file_name()
                .to_string_lossy()
                .starts_with(crate::safe_files::TEMP_PREFIX)
        {
            continue;
        }
        let abs = entry.path().to_path_buf();
        let rel = abs
            .strip_prefix(save_path)
            .map_err(|e| format!("Strip prefix error: {e}"))?
            .to_string_lossy()
            // Normalize to forward slashes for cross-platform Drive storage
            .replace('\\', "/");

        let meta = fs::metadata(&abs).map_err(|e| format!("Cannot stat {}: {e}", abs.display()))?;

        let modified = meta
            .modified()
            .map_err(|e| format!("Cannot get modified time: {e}"))?;
        let modified_iso = chrono::DateTime::<chrono::Utc>::from(modified).to_rfc3339();

        files.push(LocalFileInfo {
            relative_path: rel,
            modified_iso,
            size: meta.len(),
        });
    }

    Ok(files)
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
    let path_infos_out = if path_infos.len() > 1 {
        path_infos
    } else {
        vec![]
    };

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

fn run(app: &AppHandle, game_id: &str, mode: Mode) -> Result<SyncResult, String> {
    let _ = app.emit("sync-started", game_id);
    let result = crate::cross_device::execute(app, game_id, mode);
    match &result {
        Ok(value) => {
            set_cloud_state(game_id, CloudState::UpToDate);
            let _ = app.emit("sync-completed", value);
            schedule_storage_cleanup(app, game_id);
        }
        Err(error) => {
            let _ = app.emit(
                "sync-error",
                &SyncResult {
                    game_id: game_id.into(),
                    uploaded: 0,
                    downloaded: 0,
                    skipped: 0,
                    error: Some(error.clone()),
                },
            );
        }
    }
    result
}
/// Reclaim old Drive objects in the background, at most once per interval per
/// game. Waits for the caller's operation to finish and skips if the game is
/// running or another save operation holds the game.
fn schedule_storage_cleanup(app: &AppHandle, game_id: &str) {
    let app = app.clone();
    let game_id = game_id.to_owned();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(30));
        let Ok(_operation) = crate::game_operations::acquire(&game_id) else {
            return;
        };
        if let Err(e) = crate::cross_device::collect_garbage_if_due(&app, &game_id) {
            eprintln!("[sync-v2] Background cleanup skipped for {game_id}: {e}");
        }
    });
}

pub fn cleanup_drive_history(
    app: &AppHandle,
    game_id: &str,
) -> Result<crate::models::DriveCleanupReport, String> {
    let _operation = crate::game_operations::acquire(game_id)?;
    crate::cross_device::collect_garbage(app, game_id)
}

pub fn sync_game(app: &AppHandle, game_id: &str) -> Result<SyncResult, String> {
    let _operation = crate::game_operations::acquire(game_id)?;
    sync_game_locked(app, game_id)
}
pub(crate) fn sync_game_locked(app: &AppHandle, game_id: &str) -> Result<SyncResult, String> {
    run(app, game_id, Mode::Merge)
}
pub fn push_to_cloud(app: &AppHandle, game_id: &str) -> Result<SyncResult, String> {
    let _operation = crate::game_operations::acquire(game_id)?;
    run(app, game_id, Mode::Push)
}
pub fn restore_from_cloud(app: &AppHandle, game_id: &str) -> Result<SyncResult, String> {
    let _operation = crate::game_operations::acquire(game_id)?;
    run(app, game_id, Mode::Restore)
}
pub fn check_sync_structure_diff(
    app: &AppHandle,
    game_id: &str,
) -> Result<SyncStructureDiff, String> {
    let _operation = crate::game_operations::acquire(game_id)?;
    crate::cross_device::diff(app, game_id)
}
pub fn sync_all_games(app: &AppHandle) -> Result<Vec<SyncResult>, String> {
    let _session = crate::session::current(app)?;
    let state = settings::load_state(app)?;
    Ok(state
        .games
        .iter()
        .filter(|g| !g.save_paths.is_empty())
        .map(|g| {
            sync_game(app, &g.id).unwrap_or_else(|e| SyncResult {
                game_id: g.id.clone(),
                uploaded: 0,
                downloaded: 0,
                skipped: 0,
                error: Some(e),
            })
        })
        .collect())
}
// ── Startup cloud check ───────────────────────────────────

/// Latest known cloud state per game for this app run (not persisted).
fn cloud_states() -> &'static Mutex<HashMap<String, CloudState>> {
    static STATES: OnceLock<Mutex<HashMap<String, CloudState>>> = OnceLock::new();
    STATES.get_or_init(Default::default)
}

fn set_cloud_state(game_id: &str, state: CloudState) {
    if let Ok(mut map) = cloud_states().lock() {
        map.insert(game_id.to_owned(), state);
    }
}

pub fn cloud_statuses() -> Vec<CloudStatus> {
    cloud_states()
        .lock()
        .map(|map| {
            map.iter()
                .map(|(game_id, state)| CloudStatus {
                    game_id: game_id.clone(),
                    state: *state,
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Account switched: forget the previous account's states.
pub fn clear_cloud_statuses() {
    if let Ok(mut map) = cloud_states().lock() {
        map.clear();
    }
}

/// Check every game once, one at a time, and fast-forward safe ones when allowed.
/// Busy or running games are skipped; their own sync paths still cover them.
pub fn startup_check_all(app: &AppHandle) {
    let Ok(state) = settings::load_state(app) else {
        return;
    };
    let on_battery = crate::power::on_battery();
    let auto_pull = state.settings.auto_pull_on_startup && !on_battery;
    if state.settings.auto_pull_on_startup && on_battery {
        println!("[startup-check] On battery: checking only, not pulling");
    }
    for game in state.games.iter().filter(|g| !g.save_paths.is_empty()) {
        let Ok(_operation) = crate::game_operations::acquire(&game.id) else {
            continue;
        };
        let outcome = crate::cross_device::startup_check(app, &game.id, auto_pull);
        match outcome {
            Ok((cloud_state, result)) => {
                println!("[startup-check] {}: {:?}", game.id, cloud_state);
                set_cloud_state(&game.id, cloud_state);
                if let Some(result) = result {
                    let _ = app.emit("sync-completed", &result);
                }
            }
            Err(e) => {
                eprintln!("[startup-check] {} skipped: {e}", game.id);
            }
        }
    }
    let _ = app.emit("cloud-status-changed", cloud_statuses());
}

pub fn clean_not_included_from_cloud_all_paths(
    app: &AppHandle,
    game_id: &str,
) -> Result<u32, String> {
    let _operation = crate::game_operations::acquire(game_id)?;
    crate::cross_device::clean_excluded(app, game_id)
}

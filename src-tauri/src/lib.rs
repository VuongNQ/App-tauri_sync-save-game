mod drive_mgmt;
mod firestore;
mod gdrive;
mod gdrive_auth;
mod models;
mod settings;
mod sync;
mod tray;
mod watcher;

use std::sync::{Arc, Mutex};

use tauri::Manager;

use models::{
    AddGamePayload, AppSettings, AuthStatus, DashboardData, DriveFileFlatItem, DriveFileItem,
    DriveVersionBackup, GoogleUserInfo, OAuthCredentials, PathValidation, SaveInfo,
    SaveTokensPayload, SyncResult, SyncStructureDiff, UpdateGamePayload,
};

#[tauri::command]
fn load_dashboard(app: tauri::AppHandle) -> Result<DashboardData, String> {
    let mut state = settings::load_state(&app)?;
    // Populate last_local_modified dynamically by scanning local save folders.
    for game in state.games.iter_mut() {
        if let Some(ref save_path) = game.save_path.clone() {
            let expanded = settings::expand_env_vars(save_path);
            game.last_local_modified =
                sync::scan_last_modified(std::path::Path::new(&expanded));
        }
    }
    Ok(DashboardData { games: state.games })
}

#[tauri::command]
fn add_manual_game(
    app: tauri::AppHandle,
    payload: AddGamePayload,
) -> Result<DashboardData, String> {
    settings::add_manual_game(&app, payload)?;
    let state = settings::load_state(&app)?;
    Ok(DashboardData { games: state.games })
}

#[tauri::command]
fn update_game(
    app: tauri::AppHandle,
    payload: UpdateGamePayload,
) -> Result<DashboardData, String> {
    // Capture old game state before updating so we can diff.
    let old_game = settings::load_state(&app)
        .ok()
        .and_then(|s| s.games.into_iter().find(|g| g.id == payload.game.id));

    let old_excludes: Vec<String> = old_game.as_ref()
        .map(|g| g.sync_excludes.clone())
        .unwrap_or_default();
    let old_track_changes = old_game.map(|g| g.track_changes).unwrap_or(false);

    let new_excludes = payload.game.sync_excludes.clone();
    let new_track_changes = payload.game.track_changes;
    let game_id = payload.game.id.clone();
    let gdrive_folder_id = payload.game.gdrive_folder_id.clone();

    settings::upsert_game(&app, payload.game)?;

    // If track_changes toggled, start or stop the watcher immediately for this session.
    if new_track_changes != old_track_changes {
        if let Err(e) = watcher::handle_track_changes_toggle(&app, &game_id, new_track_changes) {
            eprintln!("[watcher] handle_track_changes_toggle failed in update_game: {e}");
        }
    }

    // If any paths were newly excluded, delete them from Drive in the background.
    let newly_excluded: Vec<String> = new_excludes
        .into_iter()
        .filter(|e| !old_excludes.contains(e))
        .collect();

    if !newly_excluded.is_empty() && gdrive_folder_id.is_some() {
        let app_clone = app.clone();
        std::thread::spawn(move || {
            if let Err(e) = sync::cleanup_excluded_from_cloud(&app_clone, &game_id, newly_excluded) {
                eprintln!("[sync] cleanup excluded from cloud failed: {e}");
            }
        });
    }

    let state = settings::load_state(&app)?;
    Ok(DashboardData { games: state.games })
}

#[tauri::command]
fn remove_game(app: tauri::AppHandle, game_id: String) -> Result<DashboardData, String> {
    // Capture the Drive folder ID before removing from local state.
    let drive_folder_id = settings::load_state(&app)
        .ok()
        .and_then(|s| s.games.into_iter().find(|g| g.id == game_id))
        .and_then(|g| g.gdrive_folder_id);

    settings::remove_game(&app, &game_id)?;

    // Delete the game's Drive folder (and all saves inside it) in the background.
    if let Some(folder_id) = drive_folder_id {
        let app_clone = app.clone();
        std::thread::spawn(move || {
            match gdrive::delete_drive_file(&app_clone, &folder_id) {
                Ok(_) => println!("[gdrive] Deleted Drive folder for removed game: {folder_id}"),
                Err(e) => eprintln!("[gdrive] Failed to delete Drive folder {folder_id}: {e}"),
            }
        });
    }

    let state = settings::load_state(&app)?;
    Ok(DashboardData { games: state.games })
}

#[tauri::command]
fn clear_all_drive_data(app: tauri::AppHandle) -> Result<DashboardData, String> {
    // Delete the entire game-processing-sync root folder on Drive.
    let root_folder_id = gdrive::ensure_root_folder(&app)?;
    gdrive::delete_drive_file(&app, &root_folder_id)?;

    // Clear all cloud metadata from every game in local state.
    let mut state = settings::load_state(&app)?;

    // Also delete all Firestore game documents so the cloud slate is fully clean.
    if let Some(user_id) = crate::gdrive_auth::get_current_user_id(&app) {
        for game in &state.games {
            if let Err(e) = firestore::delete_game(&app, &user_id, &game.id) {
                eprintln!("[firestore] clear_all_drive_data: delete game '{}' failed: {e}", game.id);
            }
        }
    }

    for game in state.games.iter_mut() {
        game.gdrive_folder_id = None;
        game.cloud_storage_bytes = None;
        game.last_cloud_modified = None;
    }
    state.last_cloud_library_modified = None;
    settings::save_state(&app, &state)?;

    println!("[gdrive] Cleared all Drive data for current account");
    Ok(DashboardData { games: state.games })
}

#[tauri::command]
fn check_auth_status(app: tauri::AppHandle) -> Result<AuthStatus, String> {
    gdrive_auth::check_auth_status(&app)
}

/// Receive tokens from the frontend after tauri-plugin-google-auth sign-in.
#[tauri::command]
fn save_auth_tokens(
    app: tauri::AppHandle,
    payload: SaveTokensPayload,
) -> Result<AuthStatus, String> {
    let status = gdrive_auth::save_tokens_from_plugin(&app, payload)?;

    // After every login: restore library + settings from Firestore (with Drive migration
    // fallback), then sync all save files.
    let app_clone = app.clone();
    std::thread::spawn(move || {
        let mut library_changed = false;

        match settings::fetch_all_from_firestore(&app_clone) {
            Ok(true) => {
                println!("[firestore] Post-login: library + settings restored");
                library_changed = true;
                let _ = tauri::Emitter::emit(&app_clone, "library-restored", ());
            }
            Ok(false) => println!("[firestore] Post-login: no data in Firestore yet"),
            Err(e) => eprintln!("[firestore] Post-login restore failed: {e}"),
        }

        // Sync all game saves from Drive (picks up cloud-side changes).
        match sync::sync_all_games(&app_clone) {
            Ok(results) => {
                let downloaded: u32 = results.iter().map(|r| r.downloaded).sum();
                let uploaded: u32 = results.iter().map(|r| r.uploaded).sum();
                println!(
                    "[sync] Post-login sync done — {} games, {} downloaded, {} uploaded",
                    results.len(),
                    downloaded,
                    uploaded
                );
                let _ = tauri::Emitter::emit(&app_clone, "post-login-sync-completed", ());
            }
            Err(e) => {
                eprintln!("[sync] Post-login sync_all_games failed: {e}");
                let _ = tauri::Emitter::emit(&app_clone, "post-login-sync-completed", ());
            }
        }

        let _ = library_changed; // suppress unused warning when library was already up-to-date
    });

    Ok(status)
}

/// Return OAuth client credentials so the frontend can pass them to the plugin.
#[tauri::command]
fn get_oauth_credentials() -> Result<OAuthCredentials, String> {
    let client_id = gdrive_auth::get_client_id()?;
    let client_secret = gdrive_auth::get_client_secret();
    Ok(OAuthCredentials {
        client_id,
        client_secret,
    })
}

#[tauri::command]
fn logout(app: tauri::AppHandle) -> Result<AuthStatus, String> {
    gdrive_auth::logout(&app)
}

#[tauri::command]
fn get_google_user_info(app: tauri::AppHandle) -> Result<GoogleUserInfo, String> {
    gdrive_auth::get_google_user_info(&app)
}

// ── Settings commands ─────────────────────────────────────

#[tauri::command]
fn get_settings(app: tauri::AppHandle) -> Result<AppSettings, String> {
    settings::get_settings(&app)
}

#[tauri::command]
fn update_settings(app: tauri::AppHandle, settings: AppSettings) -> Result<AppSettings, String> {
    settings::update_settings(&app, settings)
}

// ── Path validation commands ──────────────────────────────

#[tauri::command]
fn expand_save_path(path: String) -> String {
    settings::expand_env_vars(&path)
}

/// Replace absolute path prefixes with portable env-var tokens (e.g. `%PROGRAMFILES%\...`).
/// Mirrors the server-side `contract_env_vars` used on save, so the frontend can show
/// the portable form immediately after a file-picker selection.
#[tauri::command]
fn contract_path(path: String) -> String {
    settings::contract_path(&path)
}

#[tauri::command]
fn validate_save_paths(app: tauri::AppHandle) -> Result<Vec<PathValidation>, String> {
    settings::validate_save_paths(&app)
}

#[tauri::command]
fn get_browse_default_path(app: tauri::AppHandle) -> Result<Option<String>, String> {
    settings::get_browse_default_path(&app)
}

// ── Save info commands ─────────────────────────────────────

#[tauri::command]
fn get_save_info(app: tauri::AppHandle, game_id: String) -> Result<SaveInfo, String> {
    sync::get_save_info(&app, &game_id)
}

// ── Sync commands ─────────────────────────────────────────

/// Validate a game logo (file ≤ 3 MB; URL download ≤ 3 MB) and upload it to the
/// game's Google Drive folder as `logo.<ext>`.
#[tauri::command]
async fn upload_game_logo(
    app: tauri::AppHandle,
    game_id: String,
    logo_source: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || gdrive::upload_game_logo(&app, &game_id, &logo_source))
        .await
        .map_err(|e| format!("Logo upload task failed: {e}"))?
}

// ── Drive file management commands ────────────────────────

#[tauri::command]
async fn list_game_drive_files_flat(
    app: tauri::AppHandle,
    game_id: String,
) -> Result<Vec<DriveFileFlatItem>, String> {
    tokio::task::spawn_blocking(move || drive_mgmt::list_game_drive_files_flat(&app, &game_id))
        .await
        .map_err(|e| format!("List flat drive files task failed: {e}"))?
}

#[tauri::command]
async fn list_game_drive_files(
    app: tauri::AppHandle,
    game_id: String,
    folder_id: Option<String>,
) -> Result<Vec<DriveFileItem>, String> {
    tokio::task::spawn_blocking(move || {
        drive_mgmt::list_game_drive_files(&app, &game_id, folder_id.as_deref())
    })
    .await
    .map_err(|e| format!("List drive files task failed: {e}"))?
}

#[tauri::command]
async fn rename_game_drive_file(
    app: tauri::AppHandle,
    game_id: String,
    file_id: String,
    old_name: String,
    new_name: String,
    is_folder: bool,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        drive_mgmt::rename_game_drive_file(&app, &game_id, &file_id, &old_name, &new_name, is_folder)
    })
    .await
    .map_err(|e| format!("Rename task failed: {e}"))?
}

#[tauri::command]
async fn move_game_drive_file(
    app: tauri::AppHandle,
    game_id: String,
    file_id: String,
    file_name: String,
    new_parent_id: String,
    old_parent_id: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        drive_mgmt::move_game_drive_file(
            &app,
            &game_id,
            &file_id,
            &file_name,
            &new_parent_id,
            &old_parent_id,
        )
    })
    .await
    .map_err(|e| format!("Move task failed: {e}"))?
}

#[tauri::command]
async fn delete_game_drive_file(
    app: tauri::AppHandle,
    game_id: String,
    file_id: String,
    file_name: String,
    is_folder: bool,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        drive_mgmt::delete_game_drive_file(&app, &game_id, &file_id, &file_name, is_folder)
    })
    .await
    .map_err(|e| format!("Delete task failed: {e}"))?
}

#[tauri::command]
async fn create_version_backup(
    app: tauri::AppHandle,
    game_id: String,
    label: Option<String>,
) -> Result<DriveVersionBackup, String> {
    tokio::task::spawn_blocking(move || drive_mgmt::create_version_backup(&app, &game_id, label))
        .await
        .map_err(|e| format!("Create backup task failed: {e}"))?
}

#[tauri::command]
async fn list_version_backups(
    app: tauri::AppHandle,
    game_id: String,
) -> Result<Vec<DriveVersionBackup>, String> {
    tokio::task::spawn_blocking(move || drive_mgmt::list_version_backups(&app, &game_id))
        .await
        .map_err(|e| format!("List backups task failed: {e}"))?
}

#[tauri::command]
async fn restore_version_backup(
    app: tauri::AppHandle,
    game_id: String,
    backup_folder_id: String,
) -> Result<SyncResult, String> {
    tokio::task::spawn_blocking(move || {
        drive_mgmt::restore_version_backup(&app, &game_id, &backup_folder_id)
    })
    .await
    .map_err(|e| format!("Restore backup task failed: {e}"))?
}

#[tauri::command]
async fn delete_version_backup(
    app: tauri::AppHandle,
    game_id: String,
    backup_folder_id: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        drive_mgmt::delete_version_backup(&app, &game_id, &backup_folder_id)
    })
    .await
    .map_err(|e| format!("Delete backup task failed: {e}"))?
}

#[tauri::command]
async fn sync_game(app: tauri::AppHandle, game_id: String) -> Result<SyncResult, String> {
    tokio::task::spawn_blocking(move || sync::sync_game(&app, &game_id))
        .await
        .map_err(|e| format!("Sync task failed: {e}"))?
}

#[tauri::command]
async fn sync_all_games(app: tauri::AppHandle) -> Result<Vec<SyncResult>, String> {
    tokio::task::spawn_blocking(move || sync::sync_all_games(&app))
        .await
        .map_err(|e| format!("Sync all task failed: {e}"))?
}

#[tauri::command]
async fn sync_library_from_cloud(app: tauri::AppHandle) -> Result<DashboardData, String> {
    tokio::task::spawn_blocking(move || {
        settings::fetch_all_from_firestore(&app)?;
        let state = settings::load_state(&app)?;
        Ok(DashboardData { games: state.games })
    })
    .await
    .map_err(|e| format!("Library sync from cloud task failed: {e}"))?
}

#[tauri::command]
async fn check_sync_structure_diff(
    app: tauri::AppHandle,
    game_id: String,
) -> Result<SyncStructureDiff, String> {
    tokio::task::spawn_blocking(move || sync::check_sync_structure_diff(&app, &game_id))
        .await
        .map_err(|e| format!("Diff check task failed: {e}"))?
}

#[tauri::command]
async fn restore_from_cloud(
    app: tauri::AppHandle,
    game_id: String,
) -> Result<SyncResult, String> {
    tokio::task::spawn_blocking(move || sync::restore_from_cloud(&app, &game_id))
        .await
        .map_err(|e| format!("Restore task failed: {e}"))?
}

#[tauri::command]
async fn push_to_cloud(
    app: tauri::AppHandle,
    game_id: String,
) -> Result<SyncResult, String> {
    tokio::task::spawn_blocking(move || sync::push_to_cloud(&app, &game_id))
        .await
        .map_err(|e| format!("Push task failed: {e}"))?
}

// ── Launcher command ──────────────────────────────────────

#[tauri::command]
fn launch_game(app: tauri::AppHandle, game_id: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    let state = settings::load_state(&app)?;
    let game = state
        .games
        .iter()
        .find(|g| g.id == game_id)
        .ok_or_else(|| format!("Game not found: {game_id}"))?;

    let raw_path = game
        .exe_path
        .as_deref()
        .ok_or_else(|| "No executable path configured for this game.".to_string())?;

    let full_path = settings::expand_env_vars(raw_path);

    println!("[launcher] Launching '{}' at: {}", game.name, full_path);

    app.opener()
        .open_path(&full_path, None::<&str>)
        .map_err(|e| format!("Failed to launch game: {e}"))
}

// ── Watcher commands ──────────────────────────────────────

#[tauri::command]
fn toggle_track_changes(
    app: tauri::AppHandle,
    game_id: String,
    enabled: bool,
) -> Result<DashboardData, String> {
    // Update the game entry first
    let state = settings::update_game_field(&app, &game_id, |g| {
        g.track_changes = enabled;
    })?;

    // Start or stop the watcher
    watcher::handle_track_changes_toggle(&app, &game_id, enabled)?;

    Ok(DashboardData { games: state.games })
}

#[tauri::command]
fn toggle_auto_sync(
    app: tauri::AppHandle,
    game_id: String,
    enabled: bool,
) -> Result<DashboardData, String> {
    let state = settings::update_game_field(&app, &game_id, |g| {
        g.auto_sync = enabled;
    })?;

    Ok(DashboardData { games: state.games })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_google_auth::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // Initialize the WatcherManager as managed state
            let manager = watcher::WatcherManager::new(app.handle().clone());
            app.manage(Arc::new(Mutex::new(manager)));

            // Start watchers for games that have tracking enabled
            watcher::init_watchers(app.handle());

            // Set up system tray icon and context menu
            tray::setup_tray(app).map_err(|e| e.to_string())?;

            // If "start minimised" is enabled, hide the main window
            if let Ok(s) = settings::get_settings(app.handle()) {
                if s.start_minimised {
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.hide();
                    }
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_dashboard,
            add_manual_game,
            update_game,
            remove_game,
            clear_all_drive_data,
            check_auth_status,
            save_auth_tokens,
            get_oauth_credentials,
            logout,
            get_google_user_info,
            get_settings,
            update_settings,
            get_save_info,
            sync_game,
            sync_all_games,
            sync_library_from_cloud,
            check_sync_structure_diff,
            restore_from_cloud,
            push_to_cloud,
            toggle_track_changes,
            toggle_auto_sync,
            launch_game,
            validate_save_paths,
            get_browse_default_path,
            expand_save_path,
            contract_path,
            upload_game_logo,
            list_game_drive_files_flat,
            list_game_drive_files,
            rename_game_drive_file,
            move_game_drive_file,
            delete_game_drive_file,
            create_version_backup,
            list_version_backups,
            restore_version_backup,
            delete_version_backup,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Hide the window instead of closing — app stays in system tray
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

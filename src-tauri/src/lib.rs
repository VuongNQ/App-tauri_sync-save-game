mod gdrive;
mod gdrive_auth;
mod models;
mod settings;
mod sync;
mod watcher;

use std::sync::{Arc, Mutex};

use tauri::Manager;

use models::{
    AddGamePayload, AppSettings, AuthStatus, DashboardData, GoogleUserInfo,
    OAuthCredentials, SaveInfo, SaveTokensPayload, SyncResult, UpdateGamePayload,
};

#[tauri::command]
fn load_dashboard(app: tauri::AppHandle) -> Result<DashboardData, String> {
    let state = settings::load_state(&app)?;
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
    settings::upsert_game(&app, payload.game)?;
    let state = settings::load_state(&app)?;
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
    gdrive_auth::save_tokens_from_plugin(&app, payload)
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

// ── Save info commands ─────────────────────────────────────

#[tauri::command]
fn get_save_info(app: tauri::AppHandle, game_id: String) -> Result<SaveInfo, String> {
    sync::get_save_info(&app, &game_id)
}

// ── Sync commands ─────────────────────────────────────────

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

// ── Watcher commands ──────────────────────────────────────

#[tauri::command]
fn toggle_track_changes(
    app: tauri::AppHandle,
    game_id: String,
    enabled: bool,
) -> Result<DashboardData, String> {
    // Update the game entry first
    settings::update_game_field(&app, &game_id, |g| {
        g.track_changes = enabled;
    })?;

    // Start or stop the watcher
    watcher::handle_track_changes_toggle(&app, &game_id, enabled)?;

    let state = settings::load_state(&app)?;
    Ok(DashboardData { games: state.games })
}

#[tauri::command]
fn toggle_auto_sync(
    app: tauri::AppHandle,
    game_id: String,
    enabled: bool,
) -> Result<DashboardData, String> {
    settings::update_game_field(&app, &game_id, |g| {
        g.auto_sync = enabled;
    })?;

    let state = settings::load_state(&app)?;
    Ok(DashboardData { games: state.games })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_google_auth::init())
        .setup(|app| {
            // Initialize the WatcherManager as managed state
            let manager = watcher::WatcherManager::new(app.handle().clone());
            app.manage(Arc::new(Mutex::new(manager)));

            // Start watchers for games that have tracking enabled
            watcher::init_watchers(app.handle());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_dashboard,
            add_manual_game,
            update_game,
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
            toggle_track_changes,
            toggle_auto_sync,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

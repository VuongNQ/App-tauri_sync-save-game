mod gdrive_auth;
mod models;
mod settings;

use models::{AddGamePayload, AuthStatus, DashboardData, UpdateGamePayload};

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

#[tauri::command]
async fn start_oauth_login(app: tauri::AppHandle) -> Result<AuthStatus, String> {
    tokio::task::spawn_blocking(move || gdrive_auth::start_oauth_login(&app))
        .await
        .map_err(|e| format!("Login task failed: {e}"))?
}

#[tauri::command]
fn logout(app: tauri::AppHandle) -> Result<AuthStatus, String> {
    gdrive_auth::logout(&app)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            load_dashboard,
            add_manual_game,
            update_game,
            check_auth_status,
            start_oauth_login,
            logout,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

mod detection;
mod models;
mod settings;

use detection::load_dashboard as load_dashboard_state;
use models::{AddGamePayload, DashboardData, UpsertGamePayload};

#[tauri::command]
fn load_dashboard(app: tauri::AppHandle) -> Result<DashboardData, String> {
    load_dashboard_state(&app)
}

#[tauri::command]
fn refresh_dashboard(app: tauri::AppHandle) -> Result<DashboardData, String> {
    load_dashboard_state(&app)
}

#[tauri::command]
fn add_manual_game(
    app: tauri::AppHandle,
    payload: AddGamePayload,
) -> Result<DashboardData, String> {
    settings::add_manual_game(&app, payload)?;
    load_dashboard_state(&app)
}

#[tauri::command]
fn update_game_save_path(
    app: tauri::AppHandle,
    payload: UpsertGamePayload,
) -> Result<DashboardData, String> {
    settings::upsert_game(&app, payload.game)?;
    load_dashboard_state(&app)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            load_dashboard,
            refresh_dashboard,
            add_manual_game,
            update_game_save_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

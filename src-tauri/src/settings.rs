use std::{fs, path::PathBuf};

use tauri::{AppHandle, Manager};

use crate::models::{AddGamePayload, AppSettings, GameEntry, StoredState};

const SETTINGS_FILE_NAME: &str = "games-library.json";

pub fn load_state(app: &AppHandle) -> Result<StoredState, String> {
    let settings_path = settings_path(app)?;

    if !settings_path.exists() {
        return Ok(StoredState::default());
    }

    let content = fs::read_to_string(&settings_path)
        .map_err(|e| format!("Unable to read settings file: {e}"))?;

    if content.trim().is_empty() {
        return Ok(StoredState::default());
    }

    serde_json::from_str(&content).map_err(|e| format!("Invalid settings data: {e}"))
}

pub fn save_state(app: &AppHandle, state: &StoredState) -> Result<(), String> {
    let settings_path = settings_path(app)?;

    if let Some(parent) = settings_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Unable to create settings directory: {e}"))?;
    }

    let serialized = serde_json::to_string_pretty(state)
        .map_err(|e| format!("Unable to serialize settings: {e}"))?;

    fs::write(&settings_path, serialized)
        .map_err(|e| format!("Unable to write settings file: {e}"))
}

pub fn add_manual_game(app: &AppHandle, payload: AddGamePayload) -> Result<GameEntry, String> {
    let mut state = load_state(app)?;
    let name = payload.name.trim();

    if name.is_empty() {
        return Err("Game name is required.".into());
    }

    let base_id = format!("manual-{}", slugify(name));
    let id = ensure_unique_id(&state.games, base_id);

    let description = payload
        .description
        .map(|d| d.chars().take(1000).collect::<String>())
        .filter(|d| !d.trim().is_empty());

    let game = GameEntry {
        id,
        name: name.to_string(),
        description,
        thumbnail: payload.thumbnail,
        source: payload.source,
        save_path: normalize_optional_path(payload.save_path),
        track_changes: false,
        auto_sync: false,
        last_local_modified: None,
        last_cloud_modified: None,
        gdrive_folder_id: None,
    };

    state.games.push(game.clone());
    save_state(app, &state)?;

    Ok(game)
}

pub fn upsert_game(app: &AppHandle, game: GameEntry) -> Result<(), String> {
    let mut state = load_state(app)?;
    let normalized = GameEntry {
        save_path: normalize_optional_path(game.save_path),
        ..game
    };

    if let Some(existing) = state.games.iter_mut().find(|e| e.id == normalized.id) {
        *existing = normalized;
    } else {
        state.games.push(normalized);
    }

    save_state(app, &state)
}

pub fn get_settings(app: &AppHandle) -> Result<AppSettings, String> {
    let state = load_state(app)?;
    Ok(state.settings)
}

pub fn update_settings(app: &AppHandle, settings: AppSettings) -> Result<AppSettings, String> {
    let mut state = load_state(app)?;
    let old_run_on_startup = state.settings.run_on_startup;
    state.settings = settings;
    save_state(app, &state)?;

    // Register / unregister Windows startup when the flag changes
    if state.settings.run_on_startup != old_run_on_startup {
        if state.settings.run_on_startup {
            register_startup()?;
        } else {
            unregister_startup()?;
        }
    }

    Ok(state.settings)
}

pub fn update_game_field(
    app: &AppHandle,
    game_id: &str,
    updater: impl FnOnce(&mut GameEntry),
) -> Result<StoredState, String> {
    let mut state = load_state(app)?;
    let game = state
        .games
        .iter_mut()
        .find(|g| g.id == game_id)
        .ok_or_else(|| format!("Game not found: {game_id}"))?;
    updater(game);
    save_state(app, &state)?;
    Ok(state)
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Unable to resolve app data directory: {e}"))?;

    Ok(app_data_dir.join(SETTINGS_FILE_NAME))
}

fn normalize_optional_path(value: Option<String>) -> Option<String> {
    value
        .map(|v| v.trim().replace('/', "\\"))
        .filter(|v| !v.is_empty())
}

fn slugify(value: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;

    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }

    out.trim_matches('-').to_string()
}

fn ensure_unique_id(existing: &[GameEntry], base_id: String) -> String {
    if existing.iter().all(|g| g.id != base_id) {
        return base_id;
    }

    let mut i = 2;
    loop {
        let candidate = format!("{base_id}-{i}");
        if existing.iter().all(|g| g.id != candidate) {
            return candidate;
        }
        i += 1;
    }
}

// ── Windows startup registration ──────────────────────────

const STARTUP_KEY_NAME: &str = "SaveGameSync";

#[cfg(target_os = "windows")]
fn register_startup() -> Result<(), String> {
    use winreg::enums::*;
    use winreg::RegKey;

    let exe_path = std::env::current_exe()
        .map_err(|e| format!("Cannot resolve exe path: {e}"))?;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (run_key, _) = hkcu
        .create_subkey(r"Software\Microsoft\Windows\CurrentVersion\Run")
        .map_err(|e| format!("Cannot open Run registry key: {e}"))?;

    run_key
        .set_value(STARTUP_KEY_NAME, &exe_path.to_string_lossy().to_string())
        .map_err(|e| format!("Cannot set startup registry value: {e}"))?;

    Ok(())
}

#[cfg(target_os = "windows")]
fn unregister_startup() -> Result<(), String> {
    use winreg::enums::*;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if let Ok(run_key) = hkcu.open_subkey_with_flags(
        r"Software\Microsoft\Windows\CurrentVersion\Run",
        KEY_WRITE,
    ) {
        let _ = run_key.delete_value(STARTUP_KEY_NAME);
    }

    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn register_startup() -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn unregister_startup() -> Result<(), String> {
    Ok(())
}

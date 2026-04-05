use std::{fs, path::PathBuf};

use tauri::{AppHandle, Manager};

use crate::{
    gdrive,
    models::{AddGamePayload, AppSettings, GameEntry, PathValidation, StoredState},
};

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
        cloud_storage_bytes: None,
    };

    state.games.push(game.clone());
    save_state(app, &state)?;
    spawn_library_cloud_sync(app);

    Ok(game)
}

pub fn remove_game(app: &AppHandle, game_id: &str) -> Result<(), String> {
    let mut state = load_state(app)?;
    let before = state.games.len();
    state.games.retain(|g| g.id != game_id);
    if state.games.len() == before {
        return Err(format!("Game not found: {game_id}"));
    }
    save_state(app, &state)?;
    spawn_library_cloud_sync(app);
    Ok(())
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

    save_state(app, &state)?;
    spawn_library_cloud_sync(app);
    Ok(())
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
    spawn_settings_cloud_sync(app);

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

// ── Background cloud sync helpers ────────────────────────

/// Spawn a background thread to sync the game library to Google Drive.
/// Must only be called after `save_state()` has already succeeded locally.
fn spawn_library_cloud_sync(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(e) = gdrive::sync_library_to_cloud(&app) {
            eprintln!("[gdrive] Background library cloud sync failed: {e}");
        }
    });
}

/// Spawn a background thread to sync app settings to Google Drive.
/// Must only be called after `save_state()` has already succeeded locally.
fn spawn_settings_cloud_sync(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(e) = gdrive::sync_settings_to_cloud(&app) {
            eprintln!("[gdrive] Background settings cloud sync failed: {e}");
        }
    });
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Unable to resolve app data directory: {e}"))?;

    // Scope the library file to the currently logged-in Google account so that
    // data never leaks between users sharing the same Windows account.
    if let Some(user_id) = crate::gdrive_auth::get_current_user_id(app) {
        let user_path = app_data_dir.join(format!("games-library-{user_id}.json"));

        // One-time migration: if the user-scoped file doesn't exist yet but the
        // legacy shared file does, rename it so existing data is preserved.
        let legacy_path = app_data_dir.join(SETTINGS_FILE_NAME);
        if !user_path.exists() && legacy_path.exists() {
            if let Err(e) = fs::rename(&legacy_path, &user_path) {
                eprintln!("[settings] Could not migrate legacy library file: {e}");
            } else {
                println!("[settings] Migrated games-library.json → games-library-{user_id}.json");
            }
        }

        return Ok(user_path);
    }

    // Fallback: not authenticated or token file predates user_id capture.
    Ok(app_data_dir.join(SETTINGS_FILE_NAME))
}

/// Expand Windows environment-variable tokens (e.g. `%LOCALAPPDATA%`) to
/// their current runtime values.  Safe to call with plain absolute paths —
/// they are returned unchanged.
pub fn expand_env_vars(path: &str) -> String {
    // Order: most-specific first so that overlapping prefixes resolve correctly
    // (e.g. %TEMP% is a subdirectory of %LOCALAPPDATA%, so try TEMP first).
    const VARS: &[&str] = &["TEMP", "LOCALAPPDATA", "APPDATA", "USERPROFILE", "PROGRAMDATA"];
    let mut result = path.to_string();
    for var in VARS {
        let token = format!("%{}%", var.to_uppercase());
        if let Ok(val) = std::env::var(var) {
            // Case-insensitive token match on Windows path strings
            let upper = result.to_uppercase();
            if let Some(pos) = upper.find(&token) {
                result = format!("{}{}{}", &result[..pos], val, &result[pos + token.len()..]);
            }
        }
    }
    result
}

/// Replace a known Windows user-folder prefix with its environment-variable
/// token so that paths are portable across accounts and machines.
fn contract_env_vars(path: &str) -> String {
    // Most-specific first: TEMP ≈ %LOCALAPPDATA%\Temp, so replace it before
    // we would replace the longer LOCALAPPDATA prefix.
    const VARS: &[&str] = &["TEMP", "LOCALAPPDATA", "APPDATA", "USERPROFILE", "PROGRAMDATA"];
    let path_upper = path.to_uppercase();
    for var in VARS {
        if let Ok(val) = std::env::var(var) {
            let val_upper = val.to_uppercase();
            if path_upper.starts_with(&val_upper) {
                let remainder = &path[val.len()..];
                return format!("%{}%{}", var, remainder);
            }
        }
    }
    path.to_string()
}

fn normalize_optional_path(value: Option<String>) -> Option<String> {
    value
        .map(|v| v.trim().replace('/', "\\"))
        .filter(|v| !v.is_empty())
        .map(|v| contract_env_vars(&v))
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

// ── Path validation ───────────────────────────────────────

pub fn validate_save_paths(app: &AppHandle) -> Result<Vec<PathValidation>, String> {
    let state = load_state(app)?;
    let results = state
        .games
        .iter()
        .map(|g| {
            let valid = match &g.save_path {
                Some(p) => {
                    let expanded = expand_env_vars(p);
                    let path = std::path::Path::new(&expanded);
                    if path.exists() {
                        true
                    } else {
                        // Try to create the folder so it is ready for tracking.
                        // If creation succeeds the path is now valid on this OS.
                        fs::create_dir_all(path).is_ok()
                    }
                }
                None => true, // no path set yet — not an error
            };
            PathValidation {
                game_id: g.id.clone(),
                valid,
            }
        })
        .collect();
    Ok(results)
}

pub fn get_browse_default_path(app: &AppHandle) -> Result<Option<String>, String> {
    let state = load_state(app)?;

    // Find the game with the most recent last_local_modified that has a valid save_path
    let best = state
        .games
        .iter()
        .filter_map(|g| {
            let path = g.save_path.as_deref()?;
            let ts = g.last_local_modified.as_deref()?;
            let expanded = expand_env_vars(path);
            if std::path::Path::new(&expanded).exists() {
                Some((ts.to_string(), expanded))
            } else {
                None
            }
        })
        .max_by_key(|(ts, _)| ts.clone());

    match best {
        Some((_, path)) => {
            let parent = std::path::Path::new(&path)
                .parent()
                .map(|p| p.to_string_lossy().to_string());
            Ok(parent)
        }
        None => {
            // Fallback: first game with any existing save_path
            let fallback = state.games.iter().find_map(|g| {
                let path = g.save_path.as_deref()?;
                let expanded = expand_env_vars(path);
                if std::path::Path::new(&expanded).exists() {
                    std::path::Path::new(&expanded)
                        .parent()
                        .map(|p| p.to_string_lossy().to_string())
                } else {
                    None
                }
            });
            Ok(fallback)
        }
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

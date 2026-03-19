use std::{fs, path::PathBuf};

use tauri::{AppHandle, Manager};

use crate::models::{AddGamePayload, GameEntry, StoredState};

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

    let launcher = payload
        .launcher
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or("Manual")
        .to_string();

    let install_path = normalize_optional_path(payload.install_path);
    let base_id = format!("manual-{}", slugify(name));
    let id = ensure_unique_id(&state.games, base_id);

    let game = GameEntry {
        id,
        name: name.to_string(),
        launcher,
        install_path,
        save_path: None,
        source: "manual".into(),
        confidence: "manual".into(),
        is_manual: true,
        is_available: true,
    };

    state.games.push(game.clone());
    save_state(app, &state)?;

    Ok(game)
}

pub fn upsert_game(app: &AppHandle, game: GameEntry) -> Result<(), String> {
    let mut state = load_state(app)?;
    let normalized = GameEntry {
        save_path: normalize_optional_path(game.save_path),
        install_path: normalize_optional_path(game.install_path),
        ..game
    };

    if let Some(existing) = state.games.iter_mut().find(|e| e.id == normalized.id) {
        *existing = normalized;
    } else {
        state.games.push(normalized);
    }

    save_state(app, &state)
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

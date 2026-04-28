use std::{fs, path::PathBuf};

use tauri::{AppHandle, Manager};

use crate::{
    devices::get_machine_device_id,
    firestore,
    models::{AddGamePayload, AppSettings, GameEntry, PathValidation, SavePathEntry, StoredState},
};

// ── Path override helpers ─────────────────────────────────

/// Return the effective save paths for all `save_paths` entries at runtime.
/// For each entry, `path_overrides` / `path_overrides_indexed` (device-specific) take priority.
/// Returns the raw unexpanded paths — call `expand_env_vars` before filesystem use.
///
/// Key format depends on `GameEntry.path_mode`:
/// - `"auto"`: key = `"{game_id}"` (index 0) or `"{game_id}:{i}"` (index i≥1)
/// - `"per_device"`: key = `"{game_id}:{device_id}"` (index 0) or `"{game_id}:{device_id}:{i}"` (index i≥1)
pub fn effective_save_paths(game: &GameEntry, settings: &AppSettings) -> Vec<Option<String>> {
    let device_id = get_machine_device_id().unwrap_or_else(|| "unknown".to_string());
    game.save_paths
        .iter()
        .enumerate()
        .map(|(i, entry)| {
            let key = build_override_key(&game.id, &game.path_mode, i, &device_id);
            let override_val = if i == 0 {
                settings.path_overrides.get(&key).cloned()
            } else {
                settings.path_overrides_indexed.get(&key).cloned()
            };
            override_val.or_else(|| entry.path.clone())
        })
        .collect()
}

/// Return the effective save path for a game at runtime (compat shim — returns `save_paths[0]`).
/// `path_overrides` (device-specific) takes priority over `GameEntry.save_paths[0].path`.
/// Returns the raw unexpanded path — call `expand_env_vars` before filesystem use.
#[allow(dead_code)]
pub fn effective_save_path(game: &GameEntry, settings: &AppSettings) -> Option<String> {
    effective_save_paths(game, settings).into_iter().find_map(|p| p)
}

/// Merge device-specific path overrides into each `save_paths` entry **in place** (transient).
/// Must be called before every `DashboardData` response so the frontend always sees
/// the effective save path, regardless of whether it is portable or device-specific.
///
/// Uses device-ID-keyed lookups for `per_device` games and plain game-ID keys for `auto` games.
pub fn apply_path_overrides(games: &mut Vec<GameEntry>, settings: &AppSettings) {
    let device_id = get_machine_device_id().unwrap_or_else(|| "unknown".to_string());
    for game in games.iter_mut() {
        for (i, entry) in game.save_paths.iter_mut().enumerate() {
            let key = build_override_key(&game.id, &game.path_mode, i, &device_id);
            let override_path = if i == 0 {
                settings.path_overrides.get(&key).cloned()
            } else {
                settings.path_overrides_indexed.get(&key).cloned()
            };
            if let Some(p) = override_path {
                entry.path = Some(p);
            }
        }
    }
}

/// Route a single normalised path value to the correct storage bucket.
/// Portable paths (`%VAR%` present) → stored in the entry / returns the path.
/// Device-specific paths → stored in the given `overrides` map under `key`; returns `None`.
/// `None` input → override removed; returns `None`.
fn route_save_path_at(
    save_path: Option<String>,
    key: &str,
    overrides: &mut std::collections::HashMap<String, String>,
) -> Option<String> {
    match save_path {
        Some(ref path) if path.contains('%') => {
            overrides.remove(key);
            save_path
        }
        Some(path) => {
            overrides.insert(key.to_string(), path);
            None
        }
        None => {
            overrides.remove(key);
            None
        }
    }
}

/// Build the `path_overrides` / `path_overrides_indexed` map key for a save-path at `index`.
///
/// Key formats:
/// - "auto"       index 0:  `"{game_id}"`
/// - "auto"       index i≥1: `"{game_id}:{i}"`            (in `path_overrides_indexed`)
/// - "per_device" index 0:  `"{game_id}:{device_id}"`
/// - "per_device" index i≥1: `"{game_id}:{device_id}:{i}"` (in `path_overrides_indexed`)
fn build_override_key(game_id: &str, path_mode: &str, index: usize, device_id: &str) -> String {
    if path_mode == "per_device" {
        if index == 0 {
            format!("{game_id}:{device_id}")
        } else {
            format!("{game_id}:{device_id}:{index}")
        }
    } else if index == 0 {
        game_id.to_string()
    } else {
        format!("{game_id}:{index}")
    }
}

/// Return whether a `path_overrides_indexed` key is stale (its index ≥ `new_len`).
/// Handles both "auto" (`"{game_id}:{i}"`) and "per_device" (`"{game_id}:{device_id}:{i}"`) formats.
fn is_stale_indexed_override(
    key: &str,
    game_id: &str,
    new_len: usize,
    path_mode: &str,
    device_id: &str,
) -> bool {
    if path_mode == "per_device" {
        let prefix = format!("{game_id}:{device_id}:");
        if let Some(idx_str) = key.strip_prefix(&prefix) {
            return idx_str.parse::<usize>().map_or(false, |idx| idx >= new_len);
        }
        false
    } else {
        match key.split_once(':') {
            Some((id, idx_str)) if id == game_id => {
                idx_str.parse::<usize>().map_or(false, |idx| idx >= new_len)
            }
            _ => false,
        }
    }
}

/// Route every `SavePathEntry.path` in the game's `save_paths` list to the correct
/// storage bucket and remove overrides for indices that no longer exist.
///
/// - `"auto"` mode: portable `%VAR%` paths stay in `entry.path`; absolute paths go to overrides.
/// - `"per_device"` mode: all paths go to device-local overrides keyed by device ID;
///   `entry.path` is always `None` (never written to Firestore).
fn route_save_paths(
    save_paths: &mut Vec<SavePathEntry>,
    game_id: &str,
    settings: &mut AppSettings,
    path_mode: &str,
) {
    let device_id = get_machine_device_id().unwrap_or_else(|| "unknown".to_string());
    for (i, entry) in save_paths.iter_mut().enumerate() {
        let normalized = normalize_optional_path(entry.path.clone());
        let key = build_override_key(game_id, path_mode, i, &device_id);
        if path_mode == "per_device" {
            // Per-device: always store locally under a device-ID-keyed key.
            if i == 0 {
                match normalized {
                    Some(p) => { settings.path_overrides.insert(key, p); }
                    None => { settings.path_overrides.remove(&key); }
                }
            } else {
                match normalized {
                    Some(p) => { settings.path_overrides_indexed.insert(key, p); }
                    None => { settings.path_overrides_indexed.remove(&key); }
                }
            }
            entry.path = None;
        } else {
            // "auto" mode: portable paths stay in entry, absolute paths go to overrides.
            if i == 0 {
                entry.path = route_save_path_at(normalized, &key, &mut settings.path_overrides);
            } else {
                entry.path =
                    route_save_path_at(normalized, &key, &mut settings.path_overrides_indexed);
            }
        }
    }
    // Remove stale indexed overrides for indices >= new save_paths length.
    let len = save_paths.len();
    let device_id_ref = device_id.as_str();
    let stale_keys: Vec<String> = settings
        .path_overrides_indexed
        .keys()
        .filter(|k| is_stale_indexed_override(k, game_id, len, path_mode, device_id_ref))
        .cloned()
        .collect();
    for k in stale_keys {
        settings.path_overrides_indexed.remove(&k);
    }
}

/// Legacy single-path routing (kept for the `migrate_absolute_save_paths` helper).
#[allow(dead_code)]
fn route_save_path(
    save_path: Option<String>,
    game_id: &str,
    settings: &mut AppSettings,
) -> Option<String> {
    route_save_path_at(save_path, game_id, &mut settings.path_overrides)
}

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

    let mut state: StoredState =
        serde_json::from_str(&content).map_err(|e| format!("Invalid settings data: {e}"))?;

    // One-time migration (pass 1): move any absolute save_path (no %VAR% tokens) into path_overrides
    // so device-specific paths are never written to Firestore.
    if migrate_absolute_save_paths(&mut state) {
        println!("[settings] Migrated absolute save paths to path_overrides");
        if let Err(e) = save_state(app, &state) {
            eprintln!("[settings] Migration save failed: {e}");
        } else {
            // Inform Firestore that these games now have save_path = null.
            for game in state
                .games
                .iter()
                .filter(|g| state.settings.path_overrides.contains_key(&g.id))
            {
                spawn_firestore_game_upsert(app, game.clone());
            }
        }
    }

    // One-time migration (pass 2): promote legacy `save_path` + `sync_excludes` fields into
    // `save_paths[0]` so the rest of the codebase only has to deal with the vec form.
    if migrate_save_paths_to_vec(&mut state) {
        println!("[settings] Migrated single save_path → save_paths vec");
        if let Err(e) = save_state(app, &state) {
            eprintln!("[settings] save_paths migration save failed: {e}");
        }
    }

    // One-time migration (pass 3): for per-device games, upgrade plain game-ID override keys
    // to device-ID-keyed keys ("game_id:device_id") so paths are unambiguously per-device.
    if migrate_per_device_override_keys(&mut state) {
        println!("[settings] Migrated per-device override keys to include device ID");
        if let Err(e) = save_state(app, &state) {
            eprintln!("[settings] Per-device key migration save failed: {e}");
        }
    }

    // One-time migration (pass 4): clear legacy `sync_excludes` from every SavePathEntry.
    // The new model uses `sync_includes` (empty = sync all); the old exclusion data cannot
    // be automatically converted so it is discarded here and pushed to Firestore.
    if migrate_sync_excludes_to_includes(&mut state) {
        println!("[settings] Cleared legacy sync_excludes — migrated to sync_includes model");
        if let Err(e) = save_state(app, &state) {
            eprintln!("[settings] sync_excludes migration save failed: {e}");
        } else {
            // Push each updated game to Firestore so the old syncExcludes field is wiped there too.
            for game in &state.games {
                spawn_firestore_game_upsert(app, game.clone());
            }
        }
    }

    Ok(state)
}

pub fn save_state(app: &AppHandle, state: &StoredState) -> Result<(), String> {
    let settings_path = settings_path(app)?;

    if let Some(parent) = settings_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Unable to create settings directory: {e}"))?;
    }

    let serialized = serde_json::to_string_pretty(state)
        .map_err(|e| format!("Unable to serialize settings: {e}"))?;

    fs::write(&settings_path, serialized).map_err(|e| format!("Unable to write settings file: {e}"))
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

    let normalized_save_path = normalize_optional_path(payload.save_path);
    let mut save_paths = vec![SavePathEntry {
        label: "Save Folder".to_string(),
        path: normalized_save_path,
        gdrive_folder_id: None,
        sync_includes: vec![],
        sync_excludes: vec![],
    }];
    route_save_paths(&mut save_paths, &id, &mut state.settings, &payload.path_mode);

    let game = GameEntry {
        id,
        name: name.to_string(),
        description,
        thumbnail: payload.thumbnail,
        source: payload.source,
        save_paths,
        save_path: None,
        exe_name: None,
        exe_path: payload.exe_path,
        track_changes: false,
        auto_sync: false,
        last_local_modified: None,
        last_cloud_modified: None,
        gdrive_folder_id: None,
        cloud_storage_bytes: None,
        path_mode: payload.path_mode,
        sync_excludes: vec![],
    };

    state.games.push(game.clone());
    save_state(app, &state)?;
    spawn_firestore_game_upsert(app, game.clone());
    // Path routing may have stored new device-specific overrides — sync them to Firestore.
    spawn_firestore_device_paths_sync(app);
    Ok(game)
}

pub fn remove_game(app: &AppHandle, game_id: &str) -> Result<(), String> {
    let mut state = load_state(app)?;
    let before = state.games.len();
    state.games.retain(|g| g.id != game_id);
    if state.games.len() == before {
        return Err(format!("Game not found: {game_id}"));
    }
    // Clean up all device-specific path overrides for this game.
    let prefix = format!("{game_id}:");
    state.settings.path_overrides.retain(|k, _| k != game_id && !k.starts_with(&prefix));
    state.settings.path_overrides_indexed.retain(|k, _| !k.starts_with(&prefix));
    save_state(app, &state)?;
    spawn_firestore_game_delete(app, game_id.to_string());
    Ok(())
}

pub fn upsert_game(app: &AppHandle, game: GameEntry) -> Result<(), String> {
    let mut state = load_state(app)?;
    let game_id = game.id.clone();
    let normalized_exe_path = normalize_optional_path(game.exe_path);

    let path_mode = game.path_mode.clone();
    let mut save_paths = game.save_paths.clone();
    route_save_paths(&mut save_paths, &game_id, &mut state.settings, &path_mode);

    let normalized = GameEntry {
        save_paths,
        save_path: None, // Legacy field — never persist back
        exe_path: normalized_exe_path,
        ..game
    };

    let to_sync = normalized.clone();
    if let Some(existing) = state.games.iter_mut().find(|e| e.id == normalized.id) {
        *existing = normalized;
    } else {
        state.games.push(normalized);
    }

    save_state(app, &state)?;
    spawn_firestore_game_upsert(app, to_sync);
    // Path routing may have updated device-specific overrides — sync them to Firestore.
    spawn_firestore_device_paths_sync(app);
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
    spawn_firestore_settings_sync(app);

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

/// Look up a game by ID (immutable reference).
pub fn find_game<'a>(state: &'a StoredState, game_id: &str) -> Result<&'a GameEntry, String> {
    state
        .games
        .iter()
        .find(|g| g.id == game_id)
        .ok_or_else(|| format!("Game not found: {game_id}"))
}

/// Look up a game by ID (mutable reference).
pub fn find_game_mut<'a>(
    state: &'a mut StoredState,
    game_id: &str,
) -> Result<&'a mut GameEntry, String> {
    state
        .games
        .iter_mut()
        .find(|g| g.id == game_id)
        .ok_or_else(|| format!("Game not found: {game_id}"))
}

pub fn update_game_field(
    app: &AppHandle,
    game_id: &str,
    updater: impl FnOnce(&mut GameEntry),
) -> Result<StoredState, String> {
    let mut state = load_state(app)?;
    let game = find_game_mut(&mut state, game_id)?;
    updater(game);
    let game_snapshot = game.clone();
    save_state(app, &state)?;
    spawn_firestore_game_upsert(app, game_snapshot);
    Ok(state)
}

// ── Background Firestore sync helpers ────────────────────

/// Fetch game library + settings from Firestore and overwrite local state.
/// Falls back to Drive `library.json` migration if Firestore has no data yet.
/// Returns `Ok(true)` if data was loaded, `Ok(false)` if no data found anywhere.
pub fn fetch_all_from_firestore(app: &AppHandle) -> Result<bool, String> {
    let user_id = match crate::gdrive_auth::get_current_user_id(app) {
        Some(id) => id,
        None => {
            println!("[firestore] fetch_all_from_firestore: no user_id, skipping");
            return Ok(false);
        }
    };

    let firestore_games = firestore::load_all_games(app, &user_id).unwrap_or_else(|e| {
        eprintln!("[firestore] load_all_games failed: {e}");
        vec![]
    });

    // Migration path: if Firestore has no games, try Drive library.json once.
    if firestore_games.is_empty() {
        println!("[firestore] No games in Firestore — checking Drive for one-time migration");
        match crate::gdrive::fetch_library_from_cloud(app) {
            Ok(true) => {
                println!("[firestore] Migrating games from Drive library.json to Firestore");
                let migrated = load_state(app)?;
                for game in &migrated.games {
                    if let Err(e) = firestore::save_game(app, &user_id, game) {
                        eprintln!("[firestore] Migration: save game '{}' failed: {e}", game.id);
                    }
                }
                // Also migrate settings if available.
                match crate::gdrive::fetch_settings_from_cloud(app) {
                    Ok(true) => {
                        let s = load_state(app)?;
                        if let Err(e) = firestore::save_settings(app, &user_id, &s.settings) {
                            eprintln!("[firestore] Migration: save settings failed: {e}");
                        }
                    }
                    _ => {}
                }
                return Ok(true);
            }
            Ok(false) => {
                println!("[firestore] No data in Drive either — first-time user");
                return Ok(false);
            }
            Err(e) => {
                eprintln!("[firestore] Could not check Drive during migration: {e}");
                return Ok(false);
            }
        }
    }

    // Apply cloud data to local state, preserving local-only exe_path per machine.
    let mut state = load_state(app)?;
    // Collect local exe_paths before overwriting — they differ per device and are never synced.
    let local_exe_paths: std::collections::HashMap<String, Option<String>> = state
        .games
        .iter()
        .map(|g| (g.id.clone(), g.exe_path.clone()))
        .collect();
    state.games = firestore_games;
    for game in &mut state.games {
        if let Some(local_path) = local_exe_paths.get(&game.id) {
            game.exe_path = local_path.clone();
        }
    }

    if let Ok(Some(mut cloud_settings)) = firestore::load_settings(app, &user_id) {
        // path_overrides and path_overrides_indexed are local-only (device-specific paths)
        // — never synced via AppSettings. Preserve the local machine's overrides for now;
        // load_and_merge_device_paths (called below) will reconcile with the device doc.
        cloud_settings.path_overrides = state.settings.path_overrides.clone();
        cloud_settings.path_overrides_indexed = state.settings.path_overrides_indexed.clone();
        state.settings = cloud_settings;
    }

    save_state(app, &state)?;
    println!(
        "[firestore] Restored {} games from Firestore",
        state.games.len()
    );

    // Reconcile device path overrides: restore from Firestore (reinstall) or push local
    // overrides up (one-time migration for existing installs).
    if let Err(e) = load_and_merge_device_paths(app) {
        eprintln!("[firestore] load_and_merge_device_paths failed: {e}");
    }

    Ok(true)
}

/// Run a Firestore operation in a background thread.
/// Skips silently if the user is not authenticated (no `user_id`).
pub(crate) fn spawn_firestore_task<F>(app: &AppHandle, f: F)
where
    F: FnOnce(&AppHandle, &str) -> Result<(), String> + Send + 'static,
{
    let app = app.clone();
    std::thread::spawn(move || {
        if let Some(user_id) = crate::gdrive_auth::get_current_user_id(&app) {
            if let Err(e) = f(&app, &user_id) {
                eprintln!("[firestore] background task failed: {e}");
            }
        }
    });
}

/// Upsert a single game to Firestore in a background thread.
fn spawn_firestore_game_upsert(app: &AppHandle, game: GameEntry) {
    spawn_firestore_task(app, move |app, user_id| {
        firestore::save_game(app, user_id, &game)
    });
}

/// Delete a single game from Firestore in a background thread.
fn spawn_firestore_game_delete(app: &AppHandle, game_id: String) {
    spawn_firestore_task(app, move |app, user_id| {
        firestore::delete_game(app, user_id, &game_id)?;
        // Also delete the game's syncMeta document (best-effort — idempotent on 404).
        if let Err(e) = firestore::delete_sync_meta(app, user_id, &game_id) {
            eprintln!("[firestore] delete_sync_meta for '{game_id}' failed: {e}");
        }
        Ok(())
    });
}

/// Push the current `AppSettings` to Firestore in a background thread.
fn spawn_firestore_settings_sync(app: &AppHandle) {
    spawn_firestore_task(app, move |app, user_id| {
        let settings = load_state(app)?.settings;
        firestore::save_settings(app, user_id, &settings)
    });
}

/// Push the current device's `path_overrides` / `path_overrides_indexed` to Firestore
/// under `users/{user_id}/devices/{device_id}` using a targeted `updateMask` PATCH.
/// Called in a background thread so it never blocks the UI.
pub(crate) fn spawn_firestore_device_paths_sync(app: &AppHandle) {
    spawn_firestore_task(app, move |app, user_id| {
        let device_id = match crate::devices::get_machine_device_id() {
            Some(id) => id,
            None => return Ok(()), // non-Windows or registry unavailable
        };
        let settings = load_state(app)?.settings;
        firestore::save_device_path_overrides(
            app,
            user_id,
            &device_id,
            &settings.path_overrides,
            &settings.path_overrides_indexed,
        )
    });
}

/// Load device-scoped path overrides from Firestore and merge them into local state.
///
/// Logic:
/// - Firestore has **non-empty** overrides → restore from Firestore (covers reinstall)
/// - Firestore has **empty** overrides AND local has non-empty → push local to Firestore (one-time migration)
/// - Both empty → no-op
///
/// Returns `Ok(true)` if local state was updated, `Ok(false)` otherwise.
pub fn load_and_merge_device_paths(app: &AppHandle) -> Result<bool, String> {
    let device_id = match crate::devices::get_machine_device_id() {
        Some(id) => id,
        None => return Ok(false), // non-Windows
    };
    let user_id = match crate::gdrive_auth::get_current_user_id(app) {
        Some(id) => id,
        None => return Ok(false),
    };

    let cloud_device = match firestore::load_device(app, &user_id, &device_id) {
        Ok(Some(d)) => d,
        Ok(None) => return Ok(false), // device not yet registered
        Err(e) => {
            eprintln!("[firestore] load_and_merge_device_paths: load_device failed: {e}");
            return Ok(false);
        }
    };

    let mut state = load_state(app)?;

    let cloud_has_overrides = !cloud_device.path_overrides.is_empty();
    let local_has_overrides = !state.settings.path_overrides.is_empty()
        || !state.settings.path_overrides_indexed.is_empty();

    if cloud_has_overrides {
        // Firestore is authoritative — restore (covers clean reinstall scenario).
        state.settings.path_overrides = cloud_device.path_overrides;
        state.settings.path_overrides_indexed = cloud_device.path_overrides_indexed;
        save_state(app, &state)?;
        println!("[firestore] Restored device path overrides from Firestore ({} entries)",
            state.settings.path_overrides.len() + state.settings.path_overrides_indexed.len());
        Ok(true)
    } else if local_has_overrides {
        // One-time migration: push existing local overrides up to Firestore.
        if let Err(e) = firestore::save_device_path_overrides(
            app,
            &user_id,
            &device_id,
            &state.settings.path_overrides,
            &state.settings.path_overrides_indexed,
        ) {
            eprintln!("[firestore] load_and_merge_device_paths: migration push failed: {e}");
        } else {
            println!("[firestore] Migrated local path overrides to Firestore device doc");
        }
        Ok(false) // local state unchanged
    } else {
        Ok(false) // nothing to do
    }
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

/// Windows env-var tokens used for path portability, ordered most-specific first.
/// (`%TEMP%` ≈ `%LOCALAPPDATA%\Temp`, so TEMP must precede LOCALAPPDATA.)
#[cfg(target_os = "windows")]
const ENV_VAR_TOKENS: &[&str] = &[
    "TEMP",
    "LOCALAPPDATA",
    "APPDATA",
    "USERPROFILE",
    "PROGRAMDATA",
    "PROGRAMFILES",
];

/// Expand Windows environment-variable tokens (e.g. `%LOCALAPPDATA%`) to
/// their current runtime values.  Safe to call with plain absolute paths —
/// they are returned unchanged.
pub fn expand_env_vars(path: &str) -> String {
    let mut result = path.to_string();
    for var in ENV_VAR_TOKENS {
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

/// Replace absolute path prefixes with portable env-var tokens (e.g. `%PROGRAMFILES%\\...`).
/// Public wrapper around `contract_env_vars` for use in Tauri commands.
pub fn contract_path(path: &str) -> String {
    contract_env_vars(&path.replace('/', "\\"))
}

/// Replace a known Windows user-folder prefix with its environment-variable
/// token so that paths are portable across accounts and machines.
fn contract_env_vars(path: &str) -> String {
    #[cfg(not(target_os = "windows"))]
    const ENV_VAR_TOKENS: &[&str] = &[
        "TEMP",
        "LOCALAPPDATA",
        "APPDATA",
        "USERPROFILE",
        "PROGRAMDATA",
        "PROGRAMFILES",
    ];
    let path_upper = path.to_uppercase();
    for var in ENV_VAR_TOKENS {
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

/// One-time migration: move any `save_path` without a `%VAR%` token into
/// `AppSettings.path_overrides` so device-specific paths are never synced to Firestore.
/// Returns `true` when at least one game was migrated (caller should persist state).
fn migrate_absolute_save_paths(state: &mut StoredState) -> bool {
    let mut migrated = false;
    for game in &mut state.games {
        if let Some(ref path) = game.save_path.clone() {
            if !path.contains('%') {
                state
                    .settings
                    .path_overrides
                    .insert(game.id.clone(), path.clone());
                game.save_path = None;
                migrated = true;
            }
        }
    }
    migrated
}

/// One-time migration: promote legacy `save_path` + `sync_excludes` fields into
/// `save_paths[0]` so the rest of the codebase only needs the vec form.
/// Returns `true` when at least one game was migrated.
fn migrate_save_paths_to_vec(state: &mut StoredState) -> bool {
    let mut migrated = false;
    for game in &mut state.games {
        if game.save_paths.is_empty() {
            // Discard old sync_excludes — migration Pass 4 will clear them anyway;
            // they cannot be converted to an equivalent inclusion list without a file scan.
            let _ = std::mem::take(&mut game.sync_excludes);
            game.save_paths.push(SavePathEntry {
                label: "Save Folder".to_string(),
                path: game.save_path.take(),
                gdrive_folder_id: None,
                sync_includes: vec![],
                sync_excludes: vec![],
            });
            migrated = true;
        }
    }
    migrated
}

/// One-time migration (pass 3): upgrade per-device override keys from the old
/// device-agnostic format (`"{game_id}"` / `"{game_id}:{i}"`) to the new
/// device-ID-keyed format (`"{game_id}:{device_id}"` / `"{game_id}:{device_id}:{i}"`).
///
/// Only per-device games are touched; "auto" game keys are left unchanged.
/// Returns `true` when at least one key was migrated (caller should persist state).
fn migrate_per_device_override_keys(state: &mut StoredState) -> bool {
    let device_id = match get_machine_device_id() {
        Some(id) => id,
        None => return false, // Non-Windows or registry unavailable — skip.
    };

    let per_device_ids: Vec<String> = state
        .games
        .iter()
        .filter(|g| g.path_mode == "per_device")
        .map(|g| g.id.clone())
        .collect();

    let mut migrated = false;

    for game_id in &per_device_ids {
        // ── Index 0: path_overrides ────────────────────────────────────────
        // Old key: "{game_id}"  →  New key: "{game_id}:{device_id}"
        let new_key_0 = format!("{game_id}:{device_id}");
        if !state.settings.path_overrides.contains_key(&new_key_0) {
            if let Some(path) = state.settings.path_overrides.remove(game_id.as_str()) {
                state.settings.path_overrides.insert(new_key_0, path);
                migrated = true;
            }
        }

        // ── Index ≥1: path_overrides_indexed ──────────────────────────────
        // Old key: "{game_id}:{i}"  →  New key: "{game_id}:{device_id}:{i}"
        // Identify old-format keys: id matches, remainder is a bare integer.
        let old_indexed: Vec<(String, usize)> = state
            .settings
            .path_overrides_indexed
            .keys()
            .filter_map(|k| {
                let (id, rest) = k.split_once(':')?;
                if id != game_id.as_str() {
                    return None;
                }
                // Old format has a bare integer after the colon.
                // New format has device_id:i — device_id contains hyphens and hex chars,
                // not parseable as usize, so this filter is unambiguous.
                let idx = rest.parse::<usize>().ok()?;
                Some((k.clone(), idx))
            })
            .collect();

        for (old_key, idx) in old_indexed {
            let new_key = format!("{game_id}:{device_id}:{idx}");
            if !state.settings.path_overrides_indexed.contains_key(&new_key) {
                if let Some(path) = state.settings.path_overrides_indexed.remove(&old_key) {
                    state.settings.path_overrides_indexed.insert(new_key, path);
                    migrated = true;
                }
            }
        }
    }

    migrated
}

/// One-time migration (pass 4): clear legacy `sync_excludes` from every `SavePathEntry`.
/// The new inclusion model uses `sync_includes` (empty = sync all).
/// Old exclusion data cannot be automatically inverted so it is discarded.
/// Returns `true` when at least one entry was modified.
fn migrate_sync_excludes_to_includes(state: &mut StoredState) -> bool {
    let mut migrated = false;
    for game in &mut state.games {
        for entry in &mut game.save_paths {
            if !entry.sync_excludes.is_empty() {
                entry.sync_excludes.clear();
                migrated = true;
            }
        }
        // Also clear top-level legacy field
        if !game.sync_excludes.is_empty() {
            game.sync_excludes.clear();
            migrated = true;
        }
    }
    migrated
}

pub fn validate_save_paths(app: &AppHandle) -> Result<Vec<PathValidation>, String> {
    let state = load_state(app)?;
    let results = state
        .games
        .iter()
        .map(|g| {
            let effectives = effective_save_paths(g, &state.settings);
            // A game is valid if every configured path either exists or can be created.
            let valid = effectives.iter().all(|effective| match effective {
                Some(ref p) => {
                    let expanded = expand_env_vars(p);
                    let path = std::path::Path::new(&expanded);
                    if path.exists() {
                        true
                    } else {
                        fs::create_dir_all(path).is_ok()
                    }
                }
                None => true, // no path set yet — not an error
            });
            // Validate exe_path: check the file actually exists on this device.
            let exe_path_valid = g.exe_path.as_deref().map(|raw| {
                let expanded = expand_env_vars(raw);
                std::path::Path::new(&expanded).is_file()
            });
            PathValidation {
                game_id: g.id.clone(),
                valid,
                exe_path_valid,
            }
        })
        .collect();
    Ok(results)
}

pub fn get_browse_default_path(app: &AppHandle) -> Result<Option<String>, String> {
    let state = load_state(app)?;

    // Find the path with the most recently modified file across all games and all save_paths.
    let best = state
        .games
        .iter()
        .flat_map(|g| {
            effective_save_paths(g, &state.settings)
                .into_iter()
                .flatten()
        })
        .filter_map(|path| {
            let expanded = expand_env_vars(&path);
            let dir = std::path::Path::new(&expanded);
            if !dir.exists() {
                return None;
            }
            let ts = crate::sync::scan_last_modified(dir)?;
            Some((ts, expanded))
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
            let fallback = state.games.iter().find_map(|g| {
                effective_save_paths(g, &state.settings)
                    .into_iter()
                    .flatten()
                    .find_map(|path| {
                        let expanded = expand_env_vars(&path);
                        if std::path::Path::new(&expanded).exists() {
                            std::path::Path::new(&expanded)
                                .parent()
                                .map(|p| p.to_string_lossy().to_string())
                        } else {
                            None
                        }
                    })
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

    let exe_path = std::env::current_exe().map_err(|e| format!("Cannot resolve exe path: {e}"))?;

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
    if let Ok(run_key) =
        hkcu.open_subkey_with_flags(r"Software\Microsoft\Windows\CurrentVersion\Run", KEY_WRITE)
    {
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

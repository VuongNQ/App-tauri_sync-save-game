use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};

use tauri::AppHandle;

use crate::{
    models::{DashboardData, GameEntry, LauncherStatus},
    settings,
};

pub fn load_dashboard(app: &AppHandle) -> Result<DashboardData, String> {
    let mut dashboard = detect_dashboard();
    let stored_state = settings::load_state(app)?;

    let mut games_by_id: HashMap<String, GameEntry> = dashboard
        .games
        .into_iter()
        .map(|game| (game.id.clone(), game))
        .collect();

    for stored in stored_state.games {
        if let Some(existing) = games_by_id.get_mut(&stored.id) {
            existing.save_path = stored.save_path.clone();
            if existing.install_path.is_none() {
                existing.install_path = stored.install_path.clone();
            }
            if existing.name.trim().is_empty() {
                existing.name = stored.name.clone();
            }
        } else {
            let mut missing_game = stored;
            missing_game.is_available = missing_game.is_manual;
            games_by_id.insert(missing_game.id.clone(), missing_game);
        }
    }

    let mut games: Vec<GameEntry> = games_by_id.into_values().collect();
    games.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));

    dashboard.games = games;
    Ok(dashboard)
}

#[cfg(target_os = "windows")]
fn detect_dashboard() -> DashboardData {
    let mut warnings = Vec::new();
    let mut launchers = Vec::new();
    let mut games = Vec::new();

    let (steam_games, steam_status, steam_warnings) = detect_steam_games();
    games.extend(steam_games);
    launchers.push(steam_status);
    warnings.extend(steam_warnings);

    let (epic_games, epic_status, epic_warnings) = detect_epic_games();
    games.extend(epic_games);
    launchers.push(epic_status);
    warnings.extend(epic_warnings);

    let (gog_games, gog_status, gog_warnings) = detect_gog_games();
    games.extend(gog_games);
    launchers.push(gog_status);
    warnings.extend(gog_warnings);

    DashboardData {
        games,
        launchers,
        warnings,
    }
}

#[cfg(not(target_os = "windows"))]
fn detect_dashboard() -> DashboardData {
    DashboardData {
        games: Vec::new(),
        launchers: vec![
            LauncherStatus {
                id: "steam".into(),
                name: "Steam".into(),
                detected: false,
                game_count: 0,
                details: Some("Windows detection only".into()),
            },
            LauncherStatus {
                id: "epic".into(),
                name: "Epic Games".into(),
                detected: false,
                game_count: 0,
                details: Some("Windows detection only".into()),
            },
            LauncherStatus {
                id: "gog".into(),
                name: "GOG Galaxy".into(),
                detected: false,
                game_count: 0,
                details: Some("Windows detection only".into()),
            },
        ],
        warnings: vec!["Game detection is currently implemented for Windows only.".into()],
    }
}

#[cfg(target_os = "windows")]
fn detect_steam_games() -> (Vec<GameEntry>, LauncherStatus, Vec<String>) {
    let mut warnings = Vec::new();
    let mut libraries = steam_library_paths();

    if libraries.is_empty() {
        return (
            Vec::new(),
            LauncherStatus {
                id: "steam".into(),
                name: "Steam".into(),
                detected: false,
                game_count: 0,
                details: Some("Steam installation not found.".into()),
            },
            warnings,
        );
    }

    libraries.sort();
    libraries.dedup();

    let mut games = Vec::new();
    for library in libraries {
        let steamapps_dir = library.join("steamapps");
        if !steamapps_dir.exists() {
            continue;
        }

        let entries = match fs::read_dir(&steamapps_dir) {
            Ok(entries) => entries,
            Err(error) => {
                warnings.push(format!("Steam library read failed at {}: {error}", steamapps_dir.display()));
                continue;
            }
        };

        for entry in entries.flatten() {
            let path = entry.path();
            let file_name = path.file_name().and_then(|name| name.to_str()).unwrap_or_default();
            if !file_name.starts_with("appmanifest_") || path.extension().and_then(|ext| ext.to_str()) != Some("acf") {
                continue;
            }

            match parse_steam_manifest(&path, &library) {
                Ok(Some(game)) => games.push(game),
                Ok(None) => {}
                Err(error) => warnings.push(format!("Steam manifest parse failed at {}: {error}", path.display())),
            }
        }
    }

    let games = dedupe_games(games);
    let detected = !games.is_empty();
    let game_count = games.len();
    let details = if detected {
        Some("Detected using Steam app manifests.".into())
    } else {
        Some("Steam installed, but no game manifests were found.".into())
    };

    (
        games,
        LauncherStatus {
            id: "steam".into(),
            name: "Steam".into(),
            detected,
            game_count,
            details,
        },
        warnings,
    )
}

#[cfg(target_os = "windows")]
fn detect_epic_games() -> (Vec<GameEntry>, LauncherStatus, Vec<String>) {
    let mut warnings = Vec::new();
    let mut games = Vec::new();
    let manifest_dir = epic_manifest_dir();

    if let Some(manifest_dir) = manifest_dir.as_ref() {
        if manifest_dir.exists() {
            match fs::read_dir(&manifest_dir) {
                Ok(entries) => {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.extension().and_then(|ext| ext.to_str()) != Some("item") {
                            continue;
                        }

                        match parse_epic_manifest(&path) {
                            Ok(Some(game)) => games.push(game),
                            Ok(None) => {}
                            Err(error) => warnings.push(format!("Epic manifest parse failed at {}: {error}", path.display())),
                        }
                    }
                }
                Err(error) => warnings.push(format!("Unable to read Epic manifest directory: {error}")),
            }
        }
    }

    let manifest_dir_exists = manifest_dir.as_ref().is_some_and(|directory| directory.exists());
    let detected = !games.is_empty() || manifest_dir_exists;
    let details = if !games.is_empty() {
        Some("Detected using Epic manifest files.".into())
    } else if detected {
        Some("Epic launcher path found, but no installed games were detected.".into())
    } else {
        Some("Epic Games Launcher manifest folder not found.".into())
    };

    let games = dedupe_games(games);
    let game_count = games.len();

    (
        games,
        LauncherStatus {
            id: "epic".into(),
            name: "Epic Games".into(),
            detected,
            game_count,
            details,
        },
        warnings,
    )
}

#[cfg(target_os = "windows")]
fn detect_gog_games() -> (Vec<GameEntry>, LauncherStatus, Vec<String>) {
    let warnings = Vec::new();
    let games = dedupe_games(windows_registry::detect_gog_games());
    let detected = !games.is_empty();
    let details = if detected {
        Some("Detected using Windows uninstall registry entries.".into())
    } else {
        Some("No GOG Galaxy games found in uninstall registry entries.".into())
    };
    let game_count = games.len();

    (
        games,
        LauncherStatus {
            id: "gog".into(),
            name: "GOG Galaxy".into(),
            detected,
            game_count,
            details,
        },
        warnings,
    )
}

#[cfg(target_os = "windows")]
fn steam_library_paths() -> Vec<PathBuf> {
    let mut libraries = windows_registry::steam_install_paths();

    if libraries.is_empty() {
        libraries.push(PathBuf::from(r"C:\Program Files (x86)\Steam"));
        libraries.push(PathBuf::from(r"C:\Steam"));
    }

    let mut discovered = libraries.clone();
    for root in libraries {
        let library_file = root.join("steamapps").join("libraryfolders.vdf");
        if !library_file.exists() {
            continue;
        }

        if let Ok(content) = fs::read_to_string(library_file) {
            for path in parse_vdf_paths(&content) {
                discovered.push(PathBuf::from(path));
            }
        }
    }

    discovered.into_iter().filter(|path| path.exists()).collect()
}

#[cfg(target_os = "windows")]
fn parse_steam_manifest(path: &Path, library_root: &Path) -> Result<Option<GameEntry>, String> {
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let app_id = extract_vdf_value(&content, "appid");
    let name = extract_vdf_value(&content, "name");
    let install_dir = extract_vdf_value(&content, "installdir");

    let Some(name) = name else {
        return Ok(None);
    };

    let install_path = install_dir.map(|directory| {
        library_root
            .join("steamapps")
            .join("common")
            .join(directory)
            .display()
            .to_string()
    });

    let id = app_id
        .map(|value| format!("steam-{value}"))
        .unwrap_or_else(|| format!("steam-{}", slugify(&name)));

    Ok(Some(GameEntry {
        id,
        name,
        launcher: "Steam".into(),
        install_path,
        save_path: None,
        source: "steam-manifest".into(),
        confidence: "high".into(),
        is_manual: false,
        is_available: true,
    }))
}

#[cfg(target_os = "windows")]
fn parse_epic_manifest(path: &Path) -> Result<Option<GameEntry>, String> {
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let value: serde_json::Value = serde_json::from_str(&content).map_err(|error| error.to_string())?;
    let name = value
        .get("DisplayName")
        .and_then(serde_json::Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| {
            value
                .get("AppName")
                .and_then(serde_json::Value::as_str)
                .map(ToOwned::to_owned)
        });

    let Some(name) = name else {
        return Ok(None);
    };

    let install_path = value
        .get("InstallLocation")
        .and_then(serde_json::Value::as_str)
        .map(ToOwned::to_owned)
        .filter(|entry| !entry.trim().is_empty());

    let id = value
        .get("CatalogItemId")
        .and_then(serde_json::Value::as_str)
        .map(|catalog_id| format!("epic-{catalog_id}"))
        .or_else(|| {
            value
                .get("AppName")
                .and_then(serde_json::Value::as_str)
                .map(|app_name| format!("epic-{app_name}"))
        })
        .unwrap_or_else(|| format!("epic-{}", slugify(&name)));

    Ok(Some(GameEntry {
        id,
        name,
        launcher: "Epic Games".into(),
        install_path,
        save_path: None,
        source: "epic-manifest".into(),
        confidence: "high".into(),
        is_manual: false,
        is_available: true,
    }))
}

#[cfg(target_os = "windows")]
fn epic_manifest_dir() -> Option<PathBuf> {
    std::env::var_os("PROGRAMDATA").map(|program_data| {
        PathBuf::from(program_data)
            .join("Epic")
            .join("EpicGamesLauncher")
            .join("Data")
            .join("Manifests")
    })
}

#[cfg(target_os = "windows")]
fn extract_vdf_value(content: &str, target_key: &str) -> Option<String> {
    content.lines().find_map(|line| {
        let values = extract_quoted_values(line);
        if values.len() >= 2 && values[0].eq_ignore_ascii_case(target_key) {
            Some(values[1].replace("\\\\", "\\"))
        } else {
            None
        }
    })
}

#[cfg(target_os = "windows")]
fn parse_vdf_paths(content: &str) -> Vec<String> {
    content
        .lines()
        .filter_map(|line| {
            let values = extract_quoted_values(line);
            if values.len() >= 2 && values[0].eq_ignore_ascii_case("path") {
                Some(values[1].replace("\\\\", "\\"))
            } else {
                None
            }
        })
        .collect()
}

#[cfg(target_os = "windows")]
fn extract_quoted_values(line: &str) -> Vec<String> {
    let mut values = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;

    for character in line.chars() {
        match character {
            '"' if in_quotes => {
                values.push(current.clone());
                current.clear();
                in_quotes = false;
            }
            '"' => in_quotes = true,
            _ if in_quotes => current.push(character),
            _ => {}
        }
    }

    values
}

#[cfg(target_os = "windows")]
fn dedupe_games(games: Vec<GameEntry>) -> Vec<GameEntry> {
    let mut unique = HashMap::new();
    for game in games {
        unique.entry(game.id.clone()).or_insert(game);
    }
    unique.into_values().collect()
}

#[cfg(target_os = "windows")]
fn slugify(value: &str) -> String {
    let mut output = String::new();
    let mut last_was_dash = false;

    for character in value.chars() {
        if character.is_ascii_alphanumeric() {
            output.push(character.to_ascii_lowercase());
            last_was_dash = false;
        } else if !last_was_dash {
            output.push('-');
            last_was_dash = true;
        }
    }

    output.trim_matches('-').to_string()
}

#[cfg(target_os = "windows")]
mod windows_registry {
    use std::path::PathBuf;

    use winreg::{
        enums::{HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ},
        RegKey,
    };

    use crate::models::GameEntry;

    pub fn steam_install_paths() -> Vec<PathBuf> {
        let mut paths = Vec::new();

        for root in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
            if let Some(path) = read_registry_string(root, r"Software\Valve\Steam", "SteamPath") {
                paths.push(PathBuf::from(path));
            }
            if let Some(path) = read_registry_string(root, r"Software\WOW6432Node\Valve\Steam", "InstallPath") {
                paths.push(PathBuf::from(path));
            }
        }

        paths
    }

    pub fn detect_gog_games() -> Vec<GameEntry> {
        let mut games = Vec::new();
        let uninstall_paths = [
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
            r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        ];

        for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
            let root = RegKey::predef(hive);
            for uninstall_path in uninstall_paths {
                let Ok(uninstall_key) = root.open_subkey_with_flags(uninstall_path, KEY_READ) else {
                    continue;
                };

                for key_name in uninstall_key.enum_keys().flatten() {
                    let Ok(game_key) = uninstall_key.open_subkey_with_flags(&key_name, KEY_READ) else {
                        continue;
                    };

                    let display_name: String = game_key.get_value("DisplayName").unwrap_or_default();
                    if display_name.trim().is_empty() {
                        continue;
                    }

                    let publisher: String = game_key.get_value("Publisher").unwrap_or_default();
                    let install_location: String = game_key.get_value("InstallLocation").unwrap_or_default();
                    let looks_like_gog = publisher.to_ascii_lowercase().contains("gog")
                        || key_name.to_ascii_lowercase().contains("gog")
                        || game_key
                            .get_value::<String, _>("URLInfoAbout")
                            .map(|value| value.to_ascii_lowercase().contains("gog.com"))
                            .unwrap_or(false);

                    if !looks_like_gog {
                        continue;
                    }

                    games.push(GameEntry {
                        id: format!("gog-{}", slugify(&key_name)),
                        name: display_name,
                        launcher: "GOG Galaxy".into(),
                        install_path: normalize_value(install_location),
                        save_path: None,
                        source: "gog-registry".into(),
                        confidence: "medium".into(),
                        is_manual: false,
                        is_available: true,
                    });
                }
            }
        }

        games
    }

    fn read_registry_string(root: HKEY, subkey: &str, value_name: &str) -> Option<String> {
        let root = RegKey::predef(root);
        let key = root.open_subkey_with_flags(subkey, KEY_READ).ok()?;
        let value: String = key.get_value(value_name).ok()?;
        normalize_value(value)
    }

    fn normalize_value(value: String) -> Option<String> {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    }

    fn slugify(value: &str) -> String {
        let mut output = String::new();
        let mut last_was_dash = false;

        for character in value.chars() {
            if character.is_ascii_alphanumeric() {
                output.push(character.to_ascii_lowercase());
                last_was_dash = false;
            } else if !last_was_dash {
                output.push('-');
                last_was_dash = true;
            }
        }

        output.trim_matches('-').to_string()
    }
}

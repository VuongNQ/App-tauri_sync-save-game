use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use tauri::{AppHandle, Emitter, Manager};

use crate::{settings, sync};

// ── Watcher Manager ───────────────────────────────────────

pub struct WatcherManager {
    /// game_id → exe_name (lower-cased for case-insensitive comparison).
    tracked_games: HashMap<String, String>,
    /// Per-game sync locks to prevent concurrent syncs.
    sync_locks: HashMap<String, Arc<Mutex<()>>>,
    /// Per-game: whether the game process was running on the last poll tick.
    playing_games: HashMap<String, bool>,
}

impl WatcherManager {
    pub fn new(_app: AppHandle) -> Self {
        Self {
            tracked_games: HashMap::new(),
            sync_locks: HashMap::new(),
            playing_games: HashMap::new(),
        }
    }

    /// Register a game for process-based tracking.
    pub fn start_tracking(&mut self, game_id: &str, exe_name: &str) {
        // Stop any existing tracking entry first (idempotent).
        self.stop_tracking(game_id);

        let key = game_id.to_string();
        // Store exe_name lower-cased for case-insensitive matching on every poll.
        self.tracked_games
            .insert(key.clone(), exe_name.to_lowercase());
        self.sync_locks
            .entry(key.clone())
            .or_insert_with(|| Arc::new(Mutex::new(())));
        self.playing_games.insert(key, false);

        println!("[watcher] Tracking process for game '{game_id}': {exe_name}");
    }

    /// Unregister a game from process-based tracking.
    pub fn stop_tracking(&mut self, game_id: &str) {
        if self.tracked_games.remove(game_id).is_some() {
            self.playing_games.remove(game_id);
            println!("[watcher] Stopped tracking '{game_id}'");
        }
    }

    /// Snapshot of currently tracked games for the poll thread (avoids holding the lock during I/O).
    fn snapshot(&self) -> Vec<(String, String, bool, Arc<Mutex<()>>)> {
        self.tracked_games
            .iter()
            .map(|(id, exe)| {
                let was_playing = *self.playing_games.get(id).unwrap_or(&false);
                let lock = self
                    .sync_locks
                    .get(id)
                    .cloned()
                    .unwrap_or_else(|| Arc::new(Mutex::new(())));
                (id.clone(), exe.clone(), was_playing, lock)
            })
            .collect()
    }

    /// Bulk-update playing state after a poll tick.
    fn update_playing(&mut self, id: &str, is_playing: bool) {
        self.playing_games.insert(id.to_string(), is_playing);
    }
}

// ── Background poll thread ────────────────────────────────

/// Spawn a single background thread that polls running processes every ~7 seconds.
/// Call this ONCE at app startup (from `init_watchers`).
pub fn start_poll_thread(app: AppHandle) {
    std::thread::spawn(move || {
        println!("[watcher] Process poll thread started (interval: 7s)");

        loop {
            std::thread::sleep(Duration::from_secs(7));

            // 1. Snapshot tracked games (lock → collect → unlock immediately).
            let manager_state = app.state::<Arc<Mutex<WatcherManager>>>();
            let snapshot = match manager_state.lock() {
                Ok(m) => m.snapshot(),
                Err(e) => {
                    println!("[watcher] Failed to lock WatcherManager in poll: {e}");
                    continue;
                }
            };

            if snapshot.is_empty() {
                println!("[watcher] Poll tick: no games tracked, sleeping");
                continue;
            }

            println!(
                "[watcher] Poll tick: checking {} game(s): {:?}",
                snapshot.len(),
                snapshot.iter().map(|(id, exe, _, _)| format!("{id}={exe}")).collect::<Vec<_>>()
            );

            // 2. Check which exe_names are currently running (Windows-only).
            #[cfg(target_os = "windows")]
            let running_exes: std::collections::HashSet<String> = {
                use sysinfo::{ProcessesToUpdate, System};
                let mut sys = System::new();
                sys.refresh_processes(ProcessesToUpdate::All, true);
                let all: std::collections::HashSet<String> = sys
                    .processes()
                    .values()
                    .map(|p| p.name().to_string_lossy().to_lowercase())
                    .collect();

                // Log any process name that partially matches a tracked exe (helps spot name mismatches).
                for (_, exe_lower, _, _) in &snapshot {
                    let stem = exe_lower.trim_end_matches(".exe");
                    let matches: Vec<&String> = all
                        .iter()
                        .filter(|name| name.contains(stem))
                        .collect();
                    if matches.is_empty() {
                        println!("[watcher] '{exe_lower}' → not found in running processes");
                    } else {
                        println!("[watcher] '{exe_lower}' → partial matches in process list: {matches:?}");
                    }
                }

                all
            };

            #[cfg(not(target_os = "windows"))]
            let running_exes: std::collections::HashSet<String> =
                std::collections::HashSet::new();

            // 3. Determine state changes and collect actions.
            let mut state_updates: Vec<(String, bool)> = Vec::new();

            for (game_id, exe_name_lower, was_playing, sync_lock) in &snapshot {
                let is_now_playing = running_exes.contains(exe_name_lower.as_str());

                println!(
                    "[watcher] '{game_id}' ({exe_name_lower}): was_playing={was_playing} is_now_playing={is_now_playing}"
                );

                match (was_playing, is_now_playing) {
                    // Newly started
                    (false, true) => {
                        println!("[watcher] Game started: '{game_id}' ({exe_name_lower})");
                        let _ = app.emit(
                            "game-status-changed",
                            serde_json::json!({ "gameId": game_id, "status": "playing" }),
                        );
                        state_updates.push((game_id.clone(), true));
                    }
                    // Just exited
                    (true, false) => {
                        println!("[watcher] Game stopped: '{game_id}' ({exe_name_lower})");
                        let _ = app.emit(
                            "game-status-changed",
                            serde_json::json!({ "gameId": game_id, "status": "idle" }),
                        );

                        // Decide whether to auto-sync.
                        let should_auto_sync = settings::load_state(&app)
                            .ok()
                            .and_then(|s| {
                                s.games
                                    .iter()
                                    .find(|g| g.id == *game_id)
                                    .map(|g| g.auto_sync)
                            })
                            .unwrap_or(false);

                        if should_auto_sync {
                            if let Ok(_guard) = sync_lock.try_lock() {
                                println!(
                                    "[watcher] Auto-sync triggered for '{game_id}' after process exit"
                                );
                                let _ = sync::sync_game(&app, game_id);
                            } else {
                                println!(
                                    "[watcher] Sync already in progress for '{game_id}', skipping"
                                );
                            }
                        } else {
                            let _ = app.emit("game-sync-pending", game_id);
                        }

                        state_updates.push((game_id.clone(), false));
                    }
                    // No change
                    _ => {}
                }
            }

            // 4. Persist state updates (re-acquire lock briefly).
            if !state_updates.is_empty() {
                if let Ok(mut m) = manager_state.lock() {
                    for (id, playing) in state_updates {
                        m.update_playing(&id, playing);
                    }
                }
            }
        }
    });
}

// ── Initialization ────────────────────────────────────────

/// Initialize process tracking for all games that have it enabled.
/// Called once at app startup via `Builder::setup()`.
pub fn init_watchers(app: &AppHandle) {
    let state = match settings::load_state(app) {
        Ok(s) => s,
        Err(e) => {
            println!("[watcher] Failed to load state for init: {e}");
            return;
        }
    };

    {
        let manager_state = app.state::<Arc<Mutex<WatcherManager>>>();
        let mut manager = match manager_state.lock() {
            Ok(m) => m,
            Err(e) => {
                println!("[watcher] Failed to lock WatcherManager: {e}");
                return;
            }
        };

        for game in &state.games {
            if game.track_changes {
                // If a valid exe_path is set for this machine, skip ambient startup registration.
                // The watcher will be armed on-demand when the user clicks Play instead.
                if let Some(raw_path) = &game.exe_path {
                    let expanded = settings::expand_env_vars(raw_path);
                    if std::path::Path::new(&expanded).is_file() {
                        println!(
                            "[watcher] Skipping startup tracking for '{}': valid exe_path found — will arm on Play",
                            game.id
                        );
                        continue;
                    }
                }

                match &game.exe_name {
                    Some(exe) if !exe.is_empty() => {
                        manager.start_tracking(&game.id, exe);
                    }
                    _ => {
                        println!(
                            "[watcher] Skipping '{}': track_changes=true but no exe_name set",
                            game.id
                        );
                    }
                }
            }
        }
    } // release lock before spawning thread

    start_poll_thread(app.clone());
}

// ── Toggle helpers (called from Tauri commands) ───────────

pub fn handle_track_changes_toggle(
    app: &AppHandle,
    game_id: &str,
    enabled: bool,
) -> Result<(), String> {
    let manager_state = app.state::<Arc<Mutex<WatcherManager>>>();
    let mut manager = manager_state
        .lock()
        .map_err(|e| format!("Lock error: {e}"))?;

    if enabled {
        let state =
            settings::load_state(app).map_err(|e| format!("Failed to load state: {e}"))?;
        let game = settings::find_game(&state, game_id)?;

        match &game.exe_name {
            Some(exe) if !exe.is_empty() => {
                manager.start_tracking(game_id, exe);
            }
            _ => {
                println!(
                    "[watcher] Cannot enable tracking for '{game_id}': no exe_name configured"
                );
                // Return Ok so the toggle state is still saved; UI shows a hint.
            }
        }
    } else {
        manager.stop_tracking(game_id);
    }

    Ok(())
}

// ── On-demand arming (Play button) ───────────────────────

/// Arm process tracking for a game that was just launched via the Play button.
/// Only called when `track_changes == true` and `exe_name` is set.
/// This is idempotent — safe to call even if the game is already being tracked.
pub fn arm_on_launch(app: &AppHandle, game_id: &str, exe_name: &str) {
    let arc = app.state::<Arc<Mutex<WatcherManager>>>().inner().clone();
    let Ok(mut manager) = arc.lock() else {
        println!("[watcher] Failed to lock WatcherManager for arm_on_launch");
        return;
    };
    manager.start_tracking(game_id, exe_name);
    println!("[watcher] Armed '{game_id}' for exit tracking (launched via Play)");
}

use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

use notify_debouncer_mini::{new_debouncer, DebouncedEventKind, Debouncer};
use notify::RecommendedWatcher;
use tauri::{AppHandle, Emitter, Manager};

use crate::{settings, sync};

// ── Watcher Manager ───────────────────────────────────────

pub struct WatcherManager {
    app: AppHandle,
    watchers: HashMap<String, Debouncer<RecommendedWatcher>>,
    /// Per-game sync locks to prevent concurrent syncs for the same game.
    sync_locks: HashMap<String, Arc<Mutex<()>>>,
}

impl WatcherManager {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            watchers: HashMap::new(),
            sync_locks: HashMap::new(),
        }
    }

    /// Start watching a game's save folder for file changes.
    pub fn start_watching(&mut self, game_id: &str, save_path: &str) -> Result<(), String> {
        // Stop any existing watcher for this game first
        self.stop_watching(game_id);

        let path = Path::new(save_path);
        if !path.exists() {
            return Err(format!(
                "Save path does not exist: {}",
                path.display()
            ));
        }

        let app_handle = self.app.clone();
        let gid = game_id.to_string();
        let sync_lock = self
            .sync_locks
            .entry(game_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone();

        // Create a debounced watcher with a 2-second debounce window
        let mut debouncer = new_debouncer(
            Duration::from_secs(2),
            move |events: Result<Vec<notify_debouncer_mini::DebouncedEvent>, notify::Error>| {
                match events {
                    Ok(evts) => {
                        // Filter to only actual data changes (not just access-time changes)
                        let has_data_change = evts.iter().any(|e| {
                            matches!(e.kind, DebouncedEventKind::Any)
                        });
                        if !has_data_change {
                            return;
                        }

                        println!("[watcher] Change detected for game: {gid}");

                        // Check if auto_sync is enabled for this game
                        let should_auto_sync = settings::load_state(&app_handle)
                            .ok()
                            .and_then(|state| {
                                state.games.iter().find(|g| g.id == gid).map(|g| {
                                    g.auto_sync
                                        && state.settings.global_auto_sync
                                })
                            })
                            .unwrap_or(false);

                        if should_auto_sync {
                            // Try to acquire the sync lock (non-blocking)
                            if let Ok(_guard) = sync_lock.try_lock() {
                                println!("[watcher] Auto-syncing game: {gid}");
                                let _ = sync::sync_game(&app_handle, &gid);
                            } else {
                                println!("[watcher] Sync already in progress for: {gid}");
                            }
                        } else {
                            // Emit pending-sync event for the frontend
                            let _ = app_handle.emit("game-sync-pending", &gid);
                        }
                    }
                    Err(e) => {
                        println!("[watcher] Error for game event: {e}");
                    }
                }
            },
        )
        .map_err(|e| format!("Failed to create watcher: {e}"))?;

        debouncer
            .watcher()
            .watch(path, notify::RecursiveMode::Recursive)
            .map_err(|e| format!("Failed to watch {}: {e}", path.display()))?;

        println!("[watcher] Started watching {game_id} → {save_path}");
        self.watchers.insert(game_id.to_string(), debouncer);
        Ok(())
    }

    /// Stop watching a game's save folder.
    pub fn stop_watching(&mut self, game_id: &str) {
        if self.watchers.remove(game_id).is_some() {
            println!("[watcher] Stopped watching {game_id}");
        }
    }

    /// Check if a game is currently being watched.
    #[allow(dead_code)]
    pub fn is_watching(&self, game_id: &str) -> bool {
        self.watchers.contains_key(game_id)
    }
}

// ── Initialization ────────────────────────────────────────

/// Initialize watchers for all games that have tracking enabled.
/// Called once at app startup via `Builder::setup()`.
pub fn init_watchers(app: &AppHandle) {
    let state = match settings::load_state(app) {
        Ok(s) => s,
        Err(e) => {
            println!("[watcher] Failed to load state for init: {e}");
            return;
        }
    };

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
            if let Some(ref sp) = game.save_path {
                if let Err(e) = manager.start_watching(&game.id, sp) {
                    println!("[watcher] Failed to start watcher for {}: {e}", game.id);
                }
            }
        }
    }
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
        let state = settings::load_state(app)?;
        let game = state
            .games
            .iter()
            .find(|g| g.id == game_id)
            .ok_or_else(|| format!("Game not found: {game_id}"))?;

        let save_path = game
            .save_path
            .as_deref()
            .ok_or("Save path must be set before enabling tracking")?;

        manager.start_watching(game_id, save_path)?;
    } else {
        manager.stop_watching(game_id);
    }

    Ok(())
}

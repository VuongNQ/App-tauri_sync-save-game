use std::{
    collections::HashMap,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
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
    /// Per-game: timestamp of the most recent detected change (for interval debounce).
    last_change_times: HashMap<String, Arc<Mutex<Instant>>>,
    /// Per-game: whether an interval-debounce timer thread is already running.
    pending_timers: HashMap<String, Arc<AtomicBool>>,
}

impl WatcherManager {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            watchers: HashMap::new(),
            sync_locks: HashMap::new(),
            last_change_times: HashMap::new(),
            pending_timers: HashMap::new(),
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
        let last_change_time = self
            .last_change_times
            .entry(game_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(Instant::now())))
            .clone();
        let pending_timer = self
            .pending_timers
            .entry(game_id.to_string())
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
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

                        // Read auto_sync and sync_interval_minutes from current settings
                        let game_settings = settings::load_state(&app_handle)
                            .ok()
                            .and_then(|state| {
                                let game = state.games.iter().find(|g| g.id == gid)?;
                                let interval = state.settings.sync_interval_minutes;
                                Some((game.auto_sync, interval))
                            });

                        let (should_auto_sync, sync_interval_minutes) =
                            game_settings.unwrap_or((false, 0));

                        // Guard: auto-sync disabled — notify frontend and bail out early.
                        if !should_auto_sync {
                            let _ = app_handle.emit("game-sync-pending", &gid);
                            return;
                        }

                        if sync_interval_minutes == 0 {
                            // Immediate auto-sync (interval = 0 means "on change")
                            if let Ok(_guard) = sync_lock.try_lock() {
                                println!("[watcher] Auto-syncing game: {gid}");
                                let _ = sync::sync_game(&app_handle, &gid);
                            } else {
                                println!("[watcher] Sync already in progress for: {gid}");
                            }
                        } else {
                            // Debounced by interval: sync only after
                            // `sync_interval_minutes` of inactivity from the last change.
                            *last_change_time.lock().unwrap() = Instant::now();

                            // Only one timer thread per game at a time.
                            if !pending_timer.swap(true, Ordering::Relaxed) {
                                let delay =
                                    Duration::from_secs(sync_interval_minutes as u64 * 60);
                                let last_change_clone = last_change_time.clone();
                                let pending_clone = pending_timer.clone();
                                let app_clone = app_handle.clone();
                                let gid_clone = gid.clone();
                                let sync_lock_clone = sync_lock.clone();

                                std::thread::spawn(move || {
                                    let mut sleep_for = delay;
                                    loop {
                                        std::thread::sleep(sleep_for);
                                        let elapsed =
                                            last_change_clone.lock().unwrap().elapsed();
                                        if elapsed >= delay {
                                            // No new change in the last `delay` window.
                                            // Re-read auto_sync in case it was toggled off.
                                            let still_on =
                                                settings::load_state(&app_clone)
                                                    .ok()
                                                    .and_then(|s| {
                                                        s.games
                                                            .iter()
                                                            .find(|g| g.id == gid_clone)
                                                            .map(|g| g.auto_sync)
                                                    })
                                                    .unwrap_or(false);
                                            if still_on {
                                                if let Ok(_guard) =
                                                    sync_lock_clone.try_lock()
                                                {
                                                    println!(
                                                        "[watcher] Interval-debounce sync: {gid_clone}"
                                                    );
                                                    let _ = sync::sync_game(
                                                        &app_clone,
                                                        &gid_clone,
                                                    );
                                                }
                                            }
                                            break;
                                        }
                                        // A newer change arrived during sleep; wait
                                        // the remaining time from that change.
                                        sleep_for = delay - elapsed;
                                    }
                                    pending_clone.store(false, Ordering::Relaxed);
                                });
                            } else {
                                println!(
                                    "[watcher] Change queued (interval timer active): {gid}"
                                );
                            }
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
            self.last_change_times.remove(game_id);
            self.pending_timers.remove(game_id);
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
                let expanded = settings::expand_env_vars(sp);
                if let Err(e) = manager.start_watching(&game.id, &expanded) {
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

        let expanded = settings::expand_env_vars(save_path);
        manager.start_watching(game_id, &expanded)?;
    } else {
        manager.stop_watching(game_id);
    }

    Ok(())
}

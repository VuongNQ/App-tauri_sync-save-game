//! One shared gate for every operation that can change a game's saves.
//! This protects one app process; cross-device coordination is a separate concern.
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

#[derive(Default)]
struct ActiveOperations {
    games: HashSet<String>,
    exclusive: bool,
}

fn active() -> &'static Mutex<ActiveOperations> {
    static ACTIVE: OnceLock<Mutex<ActiveOperations>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(ActiveOperations::default()))
}

pub struct OperationGuard {
    game_id: Option<String>,
}

pub fn acquire(game_id: &str) -> Result<OperationGuard, String> {
    let mut state = active().lock().map_err(|_| "Operation gate unavailable")?;
    if state.exclusive || !state.games.insert(game_id.to_owned()) {
        return Err("SAVE_BUSY: Another save operation is running. Wait for it to finish.".into());
    }
    Ok(OperationGuard {
        game_id: Some(game_id.to_owned()),
    })
}

/// Prevent library replacement, account changes or clearing Drive during a save operation.
pub fn acquire_exclusive() -> Result<OperationGuard, String> {
    let mut state = active().lock().map_err(|_| "Operation gate unavailable")?;
    if state.exclusive || !state.games.is_empty() {
        return Err(
            "SAVE_BUSY: Wait for active save operations before changing accounts or library data."
                .into(),
        );
    }
    state.exclusive = true;
    Ok(OperationGuard { game_id: None })
}

impl Drop for OperationGuard {
    fn drop(&mut self) {
        if let Ok(mut state) = active().lock() {
            match &self.game_id {
                Some(id) => {
                    state.games.remove(id);
                }
                None => state.exclusive = false,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concurrent_callers_cannot_mutate_the_same_game() {
        let held = acquire("test-concurrent-game").unwrap();
        assert!(
            std::thread::spawn(|| acquire("test-concurrent-game").is_err())
                .join()
                .unwrap()
        );
        assert!(acquire("test-independent-game").is_ok());
        assert!(acquire_exclusive().is_err());
        drop(held);
        assert!(acquire("test-concurrent-game").is_ok());
    }

    #[test]
    fn error_paths_release_the_gate() {
        fn fail() -> Result<(), String> {
            let _guard = acquire("test-failed-game")?;
            Err("network interrupted".into())
        }
        assert!(fail().is_err());
        assert!(acquire("test-failed-game").is_ok());
    }
}

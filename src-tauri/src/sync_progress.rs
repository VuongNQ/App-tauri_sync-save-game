//! Per-game sync progress reported to the UI through the `sync-progress` event.
//!
//! Any long-running save operation (manual sync, push/restore, watcher sync,
//! play shortcut, a startup cloud check, ...) can create a [`Reporter`] and move
//! it through phases. The reporter is `Sync`, so parallel transfer workers share
//! one instance; byte updates are throttled so the UI is not flooded.
use serde::Serialize;
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};

pub const EVENT: &str = "sync-progress";
/// Minimum gap between two byte-progress events for the same operation.
const THROTTLE: Duration = Duration::from_millis(150);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    /// Reading local files and the cloud manifest; nothing transferred yet.
    Checking,
    /// Uploading and/or downloading save objects.
    Transferring,
    /// Recovery snapshot, publishing the new revision and applying local files.
    Finalizing,
    /// Operation finished (successfully or not); the UI may hide the bar.
    Done,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProgress {
    pub game_id: String,
    pub phase: Phase,
    pub files_done: u32,
    pub files_total: u32,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub uploads: u32,
    pub downloads: u32,
    /// Relative path of the most recently finished file, if any.
    pub current_file: Option<String>,
}

struct State {
    progress: SyncProgress,
    last_emit: Option<Instant>,
}

/// Where progress goes. Type-erased so code paths that never create an
/// emitting reporter (unit tests) do not link the Tauri event runtime; on
/// Windows that runtime needs the app manifest and a bare test binary fails to
/// start without it.
type Sink = Box<dyn Fn(&SyncProgress) + Send + Sync>;

pub struct Reporter {
    sink: Option<Sink>,
    state: Mutex<State>,
}

impl Reporter {
    pub fn new(app: &AppHandle, game_id: &str) -> Self {
        let app = app.clone();
        Self::build(
            Some(Box::new(move |progress: &SyncProgress| {
                let _ = app.emit(EVENT, progress);
            })),
            game_id,
        )
    }

    /// A reporter that only tracks numbers without emitting (tests, callers
    /// that do not want UI feedback).
    pub fn silent(game_id: &str) -> Self {
        Self::build(None, game_id)
    }

    fn build(sink: Option<Sink>, game_id: &str) -> Self {
        Self {
            sink,
            state: Mutex::new(State {
                progress: SyncProgress {
                    game_id: game_id.to_owned(),
                    phase: Phase::Checking,
                    files_done: 0,
                    files_total: 0,
                    bytes_done: 0,
                    bytes_total: 0,
                    uploads: 0,
                    downloads: 0,
                    current_file: None,
                },
                last_emit: None,
            }),
        }
    }

    pub fn phase(&self, phase: Phase) {
        self.update(true, |p| p.phase = phase);
    }

    /// Announce the transfer plan; switches to [`Phase::Transferring`].
    pub fn begin_transfer(&self, uploads: u32, downloads: u32, bytes_total: u64) {
        self.update(true, |p| {
            p.phase = Phase::Transferring;
            p.uploads = uploads;
            p.downloads = downloads;
            p.files_total = uploads + downloads;
            p.files_done = 0;
            p.bytes_total = bytes_total;
            p.bytes_done = 0;
        });
    }

    /// Bytes moved over the network (called often, throttled).
    pub fn add_bytes(&self, n: u64) {
        self.update(false, |p| {
            p.bytes_done = p
                .bytes_done
                .saturating_add(n)
                .min(p.bytes_total.max(p.bytes_done));
        });
    }

    /// Undo bytes counted for an attempt that is being retried from scratch.
    pub fn rewind_bytes(&self, n: u64) {
        self.update(false, |p| p.bytes_done = p.bytes_done.saturating_sub(n));
    }

    pub fn file_done(&self, relative_path: &str) {
        self.update(true, |p| {
            p.files_done = (p.files_done + 1).min(p.files_total.max(p.files_done + 1));
            p.current_file = Some(relative_path.to_owned());
        });
    }

    pub fn finish(&self) {
        self.phase(Phase::Done);
    }

    pub fn snapshot(&self) -> SyncProgress {
        self.state
            .lock()
            .map(|s| s.progress.clone())
            .unwrap_or_else(|e| e.into_inner().progress.clone())
    }

    fn update(&self, force: bool, f: impl FnOnce(&mut SyncProgress)) {
        let mut state = match self.state.lock() {
            Ok(s) => s,
            Err(e) => e.into_inner(),
        };
        f(&mut state.progress);
        let now = Instant::now();
        let due = force
            || state
                .last_emit
                .is_none_or(|t| now.duration_since(t) >= THROTTLE);
        if !due {
            return;
        }
        state.last_emit = Some(now);
        if let Some(sink) = &self.sink {
            sink(&state.progress);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_files_and_bytes() {
        let r = Reporter::silent("g");
        r.begin_transfer(2, 1, 300);
        r.add_bytes(100);
        r.add_bytes(250);
        let p = r.snapshot();
        assert_eq!(p.phase, Phase::Transferring);
        assert_eq!(p.files_total, 3);
        assert_eq!(p.bytes_done, 300, "bytes are clamped to the total");
        r.rewind_bytes(50);
        r.file_done("a.sav");
        let p = r.snapshot();
        assert_eq!(p.bytes_done, 250);
        assert_eq!(p.files_done, 1);
        assert_eq!(p.current_file.as_deref(), Some("a.sav"));
        r.finish();
        assert_eq!(r.snapshot().phase, Phase::Done);
    }
}

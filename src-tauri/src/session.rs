//! Pin background work to the account that scheduled it. Account replacement is
//! non-blocking and refused while an authenticated request/task holds a lease.
use std::sync::{
    atomic::{AtomicU64, Ordering},
    RwLock, RwLockReadGuard, RwLockWriteGuard,
};
use tauri::AppHandle;

static GATE: RwLock<()> = RwLock::new(());
static EPOCH: AtomicU64 = AtomicU64::new(0);

#[derive(Clone)]
pub struct Snapshot {
    epoch: u64,
    user_id: String,
}
pub struct Lease {
    _guard: RwLockReadGuard<'static, ()>,
}

pub fn change() -> Result<RwLockWriteGuard<'static, ()>, String> {
    GATE.try_write().map_err(|_| "ACCOUNT_BUSY: Wait for account operations to finish before signing out or switching accounts".into())
}

/// Called only while holding change(). A subsequent login to the same Google
/// account is a new session too; queued tasks from the old session are cancelled.
pub fn advance() {
    EPOCH.fetch_add(1, Ordering::SeqCst);
}

pub fn capture(app: &AppHandle) -> Option<Snapshot> {
    let _guard = GATE.try_read().ok()?;
    Some(Snapshot {
        epoch: EPOCH.load(Ordering::SeqCst),
        user_id: crate::gdrive_auth::get_current_user_id(app)?,
    })
}

pub fn lease(app: &AppHandle, expected: &Snapshot) -> Result<Lease, String> {
    let guard = GATE.read().map_err(|_| "Account session unavailable")?;
    if expected.epoch != EPOCH.load(Ordering::SeqCst)
        || crate::gdrive_auth::get_current_user_id(app).as_deref()
            != Some(expected.user_id.as_str())
    {
        return Err("ACCOUNT_CHANGED: Cancelled work from an earlier account session".into());
    }
    Ok(Lease { _guard: guard })
}

pub fn current(app: &AppHandle) -> Result<Lease, String> {
    let expected = capture(app).ok_or("Not authenticated")?;
    lease(app, &expected)
}

pub fn read() -> Result<Lease, String> {
    Ok(Lease {
        _guard: GATE
            .try_read()
            .map_err(|_| "ACCOUNT_BUSY: Account change in progress")?,
    })
}

/// Capture before queueing, pin after the worker starts, and cancel stale work.
pub fn spawn_blocking<T, F>(app: AppHandle, task: F) -> tokio::task::JoinHandle<Result<T, String>>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    let expected = capture(&app).ok_or_else(|| "Not authenticated".to_string());
    tokio::task::spawn_blocking(move || {
        let _lease = lease(&app, &expected?)?;
        task()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn account_replacement_refuses_active_requests_and_succeeds_after_release() {
        let lease = read().unwrap();
        assert!(change().is_err());
        drop(lease);
        let _change = change().unwrap();
        let previous = EPOCH.load(Ordering::SeqCst);
        advance();
        assert_ne!(previous, EPOCH.load(Ordering::SeqCst));
    }
}

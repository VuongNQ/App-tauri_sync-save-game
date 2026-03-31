---
description: "Use when: syncing save-game files to Google Drive, implementing sync logic, modifying sync.rs, modifying watcher.rs, modifying gdrive.rs, adding file-watcher features, changing background tracking, extending sync algorithm, handling sync conflicts, adding sync Tauri commands, creating sync React Query hooks, building sync UI components, emitting or listening to sync events. Covers the full sync pipeline: local file collection, timestamp comparison, Drive upload/download, .sync-meta.json management, file-watcher lifecycle, and frontend sync integration."
---

# Save-Game Sync Service

## Architecture Overview

The sync system spans four Rust modules and their frontend counterparts:

| Module | Responsibility |
|--------|---------------|
| `gdrive.rs` | Google Drive REST API client (folders, upload, download, metadata) |
| `sync.rs` | Per-game sync algorithm (collect → compare → transfer → update) |
| `watcher.rs` | File-system watcher manager (per-game, debounced, with sync locks) |
| `settings.rs` | Persistence for `AppSettings` and `GameEntry` state |

## HTTP Client: `ureq` (Blocking)

All Drive API calls use **`ureq` v3** (blocking sync), consistent with `gdrive_auth.rs`. Never introduce a second HTTP client (e.g. `reqwest`).

### ureq v3 API Gotchas

- **GET requests**: Use `.call()` on the `WithoutBody` builder — `.send()` and `.send_empty()` belong to `WithBody`.
- **POST/PATCH requests**: Use `.send(body_bytes)` on the `WithBody` builder.
- **Read response as bytes**: Use `.into_body().read_to_vec()` — there is no `read_to_end()` on ureq's `Body`.
- **Read response as string**: Use `.into_body().read_to_string()`.
- **Disable status-as-error**: Create agent with `Agent::config_builder().http_status_as_error(false).build()` so caller can inspect `resp.status().as_u16()` for 4xx/5xx.

```rust
// ✅ Correct — GET with .call()
agent().get(url).header("Authorization", &format!("Bearer {token}")).call()

// ✅ Correct — POST with .send()
agent().post(url).content_type("application/json").send(body.as_bytes())

// ❌ Wrong — GET does NOT have .send() or .send_empty()
agent().get(url).send(b"")
```

### 401 Retry Pattern

Wrap every Drive API call: on HTTP 401, force a token refresh via `gdrive_auth::get_access_token()` and retry once before returning error.

```rust
fn drive_get(app: &AppHandle, url: &str) -> Result<(u16, String), String> {
    let resp = do_drive_get(app, url)?;
    if resp.0 == 401 {
        let _ = gdrive_auth::get_access_token(app)?; // force refresh
        return do_drive_get(app, url);
    }
    Ok(resp)
}
```

## Drive Folder Structure

```
appDataFolder/
  game-processing-sync/          ← root folder (ensure_root_folder)
    {game_id}/                   ← per-game folder (ensure_game_folder)
      <save files...>
      .sync-meta.json            ← sync metadata (timestamps + Drive file IDs)
```

- Root folder name: `"game-processing-sync"`, parent: `"appDataFolder"`.
- Per-game folder name: matches `GameEntry.id` exactly.
- Cache `gdrive_folder_id` in `GameEntry` — never search Drive for the same folder twice.

## Sync Algorithm (sync.rs)

### Pipeline

1. Load `GameEntry` from state; validate `save_path` is set.
2. `gdrive::ensure_root_folder()` → `gdrive::ensure_game_folder()`.
3. `gdrive::download_sync_meta()` → `Option<SyncMeta>` + optional file ID.
4. `gdrive::list_files()` in game folder (for Drive file ID lookup).
5. `collect_local_files(save_path)` — recursively walk directory with `walkdir`.
6. **Per-file timestamp comparison** (ISO 8601 string comparison):
   - Local newer → upload (PATCH if `drive_file_id` exists, POST if new).
   - Cloud newer → download from Drive to local path.
   - Equal → skip.
7. Download cloud-only files (present in `SyncMeta` but not locally).
8. Upload updated `.sync-meta.json` with new file entries.
9. Update `GameEntry.last_local_modified` + `last_cloud_modified` to now.

### Conflict Resolution

**Newest wins**, per file, by ISO 8601 timestamp comparison. No manual conflict resolution—the most recently modified version always takes precedence.

### Path Normalization

- **Local paths** (Windows): backslashes (`\`). Use `normalize_optional_path()` in `settings.rs`.
- **Relative paths in SyncMeta / Drive**: forward slashes (`/`). Convert with `.replace('\\', "/")`.
- When downloading cloud files to local: convert back with `.replace('/', "\\")`.

### Multipart Upload Format

Manual boundary construction for `uploadType=multipart`:

```
--{boundary}
Content-Type: application/json; charset=UTF-8

{"name": "save.dat", "parents": ["folderId"]}
--{boundary}
Content-Type: application/octet-stream

<file bytes>
--{boundary}--
```

- **New file** → `POST /upload/drive/v3/files` with `parents` in metadata.
- **Update file** → `PATCH /upload/drive/v3/files/{fileId}` without `parents`.

## File Watcher (watcher.rs)

### WatcherManager Design

- Stored as `Arc<Mutex<WatcherManager>>` in Tauri managed state.
- Holds `HashMap<game_id, Debouncer<RecommendedWatcher>>` + per-game `sync_locks: HashMap<game_id, Arc<Mutex<()>>>`.
- Uses `notify_debouncer_mini` with 2-second debounce window.

### Watcher Lifecycle

| Action | When |
|--------|------|
| `init_watchers(app)` | App startup (`.setup()` callback) — starts watchers for games with `track_changes == true` |
| `start_watching(game_id, save_path)` | User enables tracking toggle, or on init |
| `stop_watching(game_id)` | User disables tracking toggle |

### Auto-Sync Decision

On file change event (after debounce):
1. Check `game.auto_sync && state.settings.global_auto_sync`.
2. If both true → `try_lock()` the per-game sync lock (non-blocking), then `sync::sync_game()`.
3. If lock unavailable → skip (sync already in progress).
4. If auto-sync disabled → emit `"game-sync-pending"` event for frontend notification.

### Important: Sync Locks

Per-game `Arc<Mutex<()>>` prevents concurrent sync for the same game. Always use **non-blocking** `try_lock()` in the watcher callback to avoid deadlocks.

## Tauri Command Patterns

### Sync Commands (async, blocking I/O offloaded)

```rust
#[tauri::command]
async fn sync_game(app: tauri::AppHandle, game_id: String) -> Result<SyncResult, String> {
    tokio::task::spawn_blocking(move || sync::sync_game(&app, &game_id))
        .await
        .map_err(|e| format!("Sync task failed: {e}"))?
}
```

### Toggle Commands (sync, no I/O)

```rust
#[tauri::command]
fn toggle_track_changes(app: tauri::AppHandle, game_id: String, enabled: bool) -> Result<DashboardData, String> {
    settings::update_game_field(&app, &game_id, |g| { g.track_changes = enabled; })?;
    watcher::handle_track_changes_toggle(&app, &game_id, enabled)?;
    let state = settings::load_state(&app)?;
    Ok(DashboardData { games: state.games })
}
```

### Return Types

| Command | Returns |
|---------|---------|
| `sync_game` | `Result<SyncResult, String>` |
| `sync_all_games` | `Result<Vec<SyncResult>, String>` |
| `toggle_track_changes` | `Result<DashboardData, String>` |
| `toggle_auto_sync` | `Result<DashboardData, String>` |
| `get_settings` / `update_settings` | `Result<AppSettings, String>` |

## Rust Events

| Event Name | Payload | Emitted From |
|------------|---------|--------------|
| `"sync-started"` | `game_id: &str` | `sync.rs` — before sync begins |
| `"sync-completed"` | `SyncResult` | `sync.rs` — on success |
| `"sync-error"` | `SyncResult` (with `error` field) | `sync.rs` — on failure |
| `"game-sync-pending"` | `game_id: &str` | `watcher.rs` — change detected but auto-sync disabled |

Frontend listens via `listen()` from `@tauri-apps/api/event` and updates React Query cache.

## Frontend Integration

### Service Layer (`src/services/tauri.ts`)

All sync calls are typed wrappers — no raw `invoke()` outside this file:

```ts
export async function syncGame(gameId: string): Promise<SyncResult> {
  return invoke<SyncResult>("sync_game", { gameId });
}
export async function toggleTrackChanges(gameId: string, enabled: boolean): Promise<DashboardData> {
  return invoke<DashboardData>("toggle_track_changes", { gameId, enabled });
}
```

### React Query Hooks (`src/queries/sync.ts`)

- `useSyncGameMutation()` — calls `syncGame()`, invalidates `DASHBOARD_KEY` on success.
- `useSyncAllMutation()` — calls `syncAllGames()`, invalidates `DASHBOARD_KEY`.
- `useToggleTrackChangesMutation()` — calls `toggleTrackChanges()`, directly sets dashboard cache.
- `useToggleAutoSyncMutation()` — calls `toggleAutoSync()`, directly sets dashboard cache.

**Cache strategy**: Sync mutations invalidate (refetch) because timestamps change server-side. Toggle mutations set cache directly because they return the full updated `DashboardData`.

### Listening to Sync Events

```ts
import { listen } from "@tauri-apps/api/event";

useEffect(() => {
  const unlisten = listen<SyncResult>("sync-completed", ({ payload }) => {
    queryClient.invalidateQueries({ queryKey: DASHBOARD_KEY });
  });
  return () => { unlisten.then(fn => fn()); };
}, [queryClient]);
```

## Data Types

### SyncResult (Rust → TypeScript)

```rust
pub struct SyncResult {
    pub game_id: String,      // gameId
    pub uploaded: u32,         // uploaded
    pub downloaded: u32,       // downloaded
    pub skipped: u32,          // skipped
    pub error: Option<String>, // error: string | null
}
```

### SyncMeta (Drive-side `.sync-meta.json`)

```rust
pub struct SyncMeta {
    pub last_synced: Option<String>,                // ISO 8601
    pub files: HashMap<String, SyncFileMeta>,       // key: relative path (forward slashes)
}

pub struct SyncFileMeta {
    pub modified_time: String,           // ISO 8601
    pub size: u64,
    pub drive_file_id: Option<String>,   // Google Drive file ID
}
```

### AppSettings

```rust
pub struct AppSettings {
    pub global_auto_sync: bool,       // master switch for auto-sync
    pub sync_interval_minutes: u32,   // 0 = only on change
    pub start_minimised: bool,
    pub run_on_startup: bool,
}
```

## Logging Convention

All sync modules log with structured prefix for grep-ability:

```rust
println!("[gdrive] Root folder found: {id}");
println!("[sync] Starting sync for game: {game_id}");
println!("[watcher] Change detected for game: {gid}");
```

## Adding New Sync Features Checklist

1. Add/modify struct in `models.rs` with `#[serde(rename_all = "camelCase")]`.
2. Mirror the type in `src/types/dashboard.ts` (TypeScript names are canonical).
3. Implement Rust logic in the appropriate module (`gdrive.rs`, `sync.rs`, or `watcher.rs`).
4. Add Tauri command in `lib.rs` — use `spawn_blocking` for any I/O.
5. Register in `tauri::generate_handler![...]`.
6. Add typed wrapper in `src/services/tauri.ts`.
7. Add React Query hook in `src/queries/sync.ts` or `src/queries/settings.ts`.
8. Re-export from `src/queries/index.ts`.

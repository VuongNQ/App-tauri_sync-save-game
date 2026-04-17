---
description: "Use when: syncing save-game files to Google Drive, implementing sync logic, modifying sync.rs, modifying watcher.rs, modifying gdrive.rs, modifying drive_mgmt.rs, modifying firestore.rs, adding process-monitoring features, changing background tracking, changing process tracking, adding exeName game executable, extending sync algorithm, handling sync conflicts, adding sync Tauri commands, creating sync React Query hooks, building sync UI components, emitting or listening to sync events, game-status-changed event, game-sync-pending event, sysinfo process poller, syncing library.json or config.json to Google Drive as a file-based database, storing game library or settings in Firestore, implementing Firestore REST API, SyncMeta Firestore mirror, cloud library restore on first login, forced-direction sync (restore from cloud, push to cloud), checking sync structure diff, SyncStructureDiff, Drive file manager, list Drive files, rename Drive file, move Drive file, delete Drive file, version backup, create backup, restore version backup, delete version backup. Covers the full sync pipeline: local file collection, timestamp comparison, Drive upload/download, .sync-meta.json management, Firestore game library/settings/SyncMeta mirror, local-first strategy, process-monitor lifecycle, Drive file management, version snapshots, and frontend sync integration."
---

# Save-Game Sync Service

## Architecture Overview

The sync system spans five Rust modules and their frontend counterparts:

| Module | Responsibility |
|--------|---------------|
| `gdrive.rs` | Google Drive REST API client (folders, upload, download, metadata, rename, move, copy) |
| `firestore.rs` | Firestore REST API client (game library, settings, SyncMeta mirror) |
| `sync.rs` | Per-game sync algorithm (collect → compare → transfer → update) |
| `watcher.rs` | Process monitor / poller — detects game launch/exit, triggers sync on exit |
| `settings.rs` | Persistence for `AppSettings` and `GameEntry` state |
| `drive_mgmt.rs` | Drive file manager + version backup commands (list, rename, move, delete, backup CRUD) |

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
    config.json                  ← AppSettings JSON (LEGACY — migration only)
    library.json                 ← Vec<GameEntry> JSON (LEGACY — migration only)
    {game_id}/                   ← per-game folder (ensure_game_folder)
      <save files...>            ← save_paths[0] files — stored flat in root
      .sync-meta.json            ← sync metadata for save_paths[0]
      path-1/                    ← save_paths[1] files (created by ensure_subfolder)
        <save files...>
        .sync-meta.json          ← separate sync metadata per sub-path
      path-2/                    ← save_paths[2] files, etc.
        ...
      backups/                   ← created on first backup; managed by drive_mgmt.rs
        {ISO-ts} — {label}/  ← one subfolder per snapshot
          <copied save files>
          .backup-meta.json
```

- Root folder name: `"game-processing-sync"`, parent: `"appDataFolder"`.
- Per-game folder name: matches `GameEntry.id` exactly.
- Cache `gdrive_folder_id` in `GameEntry` for save_paths[0]; cache in `save_paths[i].gdrive_folder_id` for i≥1 — never search Drive for the same folder twice.
- `save_paths[0]` uses the game root folder (zero migration for existing installs).
- `save_paths[i≥1]` use `path-{i}/` subfolders created on first sync via `gdrive::ensure_subfolder(app, root_folder_id, "path-{i}")`.
- Each path maintains its own `.sync-meta.json` in its own Drive folder.
- `backups/` is treated as a protected name: shown in the file manager but rename/delete/move are disabled.
- `.sync-meta.json` is treated as a protected name: shown but actions disabled.

## Cloud Library DB Sync (gdrive.rs — Legacy / Migration Only)

> **Superseded by Firestore.** `library.json` and `config.json` on Drive are no longer the live database. `sync_library_to_cloud` and `sync_settings_to_cloud` are **dead code** (marked `#[allow(dead_code)]`). Game library and settings are now mirrored to Firestore via `firestore.rs`. The Drive fetch functions are retained exclusively for the one-time migration path.

### Functions

| Function | Direction | Status |
|----------|-----------|--------|
| `sync_library_to_cloud(app)` | Local → Cloud | **Dead code** — replaced by Firestore |
| `fetch_library_from_cloud(app)` | Cloud → Local | Kept — migration path in `settings::fetch_all_from_firestore` |
| `sync_settings_to_cloud(app)` | Local → Cloud | **Dead code** — replaced by Firestore |
| `fetch_settings_from_cloud(app)` | Cloud → Local | Kept — migration path in `settings::fetch_all_from_firestore` |

---

## Firestore Database (`firestore.rs`)

The `firestore.rs` module is the primary cloud database for game library and settings. It uses the Firestore REST API via the existing `ureq` v3 blocking HTTP client (no new HTTP crate).

### Data Model

```
users/{user_id}/
  games/{game_id}       → GameEntry fields (Firestore typed values, flat document)
  settings/app          → AppSettings fields (Firestore typed values, flat document)
  syncMeta/{game_id}    → { data: stringValue (JSON blob of SyncMeta), gameId: stringValue }
```

- **`games/{game_id}`**: Each `GameEntry` is a separate Firestore document. Field keys match camelCase TypeScript names.
- **`settings/app`**: A single document under the `settings` collection. Key is always `"app"`.
- **`syncMeta/{game_id}`**: SyncMeta is stored as a **JSON blob** (`stringValue`) in a field called `data`. This avoids Firestore restrictions on `/` in field names (file paths like `"saves/slot1.sav"` cannot be Firestore field names).

### Project ID

Compiled in via `option_env!("GOOGLE_CLOUD_PROJECT_ID")` — same pattern as `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`. Set in `src-tauri/.env` for local dev and as a CI secret for release builds.

```rust
const PROJECT_ID: &str = match option_env!("GOOGLE_CLOUD_PROJECT_ID") {
    Some(v) => v,
    None => "",
};
```

### Public Functions

| Function | Operation | Endpoint |
|----------|-----------|---------|
| `save_game(app, user_id, game)` | PATCH (upsert) | `users/{uid}/games/{game_id}` |
| `delete_game(app, user_id, game_id)` | DELETE (idempotent on 404) | `users/{uid}/games/{game_id}` |
| `load_all_games(app, user_id)` | GET collection | `users/{uid}/games` → `Vec<GameEntry>` |
| `save_settings(app, user_id, settings)` | PATCH (upsert) | `users/{uid}/settings/app` |
| `load_settings(app, user_id)` | GET | `users/{uid}/settings/app` → `Option<AppSettings>` |
| `save_sync_meta(app, user_id, game_id, meta)` | PATCH (upsert) | `users/{uid}/syncMeta/{game_id}` |
| `load_sync_meta(app, user_id, game_id)` | GET | `users/{uid}/syncMeta/{game_id}` → `Option<SyncMeta>` |

> `load_sync_meta` is marked `#[allow(dead_code)]` — retained for future cross-device read path. Drive `.sync-meta.json` remains the exclusive read source today.
> **`save_settings` strips local-only fields**: When serialising `AppSettings` to Firestore, **both `pathOverrides` and `pathOverridesIndexed`** fields are **always filtered out** before the write. They are local-only device-specific values and must never be stored in Firestore.
### 401 Retry Pattern (same as gdrive.rs)

Every Firestore call wraps the request: on HTTP 401, force a token refresh via `gdrive_auth::get_access_token()` and retry once.

### Background Spawn Pattern (`settings.rs`)

Because `ureq` is blocking, Firestore writes **must not block the UI**. Use dedicated background threads after every `save_state()` call:

```rust
// After add_game / update_game:
fn spawn_firestore_game_upsert(app: &AppHandle, game: GameEntry) {
    let app_clone = app.clone();
    std::thread::spawn(move || {
        if let Some(uid) = gdrive_auth::get_current_user_id(&app_clone) {
            if let Err(e) = firestore::save_game(&app_clone, &uid, &game) {
                eprintln!("[firestore] save_game failed: {e}");
            }
        }
    });
}

// After remove_game:
fn spawn_firestore_game_delete(app: &AppHandle, game_id: String) {
    let app_clone = app.clone();
    std::thread::spawn(move || {
        if let Some(uid) = gdrive_auth::get_current_user_id(&app_clone) {
            if let Err(e) = firestore::delete_game(&app_clone, &uid, &game_id) {
                eprintln!("[firestore] delete_game failed: {e}");
            }
        }
    });
}

// After update_settings:
fn spawn_firestore_settings_sync(app: &AppHandle) {
    let app_clone = app.clone();
    std::thread::spawn(move || {
        if let (Some(uid), Ok(state)) = (
            gdrive_auth::get_current_user_id(&app_clone),
            settings::load_state(&app_clone),
        ) {
            if let Err(e) = firestore::save_settings(&app_clone, &uid, &state.settings) {
                eprintln!("[firestore] save_settings failed: {e}");
            }
        }
    });
}
```

### First-Login Migration (`settings::fetch_all_from_firestore`)

Called from `lib.rs` → `save_auth_tokens` command after login. Algorithm:

1. Try `firestore::load_all_games()` → if non-empty, use Firestore data as source of truth.
2. If Firestore has zero games → fall back to `gdrive::fetch_library_from_cloud()` for one-time migration.
3. Try `firestore::load_settings()` → if `Some`, use Firestore settings.
4. If `None` → fall back to `gdrive::fetch_settings_from_cloud()` for one-time migration.
5. **Preserve local overrides**: before overwriting settings with the cloud version, copy the current `state.settings.path_overrides` **and `path_overrides_indexed`** into the cloud settings before merging, so device-specific paths are never lost during a cloud restore.
6. Call `settings::save_state()` with merged data.

This ensures existing users (who had Drive `library.json`) are seamlessly migrated to Firestore on first login after upgrade.

---

## SyncMeta Firestore Mirror

After every `upload_sync_meta()` call (in both `sync.rs` and `drive_mgmt.rs`), mirror the written SyncMeta to Firestore as a write-only background operation.

### JSON-Blob Strategy

`SyncMeta.files` has keys that are relative file paths (e.g. `"saves/slot1.sav"`). Firestore field names cannot contain `/`, so the entire `SyncMeta` struct is serialised to a JSON string and stored in a single `stringValue` field called `data`:

```
Firestore: users/{uid}/syncMeta/{game_id} → { data: "<JSON string of SyncMeta>", gameId: "{game_id}" }
```

### Helper Pattern

Both `sync.rs` and `drive_mgmt.rs` use the same private helper after each `upload_sync_meta` call:

```rust
fn spawn_sync_meta_mirror(app: &AppHandle, game_id: &str, meta: crate::models::SyncMeta) {
    let app_c = app.clone();
    let gid = game_id.to_string();
    std::thread::spawn(move || {
        if let Some(uid) = crate::gdrive_auth::get_current_user_id(&app_c) {
            if let Err(e) = crate::firestore::save_sync_meta(&app_c, &uid, &gid, &meta) {
                eprintln!("[firestore] save_sync_meta failed for {gid}: {e}");
            }
        }
    });
}
```

### Call Sites

**`sync.rs`** (4 sites):
- `sync_game_inner` — after upload_sync_meta for normal sync
- `restore_from_cloud_inner` — after upload_sync_meta post-restore
- `push_to_cloud_inner` — after upload_sync_meta post-push
- `cleanup_excluded_from_cloud` — after upload_sync_meta when files are removed

**`drive_mgmt.rs`** (4 sites):
- `rename_game_drive_file` — after SyncMeta rename update
- `move_game_drive_file` — after SyncMeta move update
- `delete_game_drive_file` — after SyncMeta delete update
- `restore_version_backup` — after SyncMeta post-restore update

## Path Utilities (`settings.rs`)

### `expand_env_vars` / `contract_env_vars`

Both functions operate on the same `VARS` array. Supported tokens (most-specific first):

| Token | Windows env var |
|-------|----------------|
| `%TEMP%` | `TEMP` |
| `%LOCALAPPDATA%` | `LOCALAPPDATA` |
| `%APPDATA%` | `APPDATA` |
| `%USERPROFILE%` | `USERPROFILE` |
| `%PROGRAMDATA%` | `PROGRAMDATA` |
| `%PROGRAMFILES%` | `PROGRAMFILES` |

Both `save_path` **and** `exe_path` fields on `GameEntry` are stored with tokens and expanded at runtime via `expand_env_vars()`.

### `pub fn contract_path(path: &str) -> String`

Public wrapper over `contract_env_vars` (normalises backslashes then tokenises). Exposed as the `contract_path` Tauri command. The frontend calls this immediately after a file-picker returns an absolute path so the portable token form is stored and displayed.

### Two-Tier Save Path Storage (Multi-Path)

Each game has **one or more** `SavePathEntry` records in `GameEntry.save_paths`. Each entry has a `label`, `path`, `gdrive_folder_id`, and `sync_excludes`.

| Path index | Portable path storage | Device-specific path storage | Synced to Firestore? |
|---|---|---|---|
| `save_paths[0]` | `SavePathEntry.path` (contains `%`) | `AppSettings.path_overrides[game_id]` | Yes (portable only) |
| `save_paths[i≥1]` | `SavePathEntry.path` (contains `%`) | `AppSettings.path_overrides_indexed["{game_id}:{i}"]` | Yes (portable only) |

Both `path_overrides` and `path_overrides_indexed` are **local-only** — never written to Firestore.

**Routing function**: `route_save_paths(save_paths, game_id, settings)` in `settings.rs` — called on every `add_manual_game` / `upsert_game`. Iterates all entries; routes each normalised path to either `SavePathEntry.path` or the appropriate override map depending on token presence.

**Read function**: `effective_save_paths(game, settings) -> Vec<Option<String>>` — returns the active path for each index (override wins over `save_paths[i].path`). Use this **everywhere** paths are needed at runtime (sync, validate, browse default, watcher).

**Merge function**: `apply_path_overrides(games, settings)` — merges all overrides back into `GameEntry.save_paths[i].path` in-place. **Must be called before every `DashboardData` return** in `lib.rs`. Forgetting this causes `path: null` in the UI for device-specific paths after any mutation.

**One-time migrations** (both run automatically on every `load_state()`):
- `migrate_save_paths_to_vec()` — converts any `GameEntry` without `save_paths` but with legacy `save_path` + `sync_excludes` into `save_paths[0]`.
- `migrate_absolute_save_paths()` — moves any `SavePathEntry.path` without `%` tokens into the appropriate override map.

**`sync_all_games` filter**: Must check `!g.save_paths.is_empty()` to include games with configured paths.

---

### Sync Algorithm (sync.rs)

### Pipeline

1. Load `GameEntry` from state; obtain all effective save paths via `settings::effective_save_paths(game, settings)`. Error if all are `None`.
2. `gdrive::ensure_root_folder()` → `gdrive::ensure_game_folder()` → game root Drive folder.
3. For each index `i` with a configured path:
   - `i == 0`: use `GameEntry.gdrive_folder_id` (the game root folder).
   - `i >= 1`: call `gdrive::ensure_subfolder(app, root_folder_id, "path-{i}")` → cache ID in `save_paths[i].gdrive_folder_id`.
4. Per path: `gdrive::download_sync_meta()` → `Option<SyncMeta>` + optional file ID.
5. Per path: `gdrive::list_files()` in that Drive folder (for Drive file ID lookup).
6. Per path: `collect_local_files(effective_path)` — recursively walk directory with `walkdir`.
7. **Per-file timestamp comparison** (ISO 8601 string comparison):
   - Local newer → upload (PATCH if `drive_file_id` exists, POST if new).
   - Cloud newer → download from Drive to local path.
   - Equal → skip.
8. Per path: download cloud-only files (present in `SyncMeta` but not locally).
9. Per path: upload updated `.sync-meta.json` with new file entries.
10. Accumulate totals across all paths; update `GameEntry.last_local_modified`, `last_cloud_modified`, and `cloud_storage_bytes` (sum across all paths).

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

## Process Monitor (watcher.rs)

> **Architecture changed from file-system watcher to process poller.** `notify` / `notify-debouncer-mini` have been removed. The crate `sysinfo = "0.32"` is used instead.

### WatcherManager Design

- Stored as `Arc<Mutex<WatcherManager>>` in Tauri managed state.
- Fields:
  ```rust
  pub struct WatcherManager {
      tracked_games: HashMap<String, String>,   // game_id → exe_name (lowercased)
      sync_locks:    HashMap<String, Arc<Mutex<()>>>,
      playing_games: HashMap<String, bool>,     // game_id → was_playing last tick
  }
  ```
- NO file-system watchers — no `Debouncer`, no `RecommendedWatcher`.

### Tracking Lifecycle

| Function | When |
|----------|------|
| `init_watchers(app)` | App startup — calls `start_tracking` for games with `track_changes == true`, non-empty `exe_name`, AND **no valid local `exe_path`** (see guard below) |
| `arm_on_launch(app, game_id, exe_name)` | Called from `launch_game` command after successful `open_path()` — guards: `track_changes == true && exe_name` non-empty |
| `start_tracking(game_id, exe_name)` | User enables tracking toggle in Settings (and `exe_name` is set); also called by `arm_on_launch` |
| `stop_tracking(game_id)` | User disables tracking toggle |
| `handle_track_changes_toggle(app, game_id, enabled)` | Tauri command handler for `toggle_track_changes` |

#### `init_watchers` — exe_path guard

If a game has `exe_path` set **and** that path expands to a real file on the current machine (`Path::is_file()` after `expand_env_vars`), it is **skipped** in the startup registration loop. The process watcher is armed on-demand via `arm_on_launch` when the user clicks Play instead.

Games **without** a valid local `exe_path` (field is `None`, or the expanded path doesn't exist) retain the ambient startup-registration behavior.

```rust
// init_watchers inner loop guard
if let Some(raw_path) = &game.exe_path {
    let expanded = settings::expand_env_vars(raw_path);
    if std::path::Path::new(&expanded).is_file() {
        // Skip: watcher will be armed on Play click instead
        continue;
    }
}
```

#### `arm_on_launch` — idempotent arming on Play

```rust
pub fn arm_on_launch(app: &AppHandle, game_id: &str, exe_name: &str) {
    let arc = app.state::<Arc<Mutex<WatcherManager>>>().inner().clone();
    let Ok(mut manager) = arc.lock() else { return; };
    manager.start_tracking(game_id, exe_name);
    println!("[watcher] Armed '{game_id}' for exit tracking (launched via Play)");
}
```

- `start_tracking` is idempotent — safe to call even if already tracked.
- Armed games stay in `tracked_games` for the rest of the session (re-arming on every Play is harmless).
- After game exits, auto-sync / `game-sync-pending` fires as normal.

### Poll Thread (`start_poll_thread`)

A **single** background thread polls all tracked games every **7 seconds**:

```
loop:
  sleep(7s)
  lock WatcherManager → snapshot tracked_games + sync_locks + playing_games → unlock
  #[cfg(target_os = "windows")] refresh sysinfo processes
  for each (game_id, exe_name) in snapshot:
    is_now_playing = process_list contains exe_name (partial / lowercase match)
    was_playing = snapshot.playing_games[game_id]
    if !was_playing && is_now_playing:
      emit "game-status-changed" { gameId, status: "playing" }
    if was_playing && !is_now_playing:  // game just exited
      emit "game-status-changed" { gameId, status: "idle" }
      check game.auto_sync from settings:
        true  → try_lock(sync_lock) → sync::sync_game(app, game_id)
        false → emit "game-sync-pending" { gameId }
  lock WatcherManager → update playing_games → unlock
```

### Windows-Only Guard

Process list refresh is wrapped in `#[cfg(target_os = "windows")]`. On other platforms the `sysinfo` call is a no-op; all games appear as not-playing (safe).

```rust
#[cfg(target_os = "windows")]
let running_exes: HashSet<String> = {
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    sys.processes().values()
        .filter_map(|p| p.exe().and_then(|e| e.file_name()).map(|n| n.to_string_lossy().to_lowercase()))
        .collect()
};
#[cfg(not(target_os = "windows"))]
let running_exes: HashSet<String> = HashSet::new();
```

### Auto-Sync Decision (on process exit)

1. Game process exits (was_playing → !is_now_playing).
2. Emit `"game-status-changed"` with `status: "idle"`.
3. Check `game.auto_sync` from `settings::load_state`.
4. If true → `try_lock()` per-game sync lock (non-blocking) → `sync::sync_game()`.
5. If lock unavailable → skip (sync already in progress).
6. If auto_sync disabled → emit `"game-sync-pending"` for frontend notification.

### Sync Locks

Per-game `Arc<Mutex<()>>` prevents concurrent sync for the same game. Always use **non-blocking** `try_lock()` in the poll loop to avoid deadlocks.

### Diagnostic Logging

Every tick the poll thread logs (prefixed `[watcher]`):
- `Poll tick: no games tracked` — when tracked_games is empty.
- `Poll tick: checking N game(s): [...]` — logged exe names.
- `'exe' → partial matches in process list: [...]` or `'exe' → not found in process list`.
- `[game_id] was_playing=X is_now_playing=Y` — per-game state per tick.
- `Game started: game_id` / `Game stopped: game_id` — on state transitions.

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
    let mut state = settings::update_game_field(&app, &game_id, |g| { g.track_changes = enabled; })?;
    watcher::handle_track_changes_toggle(&app, &game_id, enabled)?;
    settings::apply_path_overrides(&mut state.games, &state.settings);
    Ok(DashboardData { games: state.games })
}
```

> **Critical**: Every command that returns `DashboardData` must call `settings::apply_path_overrides(&mut state.games, &state.settings)` before the return. This ensures device-specific paths (stored in `path_overrides`) are visible in the UI after any mutation.

### Return Types

| Command | Returns |
|---------|----------|
| `sync_game` | `Result<SyncResult, String>` |
| `sync_all_games` | `Result<Vec<SyncResult>, String>` |
| `check_sync_structure_diff` | `Result<SyncStructureDiff, String>` |
| `restore_from_cloud` | `Result<SyncResult, String>` |
| `push_to_cloud` | `Result<SyncResult, String>` |
| `toggle_track_changes` | `Result<DashboardData, String>` |
| `toggle_auto_sync` | `Result<DashboardData, String>` |
| `get_settings` / `update_settings` | `Result<AppSettings, String>` |
| `upload_game_logo` | `Result<(), String>` |
| `clear_all_drive_data` | `Result<DashboardData, String>` |
| `list_game_drive_files` | `Result<Vec<DriveFileItem>, String>` — `folder_id` param is optional; defaults to game root |
| `list_game_drive_files_flat` | `Result<Vec<DriveFileFlatItem>, String>` — full recursive listing with relative paths |
| `rename_game_drive_file` | `Result<(), String>` |
| `move_game_drive_file` | `Result<(), String>` |
| `delete_game_drive_file` | `Result<(), String>` |
| `create_version_backup` | `Result<DriveVersionBackup, String>` |
| `list_version_backups` | `Result<Vec<DriveVersionBackup>, String>` |
| `restore_version_backup` | `Result<SyncResult, String>` |
| `delete_version_backup` | `Result<(), String>` |

## Rust Events

| Event Name | Payload | Emitted From |
|------------|---------|--------------|
| `"sync-started"` | `game_id: &str` | `sync.rs` — before sync begins |
| `"sync-completed"` | `SyncResult` | `sync.rs` — on success |
| `"sync-error"` | `SyncResult` (with `error` field) | `sync.rs` — on failure |
| `"game-sync-pending"` | `game_id: &str` (raw string) | `watcher.rs` — process exited but auto-sync disabled |
| `"game-status-changed"` | `{ gameId, status: "playing" \| "idle" }` | `watcher.rs` — emitted each time game process starts or stops |
| `"library-restored"` | — | `lib.rs` — first-login cloud library restore succeeded |
Frontend listens via `listen()` from `@tauri-apps/api/event` and updates React Query cache.

## Frontend Integration

### Service Layer (`src/services/tauri.ts`)

All sync calls are typed wrappers — no raw `invoke()` outside this file:

```ts
export async function syncGame(gameId: string): Promise<SyncResult> {
  return invoke<SyncResult>("sync_game", { gameId });
}
export async function checkSyncStructureDiff(gameId: string): Promise<SyncStructureDiff> {
  return invoke<SyncStructureDiff>("check_sync_structure_diff", { gameId });
}
export async function restoreFromCloud(gameId: string): Promise<SyncResult> {
  return invoke<SyncResult>("restore_from_cloud", { gameId });
}
export async function pushToCloud(gameId: string): Promise<SyncResult> {
  return invoke<SyncResult>("push_to_cloud", { gameId });
}
export async function toggleTrackChanges(gameId: string, enabled: boolean): Promise<DashboardData> {
  return invoke<DashboardData>("toggle_track_changes", { gameId, enabled });
}
// Logo upload (validates ≤ 3 MB; uploads to game's Drive folder as logo.<ext>):
export async function uploadGameLogo(gameId: string, logoSource: string): Promise<void> {
  return invoke<void>("upload_game_logo", { gameId, logoSource });
}
// Drive file manager:
export async function listGameDriveFiles(gameId: string, folderId?: string): Promise<DriveFileItem[]> {
  return invoke<DriveFileItem[]>("list_game_drive_files", { gameId, folderId });
}
export async function listGameDriveFilesFlat(gameId: string): Promise<DriveFileFlatItem[]> {
  return invoke<DriveFileFlatItem[]>("list_game_drive_files_flat", { gameId });
}
export async function renameGameDriveFile(gameId: string, fileId: string, oldName: string, newName: string, isFolder: boolean): Promise<void> {
  return invoke("rename_game_drive_file", { gameId, fileId, oldName, newName, isFolder });
}
export async function moveGameDriveFile(gameId: string, fileId: string, fileName: string, newParentId: string, oldParentId: string): Promise<void> {
  return invoke("move_game_drive_file", { gameId, fileId, fileName, newParentId, oldParentId });
}
export async function deleteGameDriveFile(gameId: string, fileId: string, fileName: string, isFolder: boolean): Promise<void> {
  return invoke("delete_game_drive_file", { gameId, fileId, fileName, isFolder });
}
// Version backups:
export async function createVersionBackup(gameId: string, label?: string): Promise<DriveVersionBackup> {
  return invoke<DriveVersionBackup>("create_version_backup", { gameId, label: label ?? null });
}
export async function listVersionBackups(gameId: string): Promise<DriveVersionBackup[]> {
  return invoke<DriveVersionBackup[]>("list_version_backups", { gameId });
}
export async function restoreVersionBackup(gameId: string, backupFolderId: string): Promise<SyncResult> {
  return invoke<SyncResult>("restore_version_backup", { gameId, backupFolderId });
}
export async function deleteVersionBackup(gameId: string, backupFolderId: string): Promise<void> {
  return invoke("delete_version_backup", { gameId, backupFolderId });
}
```

### React Query Hooks (`src/queries/sync.ts`)

- `useSyncGameMutation()` — calls `syncGame()`, invalidates `DASHBOARD_KEY` on success.
- `useSyncAllMutation()` — calls `syncAllGames()`, invalidates `DASHBOARD_KEY`.
- `useGetSaveInfoQuery(gameId, enabled?)` — lazy query (not a mutation); fetches save folder metadata. Key: `saveInfoKey(gameId)`.
- `useCheckSyncDiffMutation()` — calls `checkSyncStructureDiff()`, returns `SyncStructureDiff` (no cache side-effect).
- `useRestoreFromCloudMutation()` — calls `restoreFromCloud()`, invalidates `DASHBOARD_KEY` **and `VALIDATE_PATHS_KEY`** on success.
- `usePushToCloudMutation()` — calls `pushToCloud()`, invalidates `DASHBOARD_KEY` on success.
- `useToggleTrackChangesMutation()` — calls `toggleTrackChanges()`, directly sets dashboard cache.
- `useToggleAutoSyncMutation()` — calls `toggleAutoSync()`, directly sets dashboard cache.
- `useDriveFilesQuery(gameId, folderId, enabled?)` — lazy; only fetches when `enabled: true`. Key: `driveFilesFolderKey(gameId, folderId)`.
- `useDriveFilesFlatQuery(gameId, enabled?)` — lazy; fetches full recursive flat listing. Key: `driveFilesFlatKey(gameId)`. `staleTime: Infinity`.
- `useRenameDriveFileMutation()` — invalidates `driveFilesKey(gameId)` **and `driveFilesFlatKey(gameId)`** on success.
- `useMoveDriveFileMutation()` — invalidates `driveFilesKey(gameId)` **and `driveFilesFlatKey(gameId)`** on success.
- `useDeleteDriveFileMutation()` — invalidates `driveFilesKey(gameId)` **and `driveFilesFlatKey(gameId)`** on success.
- `useVersionBackupsQuery(gameId, enabled?)` — lazy. Key: `versionBackupsKey(gameId)`.
- `useCreateVersionBackupMutation()` — invalidates `versionBackupsKey(gameId)` on success.
- `useRestoreVersionBackupMutation()` — invalidates `DASHBOARD_KEY` + `driveFilesKey(gameId)` + **`VALIDATE_PATHS_KEY`** on success.
- `useDeleteVersionBackupMutation()` — invalidates `versionBackupsKey(gameId)` on success.

**Cache strategy**: Sync/restore/push mutations invalidate (refetch) because timestamps change server-side. Toggle mutations set cache directly because they return the full updated `DashboardData`. Diff check has no cache side-effect — result is used locally in the component flow. **Both restore paths (`restoreFromCloud` and `restoreVersionBackup`) invalidate `VALIDATE_PATHS_KEY`** so the save-path-missing warning clears automatically after files are written.

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

### SaveInfo / PathSaveInfo (Rust → TypeScript)

Returned by `get_save_info`. Aggregates files from **all** configured save paths.

```rust
pub struct PathSaveInfo {
    pub label: String,           // label of this save_paths entry
    pub save_path: String,       // effective (unexpanded) path for this index
    pub total_size: u64,
    pub files: Vec<SaveFileInfo>,
}

pub struct SaveInfo {
    pub game_id: String,
    pub save_path: String,       // primary path (save_paths[0]) — backward compat
    pub total_files: u32,        // aggregate across all paths
    pub total_size: u64,         // aggregate across all paths
    pub last_modified: Option<String>,
    pub files: Vec<SaveFileInfo>, // all files from all paths
    pub path_infos: Vec<PathSaveInfo>, // per-path breakdown; EMPTY when only 1 path
}
```

TypeScript mirrors in `src/types/dashboard.ts`:
```ts
export interface PathSaveInfo {
  label: string;
  savePath: string;
  totalSize: number;
  files: SaveFileInfo[];
}
export interface SaveInfo {
  gameId: string;
  savePath: string;
  totalFiles: number;
  totalSize: number;
  lastModified: string | null;
  files: SaveFileInfo[];
  /** Per-path breakdown. Empty when only one path configured. */
  pathInfos: PathSaveInfo[];
}
```

Frontend `SaveInfoPanel` in `SupportUI.tsx`:
- When `pathInfos.length > 1`: renders one labelled `PathInfoSection` card per path, each with its own file tree and open-folder button. Global open-folder button is hidden.
- When `pathInfos.length <= 1`: single-path mode, same as before.

### SyncStructureDiff (Rust → TypeScript)

Returned by `check_sync_structure_diff`. Read-only — no file transfers.

```rust
pub struct SyncStructureDiff {
    pub game_id: String,
    pub cloud_has_data: bool,          // false when no .sync-meta.json on Drive
    pub local_only_files: Vec<String>, // relative paths in local but absent from Drive meta
    pub cloud_only_files: Vec<String>, // relative paths in Drive meta but missing locally
    pub local_newer_files: Vec<String>,// paths where local timestamp > cloud timestamp
    pub cloud_newer_files: Vec<String>,// paths where cloud timestamp > local timestamp
    pub has_diff: bool,                // true when any of the 4 vecs is non-empty
}
```

TypeScript mirror in `src/types/dashboard.ts`:
```ts
export interface SyncStructureDiff {
  gameId: string;
  cloudHasData: boolean;
  localOnlyFiles: string[];
  cloudOnlyFiles: string[];
  localNewerFiles: string[];
  cloudNewerFiles: string[];
  hasDiff: boolean;
}
```

---

## Drive File Manager & Version Backups (`drive_mgmt.rs`)

All commands in this module require the game to have been synced at least once (`gdrive_folder_id` must be set). Helper `require_game_folder()` enforces this gate.

### Protected Items

The following names must **not** be renamed, moved, or deleted via the file manager:
- `.sync-meta.json` — sync algorithm depends on this file's presence and key names
- `backups` — the backup subfolder; contents managed exclusively by backup commands

Frontend shows these items but disables action buttons. Backend commands **do not** enforce this guard — it is frontend-only.

### File Manager Commands

#### `list_game_drive_files`
Calls `gdrive::list_drive_items(app, game_folder_id)` and returns the flat list of items in the game root only.

#### `list_game_drive_files_flat`
Calls `gdrive::list_drive_items_recursive(app, &folder_id, "")` to walk the entire folder tree and returns `Vec<DriveFileFlatItem>` with each item's `relative_path` built from the folder hierarchy. Sub-folders appear as entries with `is_folder: true`. Used by `DriveFilesSection` to render the full tree in a single request.

#### `rename_game_drive_file`
1. Call `gdrive::rename_drive_item(app, file_id, new_name)`.
2. Download `.sync-meta.json` from the game folder.
3. If `old_name` exists as a key in `SyncMeta.files` → rename it to `new_name`.
4. Re-upload the updated `.sync-meta.json`.

#### `move_game_drive_file`
1. Call `gdrive::move_drive_file(app, file_id, new_parent_id, old_parent_id)`.
2. If the file was moved **out of the game root** (i.e. `old_parent_id == game_folder_id`): download `.sync-meta.json`, remove `file_name` key from `SyncMeta.files`, re-upload.
3. Moving a file already in a subfolder is a no-op for sync-meta.

#### `delete_game_drive_file`
1. Call `gdrive::delete_drive_file(app, file_id)` (recursive for folders).
2. Download `.sync-meta.json`, remove `file_name` from `SyncMeta.files`, re-upload.

### Version Backup Commands

#### `create_version_backup`
1. `gdrive::ensure_subfolder(app, game_folder_id, "backups")` → `backups_folder_id`.
2. Generate folder name: `{ISO-8601}` or `{ISO-8601} — {label.trim()}` (em dash ` — ` separator; colons stay since Drive accepts them).
3. `gdrive::ensure_subfolder(app, backups_folder_id, folder_name)` → `backup_folder_id`.
4. List all files in game root; filter out `["backups", ".sync-meta.json"]`.
5. Server-side copy each via `gdrive::copy_drive_file(app, file_id, backup_folder_id)` — no local I/O.
6. Build `BackupMeta { created_time, label, total_files, total_size }` and upload as `.backup-meta.json`.
7. Return `DriveVersionBackup { id: backup_folder_id, name: folder_name, created_time, total_files, total_size }`.

#### `list_version_backups`
1. List items in the game folder; look for a folder named `backups`.
2. If no `backups` folder exists → return empty list immediately (does **not** create it).
3. For each snapshot subfolder inside `backups/`: try downloading `.backup-meta.json`. Parse `BackupMeta`; skip entry if metadata is missing or unparseable.
4. Return sorted newest-first by `created_time`.

#### `restore_version_backup`
1. List save files currently in game root; delete each (except `backups/`).
2. List files in the backup folder; exclude `.backup-meta.json`.
3. For each backup file: `gdrive::copy_drive_file(app, file_id, game_folder_id)` — server-side.
4. Download each file to the local `save_path` (expanding `%VAR%` tokens).
5. Rebuild `.sync-meta.json` with the restored files' metadata; upload.
6. Update `GameEntry.last_local_modified` and `last_cloud_modified` to now via `settings::update_game_field()`.
7. Returns `SyncResult` (files downloaded = count of restored files).
8. **Frontend must invalidate `VALIDATE_PATHS_KEY`** — already handled by `useRestoreVersionBackupMutation`.

#### `delete_version_backup`
1. Verify `backup_folder_id` is a child of the game's `backups/` folder (security check — prevents deleting arbitrary Drive items).
2. List all files inside the backup folder; delete each, then delete the folder itself.

### gdrive.rs Primitives Used by drive_mgmt

| Function | Purpose |
|----------|---------|
| `list_drive_items(app, folder_id)` | Returns `Vec<DriveFileItem>` for all items in a folder |
| `list_drive_items_recursive(app, folder_id, prefix)` | Recursively walks folder tree; returns `Vec<DriveFileFlatItem>` with `relative_path` built from `prefix/item.name` |
| `rename_drive_item(app, file_id, new_name)` | PATCH metadata (name only) |
| `move_drive_file(app, file_id, new_parent_id, old_parent_id)` | PATCH with `addParents`/`removeParents` |
| `copy_drive_file(app, file_id, parent_id)` | POST `/drive/v3/files/{id}/copy` — server-side, no bandwidth |
| `ensure_subfolder(app, parent_id, name)` | Find or create a named subfolder; returns folder ID |
| `delete_drive_file(app, file_id)` | DELETE `/drive/v3/files/{id}` (pub) |
| `upload_json_to_folder(app, folder_id, name, data)` | Upload/replace JSON file (pub) |
| `download_json_from_drive(app, file_id)` | Download JSON bytes → deserialize (pub) |

---

### Forced-Direction Sync Commands

| Command | Behaviour |
|---------|----------|
| `sync_game` | Auto — newest file wins per-file timestamp comparison |
| `restore_from_cloud` | Force-download ALL Drive files unconditionally; local-only files left untouched |
| `push_to_cloud` | Force-upload ALL local files unconditionally; cloud-only files left in Drive |

All three emit `"sync-started"` / `"sync-completed"` / `"sync-error"` events and return `SyncResult`.

### DriveFileItem

```rust
// models.rs
pub struct DriveFileItem {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub size: Option<u64>,
    pub modified_time: Option<String>, // ISO 8601
    pub is_folder: bool,
}
```

TypeScript mirror:
```ts
export interface DriveFileItem {
  id: string;
  name: string;
  mimeType: string;
  size: number | null;
  modifiedTime: string | null;
  isFolder: boolean;
}
```

### DriveFileFlatItem

Returned by `list_game_drive_files_flat`. Contains a `relative_path` for every item in the recursive tree.

```rust
// models.rs
pub struct DriveFileFlatItem {
    pub id: String,
    pub name: String,
    pub relative_path: String,     // e.g. "subfolder/save.dat" — forward slashes
    pub size: Option<u64>,
    pub modified_time: Option<String>, // ISO 8601
    pub is_folder: bool,
    pub parent_folder_id: String,  // Drive folder ID of immediate parent
    /// The `path_file` from SyncMeta matched by this file's Drive ID.
    /// `None` when the file is not tracked in SyncMeta.
    pub sync_path: Option<String>,
}
```

TypeScript mirror:
```ts
export interface DriveFileFlatItem {
  id: string;
  name: string;
  relativePath: string;       // e.g. "76561197960271872/Default_0.sav"
  size: number | null;
  modifiedTime: string | null;
  isFolder: boolean;
  parentFolderId: string;
  /** The `pathFile` from SyncMeta matched by this file's Drive ID. `null` when not tracked. */
  syncPath: string | null;
}
```

### DriveVersionBackup

```rust
// models.rs
pub struct DriveVersionBackup {
    pub id: String,          // Drive folder ID of the backup
    pub name: String,        // folder name: "{ISO-ts}" or "{ISO-ts} — {label}"
    pub created_time: String,// ISO 8601
    pub total_files: u32,
    pub total_size: u64,
}

pub struct BackupMeta {
    pub created_time: String,
    pub label: Option<String>,
    pub total_files: u32,
    pub total_size: u64,
}
```

TypeScript mirror:
```ts
export interface DriveVersionBackup {
  id: string;
  name: string;
  createdTime: string;
  totalFiles: number;
  totalSize: number;
}
```

### SyncMeta (Drive-side `.sync-meta.json`)

```rust
pub struct SyncMeta {
    pub last_synced: Option<String>,           // ISO 8601
    pub files: Vec<SyncFileEntry>,             // list of tracked files
}

pub struct SyncFileEntry {
    pub path_file: String,              // relative path (forward slashes) — key for sync matching
    pub size: u64,
    pub drive_file_id: Option<String>,  // Google Drive file ID
}
```

### AppSettings

```rust
pub struct AppSettings {
    pub sync_interval_minutes: u32,   // 0 = only on change
    pub start_minimised: bool,
    pub run_on_startup: bool,
}

// StoredState includes last_cloud_library_modified for DB conflict detection
pub struct StoredState {
    pub version: u32,
    pub games: Vec<GameEntry>,
    pub settings: AppSettings,
    pub last_cloud_library_modified: Option<String>, // ISO 8601 of last Drive library write
}
```

## Storage Quota (Per-User, Per-Sync)

**Hard limit: 200 MB total cloud storage per user** across all games.

Enforced in `sync_game_inner()` before any upload occurs:

```rust
const STORAGE_LIMIT_BYTES: u64 = 200 * 1024 * 1024;
```

### Enforcement Algorithm

1. Call `projected_game_cloud_bytes(&local_files, &cloud_meta)` — computes projected bytes for the current game (local file sizes + cloud-only file sizes).
2. Sum `cloud_storage_bytes` from all **other** games in local state (no Drive API call needed — fast).
3. If `other_games_bytes + projected_this_game > STORAGE_LIMIT_BYTES` → return `Err(...)` with a human-readable message before any upload.
4. On successful sync, update `GameEntry.cloud_storage_bytes` to the actual sum of all file sizes in the new `SyncMeta`.

### `GameEntry.cloud_storage_bytes`

- Rust type: `Option<u64>` with `#[serde(default)]` — old library files without the field deserialize as `None`.
- TypeScript type: `cloudStorageBytes: number | null`.
- Updated only after a successful `sync_game_inner()` via `settings::update_game_field()`.
- `None` / `null` means this game has never been synced; treated as `0` in quota calculations.

## Logging Convention

All sync modules log with structured prefix for grep-ability:

```rust
println!("[gdrive] Root folder found: {id}");
println!("[sync] Starting sync for game: {game_id}");
println!("[watcher] Change detected for game: {gid}");
println!("[drive_mgmt] Creating backup for game: {game_id}");
```

## Adding New Sync Features Checklist

1. Add/modify struct in `models.rs` with `#[serde(rename_all = "camelCase")]`.
2. Mirror the type in `src/types/dashboard.ts` (TypeScript names are canonical).
3. Implement Rust logic in the appropriate module (`gdrive.rs`, `sync.rs`, `watcher.rs`, or `drive_mgmt.rs`).
4. Add Tauri command in `lib.rs` — use `spawn_blocking` for any I/O.
5. Register in `tauri::generate_handler![...]`.
6. Add typed wrapper in `src/services/tauri.ts`.
7. Add React Query hook in `src/queries/sync.ts` or `src/queries/settings.ts`.
8. Re-export from `src/queries/index.ts`.
9. If the command writes files locally (restore): invalidate `VALIDATE_PATHS_KEY` in `onSuccess` so the save-path warning refreshes.

---
description: "Use when: syncing save-game files to Google Drive, implementing sync logic, modifying sync.rs, modifying watcher.rs, modifying gdrive.rs, modifying drive_mgmt.rs, adding file-watcher features, changing background tracking, extending sync algorithm, handling sync conflicts, adding sync Tauri commands, creating sync React Query hooks, building sync UI components, emitting or listening to sync events, syncing library.json or config.json to Google Drive as a file-based database, implementing cloud library restore on first login, forced-direction sync (restore from cloud, push to cloud), checking sync structure diff, SyncStructureDiff, Drive file manager, list Drive files, rename Drive file, move Drive file, delete Drive file, version backup, create backup, restore version backup, delete version backup. Covers the full sync pipeline: local file collection, timestamp comparison, Drive upload/download, .sync-meta.json management, cloud DB library/settings sync, local-first strategy, file-watcher lifecycle, Drive file management, version snapshots, and frontend sync integration."
---

# Save-Game Sync Service

## Architecture Overview

The sync system spans four Rust modules and their frontend counterparts:

| Module | Responsibility |
|--------|---------------|
| `gdrive.rs` | Google Drive REST API client (folders, upload, download, metadata, rename, move, copy) |
| `sync.rs` | Per-game sync algorithm (collect → compare → transfer → update) |
| `watcher.rs` | File-system watcher manager (per-game, debounced, with sync locks) |
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
    config.json                  ← AppSettings JSON (global configuration)
    library.json                 ← Vec<GameEntry> JSON (game library table)
    {game_id}/                   ← per-game folder (ensure_game_folder)
      <save files...>            ← flat list; SyncMeta keys are relative paths (forward slashes)
      .sync-meta.json            ← sync metadata (timestamps + Drive file IDs)
      backups/                   ← created on first backup; managed by drive_mgmt.rs
        {ISO-ts} — {label}/  ← one subfolder per snapshot (ensure_subfolder)
          <copied save files>    ← server-side copies of non-meta save files
          .backup-meta.json      ← BackupMeta JSON (created_time, label, stats)
```

- Root folder name: `"game-processing-sync"`, parent: `"appDataFolder"`.
- Per-game folder name: matches `GameEntry.id` exactly.
- Cache `gdrive_folder_id` in `GameEntry` — never search Drive for the same folder twice.
- `library.json` and `config.json` are flat files directly under the root folder.
- **Save files are stored flat** in the game root — no recursive subfolders except `backups/`.
- `backups/` is treated as a protected name: shown in the file manager but rename/delete/move are disabled.
- `.sync-meta.json` is treated as a protected name: shown but actions disabled.

## Cloud Library DB Sync (gdrive.rs)

`library.json` and `config.json` on Drive act as the zero-cost, user-owned database.

### Functions

| Function | Direction | Trigger |
|----------|-----------|---------|
| `sync_library_to_cloud(app)` | Local → Cloud | After every `add_game`, `update_game`, `remove_game` — background thread |
| `fetch_library_from_cloud(app)` | Cloud → Local | First login or missing local `games-library.json` |
| `sync_settings_to_cloud(app)` | Local → Cloud | After every `update_settings` — background thread |
| `fetch_settings_from_cloud(app)` | Cloud → Local | First login (alongside library fetch) |

### Conflict Resolution for library.json / config.json

Use Drive's `modifiedTime` returned by `GET /drive/v3/files/{id}?fields=modifiedTime`:

1. Fetch Drive file `modifiedTime` before any write.
2. Compare against `last_cloud_library_modified` stored in local `StoredState`.
3. Drive newer → pull and merge cloud version to local first.
4. Write new merged version to Drive; update `last_cloud_library_modified`.

### Local-First Strategy (Non-negotiable)

`ureq` is blocking — cloud library writes **must not block the UI**:

```rust
// Mandatory pattern after every save_state() call that modifies games/settings:
let app_clone = app.clone();
std::thread::spawn(move || {
    if let Err(e) = gdrive::sync_library_to_cloud(&app_clone) {
        eprintln!("[gdrive] Cloud library sync failed: {e}");
    }
});
```

UI always reads from the local `games-library-{user_id}.json` file (or fallback `games-library.json` when unauthenticated) — never waits on network calls.

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
9. Update `GameEntry.last_local_modified`, `last_cloud_modified`, and `cloud_storage_bytes` (sum of all synced file sizes) to now / actual bytes.

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
1. Check `game.auto_sync`.
2. If true → `try_lock()` the per-game sync lock (non-blocking), then `sync::sync_game()`.
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
| `"game-sync-pending"` | `game_id: &str` | `watcher.rs` — change detected but auto-sync disabled || `"library-restored"` | — | `lib.rs` — first-login cloud library restore succeeded |
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
- `useGetSaveInfoMutation()` — calls `getSaveInfo(gameId)` as a mutation (no cache side-effect); used on demand in the UI.
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
1. Find or create `backups/` subfolder via `ensure_subfolder`.
2. List items inside; keep only folders.
3. For each, try downloading `.backup-meta.json`. Parse `BackupMeta`; fall back to folder metadata if missing.
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

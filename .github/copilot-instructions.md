# Copilot Instructions — Save Game Sync Tool (Tauri 2 + React 19 + Rust)

## Product Overview

This is a **Windows desktop tool** built with Tauri 2 that tracks and syncs save-game files to Google Drive. Every game's information is **manually input by the user** — the tool does not auto-detect games from launchers. The tool runs in the **system tray** at Windows startup so it can monitor save-game file changes in the background.

### Core Features

1. **Game Library** — Users manually add games with: name, description, logo/thumbnail (local file or URL), source (Manual, Emulator), and save-game folder location.
2. **Google Drive Sync** — All game save data is synced to Google Drive via the Google Drive API. OAuth 2.0 authentication is required before the app is usable.
3. **Background Tracking** — The app runs in the background (system tray) on Windows startup. Per-game **process tracking** monitors whether the game executable is running; syncs save files when the process exits (**default: off**, user must opt-in per game and set the game's executable name `exeName`).
4. **Auto-Sync** — When enabled, automatically backs up local save files to Google Drive whenever changes are detected.
5. **Conflict Resolution** — On each sync, compare the local file's last-modified timestamp with the Google Drive version's timestamp; always pick the **newest** save.
6. **Device Management** — Each Windows machine that signs in is automatically registered in Firestore with a deterministic UUID (SHA-256 of `MachineGuid`), hostname, OS, CPU, and RAM info. Users can rename or remove devices from the `/devices` page.

---

## Architecture

```
src/                            # React + TypeScript frontend
  types/dashboard.ts            # Shared TypeScript interfaces (source of truth for shape)
  services/tauri.ts             # All invoke() calls — only place that talks to Rust
  App.tsx                       # Root component with React Router
  pages/                        # Route-level page components
  components/                   # Reusable UI components
  queries/                      # React Query hooks (auth, dashboard, sync, settings)
  utils/index.ts                # Shared helper functions (norm, msg, formatLocalTime)

src-tauri/src/
  models.rs                     # Rust data types (mirrors types/dashboard.ts)
  settings.rs                   # JSON persistence (load_state / save_state)
  gdrive_auth.rs                # OAuth token management (persist, refresh, check status)
  gdrive.rs                     # Google Drive API client (upload, download, list, folders)
  watcher.rs                    # Process monitor / poller — detects game launch/exit, triggers sync on exit
  sync.rs                       # Sync logic: compare timestamps, upload/download newest save
  devices.rs                    # Device UUID generation (SHA-256 MachineGuid), sysinfo collection, device CRUD commands
  tray.rs                       # System-tray setup and background lifecycle
  lib.rs                        # Tauri commands wired to handler functions
```

---

## Authentication — Google OAuth 2.0

- Authentication uses **`tauri-plugin-google-auth`** — a Tauri plugin that handles browser-based OAuth in an external window. No local HTTP server or PKCE code is needed in our codebase.
- On app launch the frontend checks auth status via a Tauri command. If not authenticated, the UI **must** redirect to a login/connect page before showing the dashboard.
- Access and refresh tokens are stored as JSON at `{app_data_dir()}/oauth-tokens.json` (plain file — OS keyring migration is a future enhancement).
- The frontend routing guards all dashboard routes — unauthenticated users see only the Google sign-in page.

### OAuth Flow (Plugin-based)

1. Frontend calls `getOAuthCredentials()` → Rust returns `CLIENT_ID` + `CLIENT_SECRET` (compiled in via `option_env!()`).
2. Frontend passes credentials to `@choochmeque/tauri-plugin-google-auth-api` `signIn()` which opens the browser OAuth consent screen.
3. Plugin handles the full redirect flow and returns `{ accessToken, refreshToken, expiresAt }`.
4. Frontend calls `saveAuthTokens(payload)` → Rust persists tokens to `oauth-tokens.json`, then immediately fetches `/oauth2/v2/userinfo` to capture the stable Google `id` and re-saves the token file with `user_id` populated. Emits `"auth-status-changed"` event.
5. On subsequent launches, Rust silently refreshes the access token via `POST https://oauth2.googleapis.com/token` with `grant_type=refresh_token`.

### Token Lifecycle (`gdrive_auth.rs`)

- `check_auth_status()` → returns `AuthStatus { authenticated }` based on token file existence.
- `get_access_token()` → loads tokens, checks expiry, refreshes if needed, returns valid access token.
- `logout()` → deletes token file + emits `"auth-status-changed"` event.
- `get_google_user_info()` → `GET https://www.googleapis.com/oauth2/v2/userinfo`; returns `GoogleUserInfo { id, email, name, picture }`.
- `get_current_user_id()` → reads `user_id` from stored token file; returns `Some(id)` if present and non-empty, else `None`.

### Google OAuth Scopes

`openid`, `email`, `profile`, `drive.file`, `drive.appdata`, `datastore`

> `datastore` is required for Firestore REST API access (game library, settings, SyncMeta). Re-login is required when adding this scope to an existing install.

---

## Data Model

### GameEntry (all fields user-supplied)

| Field | Rust type | TS type | Description |
|---|---|---|---|
| `id` | `String` | `string` | Stable key: `manual-{slug}` with collision suffix |
| `name` | `String` | `string` | Display name |
| `description` | `Option<String>` | `string \| null` | User-provided description |
| `thumbnail` | `Option<String>` | `string \| null` | Local file path **or** remote URL for logo/thumbnail |
| `source` | `String` | `string` | One of: `"manual"`, `"emulator"` |
| `path_mode` | `String` | `string` | `"auto"` (default) or `"per_device"`. Controls how save-path override keys are keyed: `"auto"` uses plain `game_id`; `"per_device"` uses `"{game_id}:{device_id}"`. Old records without this field deserialize as `"auto"` via `#[serde(default)]`. |
| `save_paths` | `Vec<SavePathEntry>` | `SavePathEntry[]` | Ordered list of save-game folder entries. Primary path is index 0. Users can add multiple paths (e.g. memcards + save states). See `SavePathEntry` below. |
| `exe_name` | `Option<String>` | `string \| null` | Game executable filename (e.g. `"MyGame.exe"`); used by the process monitor to detect when the game is running |
| `exe_path` | `Option<String>` | `string \| null` | Full path to the game executable (e.g. `%PROGRAMFILES%\Steam\game.exe`); used by the `launch_game` command. **LOCAL-ONLY — never synced to Firestore or Drive; stripped to `None` before any cloud write; restored from local state after any cloud-to-local overwrite.** |
| `track_changes` | `bool` | `boolean` | Monitor game process and sync on exit (default `false`) |
| `auto_sync` | `bool` | `boolean` | Automatically sync on change detection (default `false`) |
| `last_local_modified` | `Option<String>` | `string \| null` | ISO 8601 timestamp of last known local save modification (max across all paths) |
| `last_cloud_modified` | `Option<String>` | `string \| null` | ISO 8601 timestamp of last Google Drive save version |
| `gdrive_folder_id` | `Option<String>` | `string \| null` | Google Drive root folder ID for this game's saves |
| `cloud_storage_bytes` | `Option<u64>` | `number \| null` | Total bytes stored in Drive across **all** paths; `None` = never synced |

### SavePathEntry

Each entry in `GameEntry.save_paths`:

| Field | Rust type | TS type | Description |
|---|---|---|---|
| `label` | `String` | `string` | User-defined label (e.g. `"Memcard"`, `"Save States"`) |
| `path` | `Option<String>` | `string \| null` | Portable `%VAR%` path, or `None` if device-specific (stored in `path_overrides` / `path_overrides_indexed`) |
| `gdrive_folder_id` | `Option<String>` | `string \| null` | Drive folder ID for this path. Index 0 uses `GameEntry.gdrive_folder_id` (root); index i≥1 uses `save_paths[i].gdrive_folder_id` (subfolder `path-{i}/`) |
| `sync_excludes` | `Vec<String>` | `string[]` | Relative paths excluded from Drive sync for this specific path; trailing `/` means folder prefix |

### DeviceInfo

Stored in Firestore at `users/{user_id}/devices/{device_id}`. Never stored in the local `games-library-*.json`.

| Field | Rust type | TS type | Description |
|---|---|---|---|
| `id` | `String` | `string` | Deterministic UUID: first 16 bytes of SHA-256(`MachineGuid`) in `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` format |
| `name` | `String` | `string` | User-editable display name (initially set to hostname) |
| `hostname` | `String` | `string` | `System::host_name()` from sysinfo |
| `os_name` | `String` | `string` | OS name (e.g. `"Windows"`) |
| `os_version` | `String` | `string` | OS version string |
| `cpu_name` | `String` | `string` | CPU brand string from sysinfo |
| `cpu_cores` | `u32` | `number` | Physical CPU core count |
| `total_ram_mb` | `u64` | `number` | Total RAM in MB |
| `registered_at` | `String` | `string` | ISO 8601 timestamp of first registration (preserved on upsert) |
| `last_seen_at` | `String` | `string` | ISO 8601 timestamp updated every app startup |
| `is_current` | `bool` (never stored) | `boolean \| undefined` | Computed locally — `true` on the device returned by the current machine; **never written to Firestore** |

> **Legacy fields** (`save_path: Option<String>`, `sync_excludes: Vec<String>` on `GameEntry`) are kept on the Rust struct with `#[serde(default, skip_serializing_if)]` for migration deserialization only. They are never written by current code.

### Serialisation Convention

**All Rust structs use `#[serde(rename_all = "camelCase")]`**, so `save_path` in Rust maps to `savePath` in TypeScript. TypeScript types in `src/types/dashboard.ts` are the canonical field names. Never diverge from this.

---

## Critical Data-Flow Pattern

Every Tauri command returns the **full `DashboardData`** — games are never mutated in the frontend state directly. The pattern is:

```
Rust command → Result<DashboardData, String> → invoke<DashboardData>() → applyDashboard()
```

For sync-specific commands, a `SyncResult` type may be returned alongside or instead of `DashboardData`.

> **`apply_path_overrides` rule**: Before returning any `DashboardData`, every command in `lib.rs` **must** call `settings::apply_path_overrides(&mut state.games, &state.settings)`. This merges device-specific paths from `AppSettings.path_overrides` (index 0) and `path_overrides_indexed` (index i≥1) back into each `GameEntry.save_paths[i].path` so the frontend always receives non-null paths. Forgetting this causes paths to appear as `null` in the UI after any mutation.

### All Tauri Commands

```rust
tauri::generate_handler![
    // Dashboard
    load_dashboard, add_manual_game, update_game, remove_game, clear_all_drive_data,
    // Auth
    check_auth_status, save_auth_tokens, get_oauth_credentials, logout, get_google_user_info,
    // Settings
    get_settings, update_settings,
    // Sync — auto
    get_save_info, sync_game, sync_all_games,
    // Sync — library restore from cloud
    sync_library_from_cloud,
    // Sync — forced direction + diff check
    check_sync_structure_diff, restore_from_cloud, push_to_cloud,
    toggle_track_changes, toggle_auto_sync,
    // Validation
    validate_save_paths, get_browse_default_path, expand_save_path,
    // Path utilities
    contract_path,
    // Game launcher
    launch_game,
    // Logo
    upload_game_logo,
    // Drive file management
    list_game_drive_files, list_game_drive_files_flat,
    rename_game_drive_file, move_game_drive_file, delete_game_drive_file,
    create_version_backup, list_version_backups, restore_version_backup, delete_version_backup,
    // Device management
    get_devices, rename_device, remove_device,
]
```

---

## Cloud Database — Firestore (Primary) + Google Drive (Save Files)

**Firestore is the live database** for game library and settings. Google Drive `appDataFolder` stores only save-game files and per-game sync metadata. The old `library.json` / `config.json` Drive files are **legacy — kept solely for one-time migration** of data from older installs.

### Folder Structure on Drive (`appDataFolder`)

```
appDataFolder/
  game-processing-sync/
    config.json          # LEGACY — AppSettings backup; read once for migration to Firestore only
    library.json         # LEGACY — Vec<GameEntry> backup; read once for migration to Firestore only
    games/
      {game_id}/
        <save files...>  # save_paths[0] files — stored flat in root
        .sync-meta.json  # timestamps + file hashes for save_paths[0]
        path-1/          # save_paths[1] files (created by ensure_subfolder)
          <save files...>
          .sync-meta.json
        path-2/          # save_paths[2] files, etc.
          ...
```

### Firestore Collection Structure

```
users/{user_id}/games/{game_id}     # GameEntry documents (primary game library)
users/{user_id}/settings/app        # AppSettings document (key is always "app")
users/{user_id}/syncMeta/{game_id}  # SyncMeta documents (per-game sync state)
users/{user_id}/devices/{device_id} # DeviceInfo documents (one per registered machine)
```

### Why Firestore

- **Primary source of truth** for game library and settings — syncs across devices in real-time.
- **Drive** is used only for actual save-game binary/data files and `.sync-meta.json`.
- `firestore.rs` uses the Firestore REST API with the same OAuth token as Drive.

### Firestore Sync Functions (`firestore.rs` + `settings.rs`)

| Function | Direction | Trigger |
|----------|-----------|---------|
| `firestore::save_game(app, user_id, game)` | Local → Cloud | After every `add_game`, `update_game`. Spawned in a background thread via `spawn_firestore_game_upsert`. |
| `firestore::delete_game(app, user_id, game_id)` | Local → Cloud | After `remove_game`. Spawned in a background thread via `spawn_firestore_game_delete`. |
| `firestore::save_settings(app, user_id, settings)` | Local → Cloud | After every `update_settings` call. |
| `firestore::load_all_games(app, user_id)` | Cloud → Local | On first login via `fetch_all_from_firestore`. |
| `firestore::load_settings(app, user_id)` | Cloud → Local | On first login via `fetch_all_from_firestore`. |
| `settings::fetch_all_from_firestore(app)` | Cloud → Local | On first login; called from `save_auth_tokens` and `restore_from_cloud`. |
| `firestore::save_device(app, user_id, device)` | Local → Cloud | Called by `devices::register_current_device()` on every startup and post-login. |
| `firestore::load_all_devices(app, user_id)` | Cloud → Local | Called by `devices::get_devices_cmd()`. |
| `firestore::delete_device(app, user_id, device_id)` | Cloud delete | Called by `devices::remove_device_cmd()`. |

### Legacy Drive JSON Files (Migration Only)

`sync_library_to_cloud()` and `sync_settings_to_cloud()` in `gdrive.rs` are **dead code** (`#[allow(dead_code)]`) — they are **never called** in the current app. `fetch_library_from_cloud()` and `fetch_settings_from_cloud()` are only called inside `settings::fetch_all_from_firestore()` on the **one-time migration path**: when Firestore returns 0 games, the app checks Drive for a legacy `library.json` and migrates it into Firestore once. After that, Drive JSON files are never touched again.

### Local-First Strategy (Performance)

Because `ureq` is **blocking**, Firestore sync must never block the UI:

- UI data always reads from `games-library-{user_id}.json` on disk (fast). Falls back to `games-library.json` when unauthenticated or on old token files without `user_id`.
- After `settings::save_state()` completes, `spawn_firestore_game_upsert` / `spawn_firestore_game_delete` fire in background threads.
- Mirror the `WatcherManager` background-thread pattern: use a dedicated thread, not the main Tauri thread.

### Stored State Shape (extended)

```rust
pub struct StoredState {
    pub version: u32,
    pub games: Vec<GameEntry>,
    pub settings: AppSettings,
    pub last_cloud_library_modified: Option<String>, // ISO 8601 — legacy field, used only during migration
}
```

`AppSettings` includes **two** local-only path-override fields that are **never synced to Firestore**:

```rust
pub struct AppSettings {
    pub sync_interval_minutes: u32,
    pub start_minimised: bool,
    pub run_on_startup: bool,
    /// Override map for save_paths[0]. Key format depends on GameEntry.path_mode:
    ///   "auto"       → "{game_id}"
    ///   "per_device" → "{game_id}:{device_id}"
    #[serde(default)]
    pub path_overrides: HashMap<String, String>,
    /// Override map for save_paths[i≥1]. Key format:
    ///   "auto"       → "{game_id}:{i}"
    ///   "per_device" → "{game_id}:{device_id}:{i}"
    #[serde(default)]
    pub path_overrides_indexed: HashMap<String, String>,
}
```

TypeScript mirror (`src/types/dashboard.ts`):

```ts
export interface AppSettings {
  syncIntervalMinutes: number;
  startMinimised: boolean;
  runOnStartup: boolean;
  /**
   * Device-specific save-path overrides for save_paths[0]. Local-only — never synced to Firestore.
   * Key: "{gameId}" for "auto" games; "{gameId}:{deviceId}" for "per_device" games.
   */
  pathOverrides: Record<string, string>;
  /**
   * Device-specific save-path overrides for save_paths[i≥1]. Local-only — never synced to Firestore.
   * Key: "{gameId}:{i}" for "auto" games; "{gameId}:{deviceId}:{i}" for "per_device" games.
   */
  pathOverridesIndexed: Record<string, string>;
}
```

---

## Google Drive Sync Logic (Save Files)

### Sync Algorithm (per game)

1. Call `settings::effective_save_paths(game, settings)` → `Vec<Option<String>>` (one entry per `save_paths` element).
2. For each index `i` with a configured path:
   - If `i == 0`: use `GameEntry.gdrive_folder_id` as the Drive folder (existing root).
   - If `i >= 1`: call `gdrive::ensure_subfolder(app, root_folder_id, "path-{i}")` → cache the returned ID in `save_paths[i].gdrive_folder_id`.
3. Fetch `.sync-meta.json` from that path's Drive folder.
4. **Storage quota check** (pre-upload): sum projected bytes for this game + `cloud_storage_bytes` from all other games. Reject if total exceeds **200 MB per user**.
5. **Compare**: if local is newer → upload local saves to Drive. If Drive is newer → download Drive saves to local. If equal → no-op.
6. After sync, update `.sync-meta.json` on Drive and `last_local_modified` / `last_cloud_modified` / `cloud_storage_bytes` (sum across all paths) in local state.

### Background Process Monitor

- Uses `sysinfo = "0.32"` — polls the OS process list every **7 seconds** (no file-system watcher).
- `WatcherManager` struct: `tracked_games: HashMap<game_id, exe_name>` + `sync_locks: HashMap<game_id, Arc<Mutex<()>>>` + `playing_games: HashMap<game_id, bool>`.
- Only active for games where `track_changes == true` **and** `exe_name` is set.
- `start_poll_thread(app)` spawns one permanent background thread that loops every 7 s:
  - Snapshot tracked games → refresh process list (Windows-only `#[cfg]`) → diff `was_playing` vs `is_now_playing` per exe.
  - On **game start**: emit `"game-status-changed"` `{ gameId, status: "playing" }`.
  - On **game exit**: emit `"game-status-changed"` `{ gameId, status: "idle" }` → check `auto_sync` → `try_lock()` per-game mutex → `sync::sync_game()` or emit `"game-sync-pending"`.
- `init_watchers()` is called at app startup. For each game with `track_changes == true`: if `exe_path` expands to a real file on this machine (`Path::is_file()`), **skip startup registration** — the watcher is armed on-demand when the user clicks Play. Only games without a valid local `exe_path` register at startup.
- `arm_on_launch(app, game_id, exe_name)` — called from `launch_game` command after successful `open_path()`; guards: `track_changes == true && exe_name` non-empty. Idempotent (calls `start_tracking` which handles duplicates).
- Process list refresh is wrapped in `#[cfg(target_os = "windows")]` — non-Windows is a safe no-op.

---

## Frontend — React Router Structure

The frontend uses **React Router** for navigation. The app shell includes a persistent sidebar/nav.

### Routes

| Path | Component | Auth Required | Description |
|---|---|---|---|
| `/login` | `LoginPage` | No | Google OAuth sign-in |
| `/` | `DashboardPage` | Yes | Game library overview |
| `/game/:id` | `GameDetailPage` | Yes | Single game detail + sync controls |
| `/devices` | `DevicesPage` | Yes | Device management — rename / remove registered machines |
| `/settings` | `SettingsPage` | Yes | Global sync settings, account info |

### Auth Guard

A route wrapper or layout component checks `isAuthenticated` (from Tauri command). Unauthenticated requests redirect to `/login`.

---

## System Tray & Background Mode

- The app minimises to system tray instead of closing (configurable in settings).
- On Windows startup, the app launches minimised to tray (opt-in setting, managed via Windows registry `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`).
- Tray context menu: "Open Dashboard", "Sync All Now", separator, "Quit".
- Double-clicking the tray icon shows/focuses the main window.
- The file watcher and auto-sync continue running while the app is in the tray.

---

## Game ID Scheme

- All games: `manual-{slugified_name}` with numeric suffix for collisions (handled by `ensure_unique_id` in `settings.rs`).
- IDs are stable keys — sync metadata on Google Drive references them.

---

## Save Path Portability (Windows Env-Var Tokens)

Save paths are stored with Windows environment-variable tokens instead of hardcoded user names so they work across accounts and machines. Paths that cannot be tokenised (e.g. on a non-system drive like `D:\Games\...`) are stored as device-specific overrides.

### Multi-Path Storage Architecture

Each game has **one or more** `SavePathEntry` records in `GameEntry.save_paths`. Each entry has a `label`, `path`, `gdrive_folder_id`, and `sync_excludes`.

The override map key depends on `GameEntry.path_mode`:

| `path_mode` | Path index | Override map | Override key |
|---|---|---|---|
| `"auto"` | 0 | `path_overrides` | `"{game_id}"` |
| `"auto"` | i≥1 | `path_overrides_indexed` | `"{game_id}:{i}"` |
| `"per_device"` | 0 | `path_overrides` | `"{game_id}:{device_id}"` |
| `"per_device"` | i≥1 | `path_overrides_indexed` | `"{game_id}:{device_id}:{i}"` |

`device_id` = SHA-256(`MachineGuid`) UUID from `devices::get_machine_device_id()`. Falls back to `"unknown"` on non-Windows.

Both `path_overrides` and `path_overrides_indexed` are **local-only** — never written to Firestore. For `"per_device"` games `SavePathEntry.path` is always `None` in Firestore — each device stores its own path in the local override map.

### Key Functions (`settings.rs`)

`build_override_key(game_id, path_mode, index, device_id) -> String` — **single source of truth** for override map key construction. Called by `route_save_paths`, `effective_save_paths`, and `apply_path_overrides`. Never construct these keys manually elsewhere.

`route_save_paths(save_paths, game_id, settings, path_mode)` — routes each `SavePathEntry.path` to either the portable field or the correct device-keyed override map. Called on every `add_manual_game` / `upsert_game`.

`effective_save_paths(game, settings) -> Vec<Option<String>>` — returns the active path for each index (override wins over `save_paths[i].path`). Use **everywhere** a path is needed at runtime.

`effective_save_path(game, settings)` — shim returning `effective_save_paths(...)[0]`. Kept `#[allow(dead_code)]`.

`apply_path_overrides(games, settings)` — merges all overrides back into `GameEntry.save_paths[i].path` **in-place**. **Must be called before every `DashboardData` return** in `lib.rs`.

### Storage contract
- `normalize_optional_path()` (called on every add/update) calls `contract_env_vars()` which replaces known user-folder prefixes with `%VAR%` tokens.
- Replacement priority (most-specific first): `TEMP` → `LOCALAPPDATA` → `APPDATA` → `USERPROFILE` → `PROGRAMDATA` → `PROGRAMFILES`.
- Example: `C:\Users\vuong\AppData\Local\Game\Saves` → `%LOCALAPPDATA%\Game\Saves`.
- Example: `D:\Games\PCSX2\memcards` → no token match → stored in `path_overrides`, `save_paths[0].path = None`.

### Expansion contract
- `expand_env_vars(path)` in `settings.rs` is the **single** expansion function; call it everywhere a path is used as a real filesystem path.
- All sync functions use `effective_save_paths()` (plural), not singular.
- Paths are **displayed to users with tokens (or as-is for device-specific)** — this is intentional.

### One-time migration
`migrate_save_paths_to_vec()` runs automatically on every `load_state()` call. Any existing `GameEntry` with no `save_paths` but a legacy `save_path` + `sync_excludes` is converted to `save_paths[0]`. Safe to run repeatedly.

`migrate_absolute_save_paths()` also runs on load. Any `SavePathEntry.path` without `%` tokens is moved to the appropriate override map.

`migrate_per_device_override_keys()` also runs on load (pass 3). For `"per_device"` games, upgrades old plain-`game_id` override keys (`"game_id"` / `"game_id:i"`) to the device-ID-keyed format (`"game_id:device_id"` / `"game_id:device_id:i"`). The old vs new format is distinguished by whether the part after the colon is a bare integer (old) or a UUID (new).

### New-device UX
When a `SavePathEntry.path` is `null` (device-specific path not configured for this machine), `SavePathCard` in `GameSettingsForm` shows a blue info banner prompting the user to Browse. The banner auto-dismisses when the field is filled.

### `expand_save_path` Tauri command
- Lets the frontend expand a stored path to an absolute path on demand (e.g. for the folder-picker dialog `defaultPath`).
- Frontend wrapper: `expandSavePath(path: string): Promise<string>` in `src/services/tauri.ts`.

### `contract_path` Tauri command
- Converts an absolute path back to a portable token path (e.g. `C:\Program Files\Steam\game.exe` → `%PROGRAMFILES%\Steam\game.exe`).
- Called immediately after a file-picker returns a path so the tokenised form is stored and displayed.
- Frontend wrapper: `contractPath(path: string): Promise<string>` in `src/services/tauri.ts`.
- Used by `GameExecutableSection` (exe picker) and `SavePathCard.handleBrowse()` (save-folder picker) so stored paths are always portable.
- Note: save-folder paths that are device-specific are stored as-is (no token) — only `exe_path` is tokenised via `contract_path`.

### `launch_game` Tauri command
- Loads `GameEntry.exe_path` from state, expands env-var tokens via `expand_env_vars`, then opens the executable via `app.opener().open_path()`.
- After a successful launch, calls `watcher::arm_on_launch()` if `track_changes == true` and `exe_name` is set — arming the process watcher on-demand.
- Requires `tauri-plugin-opener` with capability `opener:allow-open-path { path: "**" }`.

### Frontend rules
In `SavePathCard.handleBrowse()`: if the stored path contains `%`, call `expandSavePath()` before extracting the parent directory for the folder-picker `defaultPath`. Device-specific paths (no `%`) are used directly.

In `GameExecutableSection.handleBrowse()` (game settings form): after the file-picker returns an absolute `.exe` path, call `contractPath()` and store the result — never store raw absolute paths.

---

## Persistence

`settings.rs` persists all game data and app settings to a **per-user file** keyed by the authenticated Google account's stable numeric ID:
`{app_data_dir()}/games-library-{user_id}.json`

Falls back to `{app_data_dir()}/games-library.json` when unauthenticated or when the token file predates `user_id` capture (old installs).

One-time migration: on the first login after an update, if the user-scoped file does not exist but the legacy shared file does, `settings_path()` renames it automatically.

The file is read via `app.path().app_data_dir()` (Tauri `Manager` trait). Always call `load_state` → mutate → `save_state` — never write the file directly.

### Stored State Shape

```rust
pub struct StoredState {
    pub version: u32,
    pub games: Vec<GameEntry>,
    pub settings: AppSettings,
    pub last_cloud_library_modified: Option<String>, // ISO 8601 of last Drive library write
}

pub struct AppSettings {
    pub start_minimised: bool,       // launch to tray on Windows startup
    pub run_on_startup: bool,        // register in Windows Run key
    pub sync_interval_minutes: u32,  // periodic sync interval (0 = only on change)
    pub path_overrides: HashMap<String, String>, // key: "{game_id}" (auto) or "{game_id}:{device_id}" (per_device). Local-only.
    pub path_overrides_indexed: HashMap<String, String>, // key: "{game_id}:{i}" (auto) or "{game_id}:{device_id}:{i}" (per_device). Local-only.
}
```

---

## Windows-Only Code Guards

System tray, file watcher, and registry operations are gated:
```rust
#[cfg(target_os = "windows")]
fn register_startup(...) { /* write HKCU Run key */ }

#[cfg(not(target_os = "windows"))]
fn register_startup(...) { /* no-op */ }
```

`winreg` is a Windows-only dependency in `Cargo.toml`:
```toml
[target.'cfg(windows)'.dependencies]
winreg = "0.55"
```

Correct imports for winreg 0.55: `use winreg::enums::HKEY_LOCAL_MACHINE;` and `use winreg::RegKey;`. Open a predefined key with `RegKey::predef(HKEY_LOCAL_MACHINE)`. Do **not** import from `winreg::HKEY` — that path does not exist.

---

## Key Dependencies

### Rust (`Cargo.toml`)

| Crate | Purpose |
|---|---|
| `tauri` 2 (feature `tray-icon`) | App framework |
| `tauri-plugin-dialog` | Folder/file picker |
| `tauri-plugin-opener` | Open files/URLs in default apps |
| `tauri-plugin-google-auth` 0.5 | Browser-based Google OAuth |
| `serde` + `serde_json` | Serialisation |
| `ureq` 3 (feature `json`) | **Blocking** HTTP client for Google Drive API |
| `tokio` 1 (feature `rt`) | Async runtime (for sync tasks) |
| `sysinfo` 0.32 | Process list polling + system info collection (CPU brand, RAM, hostname) — use `RefreshKind::new()` not `RefreshKind::nothing()` |
| `chrono` 0.4 (feature `serde`) | Timestamp handling |
| `walkdir` 2 | Recursive directory traversal |
| `sha2` 0.10 | File hashing |
| `base64` 0.22 | Base64 encoding |
| `open` 5 | Open URLs in system browser |
| `urlencoding` 2 | URL encoding |
| `fastrand` 2 | Random number generation |
| `winreg` 0.55 | Windows registry (startup registration) |

### Frontend (`package.json`)

| Package | Purpose |
|---|---|
| `react` 19 + `react-dom` | UI framework |
| `react-router` 7 | Client-side routing (not `react-router-dom`) |
| `@tanstack/react-query` 5 | Server-state management (Tauri commands) |
| `@tauri-apps/api` 2 | Tauri IPC bridge |
| `@tauri-apps/plugin-dialog` 2 | Dialog bindings |
| `@tauri-apps/plugin-opener` 2 | Opener bindings |
| `@choochmeque/tauri-plugin-google-auth-api` 0.5 | Google OAuth plugin JS bindings |
| `react-hook-form` 7 + `@hookform/resolvers` 5 | Form handling |
| `zod` 4 | Schema validation for forms |
| `tailwindcss` 4 | Styling |

---

## Developer Workflows

**Dev mode** (requires Rust toolchain on PATH):
```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
npm run tauri -- dev        # starts Vite + Tauri hot-reload
```

**Frontend-only check** (no Rust needed):
```powershell
npm run build               # tsc + vite build — catches all TS/CSS errors
```

**Release installer** (produces `.msi` + NSIS `.exe` under `src-tauri/target/release/bundle/`):
```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
npm run tauri -- build
```

> cargo is installed via rustup at `%USERPROFILE%\.cargo\bin`. If a new terminal doesn't find `cargo`, prepend that directory as shown above.

---

## Adding a New Tauri Command

1. Add the handler function signature in `lib.rs` using `AppHandle` as first argument.
2. Return `Result<DashboardData, String>` (or an appropriate result type).
3. Add it to `tauri::generate_handler![...]` in `lib.rs`.
4. Add a typed wrapper in `src/services/tauri.ts` using `invoke<T>()`.

---

## Key Tauri Plugins

- `tauri-plugin-dialog` — folder/file picker (`open()` from `@tauri-apps/plugin-dialog`)
- `tauri-plugin-opener` — opens files/URLs in system default apps
- `tauri-plugin-google-auth` — browser-based Google OAuth flow (`signIn()` / `signOut()` from `@choochmeque/tauri-plugin-google-auth-api`)
- All must be registered in `lib.rs` via `.plugin(...)` **and** listed under `capabilities/default.json` (`"dialog:default"`, `"opener:default"`, `"google-auth:default"`).

---

## Security Notes

- **Never** store Google OAuth client secrets in frontend code. `CLIENT_ID` and `CLIENT_SECRET` are compiled into the Rust binary via `option_env!()` and served to the frontend only through a Tauri command.
- Tokens are currently stored as plain JSON at `{app_data_dir()}/oauth-tokens.json`. Future: migrate to OS keyring (keep `load_tokens`/`save_tokens` as the I/O boundary to make this swap easy).
- CSP in `tauri.conf.json` should allow connections only to `accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com`, and `localhost`.

---

## Tauri Events

The Rust backend emits these events that the frontend can listen to:

| Event | Payload | Emitted by |
|---|---|---|
| `"auth-status-changed"` | — | `gdrive_auth.rs` on login/logout |
| `"library-restored"` | — | `lib.rs` when first-login cloud library restore succeeds |
| `"post-login-sync-completed"` | — | `lib.rs` after post-login sync-all-from-Drive finishes (success or error) |
| `"sync-started"` | `{ gameId }` | `sync.rs` before sync begins |
| `"sync-completed"` | `SyncResult` | `sync.rs` after successful sync |
| `"sync-error"` | `{ gameId, error }` | `sync.rs` on sync failure |
| `"game-sync-pending"` | `{ gameId }` | `watcher.rs` when game exits but auto-sync disabled |
| `"game-status-changed"` | `{ gameId, status: "playing" \| "idle" }` | `watcher.rs` on game process start/exit |

---

## Logging Convention

All `println!` / `eprintln!` statements use grep-friendly prefixes:
- `[gdrive]` — Google Drive API calls
- `[sync]` — Sync operations
- `[watcher]` — File watcher events

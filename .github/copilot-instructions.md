# Copilot Instructions — Save Game Sync Tool (Tauri 2 + React 19 + Rust)

## Product Overview

This is a **Windows desktop tool** built with Tauri 2 that tracks and syncs save-game files to Google Drive. Every game's information is **manually input by the user** — the tool does not auto-detect games from launchers. The tool runs in the **system tray** at Windows startup so it can monitor save-game file changes in the background.

### Core Features

1. **Game Library** — Users manually add games with: name, description, logo/thumbnail (local file or URL), source (Manual, Emulator), and save-game folder location.
2. **Google Drive Sync** — All game save data is synced to Google Drive via the Google Drive API. OAuth 2.0 authentication is required before the app is usable.
3. **Background Tracking** — The app runs in the background (system tray) on Windows startup. Per-game file-change tracking watches the save-game folder for modifications (**default: off**, user must opt-in per game).
4. **Auto-Sync** — When enabled, automatically backs up local save files to Google Drive whenever changes are detected.
5. **Conflict Resolution** — On each sync, compare the local file's last-modified timestamp with the Google Drive version's timestamp; always pick the **newest** save.

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
  watcher.rs                    # File-system watcher for background save-game tracking
  sync.rs                       # Sync logic: compare timestamps, upload/download newest save
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
4. Frontend calls `saveAuthTokens(payload)` → Rust persists tokens to `oauth-tokens.json` and emits `"auth-status-changed"` event.
5. On subsequent launches, Rust silently refreshes the access token via `POST https://oauth2.googleapis.com/token` with `grant_type=refresh_token`.

### Token Lifecycle (`gdrive_auth.rs`)

- `check_auth_status()` → returns `AuthStatus { authenticated }` based on token file existence.
- `get_access_token()` → loads tokens, checks expiry, refreshes if needed, returns valid access token.
- `logout()` → deletes token file + emits `"auth-status-changed"` event.
- `get_google_user_info()` → `GET https://www.googleapis.com/oauth2/v2/userinfo`.

### Google OAuth Scopes

`openid`, `email`, `profile`, `drive.file`, `drive.appdata`

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
| `save_path` | `Option<String>` | `string \| null` | Absolute path to local save-game folder |
| `track_changes` | `bool` | `boolean` | Watch this game's save folder for file changes (default `false`) |
| `auto_sync` | `bool` | `boolean` | Automatically sync on change detection (default `false`) |
| `last_local_modified` | `Option<String>` | `string \| null` | ISO 8601 timestamp of last known local save modification |
| `last_cloud_modified` | `Option<String>` | `string \| null` | ISO 8601 timestamp of last Google Drive save version |
| `gdrive_folder_id` | `Option<String>` | `string \| null` | Google Drive folder ID where saves are stored |

### Serialisation Convention

**All Rust structs use `#[serde(rename_all = "camelCase")]`**, so `save_path` in Rust maps to `savePath` in TypeScript. TypeScript types in `src/types/dashboard.ts` are the canonical field names. Never diverge from this.

---

## Critical Data-Flow Pattern

Every Tauri command returns the **full `DashboardData`** — games are never mutated in the frontend state directly. The pattern is:

```
Rust command → Result<DashboardData, String> → invoke<DashboardData>() → applyDashboard()
```

For sync-specific commands, a `SyncResult` type may be returned alongside or instead of `DashboardData`.

### All Tauri Commands

```rust
tauri::generate_handler![
    // Dashboard
    load_dashboard, add_manual_game, update_game, remove_game,
    // Auth
    check_auth_status, save_auth_tokens, get_oauth_credentials, logout, get_google_user_info,
    // Settings
    get_settings, update_settings,
    // Sync
    get_save_info, sync_game, sync_all_games,
    toggle_track_changes, toggle_auto_sync,
    // Validation
    validate_save_paths, get_browse_default_path,
]
```

---

## Google Drive Sync Logic

### Folder Structure on Drive

```
appDataFolder/
  game-processing-sync/
    {game_id}/
      <save files...>
      .sync-meta.json       # timestamps + file hashes for conflict detection
```

Use the `drive.appdata` scope to keep all data in the hidden app folder.

### Sync Algorithm (per game)

1. Read local save folder → collect file paths + `last_modified` timestamps.
2. Fetch `.sync-meta.json` from the game's Drive folder → get `last_cloud_modified`.
3. **Compare**: if local is newer → upload local saves to Drive. If Drive is newer → download Drive saves to local. If equal → no-op.
4. After sync, update `.sync-meta.json` on Drive and `last_local_modified` / `last_cloud_modified` in local state.

### Background File Watcher

- Uses `notify` + `notify-debouncer-mini` with a **2-second debounce** window.
- `WatcherManager` holds a `HashMap<game_id, Debouncer<RecommendedWatcher>>` + per-game `Arc<Mutex<()>>` sync locks.
- Only active for games where `track_changes == true`.
- On detected change: check `game.auto_sync && settings.global_auto_sync`. If true → `try_lock()` the per-game mutex (non-blocking) and run `sync::sync_game()`. If lock unavailable → skip (sync already in progress). If auto-sync disabled → emit `"game-sync-pending"` event.
- `init_watchers()` is called at app startup; starts watchers for all eligible games.
- The watcher runs in a dedicated background thread managed by the Tauri app lifecycle.

---

## Frontend — React Router Structure

The frontend uses **React Router** for navigation. The app shell includes a persistent sidebar/nav.

### Routes

| Path | Component | Auth Required | Description |
|---|---|---|---|
| `/login` | `LoginPage` | No | Google OAuth sign-in |
| `/` | `DashboardPage` | Yes | Game library overview |
| `/game/:id` | `GameDetailPage` | Yes | Single game detail + sync controls |
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

## Persistence

`settings.rs` persists all game data and app settings to:
`{app_data_dir()}/games-library.json`

The file is read via `app.path().app_data_dir()` (Tauri `Manager` trait). Always call `load_state` → mutate → `save_state` — never write the file directly.

### Stored State Shape

```rust
pub struct StoredState {
    pub version: u32,
    pub games: Vec<GameEntry>,
    pub settings: AppSettings,
}

pub struct AppSettings {
    pub start_minimised: bool,       // launch to tray on Windows startup
    pub run_on_startup: bool,        // register in Windows Run key
    pub global_auto_sync: bool,      // master switch for auto-sync
    pub sync_interval_minutes: u32,  // periodic sync interval (0 = only on change)
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

Import `HKEY` from `winreg::HKEY` (not `winreg::enums::HKEY` — that path does not exist in 0.55).

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
| `tokio` 1 (feature `rt`) | Async runtime (for watcher tasks) |
| `notify` 8 + `notify-debouncer-mini` 0.6 | Filesystem watcher with debounce |
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
| `"sync-started"` | `{ gameId }` | `sync.rs` before sync begins |
| `"sync-completed"` | `SyncResult` | `sync.rs` after successful sync |
| `"sync-error"` | `{ gameId, error }` | `sync.rs` on sync failure |
| `"game-sync-pending"` | `{ gameId }` | `watcher.rs` when change detected but auto-sync disabled |

---

## Logging Convention

All `println!` / `eprintln!` statements use grep-friendly prefixes:
- `[gdrive]` — Google Drive API calls
- `[sync]` — Sync operations
- `[watcher]` — File watcher events

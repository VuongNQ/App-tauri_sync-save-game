# Save Game Sync

A **Windows desktop tool** built with [Tauri 2](https://tauri.app/) that tracks and syncs save-game files to Google Drive. Games are added manually — no launcher auto-detection. The app runs in the **system tray** at Windows startup to monitor save-game file changes in the background.

---

## Features

- **Game Library** — Manually add games with name, description, logo/thumbnail, source, and save-game folder location.
- **Google Drive Sync** — All save data is synced to Google Drive via OAuth 2.0. Authentication is required before using the app.
- **Background Tracking** — Process-based monitoring per game: detects when the game `.exe` starts/stops and syncs saves on exit (default: off, user opts in per game and sets the executable name).
- **Auto-Sync** — Automatically backs up local saves to Drive when changes are detected.
- **Conflict Resolution** — Compares local vs. Drive `last_modified` timestamps and always picks the newest save.
- **Game Launcher** — Launch games directly from the app (Play button on each game card and detail page). Before launching, the latest save is automatically restored from Google Drive so the newest cloud save is always loaded first.
- **In-App Updater** — Checks GitHub Releases for new versions and installs them automatically.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop framework | Tauri 2 |
| Frontend | React 19, TypeScript 5.8+, TailwindCSS 4, Vite 7 |
| Routing | React Router 7 |
| Server state | TanStack React Query 5 |
| Forms | react-hook-form 7 + Zod 4 |
| HTTP (Rust) | ureq 3 (blocking) |
| Process monitor | sysinfo 0.32 (7-second poll, replaces file-system watcher) |
| Auth | tauri-plugin-google-auth 0.5 (browser-based OAuth) |
| Cloud DB | Firestore REST API (game library, settings, sync metadata) |

---

## Architecture

```
src/                          # React + TypeScript frontend
  types/dashboard.ts          # Shared TypeScript interfaces (source of truth)
  services/tauri.ts           # All invoke() calls — only place that talks to Rust
  App.tsx                     # Root component with React Router
  pages/                      # Route-level page components
  components/                 # Reusable UI components
  queries/                    # React Query hooks (auth, dashboard, sync, settings)
  utils/index.ts              # Shared helpers (norm, msg, formatLocalTime)

src-tauri/src/
  models.rs                   # Rust data types (mirrors types/dashboard.ts)
  settings.rs                 # JSON persistence (load_state / save_state) + Firestore spawn helpers
  gdrive_auth.rs              # OAuth token management (persist, refresh, check status)
  gdrive.rs                   # Google Drive API client (upload, download, list, folders)
  firestore.rs                # Firestore REST API client (game library, settings, SyncMeta mirror)
  watcher.rs                  # Process monitor / poller — detects game launch/exit, triggers sync on exit
  sync.rs                     # Sync logic: compare timestamps, upload/download newest save
  drive_mgmt.rs               # Drive file manager + version backup commands
  tray.rs                     # System-tray setup and background lifecycle
  lib.rs                      # Tauri commands wired to handler functions
```

---

## Cloud Storage

### Firestore (Game Library & Settings)

Game library and app settings are stored in **Firestore** — a fully managed NoSQL database on the user's own GCP project. No external server needed.

```
users/{user_id}/
  games/{game_id}       # GameEntry document (flat Firestore fields)
  settings/app          # AppSettings document
  syncMeta/{game_id}    # SyncMeta JSON blob (write-only mirror for future cross-device use)
```

- Writes happen in **background threads** — the UI never blocks on network calls.
- On first login, if Firestore has no data, the app automatically migrates from the legacy Drive `library.json`.

### Google Drive (Save Files)

Actual save-game files are stored in the `drive.appdata` hidden folder — invisible in Drive UI, protected from accidental deletion.

```
appDataFolder/
  game-processing-sync/
    {game_id}/
      <save files...>
      .sync-meta.json   # timestamps + file IDs for conflict detection
      backups/          # version snapshots
```

---

## Authentication

- Uses `tauri-plugin-google-auth` — browser-based OAuth with no local HTTP server.
- Scopes: `openid`, `email`, `profile`, `drive.file`, `drive.appdata`, `https://www.googleapis.com/auth/datastore`.
- `CLIENT_ID`, `CLIENT_SECRET`, and `GOOGLE_CLOUD_PROJECT_ID` are compiled into the Rust binary via `option_env!()` — never stored in frontend code.
- Tokens are persisted to `{app_data_dir}/oauth-tokens.json`.

> Existing users upgrading from a build without the `datastore` scope must re-authenticate once.

---

## Save Path Portability

Both save-folder paths and game executable paths are stored with Windows environment-variable tokens so they work across accounts and machines:

| Token | Expands to |
|---|---|
| `%LOCALAPPDATA%` | `C:\Users\<user>\AppData\Local` |
| `%APPDATA%` | `C:\Users\<user>\AppData\Roaming` |
| `%USERPROFILE%` | `C:\Users\<user>` |
| `%PROGRAMDATA%` | `C:\ProgramData` |
| `%PROGRAMFILES%` | `C:\Program Files` |
| `%TEMP%` | `C:\Users\<user>\AppData\Local\Temp` |

- `expand_env_vars()` in `settings.rs` expands tokens to absolute paths at runtime.
- `contract_env_vars()` (exposed as the `contract_path` Tauri command) converts an absolute path back to a portable token path immediately after a file-picker selection — so `C:\Program Files\Steam\game.exe` is stored as `%PROGRAMFILES%\Steam\game.exe`.

---

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

---

## Dev Environment Requirements

### Google Cloud — OAuth 2.0 & Drive API Setup

Before running the app locally you must configure a Google Cloud project with the required APIs and credentials.

1. **Create a Google Cloud project** at [console.cloud.google.com](https://console.cloud.google.com/).

2. **Enable APIs** — in *APIs & Services → Library*, enable all three:
   - **Google Drive API**
   - **Google People API** (used for `userinfo` endpoint)
   - **Cloud Firestore API**

3. **Create OAuth 2.0 credentials**:
   - Go to *APIs & Services → Credentials → Create Credentials → OAuth client ID*.
   - Application type: **Desktop app**.
   - Download or copy the **Client ID** and **Client Secret**.

4. **Configure OAuth consent screen**:
   - Go to *APIs & Services → OAuth consent screen*.
   - Set user type to **External** (or Internal if using a Google Workspace org).
   - Add scopes: `openid`, `email`, `profile`, `https://www.googleapis.com/auth/drive.file`, `https://www.googleapis.com/auth/drive.appdata`, `https://www.googleapis.com/auth/datastore`.
   - Add your Google account as a **test user** while the app is in *Testing* status.

5. **Create a Firestore database** — in *Firestore → Create database*.
   - Choose **Native mode**.
   - Select your preferred region.

6. **Provide credentials to the Rust build** — create `src-tauri/.env`:
   ```
   GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=your-client-secret
   GOOGLE_CLOUD_PROJECT_ID=your-gcp-project-id
   ```
   These are injected at compile time via `option_env!()` in `build.rs` and are **never** exposed to the frontend directly.

> For CI/CD, add `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_CLOUD_PROJECT_ID` as GitHub repository secrets instead of using `.env`.

---

## Developer Workflows

> `cargo` is installed via rustup at `%USERPROFILE%\.cargo\bin`. Prepend it if a new terminal can't find `cargo`.

**Dev mode** (requires Rust toolchain on PATH):

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
npm run tauri -- dev        # starts Vite + Tauri hot-reload
```

**Frontend-only check** (no Rust needed):

```powershell
npm run build               # tsc + vite build — catches all TS/CSS errors
```

**Release build** (produces `.msi` + NSIS `.exe` under `src-tauri/target/release/bundle/`):

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
npm run tauri -- build
```

---

## CI/CD & Releases

Releases are published automatically via GitHub Actions on every push to `main`:

1. CI bumps the patch version in `tauri.conf.json` and `Cargo.toml`.
2. Builds and signs the Windows installer.
3. Publishes a GitHub Release tagged `vX.Y.Z` with `latest.json` for the in-app updater.

Required repository secrets: `GITHUB_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CLOUD_PROJECT_ID`, `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

### Generating the Signing Key

Run once to generate a minisign key pair:

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
npm run tauri -- signer generate -w "$env:USERPROFILE\tauri-signing.key"
```

This outputs:
- **Private key** — content of `tauri-signing.key` → add as `TAURI_SIGNING_PRIVATE_KEY` secret (the full key string, not the file path).
- **Public key** — printed to stdout → paste into `tauri.conf.json` under `plugins.updater.pubkey`.
- **Password** — the password you entered → add as `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secret.

> Keep the private key file secure and off version control. The public key is safe to commit.

> **Never** manually edit version fields in `tauri.conf.json` or `Cargo.toml` — the CI owns them.

---

## Security Notes

- OAuth credentials are **never** stored in frontend code — served only through a Tauri command from the compiled Rust binary.
- Tokens are stored as plain JSON at `{app_data_dir}/oauth-tokens.json` (OS keyring migration is a future enhancement).
- CSP in `tauri.conf.json` restricts connections to `accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com`, `firestore.googleapis.com`, and `localhost`.

---
description: "Use when: integrating Google Drive API, implementing Google OAuth SSO, adding OAuth commands, refreshing tokens, uploading/downloading save files to Drive, managing Drive folders, building gdrive.rs, extending gdrive_auth.rs, or wiring auth to the frontend. Covers plugin-based OAuth flow via tauri-plugin-google-auth, token lifecycle, Drive REST API patterns, Tauri command conventions, and React auth guard."
---

# Google Drive API & SSO Integration

## Credential Rules (Non-negotiable)

- `CLIENT_ID` and `CLIENT_SECRET` are **compile-time constants** injected via env vars in `src-tauri/.env`.
  Use `option_env!("GOOGLE_CLIENT_ID")` / `option_env!("GOOGLE_CLIENT_SECRET")`.
- `GOOGLE_CLOUD_PROJECT_ID` is a compile-time constant injected the same way — used by `firestore.rs` as the GCP project ID for Firestore REST API calls. Read with `option_env!("GOOGLE_CLOUD_PROJECT_ID")`.
- The Rust backend exposes `get_oauth_credentials` command so the frontend can pass them to the Google Auth plugin — credentials are **never hardcoded** in TypeScript.
- Always use the **"Desktop app"** OAuth credential type. `CLIENT_SECRET` defaults to `""`.
- Always call `require_client_id()` at the top of every public OAuth function to surface misconfiguration early.

## OAuth Flow — Plugin-Based (tauri-plugin-google-auth)

Authentication uses `tauri-plugin-google-auth` (Rust crate: `tauri-plugin-google-auth = "0.5"`, JS: `@choochmeque/tauri-plugin-google-auth-api`). The frontend drives the OAuth flow; the Rust backend stores and manages tokens.

### Flow

1. **Frontend** calls `getOAuthCredentials()` → Rust returns `OAuthCredentials { clientId, clientSecret }`.
2. **Frontend** calls plugin `signIn({ clientId, clientSecret, scopes })` which opens the system browser for Google consent.
3. Plugin returns `TokenResponse { accessToken, refreshToken, expiresAt }`.
4. **Frontend** sends tokens to Rust via `saveAuthTokens(SaveTokensPayload)`.
5. **Rust** persists `OAuthTokens { access_token, refresh_token, expires_at, user_id: "" }` to `TOKEN_FILE_NAME` first.
6. **Rust** calls `/oauth2/v2/userinfo` with the access token to get the stable `id`; re-saves tokens with `user_id` populated.
7. **Rust** calls `settings::fetch_all_from_firestore()` — loads game library + settings from Firestore, falls back to Drive `library.json` migration if Firestore has no data. This replaces the old separate `fetch_library_from_cloud` + `fetch_settings_from_cloud` calls.
8. **Rust** emits `"auth-status-changed"` event and returns `AuthStatus { authenticated: true }`.

### Plugin Registration

In `lib.rs`:
```rust
.plugin(tauri_plugin_google_auth::init())
```

In `capabilities/default.json`:
```json
"permissions": ["core:default", "dialog:default", "opener:default", "google-auth:default"]
```

### Key: No Rust-Side OAuth Flow

There is **no** local HTTP server, PKCE implementation, or `start_oauth_login` command in Rust. The plugin handles the browser-based OAuth flow entirely. Rust only receives and stores tokens via `save_tokens_from_plugin()`.

## Token Lifecycle

```rust
// Load → check expiry → silent refresh → return token
pub fn get_access_token(app: &AppHandle) -> Result<String, String> { ... }
```

- `expires_at` is a Unix timestamp (seconds). Refresh when `now_secs() >= expires_at`.
- On refresh failure in `check_auth_status`: delete stored tokens, return `AuthStatus { authenticated: false }`.
- Token file path: `app.path().app_data_dir()? / TOKEN_FILE_NAME` (currently `oauth-tokens.json`).
- Token refresh uses `POST https://oauth2.googleapis.com/token` with `grant_type=refresh_token`.
- **Future**: migrate storage to OS keyring (`keyring` crate) — keep `load_tokens`/`save_tokens`/`delete_tokens` as the only I/O boundary so callers don't change.

### Token Persistence Functions

| Function | Purpose |
|----------|---------|
| `tokens_path(app)` | Resolve `app_data_dir() / TOKEN_FILE_NAME` |
| `load_tokens(app)` | Read + deserialize; returns `Option<OAuthTokens>` |
| `save_tokens(app, tokens)` | Serialize + write JSON |
| `delete_tokens(app)` | Remove file if exists |
| `save_tokens_from_plugin(app, payload)` | Convert `SaveTokensPayload` → `OAuthTokens`, persist, **then fetch userinfo to capture `user_id` and re-save**, emit event |
| `get_current_user_id(app)` | Load tokens → return `Some(user_id)` if non-empty, else `None` |
| `fetch_user_info_with_token(token)` | Private helper: call Google `/oauth2/v2/userinfo` with a raw token string (used by both `get_google_user_info` and `save_tokens_from_plugin`) |

#### `save_tokens_from_plugin` — user_id capture order

1. Build `OAuthTokens` with `user_id: String::new()` and `save_tokens()` immediately — makes `get_access_token()` functional.
2. Call `fetch_user_info_with_token(&access_token)` (uses the payload token directly, no circular dependency).
3. Set `tokens.user_id = info.id` and `save_tokens()` again — one extra disk write at login, never again unless re-login.
4. If step 2 fails (network error) → log a warning, proceed; library falls back to legacy shared path until next login.

#### `user_id` propagation rules

- Always copy `old.user_id` when constructing `new_tokens` in `refresh_access_token()` — **never reset it on refresh**.
- `OAuthTokens.user_id` has `#[serde(default)]` so old token files (without the field) deserialize as empty string without error.

## OAuth Scopes

The frontend requests these scopes (passed to the plugin's `signIn()`):

```ts
const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive.appdata",
  "https://www.googleapis.com/auth/datastore",
];
```

- `openid`, `email`, `profile` — needed for Google user info (profile picture, display name).
- `drive.appdata` — keeps all sync data in the hidden app folder.
- `drive.file` — covers files the app creates.
- `datastore` — required for Firestore REST API access (game library, settings, SyncMeta mirror).

> **Re-login required**: Adding the `datastore` scope invalidates existing tokens. Users upgrading from a build without this scope must re-authenticate.

## Google Drive API Calls (gdrive.rs)

Use **`ureq` v3** for HTTP (blocking sync, consistent with `gdrive_auth.rs`). Never introduce a second HTTP client.

### Agent Setup

```rust
fn agent() -> ureq::Agent {
    let config = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .build();
    ureq::Agent::new_with_config(config)
}
```

Disable `http_status_as_error` so callers can inspect `resp.status().as_u16()` for 4xx/5xx.

### ureq v3 API Rules

- **GET**: Use `.call()` — `.send()` belongs to `WithBody` (POST/PATCH).
- **POST/PATCH**: Use `.send(body_bytes)`.
- **Read bytes**: `.into_body().read_to_vec()` — no `read_to_end()`.
- **Read string**: `.into_body().read_to_string()`.

```rust
// Always obtain a fresh token before any API call
let token = gdrive_auth::get_access_token(app)?;

agent()
    .get(url)
    .header("Authorization", &format!("Bearer {token}"))
    .call()
```

### 401 Retry Pattern

Wrap every Drive API call: on HTTP 401, force a token refresh and retry once.

```rust
fn drive_get(app: &AppHandle, url: &str) -> Result<(u16, String), String> {
    let resp = do_drive_get(app, url)?;
    if resp.0 == 401 {
        let _ = gdrive_auth::get_access_token(app)?;
        return do_drive_get(app, url);
    }
    Ok(resp)
}
```

### Drive Folder Structure

```
appDataFolder/
  game-processing-sync/          ← root folder (ensure_root_folder)
    config.json                  ← AppSettings (global configuration DB record)
    library.json                 ← Vec<GameEntry> (game library DB table)
    {game_id}/                   ← per-game folder (ensure_game_folder)
      <save files...>
      .sync-meta.json            ← { last_synced, files: { relativePath → SyncFileMeta } }
```

- Root folder name: `"game-processing-sync"`, parent: `"appDataFolder"`.
- Per-game folder name: `{game_id}` (matches `GameEntry.id`).
- Always cache `gdrive_folder_id` in `GameEntry` — avoid repeated Drive list calls.
- `library.json` and `config.json` sit directly under the root folder (not inside a game sub-folder).

### Cloud Library & Config DB Operations

> **Superseded by Firestore** — `library.json` and `config.json` on Drive are no longer the primary database. `sync_library_to_cloud` and `sync_settings_to_cloud` are dead code (marked `#[allow(dead_code)]`). Game library and settings are now read/written via `firestore.rs`. The Drive functions are kept for the one-time migration path only.

| Function | Direction | Status |
|----------|-----------|--------|
| `sync_library_to_cloud(app)` | Local → Cloud | **Dead code** — replaced by Firestore |
| `fetch_library_from_cloud(app)` | Cloud → Local | Kept — used by migration path in `settings::fetch_all_from_firestore` |
| `sync_settings_to_cloud(app)` | Local → Cloud | **Dead code** — replaced by Firestore |
| `fetch_settings_from_cloud(app)` | Cloud → Local | Kept — used by migration path in `settings::fetch_all_from_firestore` |

### Common Drive Operations

| Operation | Endpoint |
|-----------|----------|
| List files in folder | `GET /drive/v3/files?q='<folderId>' in parents&spaces=appDataFolder` |
| Upload (new) | `POST /upload/drive/v3/files?uploadType=multipart` |
| Update (existing) | `PATCH /upload/drive/v3/files/{fileId}?uploadType=multipart` |
| Download | `GET /drive/v3/files/{fileId}?alt=media` |
| Create folder | `POST /drive/v3/files` with `mimeType: application/vnd.google-apps.folder` |

Always include `spaces=appDataFolder` when listing. Request only needed fields with `?fields=id,name,modifiedTime,size`.

### Google User Info

```rust
pub fn get_google_user_info(app: &AppHandle) -> Result<GoogleUserInfo, String>
```

Fetches `GET https://www.googleapis.com/oauth2/v2/userinfo` with Bearer token. Returns `{ email, name, picture }` for the settings page display.

## Tauri Command Conventions

- All auth/Drive commands live in `lib.rs` and delegate to `gdrive_auth.rs` or `gdrive.rs`.
- Auth commands return `Result<AuthStatus, String>` (or `Result<OAuthCredentials, String>`, `Result<GoogleUserInfo, String>`).
- Drive/sync commands that mutate game state return `Result<DashboardData, String>` or `Result<SyncResult, String>`.
- Commands with blocking network I/O: use `async fn` + `tokio::task::spawn_blocking`.
- Register every new command in `tauri::generate_handler![...]`.

### Registered Auth Commands

```rust
// in generate_handler![...]
check_auth_status,      // → Result<AuthStatus, String>
save_auth_tokens,       // → Result<AuthStatus, String>     (receives tokens from plugin)
get_oauth_credentials,  // → Result<OAuthCredentials, String> (sends creds to frontend)
logout,                 // → Result<AuthStatus, String>
get_google_user_info,   // → Result<GoogleUserInfo, String>
```

### Async Pattern for Blocking I/O

```rust
#[tauri::command]
async fn sync_game(app: tauri::AppHandle, game_id: String) -> Result<SyncResult, String> {
    tokio::task::spawn_blocking(move || sync::sync_game(&app, &game_id))
        .await
        .map_err(|e| format!("Sync task failed: {e}"))?
}
```

## Frontend Auth Patterns

### Service Layer (`src/services/tauri.ts`)

Every OAuth/Drive call is a typed wrapper — no raw `invoke` outside this file:

```ts
export async function checkAuthStatus(): Promise<AuthStatus> {
  return invoke<AuthStatus>("check_auth_status");
}
export async function saveAuthTokens(payload: SaveTokensPayload): Promise<AuthStatus> {
  return invoke<AuthStatus>("save_auth_tokens", { payload });
}
export async function getOAuthCredentials(): Promise<OAuthCredentials> {
  return invoke<OAuthCredentials>("get_oauth_credentials");
}
export async function logout(): Promise<AuthStatus> {
  return invoke<AuthStatus>("logout");
}
export async function getGoogleUserInfo(): Promise<GoogleUserInfo> {
  return invoke<GoogleUserInfo>("get_google_user_info");
}
```

### React Query Hooks (`src/queries/auth.ts`)

- `useAuthStatusQuery()` — `useQuery` on `AUTH_STATUS_KEY`; runs on mount to gate the app.
- `useLoginMutation()` — orchestrates the full plugin-based OAuth flow:
  1. `getOAuthCredentials()` → get `clientId`/`clientSecret` from Rust.
  2. `signIn({ clientId, clientSecret, scopes })` → plugin opens browser, returns tokens.
  3. `saveAuthTokens({ accessToken, refreshToken, expiresAt })` → persist in Rust.
  On success, sets `AUTH_STATUS_KEY` cache to the returned `AuthStatus`.
- `useLogoutMutation()` — calls plugin `signOut()` then Rust `logout()`; clears `AUTH_STATUS_KEY` and `GOOGLE_USER_INFO_KEY` caches.
- `useGoogleUserInfoQuery()` — `useQuery` on `GOOGLE_USER_INFO_KEY`; enabled only when `authenticated === true`.
- Never call `checkAuthStatus` directly in components — always go through the query hook.

### Auth Guard (`src/components/AuthGuard.tsx`)

Layout route component using `<Outlet />`. Checks `useAuthStatusQuery().data?.authenticated`. If `false`, renders `<Navigate to="/login" replace />`. All dashboard routes are children of this layout. The `/login` page is the only unauthenticated route.

### Listening to Rust Events

When Rust emits `"auth-status-changed"`, update the auth query cache:
```ts
import { listen } from "@tauri-apps/api/event";
useEffect(() => {
  const unlisten = listen<AuthStatus>("auth-status-changed", ({ payload }) => {
    queryClient.setQueryData(AUTH_STATUS_KEY, payload);
  });
  return () => { unlisten.then(fn => fn()); };
}, [queryClient]);
```

## Auth Data Types

### Rust (`models.rs`) — all use `#[serde(rename_all = "camelCase")]`

```rust
pub struct AuthStatus { pub authenticated: bool }

pub struct OAuthTokens {        // internal, not sent to frontend
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: u64,
    #[serde(default)]
    pub user_id: String,        // stable Google numeric ID; empty on old token files
}

pub struct SaveTokensPayload {  // received from frontend after plugin sign-in
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: Option<u64>,
}

pub struct OAuthCredentials {   // sent to frontend for plugin config
    pub client_id: String,
    pub client_secret: String,
}

pub struct GoogleUserInfo {     // user profile from Google API
    pub id: String,             // stable Google numeric account ID
    pub email: String,
    pub name: Option<String>,
    pub picture: Option<String>,
}
```

### TypeScript (`src/types/dashboard.ts`) — canonical field names

```ts
interface AuthStatus { authenticated: boolean }
interface SaveTokensPayload { accessToken: string; refreshToken: string | null; expiresAt: number | null }
interface OAuthCredentials { clientId: string; clientSecret: string }
interface GoogleUserInfo { id: string; email: string; name: string | null; picture: string | null }
```

### Serde Mapping

| Rust field | TypeScript field |
|------------|-----------------|
| `authenticated` | `authenticated` |
| `access_token` | `accessToken` |
| `refresh_token` | `refreshToken` |
| `expires_at` | `expiresAt` |
| `client_id` | `clientId` |
| `client_secret` | `clientSecret` |
| `gdrive_folder_id` | `gdriveFolderId` |
| `last_cloud_modified` | `lastCloudModified` |

## CSP (`tauri.conf.json`)

```
default-src 'self';
connect-src 'self' https://accounts.google.com https://oauth2.googleapis.com https://www.googleapis.com http://127.0.0.1;
img-src 'self' https://*.googleusercontent.com;
style-src 'self' 'unsafe-inline'
```

- `*.googleusercontent.com` in `img-src` is required for Google profile pictures.
- `connect-src` allows Google APIs + localhost.

## Error Handling

- Return `Err(String)` with a human-readable message from all Tauri commands — the frontend surfaces it directly.
- On HTTP 401 from Drive API: force `get_access_token` to trigger a silent refresh and retry once before propagating the error.
- Log Rust-side with `println!("[module] message")` (structured prefix for grep-ability).
- On refresh failure: `check_auth_status` deletes stored tokens and returns `{ authenticated: false }`.

## Security Checklist

- [ ] `CLIENT_ID` loaded from env var via `option_env!`, not hardcoded
- [ ] `require_client_id()` called before any OAuth operation
- [ ] Credentials sent to frontend only via `get_oauth_credentials` command (never hardcoded in TS)
- [ ] Tokens never logged or exposed in frontend state
- [ ] Token file path derived from `app.path().app_data_dir()` (not a hardcoded path)
- [ ] CSP restricts `connect-src` to Google APIs + localhost only
- [ ] CSP restricts `img-src` to self + `*.googleusercontent.com` only
- [ ] `tauri-plugin-google-auth` registered in both `lib.rs` and `capabilities/default.json`

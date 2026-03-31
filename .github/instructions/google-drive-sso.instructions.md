---
description: "Use when: integrating Google Drive API, implementing Google OAuth SSO, adding OAuth commands, refreshing tokens, uploading/downloading save files to Drive, managing Drive folders, building gdrive.rs, extending gdrive_auth.rs, or wiring auth to the frontend. Covers OAuth 2.0 + PKCE flow, token lifecycle, Drive REST API patterns, Tauri command conventions, and React auth guard."
---

# Google Drive API & SSO Integration

## Credential Rules (Non-negotiable)

- `CLIENT_ID` and `CLIENT_SECRET` are **compile-time constants** injected via env vars in `src-tauri/.env`.
  Use `option_env!("GOOGLE_CLIENT_ID")` / `option_env!("GOOGLE_CLIENT_SECRET")`.
- **Never** place credentials in TypeScript, `tauri.conf.json`, or any file that ships to the frontend.
- Always use the **"Desktop app"** OAuth credential type (PKCE, no secret required). `CLIENT_SECRET` defaults to `""`.
- Always call `require_client_id()` at the top of every public OAuth function to surface misconfiguration early.

## OAuth 2.0 + PKCE Flow (Rust)

All OAuth logic lives in `src-tauri/src/gdrive_auth.rs`. The canonical flow:

1. Bind a random `127.0.0.1:0` port → derive `redirect_uri`.
2. Generate PKCE `code_verifier` + `code_challenge` (S256).
3. Build auth URL with `client_id`, `redirect_uri`, `scope`, `code_challenge`, `access_type=offline`, `prompt=consent`.
4. Open URL via `open::that(auth_url)`.
5. Block on `TcpListener::accept()` to receive the callback.
6. Parse `?code=` from the GET request line.
7. Exchange code → tokens via `POST https://oauth2.googleapis.com/token`.
8. Persist `OAuthTokens { access_token, refresh_token, expires_at }` to `TOKEN_FILE_NAME`.
9. Emit `"auth-status-changed"` event and return `AuthStatus { authenticated: true }`.

`start_oauth_login` uses blocking I/O — always dispatch via `tokio::task::spawn_blocking` in `lib.rs`.

## Token Lifecycle

```rust
// Load → check expiry → silent refresh → return token
pub fn get_access_token(app: &AppHandle) -> Result<String, String> { ... }
```

- `expires_at` is a Unix timestamp (seconds). Refresh when `now_secs() >= expires_at`.
- On refresh failure: delete stored tokens, return `AuthStatus { authenticated: false }`.
- Token file path: `app.path().app_data_dir()? / TOKEN_FILE_NAME`.
- **Future**: migrate storage to OS keyring (`keyring` crate) — keep `load_tokens`/`save_tokens`/`delete_tokens` as the only I/O boundary so callers don't change.

## OAuth Scopes

Always use exactly these two scopes (space-separated):
```
https://www.googleapis.com/auth/drive.file
https://www.googleapis.com/auth/drive.appdata
```
`drive.appdata` keeps all data in the hidden app folder. `drive.file` covers files the app creates.

## Google Drive API Calls (gdrive.rs)

Use `ureq` for HTTP (blocking sync, consistent with `gdrive_auth.rs`). For Drive REST calls:

```rust
// Always obtain a fresh token before any API call
let token = gdrive_auth::get_access_token(app)?;

// Use Bearer auth on every request
agent.get(url)
    .header("Authorization", &format!("Bearer {token}"))
    ...
```

### Drive Folder Structure

```
appDataFolder/
  game-processing-sync/
    {game_id}/
      <save files>
      .sync-meta.json    // { last_cloud_modified, file_hashes }
```

- Root folder name: `"game-processing-sync"`, parent: `"appDataFolder"`.
- Per-game folder name: `{game_id}` (matches `GameEntry.id`).
- Always cache `gdrive_folder_id` in `GameEntry` — avoid repeated Drive list calls.

### Common Drive Operations

| Operation | Endpoint |
|-----------|----------|
| List files in folder | `GET /drive/v3/files?q='<folderId>' in parents` |
| Upload (new) | `POST /upload/drive/v3/files?uploadType=multipart` |
| Update (existing) | `PATCH /upload/drive/v3/files/{fileId}?uploadType=multipart` |
| Download | `GET /drive/v3/files/{fileId}?alt=media` |
| Create folder | `POST /drive/v3/files` with `mimeType: application/vnd.google-apps.folder` |
| Get metadata | `GET /drive/v3/files/{fileId}?fields=id,name,modifiedTime` |

Always request only the fields you need with `?fields=id,name,modifiedTime,...`.

## Tauri Command Conventions

- All auth/Drive commands live in `lib.rs` and delegate to `gdrive_auth.rs` or `gdrive.rs`.
- Auth commands return `Result<AuthStatus, String>`.
- Drive commands that mutate game state return `Result<DashboardData, String>`.
- Async Drive commands (network I/O): use `async fn` + `.await` with `reqwest`, or `spawn_blocking` for `ureq`.
- Register every new command in `tauri::generate_handler![...]`.

```rust
// Pattern for blocking OAuth / Drive calls
#[tauri::command]
async fn sync_game(app: tauri::AppHandle, game_id: String) -> Result<DashboardData, String> {
    tokio::task::spawn_blocking(move || gdrive::sync_game_blocking(&app, &game_id))
        .await
        .map_err(|e| format!("Sync task failed: {e}"))?
}
```

## Frontend Auth Patterns

### Service layer (`src/services/tauri.ts`)

Every OAuth/Drive call is a typed wrapper — no raw `invoke` outside this file:

```ts
export async function checkAuthStatus(): Promise<AuthStatus> {
  return invoke<AuthStatus>("check_auth_status");
}
export async function startOAuthLogin(): Promise<AuthStatus> {
  return invoke<AuthStatus>("start_oauth_login");
}
export async function logout(): Promise<AuthStatus> {
  return invoke<AuthStatus>("logout");
}
```

### React Query hooks (`src/queries/auth.ts`)

- `useAuthStatusQuery()` — `useQuery` on `AUTH_STATUS_KEY`; runs on mount to gate the app.
- `useLoginMutation()` — `useMutation`; on success, sets `AUTH_STATUS_KEY` cache to the returned `AuthStatus`.
- Never call `checkAuthStatus` directly in components — always go through the query hook.

### Auth Guard

`AuthGuard` (or route wrapper) checks `useAuthStatusQuery().data?.authenticated`. If `false`, redirect to `/login`. All dashboard routes must be wrapped. The `/login` page is the only unauthenticated route.

### Listening to Rust events

When Rust emits `"auth-status-changed"`, invalidate the auth query:
```ts
import { listen } from "@tauri-apps/api/event";
useEffect(() => {
  const unlisten = listen<AuthStatus>("auth-status-changed", ({ payload }) => {
    queryClient.setQueryData(AUTH_STATUS_KEY, payload);
  });
  return () => { unlisten.then(fn => fn()); };
}, [queryClient]);
```

## Serde Mapping

All Rust auth/Drive structs use `#[serde(rename_all = "camelCase")]`. TypeScript names are canonical:

| Rust | TypeScript |
|------|-----------|
| `authenticated` | `authenticated` |
| `access_token` | `accessToken` |
| `gdrive_folder_id` | `gdriveFolderId` |
| `last_cloud_modified` | `lastCloudModified` |

## CSP (`tauri.conf.json`)

Only allow connections to these hosts:
```
https://accounts.google.com
https://oauth2.googleapis.com
https://www.googleapis.com
http://127.0.0.1:*
```

## Error Handling

- Return `Err(String)` with a human-readable message from all Tauri commands — the frontend surfaces it directly.
- On HTTP 401 from Drive API: call `get_access_token` to trigger a silent refresh and retry once before propagating the error.
- Log Rust-side with `println!("[module] message")` (structured prefix for grep-ability).

## Security Checklist

- [ ] `CLIENT_ID` loaded from env var, not hardcoded
- [ ] Tokens never logged or sent to frontend
- [ ] `require_client_id()` called before any OAuth operation
- [ ] PKCE challenge generated fresh per login attempt
- [ ] Token file path derived from `app.path().app_data_dir()` (not a hardcoded path)
- [ ] CSP restricts origins to Google APIs + localhost only

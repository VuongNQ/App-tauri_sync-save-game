---
description: "Instruction logic for Google OAuth authentication — Rust/Tauri backend and React frontend. Use when: adding auth commands, changing token lifecycle, modifying save_auth_tokens, fixing auth guard, wiring login/logout flow, debugging token refresh, extending OAuth scopes, or tracing the full sign-in sequence."
name: "Auth Logic"
argument-hint: "Describe what you want to add, fix, or understand about the auth flow"
agent: "agent"
---

# Auth Logic — Google OAuth (Tauri 2 + React)

Implement or explain authentication logic for this app following the exact conventions below.
Reference the instruction file [google-drive-sso.instructions.md](../instructions/google-drive-sso.instructions.md) for full rules.

## Architecture at a Glance

```
Frontend (React)                        Backend (Rust / Tauri)
────────────────                        ───────────────────────
useLoginMutation()
  → getOAuthCredentials()           →   get_oauth_credentials  (returns CLIENT_ID + CLIENT_SECRET)
  → signIn(creds, scopes)               (tauri-plugin-google-auth opens browser)
  → saveAuthTokens(tokenResponse)   →   save_auth_tokens
                                            save_tokens_from_plugin()
                                              └─ save OAuthTokens (user_id: "")
                                              └─ GET /oauth2/v2/userinfo → capture user_id
                                              └─ re-save tokens with user_id
                                            fetch_all_from_firestore()
                                            emit "auth-status-changed"
useAuthStatusQuery()              ←   check_auth_status  (loads tokens, refreshes if expired)
AuthGuard → redirect /login           ↑ unauthenticated
```

## Key Constraints

- **Credentials never in frontend**: `CLIENT_ID` / `CLIENT_SECRET` live only in Rust via `option_env!()`.  
  Always fetch via `getOAuthCredentials()` before calling `signIn()`.
- **No Rust-side OAuth flow**: No local HTTP server, no PKCE code in Rust. Rust only receives tokens via `save_auth_tokens`.
- **`save_tokens_from_plugin` write order**: save with empty `user_id` first → fetch userinfo → re-save with `user_id`. This keeps `get_access_token()` functional even if the userinfo step fails.
- **Token refresh**: happens inside `get_access_token()` automatically when `now_secs() >= expires_at`. On failure → delete tokens → return `authenticated: false`.
- **`user_id` flows everywhere**: token file → `settings_path()` (per-user library file) → Firestore collection path. Never assume `user_id` is available; use `get_current_user_id()` which returns `Option<String>`.
- **Scopes required**: `openid email profile drive.file drive.appdata datastore`. Re-login needed when adding scopes.
- **`require_client_id()`** must be called at the top of every public OAuth function.

## Token File (`oauth-tokens.json`)

```rust
pub struct OAuthTokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: u64,   // Unix timestamp (seconds)
    pub user_id: String,   // Google stable ID; empty string until userinfo fetch completes
}
```

File location: `app.path().app_data_dir()? / "oauth-tokens.json"`

## Frontend Auth Hooks (`src/queries/auth.ts`)

| Hook | Purpose |
|---|---|
| `useAuthStatusQuery()` | Polls `check_auth_status`; `staleTime: 0`, `refetchOnWindowFocus: true` |
| `useLoginMutation()` | Runs full OAuth flow: credentials → plugin `signIn` → `saveAuthTokens` |
| `useLogoutMutation()` | Calls `logout` command; invalidates all React Query cache |

## AuthGuard (`src/components/AuthGuard.tsx`)

Wraps all protected routes. Redirects to `/login` when `authStatus.authenticated === false`.
Shows a loading card while the status query is in-flight.

## Tauri Commands (wired in `lib.rs`)

| Command | Return | Description |
|---|---|---|
| `check_auth_status` | `AuthStatus` | Token exists + not expired (refresh attempted) |
| `get_oauth_credentials` | `OAuthCredentials` | `{ clientId, clientSecret }` |
| `save_auth_tokens` | `AuthStatus` | Persist tokens, fetch userinfo, load Firestore data |
| `logout` | `AuthStatus` | Delete token file, emit event |
| `get_google_user_info` | `GoogleUserInfo` | `{ id, email, name, picture }` |

## Events

| Event | When |
|---|---|
| `"auth-status-changed"` | After `save_auth_tokens` and after `logout` |
| `"library-restored"` | After Firestore library load succeeds on first login |

## Task

$args

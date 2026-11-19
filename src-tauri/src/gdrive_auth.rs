use std::{
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::{
    firestore, http_client,
    models::{AuthStatus, GoogleUserInfo, OAuthTokens, SaveTokensPayload},
};

// ── Google OAuth 2.0 constants ────────────────────────────
// CLIENT_ID / CLIENT_SECRET are injected at compile time from env vars.
// Desktop-app credentials don't require a secret; web-app credentials do.
// See .env.example for setup instructions.
const CLIENT_ID: &str = match option_env!("GOOGLE_CLIENT_ID") {
    Some(v) => v,
    None => "",
};
const CLIENT_SECRET: &str = match option_env!("GOOGLE_CLIENT_SECRET") {
    Some(v) => v,
    None => "",
};
const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
const TOKEN_FILE_NAME: &str = "oauth-tokens.json";

fn require_client_id() -> Result<(), String> {
    if CLIENT_ID.is_empty() {
        return Err("GOOGLE_CLIENT_ID is not configured. \
             Add it to src-tauri/.env (see .env.example)."
            .into());
    }
    println!(
        "[gdrive_auth] CLIENT_ID loaded: {}... (Desktop app)",
        &CLIENT_ID[..CLIENT_ID.len().min(10)]
    );
    Ok(())
}

/// POST a URL-encoded form body and return the raw (status, response_body).
fn post_form(url: &str, body: &str) -> Result<(u16, String), String> {
    http_client::post_form_unauthenticated(url, body)
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub(crate) static TOKEN_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn check_auth_status(app: &AppHandle) -> Result<AuthStatus, String> {
    require_client_id()?;
    let _session = crate::session::read()?;
    let Some(tokens) = load_tokens(app)? else {
        return Ok(AuthStatus {
            authenticated: false,
            user_id: None,
            role: crate::models::UserRole::User,
        });
    };
    if tokens.user_id.is_empty() {
        return Ok(AuthStatus {
            authenticated: false,
            user_id: None,
            role: crate::models::UserRole::User,
        });
    }
    // Network failures must not delete a usable local/offline session.
    let role = firestore::current_user_role(app);
    spawn_profile_sync(app);
    Ok(AuthStatus {
        authenticated: true,
        user_id: Some(tokens.user_id),
        role,
    })
}

fn spawn_profile_sync(app: &AppHandle) {
    let Some(expected) = crate::session::capture(app) else {
        return;
    };
    let app = app.clone();
    std::thread::spawn(move || {
        let Ok(_lease) = crate::session::lease(&app, &expected) else {
            return;
        };
        sync_current_user_profile(&app);
    });
}

fn sync_current_user_profile(app: &AppHandle) {
    let Some(user_id) = get_current_user_id(app) else {
        return;
    };
    if let Ok(info) = get_google_user_info(app) {
        if let Err(e) = firestore::ensure_current_user_profile(app, &user_id, &info) {
            eprintln!("[firestore] Profile refresh failed: {e}");
        }
    }
}

pub fn logout(app: &AppHandle) -> Result<AuthStatus, String> {
    let _lock = TOKEN_LOCK
        .lock()
        .map_err(|_| "Credential store unavailable")?;
    crate::secret_store::delete(&tokens_path(app)?)?;
    crate::secret_store::delete(&legacy_tokens_path(app)?)?;
    let status = AuthStatus {
        authenticated: false,
        user_id: None,
        role: crate::models::UserRole::User,
    };
    let _ = app.emit("auth-status-changed", &status);
    Ok(status)
}

pub fn get_access_token(app: &AppHandle) -> Result<String, String> {
    let _lock = TOKEN_LOCK
        .lock()
        .map_err(|_| "Credential refresh unavailable")?;
    get_access_token_locked(app)
}

pub(crate) fn get_access_token_locked(app: &AppHandle) -> Result<String, String> {
    let tokens = load_tokens(app)?.ok_or("Not authenticated")?;
    if tokens.expires_at > now_secs() + 60 {
        return Ok(tokens.access_token);
    }
    Ok(refresh_access_token(app, &tokens)?.access_token)
}

pub fn force_refresh_access_token(app: &AppHandle) -> Result<String, String> {
    let _lock = TOKEN_LOCK
        .lock()
        .map_err(|_| "Credential refresh unavailable")?;
    let old = load_tokens(app)?.ok_or("Not authenticated")?;
    Ok(refresh_access_token(app, &old)?.access_token)
}

/// Verify the candidate account BEFORE replacing the old session. Tokens for
/// both APIs are committed together in one OS-protected file.
pub fn save_tokens_from_plugin(
    app: &AppHandle,
    payload: SaveTokensPayload,
) -> Result<AuthStatus, String> {
    require_client_id()?;
    crate::firebase_auth::ensure_config()?;
    let info = fetch_user_info_with_token(&payload.access_token)?;
    if info.id.is_empty() || !info.id.bytes().all(|b| b.is_ascii_digit()) {
        return Err("Google returned an invalid account identity".into());
    }
    let firebase = crate::firebase_auth::exchange_google_token(&payload.access_token, &info.id)?;
    let _lock = TOKEN_LOCK
        .lock()
        .map_err(|_| "Credential store unavailable")?;
    let refresh_token=payload.refresh_token.filter(|s| !s.is_empty()).or_else(|| {
        load_tokens(app).ok().flatten().filter(|old| old.user_id==info.id).map(|old|old.refresh_token)
    }).ok_or("Google did not return offline access. Reconnect with consent to obtain a refresh token.")?;
    let tokens = OAuthTokens {
        access_token: payload.access_token,
        refresh_token,
        expires_at: payload.expires_at.unwrap_or_else(|| now_secs() + 3600),
        user_id: info.id.clone(),
        firebase: Some(firebase),
    };
    save_tokens(app, &tokens)?;
    crate::secret_store::delete(&legacy_tokens_path(app)?)?;
    Ok(AuthStatus {
        authenticated: true,
        user_id: Some(info.id),
        role: crate::models::UserRole::User,
    })
}

fn tokens_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|_| "Cannot resolve credential directory")?
        .join("oauth-session.dpapi"))
}
fn legacy_tokens_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|_| "Cannot resolve credential directory")?
        .join(TOKEN_FILE_NAME))
}
pub(crate) fn load_tokens(app: &AppHandle) -> Result<Option<OAuthTokens>, String> {
    crate::secret_store::load(&tokens_path(app)?, Some(&legacy_tokens_path(app)?))
}
pub(crate) fn save_tokens(app: &AppHandle, tokens: &OAuthTokens) -> Result<(), String> {
    crate::secret_store::save(&tokens_path(app)?, tokens)
}

// ── Token refresh ─────────────────────────────────────────

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
    #[allow(dead_code)]
    token_type: Option<String>,
}

fn refresh_access_token(app: &AppHandle, old: &OAuthTokens) -> Result<OAuthTokens, String> {
    if old.refresh_token.is_empty() {
        return Err("No refresh token available".into());
    }

    let mut form_body = format!(
        "client_id={}&refresh_token={}&grant_type=refresh_token",
        urlencoding::encode(CLIENT_ID),
        urlencoding::encode(&old.refresh_token),
    );
    if !CLIENT_SECRET.is_empty() {
        form_body.push_str(&format!(
            "&client_secret={}",
            urlencoding::encode(CLIENT_SECRET)
        ));
    }

    let (http_status, resp_body) = post_form(TOKEN_ENDPOINT, &form_body)?;
    if http_status != 200 {
        return Err(format!(
            "Google session refresh failed (HTTP {http_status}); reconnect if access was revoked"
        ));
    }
    let tr: TokenResponse =
        serde_json::from_str(&resp_body).map_err(|_| "Invalid Google refresh response")?;

    let new_tokens = OAuthTokens {
        access_token: tr.access_token,
        refresh_token: tr
            .refresh_token
            .unwrap_or_else(|| old.refresh_token.clone()),
        expires_at: now_secs() + tr.expires_in.unwrap_or(3600),
        // Preserve the stable user_id across refreshes — it never changes.
        user_id: old.user_id.clone(),
        firebase: old.firebase.clone(),
    };

    save_tokens(app, &new_tokens)?;
    Ok(new_tokens)
}

// ── HTTP helpers ──────────────────────────────────────────

/// Return the `CLIENT_ID` for use by the frontend plugin configuration.
pub fn get_client_id() -> Result<String, String> {
    require_client_id()?;
    Ok(CLIENT_ID.to_string())
}

/// Return the `CLIENT_SECRET` for use by the frontend plugin configuration.
pub fn get_client_secret() -> String {
    CLIENT_SECRET.to_string()
}

const USERINFO_URL: &str = "https://www.googleapis.com/oauth2/v2/userinfo";

/// Fetch the authenticated user's Google profile.
pub fn get_google_user_info(app: &AppHandle) -> Result<GoogleUserInfo, String> {
    let _session = crate::session::current(app)?;
    let token = get_access_token(app)?;
    fetch_user_info_with_token(&token)
}

/// Fetch user info using an arbitrary access token (used during login before tokens are fully saved).
fn fetch_user_info_with_token(token: &str) -> Result<GoogleUserInfo, String> {
    let (status, body) = http_client::get_with_token(USERINFO_URL, token)?;
    if status != 200 {
        return Err(format!(
            "Google account verification failed (HTTP {status})"
        ));
    }

    #[derive(Deserialize)]
    struct Raw {
        id: String,
        email: String,
        name: Option<String>,
        picture: Option<String>,
    }

    let raw: Raw = serde_json::from_str(&body).map_err(|e| format!("Parse userinfo: {e}"))?;

    Ok(GoogleUserInfo {
        id: raw.id,
        email: raw.email,
        name: raw.name,
        picture: raw.picture,
    })
}

/// Return the stable Google account numeric ID stored in the local token file.
/// Returns `None` if the token file is missing, unreadable, or predates user_id capture.
pub fn get_current_user_id(app: &AppHandle) -> Option<String> {
    let tokens = load_tokens(app).ok().flatten()?;
    if tokens.user_id.is_empty() {
        None
    } else {
        Some(tokens.user_id)
    }
}

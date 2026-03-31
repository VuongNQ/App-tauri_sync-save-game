use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::models::{AuthStatus, OAuthTokens, SaveTokensPayload};

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
        return Err(
            "GOOGLE_CLIENT_ID is not configured. \
             Add it to src-tauri/.env (see .env.example)."
                .into(),
        );
    }
    println!(
        "[gdrive_auth] CLIENT_ID loaded: {}... (Desktop app)",
        &CLIENT_ID[..CLIENT_ID.len().min(10)]
    );
    Ok(())
}

/// POST a URL-encoded form body and return the raw (status, response_body).
fn post_form(url: &str, body: &str) -> Result<(u16, String), String> {
    let config = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .build();
    let agent = ureq::Agent::new_with_config(config);
    let resp = agent
        .post(url)
        .content_type("application/x-www-form-urlencoded")
        .send(body.as_bytes())
        .map_err(|e| format!("HTTP request failed: {e}"))?;
    let status = resp.status().as_u16();
    let text = resp.into_body().read_to_string().unwrap_or_default();
    Ok((status, text))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

// ── Public API ────────────────────────────────────────────

/// Check if we already have a valid (non-expired) access token.
pub fn check_auth_status(app: &AppHandle) -> Result<AuthStatus, String> {
    require_client_id()?;

    let tokens = match load_tokens(app) {
        Some(t) => t,
        None => return Ok(AuthStatus { authenticated: false }),
    };

    if now_secs() < tokens.expires_at {
        return Ok(AuthStatus { authenticated: true });
    }

    // Token expired — try silent refresh
    match refresh_access_token(app, &tokens) {
        Ok(_) => Ok(AuthStatus { authenticated: true }),
        Err(_) => {
            delete_tokens(app)?;
            Ok(AuthStatus { authenticated: false })
        }
    }
}

/// Delete local tokens and return to unauthenticated state.
pub fn logout(app: &AppHandle) -> Result<AuthStatus, String> {
    delete_tokens(app)?;
    let status = AuthStatus { authenticated: false };
    let _ = app.emit("auth-status-changed", &status);
    println!("[gdrive_auth] Logged out — tokens deleted");
    Ok(status)
}

/// Return a valid access token, silently refreshing if expired.
/// For use by internal Rust modules (e.g. future gdrive.rs).
#[allow(dead_code)]
pub fn get_access_token(app: &AppHandle) -> Result<String, String> {
    let tokens = load_tokens(app).ok_or("Not authenticated — no tokens stored")?;
    if now_secs() < tokens.expires_at {
        return Ok(tokens.access_token);
    }
    // Token expired — refresh silently
    let refreshed = refresh_access_token(app, &tokens)?;
    Ok(refreshed.access_token)
}

/// Save tokens received from the frontend (via tauri-plugin-google-auth).
/// Called after the JS plugin's `signIn()` resolves with a TokenResponse.
pub fn save_tokens_from_plugin(app: &AppHandle, payload: SaveTokensPayload) -> Result<AuthStatus, String> {
    require_client_id()?;

    let tokens = OAuthTokens {
        access_token: payload.access_token,
        refresh_token: payload.refresh_token.unwrap_or_default(),
        expires_at: payload.expires_at.unwrap_or_else(|| now_secs() + 3600),
    };
    save_tokens(app, &tokens)?;

    let status = AuthStatus { authenticated: true };
    let _ = app.emit("auth-status-changed", &status);
    println!("[gdrive_auth] Tokens saved from plugin sign-in");
    Ok(status)
}

// ── Token persistence ─────────────────────────────────────

fn tokens_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create app data dir: {e}"))?;
    Ok(dir.join(TOKEN_FILE_NAME))
}

fn load_tokens(app: &AppHandle) -> Option<OAuthTokens> {
    let path = tokens_path(app).ok()?;
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

fn save_tokens(app: &AppHandle, tokens: &OAuthTokens) -> Result<(), String> {
    let path = tokens_path(app)?;
    let json = serde_json::to_string_pretty(tokens)
        .map_err(|e| format!("Cannot serialize tokens: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("Cannot write token file: {e}"))
}

fn delete_tokens(app: &AppHandle) -> Result<(), String> {
    let path = tokens_path(app)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("Cannot delete token file: {e}"))?;
    }
    Ok(())
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
        form_body.push_str(&format!("&client_secret={}", urlencoding::encode(CLIENT_SECRET)));
    }

    let (http_status, resp_body) = post_form(TOKEN_ENDPOINT, &form_body)?;
    if http_status != 200 {
        return Err(format!("Token refresh failed (HTTP {http_status}): {resp_body}"));
    }
    let tr: TokenResponse = serde_json::from_str(&resp_body)
        .map_err(|e| format!("Failed to parse refresh response: {e}"))?;

    let new_tokens = OAuthTokens {
        access_token: tr.access_token,
        refresh_token: tr.refresh_token.unwrap_or_else(|| old.refresh_token.clone()),
        expires_at: now_secs() + tr.expires_in.unwrap_or(3600),
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

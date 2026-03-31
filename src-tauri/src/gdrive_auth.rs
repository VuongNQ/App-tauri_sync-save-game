use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::models::{AuthStatus, OAuthTokens};

// ── Google OAuth 2.0 constants ────────────────────────────
// CLIENT_ID / CLIENT_SECRET are injected at compile time from env vars.
// Desktop-app credentials don't require a secret; web-app credentials do.
// See .env.example for setup instructions.
const CLIENT_ID: &str = match option_env!("GOOGLE_CLIENT_ID") {
    Some(v) => v,
    None => "",
};
// Empty string means the credential type is "Desktop app" (no secret needed).
const CLIENT_SECRET: &str = match option_env!("GOOGLE_CLIENT_SECRET") {
    Some(v) => v,
    None => "",
};
const AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
const SCOPES: &str =
    "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.appdata";
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
        "[gdrive_auth] CLIENT_ID loaded: {}... (Desktop app, no secret)",
        &CLIENT_ID[..CLIENT_ID.len().min(10)]
    );
    Ok(())
}

/// POST a URL-encoded form body and return the raw (status, response_body).
/// Never errors on 4xx/5xx — caller checks the status code.
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

/// Start the full OAuth 2.0 Authorization Code + PKCE flow.
/// Uses blocking I/O — must be called from a blocking thread (spawn_blocking).
pub fn start_oauth_login(app: &AppHandle) -> Result<AuthStatus, String> {
    require_client_id()?;

    // 1. Bind a random localhost port
    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|e| format!("Failed to bind listener: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to get local addr: {e}"))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}");

    // 2. Generate PKCE
    let (code_verifier, code_challenge) = generate_pkce();

    // 3. Build auth URL and open in system browser
    let auth_url = format!(
        "{AUTH_ENDPOINT}?client_id={client_id}&redirect_uri={redirect_uri}\
         &response_type=code&scope={scopes}\
         &code_challenge={code_challenge}&code_challenge_method=S256\
         &access_type=offline&prompt=consent",
        client_id = urlencoding::encode(CLIENT_ID),
        redirect_uri = urlencoding::encode(&redirect_uri),
        scopes = urlencoding::encode(SCOPES),
    );
    open::that(&auth_url).map_err(|e| format!("Failed to open browser: {e}"))?;

    // 4. Wait for the OAuth callback (blocking)
    let (mut stream, _) = listener
        .accept()
        .map_err(|e| format!("Failed to accept connection: {e}"))?;

    let mut buf = [0u8; 4096];
    let n = stream
        .read(&mut buf)
        .map_err(|e| format!("Failed to read request: {e}"))?;
    let request = String::from_utf8_lossy(&buf[..n]);

    println!("[gdrive_auth] Callback raw request:\n{request}");

    // Check for error first
    if let Some(err) = extract_query_param(&request, "error") {
        println!("[gdrive_auth] OAuth error param: {err}");
        send_response(
            &mut stream,
            "Authentication failed. You can close this tab.",
        );
        return Err(format!("OAuth error: {err}"));
    }

    let code = extract_query_param(&request, "code")
        .ok_or_else(|| "No authorization code in callback".to_string())?;

    println!("[gdrive_auth] Authorization code received: {code}");

    send_response(
        &mut stream,
        "Authentication successful! You can close this tab and return to the app.",
    );
    drop(stream);
    drop(listener);

    // 5. Exchange authorization code for tokens (ureq — sync, no Tokio conflict)
    println!("[gdrive_auth] Exchanging code for tokens via POST {TOKEN_ENDPOINT}");
    let mut form_body = format!(
        "code={}&client_id={}&redirect_uri={}&grant_type=authorization_code&code_verifier={}",
        urlencoding::encode(&code),
        urlencoding::encode(CLIENT_ID),
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(&code_verifier),
    );
    // Include client_secret if configured (required for "Web application" credentials).
    if !CLIENT_SECRET.is_empty() {
        form_body.push_str(&format!("&client_secret={}", urlencoding::encode(CLIENT_SECRET)));
    }

    // 5. Exchange authorization code for tokens
    let (http_status, resp_body) = post_form(TOKEN_ENDPOINT, &form_body)?;
    println!("[gdrive_auth] Token endpoint response HTTP {http_status}: {resp_body}");
    if http_status != 200 {
        let hint = if resp_body.contains("redirect_uri_mismatch") {
            "\n → Fix: In Google Cloud Console, open your credential and add \
             http://127.0.0.1 (no port) to \"Authorized redirect URIs\"."
        } else if resp_body.contains("invalid_client") {
            "\n → Fix: Your credential requires a client_secret. \
             Copy it from Google Cloud Console and add \
             GOOGLE_CLIENT_SECRET=<secret> to src-tauri/.env, then rebuild."
        } else {
            ""
        };
        return Err(format!(
            "Token exchange failed (HTTP {http_status}): {resp_body}{hint}"
        ));
    }
    let tr: TokenResponse = serde_json::from_str(&resp_body)
        .map_err(|e| format!("Failed to parse token response: {e}"))?;

    let tokens = OAuthTokens {
        access_token: tr.access_token,
        refresh_token: tr.refresh_token.unwrap_or_default(),
        expires_at: now_secs() + tr.expires_in.unwrap_or(3600),
    };
    save_tokens(app, &tokens)?;

    // 6. Emit event to frontend
    let status = AuthStatus { authenticated: true };
    let _ = app.emit("auth-status-changed", &status);

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

// ── PKCE ──────────────────────────────────────────────────

fn generate_pkce() -> (String, String) {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use sha2::{Digest, Sha256};

    let verifier: String = (0..128)
        .map(|_| {
            let idx = fastrand::u8(0..66);
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"[idx as usize]
                as char
        })
        .collect();

    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    let digest = hasher.finalize();
    let challenge = URL_SAFE_NO_PAD.encode(digest);

    (verifier, challenge)
}

// ── HTTP helpers ──────────────────────────────────────────

fn extract_query_param(request: &str, key: &str) -> Option<String> {
    let first_line = request.lines().next()?;
    let path = first_line.split_whitespace().nth(1)?;
    let query = path.split('?').nth(1)?;
    for pair in query.split('&') {
        let mut kv = pair.splitn(2, '=');
        if kv.next()? == key {
            return kv.next().map(|v| urlencoding::decode(v).unwrap_or_default().into_owned());
        }
    }
    None
}

fn send_response(stream: &mut std::net::TcpStream, body: &str) {
    let html = format!(
        r#"<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Save Game Sync</title>
<meta http-equiv="refresh" content="2;url=http://localhost:1420/">
<style>body{{font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#1a1a2e;color:#e0e0e0}}</style>
</head><body>
<div style="text-align:center">
  <p>{body}</p>
  <p style="font-size:0.85em;opacity:0.6">Redirecting back to the app…</p>
</div>
<script>setTimeout(()=>location.replace("http://localhost:1420/"),2000)</script>
</body></html>"#
    );
    let resp = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        html.len(),
        html
    );
    let _ = stream.write_all(resp.as_bytes());
    let _ = stream.flush();
}

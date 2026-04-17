use tauri::AppHandle;

use crate::gdrive_auth;

// ── Agent factory ─────────────────────────────────────────

/// Build a ureq Agent that never treats HTTP status codes as errors.
/// All callers must inspect `status` themselves.
pub fn make_agent() -> ureq::Agent {
    let config = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .build();
    ureq::Agent::new_with_config(config)
}

// ── Unauthenticated helper ────────────────────────────────

/// POST a URL-encoded form body with no Authorization header.
/// Used for OAuth token exchange / refresh before an access token exists.
pub fn post_form_unauthenticated(url: &str, body: &str) -> Result<(u16, String), String> {
    let resp = make_agent()
        .post(url)
        .content_type("application/x-www-form-urlencoded")
        .send(body.as_bytes())
        .map_err(|e| format!("HTTP request failed: {e}"))?;
    let status = resp.status().as_u16();
    let text = resp.into_body().read_to_string().unwrap_or_default();
    Ok((status, text))
}

/// GET a URL using an explicit Bearer token (no AppHandle — for use before tokens are saved).
pub fn get_with_token(url: &str, token: &str) -> Result<(u16, String), String> {
    let resp = make_agent()
        .get(url)
        .header("Authorization", &format!("Bearer {token}"))
        .call()
        .map_err(|e| format!("HTTP GET failed: {e}"))?;
    let status = resp.status().as_u16();
    let text = resp.into_body().read_to_string().unwrap_or_default();
    Ok((status, text))
}

// ── Authenticated helpers with 401 retry ─────────────────

fn do_authed_get(app: &AppHandle, url: &str) -> Result<(u16, String), String> {
    let token = gdrive_auth::get_access_token(app)?;
    let resp = make_agent()
        .get(url)
        .header("Authorization", &format!("Bearer {token}"))
        .call()
        .map_err(|e| format!("HTTP GET failed: {e}"))?;
    let status = resp.status().as_u16();
    let text = resp.into_body().read_to_string().unwrap_or_default();
    Ok((status, text))
}

/// Authenticated GET with automatic 401 retry (token refresh + one retry).
pub fn authed_get(app: &AppHandle, url: &str) -> Result<(u16, String), String> {
    let resp = do_authed_get(app, url)?;
    if resp.0 == 401 {
        let _ = gdrive_auth::get_access_token(app)?;
        return do_authed_get(app, url);
    }
    Ok(resp)
}

fn do_authed_post_json(app: &AppHandle, url: &str, body: &str) -> Result<(u16, String), String> {
    let token = gdrive_auth::get_access_token(app)?;
    let resp = make_agent()
        .post(url)
        .header("Authorization", &format!("Bearer {token}"))
        .content_type("application/json")
        .send(body.as_bytes())
        .map_err(|e| format!("HTTP POST failed: {e}"))?;
    let status = resp.status().as_u16();
    let text = resp.into_body().read_to_string().unwrap_or_default();
    Ok((status, text))
}

/// Authenticated POST with JSON body and automatic 401 retry.
pub fn authed_post_json(app: &AppHandle, url: &str, body: &str) -> Result<(u16, String), String> {
    let resp = do_authed_post_json(app, url, body)?;
    if resp.0 == 401 {
        let _ = gdrive_auth::get_access_token(app)?;
        return do_authed_post_json(app, url, body);
    }
    Ok(resp)
}

fn do_authed_patch_json(app: &AppHandle, url: &str, body: &str) -> Result<(u16, String), String> {
    let token = gdrive_auth::get_access_token(app)?;
    let resp = make_agent()
        .patch(url)
        .header("Authorization", &format!("Bearer {token}"))
        .content_type("application/json")
        .send(body.as_bytes())
        .map_err(|e| format!("HTTP PATCH failed: {e}"))?;
    let status = resp.status().as_u16();
    let text = resp.into_body().read_to_string().unwrap_or_default();
    Ok((status, text))
}

/// Authenticated PATCH with JSON body and automatic 401 retry.
pub fn authed_patch_json(app: &AppHandle, url: &str, body: &str) -> Result<(u16, String), String> {
    let resp = do_authed_patch_json(app, url, body)?;
    if resp.0 == 401 {
        let _ = gdrive_auth::get_access_token(app)?;
        return do_authed_patch_json(app, url, body);
    }
    Ok(resp)
}

fn do_authed_delete(app: &AppHandle, url: &str) -> Result<(u16, String), String> {
    let token = gdrive_auth::get_access_token(app)?;
    let resp = make_agent()
        .delete(url)
        .header("Authorization", &format!("Bearer {token}"))
        .call()
        .map_err(|e| format!("HTTP DELETE failed: {e}"))?;
    let status = resp.status().as_u16();
    let text = resp.into_body().read_to_string().unwrap_or_default();
    Ok((status, text))
}

/// Authenticated DELETE with automatic 401 retry.
pub fn authed_delete(app: &AppHandle, url: &str) -> Result<(u16, String), String> {
    let resp = do_authed_delete(app, url)?;
    if resp.0 == 401 {
        let _ = gdrive_auth::get_access_token(app)?;
        return do_authed_delete(app, url);
    }
    Ok(resp)
}

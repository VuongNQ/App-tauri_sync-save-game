//! Firestore uses Firebase ID tokens, never the Google Drive/datastore OAuth token.
use crate::{
    auth_identity::validate_firebase_identity, gdrive_auth, http_client, models::FirebaseTokens,
};
use serde::Deserialize;
use tauri::AppHandle;

pub const PROJECT_ID: &str = match option_env!("GOOGLE_CLOUD_PROJECT_ID") {
    Some(v) => v,
    None => "",
};
/// Firestore database id. Unset or empty keeps the project's `(default)`
/// database so existing builds and data are unchanged.
pub const DATABASE_ID: &str = match option_env!("FIRESTORE_DATABASE_ID") {
    Some(v) if !v.is_empty() => v,
    _ => "(default)",
};
const API_KEY: &str = match option_env!("FIREBASE_WEB_API_KEY") {
    Some(v) => v,
    None => "",
};

pub fn ensure_config() -> Result<(), String> {
    if PROJECT_ID.is_empty() || API_KEY.is_empty() {
        return Err("Firebase account security is not configured. Set GOOGLE_CLOUD_PROJECT_ID and FIREBASE_WEB_API_KEY for this app's Firebase project before building.".into());
    }
    if !is_valid_database_id(DATABASE_ID) {
        return Err("FIRESTORE_DATABASE_ID is invalid. Use (default) or 4-63 lowercase letters, digits and hyphens, starting with a letter.".into());
    }
    Ok(())
}

/// Firestore database ids: `(default)`, or 4-63 chars of `[a-z0-9-]`,
/// starting with a letter and not ending with a hyphen.
pub fn is_valid_database_id(id: &str) -> bool {
    if id == "(default)" {
        return true;
    }
    let bytes = id.as_bytes();
    (4..=63).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes[bytes.len() - 1] != b'-'
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub fn exchange_google_token(
    google_token: &str,
    google_id: &str,
) -> Result<FirebaseTokens, String> {
    ensure_config()?;
    let body = serde_json::json!({
        "postBody": format!("access_token={}&providerId=google.com",urlencoding::encode(google_token)),
        "requestUri": "http://localhost", "returnSecureToken": true,
    });
    let url = format!(
        "https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key={}",
        urlencoding::encode(API_KEY)
    );
    let response = http_client::make_agent()
        .post(&url)
        .content_type("application/json")
        .send(body.to_string().as_bytes())
        .map_err(|_| "Firebase sign-in could not connect; existing credentials were retained")?;
    if response.status().as_u16() != 200 {
        return Err(format!(
            "Firebase sign-in failed (HTTP {}). Check Google provider and project configuration.",
            response.status().as_u16()
        ));
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Response {
        id_token: String,
        refresh_token: String,
        expires_in: String,
        local_id: String,
    }
    let bytes = response
        .into_body()
        .read_to_string()
        .map_err(|_| "Cannot read Firebase sign-in response")?;
    let data: Response =
        serde_json::from_str(&bytes).map_err(|_| "Invalid Firebase sign-in response")?;
    validate_firebase_identity(&data.id_token, PROJECT_ID, &data.local_id, google_id)?;
    Ok(FirebaseTokens {
        id_token: data.id_token,
        refresh_token: data.refresh_token,
        uid: data.local_id,
        expires_at: now()
            + data
                .expires_in
                .parse::<u64>()
                .map_err(|_| "Invalid Firebase expiry")?,
        project_id: PROJECT_ID.into(),
    })
}

pub fn get_id_token(app: &AppHandle, force_refresh: bool) -> Result<String, String> {
    ensure_config()?;
    let _lock = gdrive_auth::TOKEN_LOCK
        .lock()
        .map_err(|_| "Credential refresh unavailable")?;
    let mut session = gdrive_auth::load_tokens(app)?.ok_or("Not authenticated")?;
    if session.user_id.is_empty() {
        return Err("Reconnect Google to verify your account identity".into());
    }
    if let Some(firebase) = session.firebase.as_ref() {
        if firebase.project_id != PROJECT_ID {
            return Err(
                "Stored Firebase session belongs to a different project. Reconnect Google.".into(),
            );
        }
        validate_firebase_identity(
            &firebase.id_token,
            PROJECT_ID,
            &firebase.uid,
            &session.user_id,
        )?;
        if !force_refresh && firebase.expires_at > now() + 60 {
            return Ok(firebase.id_token.clone());
        }
        #[derive(Deserialize)]
        struct Refresh {
            id_token: String,
            refresh_token: String,
            expires_in: String,
            user_id: String,
        }
        let url = format!(
            "https://securetoken.googleapis.com/v1/token?key={}",
            urlencoding::encode(API_KEY)
        );
        let form = format!(
            "grant_type=refresh_token&refresh_token={}",
            urlencoding::encode(&firebase.refresh_token)
        );
        let (status, body) = http_client::post_form_unauthenticated(&url, &form)?;
        if status != 200 {
            return Err(format!("Firebase session refresh failed (HTTP {status}). Reconnect Google if the session was revoked."));
        }
        let data: Refresh =
            serde_json::from_str(&body).map_err(|_| "Invalid Firebase refresh response")?;
        if data.user_id != firebase.uid {
            return Err("Firebase account changed during refresh".into());
        }
        validate_firebase_identity(&data.id_token, PROJECT_ID, &firebase.uid, &session.user_id)?;
        session.firebase = Some(FirebaseTokens {
            id_token: data.id_token,
            refresh_token: data.refresh_token,
            expires_at: now()
                + data
                    .expires_in
                    .parse::<u64>()
                    .map_err(|_| "Invalid Firebase expiry")?,
            uid: data.user_id,
            project_id: PROJECT_ID.into(),
        });
    } else {
        // Lazy upgrade: retain the existing Google ID namespace and Drive links.
        let token = gdrive_auth::get_access_token_locked(app)?;
        session = gdrive_auth::load_tokens(app)?.ok_or("Not authenticated")?;
        session.firebase = Some(exchange_google_token(&token, &session.user_id)?);
    }
    gdrive_auth::save_tokens(app, &session)?;
    Ok(session.firebase.ok_or("Missing Firebase session")?.id_token)
}

#[cfg(test)]
mod database_id_tests {
    use super::is_valid_database_id;

    #[test]
    fn accepts_default_and_named_ids() {
        assert!(is_valid_database_id("(default)"));
        assert!(is_valid_database_id("savegame"));
        assert!(is_valid_database_id("save-game-2"));
    }

    #[test]
    fn rejects_malformed_ids() {
        for id in ["", "abc", "Savegame", "1save", "save-", "save/game", "save game", "(other)"] {
            assert!(!is_valid_database_id(id), "{id} should be rejected");
        }
        assert!(!is_valid_database_id(&"a".repeat(64)));
    }
}

//! The only Firestore transport. No fallback to Drive OAuth or IAM credentials.
use crate::{firebase_auth, http_client, session};
use tauri::AppHandle;

fn request(
    app: &AppHandle,
    method: &str,
    url: &str,
    body: Option<&str>,
) -> Result<(u16, String), String> {
    let _lease = session::current(app)?;
    let expected = format!(
        "https://firestore.googleapis.com/v1/projects/{}/databases/{}/",
        firebase_auth::PROJECT_ID,
        firebase_auth::DATABASE_ID
    );
    if !url.starts_with(&expected) {
        return Err("Refusing Firebase credentials for an unexpected endpoint".into());
    }
    for attempt in 0..2 {
        let token = firebase_auth::get_id_token(app, attempt == 1)?;
        let agent = http_client::make_agent();
        let response = match method {
            "GET" => agent
                .get(url)
                .header("Authorization", &format!("Bearer {token}"))
                .call(),
            "DELETE" => agent
                .delete(url)
                .header("Authorization", &format!("Bearer {token}"))
                .call(),
            "POST" => agent
                .post(url)
                .header("Authorization", &format!("Bearer {token}"))
                .content_type("application/json")
                .send(body.unwrap_or("").as_bytes()),
            "PATCH" => agent
                .patch(url)
                .header("Authorization", &format!("Bearer {token}"))
                .content_type("application/json")
                .send(body.unwrap_or("").as_bytes()),
            _ => return Err("Unsupported Firestore method".into()),
        }
        .map_err(|_| "Firestore request could not connect")?;
        let status = response.status().as_u16();
        let text = response
            .into_body()
            .read_to_string()
            .map_err(|_| "Cannot read Firestore response")?;
        if status != 401 || attempt == 1 {
            return Ok((status, text));
        }
    }
    unreachable!()
}

pub fn authed_get(app: &AppHandle, url: &str) -> Result<(u16, String), String> {
    request(app, "GET", url, None)
}
pub fn authed_delete(app: &AppHandle, url: &str) -> Result<(u16, String), String> {
    request(app, "DELETE", url, None)
}
pub fn authed_post_json(app: &AppHandle, url: &str, body: &str) -> Result<(u16, String), String> {
    request(app, "POST", url, Some(body))
}
pub fn authed_patch_json(app: &AppHandle, url: &str, body: &str) -> Result<(u16, String), String> {
    request(app, "PATCH", url, Some(body))
}

use serde_json::{json, Value};
use tauri::AppHandle;

use crate::{
    http_client,
    models::{
        AdminConfig, AppSettings, DeviceInfo, GameEntry, GoogleUserInfo, SyncMeta,
        UserProfile, UserRole, DEFAULT_DRIVE_QUOTA_BYTES,
    },
};

const PROJECT_ID: &str = match option_env!("GOOGLE_CLOUD_PROJECT_ID") {
    Some(v) => v,
    None => "",
};

fn base_url() -> String {
    format!(
        "https://firestore.googleapis.com/v1/projects/{PROJECT_ID}/databases/(default)/documents"
    )
}

// ── HTTP helpers delegated to http_client ────────────────

// ── Type converters ───────────────────────────────────────

/// Convert a plain `serde_json::Value` into Firestore's typed-field envelope.
fn json_to_firestore(value: &Value) -> Value {
    match value {
        Value::String(s) => json!({ "stringValue": s }),
        Value::Bool(b) => json!({ "booleanValue": b }),
        Value::Number(n) => {
            // Prefer integer representation; Firestore REST encodes integers as strings.
            if let Some(i) = n.as_i64() {
                json!({ "integerValue": i.to_string() })
            } else if let Some(u) = n.as_u64() {
                json!({ "integerValue": u.to_string() })
            } else {
                json!({ "doubleValue": n.as_f64().unwrap_or(0.0) })
            }
        }
        Value::Null => json!({ "nullValue": null }),
        Value::Array(arr) => {
            let values: Vec<Value> = arr.iter().map(json_to_firestore).collect();
            json!({ "arrayValue": { "values": values } })
        }
        Value::Object(map) => {
            let fields: serde_json::Map<String, Value> = map
                .iter()
                .map(|(k, v)| (k.clone(), json_to_firestore(v)))
                .collect();
            json!({ "mapValue": { "fields": fields } })
        }
    }
}

/// Convert Firestore's typed-field envelope back into a plain `serde_json::Value`.
fn firestore_to_json(value: &Value) -> Value {
    if let Some(s) = value.get("stringValue") {
        return s.clone();
    }
    if let Some(b) = value.get("booleanValue") {
        return b.clone();
    }
    // integerValue is returned as a string by Firestore REST.
    if let Some(s) = value.get("integerValue").and_then(Value::as_str) {
        if let Ok(u) = s.parse::<u64>() {
            return json!(u);
        }
        if let Ok(i) = s.parse::<i64>() {
            return json!(i);
        }
    }
    if let Some(d) = value.get("doubleValue") {
        return d.clone();
    }
    if value.get("nullValue").is_some() {
        return Value::Null;
    }
    if let Some(arr_wrap) = value.get("arrayValue") {
        let values = arr_wrap
            .get("values")
            .and_then(Value::as_array)
            .map(|arr| arr.iter().map(firestore_to_json).collect::<Vec<_>>())
            .unwrap_or_default();
        return Value::Array(values);
    }
    if let Some(map_wrap) = value.get("mapValue") {
        // Firestore REST omits the `fields` key entirely for empty maps,
        // so we must handle both `{ "fields": {...} }` and `{}`.
        let map: serde_json::Map<String, Value> = map_wrap
            .get("fields")
            .and_then(Value::as_object)
            .map(|fields| {
                fields
                    .iter()
                    .map(|(k, v)| (k.clone(), firestore_to_json(v)))
                    .collect()
            })
            .unwrap_or_default();
        return Value::Object(map);
    }
    Value::Null
}

/// Extract and decode the `fields` object of a Firestore document into plain JSON.
fn extract_doc_fields(doc: &Value) -> Value {
    match doc.get("fields").and_then(Value::as_object) {
        Some(fields) => {
            let map: serde_json::Map<String, Value> = fields
                .iter()
                .map(|(k, v)| (k.clone(), firestore_to_json(v)))
                .collect();
            Value::Object(map)
        }
        None => json!({}),
    }
}

// ── Game CRUD ─────────────────────────────────────────────

// ── User directory / admin config ─────────────────────────

/// Ensure the current user's profile exists in the global directory collection.
/// The first authenticated user on a fresh install becomes admin automatically.
pub fn ensure_current_user_profile(
    app: &AppHandle,
    user_id: &str,
    info: &GoogleUserInfo,
) -> Result<UserProfile, String> {
    if let Some(existing) = load_user_profile(app, user_id)? {
        let updated = UserProfile {
            user_id: user_id.to_string(),
            email: info.email.clone(),
            name: info.name.clone(),
            picture: info.picture.clone(),
            role: existing.role,
            registered_at: existing.registered_at,
            last_seen_at: chrono::Utc::now().to_rfc3339(),
        };
        save_user_profile(app, &updated)?;
        return Ok(updated);
    }

    let existing_users = load_all_user_profiles(app)?;
    let role = if existing_users.is_empty() {
        UserRole::Admin
    } else {
        UserRole::User
    };
    let now = chrono::Utc::now().to_rfc3339();
    let profile = UserProfile {
        user_id: user_id.to_string(),
        email: info.email.clone(),
        name: info.name.clone(),
        picture: info.picture.clone(),
        role,
        registered_at: now.clone(),
        last_seen_at: now,
    };
    save_user_profile(app, &profile)?;
    Ok(profile)
}

/// Load the current user's role if a profile exists; defaults to `user` on error.
pub fn current_user_role(app: &AppHandle) -> UserRole {
    let user_id = match crate::gdrive_auth::get_current_user_id(app) {
        Some(id) => id,
        None => return UserRole::User,
    };
    load_user_profile(app, &user_id)
        .ok()
        .flatten()
        .map(|p| p.role)
        .unwrap_or(UserRole::User)
}

/// Write (upsert) a user profile to the global directory collection.
pub fn save_user_profile(app: &AppHandle, profile: &UserProfile) -> Result<(), String> {
    let profile_val = serde_json::to_value(profile)
        .map_err(|e| format!("Serialize UserProfile: {e}"))?;
    let fields = match profile_val {
        Value::Object(map) => map
            .into_iter()
            .map(|(k, v)| (k, json_to_firestore(&v)))
            .collect::<serde_json::Map<_, _>>(),
        _ => return Err("UserProfile did not serialize to object".into()),
    };
    let body = json!({ "fields": fields }).to_string();
    let url = format!("{}/userProfiles/{}", base_url(), profile.user_id);
    let (status, resp_body) = http_client::authed_patch_json(app, &url, &body)?;
    if status != 200 && status != 201 {
        return Err(format!("[firestore] save_user_profile HTTP {status}: {resp_body}"));
    }
    println!("[firestore] Saved user profile '{}'", profile.user_id);
    Ok(())
}

/// Load a single user profile from the global directory collection.
pub fn load_user_profile(
    app: &AppHandle,
    user_id: &str,
) -> Result<Option<UserProfile>, String> {
    let url = format!("{}/userProfiles/{user_id}", base_url());
    let (status, body) = http_client::authed_get(app, &url)?;
    if status == 404 {
        return Ok(None);
    }
    if status != 200 {
        return Err(format!("[firestore] load_user_profile HTTP {status}: {body}"));
    }
    let doc: Value = serde_json::from_str(&body)
        .map_err(|e| format!("Parse Firestore user profile doc: {e}"))?;
    let plain = extract_doc_fields(&doc);
    let profile = serde_json::from_value::<UserProfile>(plain)
        .map_err(|e| format!("Deserialize UserProfile from Firestore: {e}"))?;
    Ok(Some(profile))
}

/// Load all user profiles for the admin user-management page.
pub fn load_all_user_profiles(app: &AppHandle) -> Result<Vec<UserProfile>, String> {
    let url = format!("{}/userProfiles", base_url());
    let (status, body) = http_client::authed_get(app, &url)?;
    if status == 404 {
        return Ok(vec![]);
    }
    if status != 200 {
        return Err(format!("[firestore] load_all_user_profiles HTTP {status}: {body}"));
    }

    let resp: Value = serde_json::from_str(&body)
        .map_err(|e| format!("Parse Firestore user profile list: {e}"))?;
    let docs = match resp.get("documents").and_then(Value::as_array) {
        Some(a) => a,
        None => return Ok(vec![]),
    };

    let mut profiles = Vec::with_capacity(docs.len());
    for doc in docs {
        let plain = extract_doc_fields(doc);
        match serde_json::from_value::<UserProfile>(plain) {
            Ok(p) => profiles.push(p),
            Err(e) => eprintln!("[firestore] Skipping malformed user profile doc: {e}"),
        }
    }
    profiles.sort_by(|a, b| b.last_seen_at.cmp(&a.last_seen_at));
    println!("[firestore] Loaded {} user profiles", profiles.len());
    Ok(profiles)
}

/// Load the admin-managed global Drive quota.
pub fn load_admin_config(app: &AppHandle) -> Result<AdminConfig, String> {
    let url = format!("{}/adminConfig/global", base_url());
    let (status, body) = http_client::authed_get(app, &url)?;
    if status == 404 {
        return Ok(AdminConfig {
            drive_quota_bytes: DEFAULT_DRIVE_QUOTA_BYTES,
        });
    }
    if status != 200 {
        return Err(format!("[firestore] load_admin_config HTTP {status}: {body}"));
    }

    let doc: Value = serde_json::from_str(&body)
        .map_err(|e| format!("Parse Firestore admin config doc: {e}"))?;
    let plain = extract_doc_fields(&doc);
    let config = serde_json::from_value::<AdminConfig>(plain)
        .map_err(|e| format!("Deserialize AdminConfig from Firestore: {e}"))?;
    Ok(config)
}

/// Save the admin-managed global Drive quota.
pub fn save_admin_config(app: &AppHandle, config: &AdminConfig) -> Result<(), String> {
    let config_val = serde_json::to_value(config)
        .map_err(|e| format!("Serialize AdminConfig: {e}"))?;
    let fields = match config_val {
        Value::Object(map) => map
            .into_iter()
            .map(|(k, v)| (k, json_to_firestore(&v)))
            .collect::<serde_json::Map<_, _>>(),
        _ => return Err("AdminConfig did not serialize to object".into()),
    };

    let body = json!({ "fields": fields }).to_string();
    let url = format!("{}/adminConfig/global", base_url());
    let (status, resp_body) = http_client::authed_patch_json(app, &url, &body)?;
    if status != 200 && status != 201 {
        return Err(format!("[firestore] save_admin_config HTTP {status}: {resp_body}"));
    }
    println!("[firestore] Saved global admin config");
    Ok(())
}

/// Write (upsert) a `GameEntry` to Firestore at `users/{user_id}/games/{game_id}`.
/// `exe_path` is intentionally stripped — it is local-only (differs per device).
pub fn save_game(app: &AppHandle, user_id: &str, game: &GameEntry) -> Result<(), String> {
    // exe_path is device-specific and must not be synced to the cloud.
    let cloud_game = GameEntry { exe_path: None, ..game.clone() };
    let game_val = serde_json::to_value(&cloud_game)
        .map_err(|e| format!("Serialize GameEntry: {e}"))?;

    let fields = match game_val {
        Value::Object(map) => map
            .into_iter()
            .map(|(k, v)| (k, json_to_firestore(&v)))
            .collect::<serde_json::Map<_, _>>(),
        _ => return Err("GameEntry did not serialize to object".into()),
    };

    let body = json!({ "fields": fields }).to_string();
    let url = format!("{}/users/{user_id}/games/{}", base_url(), game.id);

    let (status, resp_body) = http_client::authed_patch_json(app, &url, &body)?;
    if status != 200 && status != 201 {
        return Err(format!("[firestore] save_game HTTP {status}: {resp_body}"));
    }
    println!("[firestore] Saved game '{}' for user {user_id}", game.id);
    Ok(())
}

/// Delete a game document from Firestore. Returns `Ok(())` on 404 (idempotent).
pub fn delete_game(app: &AppHandle, user_id: &str, game_id: &str) -> Result<(), String> {
    let url = format!("{}/users/{user_id}/games/{game_id}", base_url());
    let (status, resp_body) = http_client::authed_delete(app, &url)?;
    if status != 200 && status != 204 && status != 404 {
        return Err(format!("[firestore] delete_game HTTP {status}: {resp_body}"));
    }
    println!("[firestore] Deleted game '{game_id}' for user {user_id}");
    Ok(())
}

/// Delete a game's SyncMeta document from Firestore. Returns `Ok(())` on 404 (idempotent).
pub fn delete_sync_meta(app: &AppHandle, user_id: &str, game_id: &str) -> Result<(), String> {
    let url = format!("{}/users/{user_id}/syncMeta/{game_id}", base_url());
    let (status, resp_body) = http_client::authed_delete(app, &url)?;
    if status != 200 && status != 204 && status != 404 {
        return Err(format!("[firestore] delete_sync_meta HTTP {status}: {resp_body}"));
    }
    println!("[firestore] Deleted syncMeta '{game_id}' for user {user_id}");
    Ok(())
}

/// Load all game documents from `users/{user_id}/games`.
/// Returns an empty `Vec` if the collection doesn't exist yet.
pub fn load_all_games(app: &AppHandle, user_id: &str) -> Result<Vec<GameEntry>, String> {
    let url = format!("{}/users/{user_id}/games", base_url());
    let (status, body) = http_client::authed_get(app, &url)?;
    if status == 404 {
        return Ok(vec![]);
    }
    if status != 200 {
        return Err(format!("[firestore] load_all_games HTTP {status}: {body}"));
    }

    let resp: Value = serde_json::from_str(&body)
        .map_err(|e| format!("Parse Firestore games list: {e}"))?;

    let docs = match resp.get("documents").and_then(Value::as_array) {
        Some(a) => a,
        None => return Ok(vec![]), // empty collection — no "documents" key
    };

    let mut games = Vec::with_capacity(docs.len());
    for doc in docs {
        let plain = extract_doc_fields(doc);
        match serde_json::from_value::<GameEntry>(plain) {
            Ok(g) => games.push(g),
            Err(e) => eprintln!("[firestore] Skipping malformed game doc: {e}"),
        }
    }
    println!("[firestore] Loaded {} games for user {user_id}", games.len());
    Ok(games)
}

// ── Settings CRUD ─────────────────────────────────────────

/// Write `AppSettings` to Firestore at `users/{user_id}/settings/app`.
pub fn save_settings(app: &AppHandle, user_id: &str, settings: &AppSettings) -> Result<(), String> {
    let settings_val = serde_json::to_value(settings)
        .map_err(|e| format!("Serialize AppSettings: {e}"))?;

    let fields = match settings_val {
        Value::Object(map) => map
            .into_iter()
            .filter(|(k, _)| {
                k != "pathOverrides" && k != "pathOverridesIndexed" && k != "exePathOverrides"
            })
            .map(|(k, v)| (k, json_to_firestore(&v)))
            .collect::<serde_json::Map<_, _>>(),
        _ => return Err("AppSettings did not serialize to object".into()),
    };

    let body = json!({ "fields": fields }).to_string();
    let url = format!("{}/users/{user_id}/settings/app", base_url());

    let (status, resp_body) = http_client::authed_patch_json(app, &url, &body)?;
    if status != 200 && status != 201 {
        return Err(format!("[firestore] save_settings HTTP {status}: {resp_body}"));
    }
    println!("[firestore] Saved settings for user {user_id}");
    Ok(())
}

/// Load `AppSettings` from Firestore.
/// Returns `None` if the document doesn't exist yet (first-time user).
pub fn load_settings(app: &AppHandle, user_id: &str) -> Result<Option<AppSettings>, String> {
    let url = format!("{}/users/{user_id}/settings/app", base_url());
    let (status, body) = http_client::authed_get(app, &url)?;
    if status == 404 {
        return Ok(None);
    }
    if status != 200 {
        return Err(format!("[firestore] load_settings HTTP {status}: {body}"));
    }

    let doc: Value = serde_json::from_str(&body)
        .map_err(|e| format!("Parse Firestore settings doc: {e}"))?;
    let plain = extract_doc_fields(&doc);
    let settings = serde_json::from_value::<AppSettings>(plain)
        .map_err(|e| format!("Deserialize AppSettings from Firestore: {e}"))?;
    Ok(Some(settings))
}

// ── SyncMeta CRUD ───────────────────────────────────

/// Mirror a game's `SyncMeta` to Firestore at `users/{user_id}/syncMeta/{game_id}`.
///
/// The entire `SyncMeta` struct is serialised to a JSON string and stored in a
/// single `data` field to avoid Firestore restrictions on forward-slash characters
/// that appear in relative file-path keys (e.g. `"saves/slot1.sav"`).
pub fn save_sync_meta(
    app: &AppHandle,
    user_id: &str,
    game_id: &str,
    meta: &SyncMeta,
) -> Result<(), String> {
    let data_json = serde_json::to_string(meta)
        .map_err(|e| format!("Serialize SyncMeta: {e}"))?;

    let body = serde_json::json!({
        "fields": {
            "data":   { "stringValue": data_json },
            "gameId": { "stringValue": game_id }
        }
    })
    .to_string();

    let url = format!("{}/users/{user_id}/syncMeta/{game_id}", base_url());
    let (status, resp_body) = http_client::authed_patch_json(app, &url, &body)?;
    if status != 200 && status != 201 {
        return Err(format!("[firestore] save_sync_meta HTTP {status}: {resp_body}"));
    }
    println!("[firestore] Mirrored SyncMeta for game '{game_id}' (user {user_id})");
    Ok(())
}

/// Load a game's `SyncMeta` from Firestore.
/// Returns `None` if the document does not exist yet (game never synced on this account).
#[allow(dead_code)]
pub fn load_sync_meta(
    app: &AppHandle,
    user_id: &str,
    game_id: &str,
) -> Result<Option<SyncMeta>, String> {
    let url = format!("{}/users/{user_id}/syncMeta/{game_id}", base_url());
    let (status, body) = http_client::authed_get(app, &url)?;
    if status == 404 {
        return Ok(None);
    }
    if status != 200 {
        return Err(format!("[firestore] load_sync_meta HTTP {status}: {body}"));
    }

    let doc: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| format!("Parse Firestore syncMeta doc: {e}"))?;

    let data_json = doc
        .get("fields")
        .and_then(|f| f.get("data"))
        .and_then(|d| d.get("stringValue"))
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "[firestore] syncMeta doc missing 'data' stringValue field".to_string())?;

    let meta = serde_json::from_str::<SyncMeta>(data_json)
        .map_err(|e| format!("Deserialize SyncMeta from Firestore: {e}"))?;
    Ok(Some(meta))
}

// ── Device CRUD ───────────────────────────────────────────

/// Write (upsert) a `DeviceInfo` to Firestore at `users/{user_id}/devices/{device_id}`.
/// `is_current`, `path_overrides`, `path_overrides_indexed`, and `exe_path_overrides` are
/// local-only and stripped before writing. Each override field is managed by its own
/// dedicated updateMask PATCH function so it is never clobbered by this generic upsert.
pub fn save_device(app: &AppHandle, user_id: &str, device: &DeviceInfo) -> Result<(), String> {
    // is_current is computed at query time — never persisted.
    // path_overrides / path_overrides_indexed / exe_path_overrides are each managed by
    // dedicated updateMask PATCH functions — never include them in the generic upsert.
    let cloud_device = DeviceInfo {
        is_current: false,
        path_overrides: std::collections::HashMap::new(),
        path_overrides_indexed: std::collections::HashMap::new(),
        exe_path_overrides: std::collections::HashMap::new(),
        ..device.clone()
    };
    let device_val = serde_json::to_value(&cloud_device)
        .map_err(|e| format!("Serialize DeviceInfo: {e}"))?;

    let mut fields = match device_val {
        Value::Object(map) => map
            .into_iter()
            .map(|(k, v)| (k, json_to_firestore(&v)))
            .collect::<serde_json::Map<_, _>>(),
        _ => return Err("DeviceInfo did not serialize to object".into()),
    };

    // Keep device path overrides out of the generic device upsert to avoid clobbering
    // values that are managed by `save_device_path_overrides` with an updateMask PATCH.
    fields.remove("pathOverrides");
    fields.remove("pathOverridesIndexed");
    // exe-path overrides are managed exclusively by `save_device_exe_path_overrides`.
    fields.remove("exePathOverrides");

    let body = json!({ "fields": fields }).to_string();
    // Use updateMask so the generic device upsert updates only core device metadata
    // and never wipes override backup maps stored in the same document.
    let url = format!(
        "{}/users/{user_id}/devices/{}?updateMask.fieldPaths=id&updateMask.fieldPaths=name&updateMask.fieldPaths=hostname&updateMask.fieldPaths=osName&updateMask.fieldPaths=osVersion&updateMask.fieldPaths=cpuName&updateMask.fieldPaths=cpuCores&updateMask.fieldPaths=totalRamMb&updateMask.fieldPaths=registeredAt&updateMask.fieldPaths=lastSeenAt",
        base_url(),
        device.id
    );

    let (status, resp_body) = http_client::authed_patch_json(app, &url, &body)?;
    if status != 200 && status != 201 {
        return Err(format!("[firestore] save_device HTTP {status}: {resp_body}"));
    }
    println!("[firestore] Saved device '{}' for user {user_id}", device.id);
    Ok(())
}

/// Update only `pathOverrides` and `pathOverridesIndexed` on an existing device document
/// using a Firestore `updateMask` PATCH so no other fields are touched.
/// This is the safe write path for device-local save-path overrides.
pub fn save_device_path_overrides(
    app: &AppHandle,
    user_id: &str,
    device_id: &str,
    path_overrides: &std::collections::HashMap<String, String>,
    path_overrides_indexed: &std::collections::HashMap<String, String>,
) -> Result<(), String> {
    use serde_json::json;

    let po_val = serde_json::to_value(path_overrides)
        .map_err(|e| format!("Serialize path_overrides: {e}"))?;
    let poi_val = serde_json::to_value(path_overrides_indexed)
        .map_err(|e| format!("Serialize path_overrides_indexed: {e}"))?;

    let fields = serde_json::json!({
        "pathOverrides": json_to_firestore(&po_val),
        "pathOverridesIndexed": json_to_firestore(&poi_val),
    });

    let body = json!({ "fields": fields }).to_string();
    // updateMask ensures only these two fields are written; all other device fields are preserved.
    let url = format!(
        "{}/users/{user_id}/devices/{device_id}?updateMask.fieldPaths=pathOverrides&updateMask.fieldPaths=pathOverridesIndexed",
        base_url()
    );

    let (status, resp_body) = http_client::authed_patch_json(app, &url, &body)?;
    if status != 200 && status != 201 {
        return Err(format!("[firestore] save_device_path_overrides HTTP {status}: {resp_body}"));
    }
    println!("[firestore] Saved path overrides for device '{device_id}' (user {user_id})");
    Ok(())
}

/// Update only `exePathOverrides` on an existing device document
/// using a Firestore `updateMask` PATCH so no other fields are touched.
/// This is the safe write path for device-local exe-path overrides.
pub fn save_device_exe_path_overrides(
    app: &AppHandle,
    user_id: &str,
    device_id: &str,
    exe_path_overrides: &std::collections::HashMap<String, String>,
) -> Result<(), String> {
    use serde_json::json;

    let epo_val = serde_json::to_value(exe_path_overrides)
        .map_err(|e| format!("Serialize exe_path_overrides: {e}"))?;

    let fields = serde_json::json!({
        "exePathOverrides": json_to_firestore(&epo_val),
    });

    let body = json!({ "fields": fields }).to_string();
    // updateMask ensures only this field is written; all other device fields are preserved.
    let url = format!(
        "{}/users/{user_id}/devices/{device_id}?updateMask.fieldPaths=exePathOverrides",
        base_url()
    );

    let (status, resp_body) = http_client::authed_patch_json(app, &url, &body)?;
    if status != 200 && status != 201 {
        return Err(format!("[firestore] save_device_exe_path_overrides HTTP {status}: {resp_body}"));
    }
    println!("[firestore] Saved exe-path overrides for device '{device_id}' (user {user_id})");
    Ok(())
}
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn save_device_payload_excludes_path_override_fields() {
        let device = DeviceInfo {
            id: "device-1".to_string(),
            name: "My PC".to_string(),
            hostname: "my-host".to_string(),
            os_name: "Windows".to_string(),
            os_version: "11".to_string(),
            cpu_name: "CPU".to_string(),
            cpu_cores: 8,
            total_ram_mb: 16384,
            registered_at: "2026-01-01T00:00:00Z".to_string(),
            last_seen_at: "2026-01-01T00:00:00Z".to_string(),
            is_current: false,
            path_overrides: HashMap::from([("game-a:dev".to_string(), "D:\\Saves".to_string())]),
            path_overrides_indexed: HashMap::from([(
                "game-a:dev:1".to_string(),
                "D:\\Saves\\Extra".to_string(),
            )]),
            exe_path_overrides: HashMap::from([(
                "game-a".to_string(),
                "%PROGRAMFILES%\\Game\\game.exe".to_string(),
            )]),
        };

        let device_val = serde_json::to_value(&device).expect("serialize device");
        let mut fields = match device_val {
            Value::Object(map) => map
                .into_iter()
                .map(|(k, v)| (k, json_to_firestore(&v)))
                .collect::<serde_json::Map<_, _>>(),
            _ => panic!("DeviceInfo must serialize to map"),
        };

        fields.remove("pathOverrides");
        fields.remove("pathOverridesIndexed");
        fields.remove("exePathOverrides");

        assert!(!fields.contains_key("pathOverrides"));
        assert!(!fields.contains_key("pathOverridesIndexed"));
        assert!(!fields.contains_key("exePathOverrides"));
    }
}

/// Load a single `DeviceInfo` from Firestore.
/// Returns `None` if the document does not exist yet (device never registered).
pub fn load_device(
    app: &AppHandle,
    user_id: &str,
    device_id: &str,
) -> Result<Option<DeviceInfo>, String> {
    let url = format!("{}/users/{user_id}/devices/{device_id}", base_url());
    let (status, body) = http_client::authed_get(app, &url)?;
    if status == 404 {
        return Ok(None);
    }
    if status != 200 {
        return Err(format!("[firestore] load_device HTTP {status}: {body}"));
    }
    let doc: Value = serde_json::from_str(&body)
        .map_err(|e| format!("Parse Firestore device doc: {e}"))?;
    let plain = extract_doc_fields(&doc);
    let device = serde_json::from_value::<DeviceInfo>(plain)
        .map_err(|e| format!("Deserialize DeviceInfo from Firestore: {e}"))?;
    Ok(Some(device))
}

/// Load all device documents for a user from `users/{user_id}/devices`.
/// Returns an empty `Vec` if the collection doesn't exist yet.
pub fn load_all_devices(app: &AppHandle, user_id: &str) -> Result<Vec<DeviceInfo>, String> {
    let url = format!("{}/users/{user_id}/devices", base_url());
    let (status, body) = http_client::authed_get(app, &url)?;
    if status == 404 {
        return Ok(vec![]);
    }
    if status != 200 {
        return Err(format!("[firestore] load_all_devices HTTP {status}: {body}"));
    }

    let resp: Value = serde_json::from_str(&body)
        .map_err(|e| format!("Parse Firestore devices list: {e}"))?;

    let docs = match resp.get("documents").and_then(Value::as_array) {
        Some(a) => a,
        None => return Ok(vec![]),
    };

    let mut devices = Vec::with_capacity(docs.len());
    for doc in docs {
        let plain = extract_doc_fields(doc);
        match serde_json::from_value::<DeviceInfo>(plain) {
            Ok(d) => devices.push(d),
            Err(e) => eprintln!("[firestore] Skipping malformed device doc: {e}"),
        }
    }
    println!("[firestore] Loaded {} devices for user {user_id}", devices.len());
    Ok(devices)
}

/// Delete a device document from Firestore. Returns `Ok(())` on 404 (idempotent).
pub fn delete_device(app: &AppHandle, user_id: &str, device_id: &str) -> Result<(), String> {
    let url = format!("{}/users/{user_id}/devices/{device_id}", base_url());
    let (status, resp_body) = http_client::authed_delete(app, &url)?;
    if status != 200 && status != 204 && status != 404 {
        return Err(format!("[firestore] delete_device HTTP {status}: {resp_body}"));
    }
    println!("[firestore] Deleted device '{device_id}' for user {user_id}");
    Ok(())
}

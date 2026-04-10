use serde_json::{json, Value};
use tauri::AppHandle;

use crate::{
    gdrive_auth,
    models::{AppSettings, GameEntry, SyncMeta},
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

fn agent() -> ureq::Agent {
    let config = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .build();
    ureq::Agent::new_with_config(config)
}

// ── HTTP helpers with 401 retry ───────────────────────────

fn fs_get(app: &AppHandle, url: &str) -> Result<(u16, String), String> {
    let resp = do_fs_get(app, url)?;
    if resp.0 == 401 {
        let _ = gdrive_auth::get_access_token(app)?;
        return do_fs_get(app, url);
    }
    Ok(resp)
}

fn do_fs_get(app: &AppHandle, url: &str) -> Result<(u16, String), String> {
    let token = gdrive_auth::get_access_token(app)?;
    let resp = agent()
        .get(url)
        .header("Authorization", &format!("Bearer {token}"))
        .call()
        .map_err(|e| format!("Firestore GET failed: {e}"))?;
    let status = resp.status().as_u16();
    let text = resp.into_body().read_to_string().unwrap_or_default();
    Ok((status, text))
}

fn fs_patch(app: &AppHandle, url: &str, body: &str) -> Result<(u16, String), String> {
    let resp = do_fs_patch(app, url, body)?;
    if resp.0 == 401 {
        let _ = gdrive_auth::get_access_token(app)?;
        return do_fs_patch(app, url, body);
    }
    Ok(resp)
}

fn do_fs_patch(app: &AppHandle, url: &str, body: &str) -> Result<(u16, String), String> {
    let token = gdrive_auth::get_access_token(app)?;
    let resp = agent()
        .patch(url)
        .header("Authorization", &format!("Bearer {token}"))
        .content_type("application/json")
        .send(body.as_bytes())
        .map_err(|e| format!("Firestore PATCH failed: {e}"))?;
    let status = resp.status().as_u16();
    let text = resp.into_body().read_to_string().unwrap_or_default();
    Ok((status, text))
}

fn fs_delete(app: &AppHandle, url: &str) -> Result<(u16, String), String> {
    let resp = do_fs_delete(app, url)?;
    if resp.0 == 401 {
        let _ = gdrive_auth::get_access_token(app)?;
        return do_fs_delete(app, url);
    }
    Ok(resp)
}

fn do_fs_delete(app: &AppHandle, url: &str) -> Result<(u16, String), String> {
    let token = gdrive_auth::get_access_token(app)?;
    let resp = agent()
        .delete(url)
        .header("Authorization", &format!("Bearer {token}"))
        .call()
        .map_err(|e| format!("Firestore DELETE failed: {e}"))?;
    let status = resp.status().as_u16();
    let text = resp.into_body().read_to_string().unwrap_or_default();
    Ok((status, text))
}

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
        if let Some(fields) = map_wrap.get("fields").and_then(Value::as_object) {
            let map: serde_json::Map<String, Value> = fields
                .iter()
                .map(|(k, v)| (k.clone(), firestore_to_json(v)))
                .collect();
            return Value::Object(map);
        }
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

/// Write (upsert) a `GameEntry` to Firestore at `users/{user_id}/games/{game_id}`.
pub fn save_game(app: &AppHandle, user_id: &str, game: &GameEntry) -> Result<(), String> {
    let game_val = serde_json::to_value(game)
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

    let (status, resp_body) = fs_patch(app, &url, &body)?;
    if status != 200 && status != 201 {
        return Err(format!("[firestore] save_game HTTP {status}: {resp_body}"));
    }
    println!("[firestore] Saved game '{}' for user {user_id}", game.id);
    Ok(())
}

/// Delete a game document from Firestore. Returns `Ok(())` on 404 (idempotent).
pub fn delete_game(app: &AppHandle, user_id: &str, game_id: &str) -> Result<(), String> {
    let url = format!("{}/users/{user_id}/games/{game_id}", base_url());
    let (status, resp_body) = fs_delete(app, &url)?;
    if status != 200 && status != 204 && status != 404 {
        return Err(format!("[firestore] delete_game HTTP {status}: {resp_body}"));
    }
    println!("[firestore] Deleted game '{game_id}' for user {user_id}");
    Ok(())
}

/// Load all game documents from `users/{user_id}/games`.
/// Returns an empty `Vec` if the collection doesn't exist yet.
pub fn load_all_games(app: &AppHandle, user_id: &str) -> Result<Vec<GameEntry>, String> {
    let url = format!("{}/users/{user_id}/games", base_url());
    let (status, body) = fs_get(app, &url)?;
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
            .map(|(k, v)| (k, json_to_firestore(&v)))
            .collect::<serde_json::Map<_, _>>(),
        _ => return Err("AppSettings did not serialize to object".into()),
    };

    let body = json!({ "fields": fields }).to_string();
    let url = format!("{}/users/{user_id}/settings/app", base_url());

    let (status, resp_body) = fs_patch(app, &url, &body)?;
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
    let (status, body) = fs_get(app, &url)?;
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
    let (status, resp_body) = fs_patch(app, &url, &body)?;
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
    let (status, body) = fs_get(app, &url)?;
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

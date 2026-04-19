use serde_json::{json, Value};
use tauri::AppHandle;

use crate::{
    http_client,
    models::{AppSettings, DeviceInfo, GameEntry, SyncMeta},
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
            .filter(|(k, _)| k != "pathOverrides") // local-only, never synced to Firestore
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
/// `is_current`, `path_overrides`, and `path_overrides_indexed` are local-only and are
/// stripped before writing. Path overrides are written separately via
/// `save_device_path_overrides` with an `updateMask` PATCH so they are never clobbered.
pub fn save_device(app: &AppHandle, user_id: &str, device: &DeviceInfo) -> Result<(), String> {
    // is_current is computed at query time — never persisted.
    // path_overrides / path_overrides_indexed are written via a separate updateMask PATCH.
    let cloud_device = DeviceInfo {
        is_current: false,
        path_overrides: std::collections::HashMap::new(),
        path_overrides_indexed: std::collections::HashMap::new(),
        ..device.clone()
    };
    let device_val = serde_json::to_value(&cloud_device)
        .map_err(|e| format!("Serialize DeviceInfo: {e}"))?;

    let fields = match device_val {
        Value::Object(map) => map
            .into_iter()
            .map(|(k, v)| (k, json_to_firestore(&v)))
            .collect::<serde_json::Map<_, _>>(),
        _ => return Err("DeviceInfo did not serialize to object".into()),
    };

    let body = json!({ "fields": fields }).to_string();
    let url = format!("{}/users/{user_id}/devices/{}", base_url(), device.id);

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

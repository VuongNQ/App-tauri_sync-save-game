use std::{
    fs,
    path::Path,
};

use serde::Deserialize;
use tauri::AppHandle;

use crate::{
    gdrive_auth,
    models::{DriveFile, SyncMeta},
    settings,
};

const DRIVE_FILES_URL: &str = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD_URL: &str = "https://www.googleapis.com/upload/drive/v3/files";
const ROOT_FOLDER_NAME: &str = "game-processing-sync";
const SYNC_META_NAME: &str = ".sync-meta.json";

// ── Helpers ───────────────────────────────────────────────

fn agent() -> ureq::Agent {
    let config = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .build();
    ureq::Agent::new_with_config(config)
}

/// Generic Drive GET with automatic 401 retry.
fn drive_get(app: &AppHandle, url: &str) -> Result<(u16, String), String> {
    let resp = do_drive_get(app, url)?;
    if resp.0 == 401 {
        // Force token refresh and retry once
        let _ = gdrive_auth::get_access_token(app)?;
        return do_drive_get(app, url);
    }
    Ok(resp)
}

fn do_drive_get(app: &AppHandle, url: &str) -> Result<(u16, String), String> {
    let token = gdrive_auth::get_access_token(app)?;
    let resp = agent()
        .get(url)
        .header("Authorization", &format!("Bearer {token}"))
        .call()
        .map_err(|e| format!("Drive GET failed: {e}"))?;
    let status = resp.status().as_u16();
    let text = resp.into_body().read_to_string().unwrap_or_default();
    Ok((status, text))
}

/// Drive POST with JSON body, 401 retry.
fn drive_post_json(app: &AppHandle, url: &str, body: &str) -> Result<(u16, String), String> {
    let resp = do_drive_post_json(app, url, body)?;
    if resp.0 == 401 {
        let _ = gdrive_auth::get_access_token(app)?;
        return do_drive_post_json(app, url, body);
    }
    Ok(resp)
}

fn do_drive_post_json(app: &AppHandle, url: &str, body: &str) -> Result<(u16, String), String> {
    let token = gdrive_auth::get_access_token(app)?;
    let resp = agent()
        .post(url)
        .header("Authorization", &format!("Bearer {token}"))
        .content_type("application/json")
        .send(body.as_bytes())
        .map_err(|e| format!("Drive POST failed: {e}"))?;
    let status = resp.status().as_u16();
    let text = resp.into_body().read_to_string().unwrap_or_default();
    Ok((status, text))
}

// ── Drive list response parsing ───────────────────────────

#[derive(Deserialize)]
struct FileListResponse {
    files: Option<Vec<DriveFileRaw>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DriveFileRaw {
    id: String,
    name: String,
    modified_time: Option<String>,
    size: Option<String>,
}

impl From<DriveFileRaw> for DriveFile {
    fn from(raw: DriveFileRaw) -> Self {
        DriveFile {
            id: raw.id,
            name: raw.name,
            modified_time: raw.modified_time,
            size: raw.size.and_then(|s| s.parse().ok()),
        }
    }
}

// ── Public API ────────────────────────────────────────────

/// Find or create the root `game-processing-sync` folder under appDataFolder.
pub fn ensure_root_folder(app: &AppHandle) -> Result<String, String> {
    let url = format!(
        "{DRIVE_FILES_URL}?q=name%3D%27{ROOT_FOLDER_NAME}%27+and+%27appDataFolder%27+in+parents+and+mimeType%3D%27application%2Fvnd.google-apps.folder%27+and+trashed%3Dfalse&spaces=appDataFolder&fields=files(id,name)"
    );
    let (status, body) = drive_get(app, &url)?;
    if status != 200 {
        return Err(format!("Failed to list root folder (HTTP {status}): {body}"));
    }

    let list: FileListResponse =
        serde_json::from_str(&body).map_err(|e| format!("Parse error: {e}"))?;

    if let Some(files) = &list.files {
        if let Some(f) = files.first() {
            println!("[gdrive] Root folder found: {}", f.id);
            return Ok(f.id.clone());
        }
    }

    // Create the root folder
    let meta = serde_json::json!({
        "name": ROOT_FOLDER_NAME,
        "mimeType": "application/vnd.google-apps.folder",
        "parents": ["appDataFolder"]
    });
    let (status, body) =
        drive_post_json(app, &format!("{DRIVE_FILES_URL}?fields=id"), &meta.to_string())?;
    if status != 200 {
        return Err(format!(
            "Failed to create root folder (HTTP {status}): {body}"
        ));
    }

    let created: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Parse error: {e}"))?;
    let id = created["id"]
        .as_str()
        .ok_or("Missing id in create response")?
        .to_string();
    println!("[gdrive] Root folder created: {id}");
    Ok(id)
}

/// Find or create a per-game folder under the root. Updates the game's gdrive_folder_id.
pub fn ensure_game_folder(
    app: &AppHandle,
    root_folder_id: &str,
    game_id: &str,
) -> Result<String, String> {
    // Check if already cached in state
    let state = settings::load_state(app)?;
    if let Some(game) = state.games.iter().find(|g| g.id == game_id) {
        if let Some(ref fid) = game.gdrive_folder_id {
            return Ok(fid.clone());
        }
    }

    // Search for existing folder on Drive
    let encoded_name = urlencoding::encode(game_id);
    let url = format!(
        "{DRIVE_FILES_URL}?q=name%3D%27{encoded_name}%27+and+%27{root_folder_id}%27+in+parents+and+mimeType%3D%27application%2Fvnd.google-apps.folder%27+and+trashed%3Dfalse&spaces=appDataFolder&fields=files(id,name)"
    );
    let (status, body) = drive_get(app, &url)?;
    if status != 200 {
        return Err(format!(
            "Failed to list game folder (HTTP {status}): {body}"
        ));
    }

    let list: FileListResponse =
        serde_json::from_str(&body).map_err(|e| format!("Parse error: {e}"))?;

    let folder_id = if let Some(files) = &list.files {
        if let Some(f) = files.first() {
            println!("[gdrive] Game folder found for {game_id}: {}", f.id);
            f.id.clone()
        } else {
            create_game_folder(app, root_folder_id, game_id)?
        }
    } else {
        create_game_folder(app, root_folder_id, game_id)?
    };

    // Cache the folder ID in the game entry
    let _ = settings::update_game_field(app, game_id, |g| {
        g.gdrive_folder_id = Some(folder_id.clone());
    });

    Ok(folder_id)
}

fn create_game_folder(
    app: &AppHandle,
    parent_id: &str,
    game_id: &str,
) -> Result<String, String> {
    let meta = serde_json::json!({
        "name": game_id,
        "mimeType": "application/vnd.google-apps.folder",
        "parents": [parent_id]
    });
    let (status, body) =
        drive_post_json(app, &format!("{DRIVE_FILES_URL}?fields=id"), &meta.to_string())?;
    if status != 200 {
        return Err(format!(
            "Failed to create game folder (HTTP {status}): {body}"
        ));
    }

    let created: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Parse error: {e}"))?;
    let id = created["id"]
        .as_str()
        .ok_or("Missing id in create response")?
        .to_string();
    println!("[gdrive] Game folder created for {game_id}: {id}");
    Ok(id)
}

/// List all files in a Drive folder.
pub fn list_files(app: &AppHandle, folder_id: &str) -> Result<Vec<DriveFile>, String> {
    let url = format!(
        "{DRIVE_FILES_URL}?q=%27{folder_id}%27+in+parents+and+trashed%3Dfalse&spaces=appDataFolder&fields=files(id,name,modifiedTime,size)"
    );
    let (status, body) = drive_get(app, &url)?;
    if status != 200 {
        return Err(format!("Failed to list files (HTTP {status}): {body}"));
    }

    let list: FileListResponse =
        serde_json::from_str(&body).map_err(|e| format!("Parse error: {e}"))?;

    Ok(list
        .files
        .unwrap_or_default()
        .into_iter()
        .map(DriveFile::from)
        .collect())
}

/// Upload a new file to a Drive folder using multipart upload.
pub fn upload_file(
    app: &AppHandle,
    folder_id: &str,
    local_path: &Path,
    existing_file_id: Option<&str>,
) -> Result<DriveFile, String> {
    let file_name = local_path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Invalid file name")?;

    let file_bytes = fs::read(local_path)
        .map_err(|e| format!("Cannot read file {}: {e}", local_path.display()))?;

    let boundary = format!("----boundary{}", fastrand::u64(..));

    let metadata = if existing_file_id.is_some() {
        // For updates, don't include parents
        serde_json::json!({ "name": file_name })
    } else {
        serde_json::json!({
            "name": file_name,
            "parents": [folder_id]
        })
    };

    let mut body = Vec::new();
    // Metadata part
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(b"Content-Type: application/json; charset=UTF-8\r\n\r\n");
    body.extend_from_slice(metadata.to_string().as_bytes());
    body.extend_from_slice(b"\r\n");
    // File content part
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(b"Content-Type: application/octet-stream\r\n\r\n");
    body.extend_from_slice(&file_bytes);
    body.extend_from_slice(b"\r\n");
    body.extend_from_slice(format!("--{boundary}--").as_bytes());

    let content_type = format!("multipart/related; boundary={boundary}");

    let (url, method_is_patch) = if let Some(fid) = existing_file_id {
        (
            format!("{DRIVE_UPLOAD_URL}/{fid}?uploadType=multipart&fields=id,name,modifiedTime,size"),
            true,
        )
    } else {
        (
            format!("{DRIVE_UPLOAD_URL}?uploadType=multipart&fields=id,name,modifiedTime,size"),
            false,
        )
    };

    let token = gdrive_auth::get_access_token(app)?;
    let resp = if method_is_patch {
        agent()
            .patch(&url)
            .header("Authorization", &format!("Bearer {token}"))
            .header("Content-Type", &content_type)
            .send(&body[..])
            .map_err(|e| format!("Upload PATCH failed: {e}"))?
    } else {
        agent()
            .post(&url)
            .header("Authorization", &format!("Bearer {token}"))
            .header("Content-Type", &content_type)
            .send(&body[..])
            .map_err(|e| format!("Upload POST failed: {e}"))?
    };

    let status = resp.status().as_u16();
    let resp_body = resp.into_body().read_to_string().unwrap_or_default();
    if status != 200 {
        return Err(format!(
            "Upload failed for {} (HTTP {status}): {resp_body}",
            file_name
        ));
    }

    let raw: DriveFileRaw =
        serde_json::from_str(&resp_body).map_err(|e| format!("Parse upload response: {e}"))?;
    println!(
        "[gdrive] Uploaded {file_name} → {}",
        raw.id
    );
    Ok(DriveFile::from(raw))
}

/// Download a file from Drive to a local path.
pub fn download_file(app: &AppHandle, file_id: &str, local_dest: &Path) -> Result<(), String> {
    let url = format!("{DRIVE_FILES_URL}/{file_id}?alt=media");
    let token = gdrive_auth::get_access_token(app)?;

    let resp = agent()
        .get(&url)
        .header("Authorization", &format!("Bearer {token}"))
        .call()
        .map_err(|e| format!("Download failed: {e}"))?;

    let status = resp.status().as_u16();
    if status != 200 {
        let body = resp.into_body().read_to_string().unwrap_or_default();
        return Err(format!(
            "Download failed for {file_id} (HTTP {status}): {body}"
        ));
    }

    // Read response body as bytes
    let bytes = resp
        .into_body()
        .read_to_vec()
        .map_err(|e| format!("Failed to read download body: {e}"))?;

    if let Some(parent) = local_dest.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Cannot create directory {}: {e}", parent.display()))?;
    }

    fs::write(local_dest, &bytes)
        .map_err(|e| format!("Cannot write file {}: {e}", local_dest.display()))?;

    println!(
        "[gdrive] Downloaded {file_id} → {}",
        local_dest.display()
    );
    Ok(())
}

/// Upload or update .sync-meta.json for a game.
pub fn upload_sync_meta(
    app: &AppHandle,
    folder_id: &str,
    meta: &SyncMeta,
    existing_meta_id: Option<&str>,
) -> Result<DriveFile, String> {
    let json_bytes = serde_json::to_vec_pretty(meta)
        .map_err(|e| format!("Cannot serialize SyncMeta: {e}"))?;

    let boundary = format!("----boundary{}", fastrand::u64(..));
    let metadata = if existing_meta_id.is_some() {
        serde_json::json!({ "name": SYNC_META_NAME })
    } else {
        serde_json::json!({
            "name": SYNC_META_NAME,
            "parents": [folder_id]
        })
    };

    let mut body = Vec::new();
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(b"Content-Type: application/json; charset=UTF-8\r\n\r\n");
    body.extend_from_slice(metadata.to_string().as_bytes());
    body.extend_from_slice(b"\r\n");
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(b"Content-Type: application/json\r\n\r\n");
    body.extend_from_slice(&json_bytes);
    body.extend_from_slice(b"\r\n");
    body.extend_from_slice(format!("--{boundary}--").as_bytes());

    let content_type = format!("multipart/related; boundary={boundary}");

    let (url, method_is_patch) = if let Some(fid) = existing_meta_id {
        (
            format!("{DRIVE_UPLOAD_URL}/{fid}?uploadType=multipart&fields=id,name,modifiedTime"),
            true,
        )
    } else {
        (
            format!("{DRIVE_UPLOAD_URL}?uploadType=multipart&fields=id,name,modifiedTime"),
            false,
        )
    };

    let token = gdrive_auth::get_access_token(app)?;
    let resp = if method_is_patch {
        agent()
            .patch(&url)
            .header("Authorization", &format!("Bearer {token}"))
            .header("Content-Type", &content_type)
            .send(&body[..])
            .map_err(|e| format!("SyncMeta PATCH failed: {e}"))?
    } else {
        agent()
            .post(&url)
            .header("Authorization", &format!("Bearer {token}"))
            .header("Content-Type", &content_type)
            .send(&body[..])
            .map_err(|e| format!("SyncMeta POST failed: {e}"))?
    };

    let status = resp.status().as_u16();
    let resp_body = resp.into_body().read_to_string().unwrap_or_default();
    if status != 200 {
        return Err(format!(
            "SyncMeta upload failed (HTTP {status}): {resp_body}"
        ));
    }

    let raw: DriveFileRaw =
        serde_json::from_str(&resp_body).map_err(|e| format!("Parse SyncMeta response: {e}"))?;
    Ok(DriveFile::from(raw))
}

/// Download and parse .sync-meta.json from a game's Drive folder.
/// Returns None if the file does not exist yet.
pub fn download_sync_meta(
    app: &AppHandle,
    folder_id: &str,
) -> Result<(Option<SyncMeta>, Option<String>), String> {
    let files = list_files(app, folder_id)?;
    let meta_file = files.iter().find(|f| f.name == SYNC_META_NAME);

    match meta_file {
        None => Ok((None, None)),
        Some(f) => {
            let url = format!("{DRIVE_FILES_URL}/{}?alt=media", f.id);
            let token = gdrive_auth::get_access_token(app)?;
            let resp = agent()
                .get(&url)
                .header("Authorization", &format!("Bearer {token}"))
                .call()
                .map_err(|e| format!("Download SyncMeta failed: {e}"))?;

            let status = resp.status().as_u16();
            let body = resp.into_body().read_to_string().unwrap_or_default();
            if status != 200 {
                return Err(format!(
                    "Download SyncMeta failed (HTTP {status}): {body}"
                ));
            }

            let meta: SyncMeta =
                serde_json::from_str(&body).map_err(|e| format!("Parse SyncMeta: {e}"))?;
            Ok((Some(meta), Some(f.id.clone())))
        }
    }
}

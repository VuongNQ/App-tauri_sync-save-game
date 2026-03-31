use std::collections::HashMap;

use serde::{Deserialize, Serialize};

// ── Dashboard ─────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DashboardData {
    pub games: Vec<GameEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameEntry {
    pub id: String,
    pub name: String,
    pub thumbnail: Option<String>,
    pub source: String,
    pub save_path: Option<String>,
    pub track_changes: bool,
    pub auto_sync: bool,
    pub last_local_modified: Option<String>,
    pub last_cloud_modified: Option<String>,
    pub gdrive_folder_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddGamePayload {
    pub name: String,
    pub thumbnail: Option<String>,
    pub source: String,
    pub save_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateGamePayload {
    pub game: GameEntry,
}

// ── Auth ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub authenticated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthTokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: u64,
}

/// Payload received from the frontend after plugin-based Google sign-in.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTokensPayload {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: Option<u64>,
}

/// OAuth credentials returned to the frontend for plugin configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthCredentials {
    pub client_id: String,
    pub client_secret: String,
}

// ── Settings ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub global_auto_sync: bool,
    pub sync_interval_minutes: u32,
    pub start_minimised: bool,
    pub run_on_startup: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            global_auto_sync: false,
            sync_interval_minutes: 0,
            start_minimised: false,
            run_on_startup: false,
        }
    }
}

// ── Sync ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub game_id: String,
    pub uploaded: u32,
    pub downloaded: u32,
    pub skipped: u32,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncMeta {
    pub last_synced: Option<String>,
    pub files: HashMap<String, SyncFileMeta>,
}

impl Default for SyncMeta {
    fn default() -> Self {
        Self {
            last_synced: None,
            files: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncFileMeta {
    pub modified_time: String,
    pub size: u64,
    pub drive_file_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveFile {
    pub id: String,
    pub name: String,
    pub modified_time: Option<String>,
    pub size: Option<u64>,
}

// ── Persistence ───────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredState {
    pub version: u32,
    pub games: Vec<GameEntry>,
    #[serde(default)]
    pub settings: AppSettings,
}

impl Default for StoredState {
    fn default() -> Self {
        Self {
            version: 1,
            games: Vec::new(),
            settings: AppSettings::default(),
        }
    }
}

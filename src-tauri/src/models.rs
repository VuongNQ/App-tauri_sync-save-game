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
    pub description: Option<String>,
    pub thumbnail: Option<String>,
    pub source: String,
    pub save_path: Option<String>,
    pub track_changes: bool,
    pub auto_sync: bool,
    pub last_local_modified: Option<String>,
    pub last_cloud_modified: Option<String>,
    pub gdrive_folder_id: Option<String>,
    /// Total bytes currently stored in Google Drive for this game's save files.
    /// Updated after each successful sync. Used to enforce per-user storage quotas.
    #[serde(default)]
    pub cloud_storage_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddGamePayload {
    pub name: String,
    pub description: Option<String>,
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
    /// Stable Google account numeric ID (populated at login, empty on old token files).
    #[serde(default)]
    pub user_id: String,
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

/// Google account profile information.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleUserInfo {
    /// Stable numeric Google account ID.
    pub id: String,
    pub email: String,
    pub name: Option<String>,
    pub picture: Option<String>,
}

// ── Settings ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub sync_interval_minutes: u32,
    pub start_minimised: bool,
    pub run_on_startup: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            sync_interval_minutes: 0,
            start_minimised: false,
            run_on_startup: false,
        }
    }
}

// ── Sync ──────────────────────────────────────────────────

// ── Save Info ─────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveFileInfo {
    pub relative_path: String,
    pub size: u64,
    pub modified_time: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveInfo {
    pub game_id: String,
    pub save_path: String,
    pub total_files: u32,
    pub total_size: u64,
    pub last_modified: Option<String>,
    pub files: Vec<SaveFileInfo>,
}

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

/// Diff between local save files and Drive sync metadata.
/// Returned by `check_sync_structure_diff` — no file transfers are performed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStructureDiff {
    pub game_id: String,
    /// `false` when no `.sync-meta.json` exists on Drive (game never synced).
    pub cloud_has_data: bool,
    /// Relative paths that exist locally but have no Drive counterpart.
    pub local_only_files: Vec<String>,
    /// Relative paths present in Drive meta but missing from local.
    pub cloud_only_files: Vec<String>,
    /// Paths where local `modified_time` is newer than the Drive version.
    pub local_newer_files: Vec<String>,
    /// Paths where the Drive version is newer than local.
    pub cloud_newer_files: Vec<String>,
    /// `true` when any of the four lists is non-empty.
    pub has_diff: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveFile {
    pub id: String,
    pub name: String,
    pub modified_time: Option<String>,
    pub size: Option<u64>,
}

// ── Drive File Management ─────────────────────────────────

/// A single item (file or folder) in a game's Google Drive folder.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveFileItem {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub size: Option<u64>,
    pub modified_time: Option<String>,
    pub is_folder: bool,
}

/// Metadata written as `.backup-meta.json` inside each version-backup folder on Drive.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupMeta {
    pub created_time: String,
    pub label: Option<String>,
    pub total_files: u32,
    pub total_size: u64,
}

/// A version-backup snapshot shown in the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveVersionBackup {
    /// Drive folder ID for this backup's subfolder.
    pub id: String,
    /// Display name: ISO-8601 timestamp, optionally suffixed with " — {label}".
    pub name: String,
    pub created_time: String,
    pub total_files: u32,
    pub total_size: u64,
}
// ── Updater ───────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub available: bool,
    /// New version string (e.g. "0.2.0"), present only when `available` is true.
    pub version: Option<String>,
    /// Currently installed version string (e.g. "0.1.0"). Always present.
    pub current_version: String,
    /// Release notes from the update manifest, if any.
    pub body: Option<String>,
}
// ── Path Validation ───────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathValidation {
    pub game_id: String,
    pub valid: bool,
}

// ── Persistence ───────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredState {
    pub version: u32,
    pub games: Vec<GameEntry>,
    #[serde(default)]
    pub settings: AppSettings,
    /// ISO 8601 timestamp of the last successful `library.json` write to Drive.
    /// Used for conflict detection before each cloud library write.
    #[serde(default)]
    pub last_cloud_library_modified: Option<String>,
}

impl Default for StoredState {
    fn default() -> Self {
        Self {
            version: 1,
            games: Vec::new(),
            settings: AppSettings::default(),
            last_cloud_library_modified: None,
        }
    }
}

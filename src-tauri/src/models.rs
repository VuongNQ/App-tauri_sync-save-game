use std::collections::HashMap;

use serde::{Deserialize, Serialize};

// ── Dashboard ─────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DashboardData {
    pub games: Vec<GameEntry>,
}

/// A single save-folder entry within a game.  Games can have multiple save paths
/// (e.g. PCSX2 has separate `memcards/` and `sstates/` folders).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SavePathEntry {
    /// Human-readable label chosen by the user (e.g. "Memory Cards"). Required.
    pub label: String,
    /// Portable `%VAR%` path, **or** `None` when the path is device-specific
    /// (stored in `AppSettings.path_overrides` / `path_overrides_indexed` instead).
    pub path: Option<String>,
    /// Cached Google Drive subfolder ID for this path entry.
    /// - Index 0 → uses `GameEntry.gdrive_folder_id` (root folder) — this field stays `None`.
    /// - Index i≥1 → `game_id/path-{i}/` subfolder on Drive.
    #[serde(default)]
    pub gdrive_folder_id: Option<String>,
    /// Relative paths (forward-slash) excluded from Drive sync **for this path only**.
    /// A trailing '/' means folder prefix; otherwise it is an exact file match.
    #[serde(default)]
    pub sync_excludes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameEntry {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub thumbnail: Option<String>,
    pub source: String,
    /// List of save-folder entries for this game (primary source of truth).
    /// Populated from the legacy `save_path` field on first load via migration.
    #[serde(default)]
    pub save_paths: Vec<SavePathEntry>,
    // ── Legacy fields — kept for migration deserialization only ──────────────
    /// Old single save path. Populated on deserialization of pre-migration JSON;
    /// migrated to `save_paths[0]` in `settings::load_state` and then cleared.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub save_path: Option<String>,
    /// Old top-level exclusion list. Migrated into `save_paths[0].sync_excludes`
    /// during the same migration pass and then cleared.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sync_excludes: Vec<String>,
    // ── Active fields ─────────────────────────────────────────────────────────
    /// Process name to watch (e.g. "GameName.exe"). Sync triggers when this process exits.
    #[serde(default)]
    pub exe_name: Option<String>,
    /// Full path to the game executable (e.g. `%PROGRAMFILES%\Steam\game.exe`).
    /// Used to launch the game directly from the app.
    #[serde(default)]
    pub exe_path: Option<String>,
    pub track_changes: bool,
    pub auto_sync: bool,
    pub last_local_modified: Option<String>,
    pub last_cloud_modified: Option<String>,
    pub gdrive_folder_id: Option<String>,
    /// Total bytes currently stored in Google Drive for this game's save files.
    /// Updated after each successful sync. Used to enforce per-user storage quotas.
    #[serde(default)]
    pub cloud_storage_bytes: Option<u64>,
    /// Save-path mode for this game.
    /// - `"auto"` (default): portable `%VAR%` token paths shared across devices.
    /// - `"per_device"`: each machine stores its own path in local overrides; `save_paths[i].path` is always `None` in Firestore.
    #[serde(default = "default_path_mode")]
    pub path_mode: String,
}

fn default_path_mode() -> String {
    "auto".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddGamePayload {
    pub name: String,
    pub description: Option<String>,
    pub thumbnail: Option<String>,
    pub source: String,
    pub save_path: Option<String>,
    /// Full path to the game executable (tokenised, e.g. `%PROGRAMFILES%\…`). Optional at creation.
    #[serde(default)]
    pub exe_path: Option<String>,
    /// Save-path mode: `"auto"` (default) or `"per_device"`.
    #[serde(default = "default_path_mode")]
    pub path_mode: String,
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

// ── Devices ───────────────────────────────────────────────

/// A registered device (machine) associated with the authenticated Google account.
/// Stored in Firestore at `users/{user_id}/devices/{device_id}`.
/// `is_current` is computed at query time and never persisted to Firestore.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    /// Deterministic UUID derived from the Windows MachineGuid registry value.
    pub id: String,
    /// User-editable display name (auto-populated from hostname on first registration).
    pub name: String,
    /// OS-reported computer hostname.
    pub hostname: String,
    /// OS name (e.g. "Windows 11").
    pub os_name: String,
    /// OS version string (e.g. "23H2").
    pub os_version: String,
    /// CPU brand string (e.g. "Intel(R) Core(TM) i7-12700K").
    pub cpu_name: String,
    /// Number of logical CPU cores.
    pub cpu_cores: u32,
    /// Total system RAM in megabytes.
    pub total_ram_mb: u64,
    /// ISO 8601 timestamp when this device was first registered. Preserved on re-registration.
    pub registered_at: String,
    /// ISO 8601 timestamp of the most recent registration / startup upsert.
    pub last_seen_at: String,
    /// `true` when this device is the one currently running the app.
    /// Computed at query time — never stored in Firestore.
    #[serde(default)]
    pub is_current: bool,
}

// ── Settings ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub sync_interval_minutes: u32,
    pub start_minimised: bool,
    pub run_on_startup: bool,
    /// Device-specific save-path overrides keyed by `game_id` for `save_paths[0]`.
    /// Populated when a path cannot be represented as a portable `%VAR%` token.
    /// **Local-only — never written to Firestore.**
    #[serde(default)]
    pub path_overrides: HashMap<String, String>,
    /// Device-specific overrides for additional save paths (`save_paths[i≥1]`).
    /// Key format: `"{game_id}:{i}"` (e.g. `"manual-pcsx2:1"`).
    /// **Local-only — never written to Firestore.**
    #[serde(default)]
    pub path_overrides_indexed: HashMap<String, String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            sync_interval_minutes: 0,
            start_minimised: false,
            run_on_startup: false,
            path_overrides: HashMap::new(),
            path_overrides_indexed: HashMap::new(),
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

/// Per-path breakdown returned inside `SaveInfo` when a game has multiple save paths.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathSaveInfo {
    pub label: String,
    pub save_path: String,
    pub total_size: u64,
    pub files: Vec<SaveFileInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveInfo {
    pub game_id: String,
    /// Primary (first) save path — kept for single-path backward compat.
    pub save_path: String,
    pub total_files: u32,
    pub total_size: u64,
    pub last_modified: Option<String>,
    pub files: Vec<SaveFileInfo>,
    /// Per-path breakdown when the game has multiple save paths. Empty when only one path.
    #[serde(default)]
    pub path_infos: Vec<PathSaveInfo>,
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
    #[serde(deserialize_with = "deserialize_sync_files")]
    pub files: Vec<SyncFileEntry>,
}

impl Default for SyncMeta {
    fn default() -> Self {
        Self {
            last_synced: None,
            files: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncFileEntry {
    pub path_file: String,
    pub size: u64,
    pub drive_file_id: Option<String>,
}

/// Deserialize `SyncMeta.files` from either:
/// - **New format** (`pathFile`): JSON array of current `SyncFileEntry` objects
/// - **Intermediate format** (`relativePath`/`fileName`): array written by the Vec-refactor before the `pathFile` rename
/// - **Legacy format**: JSON object (map) keyed by relative path with `{ size, driveFileId }` values
///
/// This migration shim allows the app to read `.sync-meta.json` files written
/// by any previous version of the app without requiring a manual resync.
fn deserialize_sync_files<'de, D>(deserializer: D) -> Result<Vec<SyncFileEntry>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct LegacyFileMeta {
        #[serde(default)]
        size: u64,
        drive_file_id: Option<String>,
    }

    // Array format written when the struct had `relativePath` + `fileName` fields.
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct IntermediateEntry {
        relative_path: String,
        #[serde(default)]
        size: u64,
        drive_file_id: Option<String>,
    }

    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Format {
        New(Vec<SyncFileEntry>),
        Mid(Vec<IntermediateEntry>),
        Old(HashMap<String, LegacyFileMeta>),
    }

    match Format::deserialize(deserializer)? {
        Format::New(v) => Ok(v),
        Format::Mid(v) => Ok(v
            .into_iter()
            .map(|e| SyncFileEntry {
                path_file: e.relative_path,
                size: e.size,
                drive_file_id: e.drive_file_id,
            })
            .collect()),
        Format::Old(map) => Ok(map
            .into_iter()
            .map(|(rel, meta)| SyncFileEntry {
                path_file: rel,
                size: meta.size,
                drive_file_id: meta.drive_file_id,
            })
            .collect()),
    }
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

/// A file/folder item with its relative path within the game's Drive folder.
/// Returned by `list_game_drive_files_flat` (recursive listing).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveFileFlatItem {
    pub id: String,
    pub name: String,
    /// Relative path within the game's Drive folder, e.g. `"subfolder/file.txt"`.
    pub relative_path: String,
    pub size: Option<u64>,
    pub modified_time: Option<String>,
    pub is_folder: bool,
    /// Drive ID of the parent folder that directly contains this item.
    pub parent_folder_id: String,
    /// The `path_file` from SyncMeta that matched this file's Drive ID, e.g.
    /// `"76561198241997832/UserMetaData.sav"`. `None` when the file is not
    /// tracked in SyncMeta (e.g. folders, unsynced files).
    pub sync_path: Option<String>,
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

// ── Path Validation ───────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathValidation {
    pub game_id: String,
    /// Whether the configured save folder exists on this machine.
    pub valid: bool,
    /// `None` = no exe_path configured; `Some(true)` = file exists; `Some(false)` = set but missing.
    pub exe_path_valid: Option<bool>,
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

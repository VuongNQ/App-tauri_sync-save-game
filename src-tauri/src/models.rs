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

// ── Persistence ───────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredState {
    pub version: u32,
    pub games: Vec<GameEntry>,
}

impl Default for StoredState {
    fn default() -> Self {
        Self {
            version: 1,
            games: Vec::new(),
        }
    }
}

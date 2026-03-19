use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DashboardData {
    pub games: Vec<GameEntry>,
    pub launchers: Vec<LauncherStatus>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameEntry {
    pub id: String,
    pub name: String,
    pub launcher: String,
    pub install_path: Option<String>,
    pub save_path: Option<String>,
    pub source: String,
    pub confidence: String,
    pub is_manual: bool,
    pub is_available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherStatus {
    pub id: String,
    pub name: String,
    pub detected: bool,
    pub game_count: usize,
    pub details: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddGamePayload {
    pub name: String,
    pub launcher: Option<String>,
    pub install_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertGamePayload {
    pub game: GameEntry,
}

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

import { invoke } from "@tauri-apps/api/core";

import type {
  AddGamePayload,
  AppSettings,
  AuthStatus,
  DashboardData,
  GameEntry,
  GoogleUserInfo,
  OAuthCredentials,
  PathValidation,
  SaveInfo,
  SaveTokensPayload,
  SyncResult,
  UpdateGamePayload,
} from "../types/dashboard";

export async function loadDashboard(): Promise<DashboardData> {
  return invoke<DashboardData>("load_dashboard");
}

export async function addManualGame(
  payload: AddGamePayload,
): Promise<DashboardData> {
  return invoke<DashboardData>("add_manual_game", { payload });
}

export async function updateGame(
  game: GameEntry,
): Promise<DashboardData> {
  const payload: UpdateGamePayload = { game };
  return invoke<DashboardData>("update_game", { payload });
}

export async function removeGame(gameId: string): Promise<DashboardData> {
  return invoke<DashboardData>("remove_game", { gameId });
}

// ── Auth (plugin-based OAuth) ─────────────────────────────────────────────

export async function checkAuthStatus(): Promise<AuthStatus> {
  return invoke<AuthStatus>("check_auth_status");
}

export async function saveAuthTokens(
  payload: SaveTokensPayload,
): Promise<AuthStatus> {
  return invoke<AuthStatus>("save_auth_tokens", { payload });
}

export async function getOAuthCredentials(): Promise<OAuthCredentials> {
  return invoke<OAuthCredentials>("get_oauth_credentials");
}

export async function logout(): Promise<AuthStatus> {
  return invoke<AuthStatus>("logout");
}

export async function getGoogleUserInfo(): Promise<GoogleUserInfo> {
  return invoke<GoogleUserInfo>("get_google_user_info");
}

// ── Settings ──────────────────────────────────────────────────────────────────

export async function getSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("get_settings");
}

export async function updateSettings(
  settings: AppSettings,
): Promise<AppSettings> {
  return invoke<AppSettings>("update_settings", { settings });
}

// ── Save Info ─────────────────────────────────────────────────────────────────

export async function getSaveInfo(gameId: string): Promise<SaveInfo> {
  return invoke<SaveInfo>("get_save_info", { gameId });
}

// ── Sync ──────────────────────────────────────────────────────────────────────

export async function syncGame(gameId: string): Promise<SyncResult> {
  return invoke<SyncResult>("sync_game", { gameId });
}

export async function syncAllGames(): Promise<SyncResult[]> {
  return invoke<SyncResult[]>("sync_all_games");
}

// ── Watcher toggles ──────────────────────────────────────────────────────────

export async function toggleTrackChanges(
  gameId: string,
  enabled: boolean,
): Promise<DashboardData> {
  return invoke<DashboardData>("toggle_track_changes", { gameId, enabled });
}

export async function toggleAutoSync(
  gameId: string,
  enabled: boolean,
): Promise<DashboardData> {
  return invoke<DashboardData>("toggle_auto_sync", { gameId, enabled });
}

// ── Path Validation ──────────────────────────────────────────────────────────

export async function validateSavePaths(): Promise<PathValidation[]> {
  return invoke<PathValidation[]>("validate_save_paths");
}

export async function getBrowseDefaultPath(): Promise<string | null> {
  return invoke<string | null>("get_browse_default_path");
}

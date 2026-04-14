import { invoke } from "@tauri-apps/api/core";

import type {
  AddGamePayload,
  AppSettings,
  AuthStatus,
  DashboardData,
  DriveFileFlatItem,
  DriveFileItem,
  DriveVersionBackup,
  GameEntry,
  GoogleUserInfo,
  OAuthCredentials,
  PathValidation,
  SaveInfo,
  SaveTokensPayload,
  SyncResult,
  SyncStructureDiff,
  UpdateGamePayload,
} from "../types/dashboard";

export async function loadDashboard(): Promise<DashboardData> {
  return invoke<DashboardData>("load_dashboard");
}

export async function addManualGame(payload: AddGamePayload): Promise<DashboardData> {
  return invoke<DashboardData>("add_manual_game", { payload });
}

export async function updateGame(game: GameEntry): Promise<DashboardData> {
  const payload: UpdateGamePayload = { game };
  return invoke<DashboardData>("update_game", { payload });
}

export async function removeGame(gameId: string): Promise<DashboardData> {
  return invoke<DashboardData>("remove_game", { gameId });
}

export async function clearAllDriveData(): Promise<DashboardData> {
  return invoke<DashboardData>("clear_all_drive_data");
}

// ── Auth (plugin-based OAuth) ─────────────────────────────────────────────

export async function checkAuthStatus(): Promise<AuthStatus> {
  return invoke<AuthStatus>("check_auth_status");
}

export async function saveAuthTokens(payload: SaveTokensPayload): Promise<AuthStatus> {
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

export async function updateSettings(settings: AppSettings): Promise<AppSettings> {
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

/** Pull library.json from Drive and overwrite local game list. Returns updated dashboard. */
export async function syncLibraryFromCloud(): Promise<DashboardData> {
  return invoke<DashboardData>("sync_library_from_cloud");
}

/** Check the diff between local saves and Drive without transferring files. */
export async function checkSyncStructureDiff(gameId: string): Promise<SyncStructureDiff> {
  return invoke<SyncStructureDiff>("check_sync_structure_diff", { gameId });
}

/** Force-download all Drive saves to local (newest-wins is skipped). */
export async function restoreFromCloud(gameId: string): Promise<SyncResult> {
  return invoke<SyncResult>("restore_from_cloud", { gameId });
}

/** Force-upload all local saves to Drive (newest-wins is skipped). */
export async function pushToCloud(gameId: string): Promise<SyncResult> {
  return invoke<SyncResult>("push_to_cloud", { gameId });
}

// ── Watcher toggles ──────────────────────────────────────────────────────────

export async function toggleTrackChanges(gameId: string, enabled: boolean): Promise<DashboardData> {
  return invoke<DashboardData>("toggle_track_changes", { gameId, enabled });
}

export async function toggleAutoSync(gameId: string, enabled: boolean): Promise<DashboardData> {
  return invoke<DashboardData>("toggle_auto_sync", { gameId, enabled });
}

export async function launchGame(gameId: string): Promise<void> {
  return invoke<void>("launch_game", { gameId });
}

// ── Path Validation ──────────────────────────────────────────────────────────

export async function validateSavePaths(): Promise<PathValidation[]> {
  return invoke<PathValidation[]>("validate_save_paths");
}

export async function getBrowseDefaultPath(): Promise<string | null> {
  return invoke<string | null>("get_browse_default_path");
}

export async function expandSavePath(path: string): Promise<string> {
  return invoke<string>("expand_save_path", { path });
}

export async function contractPath(path: string): Promise<string> {
  return invoke<string>("contract_path", { path });
}

// ── Logo upload ───────────────────────────────────────────────────────────────

/**
 * Validate a game logo (≤ 3 MB) and upload it to the game's Google Drive folder.
 * `logoSource` is a local file path or an HTTPS image URL.
 * Throws if the logo exceeds 3 MB or if the Drive upload fails.
 */
export async function uploadGameLogo(gameId: string, logoSource: string): Promise<void> {
  return invoke<void>("upload_game_logo", { gameId, logoSource });
}

// ── Drive file management ─────────────────────────────────────────────────────

/** List all items (files + folders) in the game's Drive folder, or a subfolder when `folderId` is given. */
export async function listGameDriveFiles(gameId: string, folderId?: string): Promise<DriveFileItem[]> {
  return invoke<DriveFileItem[]>("list_game_drive_files", { gameId, folderId });
}

/** Recursively list every item in the game's Drive folder with relative paths (flat list, full tree). */
export async function listGameDriveFilesFlat(gameId: string): Promise<DriveFileFlatItem[]> {
  return invoke<DriveFileFlatItem[]>("list_game_drive_files_flat", { gameId });
}

/** Rename a Drive file or folder. Updates .sync-meta.json for regular files. */
export async function renameGameDriveFile(
  gameId: string,
  fileId: string,
  oldName: string,
  newName: string,
  isFolder: boolean
): Promise<void> {
  return invoke<void>("rename_game_drive_file", { gameId, fileId, oldName, newName, isFolder });
}

/** Move a Drive file to a different subfolder within the game's Drive folder. */
export async function moveGameDriveFile(
  gameId: string,
  fileId: string,
  fileName: string,
  newParentId: string,
  oldParentId: string
): Promise<void> {
  return invoke<void>("move_game_drive_file", {
    gameId,
    fileId,
    fileName,
    newParentId,
    oldParentId,
  });
}

/** Delete a Drive file or folder. Updates .sync-meta.json for regular files. */
export async function deleteGameDriveFile(gameId: string, fileId: string, fileName: string, isFolder: boolean): Promise<void> {
  return invoke<void>("delete_game_drive_file", { gameId, fileId, fileName, isFolder });
}

// ── Version backups ───────────────────────────────────────────────────────────

/** Create a manual version backup for a game. `label` is an optional display name. */
export async function createVersionBackup(gameId: string, label?: string): Promise<DriveVersionBackup> {
  return invoke<DriveVersionBackup>("create_version_backup", {
    gameId,
    label: label ?? null,
  });
}

/** List all version backups for a game, sorted newest-first. */
export async function listVersionBackups(gameId: string): Promise<DriveVersionBackup[]> {
  return invoke<DriveVersionBackup[]>("list_version_backups", { gameId });
}

/**
 * Restore a version backup: copies backup files to the Drive game root and downloads
 * them to the local save folder. Returns a SyncResult with the download count.
 */
export async function restoreVersionBackup(gameId: string, backupFolderId: string): Promise<SyncResult> {
  return invoke<SyncResult>("restore_version_backup", { gameId, backupFolderId });
}

/** Delete a version backup folder (and all its files) from Drive. */
export async function deleteVersionBackup(gameId: string, backupFolderId: string): Promise<void> {
  return invoke<void>("delete_version_backup", { gameId, backupFolderId });
}

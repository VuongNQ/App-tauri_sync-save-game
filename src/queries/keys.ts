/** Centralised React Query key registry. */

export const DASHBOARD_KEY = ["dashboard"] as const;
export type DashboardKey = typeof DASHBOARD_KEY;

export const AUTH_STATUS_KEY = ["auth-status"] as const;
export type AuthStatusKey = typeof AUTH_STATUS_KEY;

export const GOOGLE_USER_INFO_KEY = ["google-user-info"] as const;
export type GoogleUserInfoKey = typeof GOOGLE_USER_INFO_KEY;

export const SETTINGS_KEY = ["settings"] as const;
export type SettingsKey = typeof SETTINGS_KEY;

export const SAVE_INFO_KEY = ["save-info"] as const;
export type SaveInfoKey = typeof SAVE_INFO_KEY;

export const VALIDATE_PATHS_KEY = ["validate-paths"] as const;
export type ValidatePathsKey = typeof VALIDATE_PATHS_KEY;

/** Prefix key used for invalidating all cached folder queries of a game. */
export const driveFilesKey = (gameId: string) => ["drive-files", gameId] as const;
/** Specific key for a given folder inside a game's Drive folder tree. */
export const driveFilesFolderKey = (gameId: string, folderId: string) =>
  ["drive-files", gameId, folderId] as const;
export const versionBackupsKey = (gameId: string) => ["version-backups", gameId] as const;

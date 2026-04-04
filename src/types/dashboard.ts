export type GameSource = "emulator" | "manual";

export interface GameEntry {
  id: string;
  name: string;
  description: string | null;
  thumbnail: string | null;
  source: GameSource;
  savePath: string | null;
  trackChanges: boolean;
  autoSync: boolean;
  lastLocalModified: string | null;
  lastCloudModified: string | null;
  gdriveFolderId: string | null;
  /** Total bytes stored in Google Drive for this game's save files. */
  cloudStorageBytes: number | null;
}

export interface DashboardData {
  games: GameEntry[];
}

export interface AddGamePayload {
  name: string;
  description: string | null;
  thumbnail: string | null;
  source: GameSource;
  savePath: string | null;
}

export interface UpdateGamePayload {
  game: GameEntry;
}

export interface AuthStatus {
  authenticated: boolean;
}

export interface SaveTokensPayload {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
}

export interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
}

export interface GoogleUserInfo {
  /** Stable numeric Google account ID. */
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
}

// ── Settings ──────────────────────────────────────────────

export interface AppSettings {
  globalAutoSync: boolean;
  syncIntervalMinutes: number;
  startMinimised: boolean;
  runOnStartup: boolean;
}

// ── Save Info ─────────────────────────────────────────────

export interface SaveFileInfo {
  relativePath: string;
  size: number;
  modifiedTime: string;
}

export interface SaveInfo {
  gameId: string;
  savePath: string;
  totalFiles: number;
  totalSize: number;
  lastModified: string | null;
  files: SaveFileInfo[];
}

// ── Sync ──────────────────────────────────────────────────

export interface SyncStructureDiff {
  gameId: string;
  /** `false` when no sync data exists on Drive (game never synced). */
  cloudHasData: boolean;
  localOnlyFiles: string[];
  cloudOnlyFiles: string[];
  localNewerFiles: string[];
  cloudNewerFiles: string[];
  hasDiff: boolean;
}

export interface SyncResult {
  gameId: string;
  uploaded: number;
  downloaded: number;
  skipped: number;
  error: string | null;
}

// ── Path Validation ───────────────────────────────────────

export interface PathValidation {
  gameId: string;
  valid: boolean;
}

// ── Drive File Management ─────────────────────────────────

/** A single item (file or folder) inside a game's Google Drive folder. */
export interface DriveFileItem {
  id: string;
  name: string;
  mimeType: string;
  size: number | null;
  modifiedTime: string | null;
  isFolder: boolean;
}

/** A version-backup snapshot stored under the game's `backups/` Drive folder. */
export interface DriveVersionBackup {
  /** Drive folder ID of the backup subfolder. */
  id: string;
  /** Display name: ISO-8601 timestamp, optionally suffixed with " — {label}". */
  name: string;
  createdTime: string;
  totalFiles: number;
  totalSize: number;
}

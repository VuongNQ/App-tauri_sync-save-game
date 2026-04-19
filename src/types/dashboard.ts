export type GameSource = "emulator" | "manual";

export interface SavePathEntry {
  label: string;
  path: string | null;
  gdriveFolderId: string | null;
  syncExcludes: string[];
}

export interface GameEntry {
  id: string;
  name: string;
  description: string | null;
  thumbnail: string | null;
  source: GameSource;
  /** Multiple save-path entries for this game. Primary path is index 0. */
  savePaths: SavePathEntry[];
  /** Process name to watch (e.g. "GameName.exe"). Sync triggers when this process exits. */
  exeName: string | null;
  /** Full path to the game executable. Used to launch the game from the app. */
  exePath: string | null;
  trackChanges: boolean;
  autoSync: boolean;
  lastLocalModified: string | null;
  lastCloudModified: string | null;
  gdriveFolderId: string | null;
  /** Total bytes stored in Google Drive for this game's save files. */
  cloudStorageBytes: number | null;
  /**
   * Save-path mode for this game.
   * - `"auto"` (default): portable `%VAR%` token paths shared across devices.
   * - `"per_device"`: each machine stores its own path locally; not shared via Firestore.
   */
  pathMode: "auto" | "per_device";
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
  exeName?: string | null;
  /** Full path to the game executable (tokenised). Optional at creation. */
  exePath?: string | null;
  /** Save-path mode: "auto" = portable shared paths; "per_device" = device-specific local paths. */
  pathMode?: "auto" | "per_device";
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

// ── Devices ───────────────────────────────────────────────

/** A registered device (machine) for the authenticated Google account. */
export interface DeviceInfo {
  /** Deterministic UUID derived from the Windows MachineGuid registry value. */
  id: string;
  /** User-editable display name (auto-populated from hostname on first registration). */
  name: string;
  /** OS-reported computer hostname. */
  hostname: string;
  /** OS name (e.g. "Windows 11"). */
  osName: string;
  /** OS version string (e.g. "23H2"). */
  osVersion: string;
  /** CPU brand string. */
  cpuName: string;
  /** Number of logical CPU cores. */
  cpuCores: number;
  /** Total system RAM in megabytes. */
  totalRamMb: number;
  /** ISO 8601 timestamp when this device was first registered. */
  registeredAt: string;
  /** ISO 8601 timestamp of the most recent registration / startup upsert. */
  lastSeenAt: string;
  /** True when this device is the one currently running the app. Computed, never stored. */
  isCurrent?: boolean;
}

// ── Settings ──────────────────────────────────────────────

export interface AppSettings {
  syncIntervalMinutes: number;
  startMinimised: boolean;
  runOnStartup: boolean;
  /** Device-specific save-path overrides keyed by game id. Local-only — never synced to Firestore. */
  pathOverrides: Record<string, string>;
  /** Device-specific save-path overrides for extra paths keyed by "{gameId}:{index}". Local-only. */
  pathOverridesIndexed: Record<string, string>;
}

// ── Save Info ─────────────────────────────────────────────

export interface SaveFileInfo {
  relativePath: string;
  size: number;
  modifiedTime: string;
}

/** Per-path breakdown inside `SaveInfo` when a game has multiple save paths. */
export interface PathSaveInfo {
  label: string;
  savePath: string;
  totalSize: number;
  files: SaveFileInfo[];
}

export interface SaveInfo {
  gameId: string;
  /** Primary (first) save path — kept for single-path backward compat. */
  savePath: string;
  totalFiles: number;
  totalSize: number;
  lastModified: string | null;
  files: SaveFileInfo[];
  /** Per-path breakdown when the game has multiple save paths. Empty when only one path. */
  pathInfos: PathSaveInfo[];
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
  /** Whether the configured save folder exists on this machine. */
  valid: boolean;
  /** null = exe_path not configured; true = file exists; false = configured but not found on this machine. */
  exePathValid: boolean | null;
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

/**
 * A file/folder item with its **relative path** within the game's Drive folder.
 * Returned by `list_game_drive_files_flat` (recursive, full-tree listing).
 */
export interface DriveFileFlatItem {
  id: string;
  name: string;
  /** Relative path within the game's Drive folder, e.g. `"76561197960271872/Default_0.sav"`. */
  relativePath: string;
  size: number | null;
  modifiedTime: string | null;
  isFolder: boolean;
  /** Drive ID of the parent folder that directly contains this item. */
  parentFolderId: string;
  /**
   * The `pathFile` from SyncMeta matched by this file's Drive ID, e.g.
   * `"76561198241997832/UserMetaData.sav"`. `null` when not tracked in SyncMeta.
   */
  syncPath: string | null;
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

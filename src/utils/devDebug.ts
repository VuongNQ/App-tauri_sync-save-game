/**
 * Dev-only Google API debug utility.
 *
 * ONLY available in development builds (import.meta.env.DEV).
 * Mounted at window.__googleDebug by main.tsx.
 *
 * Usage in DevTools console:
 *   window.__googleDebug.help()
 *   window.__googleDebug.auth()
 *   window.__googleDebug.dashboard()
 *   window.__googleDebug.saveInfo("manual-mygame")
 *   window.__googleDebug.devices()
 *   window.__googleDebug.expandPath("%APPDATA%\\MyGame\\saves")
 *   window.__googleDebug.defaultPath()
 *   window.__googleDebug.restoreCloud("manual-mygame")
 *   window.__googleDebug.createBackup("manual-mygame", "pre-patch")
 */

import {
  checkAuthStatus,
  checkSyncStructureDiff,
  contractPath,
  createVersionBackup,
  deleteVersionBackup,
  expandSavePath,
  getBrowseDefaultPath,
  getDevices,
  getGoogleUserInfo,
  getOAuthCredentials,
  getSettings,
  getSaveInfo,
  listGameDriveFiles,
  listGameDriveFilesFlat,
  listVersionBackups,
  loadDashboard,
  pushToCloud,
  restoreFromCloud,
  restoreVersionBackup,
  syncGame,
  syncAllGames,
  syncLibraryFromCloud,
  validateSavePaths,
} from "../services/tauri";

// ── Window augmentation ───────────────────────────────────

declare global {
  interface Window {
    __googleDebug: GoogleDebugNamespace;
  }
}

// ── Namespace shape ───────────────────────────────────────

interface GoogleDebugNamespace {
  help: () => void;

  // Auth
  auth: () => Promise<unknown>;
  userInfo: () => Promise<unknown>;
  oauthCreds: () => Promise<unknown>;

  // Dashboard
  dashboard: () => Promise<unknown>;
  settings: () => Promise<unknown>;
  validatePaths: () => Promise<unknown>;

  // Devices
  devices: () => Promise<unknown>;

  // Path utilities
  expandPath: (path: string) => Promise<unknown>;
  contractPath: (path: string) => Promise<unknown>;
  defaultPath: () => Promise<unknown>;

  // Per-game (read)
  saveInfo: (gameId: string) => Promise<unknown>;
  syncDiff: (gameId: string) => Promise<unknown>;
  driveFiles: (gameId: string, folderId?: string) => Promise<unknown>;
  driveFilesFlat: (gameId: string) => Promise<unknown>;
  backups: (gameId: string) => Promise<unknown>;

  // Sync triggers
  sync: (gameId: string) => Promise<unknown>;
  syncAll: () => Promise<unknown>;

  // Forced-direction sync
  syncLibrary: () => Promise<unknown>;
  restoreCloud: (gameId: string) => Promise<unknown>;
  pushCloud: (gameId: string) => Promise<unknown>;

  // Backup management
  createBackup: (gameId: string, label?: string) => Promise<unknown>;
  restoreBackup: (gameId: string, backupFolderId: string) => Promise<unknown>;
  deleteBackup: (gameId: string, backupFolderId: string) => Promise<unknown>;
}

// ── Helpers ───────────────────────────────────────────────

function log(label: string, data: unknown): void {
  console.group(`[__googleDebug] ${label}`);
  if (Array.isArray(data)) {
    console.table(data);
  } else {
    console.log(data);
  }
  console.groupEnd();
}

async function call<T>(label: string, fn: () => Promise<T>): Promise<T> {
  console.log(`[__googleDebug] ▶ ${label}`);
  try {
    const result = await fn();
    log(`✅ ${label}`, result);
    return result;
  } catch (err) {
    console.error(`[__googleDebug] ❌ ${label}`, err);
    throw err;
  }
}

// ── Debug namespace implementation ────────────────────────

export const devDebug: GoogleDebugNamespace = {
  help() {
    console.group("[__googleDebug] Available commands");
    console.table([
      { command: "help()", description: "Show this help table" },
      // Auth
      { command: "auth()", description: "checkAuthStatus() — OAuth token present?" },
      { command: "userInfo()", description: "getGoogleUserInfo() — id, email, name, picture" },
      { command: "oauthCreds()", description: "getOAuthCredentials() — CLIENT_ID used by plugin" },
      // Dashboard
      { command: "dashboard()", description: "loadDashboard() — full game library" },
      { command: "settings()", description: "getSettings() — syncInterval, startMinimised, runOnStartup" },
      { command: "validatePaths()", description: "validateSavePaths() — check all game save folders" },
      // Devices
      { command: "devices()", description: "getDevices() — all registered machines for this account" },
      // Path utilities
      { command: "expandPath(path)", description: "expandSavePath() — expand %VAR% tokens to absolute path" },
      { command: "contractPath(path)", description: "contractPath() — convert absolute path to portable %VAR% form" },
      { command: "defaultPath()", description: "getBrowseDefaultPath() — default folder for the file picker" },
      // Per-game
      { command: "saveInfo(gameId)", description: "getSaveInfo() — local save files list + sizes" },
      { command: "syncDiff(gameId)", description: "checkSyncStructureDiff() — local vs Drive diff" },
      { command: "driveFiles(gameId, folderId?)", description: "listGameDriveFiles() — items in Drive folder" },
      { command: "driveFilesFlat(gameId)", description: "listGameDriveFilesFlat() — full Drive tree as flat list" },
      { command: "backups(gameId)", description: "listVersionBackups() — version backup list" },
      // Sync
      { command: "sync(gameId)", description: "syncGame() — trigger sync for one game" },
      { command: "syncAll()", description: "syncAllGames() — trigger sync for all games" },
      // Forced-direction sync
      { command: "syncLibrary()", description: "syncLibraryFromCloud() — pull library from Drive → overwrite local" },
      { command: "restoreCloud(gameId)", description: "restoreFromCloud() — force-download Drive saves (skip newest-wins)" },
      { command: "pushCloud(gameId)", description: "pushToCloud() — force-upload local saves (skip newest-wins)" },
      // Backup management
      { command: "createBackup(gameId, label?)", description: "createVersionBackup() — snapshot current saves to Drive" },
      { command: "restoreBackup(gameId, folderId)", description: "restoreVersionBackup() — restore a version backup to local" },
      { command: "deleteBackup(gameId, folderId)", description: "deleteVersionBackup() — delete a version backup from Drive" },
    ]);
    console.groupEnd();
  },

  // ── Auth ────────────────────────────────────────────────

  auth: () => call("checkAuthStatus()", checkAuthStatus),

  userInfo: () => call("getGoogleUserInfo()", getGoogleUserInfo),

  oauthCreds: () => call("getOAuthCredentials()", getOAuthCredentials),

  // ── Dashboard ───────────────────────────────────────────

  dashboard: () => call("loadDashboard()", loadDashboard),

  settings: () => call("getSettings()", getSettings),

  validatePaths: () => call("validateSavePaths()", validateSavePaths),

  // ── Devices ─────────────────────────────────────────────

  devices: () => call("getDevices()", getDevices),

  // ── Path utilities ───────────────────────────────────────

  expandPath: (path) => call(`expandSavePath("${path}")`, () => expandSavePath(path)),

  contractPath: (path) => call(`contractPath("${path}")`, () => contractPath(path)),

  defaultPath: () => call("getBrowseDefaultPath()", getBrowseDefaultPath),

  // ── Per-game ────────────────────────────────────────────

  saveInfo: (gameId) => call(`getSaveInfo("${gameId}")`, () => getSaveInfo(gameId)),

  syncDiff: (gameId) => call(`checkSyncStructureDiff("${gameId}")`, () => checkSyncStructureDiff(gameId)),

  driveFiles: (gameId, folderId) =>
    call(`listGameDriveFiles("${gameId}"${folderId ? `, "${folderId}"` : ""})`, () => listGameDriveFiles(gameId, folderId)),

  driveFilesFlat: (gameId) => call(`listGameDriveFilesFlat("${gameId}")`, () => listGameDriveFilesFlat(gameId)),

  backups: (gameId) => call(`listVersionBackups("${gameId}")`, () => listVersionBackups(gameId)),

  // ── Sync triggers ────────────────────────────────────────

  sync: (gameId) => call(`syncGame("${gameId}")`, () => syncGame(gameId)),

  syncAll: () => call("syncAllGames()", syncAllGames),

  // ── Forced-direction sync ────────────────────────────────

  syncLibrary: () => call("syncLibraryFromCloud()", syncLibraryFromCloud),

  restoreCloud: (gameId) => call(`restoreFromCloud("${gameId}")`, () => restoreFromCloud(gameId)),

  pushCloud: (gameId) => call(`pushToCloud("${gameId}")`, () => pushToCloud(gameId)),

  // ── Backup management ────────────────────────────────────

  createBackup: (gameId, label) =>
    call(`createVersionBackup("${gameId}"${label ? `, "${label}"` : ""})`, () => createVersionBackup(gameId, label)),

  restoreBackup: (gameId, backupFolderId) =>
    call(`restoreVersionBackup("${gameId}", "${backupFolderId}")`, () => restoreVersionBackup(gameId, backupFolderId)),

  deleteBackup: (gameId, backupFolderId) =>
    call(`deleteVersionBackup("${gameId}", "${backupFolderId}")`, () => deleteVersionBackup(gameId, backupFolderId)),
};

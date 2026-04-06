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
 */

import {
  checkAuthStatus,
  checkSyncStructureDiff,
  getGoogleUserInfo,
  getOAuthCredentials,
  getSettings,
  getSaveInfo,
  listGameDriveFiles,
  listVersionBackups,
  loadDashboard,
  syncGame,
  syncAllGames,
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

  // Per-game (read)
  saveInfo: (gameId: string) => Promise<unknown>;
  syncDiff: (gameId: string) => Promise<unknown>;
  driveFiles: (gameId: string, folderId?: string) => Promise<unknown>;
  backups: (gameId: string) => Promise<unknown>;

  // Sync triggers
  sync: (gameId: string) => Promise<unknown>;
  syncAll: () => Promise<unknown>;
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
      // Per-game
      { command: "saveInfo(gameId)", description: "getSaveInfo() — local save files list + sizes" },
      { command: "syncDiff(gameId)", description: "checkSyncStructureDiff() — local vs Drive diff" },
      { command: "driveFiles(gameId, folderId?)", description: "listGameDriveFiles() — items in Drive folder" },
      { command: "backups(gameId)", description: "listVersionBackups() — version backup list" },
      // Sync
      { command: "sync(gameId)", description: "syncGame() — trigger sync for one game" },
      { command: "syncAll()", description: "syncAllGames() — trigger sync for all games" },
    ]);
    console.groupEnd();
  },

  // ── Auth ────────────────────────────────────────────────

  auth: () =>
    call("checkAuthStatus()", checkAuthStatus),

  userInfo: () =>
    call("getGoogleUserInfo()", getGoogleUserInfo),

  oauthCreds: () =>
    call("getOAuthCredentials()", getOAuthCredentials),

  // ── Dashboard ───────────────────────────────────────────

  dashboard: () =>
    call("loadDashboard()", loadDashboard),

  settings: () =>
    call("getSettings()", getSettings),

  validatePaths: () =>
    call("validateSavePaths()", validateSavePaths),

  // ── Per-game ────────────────────────────────────────────

  saveInfo: (gameId) =>
    call(`getSaveInfo("${gameId}")`, () => getSaveInfo(gameId)),

  syncDiff: (gameId) =>
    call(`checkSyncStructureDiff("${gameId}")`, () => checkSyncStructureDiff(gameId)),

  driveFiles: (gameId, folderId) =>
    call(`listGameDriveFiles("${gameId}"${folderId ? `, "${folderId}"` : ""})`, () =>
      listGameDriveFiles(gameId, folderId),
    ),

  backups: (gameId) =>
    call(`listVersionBackups("${gameId}")`, () => listVersionBackups(gameId)),

  // ── Sync triggers ────────────────────────────────────────

  sync: (gameId) =>
    call(`syncGame("${gameId}")`, () => syncGame(gameId)),

  syncAll: () =>
    call("syncAllGames()", syncAllGames),
};

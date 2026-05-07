import { mutationOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  checkSyncStructureDiff,
  cleanExcludedDriveFiles,
  createVersionBackup,
  deleteGameDriveFile,
  deleteVersionBackup,
  getSaveInfo,
  listGameDriveFiles,
  listGameDriveFilesFlat,
  listVersionBackups,
  moveGameDriveFile,
  pushToCloud,
  renameGameDriveFile,
  restoreFromCloud,
  restoreVersionBackup,
  syncAllGames,
  syncGame,
  syncLibraryFromCloud,
  toggleAutoSync,
  toggleTrackChanges,
} from "../services/tauri";
import type { DashboardData, SyncResult } from "../types/dashboard";
import {
  DASHBOARD_KEY,
  VALIDATE_PATHS_KEY,
  driveFilesKey,
  driveFilesFlatKey,
  driveFilesFolderKey,
  gameSyncingKey,
  gameSyncResultKey,
  saveInfoKey,
  versionBackupsKey,
} from "./keys";

function useSetDashboardCache() {
  const queryClient = useQueryClient();
  return (data: DashboardData) => queryClient.setQueryData<DashboardData>(DASHBOARD_KEY, data);
}

export const SyncGameMutation = (id: string) =>
  mutationOptions({
    mutationKey: ["syncGame", id],
    mutationFn: () => syncGame(id),
  });

export function useSyncGameMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    ...SyncGameMutation(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: DASHBOARD_KEY }),
  });
}

export function useSyncAllMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ["syncAllGames"],
    mutationFn: () => syncAllGames(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: DASHBOARD_KEY }),
  });
}

export function useSyncLibraryFromCloudMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => syncLibraryFromCloud(),
    onSuccess: (data) => {
      queryClient.setQueryData<DashboardData>(DASHBOARD_KEY, data);
    },
  });
}

export function useToggleTrackChangesMutation() {
  const setCache = useSetDashboardCache();
  return useMutation({
    mutationFn: ({ gameId, enabled }: { gameId: string; enabled: boolean }) => toggleTrackChanges(gameId, enabled),
    onSuccess: setCache,
  });
}

export function useToggleAutoSyncMutation() {
  const setCache = useSetDashboardCache();
  return useMutation({
    mutationFn: ({ gameId, enabled }: { gameId: string; enabled: boolean }) => toggleAutoSync(gameId, enabled),
    onSuccess: setCache,
  });
}

export function useGetSaveInfoQuery(gameId: string, enabled = true) {
  return useQuery({
    queryKey: saveInfoKey(gameId),
    queryFn: () => getSaveInfo(gameId),
    enabled,
  });
}

export function useCheckSyncDiffMutation() {
  return useMutation({
    mutationFn: (gameId: string) => checkSyncStructureDiff(gameId),
  });
}

export function useRestoreFromCloudMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (gameId: string) => restoreFromCloud(gameId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: DASHBOARD_KEY });
      queryClient.invalidateQueries({ queryKey: VALIDATE_PATHS_KEY });
    },
  });
}

export function usePushToCloudMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (gameId: string) => pushToCloud(gameId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: DASHBOARD_KEY }),
  });
}

export function useCleanExcludedDriveFilesMutation() {
  const setCache = useSetDashboardCache();
  return useMutation({
    mutationFn: (gameId: string) => cleanExcludedDriveFiles(gameId),
    onSuccess: setCache,
  });
}

// ── Drive file management hooks ────────────────────────────────────────────────

/** Lazily fetch the list of Drive items for a game folder or subfolder. Pass `enabled: false` to skip. */
export function useDriveFilesQuery(gameId: string, folderId: string, enabled = true) {
  return useQuery({
    queryKey: driveFilesFolderKey(gameId, folderId),
    queryFn: () => listGameDriveFiles(gameId, folderId),
    enabled,
    staleTime: Infinity,
  });
}

/** Recursively list all items in the game's Drive folder as a flat list with relative paths. */
export function useDriveFilesFlatQuery(gameId: string, enabled = true) {
  return useQuery({
    queryKey: driveFilesFlatKey(gameId),
    queryFn: () => listGameDriveFilesFlat(gameId),
    enabled,
    staleTime: Infinity,
  });
}

export function useRenameDriveFileMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      gameId,
      fileId,
      oldName,
      newName,
      isFolder,
    }: {
      gameId: string;
      fileId: string;
      oldName: string;
      newName: string;
      isFolder: boolean;
    }) => renameGameDriveFile(gameId, fileId, oldName, newName, isFolder),
    onSuccess: (_data, { gameId }) => {
      queryClient.invalidateQueries({ queryKey: driveFilesKey(gameId) });
      queryClient.invalidateQueries({ queryKey: driveFilesFlatKey(gameId) });
    },
  });
}

export function useMoveDriveFileMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      gameId,
      fileId,
      fileName,
      newParentId,
      oldParentId,
    }: {
      gameId: string;
      fileId: string;
      fileName: string;
      newParentId: string;
      oldParentId: string;
    }) => moveGameDriveFile(gameId, fileId, fileName, newParentId, oldParentId),
    onSuccess: (_data, { gameId }) => {
      queryClient.invalidateQueries({ queryKey: driveFilesKey(gameId) });
      queryClient.invalidateQueries({ queryKey: driveFilesFlatKey(gameId) });
    },
  });
}

export function useDeleteDriveFileMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ gameId, fileId, fileName, isFolder }: { gameId: string; fileId: string; fileName: string; isFolder: boolean }) =>
      deleteGameDriveFile(gameId, fileId, fileName, isFolder),
    onSuccess: (_data, { gameId }) => {
      queryClient.invalidateQueries({ queryKey: driveFilesKey(gameId) });
      queryClient.invalidateQueries({ queryKey: driveFilesFlatKey(gameId) });
    },
  });
}

// ── Version backup hooks ───────────────────────────────────────────────────────

/** Lazily fetch the list of version backups for a game. Pass `enabled: false` to skip. */
export function useVersionBackupsQuery(gameId: string, enabled = true) {
  return useQuery({
    queryKey: versionBackupsKey(gameId),
    queryFn: () => listVersionBackups(gameId),
    enabled,
    staleTime: Infinity,
  });
}

export function useCreateVersionBackupMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ gameId, label }: { gameId: string; label?: string }) => createVersionBackup(gameId, label),
    onSuccess: (_data, { gameId }) => queryClient.invalidateQueries({ queryKey: versionBackupsKey(gameId) }),
  });
}

export function useRestoreVersionBackupMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ gameId, backupFolderId }: { gameId: string; backupFolderId: string }) => restoreVersionBackup(gameId, backupFolderId),
    onSuccess: (_data, { gameId }) => {
      queryClient.invalidateQueries({ queryKey: DASHBOARD_KEY });
      queryClient.invalidateQueries({ queryKey: driveFilesKey(gameId) });
      queryClient.invalidateQueries({ queryKey: VALIDATE_PATHS_KEY });
    },
  });
}

export function useDeleteVersionBackupMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ gameId, backupFolderId }: { gameId: string; backupFolderId: string }) => deleteVersionBackup(gameId, backupFolderId),
    onSuccess: (_data, { gameId }) => queryClient.invalidateQueries({ queryKey: versionBackupsKey(gameId) }),
  });
}

// ── Sync status hooks (driven by Tauri events, no network calls) ──────────────

/** Returns `true` while Rust is syncing the given game. Driven by sync-started / sync-completed / sync-error events. */
export function useGameSyncingQuery(gameId: string): boolean {
  const { data } = useQuery<boolean>({
    queryKey: gameSyncingKey(gameId),
    queryFn: () => false,
    enabled: false,
    staleTime: Infinity,
  });
  return data ?? false;
}

/** Returns the most recent `SyncResult` for the given game, or `null` if never synced this session. */
export function useGameSyncResultQuery(gameId: string): SyncResult | null {
  const { data } = useQuery<SyncResult | null>({
    queryKey: gameSyncResultKey(gameId),
    queryFn: () => null,
    enabled: false,
    staleTime: Infinity,
  });
  return data ?? null;
}

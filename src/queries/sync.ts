import { mutationOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  checkSyncStructureDiff,
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
import type { DashboardData } from "../types/dashboard";
import {
  DASHBOARD_KEY,
  VALIDATE_PATHS_KEY,
  driveFilesKey,
  driveFilesFlatKey,
  driveFilesFolderKey,
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

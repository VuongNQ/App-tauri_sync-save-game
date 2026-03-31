import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  syncAllGames,
  syncGame,
  toggleAutoSync,
  toggleTrackChanges,
} from "../services/tauri";
import type { DashboardData } from "../types/dashboard";
import { DASHBOARD_KEY } from "./keys";

function useSetDashboardCache() {
  const queryClient = useQueryClient();
  return (data: DashboardData) =>
    queryClient.setQueryData<DashboardData>(DASHBOARD_KEY, data);
}

export function useSyncGameMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (gameId: string) => syncGame(gameId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: DASHBOARD_KEY }),
  });
}

export function useSyncAllMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => syncAllGames(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: DASHBOARD_KEY }),
  });
}

export function useToggleTrackChangesMutation() {
  const setCache = useSetDashboardCache();
  return useMutation({
    mutationFn: ({ gameId, enabled }: { gameId: string; enabled: boolean }) =>
      toggleTrackChanges(gameId, enabled),
    onSuccess: setCache,
  });
}

export function useToggleAutoSyncMutation() {
  const setCache = useSetDashboardCache();
  return useMutation({
    mutationFn: ({ gameId, enabled }: { gameId: string; enabled: boolean }) =>
      toggleAutoSync(gameId, enabled),
    onSuccess: setCache,
  });
}

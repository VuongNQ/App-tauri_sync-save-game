import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { addManualGame, loadDashboard, removeGame, updateGame, validateSavePaths } from "../services/tauri";
import type { AddGamePayload, DashboardData, GameEntry } from "../types/dashboard";
import { DASHBOARD_KEY, VALIDATE_PATHS_KEY } from "./keys";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function useSetDashboardCache() {
  const queryClient = useQueryClient();
  return (data: DashboardData) => {
    queryClient.setQueryData<DashboardData>(DASHBOARD_KEY, data);
    queryClient.invalidateQueries({ queryKey: VALIDATE_PATHS_KEY });
  };
}

// ─── Query ────────────────────────────────────────────────────────────────────
export const DashboardQuery = queryOptions({
  queryKey: DASHBOARD_KEY,
  queryFn: loadDashboard,
});

export function useDashboardQuery() {
  return useQuery(DashboardQuery);
}

// ─── Mutations ───────────────────────────────────────────────────────────────

export function useAddGameMutation() {
  const setCache = useSetDashboardCache();
  return useMutation({
    mutationFn: (payload: AddGamePayload) => addManualGame(payload),
    onSuccess: setCache,
  });
}

export function useUpdateGameMutation() {
  const setCache = useSetDashboardCache();
  return useMutation({
    mutationFn: (game: GameEntry) => updateGame(game),
    onSuccess: setCache,
  });
}

export function useRemoveGameMutation() {
  const setCache = useSetDashboardCache();
  return useMutation({
    mutationFn: (gameId: string) => removeGame(gameId),
    onSuccess: setCache,
  });
}

// ─── Path Validation ─────────────────────────────────────────────────────────

export const ValidatePathsQuery = queryOptions({
  queryKey: VALIDATE_PATHS_KEY,
  queryFn: validateSavePaths,
});

export function useValidatePathsQuery() {
  return useQuery(ValidatePathsQuery);
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  addManualGame,
  loadDashboard,
  updateGame,
} from "../services/tauri";
import type { AddGamePayload, DashboardData, GameEntry } from "../types/dashboard";
import { DASHBOARD_KEY } from "./keys";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function useSetDashboardCache() {
  const queryClient = useQueryClient();
  return (data: DashboardData) =>
    queryClient.setQueryData<DashboardData>(DASHBOARD_KEY, data);
}

// ─── Query ────────────────────────────────────────────────────────────────────

export function useDashboardQuery() {
  return useQuery({
    queryKey: DASHBOARD_KEY,
    queryFn: loadDashboard,
  });
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

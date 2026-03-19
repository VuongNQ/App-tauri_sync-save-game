import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  addManualGame,
  loadDashboard,
  refreshDashboard,
  updateGameSavePath,
} from "../services/tauri";
import type { AddGamePayload, DashboardData, GameItem } from "../types/dashboard";
import { DASHBOARD_KEY } from "./keys";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Helper used by all mutations to push the returned DashboardData into the cache. */
function useSetDashboardCache() {
  const queryClient = useQueryClient();
  return (data: DashboardData) =>
    queryClient.setQueryData<DashboardData>(DASHBOARD_KEY, data);
}

// ─── Query ────────────────────────────────────────────────────────────────────

/** Fetches the full dashboard on mount. staleTime is set to Infinity in the
 *  QueryClient so this only runs once per session unless explicitly invalidated.
 */
export function useDashboardQuery() {
  return useQuery({
    queryKey: DASHBOARD_KEY,
    queryFn: loadDashboard,
  });
}

// ─── Mutations ───────────────────────────────────────────────────────────────

/** Re-scans all launchers and refreshes the dashboard. */
export function useRefreshMutation() {
  const setCache = useSetDashboardCache();
  return useMutation({
    mutationFn: refreshDashboard,
    onSuccess: setCache,
  });
}

/** Adds a manually entered game and updates the cached dashboard. */
export function useAddGameMutation() {
  const setCache = useSetDashboardCache();
  return useMutation({
    mutationFn: (payload: AddGamePayload) => addManualGame(payload),
    onSuccess: setCache,
  });
}

/** Persists a new save-folder path for the given game. */
export function useSavePathMutation() {
  const setCache = useSetDashboardCache();
  return useMutation({
    mutationFn: (game: GameItem) => updateGameSavePath(game),
    onSuccess: setCache,
  });
}

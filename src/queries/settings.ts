import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { checkForUpdate, clearAllDriveData, downloadAndInstallUpdate, getSettings, updateSettings } from "../services/tauri";
import type { AppSettings, DashboardData } from "../types/dashboard";
import { DASHBOARD_KEY, SETTINGS_KEY } from "./keys";

export function useSettingsQuery() {
  return useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: getSettings,
  });
}

export function useUpdateSettingsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: AppSettings) => updateSettings(settings),
    onSuccess: (data: AppSettings) =>
      queryClient.setQueryData<AppSettings>(SETTINGS_KEY, data),
  });
}

export function useClearAllDriveMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: clearAllDriveData,
    onSuccess: (data: DashboardData) =>
      queryClient.setQueryData<DashboardData>(DASHBOARD_KEY, data),
  });
}

export function useCheckForUpdateMutation() {
  return useMutation({ mutationFn: checkForUpdate });
}

export function useInstallUpdateMutation() {
  return useMutation({ mutationFn: downloadAndInstallUpdate });
}

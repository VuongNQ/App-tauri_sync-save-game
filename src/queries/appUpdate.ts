import { useQuery } from "@tanstack/react-query";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";

import { APP_UPDATE_KEY } from "./keys";

export interface AppUpdateInfo {
  currentVersion: string;
  update: Update | null;
  error: string | null;
}

async function fetchAppUpdate(): Promise<AppUpdateInfo> {
  const currentVersion = await getVersion().catch(() => "");

  try {
    const update = await check();
    return {
      currentVersion,
      update,
      error: null,
    };
  } catch (err) {
    return {
      currentVersion,
      update: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function useAppUpdateQuery() {
  return useQuery({
    queryKey: APP_UPDATE_KEY,
    queryFn: fetchAppUpdate,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

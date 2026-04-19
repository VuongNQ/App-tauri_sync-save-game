import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { HashRouter, Routes, Route, Navigate } from "react-router";

import { AppLayout } from "./components/AppLayout";
import { AuthGuard } from "./components/AuthGuard";
import { AUTH_STATUS_KEY, DASHBOARD_KEY, DEVICES_KEY, gamePlayingKey } from "./queries/keys";
import { useAuthStatusQuery, useSyncLibraryFromCloudMutation } from "./queries";
import { DashboardPage } from "./pages/DashboardPage";
import { DevicesPage } from "./pages/DevicesPage";
import { GameDetailPage } from "./pages/GameDetailPage";
import { LoginPage } from "./pages/LoginPage";
import { SettingsPage } from "./pages/SettingsPage";
import type { AuthStatus } from "./types/dashboard";
import "./App.css";

export function App() {
  useAuthStatusCallbacks();
  useStartupFirestoreSync();

  return (
    <HashRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<AuthGuard />}>
          <Route element={<AppLayout />}>
            <Route index element={<DashboardPage />} />
            <Route path="game/:id" element={<GameDetailPage />} />
            <Route path="devices" element={<DevicesPage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  );
}

function useAuthStatusCallbacks() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const unlistenPromise = listen<AuthStatus>("auth-status-changed", ({ payload }) => {
      queryClient.setQueryData<AuthStatus>(AUTH_STATUS_KEY, payload);
    });

    // Refresh the game library when a cloud restore completes after first login.
    const unlistenRestorePromise = listen("library-restored", () => {
      void queryClient.invalidateQueries({ queryKey: DASHBOARD_KEY });
    });

    // Refresh dashboard and devices after post-login sync-all-from-Drive completes.
    // register_current_device() runs before this event is emitted, so invalidating
    // DEVICES_KEY here ensures the devices page shows the registered device.
    const unlistenPostLoginSyncPromise = listen("post-login-sync-completed", () => {
      void queryClient.invalidateQueries({ queryKey: DASHBOARD_KEY });
      void queryClient.invalidateQueries({ queryKey: DEVICES_KEY });
    });

    // Track game playing state for TrackingSyncCard status banner.
    const unlistenGameStatusPromise = listen<{ gameId: string; status: "playing" | "idle" }>("game-status-changed", ({ payload }) => {
      queryClient.setQueryData(gamePlayingKey(payload.gameId), payload.status === "playing");
    });

    // Tracking detected a local file change — re-scan to update Last local save time.
    const unlistenSyncPendingPromise = listen("game-sync-pending", () => {
      void queryClient.invalidateQueries({ queryKey: DASHBOARD_KEY });
    });

    // Refresh dashboard after any background or watcher-triggered sync completes.
    const unlistenSyncCompletedPromise = listen("sync-completed", () => {
      void queryClient.invalidateQueries({ queryKey: DASHBOARD_KEY });
    });

    const syncAuthStatus = () => {
      void queryClient.invalidateQueries({ queryKey: AUTH_STATUS_KEY });
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        syncAuthStatus();
      }
    };

    window.addEventListener("focus", syncAuthStatus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("focus", syncAuthStatus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      void unlistenPromise.then((unlisten) => unlisten());
      void unlistenRestorePromise.then((unlisten) => unlisten());
      void unlistenPostLoginSyncPromise.then((unlisten) => unlisten());
      void unlistenSyncPendingPromise.then((unlisten) => unlisten());
      void unlistenSyncCompletedPromise.then((unlisten) => unlisten());
      void unlistenGameStatusPromise.then((unlisten) => unlisten());
    };
  }, [queryClient]);
}

function useStartupFirestoreSync() {
  const { data: authStatus } = useAuthStatusQuery();
  const { mutate } = useSyncLibraryFromCloudMutation();
  const hasRun = useRef(false);

  useEffect(() => {
    if (authStatus?.authenticated && !hasRun.current) {
      hasRun.current = true;
      mutate();
    }
    // mutate is stable; hasRun is a ref — omit from deps intentionally
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authStatus?.authenticated]);
}

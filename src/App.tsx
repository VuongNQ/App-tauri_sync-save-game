import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { BrowserRouter, Routes, Route, Navigate } from "react-router";

import { AppLayout } from "./components/AppLayout";
import { AuthGuard } from "./components/AuthGuard";
import { AUTH_STATUS_KEY } from "./queries/keys";
import { DashboardPage } from "./pages/DashboardPage";
import { GameDetailPage } from "./pages/GameDetailPage";
import { LoginPage } from "./pages/LoginPage";
import { SettingsPage } from "./pages/SettingsPage";
import type { AuthStatus } from "./types/dashboard";
import "./App.css";

export function App() {
  useAuthStatusCallbacks();

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<AuthGuard />}>
          <Route element={<AppLayout />}>
            <Route index element={<DashboardPage />} />
            <Route path="game/:id" element={<GameDetailPage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

function useAuthStatusCallbacks() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const unlistenPromise = listen<AuthStatus>("auth-status-changed", ({ payload }) => {
      queryClient.setQueryData<AuthStatus>(AUTH_STATUS_KEY, payload);
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
    };
  }, [queryClient]);
}

import { BrowserRouter, Routes, Route, Navigate } from "react-router";

import { AppLayout } from "./components/AppLayout";
import { AuthGuard } from "./components/AuthGuard";
import { DashboardPage } from "./pages/DashboardPage";
import { GameDetailPage } from "./pages/GameDetailPage";
import { LoginPage } from "./pages/LoginPage";
import { SettingsPage } from "./pages/SettingsPage";
import "./App.css";

export function App() {
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

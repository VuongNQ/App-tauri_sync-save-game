import { invoke } from "@tauri-apps/api/core";

import type {
  AddGamePayload,
  AuthStatus,
  DashboardData,
  GameEntry,
  UpdateGamePayload,
} from "../types/dashboard";

export async function loadDashboard(): Promise<DashboardData> {
  return invoke<DashboardData>("load_dashboard");
}

export async function addManualGame(
  payload: AddGamePayload,
): Promise<DashboardData> {
  return invoke<DashboardData>("add_manual_game", { payload });
}

export async function updateGame(
  game: GameEntry,
): Promise<DashboardData> {
  const payload: UpdateGamePayload = { game };
  return invoke<DashboardData>("update_game", { payload });
}

// ── Auth stubs (backed by Rust OAuth once implemented) ────────────────────

export async function checkAuthStatus(): Promise<AuthStatus> {
  return invoke<AuthStatus>("check_auth_status");
}

export async function startOAuthLogin(): Promise<AuthStatus> {
  return invoke<AuthStatus>("start_oauth_login");
}

export async function logout(): Promise<AuthStatus> {
  return invoke<AuthStatus>("logout");
}

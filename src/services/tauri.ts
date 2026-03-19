import { invoke } from "@tauri-apps/api/core";

import type {
  AddGamePayload,
  DashboardData,
  GameItem,
  UpsertGamePayload,
} from "../types/dashboard";

export async function loadDashboard(): Promise<DashboardData> {
  return invoke<DashboardData>("load_dashboard");
}

export async function refreshDashboard(): Promise<DashboardData> {
  return invoke<DashboardData>("refresh_dashboard");
}

export async function addManualGame(
  payload: AddGamePayload,
): Promise<DashboardData> {
  return invoke<DashboardData>("add_manual_game", { payload });
}

export async function updateGameSavePath(
  game: GameItem,
): Promise<DashboardData> {
  const payload: UpsertGamePayload = { game };
  return invoke<DashboardData>("update_game_save_path", { payload });
}

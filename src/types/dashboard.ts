export type ConfidenceLevel = "manual" | "high" | "medium" | "low";

export interface GameItem {
  id: string;
  name: string;
  launcher: string;
  installPath: string | null;
  savePath: string | null;
  source: string;
  confidence: ConfidenceLevel | string;
  isManual: boolean;
  isAvailable: boolean;
}

export interface LauncherStatus {
  id: string;
  name: string;
  detected: boolean;
  gameCount: number;
  details: string | null;
}

export interface DashboardData {
  games: GameItem[];
  launchers: LauncherStatus[];
  warnings: string[];
}

export interface AddGamePayload {
  name: string;
  launcher: string | null;
  installPath: string | null;
}

export interface UpsertGamePayload {
  game: GameItem;
}

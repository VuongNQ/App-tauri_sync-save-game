export type GameSource = "steam" | "epic" | "emulator" | "manual";

export interface GameEntry {
  id: string;
  name: string;
  thumbnail: string | null;
  source: GameSource;
  savePath: string | null;
  trackChanges: boolean;
  autoSync: boolean;
  lastLocalModified: string | null;
  lastCloudModified: string | null;
  gdriveFolderId: string | null;
}

export interface DashboardData {
  games: GameEntry[];
}

export interface AddGamePayload {
  name: string;
  thumbnail: string | null;
  source: GameSource;
  savePath: string | null;
}

export interface UpdateGamePayload {
  game: GameEntry;
}

export interface AuthStatus {
  authenticated: boolean;
}

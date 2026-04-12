import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { launchGame, restoreFromCloud } from "../services/tauri";
import type { GameEntry } from "../types/dashboard";
import { gamePlayingKey } from "./keys";

export const useGamePlaying = (id: string) => {
  return useQuery<boolean>({
    queryKey: gamePlayingKey(id),
    queryFn: () => false,
    staleTime: Infinity,
    enabled: !!id,
  });
};

// ── useSyncAndLaunchFlow ──────────────────────────────────────────────────────
//
// Sequence when the user clicks Play:
//   1. If the game has never been synced (gdriveFolderId is null) → skip restore,
//      go straight to launch.
//   2. Otherwise: restore saves from Drive → on success, launch the game.
//   3. If the restore step fails, surface the error and offer a `forceLaunch`
//      escape hatch so a network outage never blocks the user from playing.

type LaunchPhase = "idle" | "syncing" | "launching";

interface SyncAndLaunchCallbacks {
  onError?: (message: string, canForce: boolean) => void;
}

export function useSyncAndLaunchFlow({ onError }: SyncAndLaunchCallbacks = {}) {
  const [phase, setPhase] = useState<LaunchPhase>("idle");

  const launchMutation = useMutation({
    mutationFn: (gameId: string) => launchGame(gameId),
    onSuccess: () => setPhase("idle"),
    onError: (err) => {
      setPhase("idle");
      const message = err instanceof Error ? err.message : String(err);
      onError?.(message, false);
    },
  });

  const restoreMutation = useMutation({
    mutationFn: (gameId: string) => restoreFromCloud(gameId),
    onSuccess: (_data, gameId) => {
      setPhase("launching");
      launchMutation.mutate(gameId);
    },
    onError: (err, _gameId) => {
      setPhase("idle");
      const message = err instanceof Error ? err.message : String(err);
      onError?.(message, true);
    },
  });

  function start(game: GameEntry) {
    if (!game.gdriveFolderId) {
      // No Drive folder yet — nothing to restore, launch directly.
      setPhase("launching");
      launchMutation.mutate(game.id);
      return;
    }
    setPhase("syncing");
    restoreMutation.mutate(game.id);
  }

  function forceLaunch(gameId: string) {
    setPhase("launching");
    launchMutation.mutate(gameId);
  }

  const isPending = phase !== "idle";

  return { start, forceLaunch, phase, isPending };
}

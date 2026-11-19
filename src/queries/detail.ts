import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { launchGame, syncAndLaunchGame } from "../services/tauri";
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
// Play checks both local and cloud state in Rust and launches under the same lock.
// Force launch skips networking, but still respects the shared save-operation gate.

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

  const prepareMutation = useMutation({
    mutationFn: (gameId: string) => syncAndLaunchGame(gameId),
    onSuccess: () => setPhase("idle"),
    onError: (err) => {
      setPhase("idle");
      const message = err instanceof Error ? err.message : String(err);
      onError?.(message, !message.includes("SAVE_BUSY") && !message.includes("SAVE_PLAYING"));
    },
  });

  function start(game: GameEntry) {
    setPhase(game.gdriveFolderId ? "syncing" : "launching");
    prepareMutation.mutate(game.id);
  }

  function forceLaunch(gameId: string) {
    setPhase("launching");
    launchMutation.mutate(gameId);
  }

  const isPending = phase !== "idle";

  return { start, forceLaunch, phase, isPending };
}

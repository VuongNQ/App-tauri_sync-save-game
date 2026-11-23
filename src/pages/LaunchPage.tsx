// ── LaunchPage ────────────────────────────────────────────────────────────────
//
// Rendered in the small "launcher" window opened by a play shortcut
// (syncsave://launch/<gameId> or --launch <gameId>). Runs the same
// sync-then-launch command as the ▶ Play button and only asks the user when
// sync needs a decision: conflict, offline/error, or no signed-in account.
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { GameThumbnail } from "@/components/GameThumbnail";
import { GHOST_BTN, MUTED, PRIMARY_BTN, SECONDARY_BTN } from "@/components/styles";
import { getLaunchTarget, launchGame, showDashboard, syncAndLaunchGame, type LaunchTarget } from "@/services/tauri";

type Phase =
  | { kind: "loading" }
  | { kind: "syncing" }
  | { kind: "waiting"; attempt: number }
  | { kind: "launching" }
  | { kind: "launched" }
  | { kind: "signin" }
  | { kind: "conflict"; message: string }
  | { kind: "playing" }
  | { kind: "error"; message: string; canForce: boolean };

const BUSY_RETRY_MS = 3000;
const BUSY_MAX_ATTEMPTS = 20; // ~1 minute, covers an exit-sync still uploading
const CLOSE_AFTER_LAUNCH_MS = 1800;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function closeWindow() {
  void getCurrentWindow().close();
}

export function LaunchPage() {
  const { id = "" } = useParams<{ id: string }>();
  const [target, setTarget] = useState<LaunchTarget | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const runId = useRef(0);

  const forceLaunch = useCallback(async () => {
    const run = ++runId.current;
    setPhase({ kind: "launching" });
    try {
      await launchGame(id);
      if (run === runId.current) setPhase({ kind: "launched" });
    } catch (err) {
      if (run !== runId.current) return;
      const message = errorText(err);
      setPhase(message.includes("SAVE_PLAYING") ? { kind: "playing" } : { kind: "error", message, canForce: false });
    }
  }, [id]);

  const start = useCallback(async () => {
    const run = ++runId.current;
    const alive = () => run === runId.current;

    let info: LaunchTarget;
    try {
      info = await getLaunchTarget(id);
    } catch (err) {
      if (!alive()) return;
      const message = errorText(err);
      if (message.includes("Not authenticated") || message.includes("ACCOUNT_")) {
        setPhase({ kind: "signin" });
      } else {
        setPhase({ kind: "error", message, canForce: false });
      }
      return;
    }
    if (!alive()) return;
    setTarget(info);

    if (!info.canLaunch) {
      setPhase({
        kind: "error",
        message: "The game's executable is not set or not found on this device. Set it in the app first.",
        canForce: false,
      });
      return;
    }

    for (let attempt = 1; attempt <= BUSY_MAX_ATTEMPTS; attempt++) {
      setPhase(attempt === 1 ? (info.hasCloud ? { kind: "syncing" } : { kind: "launching" }) : { kind: "waiting", attempt });
      try {
        await syncAndLaunchGame(id);
        if (alive()) setPhase({ kind: "launched" });
        return;
      } catch (err) {
        if (!alive()) return;
        const message = errorText(err);
        if (message.includes("SAVE_BUSY") && attempt < BUSY_MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, BUSY_RETRY_MS));
          if (!alive()) return;
          continue;
        }
        if (message.includes("SAVE_CONFLICT")) setPhase({ kind: "conflict", message });
        else if (message.includes("SAVE_PLAYING")) setPhase({ kind: "playing" });
        else if (message.includes("Not authenticated") || message.includes("ACCOUNT_")) setPhase({ kind: "signin" });
        else setPhase({ kind: "error", message, canForce: !message.includes("SAVE_BUSY") });
        return;
      }
    }
  }, [id]);

  useEffect(() => {
    const runs = runId;
    // Start on the next tick so a re-targeted window (new #/launch/<id>) cancels cleanly.
    const timer = setTimeout(() => void start(), 0);
    return () => {
      clearTimeout(timer);
      runs.current++;
    };
  }, [start]);

  const retry = () => {
    setPhase({ kind: "loading" });
    void start();
  };

  useEffect(() => {
    if (phase.kind !== "launched") return;
    const timer = setTimeout(closeWindow, CLOSE_AFTER_LAUNCH_MS);
    return () => clearTimeout(timer);
  }, [phase.kind]);

  const openInApp = (route?: string) => {
    void showDashboard(route).finally(closeWindow);
  };

  const name = target?.name ?? id;
  const offline = typeof navigator !== "undefined" && !navigator.onLine;

  let title: string;
  let detail: string | null = null;
  let busy = false;
  switch (phase.kind) {
    case "loading":
      title = "Preparing…";
      busy = true;
      break;
    case "syncing":
      title = "Syncing saves…";
      detail = "Getting the latest save from the cloud before the game starts.";
      busy = true;
      break;
    case "waiting":
      title = "Waiting for another sync…";
      detail = `A save operation is still running (try ${phase.attempt}/${BUSY_MAX_ATTEMPTS}).`;
      busy = true;
      break;
    case "launching":
      title = "Launching…";
      busy = true;
      break;
    case "launched":
      title = "Game started. Have fun!";
      break;
    case "signin":
      title = "Sign in to sync saves";
      detail = "No account is signed in, so the cloud save can't be checked.";
      break;
    case "conflict":
      title = "Saves changed on both sides";
      detail =
        "Local and cloud saves both changed since the last sync. Both copies are kept. Pick which one wins in the app, or play the local save now.";
      break;
    case "playing":
      title = "The game is already running";
      break;
    case "error":
      title = offline ? "You're offline" : "Couldn't sync saves";
      detail = offline
        ? "The cloud save can't be checked. Playing now uses the save on this device; it will sync after you quit if auto-sync is on."
        : phase.message;
      break;
  }

  return (
    <div className="min-h-screen p-4 flex flex-col gap-3 bg-[#070b16] text-[#eaf3ff] select-none">
      <div className="flex items-center gap-3">
        <div className="w-14 h-14 shrink-0 rounded-xl overflow-hidden border border-[rgba(165,185,255,0.1)] bg-[rgba(9,14,28,0.75)]">
          {target?.thumbnail ? (
            <GameThumbnail src={target.thumbnail} alt={name} className="w-full h-full object-cover" />
          ) : (
            <div className="grid place-items-center w-full h-full text-2xl">🎮</div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="m-0 font-semibold truncate">{name}</p>
          <p className="m-0 text-sm text-[#7dc9ff] flex items-center gap-2">
            {busy && <span className="h-2 w-2 rounded-full bg-[#7dc9ff] animate-pulse" />}
            {title}
          </p>
        </div>
      </div>

      {detail && <p className={`m-0 text-xs leading-snug ${MUTED} line-clamp-4`}>{detail}</p>}

      <div className="mt-auto flex gap-2 justify-end flex-wrap">
        {phase.kind === "conflict" && (
          <>
            <button type="button" className={`${GHOST_BTN} min-h-9 text-sm`} onClick={() => void forceLaunch()}>
              Play local save
            </button>
            <button type="button" className={`${PRIMARY_BTN} w-auto min-h-9 text-sm`} onClick={() => openInApp(`/game/${id}`)}>
              Resolve in app
            </button>
          </>
        )}
        {phase.kind === "error" && (
          <>
            {phase.canForce && target?.canLaunch && (
              <button type="button" className={`${GHOST_BTN} min-h-9 text-sm`} onClick={() => void forceLaunch()}>
                Play without syncing
              </button>
            )}
            {target && !target.canLaunch ? (
              <button type="button" className={`${PRIMARY_BTN} w-auto min-h-9 text-sm`} onClick={() => openInApp(`/game/${id}`)}>
                Open game settings
              </button>
            ) : (
              <button type="button" className={`${PRIMARY_BTN} w-auto min-h-9 text-sm`} onClick={retry}>
                Retry
              </button>
            )}
          </>
        )}
        {phase.kind === "signin" && (
          <button type="button" className={`${PRIMARY_BTN} w-auto min-h-9 text-sm`} onClick={() => openInApp("/login")}>
            Open app to sign in
          </button>
        )}
        {(phase.kind === "error" || phase.kind === "conflict" || phase.kind === "signin" || phase.kind === "playing") && (
          <button type="button" className={`${SECONDARY_BTN} min-h-9 text-sm`} onClick={closeWindow}>
            Close
          </button>
        )}
      </div>
    </div>
  );
}

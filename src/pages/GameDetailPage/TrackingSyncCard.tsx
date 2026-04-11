// ── TrackingSyncCard ──────────────────────────────────────────────────────────

import { CARD, TOGGLE_THUMB_OFF, TOGGLE_THUMB_ON, TOGGLE_TRACK_OFF, TOGGLE_TRACK_ON } from "../../components/styles";
import { useToggleAutoSyncMutation, useToggleTrackChangesMutation } from "../../queries";
import { msg } from "../../utils";

interface TrackingSyncCardProps {
  gameId: string;
  savePath: string | null;
  trackChanges: boolean;
  autoSync: boolean;
  isSyncing: boolean;
  exeName: string | null;
  isGamePlaying: boolean;
  onError: (message: string) => void;
}

function TrackingSyncCard({
  gameId,
  savePath,
  trackChanges,
  autoSync,
  isSyncing,
  exeName,
  isGamePlaying,
  onError,
}: TrackingSyncCardProps) {
  const toggleTrack = useToggleTrackChangesMutation();
  const toggleAuto = useToggleAutoSyncMutation();

  function handleTrackChanges(enabled: boolean) {
    toggleTrack.mutate(
      { gameId, enabled },
      { onError: (err) => onError(msg(err, "Failed to toggle tracking.")) },
    );
  }

  function handleAutoSync(enabled: boolean) {
    toggleAuto.mutate(
      { gameId, enabled },
      { onError: (err) => onError(msg(err, "Failed to toggle auto-sync.")) },
    );
  }

  const trackDisabled =
    isSyncing || toggleTrack.isPending || toggleAuto.isPending;
  const autoDisabled =
    isSyncing || toggleTrack.isPending || toggleAuto.isPending;

  return (
    <div className={CARD}>
      <h3 className="m-0 mb-4 font-semibold">Tracking &amp; Sync</h3>

      {/* Game running status banner */}
      {trackChanges && isGamePlaying && (
        <div
          className={`mb-4 px-4 py-3 rounded-2xl text-sm font-medium flex items-center gap-2 ${
            autoSync
              ? "bg-[rgba(255,180,40,0.12)] border border-[rgba(255,180,40,0.3)] text-[#ffd580]"
              : "bg-[rgba(80,160,255,0.12)] border border-[rgba(80,160,255,0.3)] text-[#7dc9ff]"
          }`}
        >
          <span>🎮</span>
          {autoSync
            ? "Game is running — will sync on close"
            : "Game is running — Sync pending..."}
        </div>
      )}

      {!savePath && (
        <p className="m-0 mb-4 text-sm text-[#ffd5a0]">
          Set a save folder path so synced files have a destination.
        </p>
      )}

      <div className="grid gap-4">
        {/* Track process */}
        <div className="flex items-center justify-between gap-4 px-5 py-4 rounded-2xl border border-[rgba(165,185,255,0.08)] bg-[rgba(9,14,28,0.55)]">
          <div className="grid gap-0.5">
            <span className="font-semibold text-sm text-[#c7d3f7]">
              Track process
            </span>
            <span className="text-xs text-[#9aa8c7]">
              Detect when the game process exits and trigger sync
            </span>
            {trackChanges && !exeName && (
              <span className="text-xs text-[#ffd5a0] mt-1">
                Open settings and enter the game’s .exe name to activate process tracking.
              </span>
            )}
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={trackChanges}
            disabled={trackDisabled}
            onClick={() => handleTrackChanges(!trackChanges)}
            className={`relative inline-flex shrink-0 h-6 w-11 rounded-full transition-colors duration-200 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed ${
              trackChanges ? TOGGLE_TRACK_ON : TOGGLE_TRACK_OFF
            }`}
          >
            <span
              className={`inline-block h-5 w-5 mt-0.5 ml-0.5 rounded-full bg-white shadow transform transition-transform duration-200 ${
                trackChanges ? TOGGLE_THUMB_ON : TOGGLE_THUMB_OFF
              }`}
            />
          </button>
        </div>

        {/* Auto-sync */}
        <div className="flex items-center justify-between gap-4 px-5 py-4 rounded-2xl border border-[rgba(165,185,255,0.08)] bg-[rgba(9,14,28,0.55)]">
          <div className="grid gap-0.5">
            <span className="font-semibold text-sm text-[#c7d3f7]">
              Auto-sync to Google Drive
            </span>
            <span className="text-xs text-[#9aa8c7]">
              Automatically back up saves when the game process exits
            </span>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={autoSync}
            disabled={autoDisabled}
            onClick={() => handleAutoSync(!autoSync)}
            className={`relative inline-flex shrink-0 h-6 w-11 rounded-full transition-colors duration-200 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed ${
              autoSync ? TOGGLE_TRACK_ON : TOGGLE_TRACK_OFF
            }`}
          >
            <span
              className={`inline-block h-5 w-5 mt-0.5 ml-0.5 rounded-full bg-white shadow transform transition-transform duration-200 ${
                autoSync ? TOGGLE_THUMB_ON : TOGGLE_THUMB_OFF
              }`}
            />
          </button>
        </div>
      </div>
    </div>
  );
}

export default TrackingSyncCard;
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
  onError: (message: string) => void;
}

function TrackingSyncCard({
  gameId,
  savePath,
  trackChanges,
  autoSync,
  isSyncing,
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
    isSyncing || toggleTrack.isPending || toggleAuto.isPending || !savePath;
  const autoDisabled =
    isSyncing || toggleTrack.isPending || toggleAuto.isPending;

  return (
    <div className={CARD}>
      <h3 className="m-0 mb-4 font-semibold">Tracking &amp; Sync</h3>

      {!savePath && (
        <p className="m-0 mb-4 text-sm text-[#ffd5a0]">
          Set a save folder path before enabling tracking.
        </p>
      )}

      <div className="grid gap-4">
        {/* Track file changes */}
        <div className="flex items-center justify-between gap-4 px-5 py-4 rounded-2xl border border-[rgba(165,185,255,0.08)] bg-[rgba(9,14,28,0.55)]">
          <div className="grid gap-0.5">
            <span className="font-semibold text-sm text-[#c7d3f7]">
              Track file changes
            </span>
            <span className="text-xs text-[#9aa8c7]">
              Watch the save folder for modifications in the background
            </span>
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
              Automatically back up saves when changes are detected
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
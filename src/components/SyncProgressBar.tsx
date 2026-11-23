import { useGameSyncProgressQuery } from "@/queries/sync";
import type { SyncProgress } from "@/types/dashboard";
import { formatBytes } from "@/utils";

interface Props {
  gameId: string;
  /** Compact one-line variant for list rows. */
  compact?: boolean;
}

/** Percentage of the transfer that is done, or `null` while it cannot be measured yet. */
function syncPercent(progress: SyncProgress | null): number | null {
  if (!progress) return null;
  if (progress.phase === "finalizing" || progress.phase === "done") return 100;
  if (progress.phase !== "transferring") return null;
  if (progress.bytesTotal > 0) return Math.min(100, Math.round((progress.bytesDone / progress.bytesTotal) * 100));
  if (progress.filesTotal > 0) return Math.min(100, Math.round((progress.filesDone / progress.filesTotal) * 100));
  return 100;
}

function phaseLabel(progress: SyncProgress | null): string {
  if (!progress || progress.phase === "checking") return "Checking local and cloud saves…";
  if (progress.phase !== "transferring" || progress.filesTotal === 0) return "Saving new version…";
  const parts: string[] = [];
  if (progress.uploads > 0) parts.push(`↑ ${progress.uploads}`);
  if (progress.downloads > 0) parts.push(`↓ ${progress.downloads}`);
  let verb = "Transferring";
  if (progress.downloads === 0) verb = "Uploading";
  else if (progress.uploads === 0) verb = "Downloading";
  return `${verb} ${parts.join(" · ")}`.trim();
}

/**
 * Live per-game sync progress driven by the `sync-progress` Tauri event.
 * Shows an indeterminate bar while checking, then a determinate bar by bytes
 * (falling back to file count) during transfers.
 */
export function SyncProgressBar({ gameId, compact = false }: Props) {
  const progress = useGameSyncProgressQuery(gameId);
  const percent = syncPercent(progress);
  const transferring = progress?.phase === "transferring";

  return (
    <div className={compact ? "grid gap-1 w-full max-w-64" : "grid gap-2 w-full"} role="status" aria-live="polite">
      <div
        className={`relative overflow-hidden rounded-full bg-[rgba(125,201,255,0.12)] ${compact ? "h-1.5" : "h-2"}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-label="Sync progress"
      >
        {percent === null ? (
          <div className="absolute inset-y-0 w-1/3 rounded-full bg-linear-to-r from-[#6d7dff] to-[#55c5ff] animate-[sync-indeterminate_1.2s_ease-in-out_infinite]" />
        ) : (
          <div
            className="h-full rounded-full bg-linear-to-r from-[#6d7dff] to-[#55c5ff] transition-[width] duration-200 ease-out"
            style={{ width: `${percent}%` }}
          />
        )}
      </div>
      <div className={`flex items-center justify-between gap-2 ${compact ? "text-[0.7rem]" : "text-xs"} text-[#9aa8c7]`}>
        <span className="truncate text-[#7dc9ff]">{phaseLabel(progress)}</span>
        {transferring && progress && (
          <span className="shrink-0 tabular-nums">
            {progress.bytesTotal > 0
              ? `${formatBytes(progress.bytesDone)} / ${formatBytes(progress.bytesTotal)}`
              : `${progress.filesDone}/${progress.filesTotal}`}
            {percent !== null && ` · ${percent}%`}
          </span>
        )}
      </div>
      {!compact && transferring && progress && (
        <p className="m-0 text-xs text-[#9aa8c7] truncate">
          {progress.filesDone}/{progress.filesTotal} files
          {progress.currentFile ? ` · ${progress.currentFile}` : ""}
        </p>
      )}
    </div>
  );
}

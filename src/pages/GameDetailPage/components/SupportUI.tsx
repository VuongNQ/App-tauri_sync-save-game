// ── Co-located components ─────────────────────────────────────────────────────

import { SaveFileTree } from "@/components/SaveFileTree";
import { EYEBROW, MUTED } from "@/components/styles";
import { PathSaveInfo, SaveInfo } from "@/types/dashboard";
import { formatBytes, formatLocalTime } from "@/utils";

// Folder icon SVG used for open-folder buttons
function FolderIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

/** Single path tree row used inside the multi-path breakdown. */
function PathInfoSection({
  entry,
  onOpenFolder,
}: {
  entry: PathSaveInfo;
  onOpenFolder?: () => void;
}) {
  // Build a SaveInfo-compatible object so SaveFileTree can render it unchanged.
  const treeInfo: SaveInfo = {
    gameId: "",
    savePath: entry.savePath,
    totalFiles: entry.files.length,
    totalSize: entry.totalSize,
    lastModified: null,
    files: entry.files,
    pathInfos: [],
  };
  return (
    <div className="mt-3 p-3 rounded-[14px] bg-white/[0.02] border border-[rgba(165,185,255,0.06)]">
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[#c7d3f7] text-xs font-medium shrink-0">{entry.label}</span>
          <span className={`${MUTED} text-[0.7rem] truncate`} title={entry.savePath}>
            {entry.savePath}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <span className="text-[0.72rem] text-[#9aa8c7] bg-white/6 px-1.75 py-0.5 rounded-full whitespace-nowrap">
            {formatBytes(entry.totalSize)}
          </span>
          {onOpenFolder && (
            <button
              onClick={onOpenFolder}
              title={`Open ${entry.label} folder`}
              className="p-1 rounded-lg cursor-pointer text-[#9aa8c7] hover:text-white hover:bg-white/10 transition-colors"
            >
              <FolderIcon />
            </button>
          )}
        </div>
      </div>
      {entry.files.length > 0 && <SaveFileTree info={treeInfo} />}
    </div>
  );
}

export function SaveInfoPanel({
  info,
  onRefresh,
  isRefreshing,
  onOpenFolder,
  onOpenFolderForPath,
}: {
  info: SaveInfo;
  onRefresh?: () => void;
  isRefreshing?: boolean;
  /** Opens the primary (first) save folder. Used in single-path mode. */
  onOpenFolder?: () => void;
  /** Opens the folder for a specific raw path string. Used in multi-path mode. */
  onOpenFolderForPath?: (rawPath: string) => void;
}) {
  const isMultiPath = info.pathInfos.length > 1;

  return (
    <div className="mt-4 p-4 rounded-[18px] bg-[rgba(9,14,28,0.75)] border border-[rgba(165,185,255,0.08)]">
      <div className="flex items-center justify-between mb-1">
        <p className={`${EYEBROW} mb-0`}>Local save info</p>
        <div className="flex items-center gap-1">
          {/* In single-path mode show the global open-folder button */}
          {!isMultiPath && onOpenFolder && (
            <button
              onClick={onOpenFolder}
              title="Open save folder"
              className="p-1 rounded-lg cursor-pointer text-[#9aa8c7] hover:text-white hover:bg-white/10 transition-colors"
            >
              <FolderIcon />
            </button>
          )}
          {onRefresh && (
            <button
              onClick={onRefresh}
              disabled={isRefreshing}
              title="Refresh local save info"
              className="p-1 rounded-lg cursor-pointer text-[#9aa8c7] hover:text-white hover:bg-white/10 transition-colors disabled:opacity-40"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={isRefreshing ? "animate-spin" : ""}
              >
                <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
                <path d="M21 3v5h-5" />
                <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
                <path d="M8 16H3v5" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Aggregate stats */}
      <dl className="grid gap-2 grid-cols-3 m-0 mt-2 max-[720px]:grid-cols-1">
        <div>
          <dt className="text-[#c7d3f7] text-sm">Total files</dt>
          <dd className={`${MUTED} m-0`}>{info.totalFiles}</dd>
        </div>
        <div>
          <dt className="text-[#c7d3f7] text-sm">Total size</dt>
          <dd className={`${MUTED} m-0`}>{formatBytes(info.totalSize)}</dd>
        </div>
        <div>
          <dt className="text-[#c7d3f7] text-sm">Last modified</dt>
          <dd className={`${MUTED} m-0`}>{formatLocalTime(info.lastModified)}</dd>
        </div>
      </dl>

      {/* File tree — multi-path shows one labeled section per path */}
      {isMultiPath ? (
        info.pathInfos.map((entry, i) => (
          <PathInfoSection
            key={i}
            entry={entry}
            onOpenFolder={
              onOpenFolderForPath ? () => onOpenFolderForPath(entry.savePath) : undefined
            }
          />
        ))
      ) : (
        info.files.length > 0 && <SaveFileTree info={info} />
      )}
    </div>
  );
}

export function SyncResultPanel({
  result,
}: {
  result: {
    uploaded: number;
    downloaded: number;
    skipped: number;
    error: string | null;
  };
}) {
  return (
    <div
      className={`mt-4 p-4 rounded-[18px] border ${result.error ? "bg-[rgba(40,10,10,0.75)] border-[rgba(255,120,120,0.2)]" : "bg-[rgba(9,14,28,0.75)] border-[rgba(165,185,255,0.08)]"}`}
    >
      <p className={EYEBROW}>{result.error ? "Sync error" : "Sync complete"}</p>
      {result.error ? (
        <p className="m-0 text-sm text-[#ffd5d5]">{result.error}</p>
      ) : (
        <dl className="grid gap-2 grid-cols-3 m-0">
          <div>
            <dt className="text-[#c7d3f7] text-sm">Uploaded</dt>
            <dd className={`${MUTED} m-0`}>{result.uploaded}</dd>
          </div>
          <div>
            <dt className="text-[#c7d3f7] text-sm">Downloaded</dt>
            <dd className={`${MUTED} m-0`}>{result.downloaded}</dd>
          </div>
          <div>
            <dt className="text-[#c7d3f7] text-sm">Skipped</dt>
            <dd className={`${MUTED} m-0`}>{result.skipped}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}

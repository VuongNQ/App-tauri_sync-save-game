// ── Co-located components ─────────────────────────────────────────────────────

import { SaveFileTree } from "../../components/SaveFileTree";
import { EYEBROW, MUTED } from "../../components/styles";
import { SaveInfo } from "../../types/dashboard";
import { formatBytes, formatLocalTime } from "../../utils";

export function SaveInfoPanel({
  info,
  onRefresh,
  isRefreshing,
}: {
  info: SaveInfo;
  onRefresh?: () => void;
  isRefreshing?: boolean;
}) {
  return (
    <div className="mt-4 p-4 rounded-[18px] bg-[rgba(9,14,28,0.75)] border border-[rgba(165,185,255,0.08)]">
      <div className="flex items-center justify-between mb-1">
        <p className={`${EYEBROW} mb-0`}>Local save info</p>
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
      {info.files.length > 0 && <SaveFileTree info={info} />}
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

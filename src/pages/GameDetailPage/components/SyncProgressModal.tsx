import { useEffect } from "react";
import type { SyncResult } from "@/types/dashboard";
import { GHOST_BTN } from "@/components/styles";

interface Props {
  /** True while a sync operation is in progress. */
  isSyncing: boolean;
  /** The most recent SyncResult, or null if no sync has run this session. */
  result: SyncResult | null;
  /** Called when the modal should be hidden (error close or auto-dismiss). */
  onClose: () => void;
}

/**
 * Modal shown on the GameDetailPage while a sync is running or just completed.
 * The parent controls visibility — this component is only rendered when visible.
 *
 * States:
 *  - syncing  — spinner + "Syncing save data…"
 *  - success  — green checkmark + counts, auto-dismisses after 3 s
 *  - error    — red X + error message, requires manual close
 */
export function SyncProgressModal({ isSyncing, result, onClose }: Props) {
  // Auto-dismiss successful syncs after 3 s.
  useEffect(() => {
    if (!isSyncing && result && !result.error) {
      const timer = setTimeout(onClose, 3000);
      return () => clearTimeout(timer);
    }
  }, [isSyncing, result, onClose]);

  const isSuccess = !isSyncing && result && !result.error;
  const isError = !isSyncing && result && result.error;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        // Allow closing error state by clicking backdrop.
        if (e.target === e.currentTarget && isError) {
          onClose();
        }
      }}
    >
      <div className="w-full max-w-sm rounded-3xl border border-[rgba(165,185,255,0.15)] bg-[rgba(9,14,28,0.97)] p-7 shadow-2xl grid gap-5">
        {/* ── Syncing state ── */}
        {isSyncing && (
          <div className="flex flex-col items-center gap-4 py-2">
            <svg
              className="animate-spin w-10 h-10 text-[#7dc9ff]"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8v4l3-3-3-3v4a10 10 0 100 10l-1.41-1.41A8 8 0 014 12z"
              />
            </svg>
            <p className="m-0 text-base font-semibold text-white">Syncing save data…</p>
            <p className="m-0 text-sm text-[#9aa8c7]">Comparing local and cloud saves</p>
          </div>
        )}

        {/* ── Success state ── */}
        {isSuccess && result && (
          <>
            <div className="flex flex-col items-center gap-3 py-1">
              <div className="w-12 h-12 rounded-full bg-[rgba(80,200,120,0.15)] border border-[rgba(80,200,120,0.3)] flex items-center justify-center">
                <svg className="w-6 h-6 text-[#86efac]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <p className="m-0 text-base font-semibold text-[#86efac]">Sync complete</p>
            </div>

            <div className="grid gap-2 rounded-2xl bg-[rgba(8,14,25,0.7)] border border-[rgba(165,185,255,0.08)] p-4">
              <div className="flex justify-between text-sm">
                <span className="text-[#9aa8c7]">↑ Uploaded</span>
                <span className="font-semibold text-white">{result.uploaded} file{result.uploaded !== 1 ? "s" : ""}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-[#9aa8c7]">↓ Downloaded</span>
                <span className="font-semibold text-white">{result.downloaded} file{result.downloaded !== 1 ? "s" : ""}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-[#9aa8c7]">— Skipped</span>
                <span className="font-semibold text-white">{result.skipped} file{result.skipped !== 1 ? "s" : ""}</span>
              </div>
            </div>

            <p className="m-0 text-xs text-[#9aa8c7] text-center">Closing automatically…</p>
          </>
        )}

        {/* ── Error state ── */}
        {isError && result && (
          <>
            <div className="flex flex-col items-center gap-3 py-1">
              <div className="w-12 h-12 rounded-full bg-[rgba(255,100,100,0.12)] border border-[rgba(255,100,100,0.3)] flex items-center justify-center">
                <svg className="w-6 h-6 text-[#fca5a5]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </div>
              <p className="m-0 text-base font-semibold text-[#fca5a5]">Sync failed</p>
            </div>

            <p className="m-0 text-sm text-[#9aa8c7] text-center leading-relaxed wrap-anywhere">{result.error}</p>

            <button
              type="button"
              className={`${GHOST_BTN} w-full`}
              onClick={onClose}
            >
              Close
            </button>
          </>
        )}
      </div>
    </div>
  );
}

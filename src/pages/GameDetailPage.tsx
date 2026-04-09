import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ConfirmModal } from "../components/ConfirmModal";
import { DriveFilesSection } from "../components/DriveFilesSection";
import { GameSettingsForm } from "../components/GameSettingsForm";
import { SaveFileTree, formatBytes } from "../components/SaveFileTree";
import { Toast } from "../components/Toast";
import { VersionBackupsSection } from "../components/VersionBackupsSection";
import {
  CARD,
  DANGER_BTN,
  EYEBROW,
  GHOST_BTN,
  MUTED,
  PRIMARY_BTN,
  SECONDARY_BTN,
  SOFT_BADGE,
  SOURCE_BADGE,
} from "../components/styles";
import {
  useCheckSyncDiffMutation,
  useDashboardQuery,
  useGetSaveInfoMutation,
  usePushToCloudMutation,
  useRemoveGameMutation,
  useRestoreFromCloudMutation,
  useSyncGameMutation,
  useSyncLibraryFromCloudMutation,
  useValidatePathsQuery,
} from "../queries";
import type {
  SaveInfo,
  SyncStructureDiff,
} from "../types/dashboard";
import { formatLocalTime, msg, toImgSrc } from "../utils";

export function GameDetailPage() {
  const { id } = useParams<{ id: string }>();

  const navigate = useNavigate();

  const { data: dashboard } = useDashboardQuery();

  const removeMutation = useRemoveGameMutation();

  const [showRemoveModal, setShowRemoveModal] = useState(false);
  
  const [showSettingsModal, setShowSettingsModal] = useState(false);

  const game = dashboard?.games.find((g) => g.id === id) ?? null;

  // console.log("[GameDetailPage] game:", game);

  const saveInfoMutation = useGetSaveInfoMutation();

  const syncMutation = useSyncGameMutation();

  const syncLibraryMutation = useSyncLibraryFromCloudMutation();

  const validateQuery = useValidatePathsQuery();

  const [toast, setToast] = useState<{
    message: string;
    type: "success" | "error";
  } | null>(null);

  const restoreFlow = useRestoreFromDriveFlow(id ?? "", setToast);

  const isSyncing =
    syncMutation.isPending ||
    restoreFlow.isChecking ||
    restoreFlow.isExecuting ||
    syncLibraryMutation.isPending;

  const isPathInvalid =
    game != null &&
    (validateQuery.data ?? []).some((v) => v.gameId === game.id && !v.valid);

  if (!game) {
    return (
      <div className={`${CARD} text-center`}>
        <p className="text-[1.1rem]">Game not found.</p>
        <Link to="/" className="text-[#7dc9ff] underline">
          Back to dashboard
        </Link>
      </div>
    );
  }

  const sourceBadge = SOURCE_BADGE[game.source] ?? SOFT_BADGE;

  return (
    <>
      {/* Breadcrumb */}
      <div>
        <Link to="/" className="text-[#7dc9ff] text-sm hover:underline">
          ← Back to library
        </Link>
      </div>

      {/* Header */}
      <div className={CARD}>
        <div className="flex items-start gap-5 mb-5">
          {/* Thumbnail */}
          <div className="w-24 h-24 shrink-0 rounded-2xl border border-[rgba(165,185,255,0.1)] bg-[rgba(9,14,28,0.75)] overflow-hidden">
            {game.thumbnail ? (
              <img
                src={toImgSrc(game.thumbnail)}
                alt={game.name}
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="grid place-items-center w-full h-full text-[#9aa8c7] text-3xl">
                🎮
              </div>
            )}
          </div>

          <div className="grid gap-2">
            <p className={EYEBROW}>Game details</p>
            <h2 className="m-0">{game.name}</h2>
            <span className={sourceBadge}>{game.source}</span>
            {game.description && (
              <p className="m-0 text-sm text-[#9aa8c7] max-w-[480px] whitespace-pre-wrap">
                {game.description}
              </p>
            )}
          </div>
        </div>

        {/* Metadata grid */}
        <dl className="grid gap-[14px] grid-cols-2 m-0 max-[720px]:grid-cols-1">
          {[
            { label: "Save folder", value: game.savePath ?? "Not set" },
            {
              label: "Last local save",
              value: formatLocalTime(game.lastLocalModified),
            },
            {
              label: "Last cloud save",
              value: formatLocalTime(game.lastCloudModified),
            },
            {
              label: "Google Drive folder",
              value: game.gdriveFolderId ?? "Not synced",
            },
            {
              label: "Drive storage used",
              value:
                game.cloudStorageBytes != null
                  ? formatBytes(game.cloudStorageBytes)
                  : "Never synced",
            },
          ].map(({ label, value }) => (
            <div
              key={label}
              className="p-[18px] rounded-[18px] bg-[rgba(9,14,28,0.75)] border border-[rgba(165,185,255,0.08)]"
            >
              <dt className="mb-2 text-[#c7d3f7] text-[0.92rem]">{label}</dt>
              <dd className="m-0 break-words text-[#9aa8c7]">{value}</dd>
            </div>
          ))}
        </dl>
      </div>

      {/* Settings form */}

      {/* Actions */}
      <div className={CARD}>
        <h3 className="m-0 mb-4 font-semibold">Actions</h3>

        <div className="grid gap-4 grid-cols-2 max-[900px]:grid-cols-1">
          <button
            className={SECONDARY_BTN}
            type="button"
            disabled={isSyncing}
            onClick={() => setShowSettingsModal(true)}
          >
            Edit settings
          </button>
          <button
            className={SECONDARY_BTN}
            type="button"
            disabled={isSyncing}
            onClick={() =>
              syncLibraryMutation.mutate(undefined, {
                onSuccess: () =>
                  setToast({
                    message: "Game settings refreshed from Drive.",
                    type: "success",
                  }),
                onError: (err) =>
                  setToast({
                    message: msg(err, "Failed to sync settings from Drive."),
                    type: "error",
                  }),
              })
            }
          >
            {syncLibraryMutation.isPending ? "Syncing…" : "↓ Sync settings from Drive"}
          </button>
          <button
            className={SECONDARY_BTN}
            type="button"
            disabled={!game.savePath || saveInfoMutation.isPending || isSyncing}
            onClick={() => game.savePath && saveInfoMutation.mutate(game.id)}
          >
            {saveInfoMutation.isPending ? "Loading…" : "Get save info"}
          </button>
          <button
            className={SECONDARY_BTN}
            type="button"
            disabled={!game.savePath || isSyncing}
            onClick={() => game.savePath && restoreFlow.start()}
          >
            {restoreFlow.isChecking ? "Checking…" : "Restore from Drive"}
          </button>
          <button
            className={`${PRIMARY_BTN} inline-flex items-center justify-center gap-2`}
            type="button"
            disabled={!game.savePath || isSyncing}
            onClick={() =>
              game.savePath &&
              syncMutation.mutate(game.id, {
                onSuccess: (data) => {
                  if (data.error) {
                    setToast({ message: data.error, type: "error" });
                  } else {
                    setToast({
                      message: `Sync complete — ↑${data.uploaded} ↓${data.downloaded} file(s)`,
                      type: "success",
                    });
                  }
                },
                onError: (err) => {
                  setToast({
                    message: msg(err, "Sync failed."),
                    type: "error",
                  });
                },
              })
            }
          >
            {isSyncing ? (
              <>
                <svg
                  className="animate-spin h-4 w-4 shrink-0"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                  />
                </svg>
                Syncing…
              </>
            ) : (
              "Sync to Google Drive"
            )}
          </button>
        </div>

        {/* Save Info Result */}
        {saveInfoMutation.data && (
          <SaveInfoPanel info={saveInfoMutation.data} />
        )}
        {saveInfoMutation.isError && (
          <p className="m-0 mt-3 text-sm text-[#ffd5d5]">
            {msg(saveInfoMutation.error, "Unable to get save info.")}
          </p>
        )}

        {/* Sync Result */}
        {syncMutation.data && <SyncResultPanel result={syncMutation.data} />}
        {syncMutation.isError && (
          <p className="m-0 mt-3 text-sm text-[#ffd5d5]">
            {msg(syncMutation.error, "Sync failed.")}
          </p>
        )}
      </div>

      {/* Drive file manager */}
      {game.gdriveFolderId && (
        <DriveFilesSection
          gameId={game.id}
          gameFolderId={game.gdriveFolderId}
        />
      )}

      {/* Version backups */}
      {game.gdriveFolderId && <VersionBackupsSection gameId={game.id} />}

      {/* Danger zone */}
      <div className={CARD}>
        <h3 className="m-0 mb-4 font-semibold text-[#ff9e9e]">Danger zone</h3>
        <button
          className={DANGER_BTN}
          type="button"
          disabled={removeMutation.isPending || isSyncing}
          onClick={() => setShowRemoveModal(true)}
        >
          {removeMutation.isPending ? "Removing…" : "Remove game"}
        </button>
        {removeMutation.isError && (
          <p className="m-0 mt-3 text-sm text-[#ffd5d5]">
            {msg(removeMutation.error, "Unable to remove game.")}
          </p>
        )}
      </div>

      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onDismiss={() => setToast(null)}
        />
      )}

      {restoreFlow.syncDiff && (
        <SyncConflictModal
          open={restoreFlow.showModal}
          diff={restoreFlow.syncDiff}
          onConfirm={(method) => restoreFlow.executeMethod(method)}
          onCancel={restoreFlow.closeModal}
        />
      )}

      <GameSettingsForm
        open={showSettingsModal}
        onClose={() => setShowSettingsModal(false)}
        game={game}
        isSyncing={isSyncing}
        isPathInvalid={isPathInvalid}
      />

      <ConfirmModal
        open={showRemoveModal}
        title="Remove game"
        message={`Are you sure you want to remove "${game.name}" from your library? This cannot be undone.`}
        confirmLabel="Remove"
        onConfirm={() => {
          setShowRemoveModal(false);
          removeMutation.mutate(game.id, {
            onSuccess: () => navigate("/", { replace: true }),
          });
        }}
        onCancel={() => setShowRemoveModal(false)}
      />
    </>
  );
}

// ── Co-located components ─────────────────────────────────────────────────────

function SaveInfoPanel({ info }: { info: SaveInfo }) {
  return (
    <div className="mt-4 p-4 rounded-[18px] bg-[rgba(9,14,28,0.75)] border border-[rgba(165,185,255,0.08)]">
      <p className={EYEBROW}>Local save info</p>
      <dl className="grid gap-2 grid-cols-3 m-0 max-[720px]:grid-cols-1">
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
          <dd className={`${MUTED} m-0`}>{info.lastModified ?? "N/A"}</dd>
        </div>
      </dl>
      {info.files.length > 0 && <SaveFileTree info={info} />}
    </div>
  );
}

function SyncResultPanel({
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

// ── useRestoreFromDriveFlow ───────────────────────────────────────────────────

type SyncMethod = "auto" | "restore" | "push";

function useRestoreFromDriveFlow(
  gameId: string,
  setToast: (t: { message: string; type: "success" | "error" } | null) => void,
) {
  const [showModal, setShowModal] = useState(false);
  const [syncDiff, setSyncDiff] = useState<SyncStructureDiff | null>(null);

  const checkDiffMutation = useCheckSyncDiffMutation();
  const restoreMutation = useRestoreFromCloudMutation();
  const pushMutation = usePushToCloudMutation();
  const syncMutation = useSyncGameMutation();

  const isChecking = checkDiffMutation.isPending;
  const isExecuting =
    restoreMutation.isPending ||
    pushMutation.isPending ||
    syncMutation.isPending;

  function start() {
    checkDiffMutation.mutate(gameId, {
      onSuccess: (diff) => {
        if (!diff.cloudHasData) {
          setToast({
            message: "No cloud saves found. Sync to Drive first.",
            type: "error",
          });
          return;
        }
        if (!diff.hasDiff) {
          setToast({
            message:
              "Drive and local are already identical — nothing to restore.",
            type: "success",
          });
          return;
        }
        setSyncDiff(diff);
        setShowModal(true);
      },
      onError: (err) => {
        setToast({
          message: msg(err, "Failed to check sync status."),
          type: "error",
        });
      },
    });
  }

  function closeModal() {
    setShowModal(false);
  }

  function executeMethod(method: SyncMethod) {
    setShowModal(false);
    if (method === "auto") {
      syncMutation.mutate(gameId, {
        onSuccess: (data) => {
          if (data.error) setToast({ message: data.error, type: "error" });
          else
            setToast({
              message: `Sync complete — ↑${data.uploaded} ↓${data.downloaded} file(s)`,
              type: "success",
            });
        },
        onError: (err) =>
          setToast({ message: msg(err, "Sync failed."), type: "error" }),
      });
    } else if (method === "restore") {
      restoreMutation.mutate(gameId, {
        onSuccess: (data) => {
          if (data.error) setToast({ message: data.error, type: "error" });
          else
            setToast({
              message: `Restore complete — ↓${data.downloaded} file(s) downloaded`,
              type: "success",
            });
        },
        onError: (err) =>
          setToast({ message: msg(err, "Restore failed."), type: "error" }),
      });
    } else {
      pushMutation.mutate(gameId, {
        onSuccess: (data) => {
          if (data.error) setToast({ message: data.error, type: "error" });
          else
            setToast({
              message: `Push complete — ↑${data.uploaded} file(s) uploaded`,
              type: "success",
            });
        },
        onError: (err) =>
          setToast({
            message: msg(err, "Push to Drive failed."),
            type: "error",
          }),
      });
    }
  }

  return {
    start,
    isChecking,
    isExecuting,
    syncDiff,
    showModal,
    closeModal,
    executeMethod,
  };
}

// ── SyncConflictModal ─────────────────────────────────────────────────────────

interface SyncConflictModalProps {
  open: boolean;
  diff: SyncStructureDiff;
  onConfirm: (method: SyncMethod) => void;
  onCancel: () => void;
}

function SyncConflictModal({
  open,
  diff,
  onConfirm,
  onCancel,
}: SyncConflictModalProps) {
  const [selected, setSelected] = useState<SyncMethod>("auto");

  if (!open) return null;

  const rows: Array<{ label: string; count: number; warn?: boolean }> = [
    { label: "Local files not on Drive", count: diff.localOnlyFiles.length },
    {
      label: "Drive files not found locally",
      count: diff.cloudOnlyFiles.length,
    },
    {
      label: "Local files newer than Drive",
      count: diff.localNewerFiles.length,
      warn: true,
    },
    {
      label: "Drive files newer than local",
      count: diff.cloudNewerFiles.length,
      warn: true,
    },
  ].filter((r) => r.count > 0);

  const methods: Array<{
    value: SyncMethod;
    label: string;
    description: string;
  }> = [
    {
      value: "auto",
      label: "Auto-sync (newest wins)",
      description:
        "Each file keeps whichever version was modified most recently.",
    },
    {
      value: "restore",
      label: "Restore from Drive",
      description:
        "Overwrite local files with the Drive version — even if local is newer.",
    },
    {
      value: "push",
      label: "Push local to Drive",
      description:
        "Overwrite Drive files with local versions — even if Drive is newer.",
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-[480px] rounded-3xl border border-[rgba(165,185,255,0.15)] bg-[rgba(9,14,28,0.97)] p-6 shadow-2xl grid gap-5">
        {/* Header */}
        <div>
          <p className={EYEBROW}>Sync conflict detected</p>
          <h3 className="m-0 mt-1">Local and Drive differ</h3>
        </div>

        {/* Diff summary */}
        <div className="grid gap-2">
          {rows.map((r) => (
            <div
              key={r.label}
              className={`flex items-center justify-between gap-3 px-4 py-2 rounded-2xl border text-sm ${
                r.warn
                  ? "border-[rgba(255,180,80,0.2)] bg-[rgba(40,28,10,0.6)] text-[#ffd5a0]"
                  : "border-[rgba(165,185,255,0.08)] bg-[rgba(255,255,255,0.02)] text-[#c7d3f7]"
              }`}
            >
              <span>{r.label}</span>
              <span className="font-semibold tabular-nums">{r.count}</span>
            </div>
          ))}
        </div>

        {/* Method picker */}
        <div className="grid gap-2">
          <p className={`${MUTED} text-xs uppercase tracking-wider`}>
            Choose sync method
          </p>
          {methods.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => setSelected(m.value)}
              className={`text-left p-4 rounded-2xl border transition-colors ${
                selected === m.value
                  ? "border-[rgba(125,201,255,0.5)] bg-[rgba(125,201,255,0.08)]"
                  : "border-[rgba(165,185,255,0.08)] bg-[rgba(255,255,255,0.02)] hover:border-[rgba(165,185,255,0.2)]"
              }`}
            >
              <p className="m-0 font-medium text-[#c7d3f7] text-sm">
                {m.label}
              </p>
              <p className={`${MUTED} m-0 text-xs mt-0.5`}>{m.description}</p>
            </button>
          ))}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3">
          <button type="button" className={GHOST_BTN} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={PRIMARY_BTN}
            onClick={() => onConfirm(selected)}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

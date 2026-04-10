import { openPath } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ConfirmModal } from "../../components/ConfirmModal";
import { DriveFilesSection } from "../../components/DriveFilesSection";
import { GameSettingsForm } from "../../components/GameSettingsForm";
import { formatBytes } from "../../components/SaveFileTree";
import {
  CARD,
  DANGER_BTN,
  EYEBROW,
  PRIMARY_BTN,
  SECONDARY_BTN,
  SOFT_BADGE,
  SOURCE_BADGE,
} from "../../components/styles";
import { Toast } from "../../components/Toast";
import { VersionBackupsSection } from "../../components/VersionBackupsSection";
import {
  useDashboardQuery,
  useGetSaveInfoQuery,
  useRemoveGameMutation,
  useSyncGameMutation,
  useSyncLibraryFromCloudMutation,
  useValidatePathsQuery,
} from "../../queries";
import { expandSavePath } from "../../services/tauri";
import { formatLocalTime, msg, toImgSrc } from "../../utils";
import { useRestoreFromDriveFlow } from "./hooks";
import { SaveInfoPanel, SyncResultPanel } from "./SupportUI";
import SyncConflictModal from "./SyncConflictModal";
import TrackingSyncCard from "./TrackingSyncCard";

export function GameDetailPage() {
  const { id } = useParams<{ id: string }>();

  const navigate = useNavigate();

  const { data: dashboard, isLoading: isDashboardLoading } =
    useDashboardQuery();

  const removeMutation = useRemoveGameMutation();

  const [showRemoveModal, setShowRemoveModal] = useState(false);

  const [showSettings, setShowSettings] = useState(false);

  const game = dashboard?.games.find((g) => g.id === id) ?? null;

  // console.log("[GameDetailPage] game:", game);

  const saveInfoQuery = useGetSaveInfoQuery(id ?? "", !!game?.savePath);

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

  if (isDashboardLoading) {
    return <GameDetailSkeleton />;
  }

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
              <p className="m-0 text-sm text-[#9aa8c7] max-w-120 whitespace-pre-wrap">
                {game.description}
              </p>
            )}
          </div>
        </div>

        {/* Metadata grid */}
        <dl className="grid gap-3.5 grid-cols-2 m-0 max-[720px]:grid-cols-1">
          {[
            { label: "Save folder", value: game.savePath ?? "Not set" },
            {
              label: "Google Drive folder",
              value: game.gdriveFolderId ?? "Not synced",
            },
            {
              label: "Last cloud save",
              value: formatLocalTime(game.lastCloudModified),
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
              className="p-4.5 rounded-[18px] bg-[rgba(9,14,28,0.75)] border border-[rgba(165,185,255,0.08)]"
            >
              <dt className="mb-2 text-[#c7d3f7] text-[0.92rem]">{label}</dt>
              <dd className="m-0 wrap-break-word text-[#9aa8c7]">{value}</dd>
            </div>
          ))}
        </dl>
      </div>

      {/* Actions */}
      <div className={CARD}>
        <h3 className="m-0 mb-4 font-semibold">Actions</h3>

        <div className="grid gap-4 grid-cols-2 max-[900px]:grid-cols-1">
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
            {syncLibraryMutation.isPending
              ? "Syncing…"
              : "Download settings from Drive"}
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
            className={`${PRIMARY_BTN} col-span-full inline-flex items-center justify-center gap-2`}
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
        {saveInfoQuery.data && (
          <SaveInfoPanel
            info={saveInfoQuery.data}
            onRefresh={() => void saveInfoQuery.refetch()}
            isRefreshing={saveInfoQuery.isFetching}
            onOpenFolder={() => {
              if (!game?.savePath) return;
              void expandSavePath(game.savePath).then((p) => openPath(p));
            }}
          />
        )}
        {saveInfoQuery.isError && (
          <p className="m-0 mt-3 text-sm text-[#ffd5d5]">
            {msg(saveInfoQuery.error, "Unable to get save info.")}
          </p>
        )}

        {/* Sync Result */}
        {syncMutation.data && <SyncResultPanel result={syncMutation.data} />}
        {syncMutation.isError && (
          <p className="m-0 mt-3 text-sm text-[#ffd5d5]">
            {msg(syncMutation.error, "Sync failed.")}
          </p>
        )}

        {/* Settings form */}

        {/* Settings (collapsible) */}
        <GameSettingsForm
          isOpen={showSettings}
          onToggle={() => setShowSettings((v) => !v)}
          isSyncing={isSyncing}
          isPathInvalid={isPathInvalid}
          id={id}
        />
      </div>

      {/* Tracking & Sync quick-toggles */}
      <TrackingSyncCard
        gameId={game.id}
        savePath={game.savePath}
        trackChanges={game.trackChanges}
        autoSync={game.autoSync}
        isSyncing={isSyncing}
        onError={(msg) => setToast({ message: msg, type: "error" })}
      />

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

function GameDetailSkeleton() {
  const shimmer = "animate-pulse bg-[rgba(165,185,255,0.08)] rounded-xl";
  return (
    <>
      {/* Breadcrumb */}
      <div className={`h-4 w-28 ${shimmer} rounded-full`} />

      {/* Header card */}
      <div className={CARD}>
        <div className="flex items-start gap-5 mb-5">
          <div className={`w-24 h-24 shrink-0 rounded-2xl ${shimmer}`} />
          <div className="grid gap-3 flex-1">
            <div className={`h-3 w-20 rounded-full ${shimmer}`} />
            <div className={`h-7 w-48 ${shimmer}`} />
            <div className={`h-5 w-16 rounded-full ${shimmer}`} />
          </div>
        </div>
        {/* Metadata grid */}
        <div className="grid gap-3.5 grid-cols-2 max-[720px]:grid-cols-1">
          {[0, 1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="p-4.5 rounded-[18px] bg-[rgba(9,14,28,0.75)] border border-[rgba(165,185,255,0.08)]"
            >
              <div className={`h-3 w-24 rounded-full mb-2 ${shimmer}`} />
              <div className={`h-4 w-36 ${shimmer}`} />
            </div>
          ))}
        </div>
      </div>

      {/* Actions card */}
      <div className={CARD}>
        <div className={`h-5 w-20 mb-5 ${shimmer}`} />
        <div className="grid gap-4 grid-cols-2 max-[900px]:grid-cols-1">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className={`h-11 rounded-2xl ${shimmer}`} />
          ))}
        </div>
      </div>

      {/* Tracking toggles card */}
      <div className={CARD}>
        <div className={`h-5 w-40 mb-5 ${shimmer}`} />
        <div className="flex flex-col gap-4">
          {[0, 1].map((i) => (
            <div key={i} className="flex items-center justify-between gap-3">
              <div className="grid gap-1.5">
                <div className={`h-4 w-32 ${shimmer}`} />
                <div className={`h-3 w-52 rounded-full ${shimmer}`} />
              </div>
              <div className={`w-12 h-6 rounded-full shrink-0 ${shimmer}`} />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

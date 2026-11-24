import { ConfirmModal } from "@/components/ConfirmModal";
import { DriveFilesSection } from "@/components/DriveFilesSection";
import { CARD, PRIMARY_BTN, SECONDARY_BTN } from "@/components/styles";
import { Toast } from "@/components/Toast";
import { VersionBackupsSection } from "@/components/VersionBackupsSection";
import { useT } from "@/i18n";
import { useGetSaveInfoQuery, useSyncGameMutation } from "@/queries";
import { DashboardQuery } from "@/queries/dashboard";
import { useGamePlaying } from "@/queries/detail";
import { useCleanExcludedDriveFilesMutation, useCleanupDriveHistoryMutation } from "@/queries/sync";
import { expandSavePath } from "@/services/tauri";
import { formatBytes, msg } from "@/utils";
import { useQueryClient } from "@tanstack/react-query";
import { openPath } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import { useParams } from "react-router";
import { useRestoreFromDriveFlow } from "../../hooks";
import { SaveInfoPanel, SyncResultPanel } from "../SupportUI";
import SyncConflictModal from "../SyncConflictModal";
import TrackingSyncCard from "../TrackingSyncCard";

const TabStatus = () => {
  const { id } = useParams<{ id: string }>();
  const t = useT();

  const { data: isGamePlaying = false } = useGamePlaying(id ?? "");

  const syncMutation = useSyncGameMutation(id ?? "");

  const queryClient = useQueryClient();

  const game = queryClient.getQueryData(DashboardQuery.queryKey)?.games.find((g) => g.id === id);

  const primarySavePath = game?.savePaths[0]?.path ?? null;

  const saveInfoQuery = useGetSaveInfoQuery(id ?? "", !!primarySavePath);

  const cleanExcludedMutation = useCleanExcludedDriveFilesMutation();

  const cleanupHistoryMutation = useCleanupDriveHistoryMutation();

  const isSyncing = syncMutation.isPending || cleanExcludedMutation.isPending || cleanupHistoryMutation.isPending;

  const hasIncludes = game?.savePaths.some((sp) => sp.syncIncludes.length > 0) ?? false;

  const [toast, setToast] = useState<{
    message: string;
    type: "success" | "error";
  } | null>(null);

  const [showCleanConfirm, setShowCleanConfirm] = useState(false);

  const restoreFlow = useRestoreFromDriveFlow(id ?? "", setToast);

  if (!game) return null;

  return (
    <>
      {/* Actions */}
      <div className={CARD}>
        <h3 className="m-0 mb-4 font-semibold">{t("status.actions")}</h3>

        <div className="grid gap-4 grid-cols-2 max-[900px]:grid-cols-1">
          <button
            className={SECONDARY_BTN}
            type="button"
            disabled={!primarySavePath || isSyncing}
            onClick={() => primarySavePath && restoreFlow.start()}
          >
            {restoreFlow.isChecking ? t("status.checking") : t("conflict.restoreLabel")}
          </button>
          <button
            className={SECONDARY_BTN}
            type="button"
            disabled={isSyncing || !hasIncludes}
            title={!hasIncludes ? t("status.noFilter") : undefined}
            onClick={() => setShowCleanConfirm(true)}
          >
            {cleanExcludedMutation.isPending ? t("status.cleaning") : t("status.cleanExcluded")}
          </button>
          <button
            className={`${SECONDARY_BTN} col-span-full`}
            type="button"
            disabled={isSyncing || isGamePlaying}
            title={t("status.cleanupHint")}
            onClick={() =>
              cleanupHistoryMutation.mutate(id ?? "", {
                onSuccess: (r) => {
                  const parts = [
                    r.objectsDeleted > 0
                      ? t("status.cleanupFreed", { size: formatBytes(r.bytesFreed), count: r.objectsDeleted })
                      : t("status.cleanupNothing"),
                  ];
                  if (r.snapshotsPruned > 0) parts.push(t("status.cleanupPruned", { count: r.snapshotsPruned }));
                  if (r.objectsPending > 0)
                    parts.push(t("status.cleanupPending", { count: r.objectsPending }));
                  setToast({ message: parts.join(" · "), type: "success" });
                },
                onError: (err) => setToast({ message: msg(err, t("status.cleanupFailed")), type: "error" }),
              })
            }
          >
            {cleanupHistoryMutation.isPending ? t("status.cleaningUp") : t("status.cleanup")}
          </button>
          <button
            className={`${PRIMARY_BTN} col-span-full inline-flex items-center justify-center gap-2`}
            type="button"
            disabled={!primarySavePath || isSyncing}
            onClick={() =>
              primarySavePath &&
              syncMutation.mutate(undefined, {
                onSuccess: (data) => {
                  if (data.error) {
                    setToast({ message: data.error, type: "error" });
                  } else {
                    setToast({
                      message: t("sync.completeToast", { up: data.uploaded, down: data.downloaded }),
                      type: "success",
                    });
                  }
                },
                onError: (err) => {
                  setToast({
                    message: msg(err, t("sync.failed")),
                    type: "error",
                  });
                },
              })
            }
          >
            {syncMutation.isPending ? (
              <>
                <svg
                  className="animate-spin h-4 w-4 shrink-0"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                {t("status.syncing")}
              </>
            ) : (
              t("status.sync")
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
              if (!primarySavePath) return;
              void expandSavePath(primarySavePath).then((p) => openPath(p));
            }}
            onOpenFolderForPath={(rawPath) => {
              void expandSavePath(rawPath).then((p) => openPath(p));
            }}
          />
        )}
        {saveInfoQuery.isError && <p className="m-0 mt-3 text-sm text-[#ffd5d5]">{msg(saveInfoQuery.error, t("status.errorSaveInfo"))}</p>}

        {/* Sync Result */}
        {syncMutation.data && <SyncResultPanel result={syncMutation.data} />}
        {syncMutation.isError && <p className="m-0 mt-3 text-sm text-[#ffd5d5]">{msg(syncMutation.error, t("sync.failed"))}</p>}
      </div>

      {/* Tracking & Sync status */}
      <TrackingSyncCard
        gameId={game.id}
        savePath={primarySavePath}
        trackChanges={game.trackChanges}
        autoSync={game.autoSync}
        isSyncing={isSyncing}
        exeName={game.exeName ?? null}
        isGamePlaying={isGamePlaying}
        onError={(m) => setToast({ message: m, type: "error" })}
      />

      {/* Drive file manager */}
      {game.gdriveFolderId && (
        <DriveFilesSection gameId={game.id} gameFolderId={game.gdriveFolderId} savePaths={game.savePaths} pathMode={game.pathMode} />
      )}

      {/* Version backups */}
      {game.gdriveFolderId && <VersionBackupsSection gameId={game.id} />}

      {toast && <Toast message={toast.message} type={toast.type} onDismiss={() => setToast(null)} />}

      {restoreFlow.syncDiff && (
        <SyncConflictModal
          open={restoreFlow.showModal}
          diff={restoreFlow.syncDiff}
          onConfirm={(method) => restoreFlow.executeMethod(method)}
          onCancel={restoreFlow.closeModal}
        />
      )}

      <ConfirmModal
        open={showCleanConfirm}
        title={t("status.cleanExcludedTitle")}
        message={t("status.cleanExcludedMessage")}
        confirmLabel={t("drive.delete")}
        onConfirm={() => {
          setShowCleanConfirm(false);
          cleanExcludedMutation.mutate(id ?? "", {
            onSuccess: () => setToast({ message: t("status.cleanExcludedDone"), type: "success" }),
            onError: (err) => setToast({ message: msg(err, t("status.cleanExcludedFailed")), type: "error" }),
          });
        }}
        onCancel={() => setShowCleanConfirm(false)}
      />
    </>
  );
};

export default TabStatus;

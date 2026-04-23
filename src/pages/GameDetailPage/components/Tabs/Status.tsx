import { DriveFilesSection } from "@/components/DriveFilesSection";
import { CARD, PRIMARY_BTN, SECONDARY_BTN } from "@/components/styles";
import { Toast } from "@/components/Toast";
import { VersionBackupsSection } from "@/components/VersionBackupsSection";
import { ConfirmModal } from "@/components/ConfirmModal";
import { useGetSaveInfoQuery, useSyncGameMutation, useSyncLibraryFromCloudMutation } from "@/queries";
import { useCleanExcludedDriveFilesMutation } from "@/queries/sync";
import { DashboardQuery } from "@/queries/dashboard";
import { useGamePlaying } from "@/queries/detail";
import { expandSavePath } from "@/services/tauri";
import { msg } from "@/utils";
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

  const { data: isGamePlaying = false } = useGamePlaying(id ?? "");

  const syncMutation = useSyncGameMutation(id ?? "");

  const queryClient = useQueryClient();

  const game = queryClient.getQueryData(DashboardQuery.queryKey)?.games.find((g) => g.id === id);

  const primarySavePath = game?.savePaths[0]?.path ?? null;
  const saveInfoQuery = useGetSaveInfoQuery(id ?? "", !!primarySavePath);

  const syncLibraryMutation = useSyncLibraryFromCloudMutation();
  const cleanExcludedMutation = useCleanExcludedDriveFilesMutation();

  const isSyncing = syncMutation.isPending || syncLibraryMutation.isPending || cleanExcludedMutation.isPending;

  const hasExcludes = game?.savePaths.some((sp) => sp.syncExcludes.length > 0) ?? false;

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
            {syncLibraryMutation.isPending ? "Syncing…" : "Download settings from Drive"}
          </button>
          <button
            className={SECONDARY_BTN}
            type="button"
            disabled={!primarySavePath || isSyncing}
            onClick={() => primarySavePath && restoreFlow.start()}
          >
            {restoreFlow.isChecking ? "Checking…" : "Restore from Drive"}
          </button>
          <button
            className={SECONDARY_BTN}
            type="button"
            disabled={isSyncing || !hasExcludes}
            title={!hasExcludes ? "No sync exclusions configured for this game" : undefined}
            onClick={() => setShowCleanConfirm(true)}
          >
            {cleanExcludedMutation.isPending ? "Cleaning…" : "Clean excluded from Drive"}
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
            {isSyncing && !cleanExcludedMutation.isPending ? (
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
              if (!primarySavePath) return;
              void expandSavePath(primarySavePath).then((p) => openPath(p));
            }}
            onOpenFolderForPath={(rawPath) => {
              void expandSavePath(rawPath).then((p) => openPath(p));
            }}
          />
        )}
        {saveInfoQuery.isError && <p className="m-0 mt-3 text-sm text-[#ffd5d5]">{msg(saveInfoQuery.error, "Unable to get save info.")}</p>}

        {/* Sync Result */}
        {syncMutation.data && <SyncResultPanel result={syncMutation.data} />}
        {syncMutation.isError && <p className="m-0 mt-3 text-sm text-[#ffd5d5]">{msg(syncMutation.error, "Sync failed.")}</p>}
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
      {game.gdriveFolderId && <DriveFilesSection gameId={game.id} gameFolderId={game.gdriveFolderId} savePaths={game.savePaths} pathMode={game.pathMode} />}

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
        title="Remove excluded files from Drive"
        message="This will permanently delete all Drive files matching your current sync exclusions. This cannot be undone."
        confirmLabel="Delete from Drive"
        onConfirm={() => {
          setShowCleanConfirm(false);
          cleanExcludedMutation.mutate(id ?? "", {
            onSuccess: () =>
              setToast({ message: "Excluded files removed from Drive.", type: "success" }),
            onError: (err) =>
              setToast({ message: msg(err, "Failed to clean excluded files."), type: "error" }),
          });
        }}
        onCancel={() => setShowCleanConfirm(false)}
      />
    </>
  );
};

export default TabStatus;

// ── useRestoreFromDriveFlow ───────────────────────────────────────────────────

import { useState } from "react";
import {
  useCheckSyncDiffMutation,
  usePushToCloudMutation,
  useRestoreFromCloudMutation,
  useSyncGameMutation,
} from "../../queries";
import { SyncStructureDiff } from "../../types/dashboard";
import { msg } from "../../utils";

export type SyncMethod = "auto" | "restore" | "push";

export function useRestoreFromDriveFlow(
  gameId: string,
  setToast: (t: { message: string; type: "success" | "error" } | null) => void,
) {
  const [showModal, setShowModal] = useState(false);
  const [syncDiff, setSyncDiff] = useState<SyncStructureDiff | null>(null);

  const checkDiffMutation = useCheckSyncDiffMutation();
  const restoreMutation = useRestoreFromCloudMutation();
  const pushMutation = usePushToCloudMutation();
  const syncMutation = useSyncGameMutation(gameId);

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
      syncMutation.mutate(undefined, {
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

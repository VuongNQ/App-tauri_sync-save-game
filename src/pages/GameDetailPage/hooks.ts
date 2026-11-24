// ── useRestoreFromDriveFlow ───────────────────────────────────────────────────

import { useState } from "react";
import { useCheckSyncDiffMutation, usePushToCloudMutation, useRestoreFromCloudMutation, useSyncGameMutation } from "../../queries";
import { SyncStructureDiff } from "../../types/dashboard";
import { useT } from "../../i18n";
import { msg } from "../../utils";

export type SyncMethod = "auto" | "restore" | "push";

export function useRestoreFromDriveFlow(gameId: string, setToast: (t: { message: string; type: "success" | "error" } | null) => void) {
  const [showModal, setShowModal] = useState(false);
  const t = useT();
  const [syncDiff, setSyncDiff] = useState<SyncStructureDiff | null>(null);

  const checkDiffMutation = useCheckSyncDiffMutation();
  const restoreMutation = useRestoreFromCloudMutation();
  const pushMutation = usePushToCloudMutation();
  const syncMutation = useSyncGameMutation(gameId);

  const isChecking = checkDiffMutation.isPending;
  const isExecuting = restoreMutation.isPending || pushMutation.isPending || syncMutation.isPending;

  function start() {
    checkDiffMutation.mutate(gameId, {
      onSuccess: (diff) => {
        if (!diff.cloudHasData) {
          setToast({
            message: t("restore.noCloud"),
            type: "error",
          });
          return;
        }
        if (!diff.hasDiff) {
          setToast({
            message: t("restore.identical"),
            type: "success",
          });
          return;
        }
        setSyncDiff(diff);
        setShowModal(true);
      },
      onError: (err) => {
        setToast({
          message: msg(err, t("restore.errorCheck")),
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
              message: t("sync.completeToast", { up: data.uploaded, down: data.downloaded }),
              type: "success",
            });
        },
        onError: (err) => setToast({ message: msg(err, t("sync.failed")), type: "error" }),
      });
    } else if (method === "restore") {
      restoreMutation.mutate(gameId, {
        onSuccess: (data) => {
          if (data.error) setToast({ message: data.error, type: "error" });
          else
            setToast({
              message: t("restore.complete", { down: data.downloaded }),
              type: "success",
            });
        },
        onError: (err) => setToast({ message: msg(err, t("restore.failed")), type: "error" }),
      });
    } else {
      pushMutation.mutate(gameId, {
        onSuccess: (data) => {
          if (data.error) setToast({ message: data.error, type: "error" });
          else
            setToast({
              message: t("push.complete", { up: data.uploaded }),
              type: "success",
            });
        },
        onError: (err) =>
          setToast({
            message: msg(err, t("push.failed")),
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

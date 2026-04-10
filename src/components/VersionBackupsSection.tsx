import { useMemo, useState } from "react";

import {
  useCreateVersionBackupMutation,
  useDeleteVersionBackupMutation,
  useRestoreVersionBackupMutation,
  useVersionBackupsQuery,
} from "../queries";
import type { DriveVersionBackup } from "../types/dashboard";
import { msg } from "../utils";
import { ConfirmModal } from "./ConfirmModal";
import {
  CARD,
  DANGER_BTN,
  EYEBROW,
  GHOST_BTN,
  INPUT_CLS,
  MUTED,
  PRIMARY_BTN,
  SECONDARY_BTN,
} from "./styles";

interface Props {
  gameId: string;
}

export function VersionBackupsSection({ gameId }: Props) {
  const [isOpen, setIsOpen] = useState(false);

  const {
    data: backups,
    isLoading,
    isError,
    error,
    refetch,
  } = useVersionBackupsQuery(gameId, isOpen);

  const createMutation = useCreateVersionBackupMutation();

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [labelInput, setLabelInput] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  function handleCreate() {
    setCreateError(null);
    createMutation.mutate(
      { gameId, label: labelInput.trim() || undefined },
      {
        onSuccess: () => {
          setShowCreateForm(false);
          setLabelInput("");
        },
        onError: (err) => setCreateError(msg(err, "Failed to create backup.")),
      },
    );
  }

  return (
    <div className={CARD}>
      <button
        type="button"
        className="w-full flex items-center justify-between gap-3 text-left"
        onClick={() => setIsOpen((v) => !v)}
        aria-expanded={isOpen}
      >
        <div>
          <p className={EYEBROW}>Version backups</p>
          <h3 className="m-0 font-semibold">Save snapshots</h3>
        </div>
        <span className="text-[#7dc9ff] text-lg shrink-0">
          {isOpen ? "▲" : "▼"}
        </span>
      </button>

      {isOpen && (
        <div className="mt-5 grid gap-4">
          {/* Create backup area */}
          {!showCreateForm ? (
            <button
              type="button"
              className={`${PRIMARY_BTN} self-start text-sm`}
              onClick={() => {
                setCreateError(null);
                setLabelInput("");
                setShowCreateForm(true);
              }}
            >
              + Create backup
            </button>
          ) : (
            <div className="rounded-2xl border border-[rgba(165,185,255,0.12)] bg-[rgba(9,14,28,0.75)] p-4 grid gap-3">
              <p className="m-0 text-sm font-medium text-[#c7d3f7]">
                New version backup
              </p>
              <div>
                <label
                  htmlFor="backup-label"
                  className="block text-xs text-[#9aa8c7] mb-1"
                >
                  Label <span className="italic">(optional)</span>
                </label>
                <input
                  id="backup-label"
                  className={`${INPUT_CLS} text-sm`}
                  placeholder="e.g. before final boss"
                  value={labelInput}
                  maxLength={80}
                  onChange={(e) => setLabelInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleCreate();
                    if (e.key === "Escape") setShowCreateForm(false);
                  }}
                  autoFocus
                />
              </div>
              {createError && (
                <p className="m-0 text-xs text-[#ff9e9e]">{createError}</p>
              )}
              <div className="flex gap-3">
                <button
                  type="button"
                  className={`${PRIMARY_BTN} flex-1 text-sm`}
                  onClick={handleCreate}
                  disabled={createMutation.isPending}
                >
                  {createMutation.isPending ? "Creating…" : "Create snapshot"}
                </button>
                <button
                  type="button"
                  className={`${GHOST_BTN} flex-1 text-sm`}
                  onClick={() => setShowCreateForm(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Backup list */}
          {isLoading && <p className={`${MUTED} text-sm`}>Loading backups…</p>}
          {isError && (
            <p className="text-sm text-[#ff9e9e]">
              {msg(error, "Failed to load backups.")}
            </p>
          )}
          {!isLoading && !isError && backups && (
            <>
              {backups.length === 0 ? (
                <p className={`${MUTED} text-sm`}>No version backups yet.</p>
              ) : (
                <ul className="list-none p-0 grid gap-2">
                  {backups.map((backup) => (
                    <BackupRow
                      key={backup.id}
                      backup={backup}
                      gameId={gameId}
                    />
                  ))}
                </ul>
              )}
              <button
                type="button"
                className={`${SECONDARY_BTN} self-start text-sm`}
                onClick={() => refetch()}
              >
                Refresh
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── BackupRow ─────────────────────────────────────────────────────────────────

interface BackupRowProps {
  backup: DriveVersionBackup;
  gameId: string;
}

function BackupRow({ backup, gameId }: BackupRowProps) {
  const [showRestoreModal, setShowRestoreModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  const restoreMutation = useRestoreVersionBackupMutation();
  const deleteMutation = useDeleteVersionBackupMutation();

  // Parse the name: ISO-8601-timestamp_optional-label
  const labelPart = useMemo(() => {
    if (backup.name.length) {
      const underscoreIdx = backup.name.indexOf("—");

      if (underscoreIdx !== -1 && underscoreIdx < backup.name.length - 1) {
        return {
          time: backup.name.slice(underscoreIdx + 1).replace(/-/g, " "),
          description: backup.name.slice(underscoreIdx + 2),
        };
      }
    }

    return null;
  }, [backup.name]);

  function handleRestoreConfirm() {
    setShowRestoreModal(false);
    restoreMutation.mutate({ gameId, backupFolderId: backup.id });
  }

  function handleDeleteConfirm() {
    setShowDeleteModal(false);
    deleteMutation.mutate({ gameId, backupFolderId: backup.id });
  }

  const isBusy = restoreMutation.isPending || deleteMutation.isPending;

  return (
    <li className="rounded-[14px] border border-[rgba(165,185,255,0.08)] bg-[rgba(9,14,28,0.75)] px-4 py-3">
      <div className="flex items-start gap-3">
        <span className="text-lg shrink-0 mt-0.5" aria-hidden="true">
          💾
        </span>

        <div className="flex-1 min-w-0">
          {/* Timestamp */}
          <p className="m-0 text-sm font-medium text-[#eef4ff] truncate">
            {new Date(backup.createdTime).toLocaleString()}
          </p>
          {/* Label */}
          {labelPart && (
            <p className="m-0 mt-0.5 text-xs text-[#9aa8c7] truncate italic">
              {labelPart.description}
            </p>
          )}
          {/* Stats */}
          <p className="m-0 mt-1 text-xs text-[#7a8baa]">
            {backup.totalFiles} {backup.totalFiles === 1 ? "file" : "files"} ·{" "}
            {formatBytes(backup.totalSize)}
          </p>

          {(restoreMutation.isError || deleteMutation.isError) && (
            <p className="m-0 mt-1 text-xs text-[#ff9e9e]">
              {msg(
                restoreMutation.error ?? deleteMutation.error,
                "Operation failed.",
              )}
            </p>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            title="Restore this backup"
            aria-label={`Restore backup from ${backup.createdTime}`}
            disabled={isBusy}
            className={`${SECONDARY_BTN} text-xs px-3 disabled:opacity-40`}
            onClick={() => setShowRestoreModal(true)}
          >
            {restoreMutation.isPending ? "Restoring…" : "Restore"}
          </button>
          <button
            type="button"
            title="Delete this backup"
            aria-label={`Delete backup from ${backup.createdTime}`}
            disabled={isBusy}
            className={`${DANGER_BTN} text-xs px-3 disabled:opacity-40`}
            onClick={() => setShowDeleteModal(true)}
          >
            {deleteMutation.isPending ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>

      {/* Restore confirm */}
      <ConfirmModal
        open={showRestoreModal}
        title="Restore this backup?"
        message={
          `This will overwrite your current save files — both on Google Drive and locally at your configured save path — with the files from this snapshot.\n\n` +
          `This action cannot be undone once completed. Make sure you have a recent backup of your current save if needed.`
        }
        confirmLabel="Restore"
        onConfirm={handleRestoreConfirm}
        onCancel={() => setShowRestoreModal(false)}
      />

      {/* Delete confirm */}
      <ConfirmModal
        open={showDeleteModal}
        title="Delete this backup?"
        message={`Permanently delete the snapshot from "${new Date(backup.createdTime).toLocaleString()}" from Google Drive? This cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={handleDeleteConfirm}
        onCancel={() => setShowDeleteModal(false)}
      />
    </li>
  );
}

// ── Utility ───────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

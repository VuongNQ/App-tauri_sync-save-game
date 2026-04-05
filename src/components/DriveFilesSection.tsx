import { useState } from "react";

import {
  useDeleteDriveFileMutation,
  useDriveFilesQuery,
  useMoveDriveFileMutation,
  useRenameDriveFileMutation,
} from "../queries";
import type { DriveFileItem } from "../types/dashboard";
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
  /** The game's Drive folder root ID. */
  gameFolderId: string;
}

const PROTECTED_NAMES = new Set([".sync-meta.json", "backups"]);

export function DriveFilesSection({ gameId, gameFolderId }: Props) {
  const [isOpen, setIsOpen] = useState(false);

  function handleToggle() {
    setIsOpen((v) => !v);
  }

  // Only fetch root items when the section is expanded.
  const { data: items, isLoading, isError, error, refetch } = useDriveFilesQuery(
    gameId,
    gameFolderId,
    isOpen,
  );

  return (
    <div className={CARD}>
      <button
        type="button"
        className="w-full flex items-center justify-between gap-3 text-left"
        onClick={handleToggle}
        aria-expanded={isOpen}
      >
        <div>
          <p className={EYEBROW}>Cloud files</p>
          <h3 className="m-0 font-semibold">Drive file manager</h3>
        </div>
        <span className="text-[#7dc9ff] text-lg shrink-0">{isOpen ? "▲" : "▼"}</span>
      </button>

      {isOpen && (
        <div className="mt-5">
          {isLoading && (
            <p className={`${MUTED} text-sm`}>Loading Drive files…</p>
          )}
          {isError && (
            <p className="text-sm text-[#ff9e9e]">{msg(error, "Failed to load Drive files.")}</p>
          )}
          {!isLoading && !isError && items && (
            <>
              {items.length === 0 ? (
                <p className={`${MUTED} text-sm`}>No files found in this folder.</p>
              ) : (
                <ul className="list-none p-0 grid gap-1.5">
                  {items.map((item) => (
                    <DriveTreeNode
                      key={item.id}
                      item={item}
                      gameId={gameId}
                      gameFolderId={gameFolderId}
                      depth={0}
                      siblingItems={items}
                    />
                  ))}
                </ul>
              )}
              <button
                type="button"
                className={`${SECONDARY_BTN} mt-3 text-sm`}
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

// ── DriveTreeNode ─────────────────────────────────────────────────────────────

interface TreeNodeProps {
  item: DriveFileItem;
  gameId: string;
  /** The game's Drive root folder ID — passed down for move validation. */
  gameFolderId: string;
  /** 0 = root child, 1 = inside a subfolder, etc. */
  depth: number;
  /** Sibling items at the same level — used by the move modal. */
  siblingItems: DriveFileItem[];
}

function DriveTreeNode({ item, gameId, gameFolderId, depth, siblingItems }: TreeNodeProps) {
  const isProtected = PROTECTED_NAMES.has(item.name);
  const isAtRoot = depth === 0;

  // ── Folder expand ─────────────────────────────────────
  const [isExpanded, setIsExpanded] = useState(false);

  // Always call the hook; enabled only when this is a folder and it's expanded.
  const { data: childItems, isLoading: childrenLoading } = useDriveFilesQuery(
    gameId,
    item.id,
    item.isFolder && isExpanded,
  );

  // ── Rename ────────────────────────────────────────────
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(item.name);
  const [renameError, setRenameError] = useState<string | null>(null);

  // ── Modals ────────────────────────────────────────────
  const [showMoveModal, setShowMoveModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  const renameMutation = useRenameDriveFileMutation();
  const moveMutation = useMoveDriveFileMutation();
  const deleteMutation = useDeleteDriveFileMutation();

  function startRename() {
    setRenameValue(item.name);
    setRenameError(null);
    setIsRenaming(true);
  }

  async function commitRename() {
    const trimmed = renameValue.trim();
    if (trimmed === item.name) {
      setIsRenaming(false);
      return;
    }
    if (!trimmed) {
      setRenameError("Name cannot be empty");
      return;
    }
    setRenameError(null);
    renameMutation.mutate(
      { gameId, fileId: item.id, oldName: item.name, newName: trimmed, isFolder: item.isFolder },
      {
        onSuccess: () => setIsRenaming(false),
        onError: (err) => setRenameError(msg(err, "Rename failed.")),
      },
    );
  }

  function handleDeleteConfirm() {
    setShowDeleteModal(false);
    deleteMutation.mutate({ gameId, fileId: item.id, fileName: item.name, isFolder: item.isFolder });
  }

  const isBusy = renameMutation.isPending || moveMutation.isPending || deleteMutation.isPending;
  const rowIndent = { paddingLeft: `${depth * 20}px` };

  return (
    <li className="grid gap-0">
      {/* ── Row ── */}
      <div
        className="flex items-center gap-3 px-3 py-2.5 rounded-[14px] bg-[rgba(9,14,28,0.75)] border border-[rgba(165,185,255,0.08)]"
        style={rowIndent}
      >
        {/* Expand toggle (folders) or spacer (files) */}
        {item.isFolder ? (
          <button
            type="button"
            className="shrink-0 w-5 h-5 flex items-center justify-center text-[10px] text-[#7dc9ff] hover:text-white transition-colors"
            aria-label={isExpanded ? "Collapse folder" : "Expand folder"}
            onClick={() => setIsExpanded((v) => !v)}
          >
            {isExpanded ? "▼" : "▶"}
          </button>
        ) : (
          <span className="shrink-0 w-5" aria-hidden="true" />
        )}

        {/* Icon */}
        <span className="text-lg shrink-0" aria-hidden="true">
          {item.isFolder ? "📁" : "📄"}
        </span>

        {/* Name / inline rename */}
        <div className="flex-1 min-w-0">
          {isRenaming ? (
            <div className="flex items-center gap-2">
              <input
                className={`${INPUT_CLS} text-sm py-1 min-h-0 h-8`}
                value={renameValue}
                autoFocus
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") setIsRenaming(false);
                }}
              />
              <button
                type="button"
                className={`${PRIMARY_BTN} text-xs px-3 min-h-0 h-8`}
                onClick={commitRename}
                disabled={renameMutation.isPending}
              >
                {renameMutation.isPending ? "…" : "Save"}
              </button>
              <button
                type="button"
                className={`${GHOST_BTN} text-xs px-3 min-h-0 h-8`}
                onClick={() => setIsRenaming(false)}
              >
                Cancel
              </button>
            </div>
          ) : (
            <span className="truncate text-sm text-[#c7d3f7] block">{item.name}</span>
          )}
          {renameError && (
            <p className="m-0 mt-0.5 text-xs text-[#ff9e9e]">{renameError}</p>
          )}
          {(moveMutation.isError || deleteMutation.isError) && (
            <p className="m-0 mt-0.5 text-xs text-[#ff9e9e]">
              {msg(moveMutation.error ?? deleteMutation.error, "Operation failed.")}
            </p>
          )}
        </div>

        {/* Metadata */}
        <div className="hidden sm:flex items-center gap-4 shrink-0 text-xs text-[#9aa8c7]">
          {!item.isFolder && item.size != null && (
            <span>{formatBytes(item.size)}</span>
          )}
          {item.modifiedTime && (
            <span>{new Date(item.modifiedTime).toLocaleString()}</span>
          )}
        </div>

        {/* Protected badge */}
        {isProtected && (
          <span className="shrink-0 text-xs px-2 py-0.5 rounded-xl bg-[rgba(255,196,91,0.14)] text-[#ffd98a]">
            protected
          </span>
        )}

        {/* Actions */}
        {!isProtected && !isRenaming && (
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              title="Rename"
              aria-label={`Rename ${item.name}`}
              disabled={isBusy}
              className="p-1.5 rounded-lg text-[#7dc9ff] hover:bg-[rgba(125,201,255,0.1)] transition-colors disabled:opacity-40"
              onClick={startRename}
            >
              ✏️
            </button>
            {!item.isFolder && isAtRoot && (
              <button
                type="button"
                title="Move to subfolder"
                aria-label={`Move ${item.name}`}
                disabled={isBusy}
                className="p-1.5 rounded-lg text-[#7dc9ff] hover:bg-[rgba(125,201,255,0.1)] transition-colors disabled:opacity-40"
                onClick={() => setShowMoveModal(true)}
              >
                📂
              </button>
            )}
            <button
              type="button"
              title="Delete from Drive"
              aria-label={`Delete ${item.name}`}
              disabled={isBusy || deleteMutation.isPending}
              className="p-1.5 rounded-lg text-[#ff9e9e] hover:bg-[rgba(255,100,100,0.1)] transition-colors disabled:opacity-40"
              onClick={() => setShowDeleteModal(true)}
            >
              🗑️
            </button>
          </div>
        )}

        {/* Move modal — only at root depth */}
        {showMoveModal && isAtRoot && (
          <MoveFileModal
            item={item}
            gameId={gameId}
            gameFolderId={gameFolderId}
            subfolders={siblingItems.filter(
              (f) => f.isFolder && !PROTECTED_NAMES.has(f.name),
            )}
            onMove={(newParentId) => {
              setShowMoveModal(false);
              moveMutation.mutate({
                gameId,
                fileId: item.id,
                fileName: item.name,
                newParentId,
                oldParentId: gameFolderId,
              });
            }}
            onCancel={() => setShowMoveModal(false)}
          />
        )}

        {/* Delete confirm */}
        <ConfirmModal
          open={showDeleteModal}
          title={`Delete "${item.name}"?`}
          message={
            item.isFolder
              ? `Delete the folder "${item.name}" and all its contents from Google Drive? This cannot be undone.`
              : `Delete "${item.name}" from Google Drive? The file will no longer be synced and cannot be recovered.`
          }
          confirmLabel="Delete"
          onConfirm={handleDeleteConfirm}
          onCancel={() => setShowDeleteModal(false)}
        />
      </div>

      {/* ── Children (rendered inside parent li when folder is expanded) ── */}
      {item.isFolder && isExpanded && (
        <div className="mt-1.5">
          {childrenLoading ? (
            <p className={`${MUTED} text-xs`} style={{ paddingLeft: `${(depth + 1) * 20 + 28}px` }}>
              Loading…
            </p>
          ) : childItems && childItems.length > 0 ? (
            <ul className="list-none p-0 grid gap-1.5">
              {childItems.map((child) => (
                <DriveTreeNode
                  key={child.id}
                  item={child}
                  gameId={gameId}
                  gameFolderId={gameFolderId}
                  depth={depth + 1}
                  siblingItems={childItems}
                />
              ))}
            </ul>
          ) : (
            <p
              className={`${MUTED} text-xs`}
              style={{ paddingLeft: `${(depth + 1) * 20 + 28}px` }}
            >
              Empty folder
            </p>
          )}
        </div>
      )}
    </li>
  );
}

// ── MoveFileModal ─────────────────────────────────────────────────────────────

interface MoveModalProps {
  item: DriveFileItem;
  gameId: string;
  gameFolderId: string;
  subfolders: DriveFileItem[];
  onMove: (newParentId: string) => void;
  onCancel: () => void;
}

function MoveFileModal({
  item,
  gameFolderId,
  subfolders,
  onMove,
  onCancel,
}: MoveModalProps) {
  const [selected, setSelected] = useState(gameFolderId);

  return (
    <dialog
      open
      className="m-auto max-w-105 w-full rounded-3xl border border-[rgba(165,185,255,0.12)] bg-[rgba(14,22,40,0.97)] p-6 text-[#eef4ff] shadow-[0_32px_80px_rgba(0,0,0,0.5)] backdrop:bg-[rgba(0,0,0,0.55)]"
    >
      <h3 className="m-0 mb-2 text-lg font-semibold">Move "{item.name}"</h3>
      <p className="m-0 mb-4 text-sm text-[#9aa8c7]">
        Choose a destination folder within this game's Drive folder.
      </p>

      <div className="grid gap-2 mb-5">
        {/* Root option */}
        <label className="flex items-center gap-3 cursor-pointer p-3 rounded-xl border border-[rgba(165,185,255,0.10)] hover:bg-[rgba(125,201,255,0.06)] transition-colors">
          <input
            type="radio"
            name="move-target"
            value={gameFolderId}
            checked={selected === gameFolderId}
            onChange={() => setSelected(gameFolderId)}
            className="accent-[#7dc9ff]"
          />
          <span className="text-sm text-[#c7d3f7]">📁 / (game root)</span>
        </label>

        {subfolders.map((folder) => (
          <label
            key={folder.id}
            className="flex items-center gap-3 cursor-pointer p-3 rounded-xl border border-[rgba(165,185,255,0.10)] hover:bg-[rgba(125,201,255,0.06)] transition-colors"
          >
            <input
              type="radio"
              name="move-target"
              value={folder.id}
              checked={selected === folder.id}
              onChange={() => setSelected(folder.id)}
              className="accent-[#7dc9ff]"
            />
            <span className="text-sm text-[#c7d3f7]">📁 {folder.name}</span>
          </label>
        ))}

        {subfolders.length === 0 && (
          <p className="text-sm text-[#9aa8c7]">
            No subfolders available. Only the game root folder is listed.
          </p>
        )}
      </div>

      <p className="m-0 mb-4 text-xs text-[#ffd98a]">
        ⚠ Files moved out of the root folder will no longer be tracked by the sync algorithm. A
        manual "Sync to Google Drive" will re-upload the local version to the root on next sync.
      </p>

      <div className="flex items-center gap-3">
        <button type="button" className={`${GHOST_BTN} flex-1`} onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className={`${DANGER_BTN} flex-1`}
          onClick={() => onMove(selected)}
        >
          Move
        </button>
      </div>
    </dialog>
  );
}

// ── Utility ───────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

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
  /** Pass the game's Drive folder root ID so the Move modal can validate targets. */
  gameFolderId: string;
}

// A single entry in the folder-navigation breadcrumb stack.
interface NavEntry {
  id: string;
  name: string;
}

export function DriveFilesSection({ gameId, gameFolderId }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [navStack, setNavStack] = useState<NavEntry[]>([{ id: gameFolderId, name: "/" }]);

  const currentFolder = navStack[navStack.length - 1];
  const isAtRoot = navStack.length === 1;

  function handleToggle() {
    if (isOpen) {
      // Reset navigation when collapsing.
      setNavStack([{ id: gameFolderId, name: "/" }]);
    }
    setIsOpen((v) => !v);
  }

  // Only fetch when the section is expanded.
  const { data: items, isLoading, isError, error, refetch } = useDriveFilesQuery(
    gameId,
    currentFolder.id,
    isOpen,
  );

  // console.log("[DriveFilesSection] gameId:", gameId, "folder:", currentFolder, "items:", items);

  function navigateInto(folder: DriveFileItem) {
    if (PROTECTED_NAMES.has(folder.name)) return;
    setNavStack((prev) => [...prev, { id: folder.id, name: folder.name }]);
  }

  function navigateTo(index: number) {
    setNavStack((prev) => prev.slice(0, index + 1));
  }

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
          {/* Breadcrumb navigation */}
          <nav
            aria-label="Folder navigation"
            className="flex items-center gap-1 mb-3 text-sm flex-wrap min-h-7"
          >
            {navStack.map((entry, index) => (
              <span key={entry.id} className="flex items-center gap-1">
                {index > 0 && (
                  <span className="text-[#4a5568] select-none mx-0.5">/</span>
                )}
                {index < navStack.length - 1 ? (
                  <button
                    type="button"
                    className="text-[#7dc9ff] hover:underline"
                    onClick={() => navigateTo(index)}
                  >
                    {entry.name}
                  </button>
                ) : (
                  <span className="text-[#c7d3f7] font-medium">{entry.name}</span>
                )}
              </span>
            ))}
          </nav>

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
                <ul className="list-none p-0 grid gap-2">
                  {items.map((item) => {
                    const fullPath =
                      navStack.map((e) => e.name).join(" / ") + " / " + item.name;
                    return (
                      <DriveFileRow
                        key={item.id}
                        item={item}
                        gameId={gameId}
                        gameFolderId={gameFolderId}
                        allItems={items}
                        currentFolderId={currentFolder.id}
                        isAtRoot={isAtRoot}
                        fullPath={fullPath}
                        onNavigate={navigateInto}
                      />
                    );
                  })}
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

// ── DriveFileRow ──────────────────────────────────────────────────────────────

interface RowProps {
  item: DriveFileItem;
  gameId: string;
  gameFolderId: string;
  allItems: DriveFileItem[];
  currentFolderId: string;
  isAtRoot: boolean;
  /** Full path string for this item, e.g. "/ backups / save.zip" */
  fullPath: string;
  onNavigate: (folder: DriveFileItem) => void;
}

const PROTECTED_NAMES = new Set([".sync-meta.json", "backups"]);

function DriveFileRow({
  item,
  gameId,
  gameFolderId,
  allItems,
  currentFolderId,
  isAtRoot,
  fullPath,
  onNavigate,
}: RowProps) {
  const isProtected = PROTECTED_NAMES.has(item.name);

  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(item.name);
  const [renameError, setRenameError] = useState<string | null>(null);

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

  const isBusy =
    renameMutation.isPending || moveMutation.isPending || deleteMutation.isPending;

  return (
    <li className="flex items-center gap-3 px-3 py-2.5 rounded-[14px] bg-[rgba(9,14,28,0.75)] border border-[rgba(165,185,255,0.08)]">
      {/* Icon — clicking a non-protected folder navigates into it */}
      <span
        className={`text-lg shrink-0 ${
          item.isFolder && !isProtected ? "cursor-pointer" : ""
        }`}
        aria-hidden="true"
        onClick={() => item.isFolder && !isProtected && onNavigate(item)}
      >
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
        ) : item.isFolder && !isProtected ? (
          <button
            type="button"
            className="truncate text-sm text-[#7dc9ff] hover:underline text-left"
            onClick={() => onNavigate(item)}
          >
            {item.name}
          </button>
        ) : (
          <span className="truncate text-sm text-[#c7d3f7]">{item.name}</span>
        )}
        {!isRenaming && (
          <p className="m-0 mt-0.5 text-xs text-[#4a5568] truncate" title={fullPath}>
            {fullPath}
          </p>
        )}
        {renameError && (
          <p className="m-0 mt-0.5 text-xs text-[#ff9e9e]">{renameError}</p>
        )}
        {(moveMutation.isError || deleteMutation.isError) && (
          <p className="m-0 mt-0.5 text-xs text-[#ff9e9e]">
            {msg(
              moveMutation.error ?? deleteMutation.error,
              "Operation failed.",
            )}
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

      {/* Move modal — only shown when at root level */}
      {showMoveModal && isAtRoot && (
        <MoveFileModal
          item={item}
          gameId={gameId}
          gameFolderId={gameFolderId}
          subfolders={allItems.filter(
            (f) => f.isFolder && !PROTECTED_NAMES.has(f.name),
          )}
          onMove={(newParentId) => {
            setShowMoveModal(false);
            moveMutation.mutate({
              gameId,
              fileId: item.id,
              fileName: item.name,
              newParentId,
              oldParentId: currentFolderId,
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

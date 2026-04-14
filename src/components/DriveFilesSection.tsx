import { useMemo, useState } from "react";

import { useDeleteDriveFileMutation, useDriveFilesFlatQuery, useMoveDriveFileMutation, useRenameDriveFileMutation } from "../queries";
import type { DriveFileFlatItem } from "../types/dashboard";
import { msg } from "../utils";
import { ConfirmModal } from "./ConfirmModal";
import { CARD, EYEBROW, GHOST_BTN, INPUT_CLS, MUTED, PRIMARY_BTN, SECONDARY_BTN } from "./styles";

interface Props {
  gameId: string;
  /** The game's Drive folder root ID. */
  gameFolderId: string;
}

const PROTECTED_PATHS = new Set([".sync-meta.json", "backups"]);

function isProtected(relativePath: string): boolean {
  return PROTECTED_PATHS.has(relativePath) || relativePath.startsWith("backups/");
}

export function DriveFilesSection({ gameId, gameFolderId }: Props) {
  const [isOpen, setIsOpen] = useState(false);

  const { data: flatItems, isLoading, isError, error, refetch } = useDriveFilesFlatQuery(gameId, isOpen);

  const tree = useMemo(() => (flatItems ? buildDriveTree(flatItems) : null), [flatItems]);

  // Top-level subfolders available for file move operations.
  const topSubfolders = useMemo(
    () => flatItems?.filter((item) => item.isFolder && !item.relativePath.includes("/") && !PROTECTED_PATHS.has(item.relativePath)) ?? [],
    [flatItems]
  );

  return (
    <div className={CARD}>
      <button
        type="button"
        className="w-full flex items-center justify-between gap-3 text-left"
        onClick={() => setIsOpen((v) => !v)}
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
          {isLoading && <p className={`${MUTED} text-sm`}>Loading Drive files…</p>}
          {isError && <p className="text-sm text-[#ff9e9e]">{msg(error, "Failed to load Drive files.")}</p>}
          {!isLoading && !isError && tree && (
            <>
              {tree.length === 0 ? (
                <p className={`${MUTED} text-sm`}>No files found in this folder.</p>
              ) : (
                <ul className="list-none p-0 rounded-[14px] bg-[rgba(255,255,255,0.02)] border border-[rgba(165,185,255,0.06)] overflow-hidden">
                  {tree.map((node, i) => (
                    <DriveTreeNode
                      key={i}
                      node={node}
                      depth={0}
                      gameId={gameId}
                      gameFolderId={gameFolderId}
                      topSubfolders={topSubfolders}
                    />
                  ))}
                </ul>
              )}
              <button type="button" className={`${SECONDARY_BTN} mt-3 text-sm`} onClick={() => refetch()}>
                Refresh
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Tree types ─────────────────────────────────────────────────────────────────

type DriveTreeLeaf = {
  kind: "file";
  name: string;
  relativePath: string;
  syncPath: string | null;
  size: number | null;
  modifiedTime: string | null;
  id: string;
  parentFolderId: string;
};

type DriveTreeDir = {
  kind: "folder";
  name: string;
  relativePath: string;
  children: DriveTreeItem[];
  totalSize: number;
  /** Drive folder ID; null when the folder node was inferred (not explicit in flat list). */
  id: string | null;
  parentFolderId: string | null;
};

type DriveTreeItem = DriveTreeLeaf | DriveTreeDir;

// ── Tree builder ───────────────────────────────────────────────────────────────

function buildDriveTree(items: DriveFileFlatItem[]): DriveTreeItem[] {
  // Build a lookup map from relative path → folder item for ID resolution.
  const folderIdMap = new Map<string, DriveFileFlatItem>();
  for (const item of items) {
    if (item.isFolder) folderIdMap.set(item.relativePath, item);
  }

  function insertFile(nodes: DriveTreeItem[], parts: string[], item: DriveFileFlatItem, pathPrefix: string): void {
    if (parts.length === 1) {
      nodes.push({
        kind: "file",
        name: parts[0],
        relativePath: item.relativePath,
        syncPath: item.syncPath ?? null,
        size: item.size,
        modifiedTime: item.modifiedTime,
        id: item.id,
        parentFolderId: item.parentFolderId,
      });
      return;
    }
    const dirName = parts[0];
    const dirPath = pathPrefix ? `${pathPrefix}/${dirName}` : dirName;
    let dir = nodes.find((n): n is DriveTreeDir => n.kind === "folder" && n.name === dirName);
    if (!dir) {
      const folderItem = folderIdMap.get(dirPath);
      dir = {
        kind: "folder",
        name: dirName,
        relativePath: dirPath,
        children: [],
        totalSize: 0,
        id: folderItem?.id ?? null,
        parentFolderId: folderItem?.parentFolderId ?? null,
      };
      nodes.push(dir);
    }
    dir.totalSize += item.size ?? 0;
    insertFile(dir.children, parts.slice(1), item, dirPath);
  }

  const roots: DriveTreeItem[] = [];

  // First pass: insert all files to build folder hierarchy and sizes.
  for (const item of items) {
    if (!item.isFolder) {
      const parts = item.relativePath.split("/").filter(Boolean);
      insertFile(roots, parts, item, "");
    }
  }

  // Second pass: ensure top-level empty folders are present.
  for (const item of items) {
    if (item.isFolder && !item.relativePath.includes("/")) {
      if (!roots.find((n) => n.kind === "folder" && n.name === item.name)) {
        roots.push({
          kind: "folder",
          name: item.name,
          relativePath: item.relativePath,
          children: [],
          totalSize: 0,
          id: item.id,
          parentFolderId: item.parentFolderId,
        });
      }
    }
  }

  return roots;
}

// ── Formatters ─────────────────────────────────────────────────────────────────

function formatDriveBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// ── DriveTreeNode ──────────────────────────────────────────────────────────────

interface TreeNodeProps {
  node: DriveTreeItem;
  depth: number;
  gameId: string;
  gameFolderId: string;
  topSubfolders: DriveFileFlatItem[];
}

function DriveTreeNode({ node, depth, gameId, gameFolderId, topSubfolders }: TreeNodeProps) {
  const indent = depth * 14;
  const protected_ = isProtected(node.relativePath);

  const [isExpanded, setIsExpanded] = useState(true);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(node.name);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [showMoveModal, setShowMoveModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  const renameMutation = useRenameDriveFileMutation();
  const moveMutation = useMoveDriveFileMutation();
  const deleteMutation = useDeleteDriveFileMutation();

  const isBusy = renameMutation.isPending || moveMutation.isPending || deleteMutation.isPending;
  const isAtRoot = depth === 0;

  function startRename() {
    setRenameValue(node.name);
    setRenameError(null);
    setIsRenaming(true);
  }

  function commitRename() {
    const trimmed = renameValue.trim();
    if (trimmed === node.name) {
      setIsRenaming(false);
      return;
    }
    if (!trimmed) {
      setRenameError("Name cannot be empty");
      return;
    }
    const fileId = node.kind === "folder" ? (node.id ?? "") : node.id;
    if (!fileId) return;
    setRenameError(null);
    renameMutation.mutate(
      { gameId, fileId, oldName: node.name, newName: trimmed, isFolder: node.kind === "folder" },
      {
        onSuccess: () => setIsRenaming(false),
        onError: (err) => setRenameError(msg(err, "Rename failed.")),
      }
    );
  }

  function handleDeleteConfirm() {
    setShowDeleteModal(false);
    const fileId = node.kind === "folder" ? (node.id ?? "") : node.id;
    if (!fileId) return;
    deleteMutation.mutate({
      gameId,
      fileId,
      fileName: node.name,
      isFolder: node.kind === "folder",
    });
  }

  const rowBase = "flex items-center gap-2 text-xs py-1.5 pr-3 border-b border-[rgba(165,185,255,0.04)] last:border-b-0";

  if (node.kind === "folder") {
    return (
      <>
        <li className={`${rowBase} select-none`} style={{ paddingLeft: `${8 + indent}px` }}>
          {/* Expand toggle + name */}
          <div className="flex items-center gap-1.5 min-w-0 flex-1 cursor-pointer" onClick={() => setIsExpanded((v) => !v)}>
            <span className="shrink-0 w-3 text-center text-[0.56rem] text-[#9aa8c7]">{isExpanded ? "▼" : "►"}</span>
            {isRenaming ? (
              <div className="flex items-center gap-1.5 flex-1" onClick={(e) => e.stopPropagation()}>
                <input
                  className={`${INPUT_CLS} text-xs py-0.5 min-h-0 h-7`}
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
                  className={`${PRIMARY_BTN} text-xs px-2 min-h-0 h-7`}
                  onClick={commitRename}
                  disabled={renameMutation.isPending}
                >
                  {renameMutation.isPending ? "…" : "Save"}
                </button>
                <button type="button" className={`${GHOST_BTN} text-xs px-2 min-h-0 h-7`} onClick={() => setIsRenaming(false)}>
                  Cancel
                </button>
              </div>
            ) : (
              <span className="text-[#7dc9ff] font-medium truncate">{node.name}/</span>
            )}
          </div>

          {/* Size + protected badge + actions */}
          <div className="flex items-center gap-2 shrink-0">
            {node.totalSize > 0 && (
              <span className="text-[0.68rem] text-[#9aa8c7] bg-white/5 px-1.5 py-0.5 rounded-full">
                {formatDriveBytes(node.totalSize)}
              </span>
            )}
            {protected_ ? (
              <span className="text-[0.68rem] px-2 py-0.5 rounded-xl bg-[rgba(255,196,91,0.14)] text-[#ffd98a]">protected</span>
            ) : (
              !isRenaming && (
                <div className="flex items-center">
                  <button
                    type="button"
                    title="Rename"
                    disabled={isBusy}
                    className="p-1 rounded-lg text-[#7dc9ff] hover:bg-[rgba(125,201,255,0.1)] transition-colors disabled:opacity-40"
                    onClick={(e) => {
                      e.stopPropagation();
                      startRename();
                    }}
                  >
                    ✏️
                  </button>
                  <button
                    type="button"
                    title="Delete from Drive"
                    disabled={isBusy}
                    className="p-1 rounded-lg text-[#ff9e9e] hover:bg-[rgba(255,100,100,0.1)] transition-colors disabled:opacity-40"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowDeleteModal(true);
                    }}
                  >
                    🗑️
                  </button>
                </div>
              )
            )}
          </div>

          <ConfirmModal
            open={showDeleteModal}
            title={`Delete "${node.name}"?`}
            message={`Delete the folder "${node.name}" and all its contents from Google Drive? This cannot be undone.`}
            confirmLabel="Delete"
            onConfirm={handleDeleteConfirm}
            onCancel={() => setShowDeleteModal(false)}
          />
        </li>

        {renameError && (
          <li style={{ paddingLeft: `${8 + indent + 20}px` }} className="pb-1">
            <p className="m-0 text-xs text-[#ff9e9e]">{renameError}</p>
          </li>
        )}
        {(moveMutation.isError || deleteMutation.isError) && (
          <li style={{ paddingLeft: `${8 + indent + 20}px` }} className="pb-1">
            <p className="m-0 text-xs text-[#ff9e9e]">{msg(moveMutation.error ?? deleteMutation.error, "Operation failed.")}</p>
          </li>
        )}

        {isExpanded &&
          node.children.map((child, i) => (
            <DriveTreeNode
              key={i}
              node={child}
              depth={depth + 1}
              gameId={gameId}
              gameFolderId={gameFolderId}
              topSubfolders={topSubfolders}
            />
          ))}
      </>
    );
  }

  // ── File leaf ───────────────────────────────────────────────────────────────

  return (
    <>
      <li className={`${rowBase} hover:bg-white/2`} style={{ paddingLeft: `${8 + indent}px` }}>
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <span className="text-[#9aa8c7] shrink-0 select-none">↳</span>
          {isRenaming ? (
            <div className="flex items-center gap-1.5 flex-1">
              <input
                className={`${INPUT_CLS} text-xs py-0.5 min-h-0 h-7`}
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
                className={`${PRIMARY_BTN} text-xs px-2 min-h-0 h-7`}
                onClick={commitRename}
                disabled={renameMutation.isPending}
              >
                {renameMutation.isPending ? "…" : "Save"}
              </button>
              <button type="button" className={`${GHOST_BTN} text-xs px-2 min-h-0 h-7`} onClick={() => setIsRenaming(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <span className="min-w-0">
              <span className="text-[#c7d3f7] truncate block">{node.name}</span>
              {(node.syncPath ?? node.relativePath) !== node.name && (
                <span className="text-[0.65rem] text-[#9aa8c7]/60 truncate block" title={node.syncPath ?? node.relativePath}>
                  {node.syncPath ?? node.relativePath}
                </span>
              )}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {node.size != null && <span className="text-[0.68rem] text-[#9aa8c7]">{formatDriveBytes(node.size)}</span>}
          {node.modifiedTime && (
            <span className="hidden sm:block text-[0.66rem] text-[#9aa8c7]">{new Date(node.modifiedTime).toLocaleString()}</span>
          )}
          {protected_ ? (
            <span className="text-[0.68rem] px-2 py-0.5 rounded-xl bg-[rgba(255,196,91,0.14)] text-[#ffd98a]">protected</span>
          ) : (
            !isRenaming && (
              <div className="flex items-center">
                <button
                  type="button"
                  title="Rename"
                  disabled={isBusy}
                  className="p-1 rounded-lg text-[#7dc9ff] hover:bg-[rgba(125,201,255,0.1)] transition-colors disabled:opacity-40"
                  onClick={startRename}
                >
                  ✏️
                </button>
                {isAtRoot && (
                  <button
                    type="button"
                    title="Move to subfolder"
                    disabled={isBusy}
                    className="p-1 rounded-lg text-[#7dc9ff] hover:bg-[rgba(125,201,255,0.1)] transition-colors disabled:opacity-40"
                    onClick={() => setShowMoveModal(true)}
                  >
                    📂
                  </button>
                )}
                <button
                  type="button"
                  title="Delete from Drive"
                  disabled={isBusy}
                  className="p-1 rounded-lg text-[#ff9e9e] hover:bg-[rgba(255,100,100,0.1)] transition-colors disabled:opacity-40"
                  onClick={() => setShowDeleteModal(true)}
                >
                  🗑️
                </button>
              </div>
            )
          )}
        </div>

        {showMoveModal && isAtRoot && (
          <MoveFileModal
            fileName={node.name}
            gameId={gameId}
            gameFolderId={gameFolderId}
            subfolders={topSubfolders}
            onMove={(newParentId) => {
              setShowMoveModal(false);
              moveMutation.mutate({
                gameId,
                fileId: node.id,
                fileName: node.name,
                newParentId,
                oldParentId: node.parentFolderId,
              });
            }}
            onCancel={() => setShowMoveModal(false)}
          />
        )}

        <ConfirmModal
          open={showDeleteModal}
          title={`Delete "${node.name}"?`}
          message={`Delete "${node.name}" from Google Drive? The file will no longer be synced and cannot be recovered.`}
          confirmLabel="Delete"
          onConfirm={handleDeleteConfirm}
          onCancel={() => setShowDeleteModal(false)}
        />
      </li>

      {renameError && (
        <li style={{ paddingLeft: `${8 + indent + 20}px` }} className="pb-1">
          <p className="m-0 text-xs text-[#ff9e9e]">{renameError}</p>
        </li>
      )}
      {(moveMutation.isError || deleteMutation.isError) && (
        <li style={{ paddingLeft: `${8 + indent + 20}px` }} className="pb-1">
          <p className="m-0 text-xs text-[#ff9e9e]">{msg(moveMutation.error ?? deleteMutation.error, "Operation failed.")}</p>
        </li>
      )}
    </>
  );
}

// ── MoveFileModal ──────────────────────────────────────────────────────────────

interface MoveModalProps {
  fileName: string;
  gameId: string;
  gameFolderId: string;
  subfolders: DriveFileFlatItem[];
  onMove: (newParentId: string) => void;
  onCancel: () => void;
}

function MoveFileModal({ fileName, gameFolderId, subfolders, onMove, onCancel }: MoveModalProps) {
  const [selected, setSelected] = useState(gameFolderId);

  return (
    <dialog
      open
      className="m-auto max-w-105 w-full rounded-3xl border border-[rgba(165,185,255,0.12)] bg-[rgba(14,22,40,0.97)] p-6 text-[#eef4ff] shadow-[0_32px_80px_rgba(0,0,0,0.5)] backdrop:bg-[rgba(0,0,0,0.55)]"
    >
      <h3 className="m-0 mb-2 text-lg font-semibold">Move "{fileName}"</h3>
      <p className="m-0 mb-4 text-sm text-[#9aa8c7]">Choose a destination folder within this game's Drive folder.</p>
      <ul className="list-none p-0 grid gap-2 mb-5">
        <li>
          <label className="flex items-center gap-3 p-3 rounded-xl cursor-pointer hover:bg-white/5">
            <input
              type="radio"
              name="move-target"
              value={gameFolderId}
              checked={selected === gameFolderId}
              onChange={() => setSelected(gameFolderId)}
              className="accent-[#6d7dff]"
            />
            <span className="text-sm text-[#c7d3f7]">📁 Game root</span>
          </label>
        </li>
        {subfolders.map((folder) => (
          <li key={folder.id}>
            <label className="flex items-center gap-3 p-3 rounded-xl cursor-pointer hover:bg-white/5">
              <input
                type="radio"
                name="move-target"
                value={folder.id}
                checked={selected === folder.id}
                onChange={() => setSelected(folder.id)}
                className="accent-[#6d7dff]"
              />
              <span className="text-sm text-[#c7d3f7]">📁 {folder.name}/</span>
            </label>
          </li>
        ))}
      </ul>
      <p className="m-0 mb-5 text-xs text-[#9aa8c7]">
        ⚠️ Files moved out of the game root are removed from sync metadata and will be re-uploaded on next sync.
      </p>
      <div className="flex gap-3 justify-end">
        <button type="button" className={`${SECONDARY_BTN} text-sm`} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className={`${PRIMARY_BTN} text-sm`} onClick={() => onMove(selected)}>
          Move here
        </button>
      </div>
    </dialog>
  );
}

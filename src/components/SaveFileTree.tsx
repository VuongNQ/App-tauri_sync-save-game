import { useState } from "react";
import type { SaveFileInfo, SaveInfo } from "../types/dashboard";

// ── Types ─────────────────────────────────────────────────

export type SaveTreeLeaf = {
  kind: "file";
  name: string;
  relativePath: string;
  size: number;
};

export type SaveTreeDir = {
  kind: "folder";
  name: string;
  /** Relative path prefix for this folder (forward-slash, no trailing slash). */
  relativePath: string;
  children: SaveTreeItem[];
  totalSize: number;
};

export type SaveTreeItem = SaveTreeLeaf | SaveTreeDir;

// ── Helpers ───────────────────────────────────────────────

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function buildSaveTree(files: SaveFileInfo[]): SaveTreeItem[] {
  function insert(
    nodes: SaveTreeItem[],
    parts: string[],
    file: SaveFileInfo,
    parentPath: string,
  ): void {
    if (parts.length === 1) {
      nodes.push({
        kind: "file",
        name: parts[0],
        relativePath: file.relativePath.replace(/\\/g, "/"),
        size: file.size,
      });
      return;
    }
    const dirName = parts[0];
    const dirPath = parentPath ? `${parentPath}/${dirName}` : dirName;
    let dir = nodes.find(
      (n): n is SaveTreeDir => n.kind === "folder" && n.name === dirName,
    );
    if (!dir) {
      dir = {
        kind: "folder",
        name: dirName,
        relativePath: dirPath,
        children: [],
        totalSize: 0,
      };
      nodes.push(dir);
    }
    dir.totalSize += file.size;
    insert(dir.children, parts.slice(1), file, dirPath);
  }

  const roots: SaveTreeItem[] = [];
  for (const file of files) {
    const parts = file.relativePath
      .replace(/\\/g, "/")
      .split("/")
      .filter(Boolean);
    insert(roots, parts, file, "");
  }
  return roots;
}

/** Check whether a relative path is excluded (same logic as Rust is_excluded). */
function isExcluded(relPath: string, excluded: string[]): boolean {
  for (const ex of excluded) {
    if (ex.endsWith("/")) {
      if (relPath.startsWith(ex)) return true;
    } else {
      if (relPath === ex || relPath.startsWith(`${ex}/`)) return true;
    }
  }
  return false;
}

// ── SaveTreeNode ──────────────────────────────────────────

interface SaveTreeNodeProps {
  node: SaveTreeItem;
  depth: number;
  checkable: boolean;
  excluded: string[];
  onToggle: (path: string, isFolder: boolean) => void;
  parentExcluded: boolean;
}

function SaveTreeNode({
  node,
  depth,
  checkable,
  excluded,
  onToggle,
  parentExcluded,
}: SaveTreeNodeProps) {
  const [open, setOpen] = useState(false);
  const indent = depth * 14;

  if (node.kind === "file") {
    const checked = checkable && isExcluded(node.relativePath, excluded);
    const dimmed = parentExcluded && !checked;

    return (
      <li
        className={`flex items-center justify-between gap-2 text-xs py-1.25 pr-2 rounded-lg hover:bg-white/4 ${dimmed ? "opacity-40" : ""}`}
        style={{ paddingLeft: `${6 + indent}px` }}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          {checkable && (
            <input
              type="checkbox"
              className="shrink-0 accent-[#7dc9ff] cursor-pointer"
              checked={checked}
              onChange={() => onToggle(node.relativePath, false)}
              title={checked ? "Unexclude from sync" : "Exclude from sync"}
            />
          )}
          {!checkable && (
            <span className="text-[#9aa8c7] shrink-0 select-none">↳</span>
          )}
          <span className="text-[#c7d3f7] truncate block">{node.name}</span>
        </div>
        <span className="shrink-0 text-[0.72rem] text-[#9aa8c7] bg-white/6 px-1.75 py-0.5 rounded-full whitespace-nowrap">
          {formatBytes(node.size)}
        </span>
      </li>
    );
  }

  // Folder
  const folderExcludePath = node.relativePath + "/";
  const checked = checkable && isExcluded(folderExcludePath, excluded);
  const dimmed = parentExcluded && !checked;

  return (
    <>
      <li
        className={`flex items-center justify-between gap-2 text-xs py-1.25 pr-2 rounded-lg select-none ${dimmed ? "opacity-40" : ""} ${checkable ? "" : "cursor-pointer hover:bg-white/6"}`}
        style={{ paddingLeft: `${6 + indent}px` }}
        onClick={checkable ? undefined : () => setOpen((o) => !o)}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          {checkable ? (
            <>
              <input
                type="checkbox"
                className="shrink-0 accent-[#7dc9ff] cursor-pointer"
                checked={checked}
                onChange={() => onToggle(folderExcludePath, true)}
                title={checked ? "Unexclude folder from sync" : "Exclude entire folder from sync"}
              />
              <span
                className="text-[#9aa8c7] shrink-0 w-3 text-center text-[0.6rem] cursor-pointer"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen((o) => !o);
                }}
              >
                {open ? "▼" : "►"}
              </span>
            </>
          ) : (
            <span className="text-[#9aa8c7] shrink-0 w-3 text-center text-[0.6rem]">
              {open ? "▼" : "►"}
            </span>
          )}
          <span className="text-[#7dc9ff] font-medium truncate">
            {node.name}/
          </span>
        </div>
        <span className="shrink-0 text-[0.72rem] text-[#9aa8c7] bg-white/6 px-1.75 py-0.5 rounded-full whitespace-nowrap">
          {formatBytes(node.totalSize)}
        </span>
      </li>
      {open &&
        node.children.map((child, i) => (
          <SaveTreeNode
            key={i}
            node={child}
            depth={depth + 1}
            checkable={checkable}
            excluded={excluded}
            onToggle={onToggle}
            parentExcluded={parentExcluded || checked}
          />
        ))}
    </>
  );
}

// ── SaveFileTree ──────────────────────────────────────────

interface SaveFileTreeProps {
  info: SaveInfo;
  /** When true, renders checkboxes for exclude-from-sync selection. */
  checkable?: boolean;
  /** Currently excluded relative paths (only relevant when checkable=true). */
  excluded?: string[];
  /** Called when a file or folder checkbox is toggled. */
  onToggle?: (path: string, isFolder: boolean) => void;
}

export function SaveFileTree({
  info,
  checkable = false,
  excluded = [],
  onToggle = () => {},
}: SaveFileTreeProps) {
  const [open, setOpen] = useState(false);
  const tree = buildSaveTree(info.files);

  return (
    <ul className="mt-3 list-none p-0 text-xs rounded-[14px] bg-[rgba(255,255,255,0.02)] border border-[rgba(165,185,255,0.06)] overflow-hidden">
      {/* Root save-path row */}
      <li
        className="flex items-center justify-between gap-2 px-2 py-1.75 cursor-pointer hover:bg-white/5 select-none border-b border-[rgba(165,185,255,0.06)]"
        onClick={() => setOpen((o) => !o)}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-[#9aa8c7] shrink-0 w-3 text-center text-[0.6rem]">
            {open ? "▼" : "►"}
          </span>
          <span
            className="text-[#7dc9ff] font-medium truncate"
            title={info.savePath}
          >
            {info.savePath}
          </span>
        </div>
        <span className="shrink-0 text-[0.72rem] text-[#9aa8c7] bg-white/6 px-1.75 py-0.5 rounded-full whitespace-nowrap">
          {formatBytes(info.totalSize)}
        </span>
      </li>
      {/* Tree children */}
      {open && (
        <div className="py-1 max-h-65 overflow-y-auto">
          {tree.map((node, i) => (
            <SaveTreeNode
              key={i}
              node={node}
              depth={1}
              checkable={checkable}
              excluded={excluded}
              onToggle={onToggle}
              parentExcluded={false}
            />
          ))}
        </div>
      )}
    </ul>
  );
}

import { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router";
import { open } from "@tauri-apps/plugin-dialog";

import {
  useDashboardQuery,
  useRemoveGameMutation,
  useUpdateGameMutation,
  useGetSaveInfoMutation,
  useSyncGameMutation,
  useValidatePathsQuery,
} from "../queries";
import type { GameEntry } from "../types/dashboard";
import type { SaveInfo } from "../types/dashboard";
import { getBrowseDefaultPath, expandSavePath, uploadGameLogo } from "../services/tauri";
import { norm, msg, formatLocalTime } from "../utils";
import { ConfirmModal } from "../components/ConfirmModal";
import { Toast } from "../components/Toast";
import {
  CARD,
  DANGER_BTN,
  EYEBROW,
  FORM_GRID,
  FORM_LABEL,
  GHOST_BTN,
  INPUT_CLS,
  INPUT_ROW,
  LABEL_SPAN,
  MUTED,
  PRIMARY_BTN,
  SECONDARY_BTN,
  SOFT_BADGE,
  SOURCE_BADGE,
  TOGGLE_TRACK_ON,
  TOGGLE_TRACK_OFF,
  TOGGLE_THUMB_ON,
  TOGGLE_THUMB_OFF,
} from "../components/styles";

export function GameDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: dashboard } = useDashboardQuery();
  const updateMutation = useUpdateGameMutation();
  const removeMutation = useRemoveGameMutation();
  const [showRemoveModal, setShowRemoveModal] = useState(false);

  const game = dashboard?.games.find((g) => g.id === id) ?? null;
  const { savePathDraft, setSavePathDraft, handleBrowse, handleSave } =
    useSavePathForm(game, updateMutation);
  const { descDraft, setDescDraft, handleSaveDesc } =
    useDescriptionForm(game, updateMutation);
  const { thumbnailDraft, setThumbnailDraft, handleBrowseThumbnail, handleSaveThumbnail, isUploadingLogo, logoUploadError } =
    useThumbnailForm(game, updateMutation);
  const saveInfoMutation = useGetSaveInfoMutation();
  const syncMutation = useSyncGameMutation();
  const validateQuery = useValidatePathsQuery();
  const isSyncing = syncMutation.isPending;
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
  const isPathInvalid =
    game != null &&
    (validateQuery.data ?? []).some((v) => v.gameId === game.id && !v.valid);

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
                src={game.thumbnail}
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
              <p className="m-0 text-sm text-[#9aa8c7] max-w-[480px] whitespace-pre-wrap">
                {game.description}
              </p>
            )}
          </div>
        </div>

        {/* Metadata grid */}
        <dl className="grid gap-[14px] grid-cols-2 m-0 max-[720px]:grid-cols-1">
          {[
            { label: "Save folder", value: game.savePath ?? "Not set" },
            { label: "Last local save", value: formatLocalTime(game.lastLocalModified) },
            { label: "Last cloud save", value: formatLocalTime(game.lastCloudModified) },
            { label: "Google Drive folder", value: game.gdriveFolderId ?? "Not synced" },
          ].map(({ label, value }) => (
            <div
              key={label}
              className="p-[18px] rounded-[18px] bg-[rgba(9,14,28,0.75)] border border-[rgba(165,185,255,0.08)]"
            >
              <dt className="mb-2 text-[#c7d3f7] text-[0.92rem]">{label}</dt>
              <dd className="m-0 break-words text-[#9aa8c7]">{value}</dd>
            </div>
          ))}
        </dl>
      </div>

      {/* Logo / Thumbnail */}
      <div className={CARD}>
        <h3 className="m-0 mb-4 font-semibold">Logo / Thumbnail</h3>

        <div className={FORM_GRID}>
          {thumbnailDraft && (
            <div className="w-20 h-20 rounded-2xl border border-[rgba(165,185,255,0.1)] bg-[rgba(9,14,28,0.75)] overflow-hidden">
              <img
                src={thumbnailDraft}
                alt="Thumbnail preview"
                className="w-full h-full object-cover"
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
              />
            </div>
          )}

          <label className={FORM_LABEL}>
            <span className={LABEL_SPAN}>URL or local file path</span>
            <div className={INPUT_ROW}>
              <input
                className={INPUT_CLS}
                value={thumbnailDraft}
                onChange={(e) => setThumbnailDraft(e.currentTarget.value)}
                placeholder="https://… or browse a local file"
              />
              <button type="button" className={SECONDARY_BTN} onClick={handleBrowseThumbnail}>
                Browse
              </button>
            </div>
          </label>

          <div className="flex items-center gap-3">
            <button
              className={PRIMARY_BTN}
              type="button"
              onClick={handleSaveThumbnail}
              disabled={updateMutation.isPending || isUploadingLogo || isSyncing}
            >
              {isUploadingLogo ? "Uploading…" : updateMutation.isPending ? "Saving…" : "Save thumbnail"}
            </button>
            <button
              className={GHOST_BTN}
              type="button"              disabled={isSyncing}              onClick={() => setThumbnailDraft("")}
            >
              Clear
            </button>
          </div>

          {logoUploadError && (
            <p className="m-0 text-sm text-[#ffd5d5]">{logoUploadError}</p>
          )}
          {!logoUploadError && updateMutation.isError && (
            <p className="m-0 text-sm text-[#ffd5d5]">
              {msg(updateMutation.error, "Unable to save.")}
            </p>
          )}
        </div>
      </div>

      {/* Description */}
      <div className={CARD}>
        <h3 className="m-0 mb-4 font-semibold">Description</h3>

        <div className={FORM_GRID}>
          <label className={FORM_LABEL}>
            <span className={LABEL_SPAN}>Game description (max 1000 characters)</span>
            <textarea
              className={`${INPUT_CLS} resize-y min-h-[60px]`}
              value={descDraft}
              onChange={(e) => setDescDraft(e.currentTarget.value)}
              maxLength={1000}
              rows={4}
              placeholder="Brief description of the game…"
            />
            <span className={MUTED + " text-xs mt-1"}>{descDraft.length}/1000</span>
          </label>

          <button
            className={PRIMARY_BTN}
            type="button"
            onClick={handleSaveDesc}
            disabled={updateMutation.isPending || isSyncing}
          >
            {updateMutation.isPending ? "Saving…" : "Save description"}
          </button>
        </div>
      </div>

      {/* Save folder form */}
      <div className={CARD}>
        <h3 className="m-0 mb-4 font-semibold">Save folder mapping</h3>

        {isPathInvalid && (
          <div className="mb-4 p-3 rounded-2xl border border-[rgba(255,100,100,0.3)] bg-[rgba(62,18,22,0.5)] text-[#ff9e9e] text-sm flex items-center gap-2">
            <span>⚠</span> The configured save path does not exist on this machine.
          </div>
        )}

        <div className={FORM_GRID}>
          <label className={FORM_LABEL}>
            <span className={LABEL_SPAN}>Save folder path</span>
            <div className={INPUT_ROW}>
              <input
                className={INPUT_CLS}
                value={savePathDraft}
                onChange={(e) => setSavePathDraft(e.currentTarget.value)}
                placeholder="Choose or enter the save folder path"
              />
              <button type="button" className={SECONDARY_BTN} onClick={handleBrowse} disabled={isSyncing}>
                Browse
              </button>
            </div>
          </label>

          <div className="flex items-center justify-between gap-3 max-[720px]:flex-col max-[720px]:items-stretch">
            <button
              className={PRIMARY_BTN}
              type="button"
              onClick={handleSave}
              disabled={updateMutation.isPending || isSyncing}
            >
              {updateMutation.isPending ? "Saving…" : "Save mapping"}
            </button>
            <button className={GHOST_BTN} type="button" disabled={isSyncing} onClick={() => setSavePathDraft("")}>
              Clear
            </button>
          </div>

          {updateMutation.isError && (
            <p className="m-0 text-sm text-[#ffd5d5]">
              {msg(updateMutation.error, "Unable to save.")}
            </p>
          )}
        </div>
      </div>

      {/* Tracking & Sync settings */}
      <div className={CARD}>
        <h3 className="m-0 mb-4 font-semibold">Tracking & Sync</h3>

        <div className="grid gap-4">
          <ToggleRow
            label="Track file changes"
            description="Watch the save folder for modifications in the background"
            enabled={game.trackChanges}
            disabled={isSyncing}
            onChange={(v) => updateMutation.mutate({ ...game, trackChanges: v })}
          />
          <ToggleRow
            label="Auto-sync to Google Drive"
            description="Automatically back up saves when changes are detected"
            enabled={game.autoSync}
            disabled={isSyncing}
            onChange={(v) => updateMutation.mutate({ ...game, autoSync: v })}
          />
        </div>
      </div>

      {/* Actions */}
      <div className={CARD}>
        <h3 className="m-0 mb-4 font-semibold">Actions</h3>

        <div className="grid gap-4 grid-cols-2 max-[720px]:grid-cols-1">
          <button
            className={SECONDARY_BTN}
            type="button"
            disabled={!game.savePath || saveInfoMutation.isPending || isSyncing}
            onClick={() => game.savePath && saveInfoMutation.mutate(game.id)}
          >
            {saveInfoMutation.isPending ? "Loading…" : "Get save info"}
          </button>
          <button
            className={`${PRIMARY_BTN} inline-flex items-center justify-center gap-2`}
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
                  setToast({ message: msg(err, "Sync failed."), type: "error" });
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
        {saveInfoMutation.data && (
          <SaveInfoPanel info={saveInfoMutation.data} />
        )}
        {saveInfoMutation.isError && (
          <p className="m-0 mt-3 text-sm text-[#ffd5d5]">
            {msg(saveInfoMutation.error, "Unable to get save info.")}
          </p>
        )}

        {/* Sync Result */}
        {syncMutation.data && (
          <SyncResultPanel result={syncMutation.data} />
        )}
        {syncMutation.isError && (
          <p className="m-0 mt-3 text-sm text-[#ffd5d5]">
            {msg(syncMutation.error, "Sync failed.")}
          </p>
        )}
      </div>

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

      <ConfirmModal
        open={showRemoveModal}
        title="Remove game"
        message={`Are you sure you want to remove "${game.name}" from your library? This cannot be undone.`}
        confirmLabel="Remove"
        onConfirm={() => {
          setShowRemoveModal(false);
          removeMutation.mutate(game.id, { onSuccess: () => navigate("/", { replace: true }) });
        }}
        onCancel={() => setShowRemoveModal(false)}
      />
    </>
  );
}

// ── Co-located components ─────────────────────────────────────────────────────

interface ToggleRowProps {
  label: string;
  description: string;
  enabled: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}

function ToggleRow({ label, description, enabled, disabled, onChange }: ToggleRowProps) {
  return (
    <div className="flex items-center justify-between gap-4 p-4 rounded-[18px] bg-[rgba(9,14,28,0.75)] border border-[rgba(165,185,255,0.08)]">
      <div>
        <p className="m-0 font-medium text-[#c7d3f7]">{label}</p>
        <p className={`${MUTED} m-0 text-sm`}>{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        disabled={disabled}
        className={`${enabled ? TOGGLE_TRACK_ON : TOGGLE_TRACK_OFF} disabled:opacity-40 disabled:cursor-not-allowed`}
        onClick={() => onChange(!enabled)}
      >
        <span className={enabled ? TOGGLE_THUMB_ON : TOGGLE_THUMB_OFF} />
      </button>
    </div>
  );
}

function SaveInfoPanel({ info }: { info: SaveInfo }) {
  return (
    <div className="mt-4 p-4 rounded-[18px] bg-[rgba(9,14,28,0.75)] border border-[rgba(165,185,255,0.08)]">
      <p className={EYEBROW}>Local save info</p>
      <dl className="grid gap-2 grid-cols-2 m-0 max-[720px]:grid-cols-1">
        <div>
          <dt className="text-[#c7d3f7] text-sm">Total files</dt>
          <dd className={`${MUTED} m-0`}>{info.totalFiles}</dd>
        </div>
        <div>
          <dt className="text-[#c7d3f7] text-sm">Total size</dt>
          <dd className={`${MUTED} m-0`}>{formatBytes(info.totalSize)}</dd>
        </div>
        <div>
          <dt className="text-[#c7d3f7] text-sm">Last modified</dt>
          <dd className={`${MUTED} m-0`}>{info.lastModified ?? "N/A"}</dd>
        </div>
        <div>
          <dt className="text-[#c7d3f7] text-sm">Save path</dt>
          <dd className={`${MUTED} m-0 break-all text-xs`}>{info.savePath}</dd>
        </div>
      </dl>
      {info.files.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm text-[#7dc9ff]">
            Show files ({info.files.length})
          </summary>
          <ul className="mt-2 list-none p-0 grid gap-1 max-h-[240px] overflow-y-auto">
            {info.files.map((f) => (
              <li
                key={f.relativePath}
                className="flex items-center justify-between gap-2 text-xs px-2 py-1 rounded-lg bg-[rgba(255,255,255,0.03)]"
              >
                <span className="text-[#c7d3f7] truncate">{f.relativePath}</span>
                <span className={MUTED}>{formatBytes(f.size)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function SyncResultPanel({ result }: { result: { uploaded: number; downloaded: number; skipped: number; error: string | null } }) {
  return (
    <div className={`mt-4 p-4 rounded-[18px] border ${result.error ? "bg-[rgba(40,10,10,0.75)] border-[rgba(255,120,120,0.2)]" : "bg-[rgba(9,14,28,0.75)] border-[rgba(165,185,255,0.08)]"}`}>
      <p className={EYEBROW}>{result.error ? "Sync error" : "Sync complete"}</p>
      {result.error ? (
        <p className="m-0 text-sm text-[#ffd5d5]">{result.error}</p>
      ) : (
        <dl className="grid gap-2 grid-cols-3 m-0">
          <div>
            <dt className="text-[#c7d3f7] text-sm">Uploaded</dt>
            <dd className={`${MUTED} m-0`}>{result.uploaded}</dd>
          </div>
          <div>
            <dt className="text-[#c7d3f7] text-sm">Downloaded</dt>
            <dd className={`${MUTED} m-0`}>{result.downloaded}</dd>
          </div>
          <div>
            <dt className="text-[#c7d3f7] text-sm">Skipped</dt>
            <dd className={`${MUTED} m-0`}>{result.skipped}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// ── Co-located hook ───────────────────────────────────────────────────────────

function useSavePathForm(
  game: GameEntry | null,
  updateMutation: ReturnType<typeof useUpdateGameMutation>,
) {
  const [savePathDraft, setSavePathDraft] = useState(game?.savePath ?? "");

  useEffect(() => {
    setSavePathDraft(game?.savePath ?? "");
  }, [game?.id, game?.savePath]);

  async function handleBrowse() {
    // Priority: current game's parent dir → last game's parent dir → no default
    let defaultPath: string | undefined;
    if (game?.savePath) {
      // Expand %VAR% tokens before extracting the parent so the dialog opens
      // at the real filesystem location rather than the token string.
      const resolved = game.savePath.includes("%")
        ? await expandSavePath(game.savePath)
        : game.savePath;
      const sep = resolved.lastIndexOf("\\");
      if (sep > 0) defaultPath = resolved.slice(0, sep);
    }
    if (!defaultPath) {
      const suggested = await getBrowseDefaultPath();
      if (suggested) defaultPath = suggested;
    }

    const p = await open({
      directory: true,
      multiple: false,
      title: "Choose the save game folder",
      defaultPath,
    });
    if (typeof p === "string") setSavePathDraft(p);
  }

  async function handleSave() {
    if (!game) return;
    await updateMutation.mutateAsync({ ...game, savePath: norm(savePathDraft) });
  }

  return { savePathDraft, setSavePathDraft, handleBrowse, handleSave };
}

function useDescriptionForm(
  game: GameEntry | null,
  updateMutation: ReturnType<typeof useUpdateGameMutation>,
) {
  const [descDraft, setDescDraft] = useState(game?.description ?? "");

  useEffect(() => {
    setDescDraft(game?.description ?? "");
  }, [game?.id, game?.description]);

  async function handleSaveDesc() {
    if (!game) return;
    const trimmed = descDraft.trim().slice(0, 1000);
    await updateMutation.mutateAsync({
      ...game,
      description: trimmed || null,
    });
  }

  return { descDraft, setDescDraft, handleSaveDesc };
}

function useThumbnailForm(
  game: GameEntry | null,
  updateMutation: ReturnType<typeof useUpdateGameMutation>,
) {
  const [thumbnailDraft, setThumbnailDraft] = useState(game?.thumbnail ?? "");
  const [isUploadingLogo, setIsUploadingLogo] = useState(false);
  const [logoUploadError, setLogoUploadError] = useState<string | null>(null);

  useEffect(() => {
    setThumbnailDraft(game?.thumbnail ?? "");
  }, [game?.id, game?.thumbnail]);

  async function handleBrowseThumbnail() {
    const p = await open({
      multiple: false,
      title: "Choose a thumbnail image",
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
    });
    if (typeof p === "string") {
      setThumbnailDraft(p);
      setLogoUploadError(null);
    }
  }

  async function handleSaveThumbnail() {
    if (!game) return;
    const src = norm(thumbnailDraft);
    setLogoUploadError(null);

    if (src) {
      setIsUploadingLogo(true);
      try {
        await uploadGameLogo(game.id, src);
      } catch (err) {
        setLogoUploadError(msg(err, "Logo upload failed."));
        setIsUploadingLogo(false);
        return;
      }
      setIsUploadingLogo(false);
    }

    await updateMutation.mutateAsync({ ...game, thumbnail: src });
  }

  return { thumbnailDraft, setThumbnailDraft, handleBrowseThumbnail, handleSaveThumbnail, isUploadingLogo, logoUploadError };
}

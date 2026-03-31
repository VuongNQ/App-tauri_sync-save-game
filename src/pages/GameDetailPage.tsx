import { useEffect, useState } from "react";
import { useParams, Link } from "react-router";
import { open } from "@tauri-apps/plugin-dialog";

import {
  useDashboardQuery,
  useUpdateGameMutation,
  useGetSaveInfoMutation,
  useSyncGameMutation,
} from "../queries";
import type { GameEntry } from "../types/dashboard";
import type { SaveInfo } from "../types/dashboard";
import { norm, msg } from "../utils";
import {
  CARD,
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
  const { data: dashboard } = useDashboardQuery();
  const updateMutation = useUpdateGameMutation();

  const game = dashboard?.games.find((g) => g.id === id) ?? null;
  const { savePathDraft, setSavePathDraft, handleBrowse, handleSave } =
    useSavePathForm(game, updateMutation);
  const { descDraft, setDescDraft, handleSaveDesc } =
    useDescriptionForm(game, updateMutation);
  const saveInfoMutation = useGetSaveInfoMutation();
  const syncMutation = useSyncGameMutation();

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
            { label: "Last local save", value: game.lastLocalModified ?? "Never" },
            { label: "Last cloud save", value: game.lastCloudModified ?? "Never" },
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
            disabled={updateMutation.isPending}
          >
            {updateMutation.isPending ? "Saving…" : "Save description"}
          </button>
        </div>
      </div>

      {/* Save folder form */}
      <div className={CARD}>
        <h3 className="m-0 mb-4 font-semibold">Save folder mapping</h3>

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
              <button type="button" className={SECONDARY_BTN} onClick={handleBrowse}>
                Browse
              </button>
            </div>
          </label>

          <div className="flex items-center justify-between gap-3 max-[720px]:flex-col max-[720px]:items-stretch">
            <button
              className={PRIMARY_BTN}
              type="button"
              onClick={handleSave}
              disabled={updateMutation.isPending}
            >
              {updateMutation.isPending ? "Saving…" : "Save mapping"}
            </button>
            <button className={GHOST_BTN} type="button" onClick={() => setSavePathDraft("")}>
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
            onChange={(v) => updateMutation.mutate({ ...game, trackChanges: v })}
          />
          <ToggleRow
            label="Auto-sync to Google Drive"
            description="Automatically back up saves when changes are detected"
            enabled={game.autoSync}
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
            disabled={!game.savePath || saveInfoMutation.isPending}
            onClick={() => game.savePath && saveInfoMutation.mutate(game.id)}
          >
            {saveInfoMutation.isPending ? "Loading…" : "Get save info"}
          </button>
          <button
            className={PRIMARY_BTN}
            type="button"
            disabled={!game.savePath || syncMutation.isPending}
            onClick={() => game.savePath && syncMutation.mutate(game.id)}
          >
            {syncMutation.isPending ? "Syncing…" : "Sync to Google Drive"}
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
    </>
  );
}

// ── Co-located components ─────────────────────────────────────────────────────

interface ToggleRowProps {
  label: string;
  description: string;
  enabled: boolean;
  onChange: (value: boolean) => void;
}

function ToggleRow({ label, description, enabled, onChange }: ToggleRowProps) {
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
        className={enabled ? TOGGLE_TRACK_ON : TOGGLE_TRACK_OFF}
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
    const p = await open({
      directory: true,
      multiple: false,
      title: "Choose the save game folder",
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

import { useEffect, useState } from "react";
import { useParams, Link } from "react-router";
import { open } from "@tauri-apps/plugin-dialog";

import { useDashboardQuery, useUpdateGameMutation } from "../queries";
import type { GameEntry } from "../types/dashboard";
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

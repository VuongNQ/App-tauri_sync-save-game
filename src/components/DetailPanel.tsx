import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";

import { useSavePathMutation } from "../queries";
import type { GameItem } from "../types/dashboard";
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
} from "./styles";

interface Props {
  selectedGame: GameItem | null;
}

export function DetailPanel({ selectedGame }: Props) {
  const [savePathDraft, setSavePathDraft] = useState(selectedGame?.savePath ?? "");
  const savePathMutation = useSavePathMutation();

  // Sync draft whenever the selected game changes
  useEffect(() => {
    setSavePathDraft(selectedGame?.savePath ?? "");
  }, [selectedGame?.id, selectedGame?.savePath]);

  async function handleBrowse() {
    const p = await open({ directory: true, multiple: false, title: "Choose the save game folder" });
    if (typeof p === "string") setSavePathDraft(p);
  }

  async function handleSave() {
    if (!selectedGame) return;
    await savePathMutation.mutateAsync({ ...selectedGame, savePath: norm(savePathDraft) });
  }

  if (!selectedGame) {
    return (
      <section className={CARD}>
        <div className="grid place-items-center min-h-full rounded-[18px] border border-dashed border-[rgba(165,185,255,0.16)] bg-[rgba(8,14,25,0.55)] text-center p-[18px]">
          <p className="m-0 text-[1.1rem]">Select a game from the list.</p>
          <span className={MUTED}>Its install folder and save folder mapping will appear here.</span>
        </div>
      </section>
    );
  }

  return (
    <section className={CARD}>
      {/* Header */}
      <div className="flex items-center justify-between gap-3 mb-[18px]">
        <div>
          <p className={EYEBROW}>Game details</p>
          <h3 className="m-0">{selectedGame.name}</h3>
        </div>
        <div className="flex gap-2 flex-wrap">
          <span className={SOFT_BADGE}>{selectedGame.launcher}</span>
          <span className={SOFT_BADGE}>Confidence: {selectedGame.confidence}</span>
        </div>
      </div>

      {/* Metadata grid */}
      <dl className="grid gap-[14px] grid-cols-2 m-0 mb-[18px] max-[720px]:grid-cols-1">
        {[
          { label: "Install folder", value: selectedGame.installPath ?? "Not set" },
          { label: "Source",         value: selectedGame.source },
          { label: "Mode",           value: selectedGame.isManual ? "Manual entry" : "Auto-detected" },
          { label: "Status",         value: selectedGame.isAvailable ? "Available on this system" : "Saved mapping only" },
        ].map(({ label, value }) => (
          <div key={label} className="p-[18px] rounded-[18px] bg-[rgba(9,14,28,0.75)] border border-[rgba(165,185,255,0.08)]">
            <dt className="mb-2 text-[#c7d3f7] text-[0.92rem]">{label}</dt>
            <dd className="m-0 break-words text-[#9aa8c7]">{value}</dd>
          </div>
        ))}
      </dl>

      {/* Save folder form */}
      <div className={FORM_GRID}>
        <label className={FORM_LABEL}>
          <span className={LABEL_SPAN}>Save folder</span>
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
            disabled={savePathMutation.isPending}
          >
            {savePathMutation.isPending ? "Saving…" : "Save folder mapping"}
          </button>
          <button className={GHOST_BTN} type="button" onClick={() => setSavePathDraft("")}>
            Clear input
          </button>
        </div>

        {savePathMutation.isError && (
          <p className="m-0 text-sm text-[#ffd5d5]">
            {msg(savePathMutation.error, "Unable to save the folder path.")}
          </p>
        )}
      </div>
    </section>
  );
}

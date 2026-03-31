import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router";

import { useAddGameMutation } from "../queries";
import type { AddGamePayload, GameSource } from "../types/dashboard";
import { norm, msg } from "../utils";
import {
  CARD,
  FORM_GRID,
  FORM_LABEL,
  INPUT_CLS,
  INPUT_ROW,
  LABEL_SPAN,
  PRIMARY_BTN,
  SEC_HDR,
  SECONDARY_BTN,
} from "./styles";

const DEFAULT_FORM: AddGamePayload = {
  name: "",
  thumbnail: null,
  source: "manual",
  savePath: null,
};

export function AddGameCard() {
  const [form, setForm] = useState<AddGamePayload>(DEFAULT_FORM);
  const addMutation = useAddGameMutation();
  const navigate = useNavigate();

  async function handleBrowseSave() {
    const p = await open({ directory: true, multiple: false, title: "Choose the save game folder" });
    if (typeof p === "string") setForm((c) => ({ ...c, savePath: p }));
  }

  async function handleBrowseThumbnail() {
    const p = await open({
      multiple: false,
      title: "Choose a thumbnail image",
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
    });
    if (typeof p === "string") setForm((c) => ({ ...c, thumbnail: p }));
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const payload: AddGamePayload = {
      name: form.name.trim(),
      thumbnail: norm(form.thumbnail),
      source: form.source,
      savePath: norm(form.savePath),
    };
    const data = await addMutation.mutateAsync(payload);
    const added = data.games.find(
      (g) => g.name.toLowerCase() === payload.name.toLowerCase(),
    );
    setForm(DEFAULT_FORM);
    if (added) navigate(`/game/${added.id}`);
  }

  return (
    <section className={CARD}>
      <div className={SEC_HDR}>
        <h2 className="m-0 text-lg font-semibold">Add game</h2>
      </div>

      <form className={FORM_GRID} onSubmit={handleSubmit}>
        <label className={FORM_LABEL}>
          <span className={LABEL_SPAN}>Game name</span>
          <input
            className={INPUT_CLS}
            value={form.name}
            onChange={(e) => setForm((c) => ({ ...c, name: e.currentTarget.value }))}
            placeholder="Example: Elden Ring"
            required
          />
        </label>

        <label className={FORM_LABEL}>
          <span className={LABEL_SPAN}>Source</span>
          <select
            className={INPUT_CLS}
            value={form.source}
            onChange={(e) =>
              setForm((c) => ({ ...c, source: e.currentTarget.value as GameSource }))
            }
          >
            <option value="manual">Manual</option>
            <option value="steam">Steam</option>
            <option value="epic">Epic Games</option>
            <option value="emulator">Emulator</option>
          </select>
        </label>

        <label className={FORM_LABEL}>
          <span className={LABEL_SPAN}>Thumbnail (URL or file)</span>
          <div className={INPUT_ROW}>
            <input
              className={INPUT_CLS}
              value={form.thumbnail ?? ""}
              onChange={(e) => setForm((c) => ({ ...c, thumbnail: e.currentTarget.value }))}
              placeholder="https://… or browse a local file"
            />
            <button type="button" className={SECONDARY_BTN} onClick={handleBrowseThumbnail}>
              Browse
            </button>
          </div>
        </label>

        <label className={FORM_LABEL}>
          <span className={LABEL_SPAN}>Save game folder</span>
          <div className={INPUT_ROW}>
            <input
              className={INPUT_CLS}
              value={form.savePath ?? ""}
              onChange={(e) => setForm((c) => ({ ...c, savePath: e.currentTarget.value }))}
              placeholder="Choose the save game folder"
            />
            <button type="button" className={SECONDARY_BTN} onClick={handleBrowseSave}>
              Browse
            </button>
          </div>
        </label>

        <button className={PRIMARY_BTN} type="submit" disabled={addMutation.isPending}>
          {addMutation.isPending ? "Saving…" : "Add game"}
        </button>

        {addMutation.isError && (
          <p className="m-0 text-sm text-[#ffd5d5]">
            {msg(addMutation.error, "Unable to add the game.")}
          </p>
        )}
      </form>
    </section>
  );
}

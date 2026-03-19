import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import type { FormEvent } from "react";

import { useAddGameMutation } from "../queries";
import type { AddGamePayload, DashboardData } from "../types/dashboard";
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

const DEFAULT_FORM: AddGamePayload = { name: "", launcher: null, installPath: null };

interface Props {
  /** Called with the id of the newly-added game so the parent can select it. */
  onGameAdded: (data: DashboardData, addedName: string) => void;
}

export function AddGameCard({ onGameAdded }: Props) {
  const [form, setForm] = useState<AddGamePayload>(DEFAULT_FORM);
  const addMutation = useAddGameMutation();

  async function handleBrowse() {
    const p = await open({ directory: true, multiple: false, title: "Choose the game install folder" });
    if (typeof p === "string") setForm((c) => ({ ...c, installPath: p }));
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const payload: AddGamePayload = {
      name: form.name.trim(),
      launcher: norm(form.launcher),
      installPath: norm(form.installPath),
    };
    const data = await addMutation.mutateAsync(payload);
    onGameAdded(data, payload.name);
    setForm(DEFAULT_FORM);
  }

  return (
    <section className={CARD}>
      <div className={SEC_HDR}>
        <h2 className="m-0 text-lg font-semibold">Add game</h2>
        <span className="text-[0.85rem]">Manual entry</span>
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
          <span className={LABEL_SPAN}>Launcher</span>
          <select
            className={INPUT_CLS}
            value={form.launcher ?? "Manual"}
            onChange={(e) => setForm((c) => ({ ...c, launcher: e.currentTarget.value }))}
          >
            <option value="Manual">Manual</option>
            <option value="Steam">Steam</option>
            <option value="Epic Games">Epic Games</option>
            <option value="GOG Galaxy">GOG Galaxy</option>
            <option value="Other">Other</option>
          </select>
        </label>

        <label className={FORM_LABEL}>
          <span className={LABEL_SPAN}>Install folder</span>
          <div className={INPUT_ROW}>
            <input
              className={INPUT_CLS}
              value={form.installPath ?? ""}
              onChange={(e) => setForm((c) => ({ ...c, installPath: e.currentTarget.value }))}
              placeholder="Optional install path"
            />
            <button type="button" className={SECONDARY_BTN} onClick={handleBrowse}>
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

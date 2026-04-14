import { zodResolver } from "@hookform/resolvers/zod";
import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useNavigate } from "react-router";
import { z } from "zod";

import { useAddGameMutation } from "../queries";
import type { AddGamePayload } from "../types/dashboard";
import { norm, msg } from "../utils";
import { uploadGameLogo } from "../services/tauri";
import { CARD, FIELD_ERROR, FORM_GRID, FORM_LABEL, INPUT_CLS, INPUT_ROW, LABEL_SPAN, PRIMARY_BTN, SEC_HDR, SECONDARY_BTN } from "./styles";

const addGameSchema = z.object({
  name: z.string().min(1, "Game name is required."),
  description: z.string().max(1000, "Description must be 1000 characters or fewer.").nullable(),
  thumbnail: z.string().nullable(),
  source: z.enum(["manual", "emulator"]),
  savePath: z.string().nullable(),
}) satisfies z.ZodType<AddGamePayload>;

const DEFAULT_VALUES: AddGamePayload = {
  name: "",
  description: null,
  thumbnail: null,
  source: "manual",
  savePath: null,
};

export function AddGameCard() {
  const {
    register,
    handleSubmit,
    setValue,
    reset,
    watch,
    formState: { errors },
  } = useForm<AddGamePayload>({
    defaultValues: DEFAULT_VALUES,
    resolver: zodResolver(addGameSchema),
  });
  const addMutation = useAddGameMutation();
  const navigate = useNavigate();
  const [logoUploadError, setLogoUploadError] = useState<string | null>(null);

  const thumbnail = watch("thumbnail");
  const savePath = watch("savePath");

  async function handleBrowseSave() {
    const p = await open({ directory: true, multiple: false, title: "Choose the save game folder" });
    if (typeof p === "string") setValue("savePath", p);
  }

  async function handleBrowseThumbnail() {
    const p = await open({
      multiple: false,
      title: "Choose a thumbnail image",
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
    });
    if (typeof p === "string") setValue("thumbnail", p);
  }

  async function onSubmit(values: AddGamePayload) {
    setLogoUploadError(null);
    const payload: AddGamePayload = {
      name: values.name.trim(),
      description: norm(values.description),
      thumbnail: norm(values.thumbnail),
      source: values.source,
      savePath: norm(values.savePath),
    };
    const data = await addMutation.mutateAsync(payload);
    const added = data.games.find((g) => g.name.toLowerCase() === payload.name.toLowerCase());

    if (added && payload.thumbnail) {
      try {
        await uploadGameLogo(added.id, payload.thumbnail);
      } catch (err) {
        setLogoUploadError(msg(err, "Game added but logo upload failed."));
        reset(DEFAULT_VALUES);
        navigate(`/game/${added.id}`);
        return;
      }
    }

    reset(DEFAULT_VALUES);
    if (added) navigate(`/game/${added.id}`);
  }

  return (
    <section className={CARD}>
      <div className={SEC_HDR}>
        <h2 className="m-0 text-lg font-semibold">Add game</h2>
      </div>

      <form className={FORM_GRID} onSubmit={handleSubmit(onSubmit)}>
        <label className={FORM_LABEL}>
          <span className={LABEL_SPAN}>Game name</span>
          <input className={INPUT_CLS} {...register("name")} placeholder="Example: Elden Ring" />
          {errors.name && <span className={FIELD_ERROR}>{errors.name.message}</span>}
        </label>

        <label className={FORM_LABEL}>
          <span className={LABEL_SPAN}>Description (optional)</span>
          <textarea
            className={`${INPUT_CLS} resize-y min-h-[60px]`}
            {...register("description")}
            maxLength={1000}
            rows={3}
            placeholder="Brief description of the game…"
          />
          {errors.description && <span className={FIELD_ERROR}>{errors.description.message}</span>}
        </label>

        <label className={FORM_LABEL}>
          <span className={LABEL_SPAN}>Source</span>
          <select className={INPUT_CLS} {...register("source")}>
            <option value="manual">Manual</option>
            <option value="emulator">Emulator</option>
          </select>
        </label>

        <label className={FORM_LABEL}>
          <span className={LABEL_SPAN}>Thumbnail (URL or file)</span>
          <div className={INPUT_ROW}>
            <input
              className={INPUT_CLS}
              {...register("thumbnail")}
              value={thumbnail ?? ""}
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
            <input className={INPUT_CLS} {...register("savePath")} value={savePath ?? ""} placeholder="Choose the save game folder" />
            <button type="button" className={SECONDARY_BTN} onClick={handleBrowseSave}>
              Browse
            </button>
          </div>
        </label>

        <button className={PRIMARY_BTN} type="submit" disabled={addMutation.isPending}>
          {addMutation.isPending ? "Saving…" : "Add game"}
        </button>

        {addMutation.isError && <p className="m-0 text-sm text-[#ffd5d5]">{msg(addMutation.error, "Unable to add the game.")}</p>}
        {logoUploadError && <p className="m-0 text-sm text-[#ffd5d5]">{logoUploadError}</p>}
      </form>
    </section>
  );
}

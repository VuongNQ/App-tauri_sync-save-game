import { zodResolver } from "@hookform/resolvers/zod";
import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useNavigate } from "react-router";
import { z } from "zod";

import { useAddGameMutation, useUpdateGameMutation } from "../queries";
import type { AddGamePayload } from "../types/dashboard";
import { norm, msg, toImgSrc } from "../utils";
import { contractPath, getFileSize, uploadGameLogo } from "../services/tauri";
import { CARD, FIELD_ERROR, FORM_GRID, FORM_LABEL, INPUT_CLS, INPUT_ROW, LABEL_SPAN, PRIMARY_BTN, SEC_HDR, SECONDARY_BTN } from "./styles";

const addGameSchema = z.object({
  name: z.string().min(1, "Game name is required."),
  description: z.string().max(1000, "Description must be 1000 characters or fewer.").nullable(),
  thumbnail: z.string().nullable(),
  source: z.enum(["manual", "emulator"]),
  savePath: z.string().nullable(),
  exeName: z.string().nullable().optional(),
  pathMode: z.enum(["auto", "per_device"]).optional(),
  exePath: z.string().nullable().optional(),
}) satisfies z.ZodType<AddGamePayload>;

const DEFAULT_VALUES: AddGamePayload = {
  name: "",
  description: null,
  thumbnail: null,
  source: "manual",
  savePath: null,
  exeName: null,
  pathMode: "auto",
  exePath: null,
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
  const updateMutation = useUpdateGameMutation();

  const navigate = useNavigate();

  const [logoUploadError, setLogoUploadError] = useState<string | null>(null);
  const [thumbnailSizeError, setThumbnailSizeError] = useState<string | null>(null);

  const thumbnail = watch("thumbnail");

  const savePath = watch("savePath");

  const exePath = watch("exePath");

  async function handleBrowseSave() {
    const p = await open({ directory: true, multiple: false, title: "Choose the save game folder" });
    if (typeof p === "string") setValue("savePath", p);
  }

  async function handleBrowseExe() {
    const p = await open({
      multiple: false,
      title: "Choose the game executable",
      filters: [{ name: "Executable", extensions: ["exe"] }],
    });
    if (typeof p === "string") {
      const portable = await contractPath(p);
      setValue("exePath", portable);
    }
  }

  async function handleBrowseThumbnail() {
    const p = await open({
      multiple: false,
      title: "Choose a thumbnail image",
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
    });
    if (typeof p === "string") {
      setValue("thumbnail", p);
      setThumbnailSizeError(null);
      try {
        const bytes = await getFileSize(p);
        if (bytes > 2 * 1024 * 1024) {
          setThumbnailSizeError(`Image is ${(bytes / 1_048_576).toFixed(1)} MB — must be 2 MB or smaller.`);
        }
      } catch {
        // size check failed silently — backend will catch it on upload
      }
    }
  }

  async function onSubmit(values: AddGamePayload) {
    if (thumbnailSizeError) return;
    setLogoUploadError(null);
    
    const payload: AddGamePayload = {
      name: values.name.trim(),
      description: norm(values.description),
      thumbnail: norm(values.thumbnail),
      source: values.source,
      savePath: norm(values.savePath),
      pathMode: values.pathMode,
      exePath: norm(values.exePath),
    };
    
    const data = await addMutation.mutateAsync(payload);

    const added = data.games.find((g) => g.name.toLowerCase() === payload.name.toLowerCase());

    // Upload local file thumbnails to Drive and persist the returned URL.
    // HTTP/HTTPS thumbnails are stored as-is without upload.
    const isLocalFile = payload.thumbnail && !/^https?:\/\//.test(payload.thumbnail);
    if (added && isLocalFile) {
      try {
        const driveUrl = await uploadGameLogo(added.id, payload.thumbnail!);
        // Persist the Drive URL so future loads use the cloud-hosted image.
        await updateMutation.mutateAsync({ ...added, thumbnail: driveUrl });
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
            className={`${INPUT_CLS} resize-y min-h-15`}
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
          {thumbnailSizeError && <span className={FIELD_ERROR}>{thumbnailSizeError}</span>}
        </label>

        {thumbnail && !thumbnailSizeError && (
          <div className="w-20 h-20 rounded-2xl border border-[rgba(165,185,255,0.1)] bg-[rgba(9,14,28,0.75)] overflow-hidden">
            <img
              src={toImgSrc(thumbnail)}
              alt="Thumbnail preview"
              className="w-full h-full object-cover"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
          </div>
        )}

        <label className={FORM_LABEL}>
          <span className={LABEL_SPAN}>Save game folder</span>
          <div className={INPUT_ROW}>
            <input className={INPUT_CLS} {...register("savePath")} value={savePath ?? ""} placeholder="Choose the save game folder" />
            <button type="button" className={SECONDARY_BTN} onClick={handleBrowseSave}>
              Browse
            </button>
          </div>
        </label>

        <label className={FORM_LABEL}>
          <span className={LABEL_SPAN}>Path type</span>
          <select className={INPUT_CLS} {...register("pathMode")}>
            <option value="auto">Auto — portable paths shared across devices</option>
            <option value="per_device">Per device — path stored locally on each machine</option>
          </select>
        </label>

        <label className={FORM_LABEL}>
          <span className={LABEL_SPAN}>Executable path (optional)</span>
          <div className={INPUT_ROW}>
            <input
              className={INPUT_CLS}
              {...register("exePath")}
              value={exePath ?? ""}
              placeholder="Browse or paste the .exe path (e.g. %PROGRAMFILES%\…)"
            />
            <button type="button" className={SECONDARY_BTN} onClick={handleBrowseExe}>
              Browse
            </button>
          </div>
        </label>

        <button className={PRIMARY_BTN} type="submit" disabled={addMutation.isPending || updateMutation.isPending || !!thumbnailSizeError}>
          {addMutation.isPending || updateMutation.isPending ? "Saving…" : "Add game"}
        </button>

        {addMutation.isError && <p className="m-0 text-sm text-[#ffd5d5]">{msg(addMutation.error, "Unable to add the game.")}</p>}
        {logoUploadError && <p className="m-0 text-sm text-[#ffd5d5]">{logoUploadError}</p>}
      </form>
    </section>
  );
}

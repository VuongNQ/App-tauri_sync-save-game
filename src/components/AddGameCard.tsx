import { zodResolver } from "@hookform/resolvers/zod";
import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useNavigate } from "react-router";
import { z } from "zod";

import { useI18n } from "../i18n";
import { useAddGameMutation, useUpdateGameMutation } from "../queries";
import type { AddGamePayload } from "../types/dashboard";
import { norm, msg, toImgSrc } from "../utils";
import { contractPath, getFileSize, uploadGameLogo } from "../services/tauri";
import { CARD, FIELD_ERROR, FORM_GRID, FORM_LABEL, INPUT_CLS, INPUT_ROW, LABEL_SPAN, PRIMARY_BTN, SEC_HDR, SECONDARY_BTN } from "./styles";

const addGameSchema = z.object({
  name: z.string().min(1, "addGame.errorNameRequired"),
  description: z.string().max(1000, "form.errorDescriptionMax").nullable(),
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
  const { t, tx } = useI18n();
  const updateMutation = useUpdateGameMutation();

  const navigate = useNavigate();

  const [logoUploadError, setLogoUploadError] = useState<string | null>(null);
  const [thumbnailSizeError, setThumbnailSizeError] = useState<string | null>(null);

  const thumbnail = watch("thumbnail");

  const savePath = watch("savePath");

  const exePath = watch("exePath");

  async function handleBrowseSave() {
    const p = await open({ directory: true, multiple: false, title: t("dialog.chooseSaveFolder") });
    if (typeof p === "string") setValue("savePath", p);
  }

  async function handleBrowseExe() {
    const p = await open({
      multiple: false,
      title: t("dialog.chooseExe"),
      filters: [{ name: t("dialog.exeFilter"), extensions: ["exe", "lnk"] }],
    });
    if (typeof p === "string") {
      const portable = await contractPath(p);
      setValue("exePath", portable);
    }
  }

  async function handleBrowseThumbnail() {
    const p = await open({
      multiple: false,
      title: t("dialog.chooseThumbnail"),
      filters: [{ name: t("dialog.imagesFilter"), extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
    });
    if (typeof p === "string") {
      setValue("thumbnail", p);
      setThumbnailSizeError(null);
      try {
        const bytes = await getFileSize(p);
        if (bytes > 2 * 1024 * 1024) {
          setThumbnailSizeError(t("form.errorImageSize", { size: (bytes / 1_048_576).toFixed(1) }));
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
        setLogoUploadError(msg(err, t("addGame.errorLogo")));
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
        <h2 className="m-0 text-lg font-semibold">{t("addGame.title")}</h2>
      </div>

      <form className={FORM_GRID} onSubmit={handleSubmit(onSubmit)}>
        <label className={FORM_LABEL}>
          <span className={LABEL_SPAN}>{t("addGame.name")}</span>
          <input className={INPUT_CLS} {...register("name")} placeholder={t("addGame.namePlaceholder")} />
          {errors.name && <span className={FIELD_ERROR}>{tx(errors.name.message)}</span>}
        </label>

        <label className={FORM_LABEL}>
          <span className={LABEL_SPAN}>{t("addGame.description")}</span>
          <textarea
            className={`${INPUT_CLS} resize-y min-h-15`}
            {...register("description")}
            maxLength={1000}
            rows={3}
            placeholder={t("form.descriptionPlaceholder")}
          />
          {errors.description && <span className={FIELD_ERROR}>{tx(errors.description.message)}</span>}
        </label>

        <label className={FORM_LABEL}>
          <span className={LABEL_SPAN}>{t("addGame.source")}</span>
          <select className={INPUT_CLS} {...register("source")}>
            <option value="manual">{t("addGame.sourceManual")}</option>
            <option value="emulator">{t("addGame.sourceEmulator")}</option>
          </select>
        </label>

        <label className={FORM_LABEL}>
          <span className={LABEL_SPAN}>{t("addGame.thumbnail")}</span>
          <div className={INPUT_ROW}>
            <input
              className={INPUT_CLS}
              {...register("thumbnail")}
              value={thumbnail ?? ""}
              placeholder={t("form.thumbnailPlaceholder")}
            />
            <button type="button" className={SECONDARY_BTN} onClick={handleBrowseThumbnail}>
              {t("common.browse")}
            </button>
          </div>
          {thumbnailSizeError && <span className={FIELD_ERROR}>{thumbnailSizeError}</span>}
        </label>

        {thumbnail && !thumbnailSizeError && (
          <div className="w-20 h-20 rounded-2xl border border-[rgba(165,185,255,0.1)] bg-[rgba(9,14,28,0.75)] overflow-hidden">
            <img
              src={toImgSrc(thumbnail)}
              alt={t("form.thumbnailPreview")}
              className="w-full h-full object-cover"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
          </div>
        )}

        <label className={FORM_LABEL}>
          <span className={LABEL_SPAN}>{t("addGame.saveFolder")}</span>
          <div className={INPUT_ROW}>
            <input className={INPUT_CLS} {...register("savePath")} value={savePath ?? ""} placeholder={t("dialog.chooseSaveFolder")} />
            <button type="button" className={SECONDARY_BTN} onClick={handleBrowseSave}>
              {t("common.browse")}
            </button>
          </div>
        </label>

        <label className={FORM_LABEL}>
          <span className={LABEL_SPAN}>{t("addGame.pathType")}</span>
          <select className={INPUT_CLS} {...register("pathMode")}>
            <option value="auto">{t("addGame.pathAuto")}</option>
            <option value="per_device">{t("addGame.pathPerDevice")}</option>
          </select>
        </label>

        <label className={FORM_LABEL}>
          <span className={LABEL_SPAN}>{t("addGame.exePath")}</span>
          <div className={INPUT_ROW}>
            <input
              className={INPUT_CLS}
              {...register("exePath")}
              value={exePath ?? ""}
              placeholder={t("addGame.exePlaceholder")}
            />
            <button type="button" className={SECONDARY_BTN} onClick={handleBrowseExe}>
              {t("common.browse")}
            </button>
          </div>
        </label>

        <button className={PRIMARY_BTN} type="submit" disabled={addMutation.isPending || updateMutation.isPending || !!thumbnailSizeError}>
          {addMutation.isPending || updateMutation.isPending ? t("common.saving") : t("addGame.submit")}
        </button>

        {addMutation.isError && <p className="m-0 text-sm text-[#ffd5d5]">{msg(addMutation.error, t("addGame.errorAdd"))}</p>}
        {logoUploadError && <p className="m-0 text-sm text-[#ffd5d5]">{logoUploadError}</p>}
      </form>
    </section>
  );
}

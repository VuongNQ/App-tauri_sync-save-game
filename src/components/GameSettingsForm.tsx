import { useEffect, useState } from "react";
import {
  useForm,
  useFormContext,
  FormProvider,
  Controller,
} from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { open } from "@tauri-apps/plugin-dialog";

import { useUpdateGameMutation } from "../queries";
import type { GameEntry } from "../types/dashboard";
import {
  getBrowseDefaultPath,
  expandSavePath,
  uploadGameLogo,
} from "../services/tauri";
import { norm, msg, toImgSrc } from "../utils";
import {
  CARD,
  FIELD_ERROR,
  FORM_GRID,
  FORM_LABEL,
  GHOST_BTN,
  INPUT_CLS,
  INPUT_ROW,
  LABEL_SPAN,
  MUTED,
  PRIMARY_BTN,
  SECONDARY_BTN,
  TOGGLE_TRACK_ON,
  TOGGLE_TRACK_OFF,
  TOGGLE_THUMB_ON,
  TOGGLE_THUMB_OFF,
} from "./styles";

// ── Unified settings schema ───────────────────────────────────────────────────

const gameSettingsSchema = z.object({
  thumbnail: z
    .string()
    .refine(
      (v) =>
        !v ||
        v.startsWith("https://") ||
        v.startsWith("http://") ||
        /^[A-Za-z]:[\\//]/.test(v),
      "Enter a valid image URL (https://…) or browse a local file.",
    ),
  description: z
    .string()
    .max(1000, "Description must be 1000 characters or fewer."),
  savePath: z.string(),
  trackChanges: z.boolean(),
  autoSync: z.boolean(),
});

type GameSettingsFormValues = z.infer<typeof gameSettingsSchema>;

// ── GameSettingsForm ──────────────────────────────────────────────────────────

interface GameSettingsFormProps {
  game: GameEntry;
  isSyncing: boolean;
  isPathInvalid: boolean;
}

export function GameSettingsForm({
  game,
  isSyncing,
  isPathInvalid,
}: GameSettingsFormProps) {
  const updateMutation = useUpdateGameMutation();

  const [isUploadingLogo, setIsUploadingLogo] = useState(false);
  const [logoUploadError, setLogoUploadError] = useState<string | null>(null);

  const methods = useForm<GameSettingsFormValues>({
    defaultValues: {
      thumbnail: game.thumbnail ?? "",
      description: game.description ?? "",
      savePath: game.savePath ?? "",
      trackChanges: game.trackChanges,
      autoSync: game.autoSync,
    },
    resolver: zodResolver(gameSettingsSchema),
  });

  const {
    handleSubmit,
    reset,
    formState: { isDirty },
  } = methods;

  useEffect(() => {
    reset({
      thumbnail: game.thumbnail ?? "",
      description: game.description ?? "",
      savePath: game.savePath ?? "",
      trackChanges: game.trackChanges,
      autoSync: game.autoSync,
    });
  }, [
    game.id,
    game.thumbnail,
    game.description,
    game.savePath,
    game.trackChanges,
    game.autoSync,
    reset,
  ]);

  async function onSaveSettings(values: GameSettingsFormValues) {
    setLogoUploadError(null);
    const src = norm(values.thumbnail);

    if (methods.formState.dirtyFields.thumbnail && src) {
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

    const trimmed = values.description.trim().slice(0, 1000);
    await updateMutation.mutateAsync({
      ...game,
      thumbnail: src || null,
      description: trimmed || null,
      savePath: norm(values.savePath),
      trackChanges: values.trackChanges,
      autoSync: values.autoSync,
    });
  }

  return (
    <FormProvider {...methods}>
      <form
        onSubmit={handleSubmit(onSaveSettings)}
        className="flex flex-col gap-4"
      >
        {isDirty && (
          <SaveBar
            isSaving={isUploadingLogo || updateMutation.isPending}
            onDiscard={() => reset()}
            error={
              logoUploadError ??
              (updateMutation.isError
                ? msg(updateMutation.error, "Unable to save.")
                : null)
            }
          />
        )}

        {/* Logo / Thumbnail */}
        <ThumbnailSection isSyncing={isSyncing} />

        {/* Description */}
        <DescriptionSection />

        {/* Save folder */}
        <SaveFolderSection
          game={game}
          isSyncing={isSyncing}
          isPathInvalid={isPathInvalid}
        />

        {/* Tracking & Sync */}
        <TrackingSettingsSection isSyncing={isSyncing} />
      </form>
    </FormProvider>
  );
}

// ── SaveBar ───────────────────────────────────────────────────────────────────

interface SaveBarProps {
  isSaving: boolean;
  onDiscard: () => void;
  error: string | null;
}

function SaveBar({ isSaving, onDiscard, error }: SaveBarProps) {
  return (
    <div className="sticky top-0 z-50 mb-5 px-4 py-3 rounded-2xl border border-[rgba(120,180,255,0.25)] bg-[rgba(9,14,28,0.97)] backdrop-blur-sm flex items-center justify-between gap-4 max-[720px]:flex-col max-[720px]:items-stretch">
      <div className="flex items-center gap-3">
        <span className="h-2 w-2 rounded-full bg-[#7dc9ff] shrink-0" />
        <span className="text-sm text-[#c7d3f7]">You have unsaved changes</span>
        {error && <span className="text-sm text-[#ffd5d5]">{error}</span>}
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <button
          type="button"
          className={GHOST_BTN}
          onClick={onDiscard}
          disabled={isSaving}
        >
          Discard
        </button>
        <button type="submit" className={PRIMARY_BTN} disabled={isSaving}>
          {isSaving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

// ── Thumbnail section ─────────────────────────────────────────────────────────

interface ThumbnailSectionProps {
  isSyncing: boolean;
}

function ThumbnailSection({ isSyncing }: ThumbnailSectionProps) {
  const {
    control,
    setValue,
    watch,
    formState: { errors },
  } = useFormContext<GameSettingsFormValues>();
  const thumbnailValue = watch("thumbnail");

  async function handleBrowse() {
    const p = await open({
      multiple: false,
      title: "Choose a thumbnail image",
      filters: [
        { name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] },
      ],
    });
    if (typeof p === "string") {
      setValue("thumbnail", p, { shouldValidate: true, shouldDirty: true });
    }
  }

  return (
    <div className={CARD}>
      <h3 className="m-0 mb-4 font-semibold">Logo / Thumbnail</h3>

      <div className={FORM_GRID}>
        {thumbnailValue && (
          <div className="w-20 h-20 rounded-2xl border border-[rgba(165,185,255,0.1)] bg-[rgba(9,14,28,0.75)] overflow-hidden">
            <img
              src={toImgSrc(thumbnailValue)}
              alt="Thumbnail preview"
              className="w-full h-full object-cover"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
          </div>
        )}

        <Controller
          name="thumbnail"
          control={control}
          render={({ field }) => (
            <label className={FORM_LABEL}>
              <span className={LABEL_SPAN}>URL or local file path</span>
              <div className={INPUT_ROW}>
                <input
                  className={INPUT_CLS}
                  {...field}
                  placeholder="https://… or browse a local file"
                />
                <button
                  type="button"
                  className={SECONDARY_BTN}
                  onClick={handleBrowse}
                  disabled={isSyncing}
                >
                  Browse
                </button>
              </div>
              {errors.thumbnail && (
                <span className={FIELD_ERROR}>{errors.thumbnail.message}</span>
              )}
            </label>
          )}
        />
      </div>
    </div>
  );
}

// ── Description section ───────────────────────────────────────────────────────

function DescriptionSection() {
  const {
    control,
    formState: { errors },
  } = useFormContext<GameSettingsFormValues>();

  return (
    <div className={CARD}>
      <h3 className="m-0 mb-4 font-semibold">Description</h3>
      <div className={FORM_GRID}>
        <Controller
          name="description"
          control={control}
          render={({ field }) => (
            <label className={FORM_LABEL}>
              <span className={LABEL_SPAN}>
                Game description (max 1000 characters)
              </span>
              <textarea
                className={`${INPUT_CLS} resize-y min-h-[60px]`}
                {...field}
                maxLength={1000}
                rows={4}
                placeholder="Brief description of the game…"
              />
              <span className={MUTED + " text-xs mt-1"}>
                {field.value.length}/1000
              </span>
              {errors.description && (
                <span className={FIELD_ERROR}>
                  {errors.description.message}
                </span>
              )}
            </label>
          )}
        />
      </div>
    </div>
  );
}

// ── Save folder section ───────────────────────────────────────────────────────

interface SaveFolderSectionProps {
  game: GameEntry;
  isSyncing: boolean;
  isPathInvalid: boolean;
}

function SaveFolderSection({
  game,
  isSyncing,
  isPathInvalid,
}: SaveFolderSectionProps) {
  const { control, setValue } = useFormContext<GameSettingsFormValues>();

  async function handleBrowse() {
    let defaultPath: string | undefined;
    if (game.savePath) {
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
    if (typeof p === "string") setValue("savePath", p, { shouldDirty: true });
  }

  return (
    <div className={CARD}>
      <h3 className="m-0 mb-4 font-semibold">Save folder mapping</h3>

      {isPathInvalid && (
        <div className="mb-4 p-3 rounded-2xl border border-[rgba(255,100,100,0.3)] bg-[rgba(62,18,22,0.5)] text-[#ff9e9e] text-sm flex items-center gap-2">
          <span>⚠</span> The configured save path does not exist on this
          machine.
        </div>
      )}

      <div className={FORM_GRID}>
        <Controller
          name="savePath"
          control={control}
          render={({ field }) => (
            <label className={FORM_LABEL}>
              <span className={LABEL_SPAN}>Save folder path</span>
              <div className={INPUT_ROW}>
                <input
                  className={INPUT_CLS}
                  {...field}
                  placeholder="Choose or enter the save folder path"
                />
                <button
                  type="button"
                  className={SECONDARY_BTN}
                  onClick={handleBrowse}
                  disabled={isSyncing}
                >
                  Browse
                </button>
              </div>
            </label>
          )}
        />
      </div>
    </div>
  );
}

// ── Tracking & Sync section ───────────────────────────────────────────────────

interface TrackingSettingsSectionProps {
  isSyncing: boolean;
}

function TrackingSettingsSection({ isSyncing }: TrackingSettingsSectionProps) {
  const { control } = useFormContext<GameSettingsFormValues>();

  return (
    <div className={CARD}>
      <h3 className="m-0 mb-4 font-semibold">Tracking & Sync</h3>

      <div className="grid gap-4">
        <Controller
          name="trackChanges"
          control={control}
          render={({ field }) => (
            <ToggleRow
              label="Track file changes"
              description="Watch the save folder for modifications in the background"
              enabled={field.value}
              disabled={isSyncing}
              onChange={field.onChange}
            />
          )}
        />
        <Controller
          name="autoSync"
          control={control}
          render={({ field }) => (
            <ToggleRow
              label="Auto-sync to Google Drive"
              description="Automatically back up saves when changes are detected"
              enabled={field.value}
              disabled={isSyncing}
              onChange={field.onChange}
            />
          )}
        />
      </div>
    </div>
  );
}

// ── ToggleRow ─────────────────────────────────────────────────────────────────

interface ToggleRowProps {
  label: string;
  description: string;
  enabled: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}

function ToggleRow({
  label,
  description,
  enabled,
  disabled,
  onChange,
}: ToggleRowProps) {
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

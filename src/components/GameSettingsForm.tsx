import { ValidatePathsQuery } from "@/queries/dashboard";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { Controller, FormProvider, useFieldArray, useForm, useFormContext, useWatch } from "react-hook-form";
import { z } from "zod";
import { DASHBOARD_KEY, useUpdateGameMutation } from "../queries";
import { contractPath, expandSavePath, getBrowseDefaultPath, getSaveInfo, uploadGameLogo } from "../services/tauri";
import type { DashboardData, GameEntry, SaveInfo } from "../types/dashboard";
import { msg, norm, toImgSrc } from "../utils";
import { SaveFileTree } from "./SaveFileTree";
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
} from "./styles";

// ── Unified settings schema ───────────────────────────────────────────────────

const savePathEntrySchema = z.object({
  label: z.string().min(1, "Label is required"),
  path: z.string(),
  gdriveFolderId: z.string().nullable().optional(),
  syncExcludes: z.array(z.string()),
});

const gameSettingsSchema = z.object({
  thumbnail: z
    .string()
    .refine(
      (v) => !v || v.startsWith("https://") || v.startsWith("http://") || /^[A-Za-z]:[\\/]/.test(v),
      "Enter a valid image URL (https://…) or browse a local file."
    ),
  description: z.string().max(1000, "Description must be 1000 characters or fewer."),  pathMode: z.enum(["auto", "per_device"]),  savePaths: z.array(savePathEntrySchema),
  exeName: z.string().max(260, "Executable name must be 260 characters or fewer."),
  exePath: z.string().optional().nullable(),
  trackChanges: z.boolean(),
  autoSync: z.boolean(),
});

type GameSettingsFormValues = z.infer<typeof gameSettingsSchema>;

// ── GameSettingsForm ──────────────────────────────────────────────────────────

interface GameSettingsFormProps {
  isOpen: boolean;
  isSyncing: boolean;
  id?: string;
}

export function GameSettingsForm({ isOpen, isSyncing, id }: GameSettingsFormProps) {
  const updateMutation = useUpdateGameMutation();

  const [isUploadingLogo, setIsUploadingLogo] = useState(false);

  const [logoUploadError, setLogoUploadError] = useState<string | null>(null);

  const queryClient = useQueryClient();

  const validateQuery = queryClient.getQueryData(ValidatePathsQuery.queryKey);

  const gameSettings = queryClient.getQueryData<DashboardData>(DASHBOARD_KEY)?.games.find((g) => g.id === id);

  const isPathInvalid = gameSettings != null && (validateQuery ?? []).some((v) => v.gameId === gameSettings.id && !v.valid);

  // exePathValid: null = not set, true = ok, false = set but file not found on this machine.
  const exePathValid = (validateQuery ?? []).find((v) => v.gameId === gameSettings?.id)?.exePathValid ?? null;

  const methods = useForm<GameSettingsFormValues>({
    defaultValues: {
      thumbnail: gameSettings?.thumbnail ?? "",
      description: gameSettings?.description ?? "",
      pathMode: gameSettings?.pathMode ?? "auto",
      savePaths: (gameSettings?.savePaths ?? []).map((e) => ({ ...e, path: e.path ?? "", gdriveFolderId: e.gdriveFolderId ?? null })),
      exeName: gameSettings?.exeName ?? "",
      exePath: gameSettings?.exePath ?? "",
      trackChanges: gameSettings?.trackChanges ?? false,
      autoSync: gameSettings?.autoSync ?? false,
    },
    resolver: zodResolver(gameSettingsSchema),
  });

  const { handleSubmit, reset, formState } = methods;
  const { isDirty } = formState;

  useEffect(() => {
    reset({
      thumbnail: gameSettings?.thumbnail ?? "",
      description: gameSettings?.description ?? "",
      pathMode: gameSettings?.pathMode ?? "auto",
      savePaths: (gameSettings?.savePaths ?? []).map((e) => ({ ...e, path: e.path ?? "", gdriveFolderId: e.gdriveFolderId ?? null })),
      exeName: gameSettings?.exeName ?? "",
      exePath: gameSettings?.exePath ?? "",
      trackChanges: gameSettings?.trackChanges ?? false,
      autoSync: gameSettings?.autoSync ?? false,
    });
  }, [gameSettings, reset]);

  async function onSaveSettings(values: GameSettingsFormValues) {
    setLogoUploadError(null);
    const src = norm(values.thumbnail);

    if (!gameSettings) {
      setLogoUploadError("Game not found in cache.");
      return;
    }

    if (methods.formState.dirtyFields.thumbnail && src) {
      setIsUploadingLogo(true);
      try {
        await uploadGameLogo(gameSettings.id, src);
      } catch (err) {
        setLogoUploadError(msg(err, "Logo upload failed."));
        setIsUploadingLogo(false);
        return;
      }
      setIsUploadingLogo(false);
    }

    const trimmed = values.description.trim().slice(0, 1000);
    await updateMutation.mutateAsync({
      ...gameSettings,
      thumbnail: src || null,
      description: trimmed || null,
      pathMode: values.pathMode,
      savePaths: values.savePaths.map((entry) => ({
        label: entry.label,
        path: norm(entry.path),
        gdriveFolderId: entry.gdriveFolderId ?? null,
        syncExcludes: entry.syncExcludes,
      })),
      exeName: values.exeName.trim() || null,
      exePath: norm(values.exePath ?? ""),
      trackChanges: values.trackChanges,
      autoSync: values.autoSync,
    });
  }

  const isSaving = isUploadingLogo || updateMutation.isPending;
  const saveError = logoUploadError ?? (updateMutation.isError ? msg(updateMutation.error, "Unable to save.") : null);

  return (
    <FormProvider {...methods}>
      <form onSubmit={handleSubmit(onSaveSettings)}>
        <div className="flex items-center gap-3 justify-between">
          <h3 className="m-0 font-semibold">Edit settings</h3>
          <div className="flex items-center gap-5 justify-end-safe">
            {isDirty && (
              <>
                <button
                  type="button"
                  className={GHOST_BTN}
                  onClick={() => {
                    reset();
                  }}
                  disabled={isSaving}
                >
                  Discard
                </button>
                <button type="submit" className={PRIMARY_BTN} disabled={isSaving}>
                  {isSaving ? "Saving…" : "Save"}
                </button>
              </>
            )}
          </div>
        </div>

        {isOpen && gameSettings && (
          <div className="flex flex-col gap-5 pt-4">
            <ThumbnailSection isSyncing={isSyncing} />
            <DescriptionSection />
            <SavePathsSection game={gameSettings} isSyncing={isSyncing} isPathInvalid={isPathInvalid} />
            <GameExecutableSection game={gameSettings} exePathValid={exePathValid} />
            <div className="flex items-center gap-3 justify-end">
              {saveError && <span className="text-sm text-[#ffd5d5] mr-auto">{saveError}</span>}
            </div>
          </div>
        )}
      </form>
    </FormProvider>
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
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
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
                <input className={INPUT_CLS} {...field} placeholder="https://… or browse a local file" />
                <button type="button" className={SECONDARY_BTN} onClick={handleBrowse} disabled={isSyncing}>
                  Browse
                </button>
              </div>
              {errors.thumbnail && <span className={FIELD_ERROR}>{errors.thumbnail.message}</span>}
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
              <span className={LABEL_SPAN}>Game description (max 1000 characters)</span>
              <textarea
                className={`${INPUT_CLS} resize-y min-h-15`}
                {...field}
                maxLength={1000}
                rows={4}
                placeholder="Brief description of the game…"
              />
              <span className={MUTED + " text-xs mt-1"}>{field.value.length}/1000</span>
              {errors.description && <span className={FIELD_ERROR}>{errors.description.message}</span>}
            </label>
          )}
        />
      </div>
    </div>
  );
}

// ── Save paths section (multiple) ─────────────────────────────────────────────

interface SavePathsSectionProps {
  game: GameEntry;
  isSyncing: boolean;
  isPathInvalid: boolean;
}

function SavePathsSection({ game, isSyncing, isPathInvalid }: SavePathsSectionProps) {
  const { control, setValue } = useFormContext<GameSettingsFormValues>();
  const { fields, append, remove } = useFieldArray({ control, name: "savePaths" });
  const pathMode = useWatch({ control, name: "pathMode" });

  function handleAdd() {
    append({ label: `Save Folder ${fields.length + 1}`, path: "", gdriveFolderId: null, syncExcludes: [] });
  }

  function handleModeChange(newMode: "auto" | "per_device") {
    if (newMode === pathMode) return;
    setValue("pathMode", newMode, { shouldDirty: true });
    // Clear all path fields — each device must set its own path after switching modes.
    fields.forEach((_, i) => {
      setValue(`savePaths.${i}.path`, "", { shouldDirty: true });
    });
  }

  return (
    <div className={CARD}>
      <div className="flex items-center justify-between mb-4">
        <h3 className="m-0 font-semibold">Save folder mapping</h3>
        <button type="button" className={SECONDARY_BTN} onClick={handleAdd} disabled={isSyncing}>
          + Add save path
        </button>
      </div>

      {/* Path mode selector */}
      <div className="mb-4 flex flex-col gap-2">
        <span className="text-xs font-medium text-[#9aa8c7]">Path storage mode</span>
        <div className="flex rounded-xl bg-[rgba(255,255,255,0.05)] border border-[rgba(165,185,255,0.1)] p-1 gap-1 w-fit">
          <button
            type="button"
            onClick={() => handleModeChange("auto")}
            disabled={isSyncing}
            className={`px-4 py-1.5 rounded-[10px] text-sm font-medium transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed ${
              pathMode === "auto"
                ? "bg-[rgba(109,125,255,0.35)] text-[#d0d8ff]"
                : "text-[#9aa8c7] hover:text-[#c7d3f7]"
            }`}
          >
            Automatic
          </button>
          <button
            type="button"
            onClick={() => handleModeChange("per_device")}
            disabled={isSyncing}
            className={`px-4 py-1.5 rounded-[10px] text-sm font-medium transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed ${
              pathMode === "per_device"
                ? "bg-[rgba(109,125,255,0.35)] text-[#d0d8ff]"
                : "text-[#9aa8c7] hover:text-[#c7d3f7]"
            }`}
          >
            Per device
          </button>
        </div>
        <p className="m-0 text-xs text-[#9aa8c7]">
          {pathMode === "per_device"
            ? "Each device sets its own path locally — paths are not shared across machines."
            : "Paths use portable tokens (e.g. %USERPROFILE%) and are shared across all devices."}
        </p>
      </div>

      {fields.length === 0 && (
        <div className="mb-4 p-3 rounded-2xl border border-[rgba(100,180,255,0.25)] bg-[rgba(9,40,80,0.45)] text-[#7dc9ff] text-sm flex items-start gap-2">
          <span className="mt-0.5 shrink-0">ℹ</span>
          <span>
            No save paths configured. Click <strong>+ Add save path</strong> to add a folder.
          </span>
        </div>
      )}

      {isPathInvalid && fields.length > 0 && (
        <div className="mb-4 p-3 rounded-2xl border border-[rgba(255,100,100,0.3)] bg-[rgba(62,18,22,0.5)] text-[#ff9e9e] text-sm flex items-center gap-2">
          <span>⚠</span> One or more configured save paths do not exist on this machine.
        </div>
      )}

      <div className="flex flex-col">
        {fields.map((field, index) => (
          <SavePathCard
            key={field.id}
            index={index}
            game={game}
            pathMode={pathMode}
            isSyncing={isSyncing}
            onRemove={() => remove(index)}
            canRemove={fields.length > 1}
          />
        ))}
      </div>
    </div>
  );
}

// ── Single save-path card ─────────────────────────────────────────────────────

interface SavePathCardProps {
  index: number;
  game: GameEntry;
  pathMode: "auto" | "per_device";
  isSyncing: boolean;
  onRemove: () => void;
  canRemove: boolean;
}

function SavePathCard({ index, game, pathMode, isSyncing, onRemove, canRemove }: SavePathCardProps) {
  const { control, setValue } = useFormContext<GameSettingsFormValues>();
  const currentPath = useWatch({ control, name: `savePaths.${index}.path` });
  const isPathEmpty = !currentPath;

  async function handleBrowse() {
    let defaultPath: string | undefined;
    const stored = game.savePaths[index]?.path;
    if (stored) {
      const resolved = stored.includes("%") ? await expandSavePath(stored) : stored;
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
    if (typeof p === "string") setValue(`savePaths.${index}.path`, p, { shouldDirty: true });
  }

  return (
    <div className="flex flex-col gap-3 py-4 border-b border-white/8 last:border-b-0">
      <div className="flex items-center justify-between gap-2">
        <Controller
          name={`savePaths.${index}.label`}
          control={control}
          render={({ field }) => (
            <input
              className={INPUT_CLS + " font-medium flex-1"}
              {...field}
              placeholder="Label (e.g. Save Folder, Save States…)"
            />
          )}
        />
        {canRemove && (
          <button
            type="button"
            className="shrink-0 text-sm text-[#ffd5d5] hover:text-white px-2 py-1"
            onClick={onRemove}
            disabled={isSyncing}
            title="Remove this save path"
          >
            Remove
          </button>
        )}
      </div>

      {isPathEmpty && (
        <div className="p-2 rounded-xl border border-[rgba(100,180,255,0.2)] bg-[rgba(9,40,80,0.35)] text-[#7dc9ff] text-xs flex items-start gap-2">
          <span className="mt-0.5 shrink-0">ℹ</span>
          <span>
            No path configured for this device. Use <strong>Browse</strong> to select the folder.
          </span>
        </div>
      )}

      <Controller
        name={`savePaths.${index}.path`}
        control={control}
        render={({ field }) => (
          <label className={FORM_LABEL}>
            <span className="text-[#c7d3f7] text-[0.92rem] flex items-center gap-2">
              Folder path
              {pathMode === "per_device" && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[0.72rem] bg-[rgba(109,125,255,0.15)] text-[#9daeff] border border-[rgba(109,125,255,0.22)]">
                  Device path
                </span>
              )}
            </span>
            <div className={INPUT_ROW}>
              <input className={INPUT_CLS} {...field} placeholder="Choose or enter the save folder path" />
              <button type="button" className={SECONDARY_BTN} onClick={handleBrowse} disabled={isSyncing}>
                Browse
              </button>
            </div>
          </label>
        )}
      />

      <SavePathExclusionsSection index={index} game={game} />
    </div>
  );
}

// ── Per-path exclusions (embedded inside SavePathCard) ────────────────────────

interface SavePathExclusionsSectionProps {
  index: number;
  game: GameEntry;
}

function SavePathExclusionsSection({ index, game }: SavePathExclusionsSectionProps) {
  const { setValue, control } = useFormContext<GameSettingsFormValues>();
  const excluded = useWatch({ control, name: `savePaths.${index}.syncExcludes` }) ?? [];
  const currentPath = useWatch({ control, name: `savePaths.${index}.path` });

  const [saveInfo, setSaveInfo] = useState<SaveInfo | null>(null);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [manualInput, setManualInput] = useState("");

  async function handleLoadFiles() {
    setLoadError(null);
    setIsLoadingFiles(true);
    try {
      const info = await getSaveInfo(game.id);
      // When multi-path, extract only this path's files from pathInfos[index]
      if (info.pathInfos.length > 0 && info.pathInfos[index]) {
        const pi = info.pathInfos[index];
        setSaveInfo({
          gameId: info.gameId,
          savePath: pi.savePath,
          totalFiles: pi.files.length,
          totalSize: pi.totalSize,
          lastModified: null,
          files: pi.files,
          pathInfos: [],
        });
      } else {
        setSaveInfo(info);
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoadingFiles(false);
    }
  }

  function handleToggle(path: string, _isFolder: boolean) {
    const next = excluded.includes(path) ? excluded.filter((e) => e !== path) : [...excluded, path];
    setValue(`savePaths.${index}.syncExcludes`, next, { shouldDirty: true });
  }

  function handleRemove(path: string) {
    setValue(`savePaths.${index}.syncExcludes`, excluded.filter((e) => e !== path), { shouldDirty: true });
  }

  function handleManualAdd() {
    const trimmed = manualInput.trim();
    if (!trimmed || excluded.includes(trimmed)) {
      setManualInput("");
      return;
    }
    setValue(`savePaths.${index}.syncExcludes`, [...excluded, trimmed], { shouldDirty: true });
    setManualInput("");
  }

  return (
    <div className="mt-1">
      <p className="m-0 mb-2 text-xs font-medium text-[#9aa8c7]">Sync exclusions</p>

      {excluded.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-3">
          {excluded.map((ex) => (
            <span
              key={ex}
              className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs bg-[rgba(255,180,80,0.12)] border border-[rgba(255,180,80,0.25)] text-[#ffd5a0]"
            >
              <span className="font-mono truncate max-w-65" title={ex}>{ex}</span>
              <button
                type="button"
                className="shrink-0 text-[#ffd5a0] hover:text-white leading-none"
                onClick={() => handleRemove(ex)}
                title="Remove exclusion"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className={INPUT_ROW + " mb-3"}>
        <input
          className={INPUT_CLS}
          value={manualInput}
          onChange={(e) => setManualInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), handleManualAdd())}
          placeholder="e.g. UserMetaData.sav  or  backup/"
        />
        <button type="button" className={SECONDARY_BTN} onClick={handleManualAdd} disabled={!manualInput.trim()}>
          Add
        </button>
      </div>

      {!saveInfo && (
        <button
          type="button"
          className={SECONDARY_BTN}
          onClick={handleLoadFiles}
          disabled={isLoadingFiles || !currentPath}
          title={!currentPath ? "Set a save folder first" : undefined}
        >
          {isLoadingFiles ? "Loading…" : "Load save files"}
        </button>
      )}
      {loadError && <p className="mt-2 text-xs text-[#ffd5d5]">{loadError}</p>}

      {saveInfo && (
        <>
          <div className="flex items-center justify-between mb-1">
            <p className="m-0 text-xs text-[#9aa8c7]">Check files or folders to exclude from sync.</p>
            <button type="button" className="text-xs text-[#7dc9ff] hover:underline" onClick={() => setSaveInfo(null)}>
              Hide
            </button>
          </div>
          <SaveFileTree info={saveInfo} checkable excluded={excluded} onToggle={handleToggle} />
        </>
      )}
    </div>
  );
}

interface GameExecutableSectionProps {
  game: GameEntry;
  exePathValid: boolean | null;
}

function GameExecutableSection({ game, exePathValid }: GameExecutableSectionProps) {
  const {
    register,
    setValue,
    control,
    formState: { errors },
  } = useFormContext<GameSettingsFormValues>();

  const watchedExeName = useWatch({ control, name: "exeName" });

  async function handleBrowse() {
    let defaultPath: string | undefined;
    if (game.exePath) {
      const resolved = game.exePath.includes("%") ? await expandSavePath(game.exePath) : game.exePath;
      const sep = resolved.lastIndexOf("\\");
      if (sep > 0) defaultPath = resolved.slice(0, sep);
    }
    const p = await open({
      multiple: false,
      title: "Choose the game executable",
      defaultPath,
      filters: [{ name: "Executable", extensions: ["exe"] }],
    });
    if (typeof p === "string") {
      // Tokenize the absolute path for portability (e.g. C:\Program Files\... → %PROGRAMFILES%\...).
      const portable = await contractPath(p);
      setValue("exePath", portable, { shouldDirty: true, shouldValidate: true });
      // Auto-fill the process name from the basename; user can override for launcher vs. process cases.
      const filename = p.split(/[\\/]/).pop() ?? p;
      setValue("exeName", filename, { shouldDirty: true, shouldValidate: true });
    }
  }

  return (
    <div className={CARD}>
      <h3 className="m-0 mb-4 font-semibold">Game Executable</h3>

      {exePathValid === false && (
        <div className="mb-4 p-3 rounded-2xl border border-[rgba(255,100,100,0.3)] bg-[rgba(62,18,22,0.5)] text-[#ff9e9e] text-sm flex items-center gap-2">
          <span>⚠</span> The configured executable was not found on this machine. Update the path below to enable the ▶ Play button.
        </div>
      )}

      <div className={FORM_GRID}>
        {/* Row 1 — launch path */}
        <label className={FORM_LABEL}>
          <span className={LABEL_SPAN}>Executable path</span>
          <div className={INPUT_ROW}>
            <input className={INPUT_CLS} {...register("exePath")} placeholder="e.g. %PROGRAMFILES%\Steam\steamapps\common\Game\Game.exe" />
            <button type="button" className={SECONDARY_BTN} onClick={handleBrowse}>
              Browse
            </button>
          </div>
          <span className={MUTED + " text-xs mt-1"}>
            Full path to the .exe used to launch the game. Enables the ▶ Play button. Stored with env-var tokens (e.g.{" "}
            <code>%PROGRAMFILES%</code>) for portability. <strong className="text-amber-400/80">Saved locally only</strong> — not synced to
            the cloud, since paths differ between devices.
          </span>
        </label>

        {/* Row 2 — process name (auto-filled, user-editable) */}
        <label className={FORM_LABEL}>
          <span className={LABEL_SPAN}>Process name</span>
          <input className={INPUT_CLS} {...register("exeName")} placeholder="e.g. Game.exe" />
          <span className={MUTED + " text-xs mt-1"}>
            {watchedExeName ? (
              <>
                Watcher will track: <strong className="text-white/80">{watchedExeName}</strong>
              </>
            ) : (
              "Auto-filled from the path above. Edit if the launcher differs from the main process. Leave empty to disable tracking."
            )}
          </span>
          {errors.exeName && <span className={FIELD_ERROR}>{errors.exeName.message}</span>}
        </label>
      </div>
    </div>
  );
}


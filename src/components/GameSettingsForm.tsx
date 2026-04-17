import { ValidatePathsQuery } from "@/queries/dashboard";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { Controller, FormProvider, useForm, useFormContext, useWatch } from "react-hook-form";
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

const gameSettingsSchema = z.object({
  thumbnail: z
    .string()
    .refine(
      (v) => !v || v.startsWith("https://") || v.startsWith("http://") || /^[A-Za-z]:[\\/]/.test(v),
      "Enter a valid image URL (https://…) or browse a local file."
    ),
  description: z.string().max(1000, "Description must be 1000 characters or fewer."),
  savePath: z.string(),
  exeName: z.string().max(260, "Executable name must be 260 characters or fewer."),
  exePath: z.string().optional().nullable(),
  trackChanges: z.boolean(),
  autoSync: z.boolean(),
  syncExcludes: z.array(z.string()),
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
      savePath: gameSettings?.savePath ?? "",
      exeName: gameSettings?.exeName ?? "",
      exePath: gameSettings?.exePath ?? "",
      trackChanges: gameSettings?.trackChanges ?? false,
      autoSync: gameSettings?.autoSync ?? false,
      syncExcludes: gameSettings?.syncExcludes ?? [],
    },
    resolver: zodResolver(gameSettingsSchema),
  });

  const { handleSubmit, reset, formState } = methods;
  const { isDirty } = formState;

  useEffect(() => {
    reset({
      thumbnail: gameSettings?.thumbnail ?? "",
      description: gameSettings?.description ?? "",
      savePath: gameSettings?.savePath ?? "",
      exeName: gameSettings?.exeName ?? "",
      exePath: gameSettings?.exePath ?? "",
      trackChanges: gameSettings?.trackChanges ?? false,
      autoSync: gameSettings?.autoSync ?? false,
      syncExcludes: gameSettings?.syncExcludes ?? [],
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
      savePath: norm(values.savePath),
      exeName: values.exeName.trim() || null,
      exePath: norm(values.exePath ?? ""),
      trackChanges: values.trackChanges,
      autoSync: values.autoSync,
      syncExcludes: values.syncExcludes,
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
            <SaveFolderSection game={gameSettings} isSyncing={isSyncing} isPathInvalid={isPathInvalid} />
            <GameExecutableSection game={gameSettings} exePathValid={exePathValid} />
            <SyncExclusionsSection game={gameSettings} />
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

// ── Save folder section ───────────────────────────────────────────────────────

interface SaveFolderSectionProps {
  game: GameEntry;
  isSyncing: boolean;
  isPathInvalid: boolean;
}

function SaveFolderSection({ game, isSyncing, isPathInvalid }: SaveFolderSectionProps) {
  const { control, setValue } = useFormContext<GameSettingsFormValues>();

  async function handleBrowse() {
    let defaultPath: string | undefined;
    if (game.savePath) {
      const resolved = game.savePath.includes("%") ? await expandSavePath(game.savePath) : game.savePath;
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
          <span>⚠</span> The configured save path does not exist on this machine.
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
                <input className={INPUT_CLS} {...field} placeholder="Choose or enter the save folder path" />
                <button type="button" className={SECONDARY_BTN} onClick={handleBrowse} disabled={isSyncing}>
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

// ── Game executable section (unified path + process name) ────────────────────

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

// ── SyncExclusionsSection ─────────────────────────────────────────────────────

interface SyncExclusionsSectionProps {
  game: GameEntry;
}

function SyncExclusionsSection({ game }: SyncExclusionsSectionProps) {
  const { setValue, control } = useFormContext<GameSettingsFormValues>();
  const excluded = useWatch({ control, name: "syncExcludes" });

  const [saveInfo, setSaveInfo] = useState<SaveInfo | null>(null);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [manualInput, setManualInput] = useState("");

  async function handleLoadFiles() {
    setLoadError(null);
    setIsLoadingFiles(true);
    try {
      const info = await getSaveInfo(game.id);
      setSaveInfo(info);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoadingFiles(false);
    }
  }

  function handleToggle(path: string, _isFolder: boolean) {
    const next = excluded.includes(path) ? excluded.filter((e) => e !== path) : [...excluded, path];
    setValue("syncExcludes", next, { shouldDirty: true });
  }

  function handleRemove(path: string) {
    setValue(
      "syncExcludes",
      excluded.filter((e) => e !== path),
      { shouldDirty: true }
    );
  }

  function handleManualAdd() {
    const trimmed = manualInput.trim();
    if (!trimmed || excluded.includes(trimmed)) {
      setManualInput("");
      return;
    }
    setValue("syncExcludes", [...excluded, trimmed], { shouldDirty: true });
    setManualInput("");
  }

  return (
    <div className={CARD}>
      <h3 className="m-0 mb-1 font-semibold">Sync exclusions</h3>
      <p className="m-0 mb-4 text-sm text-[#9aa8c7]">
        Files and folders listed here are skipped during Google Drive sync. Existing Drive copies are deleted when you save.
      </p>

      {/* Current exclusions list */}
      {excluded.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-4">
          {excluded.map((ex) => (
            <span
              key={ex}
              className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs bg-[rgba(255,180,80,0.12)] border border-[rgba(255,180,80,0.25)] text-[#ffd5a0]"
            >
              <span className="font-mono truncate max-w-65" title={ex}>
                {ex}
              </span>
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

      {/* Manual add */}
      <div className={INPUT_ROW + " mb-4"}>
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

      {/* Load files button */}
      {!saveInfo && (
        <button
          type="button"
          className={SECONDARY_BTN}
          onClick={handleLoadFiles}
          disabled={isLoadingFiles || !game.savePath}
          title={!game.savePath ? "Set a save folder first" : undefined}
        >
          {isLoadingFiles ? "Loading…" : "Load save files"}
        </button>
      )}
      {loadError && <p className="mt-2 text-sm text-[#ffd5d5]">{loadError}</p>}

      {/* Interactive file tree */}
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

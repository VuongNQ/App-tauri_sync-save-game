import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import {
  Controller,
  FormProvider,
  useForm,
  useFormContext,
  useWatch,
} from "react-hook-form";
import { z } from "zod";
import { DASHBOARD_KEY, useUpdateGameMutation } from "../queries";
import {
  expandSavePath,
  getBrowseDefaultPath,
  getSaveInfo,
  uploadGameLogo,
} from "../services/tauri";
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
      (v) =>
        !v ||
        v.startsWith("https://") ||
        v.startsWith("http://") ||
        /^[A-Za-z]:[\\/]/.test(v),
      "Enter a valid image URL (https://…) or browse a local file.",
    ),
  description: z
    .string()
    .max(1000, "Description must be 1000 characters or fewer."),
  savePath: z.string(),
  exeName: z.string().max(260, "Executable name must be 260 characters or fewer."),
  trackChanges: z.boolean(),
  autoSync: z.boolean(),
  syncExcludes: z.array(z.string()),
});

type GameSettingsFormValues = z.infer<typeof gameSettingsSchema>;

// ── GameSettingsForm ──────────────────────────────────────────────────────────

interface GameSettingsFormProps {
  isOpen: boolean;
  onToggle: () => void;
  isSyncing: boolean;
  isPathInvalid: boolean;
  id?: string;
}

export function GameSettingsForm({
  isOpen,
  onToggle,
  isSyncing,
  isPathInvalid,
  id,
}: GameSettingsFormProps) {
  const updateMutation = useUpdateGameMutation();

  const [isUploadingLogo, setIsUploadingLogo] = useState(false);

  const [logoUploadError, setLogoUploadError] = useState<string | null>(null);

  const queryClient = useQueryClient();

  const gameSettings = queryClient
    .getQueryData<DashboardData>(DASHBOARD_KEY)
    ?.games.find((g) => g.id === id);

  const methods = useForm<GameSettingsFormValues>({
    defaultValues: {
      thumbnail: gameSettings?.thumbnail ?? "",
      description: gameSettings?.description ?? "",
      savePath: gameSettings?.savePath ?? "",
      exeName: gameSettings?.exeName ?? "",
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
      trackChanges: values.trackChanges,
      autoSync: values.autoSync,
      syncExcludes: values.syncExcludes,
    });
    onToggle();
  }

  const isSaving = isUploadingLogo || updateMutation.isPending;
  const saveError =
    logoUploadError ??
    (updateMutation.isError
      ? msg(updateMutation.error, "Unable to save.")
      : null);

  return (
    <div className={`${CARD} mt-4`}>
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
                      onToggle();
                    }}
                    disabled={isSaving}
                  >
                    Discard
                  </button>
                  <button
                    type="submit"
                    className={PRIMARY_BTN}
                    disabled={isSaving}
                  >
                    {isSaving ? "Saving…" : "Save"}
                  </button>
                </>
              )}
              <span
                className="text-[#7dc9ff] text-lg shrink-0 cursor-pointer"
                onClick={onToggle}
              >
                {isOpen ? "▲" : "▼"}
              </span>
            </div>
          </div>

          {isOpen && gameSettings && (
            <div className="flex flex-col gap-5 pt-4">
              <ThumbnailSection isSyncing={isSyncing} />
              <DescriptionSection />
              <SaveFolderSection
                game={gameSettings}
                isSyncing={isSyncing}
                isPathInvalid={isPathInvalid}
              />
              <ExeNameSection />
              <SyncExclusionsSection game={gameSettings} />
              <div className="flex items-center gap-3 justify-end">
                {saveError && (
                  <span className="text-sm text-[#ffd5d5] mr-auto">
                    {saveError}
                  </span>
                )}
              </div>
            </div>
          )}
        </form>
      </FormProvider>
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

// ── Exe name section ──────────────────────────────────────────────────────────

function ExeNameSection() {
  const {
    register,
    setValue,
    formState: { errors },
  } = useFormContext<GameSettingsFormValues>();

  async function handleBrowse() {
    const p = await open({
      multiple: false,
      title: "Choose the game executable",
      filters: [{ name: "Executable", extensions: ["exe"] }],
    });
    if (typeof p === "string") {
      // Extract only the filename (e.g. "REANIMAL.exe") from the full path.
      const filename = p.split(/[\\/]/).pop() ?? p;
      setValue("exeName", filename, { shouldDirty: true, shouldValidate: true });
    }
  }

  return (
    <div className={CARD}>
      <h3 className="m-0 mb-4 font-semibold">Game Executable</h3>
      <div className={FORM_GRID}>
        <label className={FORM_LABEL}>
          <span className={LABEL_SPAN}>Executable name</span>
          <div className={INPUT_ROW}>
            <input
              className={INPUT_CLS}
              {...register("exeName")}
              placeholder="e.g. REANIMAL.exe"
            />
            <button
              type="button"
              className={SECONDARY_BTN}
              onClick={handleBrowse}
            >
              Browse
            </button>
          </div>
          <span className={MUTED + " text-xs mt-1"}>
            The process name to watch. Sync triggers automatically when this
            process exits. Leave empty to disable process tracking.
          </span>
          {errors.exeName && (
            <span className={FIELD_ERROR}>{errors.exeName.message}</span>
          )}
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
    const next = excluded.includes(path)
      ? excluded.filter((e) => e !== path)
      : [...excluded, path];
    setValue("syncExcludes", next, { shouldDirty: true });
  }

  function handleRemove(path: string) {
    setValue(
      "syncExcludes",
      excluded.filter((e) => e !== path),
      { shouldDirty: true },
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
        Files and folders listed here are skipped during Google Drive sync.
        Existing Drive copies are deleted when you save.
      </p>

      {/* Current exclusions list */}
      {excluded.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-4">
          {excluded.map((ex) => (
            <span
              key={ex}
              className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs bg-[rgba(255,180,80,0.12)] border border-[rgba(255,180,80,0.25)] text-[#ffd5a0]"
            >
              <span className="font-mono truncate max-w-[260px]" title={ex}>
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
          onKeyDown={(e) =>
            e.key === "Enter" && (e.preventDefault(), handleManualAdd())
          }
          placeholder="e.g. UserMetaData.sav  or  backup/"
        />
        <button
          type="button"
          className={SECONDARY_BTN}
          onClick={handleManualAdd}
          disabled={!manualInput.trim()}
        >
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
            <p className="m-0 text-xs text-[#9aa8c7]">
              Check files or folders to exclude from sync.
            </p>
            <button
              type="button"
              className="text-xs text-[#7dc9ff] hover:underline"
              onClick={() => setSaveInfo(null)}
            >
              Hide
            </button>
          </div>
          <SaveFileTree
            info={saveInfo}
            checkable
            excluded={excluded}
            onToggle={handleToggle}
          />
        </>
      )}
    </div>
  );
}

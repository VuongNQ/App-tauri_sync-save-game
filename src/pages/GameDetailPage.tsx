import { useEffect, useState } from "react";
import { useForm, useFormContext, FormProvider, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useParams, Link, useNavigate } from "react-router";
import { open } from "@tauri-apps/plugin-dialog";

import {
  useDashboardQuery,
  useRemoveGameMutation,
  useUpdateGameMutation,
  useGetSaveInfoMutation,
  useSyncGameMutation,
  useValidatePathsQuery,
  useCheckSyncDiffMutation,
  useRestoreFromCloudMutation,
  usePushToCloudMutation,
} from "../queries";
import type { GameEntry } from "../types/dashboard";
import type { SaveInfo, SyncStructureDiff } from "../types/dashboard";
import { getBrowseDefaultPath, expandSavePath, uploadGameLogo } from "../services/tauri";
import { norm, msg, formatLocalTime, toImgSrc } from "../utils";
import { ConfirmModal } from "../components/ConfirmModal";
import { DriveFilesSection } from "../components/DriveFilesSection";
import { Toast } from "../components/Toast";
import { VersionBackupsSection } from "../components/VersionBackupsSection";
import {
  CARD,
  DANGER_BTN,
  EYEBROW,
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
  SOFT_BADGE,
  SOURCE_BADGE,
  TOGGLE_TRACK_ON,
  TOGGLE_TRACK_OFF,
  TOGGLE_THUMB_ON,
  TOGGLE_THUMB_OFF,
} from "../components/styles";

// ── Unified settings schema ───────────────────────────────────────────────────

const gameSettingsSchema = z.object({
  thumbnail: z.string().refine(
    (v) =>
      !v ||
      v.startsWith("https://") ||
      v.startsWith("http://") ||
      /^[A-Za-z]:[\\//]/.test(v),
    "Enter a valid image URL (https://…) or browse a local file.",
  ),
  description: z.string().max(1000, "Description must be 1000 characters or fewer."),
  savePath: z.string(),
  trackChanges: z.boolean(),
  autoSync: z.boolean(),
});

type GameSettingsFormValues = z.infer<typeof gameSettingsSchema>;

export function GameDetailPage() {
  const { id } = useParams<{ id: string }>();

  const navigate = useNavigate();

  const { data: dashboard } = useDashboardQuery();

  const updateMutation = useUpdateGameMutation();

  const removeMutation = useRemoveGameMutation();

  const [showRemoveModal, setShowRemoveModal] = useState(false);

  const game = dashboard?.games.find((g) => g.id === id) ?? null;

  const [isUploadingLogo, setIsUploadingLogo] = useState(false);
  const [logoUploadError, setLogoUploadError] = useState<string | null>(null);

  const saveInfoMutation = useGetSaveInfoMutation();

  const syncMutation = useSyncGameMutation();

  const validateQuery = useValidatePathsQuery();

  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);

  const restoreFlow = useRestoreFromDriveFlow(id ?? "", setToast);

  const isSyncing = syncMutation.isPending || restoreFlow.isChecking || restoreFlow.isExecuting;

  const methods = useForm<GameSettingsFormValues>({
    defaultValues: {
      thumbnail: game?.thumbnail ?? "",
      description: game?.description ?? "",
      savePath: game?.savePath ?? "",
      trackChanges: game?.trackChanges ?? false,
      autoSync: game?.autoSync ?? false,
    },
    resolver: zodResolver(gameSettingsSchema),
  });

  const { handleSubmit, reset, formState: { isDirty } } = methods;

  useEffect(() => {
    reset({
      thumbnail: game?.thumbnail ?? "",
      description: game?.description ?? "",
      savePath: game?.savePath ?? "",
      trackChanges: game?.trackChanges ?? false,
      autoSync: game?.autoSync ?? false,
    });
  }, [game?.id, game?.thumbnail, game?.description, game?.savePath, game?.trackChanges, game?.autoSync, reset]);

  const isPathInvalid =
    game != null &&
    (validateQuery.data ?? []).some((v) => v.gameId === game.id && !v.valid);

  if (!game) {
    return (
      <div className={`${CARD} text-center`}>
        <p className="text-[1.1rem]">Game not found.</p>
        <Link to="/" className="text-[#7dc9ff] underline">
          Back to dashboard
        </Link>
      </div>
    );
  }

  const sourceBadge = SOURCE_BADGE[game.source] ?? SOFT_BADGE;

  async function onSaveSettings(values: GameSettingsFormValues) {
    if (!game) return;
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
    <>
      {/* Breadcrumb */}
      <div>
        <Link to="/" className="text-[#7dc9ff] text-sm hover:underline">
          ← Back to library
        </Link>
      </div>

      {/* Header */}
      <div className={CARD}>
        <div className="flex items-start gap-5 mb-5">
          {/* Thumbnail */}
          <div className="w-24 h-24 shrink-0 rounded-2xl border border-[rgba(165,185,255,0.1)] bg-[rgba(9,14,28,0.75)] overflow-hidden">
            {game.thumbnail ? (
              <img
                src={toImgSrc(game.thumbnail)}
                alt={game.name}
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="grid place-items-center w-full h-full text-[#9aa8c7] text-3xl">
                🎮
              </div>
            )}
          </div>

          <div className="grid gap-2">
            <p className={EYEBROW}>Game details</p>
            <h2 className="m-0">{game.name}</h2>
            <span className={sourceBadge}>{game.source}</span>
            {game.description && (
              <p className="m-0 text-sm text-[#9aa8c7] max-w-[480px] whitespace-pre-wrap">
                {game.description}
              </p>
            )}
          </div>
        </div>

        {/* Metadata grid */}
        <dl className="grid gap-[14px] grid-cols-2 m-0 max-[720px]:grid-cols-1">
          {[
            { label: "Save folder", value: game.savePath ?? "Not set" },
            { label: "Last local save", value: formatLocalTime(game.lastLocalModified) },
            { label: "Last cloud save", value: formatLocalTime(game.lastCloudModified) },
            { label: "Google Drive folder", value: game.gdriveFolderId ?? "Not synced" },
          ].map(({ label, value }) => (
            <div
              key={label}
              className="p-[18px] rounded-[18px] bg-[rgba(9,14,28,0.75)] border border-[rgba(165,185,255,0.08)]"
            >
              <dt className="mb-2 text-[#c7d3f7] text-[0.92rem]">{label}</dt>
              <dd className="m-0 break-words text-[#9aa8c7]">{value}</dd>
            </div>
          ))}
        </dl>
      </div>

      {/* Settings form */}
      <FormProvider {...methods}>
        <form onSubmit={handleSubmit(onSaveSettings)}>
          {isDirty && (
            <SaveBar
              isSaving={isUploadingLogo || updateMutation.isPending}
              onDiscard={() => reset()}
              error={logoUploadError ?? (updateMutation.isError ? msg(updateMutation.error, "Unable to save.") : null)}
            />
          )}

          {/* Logo / Thumbnail */}
          <ThumbnailSection isSyncing={isSyncing} />

          {/* Description */}
          <DescriptionSection />

          {/* Save folder */}
          <SaveFolderSection game={game} isSyncing={isSyncing} isPathInvalid={isPathInvalid} />

          {/* Tracking & Sync */}
          <TrackingSettingsSection isSyncing={isSyncing} />
        </form>
      </FormProvider>

      {/* Actions */}
      <div className={CARD}>
        <h3 className="m-0 mb-4 font-semibold">Actions</h3>

        <div className="grid gap-4 grid-cols-3 max-[900px]:grid-cols-1">
          <button
            className={SECONDARY_BTN}
            type="button"
            disabled={!game.savePath || saveInfoMutation.isPending || isSyncing}
            onClick={() => game.savePath && saveInfoMutation.mutate(game.id)}
          >
            {saveInfoMutation.isPending ? "Loading…" : "Get save info"}
          </button>
          <button
            className={SECONDARY_BTN}
            type="button"
            disabled={!game.savePath || isSyncing}
            onClick={() => game.savePath && restoreFlow.start()}
          >
            {restoreFlow.isChecking ? "Checking…" : "Restore from Drive"}
          </button>
          <button
            className={`${PRIMARY_BTN} inline-flex items-center justify-center gap-2`}
            type="button"
            disabled={!game.savePath || isSyncing}
            onClick={() =>
              game.savePath &&
              syncMutation.mutate(game.id, {
                onSuccess: (data) => {
                  if (data.error) {
                    setToast({ message: data.error, type: "error" });
                  } else {
                    setToast({
                      message: `Sync complete — ↑${data.uploaded} ↓${data.downloaded} file(s)`,
                      type: "success",
                    });
                  }
                },
                onError: (err) => {
                  setToast({ message: msg(err, "Sync failed."), type: "error" });
                },
              })
            }
          >
            {isSyncing ? (
              <>
                <svg
                  className="animate-spin h-4 w-4 shrink-0"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                  />
                </svg>
                Syncing…
              </>
            ) : (
              "Sync to Google Drive"
            )}
          </button>
        </div>

        {/* Save Info Result */}
        {saveInfoMutation.data && (
          <SaveInfoPanel info={saveInfoMutation.data} />
        )}
        {saveInfoMutation.isError && (
          <p className="m-0 mt-3 text-sm text-[#ffd5d5]">
            {msg(saveInfoMutation.error, "Unable to get save info.")}
          </p>
        )}

        {/* Sync Result */}
        {syncMutation.data && (
          <SyncResultPanel result={syncMutation.data} />
        )}
        {syncMutation.isError && (
          <p className="m-0 mt-3 text-sm text-[#ffd5d5]">
            {msg(syncMutation.error, "Sync failed.")}
          </p>
        )}
      </div>

      {/* Drive file manager */}
      {game.gdriveFolderId && (
        <DriveFilesSection gameId={game.id} gameFolderId={game.gdriveFolderId} />
      )}

      {/* Version backups */}
      {game.gdriveFolderId && (
        <VersionBackupsSection gameId={game.id} />
      )}

      {/* Danger zone */}
      <div className={CARD}>
        <h3 className="m-0 mb-4 font-semibold text-[#ff9e9e]">Danger zone</h3>
        <button
          className={DANGER_BTN}
          type="button"
          disabled={removeMutation.isPending || isSyncing}
          onClick={() => setShowRemoveModal(true)}
        >
          {removeMutation.isPending ? "Removing…" : "Remove game"}
        </button>
        {removeMutation.isError && (
          <p className="m-0 mt-3 text-sm text-[#ffd5d5]">
            {msg(removeMutation.error, "Unable to remove game.")}
          </p>
        )}
      </div>

      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onDismiss={() => setToast(null)}
        />
      )}

      {restoreFlow.syncDiff && (
        <SyncConflictModal
          open={restoreFlow.showModal}
          diff={restoreFlow.syncDiff}
          onConfirm={(method) => restoreFlow.executeMethod(method)}
          onCancel={restoreFlow.closeModal}
        />
      )}

      <ConfirmModal
        open={showRemoveModal}
        title="Remove game"
        message={`Are you sure you want to remove "${game.name}" from your library? This cannot be undone.`}
        confirmLabel="Remove"
        onConfirm={() => {
          setShowRemoveModal(false);
          removeMutation.mutate(game.id, { onSuccess: () => navigate("/", { replace: true }) });
        }}
        onCancel={() => setShowRemoveModal(false)}
      />
    </>
  );
}

// ── Co-located components ─────────────────────────────────────────────────────

interface ToggleRowProps {
  label: string;
  description: string;
  enabled: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}

function ToggleRow({ label, description, enabled, disabled, onChange }: ToggleRowProps) {
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

function SaveInfoPanel({ info }: { info: SaveInfo }) {
  return (
    <div className="mt-4 p-4 rounded-[18px] bg-[rgba(9,14,28,0.75)] border border-[rgba(165,185,255,0.08)]">
      <p className={EYEBROW}>Local save info</p>
      <dl className="grid gap-2 grid-cols-2 m-0 max-[720px]:grid-cols-1">
        <div>
          <dt className="text-[#c7d3f7] text-sm">Total files</dt>
          <dd className={`${MUTED} m-0`}>{info.totalFiles}</dd>
        </div>
        <div>
          <dt className="text-[#c7d3f7] text-sm">Total size</dt>
          <dd className={`${MUTED} m-0`}>{formatBytes(info.totalSize)}</dd>
        </div>
        <div>
          <dt className="text-[#c7d3f7] text-sm">Last modified</dt>
          <dd className={`${MUTED} m-0`}>{info.lastModified ?? "N/A"}</dd>
        </div>
        <div>
          <dt className="text-[#c7d3f7] text-sm">Save path</dt>
          <dd className={`${MUTED} m-0 break-all text-xs`}>{info.savePath}</dd>
        </div>
      </dl>
      {info.files.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm text-[#7dc9ff]">
            Show files ({info.files.length})
          </summary>
          <ul className="mt-2 list-none p-0 grid gap-1 max-h-[240px] overflow-y-auto">
            {info.files.map((f) => (
              <li
                key={f.relativePath}
                className="flex items-center justify-between gap-2 text-xs px-2 py-1 rounded-lg bg-[rgba(255,255,255,0.03)]"
              >
                <span className="text-[#c7d3f7] truncate">{f.relativePath}</span>
                <span className={MUTED}>{formatBytes(f.size)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function SyncResultPanel({ result }: { result: { uploaded: number; downloaded: number; skipped: number; error: string | null } }) {
  return (
    <div className={`mt-4 p-4 rounded-[18px] border ${result.error ? "bg-[rgba(40,10,10,0.75)] border-[rgba(255,120,120,0.2)]" : "bg-[rgba(9,14,28,0.75)] border-[rgba(165,185,255,0.08)]"}`}>
      <p className={EYEBROW}>{result.error ? "Sync error" : "Sync complete"}</p>
      {result.error ? (
        <p className="m-0 text-sm text-[#ffd5d5]">{result.error}</p>
      ) : (
        <dl className="grid gap-2 grid-cols-3 m-0">
          <div>
            <dt className="text-[#c7d3f7] text-sm">Uploaded</dt>
            <dd className={`${MUTED} m-0`}>{result.uploaded}</dd>
          </div>
          <div>
            <dt className="text-[#c7d3f7] text-sm">Downloaded</dt>
            <dd className={`${MUTED} m-0`}>{result.downloaded}</dd>
          </div>
          <div>
            <dt className="text-[#c7d3f7] text-sm">Skipped</dt>
            <dd className={`${MUTED} m-0`}>{result.skipped}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
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
        <button type="button" className={GHOST_BTN} onClick={onDiscard} disabled={isSaving}>
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
  const { control, setValue, watch, formState: { errors } } = useFormContext<GameSettingsFormValues>();
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
  const { control, formState: { errors } } = useFormContext<GameSettingsFormValues>();

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
                className={`${INPUT_CLS} resize-y min-h-[60px]`}
                {...field}
                maxLength={1000}
                rows={4}
                placeholder="Brief description of the game…"
              />
              <span className={MUTED + " text-xs mt-1"}>{field.value.length}/1000</span>
              {errors.description && (
                <span className={FIELD_ERROR}>{errors.description.message}</span>
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

function SaveFolderSection({ game, isSyncing, isPathInvalid }: SaveFolderSectionProps) {
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

// ── useRestoreFromDriveFlow ───────────────────────────────────────────────────

type SyncMethod = "auto" | "restore" | "push";

function useRestoreFromDriveFlow(
  gameId: string,
  setToast: (t: { message: string; type: "success" | "error" } | null) => void,
) {
  const [showModal, setShowModal] = useState(false);
  const [syncDiff, setSyncDiff] = useState<SyncStructureDiff | null>(null);

  const checkDiffMutation = useCheckSyncDiffMutation();
  const restoreMutation = useRestoreFromCloudMutation();
  const pushMutation = usePushToCloudMutation();
  const syncMutation = useSyncGameMutation();

  const isChecking = checkDiffMutation.isPending;
  const isExecuting =
    restoreMutation.isPending || pushMutation.isPending || syncMutation.isPending;

  function start() {
    checkDiffMutation.mutate(gameId, {
      onSuccess: (diff) => {
        if (!diff.cloudHasData) {
          setToast({
            message: "No cloud saves found. Sync to Drive first.",
            type: "error",
          });
          return;
        }
        if (!diff.hasDiff) {
          setToast({
            message: "Drive and local are already identical — nothing to restore.",
            type: "success",
          });
          return;
        }
        setSyncDiff(diff);
        setShowModal(true);
      },
      onError: (err) => {
        setToast({ message: msg(err, "Failed to check sync status."), type: "error" });
      },
    });
  }

  function closeModal() {
    setShowModal(false);
  }

  function executeMethod(method: SyncMethod) {
    setShowModal(false);
    if (method === "auto") {
      syncMutation.mutate(gameId, {
        onSuccess: (data) => {
          if (data.error) setToast({ message: data.error, type: "error" });
          else
            setToast({
              message: `Sync complete — ↑${data.uploaded} ↓${data.downloaded} file(s)`,
              type: "success",
            });
        },
        onError: (err) => setToast({ message: msg(err, "Sync failed."), type: "error" }),
      });
    } else if (method === "restore") {
      restoreMutation.mutate(gameId, {
        onSuccess: (data) => {
          if (data.error) setToast({ message: data.error, type: "error" });
          else
            setToast({
              message: `Restore complete — ↓${data.downloaded} file(s) downloaded`,
              type: "success",
            });
        },
        onError: (err) => setToast({ message: msg(err, "Restore failed."), type: "error" }),
      });
    } else {
      pushMutation.mutate(gameId, {
        onSuccess: (data) => {
          if (data.error) setToast({ message: data.error, type: "error" });
          else
            setToast({
              message: `Push complete — ↑${data.uploaded} file(s) uploaded`,
              type: "success",
            });
        },
        onError: (err) =>
          setToast({ message: msg(err, "Push to Drive failed."), type: "error" }),
      });
    }
  }

  return { start, isChecking, isExecuting, syncDiff, showModal, closeModal, executeMethod };
}

// ── SyncConflictModal ─────────────────────────────────────────────────────────

interface SyncConflictModalProps {
  open: boolean;
  diff: SyncStructureDiff;
  onConfirm: (method: SyncMethod) => void;
  onCancel: () => void;
}

function SyncConflictModal({ open, diff, onConfirm, onCancel }: SyncConflictModalProps) {
  const [selected, setSelected] = useState<SyncMethod>("auto");

  if (!open) return null;

  const rows: Array<{ label: string; count: number; warn?: boolean }> = [
    { label: "Local files not on Drive", count: diff.localOnlyFiles.length },
    { label: "Drive files not found locally", count: diff.cloudOnlyFiles.length },
    { label: "Local files newer than Drive", count: diff.localNewerFiles.length, warn: true },
    { label: "Drive files newer than local", count: diff.cloudNewerFiles.length, warn: true },
  ].filter((r) => r.count > 0);

  const methods: Array<{ value: SyncMethod; label: string; description: string }> = [
    {
      value: "auto",
      label: "Auto-sync (newest wins)",
      description: "Each file keeps whichever version was modified most recently.",
    },
    {
      value: "restore",
      label: "Restore from Drive",
      description: "Overwrite local files with the Drive version — even if local is newer.",
    },
    {
      value: "push",
      label: "Push local to Drive",
      description: "Overwrite Drive files with local versions — even if Drive is newer.",
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-[480px] rounded-3xl border border-[rgba(165,185,255,0.15)] bg-[rgba(9,14,28,0.97)] p-6 shadow-2xl grid gap-5">
        {/* Header */}
        <div>
          <p className={EYEBROW}>Sync conflict detected</p>
          <h3 className="m-0 mt-1">Local and Drive differ</h3>
        </div>

        {/* Diff summary */}
        <div className="grid gap-2">
          {rows.map((r) => (
            <div
              key={r.label}
              className={`flex items-center justify-between gap-3 px-4 py-2 rounded-2xl border text-sm ${
                r.warn
                  ? "border-[rgba(255,180,80,0.2)] bg-[rgba(40,28,10,0.6)] text-[#ffd5a0]"
                  : "border-[rgba(165,185,255,0.08)] bg-[rgba(255,255,255,0.02)] text-[#c7d3f7]"
              }`}
            >
              <span>{r.label}</span>
              <span className="font-semibold tabular-nums">{r.count}</span>
            </div>
          ))}
        </div>

        {/* Method picker */}
        <div className="grid gap-2">
          <p className={`${MUTED} text-xs uppercase tracking-wider`}>Choose sync method</p>
          {methods.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => setSelected(m.value)}
              className={`text-left p-4 rounded-2xl border transition-colors ${
                selected === m.value
                  ? "border-[rgba(125,201,255,0.5)] bg-[rgba(125,201,255,0.08)]"
                  : "border-[rgba(165,185,255,0.08)] bg-[rgba(255,255,255,0.02)] hover:border-[rgba(165,185,255,0.2)]"
              }`}
            >
              <p className="m-0 font-medium text-[#c7d3f7] text-sm">{m.label}</p>
              <p className={`${MUTED} m-0 text-xs mt-0.5`}>{m.description}</p>
            </button>
          ))}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3">
          <button type="button" className={GHOST_BTN} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={PRIMARY_BTN}
            onClick={() => onConfirm(selected)}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

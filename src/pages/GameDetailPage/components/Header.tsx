import { CARD, EYEBROW, GHOST_BTN, PRIMARY_BTN, SOFT_BADGE, SOURCE_BADGE } from "@/components/styles";
import { GameThumbnail } from "@/components/GameThumbnail";
import { richText, useT } from "@/i18n";
import { DashboardQuery, ValidatePathsQuery } from "@/queries/dashboard";
import { useGamePlaying, useSyncAndLaunchFlow } from "@/queries/detail";
import { createDesktopShortcut, getLaunchShortcutUrl } from "@/services/tauri";
import { formatBytes, formatDuration, formatLocalTime } from "@/utils";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router";

const Header = ({ setActiveTab }: { setActiveTab: (tab: "status" | "config") => void }) => {
  const { id } = useParams<{ id: string }>();

  const queryClient = useQueryClient();
  const t = useT();

  const game = queryClient.getQueryData(DashboardQuery.queryKey)?.games.find((g) => g.id === id);

  const validateQuery = queryClient.getQueryData(ValidatePathsQuery.queryKey);
  const exeValidation = validateQuery?.find((v) => v.gameId === id);
  // exePathValid: null = not set, true = ok, false = set but file not found
  const exePathValid = exeValidation?.exePathValid ?? null;

  const [launchError, setLaunchError] = useState<string | null>(null);
  const [canForceAfterError, setCanForceAfterError] = useState(false);

  const flow = useSyncAndLaunchFlow({
    onError: (msg, canForce) => {
      setLaunchError(msg);
      setCanForceAfterError(canForce);
    },
  });
  const { data: isGamePlaying = false } = useGamePlaying(id ?? "");
  const [shortcutNote, setShortcutNote] = useState<{ ok: boolean; text: string } | null>(null);

  const sourceBadge = game ? SOURCE_BADGE[game.source] : SOFT_BADGE;

  if (!game) return null;

  // Can only launch if exe_path is set AND validated as present on this machine.
  const canLaunch = !!game.exePath && exePathValid !== false;

  function handlePlay() {
    setLaunchError(null);
    setCanForceAfterError(false);
    flow.start(game!);
  }

  function handleForceLaunch() {
    setLaunchError(null);
    setCanForceAfterError(false);
    flow.forceLaunch(game!.id);
  }

  async function handleCreateShortcut() {
    setShortcutNote(null);
    try {
      const path = await createDesktopShortcut(game!.id);
      setShortcutNote({ ok: true, text: t("header.shortcutCreated", { path }) });
    } catch (err) {
      setShortcutNote({ ok: false, text: err instanceof Error ? err.message : String(err) });
    }
  }

  async function handleCopyLink() {
    setShortcutNote(null);
    try {
      const url = await getLaunchShortcutUrl(game!.id);
      await navigator.clipboard.writeText(url);
      setShortcutNote({ ok: true, text: t("header.linkCopied", { url }) });
    } catch (err) {
      setShortcutNote({ ok: false, text: err instanceof Error ? err.message : String(err) });
    }
  }

  const playLabel = flow.phase === "syncing" ? t("play.syncing") : flow.phase === "launching" ? t("play.launching") : `▶ ${t("play.play")}`;

  return (
    <div className={CARD}>
      <div className="flex items-start gap-5 mb-5">
        {/* Thumbnail */}
        <div className="w-24 h-24 shrink-0 rounded-2xl border border-[rgba(165,185,255,0.1)] bg-[rgba(9,14,28,0.75)] overflow-hidden">
          {game.thumbnail ? (
            <GameThumbnail src={game.thumbnail} alt={game.name} className="w-full h-full object-cover" />
          ) : (
            <div className="grid place-items-center w-full h-full text-[#9aa8c7] text-3xl">🎮</div>
          )}
        </div>

        <div className="grid gap-2 flex-1 min-w-0">
          <p className={EYEBROW}>{t("header.eyebrow")}</p>
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="m-0">{game.name}</h2>
            <span className={sourceBadge}>{t(game.source === "emulator" ? "source.emulator" : "source.manual")}</span>
            {isGamePlaying && (
              <span className="inline-flex items-center gap-1 rounded-full border border-[rgba(120,230,170,0.35)] bg-[rgba(70,220,150,0.14)] px-2 py-0.5 text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-[#8ff5c2]">
                <span className="h-1.5 w-1.5 rounded-full bg-[#8ff5c2] animate-pulse" />
                {t("game.playing")}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap text-sm text-[#9aa8c7]">
            <span className="text-[#c7d3f7]">{t("header.totalPlayTime")}</span>
            <span>{formatDuration(game.totalPlayTimeSeconds)}</span>
          </div>
          {game.description && (
            <details className="group [&_p]:group-open:line-clamp-none [&_p]:line-clamp-3">
              <summary className="text-sm text-[#9aa8c7] cursor-pointer pb-2">{t("header.viewDescription")}</summary>
              <p className="m-0 text-sm text-[#9aa8c7] whitespace-pre-wrap">{game.description}</p>
            </details>
          )}
        </div>

        {/* Play button */}
        <div className="flex flex-col items-end gap-2 shrink-0">
          <button
            type="button"
            className={`${PRIMARY_BTN} w-auto px-6`}
            disabled={!canLaunch || flow.isPending || isGamePlaying}
            title={
              isGamePlaying
                ? t("play.running")
                : !game.exePath
                  ? t("header.playNoExe")
                  : exePathValid === false
                    ? t("play.exeMissingHint")
                    : t("header.playHint")
            }
            onClick={handlePlay}
          >
            {isGamePlaying ? `🎮 ${t("game.playing")}` : playLabel}
          </button>
          {canLaunch && (
            <div className="flex gap-1.5">
              <button
                type="button"
                className={`${GHOST_BTN} text-xs min-h-8 px-3`}
                title={t("header.shortcutHint")}
                onClick={() => void handleCreateShortcut()}
              >
                {t("header.shortcut")}
              </button>
              <button
                type="button"
                className={`${GHOST_BTN} text-xs min-h-8 px-3`}
                title={t("header.copyLinkHint")}
                onClick={() => void handleCopyLink()}
              >
                {t("header.copyLink")}
              </button>
            </div>
          )}
          {shortcutNote && (
            <span className={`text-xs text-right max-w-[240px] break-all ${shortcutNote.ok ? "text-[#8ff5c2]" : "text-[#ff9e9e]"}`}>
              {shortcutNote.text}
            </span>
          )}
          {!game.exePath && <span className="text-xs text-[#9aa8c7] text-right max-w-[140px]">{t("header.setExe")}</span>}
          {game.exePath && exePathValid === false && (
            <span className="text-xs text-[#ff9e9e] text-right max-w-[160px]">⚠ {t("games.warnExeMissing")}</span>
          )}
          {launchError && (
            <div className="flex flex-col items-end gap-1.5 max-w-[220px]">
              <span className="text-xs text-[#ff9e9e] text-right">{launchError}</span>
              {canForceAfterError && (
                <button type="button" className={`${GHOST_BTN} text-xs min-h-8 px-3`} onClick={handleForceLaunch}>
                  {t("play.launchAnyway")}
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Metadata grid */}
      <dl className="grid gap-3.5 grid-cols-2 m-0 max-[720px]:grid-cols-1">
        {[
          {
            label: t("header.saveFolder"),
            value:
              game.savePaths.length === 0 ? (
                t("header.notSet")
              ) : (
                <ul className="m-0 p-0 list-none flex flex-col gap-2">
                  {game.savePaths.map((sp, i) => (
                    <li key={i} className="flex flex-col gap-0.5">
                      {game.savePaths.length > 1 && <span className="text-[0.78rem] text-[#c7d3f7] font-medium">{sp.label}</span>}
                      <span>{sp.path ?? <em className="not-italic text-[#ff9e9e] text-xs">{t("header.notSetOnDevice")}</em>}</span>
                    </li>
                  ))}
                </ul>
              ),
          },
          {
            label: t("header.driveFolder"),
            value: game.gdriveFolderId ?? t("header.notSynced"),
          },
          {
            label: t("header.lastCloudSave"),
            value: formatLocalTime(game.lastCloudModified),
          },
          {
            label: t("header.driveStorage"),
            value: game.cloudStorageBytes != null ? formatBytes(game.cloudStorageBytes) : t("header.neverSynced"),
          },
        ].map(({ label, value }) => (
          <div key={label} className="p-4.5 rounded-[18px] bg-[rgba(9,14,28,0.75)] border border-[rgba(165,185,255,0.08)]">
            <dt className="mb-2 text-[#c7d3f7] text-[0.92rem]">{label}</dt>
            <dd className="m-0 wrap-break-word text-[#9aa8c7]">{value}</dd>
          </div>
        ))}
      </dl>

      {/* No-exe warning */}
      {game.trackChanges && !game.exeName && (
        <div className="mt-4 px-4 py-3 rounded-2xl border border-[rgba(255,200,80,0.3)] bg-[rgba(62,45,12,0.55)] text-[#ffd5a0] text-sm flex items-center gap-2">
          <span>⚠</span>
          <span>
            <strong>{t("header.warnNoExeNameTitle")}</strong>{" "}
            {richText(t("header.warnNoExeNameBody"), {
              tab: (
                <button
                  type="button"
                  className="underline text-[#ffd5a0] bg-transparent border-0 p-0 cursor-pointer"
                  onClick={() => setActiveTab("config")}
                >
                  {t("detail.tabConfig")}
                </button>
              ),
            })}
          </span>
        </div>
      )}

      {/* Exe-path not configured on this device */}
      {game.trackChanges && !game.exePath && (
        <div className="mt-4 px-4 py-3 rounded-2xl border border-[rgba(255,200,80,0.3)] bg-[rgba(62,45,12,0.55)] text-[#ffd5a0] text-sm flex items-center gap-2">
          <span>⚠</span>
          <span>
            <strong>{t("header.warnNoExePathTitle")}</strong>{" "}
            {richText(t("header.warnNoExePathBody"), {
              tab: (
                <button
                  type="button"
                  className="underline text-[#ffd5a0] bg-transparent border-0 p-0 cursor-pointer"
                  onClick={() => setActiveTab("config")}
                >
                  {t("detail.tabConfig")}
                </button>
              ),
            })}
          </span>
        </div>
      )}
    </div>
  );
};

export default Header;

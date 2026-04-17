import { CARD, EYEBROW, GHOST_BTN, PRIMARY_BTN, SOFT_BADGE, SOURCE_BADGE } from "@/components/styles";
import { DashboardQuery, ValidatePathsQuery } from "@/queries/dashboard";
import { useSyncAndLaunchFlow } from "@/queries/detail";
import { formatBytes, formatLocalTime, toImgSrc } from "@/utils";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router";

const Header = ({ setActiveTab }: { setActiveTab: (tab: "status" | "config") => void }) => {
  const { id } = useParams<{ id: string }>();

  const queryClient = useQueryClient();

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

  const playLabel = flow.phase === "syncing" ? "Syncing saves…" : flow.phase === "launching" ? "Launching…" : "▶ Play";

  return (
    <div className={CARD}>
      <div className="flex items-start gap-5 mb-5">
        {/* Thumbnail */}
        <div className="w-24 h-24 shrink-0 rounded-2xl border border-[rgba(165,185,255,0.1)] bg-[rgba(9,14,28,0.75)] overflow-hidden">
          {game.thumbnail ? (
            <img src={toImgSrc(game.thumbnail)} alt={game.name} className="w-full h-full object-cover" />
          ) : (
            <div className="grid place-items-center w-full h-full text-[#9aa8c7] text-3xl">🎮</div>
          )}
        </div>

        <div className="grid gap-2 flex-1 min-w-0">
          <p className={EYEBROW}>Game details</p>
          <h2 className="m-0">{game.name}</h2>
          <span className={sourceBadge}>{game.source}</span>
          {game.description && <p className="m-0 text-sm text-[#9aa8c7] max-w-120 whitespace-pre-wrap">{game.description}</p>}
        </div>

        {/* Play button */}
        <div className="flex flex-col items-end gap-2 shrink-0">
          <button
            type="button"
            className={`${PRIMARY_BTN} w-auto px-6`}
            disabled={!canLaunch || flow.isPending}
            title={
              !game.exePath
                ? "Set an executable path in Settings to enable launching"
                : exePathValid === false
                  ? "Executable not found on this machine — update the path in Settings"
                  : "Sync saves from Drive then launch the game"
            }
            onClick={handlePlay}
          >
            {playLabel}
          </button>
          {!game.exePath && <span className="text-xs text-[#9aa8c7] text-right max-w-[140px]">Set an exe path in Settings</span>}
          {game.exePath && exePathValid === false && (
            <span className="text-xs text-[#ff9e9e] text-right max-w-[160px]">⚠ Exe not found on this device</span>
          )}
          {launchError && (
            <div className="flex flex-col items-end gap-1.5 max-w-[220px]">
              <span className="text-xs text-[#ff9e9e] text-right">{launchError}</span>
              {canForceAfterError && (
                <button type="button" className={`${GHOST_BTN} text-xs min-h-8 px-3`} onClick={handleForceLaunch}>
                  Launch anyway
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Metadata grid */}
      <dl className="grid gap-3.5 grid-cols-2 m-0 max-[720px]:grid-cols-1">
        {[
          { label: "Save folder", value: game.savePaths.length > 0 ? (game.savePaths[0].path ?? "Not set") : "Not set" },
          {
            label: "Google Drive folder",
            value: game.gdriveFolderId ?? "Not synced",
          },
          {
            label: "Last cloud save",
            value: formatLocalTime(game.lastCloudModified),
          },
          {
            label: "Drive storage used",
            value: game.cloudStorageBytes != null ? formatBytes(game.cloudStorageBytes) : "Never synced",
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
            <strong>Process tracking is on but no executable is set.</strong> Switch to the{" "}
            <button
              type="button"
              className="underline text-[#ffd5a0] bg-transparent border-0 p-0 cursor-pointer"
              onClick={() => setActiveTab("config")}
            >
              Configuration
            </button>{" "}
            tab and enter the game&apos;s .exe name to activate tracking.
          </span>
        </div>
      )}
    </div>
  );
};

export default Header;

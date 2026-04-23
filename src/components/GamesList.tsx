import { useState } from "react";
import { Link } from "react-router";
import { useRemoveGameMutation } from "../queries";
import { useSyncAndLaunchFlow } from "../queries/detail";
import type { GameEntry } from "../types/dashboard";
import { formatBytes, toImgSrc } from "../utils";
import { ConfirmModal } from "./ConfirmModal";
import { BTN, CARD, MUTED, SEC_HDR, SOFT_BADGE, SOURCE_BADGE } from "./styles";

function LazyThumbnail({ src }: { src: string }) {
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);

  if (errored) {
    return <div className="grid place-items-center w-full h-full text-[#9aa8c7] text-lg">🎮</div>;
  }

  return (
    <div className="relative w-full h-full">
      {!loaded && <div className="absolute inset-0 animate-pulse bg-[rgba(165,185,255,0.08)]" />}
      <img
        src={toImgSrc(src)}
        alt=""
        loading="lazy"
        className={`w-full h-full object-cover transition-opacity duration-300 ${loaded ? "opacity-100" : "opacity-0"}`}
        onLoad={() => setLoaded(true)}
        onError={() => setErrored(true)}
      />
    </div>
  );
}

interface Props {
  games: GameEntry[];
  invalidGameIds?: Set<string>;
  missingExeIds?: Set<string>;
}

export function GamesList({ games, invalidGameIds, missingExeIds }: Props) {
  const removeMutation = useRemoveGameMutation();

  const [removeTarget, setRemoveTarget] = useState<GameEntry | null>(null);

  function handleRemoveClick(e: React.MouseEvent, game: GameEntry) {
    e.preventDefault();
    setRemoveTarget(game);
  }

  function handleConfirmRemove() {
    if (removeTarget) {
      removeMutation.mutate(removeTarget.id);
      setRemoveTarget(null);
    }
  }

  return (
    <section className={CARD}>
      <div className={SEC_HDR}>
        <h3 className="m-0 font-semibold">Games</h3>
        <span className="text-[0.85rem]">{games.length} entries</span>
      </div>

      <div className="grid gap-3.5">
        {games.length === 0 ? (
          <div className="grid place-items-center min-h-40 rounded-[18px] border border-dashed border-[rgba(165,185,255,0.16)] bg-[rgba(8,14,25,0.55)] text-center p-4.5">
            <p className="m-0 text-[1.1rem]">No games yet.</p>
            <span className={MUTED}>Add your first game using the form above.</span>
          </div>
        ) : (
          games.map((g) => {
            const badge = SOURCE_BADGE[g.source] ?? SOFT_BADGE;
            const isInvalid = invalidGameIds?.has(g.id) ?? false;
            const isExeMissing = missingExeIds?.has(g.id) ?? false;
            return (
              <div
                key={g.id}
                className={`relative flex items-center gap-4 p-4 rounded-2xl bg-[rgba(10,16,31,0.72)] border transition-colors ${
                  isInvalid || isExeMissing
                    ? "border-[rgba(255,100,100,0.4)] hover:border-[rgba(255,100,100,0.6)]"
                    : "border-[rgba(154,177,255,0.08)] hover:border-[rgba(111,171,255,0.4)]"
                }`}
              >
                <Link to={`/game/${g.id}`} className="flex items-center gap-4 flex-1 min-w-0 text-inherit no-underline">
                  {/* Thumbnail */}
                  <div className="w-12 h-12 shrink-0 rounded-xl border border-[rgba(165,185,255,0.1)] bg-[rgba(9,14,28,0.75)] overflow-hidden">
                    {g.thumbnail ? (
                      <LazyThumbnail src={g.thumbnail} />
                    ) : (
                      <div className="grid place-items-center w-full h-full text-[#9aa8c7] text-lg">🎮</div>
                    )}
                  </div>

                  <div className="grid gap-1 min-w-0">
                    <strong className="truncate">{g.name}</strong>
                    <div className="flex items-center gap-2">
                      <span className={badge}>{g.source}</span>
                      {g.savePaths.length > 0 && g.savePaths[0].path && (
                        <span className={`${MUTED} text-xs truncate`}>
                          {g.savePaths.length > 1 ? `${g.savePaths[0].path} (+${g.savePaths.length - 1} more)` : g.savePaths[0].path}
                        </span>
                      )}
                    </div>
                    {isInvalid && (
                      <p className="m-0 text-xs text-[#ff9e9e] flex items-center gap-1">
                        <span>⚠</span> Save path not found
                      </p>
                    )}
                    {isExeMissing && (
                      <p className="m-0 text-xs text-[#ff9e9e] flex items-center gap-1">
                        <span>⚠</span> Executable not found on this device
                      </p>
                    )}
                    {g.trackChanges && !g.exeName && (
                      <p className="m-0 text-xs text-[#ffd5a0] flex items-center gap-1">
                        <span>⚠</span> No executable set — process tracking inactive
                      </p>
                    )}
                    {g.cloudStorageBytes != null && (
                      <p className="m-0 text-xs text-[#7dc9ff] flex items-center gap-1">
                        <span>☁</span> {formatBytes(g.cloudStorageBytes)} on Drive
                      </p>
                    )}{" "}
                  </div>
                </Link>

                {/* Play button */}
                <GamePlayButton game={g} exeMissing={isExeMissing} />

                {/* Remove button */}
                <button
                  type="button"
                  title="Remove game"
                  className="shrink-0 w-9 h-9 grid place-items-center rounded-xl border border-transparent text-[#9aa8c7] hover:text-[#ff9e9e] hover:bg-[rgba(255,80,80,0.12)] hover:border-[rgba(255,100,100,0.3)] transition-colors cursor-pointer bg-transparent"
                  onClick={(e) => handleRemoveClick(e, g)}
                >
                  ✕
                </button>
              </div>
            );
          })
        )}
      </div>

      <ConfirmModal
        open={removeTarget !== null}
        title="Remove game"
        message={`Are you sure you want to remove "${removeTarget?.name}" from your library? This cannot be undone.`}
        confirmLabel="Remove"
        onConfirm={handleConfirmRemove}
        onCancel={() => setRemoveTarget(null)}
      />
    </section>
  );
}

// ── GamePlayButton ────────────────────────────────────────────────────────────

function GamePlayButton({ game, exeMissing }: { game: GameEntry; exeMissing: boolean }) {
  const [error, setError] = useState<string | null>(null);

  const [canForce, setCanForce] = useState(false);

  const flow = useSyncAndLaunchFlow({
    onError: (msg, canForceArg) => {
      setError(msg);
      setCanForce(canForceArg);
    },
  });

  if (!game.exePath) return null;

  const isDisabled = flow.isPending || exeMissing;

  const label = flow.phase === "syncing" ? "⏳" : flow.phase === "launching" ? "▶" : "▶";

  const title = exeMissing
    ? "Executable not found on this device — update path in Settings"
    : flow.phase === "syncing"
      ? "Syncing saves…"
      : flow.phase === "launching"
        ? "Launching…"
        : "Sync saves then launch game";

  return (
    <div className="flex flex-col items-center gap-1 shrink-0">
      <button
        type="button"
        title={title}
        disabled={isDisabled}
        className={`${BTN} w-9 h-9 grid place-items-center rounded-xl border transition-colors ${
          exeMissing
            ? "text-[#ff9e9e] border-[rgba(255,100,100,0.25)] bg-[rgba(255,80,80,0.08)] cursor-not-allowed opacity-60"
            : "text-[#7dc9ff] hover:text-[#05111f] hover:bg-[rgba(122,180,255,0.85)] hover:border-[rgba(122,180,255,0.6)] border-[rgba(122,180,255,0.25)] bg-[rgba(122,180,255,0.08)]"
        }`}
        onClick={(e) => {
          e.preventDefault();
          setError(null);
          setCanForce(false);
          flow.start(game);
        }}
      >
        {label}
      </button>
      {error && (
        <div className="absolute right-16 top-1/2 -translate-y-1/2 z-10 w-48 rounded-xl border border-[rgba(255,100,100,0.3)] bg-[rgba(18,10,24,0.96)] p-2.5 text-xs text-[#ff9e9e] shadow-lg">
          <p className="m-0 mb-1.5 leading-snug">{error}</p>
          {canForce && (
            <button
              type="button"
              className={`${BTN} w-full text-xs min-h-7 px-2 rounded-lg bg-[rgba(255,255,255,0.06)] text-[#eaf3ff]`}
              onClick={(e) => {
                e.preventDefault();
                setError(null);
                flow.forceLaunch(game.id);
              }}
            >
              Launch anyway
            </button>
          )}
        </div>
      )}
    </div>
  );
}

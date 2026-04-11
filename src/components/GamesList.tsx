import { useState } from "react";
import { Link } from "react-router";

import { useRemoveGameMutation } from "../queries";
import type { GameEntry } from "../types/dashboard";
import { toImgSrc, formatBytes } from "../utils";
import { ConfirmModal } from "./ConfirmModal";
import { CARD, MUTED, SEC_HDR, SOURCE_BADGE, SOFT_BADGE } from "./styles";

function LazyThumbnail({ src }: { src: string }) {
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);

  if (errored) {
    return (
      <div className="grid place-items-center w-full h-full text-[#9aa8c7] text-lg">🎮</div>
    );
  }

  return (
    <div className="relative w-full h-full">
      {!loaded && (
        <div className="absolute inset-0 animate-pulse bg-[rgba(165,185,255,0.08)]" />
      )}
      <img
        src={toImgSrc(src)}
        alt=""
        loading="lazy"
        className={`w-full h-full object-cover transition-opacity duration-300 ${
          loaded ? "opacity-100" : "opacity-0"
        }`}
        onLoad={() => setLoaded(true)}
        onError={() => setErrored(true)}
      />
    </div>
  );
}

interface Props {
  games: GameEntry[];
  invalidGameIds?: Set<string>;
}

export function GamesList({ games, invalidGameIds }: Props) {
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

      <div className="grid gap-[14px]">
        {games.length === 0 ? (
          <div className="grid place-items-center min-h-[160px] rounded-[18px] border border-dashed border-[rgba(165,185,255,0.16)] bg-[rgba(8,14,25,0.55)] text-center p-[18px]">
            <p className="m-0 text-[1.1rem]">No games yet.</p>
            <span className={MUTED}>Add your first game using the form above.</span>
          </div>
        ) : (
          games.map((g) => {
            const badge = SOURCE_BADGE[g.source] ?? SOFT_BADGE;
            const isInvalid = invalidGameIds?.has(g.id) ?? false;
            return (
              <div
                key={g.id}
                className={`flex items-center gap-4 p-4 rounded-2xl bg-[rgba(10,16,31,0.72)] border transition-colors ${
                  isInvalid
                    ? "border-[rgba(255,100,100,0.4)] hover:border-[rgba(255,100,100,0.6)]"
                    : "border-[rgba(154,177,255,0.08)] hover:border-[rgba(111,171,255,0.4)]"
                }`}
              >
                <Link
                  to={`/game/${g.id}`}
                  className="flex items-center gap-4 flex-1 min-w-0 text-inherit no-underline"
                >
                  {/* Thumbnail */}
                  <div className="w-12 h-12 shrink-0 rounded-xl border border-[rgba(165,185,255,0.1)] bg-[rgba(9,14,28,0.75)] overflow-hidden">
                    {g.thumbnail ? (
                      <LazyThumbnail src={g.thumbnail} />
                    ) : (
                      <div className="grid place-items-center w-full h-full text-[#9aa8c7] text-lg">
                        🎮
                      </div>
                    )}
                  </div>

                  <div className="grid gap-1 min-w-0">
                    <strong className="truncate">{g.name}</strong>
                    <div className="flex items-center gap-2">
                      <span className={badge}>{g.source}</span>
                      {g.savePath && (
                        <span className={`${MUTED} text-xs truncate`}>{g.savePath}</span>
                      )}
                    </div>
                    {isInvalid && (
                      <p className="m-0 text-xs text-[#ff9e9e] flex items-center gap-1">
                        <span>⚠</span> Save path not found
                      </p>
                    )}
                    {g.trackChanges && !g.exeName && (
                      <p className="m-0 text-xs text-[#ffd5a0] flex items-center gap-1">
                        <span>⚠</span> No executable set — process tracking inactive
                      </p>
                    )}
                    {g.description && (
                      <p className={`${MUTED} m-0 text-xs truncate`}>{g.description}</p>
                    )}                    {g.cloudStorageBytes != null && (
                      <p className="m-0 text-xs text-[#7dc9ff] flex items-center gap-1">
                        <span>☁</span> {formatBytes(g.cloudStorageBytes)} on Drive
                      </p>
                    )}                  </div>
                </Link>

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

import { Link } from "react-router";

import type { GameEntry } from "../types/dashboard";
import { CARD, MUTED, SEC_HDR, SOURCE_BADGE, SOFT_BADGE } from "./styles";

interface Props {
  games: GameEntry[];
}

export function GamesList({ games }: Props) {
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
            return (
              <Link
                key={g.id}
                to={`/game/${g.id}`}
                className="flex items-center gap-4 p-4 rounded-2xl text-inherit no-underline bg-[rgba(10,16,31,0.72)] border border-[rgba(154,177,255,0.08)] hover:border-[rgba(111,171,255,0.4)] transition-colors"
              >
                {/* Thumbnail */}
                <div className="w-12 h-12 shrink-0 rounded-xl border border-[rgba(165,185,255,0.1)] bg-[rgba(9,14,28,0.75)] overflow-hidden">
                  {g.thumbnail ? (
                    <img src={g.thumbnail} alt="" className="w-full h-full object-cover" />
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
                  {g.description && (
                    <p className={`${MUTED} m-0 text-xs truncate`}>{g.description}</p>
                  )}
                </div>
              </Link>
            );
          })
        )}
      </div>
    </section>
  );
}

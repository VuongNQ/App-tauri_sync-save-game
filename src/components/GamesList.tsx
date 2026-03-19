import type { GameItem } from "../types/dashboard";
import {
  BADGE_OFFLINE,
  BADGE_ONLINE,
  BTN,
  CARD,
  MUTED,
  SEC_HDR,
} from "./styles";

interface Props {
  games: GameItem[];
  selectedGameId: string | null;
  onSelect: (id: string) => void;
}

export function GamesList({ games, selectedGameId, onSelect }: Props) {
  return (
    <section className={CARD}>
      <div className={SEC_HDR}>
        <h3 className="m-0 font-semibold">Games on this system</h3>
        <span className="text-[0.85rem]">{games.length} entries</span>
      </div>

      <div className="grid gap-[14px] max-h-[calc(100vh-240px)] overflow-auto pr-[6px] max-[1180px]:max-h-[420px]">
        {games.length === 0 ? (
          <div className="grid place-items-center min-h-[220px] rounded-[18px] border border-dashed border-[rgba(165,185,255,0.16)] bg-[rgba(8,14,25,0.55)] text-center p-[18px]">
            <p className="m-0 text-[1.1rem]">No games detected yet.</p>
            <span className={MUTED}>Run a scan or add your first game manually.</span>
          </div>
        ) : (
          games.map((g) => (
            <button
              key={g.id}
              type="button"
              className={
                g.id === selectedGameId
                  ? `${BTN} w-full p-4 text-left rounded-2xl text-inherit bg-[rgba(19,31,57,0.92)] border border-[rgba(111,171,255,0.62)] shadow-[inset_0_0_0_1px_rgba(104,196,255,0.16)]`
                  : `${BTN} w-full p-4 text-left rounded-2xl text-inherit bg-[rgba(10,16,31,0.72)] border border-[rgba(154,177,255,0.08)]`
              }
              onClick={() => onSelect(g.id)}
            >
              <div className="flex items-center justify-between gap-3">
                <strong>{g.name}</strong>
                <span className={g.isAvailable ? BADGE_ONLINE : BADGE_OFFLINE}>
                  {g.isAvailable ? "Available" : "Missing"}
                </span>
              </div>
              <div className="flex items-center justify-start gap-3 text-[#7fc7ff] text-[0.86rem]">
                <span>{g.launcher}</span>
                <span>{g.isManual ? "Manual" : g.source}</span>
              </div>
              <p className={MUTED}>{g.installPath ?? "Install path not detected"}</p>
            </button>
          ))
        )}
      </div>
    </section>
  );
}

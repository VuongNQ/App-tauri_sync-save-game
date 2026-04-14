import { CARD, EYEBROW, MUTED } from "./styles";

interface Props {
  gamesCount: number;
}

export function HeroCard({ gamesCount }: Props) {
  return (
    <header className={`${CARD} grid gap-[18px]`}>
      <p className={EYEBROW}>Windows save manager</p>
      <h1 className="m-0 text-2xl font-bold">Save Game Sync</h1>
      <p className={MUTED}>Track and sync your save games to Google Drive across devices.</p>

      <div className="p-4 border border-[rgba(165,185,255,0.12)] bg-[rgba(11,18,33,0.76)] rounded-[18px]">
        <span className="block text-[1.8rem] font-bold">{gamesCount}</span>
        <span className="text-[#91a0bf] text-sm">Games tracked</span>
      </div>
    </header>
  );
}

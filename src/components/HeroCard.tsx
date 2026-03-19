import { useRefreshMutation } from "../queries";
import { msg } from "../utils";
import { CARD, EYEBROW, MUTED, PRIMARY_BTN } from "./styles";

interface Props {
  gamesCount: number;
  launcherCount: number;
}

export function HeroCard({ gamesCount, launcherCount }: Props) {
  const refresh = useRefreshMutation();

  return (
    <header className={`${CARD} grid gap-[18px]`}>
      <p className={EYEBROW}>Windows save manager</p>
      <h1 className="m-0 text-2xl font-bold">Save Game Dashboard</h1>
      <p className={MUTED}>
        Detect installed games, add custom titles, and map each game to its save folder.
      </p>

      <div className="grid grid-cols-2 gap-[14px]">
        <div className="p-4 border border-[rgba(165,185,255,0.12)] bg-[rgba(11,18,33,0.76)] rounded-[18px]">
          <span className="block text-[1.8rem] font-bold">{gamesCount}</span>
          <span className="text-[#91a0bf] text-sm">Games tracked</span>
        </div>
        <div className="p-4 border border-[rgba(165,185,255,0.12)] bg-[rgba(11,18,33,0.76)] rounded-[18px]">
          <span className="block text-[1.8rem] font-bold">{launcherCount}</span>
          <span className="text-[#91a0bf] text-sm">Launchers found</span>
        </div>
      </div>

      <button
        className={PRIMARY_BTN}
        type="button"
        onClick={() => refresh.mutate()}
        disabled={refresh.isPending}
      >
        {refresh.isPending ? "Scanning…" : "Refresh library"}
      </button>

      {refresh.isError && (
        <p className="m-0 text-sm text-[#ffd5d5]">
          {msg(refresh.error, "Unable to refresh launchers.")}
        </p>
      )}
    </header>
  );
}

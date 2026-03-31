import { useDashboardQuery } from "../queries";
import { AddGameCard } from "../components/AddGameCard";
import { GamesList } from "../components/GamesList";
import { HeroCard } from "../components/HeroCard";
import { EYEBROW } from "../components/styles";
import { msg } from "../utils";

export function DashboardPage() {
  const dashboardQuery = useDashboardQuery();
  const games = dashboardQuery.data?.games ?? [];

  return (
    <>
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className={EYEBROW}>Home</p>
          <h2 className="m-0">Your game library</h2>
        </div>
        {dashboardQuery.isLoading && (
          <span className="text-[0.85rem] text-[#9aa8c7]">Loading…</span>
        )}
      </div>

      {/* Error */}
      {dashboardQuery.isError && (
        <p className="py-4 px-[18px] border rounded-3xl border-[rgba(255,100,100,0.24)] bg-[rgba(62,18,22,0.7)] text-[#ffd5d5]">
          {msg(dashboardQuery.error, "Unable to load the dashboard.")}
        </p>
      )}

      {/* Stats + Add game */}
      <div className="grid grid-cols-[1fr_1fr] gap-5 max-[900px]:grid-cols-1">
        <HeroCard gamesCount={games.length} />
        <AddGameCard />
      </div>

      {/* Game list */}
      <GamesList games={games} />
    </>
  );
}

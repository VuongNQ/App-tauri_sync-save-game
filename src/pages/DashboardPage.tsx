import { useDashboardQuery, useSyncAllMutation, useValidatePathsQuery } from "../queries";
import { AddGameCard } from "../components/AddGameCard";
import { GamesList } from "../components/GamesList";
import { HeroCard } from "../components/HeroCard";
import { EYEBROW, SECONDARY_BTN } from "../components/styles";
import { msg } from "../utils";

export function DashboardPage() {
  const dashboardQuery = useDashboardQuery();
  const validateQuery = useValidatePathsQuery();
  const syncAll = useSyncAllMutation();
  const games = dashboardQuery.data?.games ?? [];

  const invalidGameIds = new Set(
    (validateQuery.data ?? [])
      .filter((v) => !v.valid)
      .map((v) => v.gameId),
  );

  const syncableCount = games.filter((g) => g.savePath !== null).length;

  const syncSummary = (() => {
    if (!syncAll.data) return null;
    const errors = syncAll.data.filter((r) => r.error !== null).length;
    const ok = syncAll.data.length - errors;
    if (errors === 0) return `${ok} game${ok !== 1 ? "s" : ""} synced`;
    return `${ok} synced · ${errors} failed`;
  })();

  return (
    <>
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className={EYEBROW}>Home</p>
          <h2 className="m-0">Your game library</h2>
        </div>
        <div className="flex items-center gap-3 pt-1">
          {dashboardQuery.isLoading && (
            <span className="text-[0.85rem] text-[#9aa8c7]">Loading…</span>
          )}
          {syncSummary && !syncAll.isPending && (
            <span className={`text-[0.82rem] ${syncAll.data?.some((r) => r.error !== null) ? "text-[#ffb3b3]" : "text-[#7de8ae]"}`}>
              {syncSummary}
            </span>
          )}
          {syncAll.isError && (
            <span className="text-[0.82rem] text-[#ffb3b3]">
              {msg(syncAll.error, "Sync failed.")}
            </span>
          )}
          {syncableCount > 0 && (
            <button
              type="button"
              className={`${SECONDARY_BTN} text-sm px-5`}
              disabled={syncAll.isPending || dashboardQuery.isLoading}
              onClick={() => syncAll.mutate()}
            >
              {syncAll.isPending ? "Syncing…" : "Sync All"}
            </button>
          )}
        </div>
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
      <GamesList games={games} invalidGameIds={invalidGameIds} />
    </>
  );
}

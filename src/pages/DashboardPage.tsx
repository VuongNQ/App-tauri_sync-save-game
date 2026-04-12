import { AddGameCard } from "../components/AddGameCard";
import { GamesList } from "../components/GamesList";
import { HeroCard } from "../components/HeroCard";
import { BTN, CARD, EYEBROW } from "../components/styles";
import { useDashboardQuery, useValidatePathsQuery } from "../queries";
import { useSyncLibraryFromCloudMutation } from "../queries/sync";
import { msg } from "../utils";

function DashboardSkeleton() {
  const shimmer = "animate-pulse bg-[rgba(165,185,255,0.08)] rounded-xl";
  return (
    <>
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="grid gap-2">
          <div className={`h-3 w-16 rounded-full ${shimmer}`} />
          <div className={`h-7 w-52 ${shimmer}`} />
        </div>
      </div>

      {/* Hero + Add cards */}
      <div className="grid grid-cols-[1fr_1fr] gap-5 max-[900px]:grid-cols-1">
        <div className={`${CARD} h-35 ${shimmer}`} />
        <div className={`${CARD} h-35 ${shimmer}`} />
      </div>

      {/* Games list */}
      <div className={CARD}>
        <div className="flex items-center justify-between mb-4.5">
          <div className={`h-5 w-20 ${shimmer}`} />
          <div className={`h-4 w-16 ${shimmer}`} />
        </div>
        <div className="grid gap-3.5">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="flex items-center gap-4 p-4 rounded-2xl bg-[rgba(10,16,31,0.72)] border border-[rgba(154,177,255,0.08)]"
            >
              <div className={`w-12 h-12 shrink-0 rounded-xl ${shimmer}`} />
              <div className="flex-1 grid gap-2">
                <div className={`h-4 w-36 ${shimmer}`} />
                <div className={`h-3 w-24 rounded-full ${shimmer}`} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

export function DashboardPage() {
  const dashboardQuery = useDashboardQuery();
  const validateQuery = useValidatePathsQuery();
  const refreshMutation = useSyncLibraryFromCloudMutation();
  const games = dashboardQuery.data?.games ?? [];

  const invalidGameIds = new Set(
    (validateQuery.data ?? [])
      .filter((v) => !v.valid)
      .map((v) => v.gameId),
  );

  if (dashboardQuery.isLoading) {
    return <DashboardSkeleton />;
  }

  return (
    <>
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className={EYEBROW}>Home</p>
          <h2 className="m-0">Your game library</h2>
        </div>
        <button
          className={`${BTN} mt-1 p-2 rounded-xl text-[#9aa8c7] hover:text-[#c7d3f7] hover:bg-[rgba(165,185,255,0.08)]`}
          title="Refresh from cloud"
          disabled={refreshMutation.isPending}
          onClick={() => refreshMutation.mutate()}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={refreshMutation.isPending ? "animate-spin" : undefined}
          >
            <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
            <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
            <path d="M16 16h5v5" />
          </svg>
        </button>
      </div>

      {/* Error */}
      {dashboardQuery.isError && (
        <p className="py-4 px-4.5 border rounded-3xl border-[rgba(255,100,100,0.24)] bg-[rgba(62,18,22,0.7)] text-[#ffd5d5]">
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

import { useEffect, useMemo, useState } from "react";

import { useDashboardQuery } from "./queries";
import type { DashboardData } from "./types/dashboard";
import { msg } from "./utils";
import { AddGameCard } from "./components/AddGameCard";
import { DetailPanel } from "./components/DetailPanel";
import { GamesList } from "./components/GamesList";
import { HeroCard } from "./components/HeroCard";
import { LauncherCard } from "./components/LauncherCard";
import { EYEBROW } from "./components/styles";
import "./App.css";

/** Pick the best game id from freshly returned dashboard data. */
function resolveId(data: DashboardData, preferredId: string | null | undefined): string | null {
  const hit = data.games.find((g) => g.id === preferredId);
  return (hit ?? data.games[0] ?? null)?.id ?? null;
}

function App() {
  const [selectedGameId, setSelectedGameId] = useState<string | null>(null);

  // ── Server state ────────────────────────────────────────────────────────
  const dashboardQuery = useDashboardQuery();
  const dashboard = dashboardQuery.data ?? null;

  // Auto-select the first game once the dashboard loads
  useEffect(() => {
    if (dashboard && selectedGameId === null) {
      setSelectedGameId(dashboard.games[0]?.id ?? null);
    }
  }, [dashboard, selectedGameId]);

  const selectedGame = useMemo(
    () => dashboard?.games.find((g) => g.id === selectedGameId) ?? null,
    [dashboard, selectedGameId],
  );

  const games        = dashboard?.games     ?? [];
  const launchers    = dashboard?.launchers ?? [];
  const launcherCount = launchers.filter((l) => l.detected).length;

  return (
    <main className="grid min-h-screen grid-cols-[380px_1fr] max-[1180px]:grid-cols-1">

      {/* ── Sidebar ── */}
      <aside className="flex flex-col gap-5 border-r border-[rgba(153,176,255,0.12)] bg-[rgba(6,11,22,0.65)] [backdrop-filter:blur(18px)] p-7 max-[720px]:p-[18px]">
        <HeroCard gamesCount={games.length} launcherCount={launcherCount} />
        <LauncherCard launchers={launchers} />
        <AddGameCard
          onGameAdded={(data, addedName) => {
            const added = data.games.find(
              (g) => g.isManual && g.name.toLowerCase() === addedName.toLowerCase(),
            );
            setSelectedGameId(resolveId(data, added?.id ?? selectedGameId));
          }}
        />
      </aside>

      {/* ── Main content ── */}
      <section className="flex flex-col gap-5 p-7 max-[720px]:p-[18px]">

        {/* Toolbar */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className={EYEBROW}>Home</p>
            <h2 className="m-0">Installed and managed games</h2>
          </div>
          {dashboardQuery.isLoading && (
            <span className="text-[0.85rem] text-[#9aa8c7]">Loading your game library…</span>
          )}
        </div>

        {/* Dashboard load error */}
        {dashboardQuery.isError && (
          <p className="py-4 px-[18px] border rounded-3xl border-[rgba(255,100,100,0.24)] bg-[rgba(62,18,22,0.7)] text-[#ffd5d5]">
            {msg(dashboardQuery.error, "Unable to load the dashboard.")}
          </p>
        )}

        {/* Scan warnings */}
        {!!dashboard?.warnings.length && (
          <div className="py-4 px-[18px] border rounded-3xl border-[rgba(255,196,91,0.18)] bg-[rgba(59,39,15,0.7)]">
            <strong>Scan notes</strong>
            <ul className="mt-2 mb-0 pl-[18px]">
              {dashboard.warnings.map((w) => <li key={w}>{w}</li>)}
            </ul>
          </div>
        )}

        {/* Workspace grid */}
        <div className="grid grid-cols-[minmax(320px,420px)_1fr] gap-5 min-h-0 max-[1180px]:grid-cols-1">
          <GamesList
            games={games}
            selectedGameId={selectedGameId}
            onSelect={setSelectedGameId}
          />
          <DetailPanel selectedGame={selectedGame} />
        </div>
      </section>
    </main>
  );
}

export default App;

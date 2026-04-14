import { CARD } from "@/components/styles";
import { useDashboardQuery } from "@/queries";
import { useState } from "react";
import { Link, useParams } from "react-router";
import Header from "./components/Header";
import TabSettings from "./components/Tabs/Settings";
import TabStatus from "./components/Tabs/Status";

type TabId = "status" | "config";

export function GameDetailPage() {
  const { id } = useParams<{ id: string }>();

  const { data: dashboard, isLoading: isDashboardLoading } = useDashboardQuery();

  const [activeTab, setActiveTab] = useState<TabId>("status");

  const game = dashboard?.games.find((g) => g.id === id) ?? null;

  if (isDashboardLoading) {
    return <GameDetailSkeleton />;
  }

  if (!game) {
    return (
      <div className={`${CARD} text-center`}>
        <p className="text-[1.1rem]">Game not found.</p>
        <Link to="/" className="text-[#7dc9ff] underline">
          Back to dashboard
        </Link>
      </div>
    );
  }

  return (
    <>
      {/* Breadcrumb */}
      <div>
        <Link to="/" className="text-[#7dc9ff] text-sm hover:underline">
          ← Back to library
        </Link>
      </div>

      {/* Header */}
      <Header setActiveTab={setActiveTab} />

      {/* Tabs */}
      <div className="flex gap-1 p-1 rounded-2xl bg-[rgba(9,14,28,0.6)] border border-white/[0.07] cursor-pointer">
        {(
          [
            { id: "status", label: "Status & Sync" },
            { id: "config", label: "Configuration" },
          ] as { id: TabId; label: string }[]
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={
              activeTab === tab.id
                ? "flex-1 py-2.5 rounded-xl text-sm font-semibold text-white bg-linear-to-br from-[#6d7dff] to-[#55c5ff] transition-colors"
                : "flex-1 py-2.5 rounded-xl text-sm font-semibold text-[#9aa8c7] hover:text-white hover:bg-white/6 transition-colors"
            }
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── Tab 1: Status & Sync ── */}
      {activeTab === "status" && <TabStatus />}

      {/* ── Tab 2: Configuration ── */}
      {activeTab === "config" && <TabSettings />}
    </>
  );
}

function GameDetailSkeleton() {
  const shimmer = "animate-pulse bg-[rgba(165,185,255,0.08)] rounded-xl";
  return (
    <>
      {/* Breadcrumb */}
      <div className={`h-4 w-28 ${shimmer} rounded-full`} />

      {/* Header card */}
      <div className={CARD}>
        <div className="flex items-start gap-5 mb-5">
          <div className={`w-24 h-24 shrink-0 rounded-2xl ${shimmer}`} />
          <div className="grid gap-3 flex-1">
            <div className={`h-3 w-20 rounded-full ${shimmer}`} />
            <div className={`h-7 w-48 ${shimmer}`} />
            <div className={`h-5 w-16 rounded-full ${shimmer}`} />
          </div>
        </div>
        {/* Metadata grid */}
        <div className="grid gap-3.5 grid-cols-2 max-[720px]:grid-cols-1">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="p-4.5 rounded-[18px] bg-[rgba(9,14,28,0.75)] border border-[rgba(165,185,255,0.08)]">
              <div className={`h-3 w-24 rounded-full mb-2 ${shimmer}`} />
              <div className={`h-4 w-36 ${shimmer}`} />
            </div>
          ))}
        </div>
      </div>

      {/* Actions card */}
      <div className={CARD}>
        <div className={`h-5 w-20 mb-5 ${shimmer}`} />
        <div className="grid gap-4 grid-cols-2 max-[900px]:grid-cols-1">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className={`h-11 rounded-2xl ${shimmer}`} />
          ))}
        </div>
      </div>

      {/* Tracking toggles card */}
      <div className={CARD}>
        <div className={`h-5 w-40 mb-5 ${shimmer}`} />
        <div className="flex flex-col gap-4">
          {[0, 1].map((i) => (
            <div key={i} className="flex items-center justify-between gap-3">
              <div className="grid gap-1.5">
                <div className={`h-4 w-32 ${shimmer}`} />
                <div className={`h-3 w-52 rounded-full ${shimmer}`} />
              </div>
              <div className={`w-12 h-6 rounded-full shrink-0 ${shimmer}`} />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

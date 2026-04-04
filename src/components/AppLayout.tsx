import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router";

import { NAV_LINK, NAV_LINK_ACTIVE } from "./styles";

export function AppLayout() {
  const [appVersion, setAppVersion] = useState<string>("");

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => {});
  }, []);

  return (
    <div className="grid min-h-screen grid-cols-[260px_1fr] max-[900px]:grid-cols-1">
      {/* ── Sidebar ── */}
      <aside className="flex flex-col gap-2 border-r border-[rgba(153,176,255,0.12)] bg-[rgba(6,11,22,0.65)] [backdrop-filter:blur(18px)] p-5">
        <h1 className="mb-6 px-4 text-lg font-bold text-white">Save Game Sync</h1>

        <nav className="flex flex-col gap-1">
          <NavLink
            to="/"
            end
            className={({ isActive }) => (isActive ? NAV_LINK_ACTIVE : NAV_LINK)}
          >
            <DashboardIcon />
            Dashboard
          </NavLink>
          <NavLink
            to="/settings"
            className={({ isActive }) => (isActive ? NAV_LINK_ACTIVE : NAV_LINK)}
          >
            <SettingsIcon />
            Settings
          </NavLink>
        </nav>

        {appVersion && (
          <div className="mt-auto px-4 py-3 text-xs text-[#9aa8c7]">v{appVersion}</div>
        )}
      </aside>

      {/* ── Page content ── */}
      <main className="flex flex-col gap-5 overflow-auto p-7 max-[720px]:p-4.5">
        <Outlet />
      </main>
    </div>
  );
}

// ── Inline SVG icons (avoid extra deps) ───────────────────────────────────────

function DashboardIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

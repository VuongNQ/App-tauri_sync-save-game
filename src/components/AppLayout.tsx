import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router";

import { NAV_LINK, NAV_LINK_ACTIVE } from "./styles";

export function AppLayout() {
  const [appVersion, setAppVersion] = useState<string>("");
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => {});
  }, []);

  const iconNavLink = "flex items-center justify-center p-3 rounded-2xl text-[#c7d3f7] transition-colors hover:bg-[rgba(86,133,255,0.12)]";
  const iconNavLinkActive = "flex items-center justify-center p-3 rounded-2xl text-white bg-[rgba(86,133,255,0.18)]";

  return (
    <div className="grid min-h-screen max-[900px]:grid-cols-1" style={{ gridTemplateColumns: collapsed ? "64px 1fr" : "260px 1fr" }}>
      {/* ── Sidebar ── */}
      <aside
        className={`flex flex-col gap-2 border-r border-[rgba(153,176,255,0.12)] bg-[rgba(6,11,22,0.65)] [backdrop-filter:blur(18px)] ${collapsed ? "px-2 py-4" : "p-5"}`}
      >
        {/* ── Header: title + version + collapse button ── */}
        <div className={`flex items-start ${collapsed ? "justify-center" : "justify-between"} mb-4`}>
          {!collapsed && (
            <div className="px-4">
              <h1 className="text-lg font-bold text-white">Save Game Sync</h1>
              {appVersion && <span className="text-xs text-[#9aa8c7]">v{appVersion}</span>}
            </div>
          )}
          <button
            onClick={() => setCollapsed((c) => !c)}
            className="rounded-xl p-1.5 text-[#9aa8c7] hover:bg-white/10 hover:text-white transition-colors"
            title={collapsed ? "Expand menu" : "Collapse menu"}
          >
            <ChevronIcon collapsed={collapsed} />
          </button>
        </div>

        <nav className="flex flex-col gap-1">
          <NavLink
            to="/"
            end
            className={({ isActive }) => (collapsed ? (isActive ? iconNavLinkActive : iconNavLink) : isActive ? NAV_LINK_ACTIVE : NAV_LINK)}
            title={collapsed ? "Dashboard" : undefined}
          >
            <DashboardIcon />
            {!collapsed && "Dashboard"}
          </NavLink>
          <NavLink
            to="/settings"
            className={({ isActive }) => (collapsed ? (isActive ? iconNavLinkActive : iconNavLink) : isActive ? NAV_LINK_ACTIVE : NAV_LINK)}
            title={collapsed ? "Settings" : undefined}
          >
            <SettingsIcon />
            {!collapsed && "Settings"}
          </NavLink>
          <NavLink
            to="/devices"
            className={({ isActive }) => (collapsed ? (isActive ? iconNavLinkActive : iconNavLink) : isActive ? NAV_LINK_ACTIVE : NAV_LINK)}
            title={collapsed ? "Devices" : undefined}
          >
            <DevicesIcon />
            {!collapsed && "Devices"}
          </NavLink>
        </nav>
      </aside>

      {/* ── Page content ── */}
      <main className="flex flex-col gap-5 overflow-auto p-7 max-[720px]:p-4.5">
        <Outlet />
      </main>
    </div>
  );
}

// ── Inline SVG icons (avoid extra deps) ───────────────────────────────────────

function ChevronIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {collapsed ? <polyline points="9 18 15 12 9 6" /> : <polyline points="15 18 9 12 15 6" />}
    </svg>
  );
}

function DashboardIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function DevicesIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8" />
      <path d="M12 17v4" />
    </svg>
  );
}

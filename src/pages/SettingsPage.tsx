import { useGoogleUserInfoQuery, useLogoutMutation } from "../queries";
import { useSettingsQuery, useUpdateSettingsMutation } from "../queries/settings";
import {
  BTN,
  CARD,
  EYEBROW,
  MUTED,
  TOGGLE_TRACK_ON,
  TOGGLE_TRACK_OFF,
  TOGGLE_THUMB,
  TOGGLE_THUMB_ON,
} from "../components/styles";
import type { AppSettings } from "../types/dashboard";

export function SettingsPage() {
  const { data: userInfo, isLoading, error, refetch } = useGoogleUserInfoQuery();
  const logoutMutation = useLogoutMutation();
  const { data: settings } = useSettingsQuery();
  const updateSettings = useUpdateSettingsMutation();

  const toggleSetting = (key: keyof AppSettings, value: boolean) => {
    if (!settings) return;
    updateSettings.mutate({ ...settings, [key]: value });
  };

  return (
    <>
      <div>
        <p className={EYEBROW}>Configuration</p>
        <h2 className="m-0">Settings</h2>
      </div>

      <div className={CARD}>
        <h3 className="m-0 mb-4 font-semibold">Google Account</h3>
        {isLoading ? (
          <p className={MUTED}>Loading account info…</p>
        ) : userInfo ? (
          <div className="flex items-center gap-4">
            {userInfo.picture && (
              <img
                src={userInfo.picture}
                alt=""
                className="h-12 w-12 rounded-full object-cover"
                referrerPolicy="no-referrer"
              />
            )}
            <div className="flex-1 min-w-0">
              {userInfo.name && (
                <p className="m-0 font-medium text-[#eef4ff] truncate">
                  {userInfo.name}
                </p>
              )}
              <p className={`m-0 text-sm truncate ${MUTED}`}>
                {userInfo.email}
              </p>
            </div>
            <button
              type="button"
              className={`${BTN} rounded-xl bg-red-500/15 px-4 py-2 text-sm font-medium text-red-400 hover:bg-red-500/25`}
              disabled={logoutMutation.isPending}
              onClick={() => logoutMutation.mutate()}
            >
              {logoutMutation.isPending ? "Signing out…" : "Sign out"}
            </button>
          </div>
        ) : (
          <div>
            <p className={MUTED}>
              Unable to load account info.{error ? ` (${error.message})` : ""}
            </p>
            <p className={`mt-2 text-xs ${MUTED}`}>
              You may need to sign out and sign back in to grant profile permissions.
            </p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                className={`${BTN} rounded-xl bg-white/10 px-4 py-2 text-sm font-medium text-[#eef4ff] hover:bg-white/15`}
                onClick={() => refetch()}
              >
                Retry
              </button>
              <button
                type="button"
                className={`${BTN} rounded-xl bg-red-500/15 px-4 py-2 text-sm font-medium text-red-400 hover:bg-red-500/25`}
                disabled={logoutMutation.isPending}
                onClick={() => logoutMutation.mutate()}
              >
                {logoutMutation.isPending ? "Signing out…" : "Sign out & re-login"}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className={CARD}>
        <h3 className="m-0 mb-4 font-semibold">Sync preferences</h3>
        {settings ? (
          <div className="flex flex-col gap-4">
            <ToggleRow
              label="Global auto-sync"
              description="Master switch — automatically sync all games when changes are detected"
              checked={settings.globalAutoSync}
              onChange={(v) => toggleSetting("globalAutoSync", v)}
            />
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="m-0 text-[0.92rem] text-[#c7d3f7]">Sync interval (minutes)</p>
                <p className={`m-0 mt-0.5 text-xs ${MUTED}`}>
                  Periodic sync interval. 0 = only sync on file change.
                </p>
              </div>
              <input
                type="number"
                min={0}
                max={1440}
                className="w-20 rounded-lg border border-[rgba(140,165,241,0.16)] bg-[rgba(7,12,23,0.84)] px-2.5 py-1.5 text-center text-[#eef4ff] focus:outline-2 focus:outline-[rgba(122,180,255,0.35)] focus:outline-offset-1"
                value={settings.syncIntervalMinutes}
                onChange={(e) => {
                  const val = Math.max(0, Math.min(1440, Number(e.target.value) || 0));
                  updateSettings.mutate({ ...settings, syncIntervalMinutes: val });
                }}
              />
            </div>
          </div>
        ) : (
          <p className={MUTED}>Loading…</p>
        )}
      </div>

      <div className={CARD}>
        <h3 className="m-0 mb-4 font-semibold">Startup &amp; Background</h3>
        {settings ? (
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="m-0 text-[0.92rem] text-[#c7d3f7]">Minimize to tray on close</p>
                <p className={`m-0 mt-0.5 text-xs ${MUTED}`}>
                  The app hides to the system tray instead of quitting. Use the tray icon to reopen or right-click → Quit to exit.
                </p>
              </div>
              <span className="shrink-0 rounded-lg bg-[rgba(109,125,255,0.14)] px-3 py-1 text-xs text-[#a3b0ff]">
                Always on
              </span>
            </div>
            <ToggleRow
              label="Start minimized"
              description="Launch the app hidden in the system tray"
              checked={settings.startMinimised}
              onChange={(v) => toggleSetting("startMinimised", v)}
            />
            <ToggleRow
              label="Launch on Windows startup"
              description="Automatically start the app when you sign in to Windows"
              checked={settings.runOnStartup}
              onChange={(v) => toggleSetting("runOnStartup", v)}
            />
          </div>
        ) : (
          <p className={MUTED}>Loading…</p>
        )}
      </div>
    </>
  );
}

// ── ToggleRow (same-file helper) ──────────────────────────

interface ToggleRowProps {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}

function ToggleRow({ label, description, checked, onChange }: ToggleRowProps) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div>
        <p className="m-0 text-[0.92rem] text-[#c7d3f7]">{label}</p>
        <p className={`m-0 mt-0.5 text-xs ${MUTED}`}>{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className={checked ? TOGGLE_TRACK_ON : TOGGLE_TRACK_OFF}
        onClick={() => onChange(!checked)}
      >
        <span className={checked ? TOGGLE_THUMB_ON : TOGGLE_THUMB} />
      </button>
    </div>
  );
}

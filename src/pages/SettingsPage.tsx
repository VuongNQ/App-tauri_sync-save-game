import { useEffect, useState } from "react";

import { check } from "@tauri-apps/plugin-updater";
import type { Update } from "@tauri-apps/plugin-updater";
import { getVersion } from "@tauri-apps/api/app";

import { useClearAllDriveMutation, useGoogleUserInfoQuery, useLogoutMutation } from "../queries";
import { useSettingsQuery, useUpdateSettingsMutation } from "../queries/settings";
import { ConfirmModal } from "../components/ConfirmModal";
import {
  BTN,
  CARD,
  DANGER_BTN,
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

  const clearAllDrive = useClearAllDriveMutation();

  const [showClearModal, setShowClearModal] = useState(false);

  const { status, currentVersion, update, progress, updateError, handleCheck, handleInstall } = useAppUpdater();

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

      {/* App Updates */}
      <div className={CARD}>
        <h3 className="m-0 mb-4 font-semibold">App Updates</h3>
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="m-0 text-[0.92rem] text-[#c7d3f7]">Current version</p>
              {currentVersion && (
                <p className={`m-0 mt-0.5 font-mono text-xs ${MUTED}`}>
                  v{currentVersion}
                </p>
              )}
            </div>
            <button
              type="button"
              className={`${BTN} rounded-xl bg-white/10 px-4 py-2 text-sm font-medium text-[#eef4ff] hover:bg-white/15 disabled:opacity-50`}
              disabled={status === 'checking' || status === 'downloading'}
              onClick={handleCheck}
            >
              {status === 'checking' ? "Checking…" : "Check for Updates"}
            </button>
          </div>

          {status === 'available' && (
            <div className="rounded-xl border border-[rgba(140,165,241,0.2)] bg-[rgba(99,125,255,0.08)] p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="m-0 text-sm font-semibold text-[#9effc3]">
                    v{update?.version} is available
                  </p>
                  {update?.body && (
                    <p className={`m-0 mt-1 whitespace-pre-wrap text-xs ${MUTED}`}>
                      {update.body}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  className={`${BTN} shrink-0 rounded-xl bg-indigo-500/20 px-4 py-2 text-sm font-medium text-indigo-300 hover:bg-indigo-500/30`}
                  onClick={handleInstall}
                >
                  Download &amp; Install
                </button>
              </div>
            </div>
          )}

          {status === 'downloading' && (
            <div>
              <p className={`m-0 mb-1 text-sm ${MUTED}`}>
                Downloading update…
                {progress && progress.total > 0
                  ? ` ${Math.round((progress.downloaded / progress.total) * 100)}%`
                  : ""}
              </p>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-indigo-400 transition-all duration-300"
                  style={{
                    width:
                      progress && progress.total > 0
                        ? `${Math.round((progress.downloaded / progress.total) * 100)}%`
                        : "10%",
                  }}
                />
              </div>
            </div>
          )}

          {status === 'installed' && (
            <p className="m-0 text-sm text-[#9effc3]">Restarting to apply update…</p>
          )}

          {status === 'up-to-date' && (
            <p className={`m-0 text-sm ${MUTED}`}>You&apos;re up to date.</p>
          )}

          {updateError && (
            <p className="m-0 text-sm text-[#ffd5d5]">{updateError}</p>
          )}
        </div>
      </div>

      {/* Danger Zone */}
      <div className={CARD}>
        <h3 className="m-0 mb-1 font-semibold text-[#ff9e9e]">Danger zone</h3>
        <p className={`m-0 mb-4 text-sm ${MUTED}`}>
          Permanently delete all synced save files, game folders, and configuration stored on Google Drive for this account. Your local game library is not affected.
        </p>
        <button
          type="button"
          className={DANGER_BTN}
          disabled={clearAllDrive.isPending}
          onClick={() => setShowClearModal(true)}
        >
          {clearAllDrive.isPending ? "Clearing…" : "Clear all Drive data"}
        </button>
        {clearAllDrive.isError && (
          <p className="m-0 mt-3 text-sm text-[#ffd5d5]">
            {clearAllDrive.error instanceof Error
              ? clearAllDrive.error.message
              : "Failed to clear Drive data."}
          </p>
        )}
        {clearAllDrive.isSuccess && (
          <p className="m-0 mt-3 text-sm text-[#9effc3]">
            All Drive data has been cleared.
          </p>
        )}
      </div>

      <ConfirmModal
        open={showClearModal}
        title="Clear all Drive data"
        message="This will permanently delete all synced save files, game folders, and library data from Google Drive for your account. This cannot be undone. Your local game list will be preserved."
        confirmLabel="Clear all Drive data"
        onConfirm={() => {
          setShowClearModal(false);
          clearAllDrive.mutate();
        }}
        onCancel={() => setShowClearModal(false)}
      />
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

// ── useAppUpdater (same-file hook) ────────────────────────

type UpdateStatus = 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'installed' | 'error';

interface DownloadProgress {
  downloaded: number;
  total: number;
}

function useAppUpdater() {
  const [status, setStatus] = useState<UpdateStatus>('idle');
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [update, setUpdate] = useState<Update | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getVersion().then(setCurrentVersion).catch(() => {});
  }, []);

  const handleCheck = async () => {
    setStatus('checking');
    setError(null);
    setUpdate(null);
    try {
      const result = await check();
      if (result) {
        setUpdate(result);
        setStatus('available');
      } else {
        setStatus('up-to-date');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('error');
    }
  };

  const handleInstall = async () => {
    if (!update) return;
    setStatus('downloading');
    setProgress(null);
    let totalSize = 0;
    let downloaded = 0;
    try {
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            totalSize = event.data.contentLength ?? 0;
            break;
          case 'Progress':
            downloaded += event.data.chunkLength;
            setProgress({ downloaded, total: totalSize });
            break;
          case 'Finished':
            setStatus('installed');
            break;
        }
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('error');
    }
  };

  return { status, currentVersion, update, progress, updateError: error, handleCheck, handleInstall };
}

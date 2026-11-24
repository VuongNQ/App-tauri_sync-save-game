import { useState } from "react";

import { useClearAllDriveMutation, useGoogleUserInfoQuery, useLogoutMutation } from "../queries";
import { useAppUpdateQuery } from "../queries/appUpdate";
import { useSettingsQuery, useUpdateSettingsMutation } from "../queries/settings";
import { ConfirmModal } from "../components/ConfirmModal";
import { LanguageSwitcher } from "../components/LanguageSwitcher";
import { useT } from "../i18n";
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
  const t = useT();

  const [showClearModal, setShowClearModal] = useState(false);

  const { status, currentVersion, update, progress, updateError, handleCheck, handleInstall } = useAppUpdater();

  const toggleSetting = (key: keyof AppSettings, value: boolean) => {
    if (!settings) return;
    updateSettings.mutate({ ...settings, [key]: value });
  };

  return (
    <>
      <div>
        <p className={EYEBROW}>{t("settings.eyebrow")}</p>
        <h2 className="m-0">{t("nav.settings")}</h2>
      </div>

      <div className={CARD}>
        <h3 className="m-0 mb-4 font-semibold">{t("language.title")}</h3>
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="m-0 text-[0.92rem] text-[#c7d3f7]">{t("language.label")}</p>
            <p className={`m-0 mt-0.5 text-xs ${MUTED}`}>{t("language.hint")}</p>
          </div>
          <LanguageSwitcher />
        </div>
      </div>

      <div className={CARD}>
        <h3 className="m-0 mb-4 font-semibold">{t("settings.account")}</h3>
        {isLoading ? (
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 shrink-0 rounded-full animate-pulse bg-[rgba(165,185,255,0.08)]" />
            <div className="flex-1 grid gap-2">
              <div className="h-4 w-32 rounded-xl animate-pulse bg-[rgba(165,185,255,0.08)]" />
              <div className="h-3 w-44 rounded-full animate-pulse bg-[rgba(165,185,255,0.08)]" />
            </div>
          </div>
        ) : userInfo ? (
          <div className="flex items-center gap-4">
            {userInfo.picture && (
              <img src={userInfo.picture} alt="" className="h-12 w-12 rounded-full object-cover" referrerPolicy="no-referrer" />
            )}
            <div className="flex-1 min-w-0">
              {userInfo.name && <p className="m-0 font-medium text-[#eef4ff] truncate">{userInfo.name}</p>}
              <p className={`m-0 text-sm truncate ${MUTED}`}>{userInfo.email}</p>
            </div>
            <button
              type="button"
              className={`${BTN} rounded-xl bg-red-500/15 px-4 py-2 text-sm font-medium text-red-400 hover:bg-red-500/25`}
              disabled={logoutMutation.isPending}
              onClick={() => logoutMutation.mutate()}
            >
              {logoutMutation.isPending ? t("settings.signingOut") : t("settings.signOut")}
            </button>
          </div>
        ) : (
          <div>
            <p className={MUTED}>{t("settings.accountError")}{error ? ` (${error.message})` : ""}</p>
            <p className={`mt-2 text-xs ${MUTED}`}>{t("settings.accountErrorHint")}</p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                className={`${BTN} rounded-xl bg-white/10 px-4 py-2 text-sm font-medium text-[#eef4ff] hover:bg-white/15`}
                onClick={() => refetch()}
              >
                {t("common.retry")}
              </button>
              <button
                type="button"
                className={`${BTN} rounded-xl bg-red-500/15 px-4 py-2 text-sm font-medium text-red-400 hover:bg-red-500/25`}
                disabled={logoutMutation.isPending}
                onClick={() => logoutMutation.mutate()}
              >
                {logoutMutation.isPending ? t("settings.signingOut") : t("settings.signOutRelogin")}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className={CARD}>
        <h3 className="m-0 mb-4 font-semibold">{t("settings.syncPrefs")}</h3>
        {settings ? (
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="m-0 text-[0.92rem] text-[#c7d3f7]">{t("settings.interval")}</p>
                <p className={`m-0 mt-0.5 text-xs ${MUTED}`}>{t("settings.intervalHint")}</p>
              </div>
              <input
                type="number"
                min={0}
                max={1440}
                aria-label={t("settings.interval")}
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
          <SettingsSectionSkeleton rows={1} />
        )}
      </div>

      <div className={CARD}>
        <h3 className="m-0 mb-4 font-semibold">{t("settings.startup")}</h3>
        {settings ? (
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="m-0 text-[0.92rem] text-[#c7d3f7]">{t("settings.tray")}</p>
                <p className={`m-0 mt-0.5 text-xs ${MUTED}`}>
                  {t("settings.trayHint")}
                </p>
              </div>
              <span className="shrink-0 rounded-lg bg-[rgba(109,125,255,0.14)] px-3 py-1 text-xs text-[#a3b0ff]">{t("settings.alwaysOn")}</span>
            </div>
            <ToggleRow
              label={t("settings.startMinimized")}
              description={t("settings.startMinimizedHint")}
              checked={settings.startMinimised}
              onChange={(v) => toggleSetting("startMinimised", v)}
            />
            <ToggleRow
              label={t("settings.runOnStartup")}
              description={t("settings.runOnStartupHint")}
              checked={settings.runOnStartup}
              onChange={(v) => toggleSetting("runOnStartup", v)}
            />
            <ToggleRow
              label={t("settings.autoPull")}
              description={t("settings.autoPullHint")}
              checked={settings.autoPullOnStartup}
              onChange={(v) => toggleSetting("autoPullOnStartup", v)}
            />
          </div>
        ) : (
          <SettingsSectionSkeleton rows={4} />
        )}
      </div>

      {/* App Updates */}
      <div className={CARD}>
        <h3 className="m-0 mb-4 font-semibold">{t("settings.updates")}</h3>
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="m-0 text-[0.92rem] text-[#c7d3f7]">{t("settings.currentVersion")}</p>
              {currentVersion && <p className={`m-0 mt-0.5 font-mono text-xs ${MUTED}`}>v{currentVersion}</p>}
            </div>
            <button
              type="button"
              className={`${BTN} rounded-xl bg-white/10 px-4 py-2 text-sm font-medium text-[#eef4ff] hover:bg-white/15 disabled:opacity-50`}
              disabled={status === "checking" || status === "downloading"}
              onClick={handleCheck}
            >
              {status === "checking" ? t("status.checking") : t("settings.checkUpdates")}
            </button>
          </div>

          {status === "available" && (
            <div className="rounded-xl border border-[rgba(140,165,241,0.2)] bg-[rgba(99,125,255,0.08)] p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="m-0 text-sm font-semibold text-[#9effc3]">{t("settings.updateAvailable", { version: update?.version ?? "" })}</p>
                  {update?.body && <p className={`m-0 mt-1 whitespace-pre-wrap text-xs ${MUTED}`}>{update.body}</p>}
                </div>
                <button
                  type="button"
                  className={`${BTN} shrink-0 rounded-xl bg-indigo-500/20 px-4 py-2 text-sm font-medium text-indigo-300 hover:bg-indigo-500/30`}
                  onClick={handleInstall}
                >
                  {t("settings.install")}
                </button>
              </div>
            </div>
          )}

          {status === "downloading" && (
            <div>
              <p className={`m-0 mb-1 text-sm ${MUTED}`}>
                {t("settings.downloading")}
                {progress && progress.total > 0 ? ` ${Math.round((progress.downloaded / progress.total) * 100)}%` : ""}
              </p>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-indigo-400 transition-all duration-300"
                  style={{
                    width: progress && progress.total > 0 ? `${Math.round((progress.downloaded / progress.total) * 100)}%` : "10%",
                  }}
                />
              </div>
            </div>
          )}

          {status === "installed" && <p className="m-0 text-sm text-[#9effc3]">{t("settings.restarting")}</p>}

          {status === "up-to-date" && <p className={`m-0 text-sm ${MUTED}`}>{t("settings.upToDate")}</p>}

          {updateError && <p className="m-0 text-sm text-[#ffd5d5]">{updateError}</p>}
        </div>
      </div>

      {/* Danger Zone */}
      <div className={CARD}>
        <h3 className="m-0 mb-1 font-semibold text-[#ff9e9e]">{t("common.dangerZone")}</h3>
        <p className={`m-0 mb-4 text-sm ${MUTED}`}>
          {t("settings.clearDriveBody")}
        </p>
        <button type="button" className={DANGER_BTN} disabled={clearAllDrive.isPending} onClick={() => setShowClearModal(true)}>
          {clearAllDrive.isPending ? t("login.clearing") : t("settings.clearDrive")}
        </button>
        {clearAllDrive.isError && (
          <p className="m-0 mt-3 text-sm text-[#ffd5d5]">
            {clearAllDrive.error instanceof Error ? clearAllDrive.error.message : t("settings.clearDriveFailed")}
          </p>
        )}
        {clearAllDrive.isSuccess && <p className="m-0 mt-3 text-sm text-[#9effc3]">{t("settings.clearDriveDone")}</p>}
      </div>

      <ConfirmModal
        open={showClearModal}
        title={t("settings.clearDrive")}
        message={t("settings.clearDriveMessage")}
        confirmLabel={t("settings.clearDrive")}
        onConfirm={() => {
          setShowClearModal(false);
          clearAllDrive.mutate();
        }}
        onCancel={() => setShowClearModal(false)}
      />
    </>
  );
}

// ── SettingsSectionSkeleton (same-file helper) ───────────

function SettingsSectionSkeleton({ rows }: { rows: number }) {
  return (
    <div className="flex flex-col gap-4">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center justify-between gap-3">
          <div className="grid gap-1.5">
            <div className="h-4 w-40 rounded-xl animate-pulse bg-[rgba(165,185,255,0.08)]" />
            <div className="h-3 w-60 rounded-full animate-pulse bg-[rgba(165,185,255,0.08)]" />
          </div>
          <div className="w-12 h-6 rounded-full shrink-0 animate-pulse bg-[rgba(165,185,255,0.08)]" />
        </div>
      ))}
    </div>
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
        aria-label={label}
        className={checked ? TOGGLE_TRACK_ON : TOGGLE_TRACK_OFF}
        onClick={() => onChange(!checked)}
      >
        <span className={checked ? TOGGLE_THUMB_ON : TOGGLE_THUMB} />
      </button>
    </div>
  );
}

// ── useAppUpdater (same-file hook) ────────────────────────

type UpdateStatus = "idle" | "checking" | "up-to-date" | "available" | "downloading" | "installed" | "error";

interface DownloadProgress {
  downloaded: number;
  total: number;
}

function useAppUpdater() {
  const updateQuery = useAppUpdateQuery();
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);

  const handleCheck = async () => {
    setStatus("checking");
    setInstallError(null);
    await updateQuery.refetch();
    setStatus("idle");
  };

  const handleInstall = async () => {
    const update = updateQuery.data?.update;
    if (!update) return;
    setStatus("downloading");
    setProgress(null);
    setInstallError(null);
    let totalSize = 0;
    let downloaded = 0;
    try {
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            totalSize = event.data.contentLength ?? 0;
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            setProgress({ downloaded, total: totalSize });
            break;
          case "Finished":
            setStatus("installed");
            break;
        }
      });
    } catch (e) {
      setInstallError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  };

  const currentVersion = updateQuery.data?.currentVersion ?? null;
  const update = updateQuery.data?.update ?? null;
  const updateError = installError ?? updateQuery.data?.error ?? null;
  const derivedStatus =
    status === "downloading" || status === "installed" || status === "error"
      ? status
      : updateQuery.isFetching
        ? "checking"
        : update
          ? "available"
          : updateError
            ? "error"
            : "up-to-date";

  return { status: derivedStatus, currentVersion, update, progress, updateError, handleCheck, handleInstall };
}

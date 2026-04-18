import { useState } from "react";

import { useDevicesQuery, useRemoveDeviceMutation, useRenameDeviceMutation } from "../queries";
import { ConfirmModal } from "../components/ConfirmModal";
import { BTN, CARD, EYEBROW, MUTED } from "../components/styles";
import type { DeviceInfo } from "../types/dashboard";
import { formatLocalTime } from "../utils";

export function DevicesPage() {
  const { data: devices, isLoading, error } = useDevicesQuery();

  return (
    <>
      <div>
        <p className={EYEBROW}>Management</p>
        <h2 className="m-0">My Devices</h2>
        <p className={`mt-1 text-sm ${MUTED}`}>
          All Windows machines that have signed in with your Google account. The app registers each
          device automatically on startup.
        </p>
      </div>

      {isLoading && <DeviceListSkeleton />}

      {error && (
        <div className={CARD}>
          <p className={`m-0 text-sm ${MUTED}`}>
            Failed to load devices: {error instanceof Error ? error.message : String(error)}
          </p>
        </div>
      )}

      {!isLoading && !error && devices && devices.length === 0 && (
        <div className={CARD}>
          <p className={`m-0 text-sm ${MUTED}`}>
            No devices registered yet. They will appear here after you sign in on a machine.
          </p>
        </div>
      )}

      {devices &&
        devices.map((device) => <DeviceCard key={device.id} device={device} />)}
    </>
  );
}

// ── DeviceCard ────────────────────────────────────────────

interface DeviceCardProps {
  device: DeviceInfo;
}

function DeviceCard({ device }: DeviceCardProps) {
  const [renaming, setRenaming] = useState(false);
  const [nameInput, setNameInput] = useState(device.name);
  const [showRemoveModal, setShowRemoveModal] = useState(false);

  const renameMutation = useRenameDeviceMutation();
  const removeMutation = useRemoveDeviceMutation();

  const handleRenameSubmit = () => {
    const trimmed = nameInput.trim();
    if (!trimmed || trimmed === device.name) {
      setRenaming(false);
      setNameInput(device.name);
      return;
    }
    renameMutation.mutate(
      { deviceId: device.id, name: trimmed },
      { onSettled: () => setRenaming(false) }
    );
  };

  const handleRenameCancel = () => {
    setRenaming(false);
    setNameInput(device.name);
  };

  const ramGb = (device.totalRamMb / 1024).toFixed(1);

  return (
    <>
      <div
        className={`${CARD} ${device.isCurrent ? "border-[rgba(109,125,255,0.4)]" : ""}`}
      >
        {/* ── Header row ── */}
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="flex-1 min-w-0">
            {renaming ? (
              <div className="flex items-center gap-2">
                <input
                  autoFocus
                  type="text"
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleRenameSubmit();
                    if (e.key === "Escape") handleRenameCancel();
                  }}
                  className="flex-1 min-w-0 rounded-[10px] border border-[rgba(140,165,241,0.28)] bg-[rgba(7,12,23,0.84)] px-3 py-1.5 text-[#eef4ff] focus:outline-2 focus:outline-[rgba(122,180,255,0.35)] focus:outline-offset-1"
                />
                <button
                  type="button"
                  className={`${BTN} rounded-lg bg-indigo-500/20 px-3 py-1.5 text-xs font-semibold text-indigo-300 hover:bg-indigo-500/30 disabled:opacity-40`}
                  disabled={renameMutation.isPending}
                  onClick={handleRenameSubmit}
                >
                  {renameMutation.isPending ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  className={`${BTN} rounded-lg bg-white/8 px-3 py-1.5 text-xs font-semibold text-[#c7d3f7] hover:bg-white/12`}
                  onClick={handleRenameCancel}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="m-0 text-base font-semibold text-[#eef4ff] truncate">
                  {device.name}
                </h3>
                {device.isCurrent && (
                  <span className="inline-flex items-center rounded-full bg-[rgba(109,125,255,0.18)] px-2.5 py-0.5 text-[0.72rem] font-medium text-[#a3b0ff]">
                    this device
                  </span>
                )}
                {device.name !== device.hostname && (
                  <span className={`text-xs ${MUTED}`}>({device.hostname})</span>
                )}
              </div>
            )}
          </div>

          {/* ── Action buttons ── */}
          {!renaming && (
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                className={`${BTN} rounded-xl bg-white/8 px-3 py-1.5 text-xs font-medium text-[#c7d3f7] hover:bg-white/12`}
                onClick={() => {
                  setNameInput(device.name);
                  setRenaming(true);
                }}
              >
                Rename
              </button>
              <button
                type="button"
                className={`${BTN} rounded-xl bg-red-500/12 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/22 disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none`}
                disabled={!!device.isCurrent}
                title={device.isCurrent ? "Cannot remove the device you are currently using" : undefined}
                onClick={() => setShowRemoveModal(true)}
              >
                Remove
              </button>
            </div>
          )}
        </div>

        {/* ── Info grid ── */}
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 max-[560px]:grid-cols-1">
          <DeviceInfoRow label="OS" value={`${device.osName} ${device.osVersion}`.trim()} />
          <DeviceInfoRow label="CPU" value={`${device.cpuName} (${device.cpuCores} cores)`} />
          <DeviceInfoRow label="RAM" value={`${ramGb} GB`} />
          <DeviceInfoRow label="Hostname" value={device.hostname} />
          <DeviceInfoRow label="Registered" value={formatLocalTime(device.registeredAt)} />
          <DeviceInfoRow label="Last seen" value={formatLocalTime(device.lastSeenAt)} />
        </dl>
      </div>

      <ConfirmModal
        open={showRemoveModal}
        title="Remove device"
        message={`Remove "${device.name}" from your device list? This only removes the registration record — it does not affect any save files.`}
        confirmLabel="Remove device"
        onConfirm={() => {
          setShowRemoveModal(false);
          removeMutation.mutate(device.id);
        }}
        onCancel={() => setShowRemoveModal(false)}
      />
    </>
  );
}

// ── DeviceInfoRow (same-file helper) ─────────────────────

function DeviceInfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2 min-w-0">
      <dt className={`shrink-0 text-xs ${MUTED}`}>{label}</dt>
      <dd className="m-0 truncate text-sm text-[#c7d3f7]" title={value}>
        {value}
      </dd>
    </div>
  );
}

// ── DeviceListSkeleton (same-file helper) ─────────────────

function DeviceListSkeleton() {
  return (
    <>
      {[0, 1].map((i) => (
        <div key={i} className={CARD}>
          <div className="flex items-start justify-between gap-3 mb-4">
            <div className="h-5 w-48 rounded-xl animate-pulse bg-[rgba(165,185,255,0.08)]" />
            <div className="flex gap-2">
              <div className="h-7 w-16 rounded-xl animate-pulse bg-[rgba(165,185,255,0.08)]" />
              <div className="h-7 w-16 rounded-xl animate-pulse bg-[rgba(165,185,255,0.08)]" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2">
            {[0, 1, 2, 3, 4, 5].map((j) => (
              <div key={j} className="flex items-baseline gap-2">
                <div className="h-3 w-14 rounded-full animate-pulse bg-[rgba(165,185,255,0.06)]" />
                <div className="h-3 w-32 rounded-full animate-pulse bg-[rgba(165,185,255,0.08)]" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

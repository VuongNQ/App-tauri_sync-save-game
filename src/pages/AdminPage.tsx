import { useState } from "react";

import { useAdminConfigQuery, useAdminUsersQuery, useUpdateAdminConfigMutation, useUpdateUserRoleMutation } from "../queries";
import { DEFAULT_DRIVE_QUOTA_BYTES } from "../types/dashboard";
import type { UserProfile, UserRole } from "../types/dashboard";
import { BTN, CARD, EYEBROW, MUTED } from "../components/styles";
import { formatLocalTime } from "../utils";

export function AdminPage() {
  const usersQuery = useAdminUsersQuery();
  const configQuery = useAdminConfigQuery();
  const updateConfig = useUpdateAdminConfigMutation();
  const updateRole = useUpdateUserRoleMutation();

  return (
    <>
      <div>
        <p className={EYEBROW}>Administration</p>
        <h2 className="m-0">Admin</h2>
        <p className={`mt-1 text-sm ${MUTED}`}>Manage user roles and the global Drive quota.</p>
      </div>

      <div className={CARD}>
        <h3 className="m-0 mb-4 font-semibold">Drive quota</h3>
        {configQuery.isLoading ? (
          <div className="h-10 w-56 animate-pulse rounded-xl bg-[rgba(165,185,255,0.08)]" />
        ) : configQuery.error ? (
          <p className="m-0 text-sm text-[#ffd5d5]">
            Failed to load quota: {configQuery.error instanceof Error ? configQuery.error.message : String(configQuery.error)}
          </p>
        ) : (
          <QuotaEditor
            key={configQuery.data?.driveQuotaBytes ?? "quota"}
            driveQuotaBytes={configQuery.data?.driveQuotaBytes ?? DEFAULT_DRIVE_QUOTA_BYTES}
            isSaving={updateConfig.isPending}
            onSave={(driveQuotaBytes) => updateConfig.mutate({ driveQuotaBytes })}
          />
        )}
      </div>

      <div className={CARD}>
        <h3 className="m-0 mb-4 font-semibold">Users</h3>
        {usersQuery.isLoading ? (
          <UserListSkeleton />
        ) : usersQuery.error ? (
          <p className="m-0 text-sm text-[#ffd5d5]">
            Failed to load users: {usersQuery.error instanceof Error ? usersQuery.error.message : String(usersQuery.error)}
          </p>
        ) : !usersQuery.data || usersQuery.data.length === 0 ? (
          <p className={`m-0 text-sm ${MUTED}`}>No users found yet.</p>
        ) : (
          <div className="grid gap-3">
            {usersQuery.data.map((user) => (
              <UserRow
                key={`${user.userId}:${user.role}`}
                user={user}
                onChangeRole={(role) => updateRole.mutate({ userId: user.userId, role })}
                pending={updateRole.isPending}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function UserRow({
  user,
  onChangeRole,
  pending,
}: {
  user: UserProfile;
  onChangeRole: (role: UserRole) => void;
  pending: boolean;
}) {
  const [role, setRole] = useState<UserRole>(user.role);

  return (
    <div className="rounded-2xl border border-[rgba(140,165,241,0.12)] bg-[rgba(7,12,23,0.35)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="m-0 font-medium text-[#eef4ff] truncate">{user.name ?? user.email}</p>
          <p className={`m-0 text-xs ${MUTED}`}>{user.email}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-xs ${MUTED}`}>Role</span>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as UserRole)}
            className="rounded-lg border border-[rgba(140,165,241,0.16)] bg-[rgba(7,12,23,0.84)] px-3 py-2 text-sm text-[#eef4ff] focus:outline-2 focus:outline-[rgba(122,180,255,0.35)] focus:outline-offset-1"
          >
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
          <button
            type="button"
            className={`${BTN} rounded-xl bg-white/10 px-4 py-2 text-sm font-medium text-[#eef4ff] hover:bg-white/15 disabled:opacity-50`}
            disabled={pending || role === user.role}
            onClick={() => onChangeRole(role)}
          >
            Save
          </button>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs">
        <span className={MUTED}>Registered: {formatLocalTime(user.registeredAt)}</span>
        <span className={MUTED}>Last seen: {formatLocalTime(user.lastSeenAt)}</span>
        <span className={MUTED}>ID: {user.userId}</span>
      </div>
    </div>
  );
}

function QuotaEditor({
  driveQuotaBytes,
  isSaving,
  onSave,
}: {
  driveQuotaBytes: number;
  isSaving: boolean;
  onSave: (driveQuotaBytes: number) => void;
}) {
  const [quotaMb, setQuotaMb] = useState(() => String(Math.max(1, Math.round(driveQuotaBytes / 1024 / 1024))));

  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const mb = Math.max(1, Number(quotaMb) || 1);
        onSave(mb * 1024 * 1024);
      }}
    >
      <label className="grid gap-1">
        <span className={`text-xs ${MUTED}`}>Global limit (MB)</span>
        <input
          type="number"
          min={1}
          className="w-32 rounded-lg border border-[rgba(140,165,241,0.16)] bg-[rgba(7,12,23,0.84)] px-3 py-2 text-[#eef4ff] focus:outline-2 focus:outline-[rgba(122,180,255,0.35)] focus:outline-offset-1"
          value={quotaMb}
          onChange={(e) => setQuotaMb(e.target.value)}
        />
      </label>
      <button
        type="submit"
        className={`${BTN} rounded-xl bg-indigo-500/20 px-4 py-2 text-sm font-medium text-indigo-300 hover:bg-indigo-500/30 disabled:opacity-50`}
        disabled={isSaving}
      >
        {isSaving ? "Saving…" : "Save quota"}
      </button>
      <p className={`m-0 text-xs ${MUTED}`}>Current limit: {formatBytes(driveQuotaBytes)}</p>
    </form>
  );
}

function UserListSkeleton() {
  return (
    <div className="grid gap-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-24 rounded-2xl animate-pulse bg-[rgba(165,185,255,0.08)]" />
      ))}
    </div>
  );
}

function formatBytes(bytes: number) {
  const mb = bytes / 1024 / 1024;
  return `${mb.toFixed(0)} MB`;
}

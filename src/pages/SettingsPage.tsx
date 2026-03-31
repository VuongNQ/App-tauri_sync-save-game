import { useGoogleUserInfoQuery, useLogoutMutation } from "../queries";
import { BTN, CARD, EYEBROW, MUTED } from "../components/styles";

export function SettingsPage() {
  const { data: userInfo, isLoading, error, refetch } = useGoogleUserInfoQuery();
  const logoutMutation = useLogoutMutation();

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
        <h3 className="m-0 mb-2 font-semibold">Sync preferences</h3>
        <p className={MUTED}>Global sync settings — coming soon.</p>
      </div>

      <div className={CARD}>
        <h3 className="m-0 mb-2 font-semibold">Startup &amp; Background</h3>
        <p className={MUTED}>System tray and Windows startup options — coming soon.</p>
      </div>
    </>
  );
}

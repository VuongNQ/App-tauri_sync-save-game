import { useEffect } from "react";
import { useNavigate } from "react-router";

import { CARD, MUTED, PRIMARY_BTN } from "../components/styles";
import { useAuthStatusQuery, useLoginMutation, useLogoutMutation } from "../queries";
import { msg } from "../utils";

export function LoginPage() {
  const navigate = useNavigate();
  const { data: authStatus, error: authError } = useAuthStatusQuery();
  const login = useLoginMutation();
  const resetSession = useLogoutMutation();

  useEffect(() => {
    if (authStatus?.authenticated) {
      navigate("/", { replace: true });
    }
  }, [authStatus?.authenticated, navigate]);

  async function handleLogin() {
    await login.mutateAsync();
  }

  const isRedirecting = authStatus?.authenticated === true;

  return (
    <div className="grid min-h-screen place-items-center p-6">
      <div className={`${CARD} w-full max-w-md text-center grid gap-6`}>
        <div className="grid gap-2">
          <h1 className="m-0 text-2xl font-bold">Save Game Sync</h1>
          <p className={MUTED}>Connect your Google account to sync your save games across devices.</p>
        </div>

        <button className={PRIMARY_BTN} type="button" onClick={handleLogin} disabled={login.isPending || resetSession.isPending || isRedirecting}>
          {login.isPending ? "Connecting…" : isRedirecting ? "Redirecting…" : "Connect with Google"}
        </button>

        {isRedirecting && <p className={MUTED}>Login successful. Returning to your dashboard…</p>}

        {authError && (
          <div className="grid gap-3">
            <p className="m-0 text-sm text-[#ffd5d5]">{msg(authError, "Saved sign-in could not be read.")}</p>
            <button type="button" className="text-sm underline text-[#c7d3f7]" disabled={login.isPending || resetSession.isPending} onClick={() => resetSession.mutate()}>
              {resetSession.isPending ? "Clearing…" : "Clear saved sign-in"}
            </button>
          </div>
        )}
        {resetSession.isError && <p className="m-0 text-sm text-[#ffd5d5]">{msg(resetSession.error, "Unable to clear saved sign-in.")}</p>}

        {login.isError && <p className="m-0 text-sm text-[#ffd5d5]">{msg(login.error, "Unable to connect to Google.")}</p>}
      </div>
    </div>
  );
}

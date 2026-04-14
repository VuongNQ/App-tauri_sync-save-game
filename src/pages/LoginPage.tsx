import { useEffect } from "react";
import { useNavigate } from "react-router";

import { CARD, MUTED, PRIMARY_BTN } from "../components/styles";
import { useAuthStatusQuery, useLoginMutation } from "../queries";
import { msg } from "../utils";

export function LoginPage() {
  const navigate = useNavigate();
  const { data: authStatus } = useAuthStatusQuery();
  const login = useLoginMutation();

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

        <button className={PRIMARY_BTN} type="button" onClick={handleLogin} disabled={login.isPending || isRedirecting}>
          {login.isPending ? "Connecting…" : isRedirecting ? "Redirecting…" : "Connect with Google"}
        </button>

        {isRedirecting && <p className={MUTED}>Login successful. Returning to your dashboard…</p>}

        {login.isError && <p className="m-0 text-sm text-[#ffd5d5]">{msg(login.error, "Unable to connect to Google.")}</p>}
      </div>
    </div>
  );
}

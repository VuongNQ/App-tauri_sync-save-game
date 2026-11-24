import { useEffect } from "react";
import { useNavigate } from "react-router";

import { LanguageSwitcher } from "../components/LanguageSwitcher";
import { CARD, MUTED, PRIMARY_BTN } from "../components/styles";
import { useT } from "../i18n";
import { useAuthStatusQuery, useLoginMutation, useLogoutMutation } from "../queries";
import { msg } from "../utils";

export function LoginPage() {
  const navigate = useNavigate();
  const { data: authStatus, error: authError } = useAuthStatusQuery();
  const login = useLoginMutation();
  const resetSession = useLogoutMutation();
  const t = useT();

  useEffect(() => {
    if (authStatus?.authenticated && authStatus.userId) {
      navigate("/", { replace: true });
    }
  }, [authStatus?.authenticated, authStatus?.userId, navigate]);

  async function handleLogin() {
    await login.mutateAsync();
  }

  const isRedirecting = authStatus?.authenticated === true && !!authStatus.userId;

  return (
    <div className="relative grid min-h-screen place-items-center p-6">
      <div className="absolute right-6 top-6">
        <LanguageSwitcher compact />
      </div>
      <div className={`${CARD} w-full max-w-md text-center grid gap-6`}>
        <div className="grid gap-2">
          <h1 className="m-0 text-2xl font-bold">{t("app.name")}</h1>
          <p className={MUTED}>{t("login.subtitle")}</p>
        </div>

        <button className={PRIMARY_BTN} type="button" onClick={handleLogin} disabled={login.isPending || resetSession.isPending || isRedirecting}>
          {login.isPending ? t("login.connecting") : isRedirecting ? t("login.redirecting") : t("login.connect")}
        </button>

        {isRedirecting && <p className={MUTED}>{t("login.success")}</p>}

        {authError && (
          <div className="grid gap-3">
            <p className="m-0 text-sm text-[#ffd5d5]">{msg(authError, t("login.errorReadSession"))}</p>
            <button type="button" className="text-sm underline text-[#c7d3f7]" disabled={login.isPending || resetSession.isPending} onClick={() => resetSession.mutate()}>
              {resetSession.isPending ? t("login.clearing") : t("login.clearSession")}
            </button>
          </div>
        )}
        {resetSession.isError && <p className="m-0 text-sm text-[#ffd5d5]">{msg(resetSession.error, t("login.errorClear"))}</p>}

        {login.isError && <p className="m-0 text-sm text-[#ffd5d5]">{msg(login.error, t("login.errorConnect"))}</p>}
      </div>
    </div>
  );
}

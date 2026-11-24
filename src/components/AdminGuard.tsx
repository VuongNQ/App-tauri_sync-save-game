import { Navigate, Outlet } from "react-router";

import { useT } from "../i18n";
import { useAuthStatusQuery } from "../queries";
import { CARD, MUTED } from "./styles";

export function AdminGuard() {
  const { data: authStatus, isLoading } = useAuthStatusQuery();
  const t = useT();

  if (isLoading) {
    return (
      <div className="grid min-h-screen place-items-center">
        <div className={`${CARD} text-center`}>
          <p className={MUTED}>{t("auth.checkingAdmin")}</p>
        </div>
      </div>
    );
  }

  if (authStatus?.role !== "admin") {
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
}

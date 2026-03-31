import { Navigate, Outlet } from "react-router";

import { useAuthStatusQuery } from "../queries";
import { CARD, MUTED } from "./styles";

export function AuthGuard() {
  const { data: authStatus, isLoading } = useAuthStatusQuery();

  if (isLoading) {
    return (
      <div className="grid min-h-screen place-items-center">
        <div className={`${CARD} text-center`}>
          <p className={MUTED}>Checking authentication…</p>
        </div>
      </div>
    );
  }

  if (!authStatus?.authenticated) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}

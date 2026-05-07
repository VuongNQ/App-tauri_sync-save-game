import { Navigate, Outlet } from "react-router";

import { useAuthStatusQuery } from "../queries";
import { CARD, MUTED } from "./styles";

export function AdminGuard() {
  const { data: authStatus, isLoading } = useAuthStatusQuery();

  if (isLoading) {
    return (
      <div className="grid min-h-screen place-items-center">
        <div className={`${CARD} text-center`}>
          <p className={MUTED}>Checking admin access…</p>
        </div>
      </div>
    );
  }

  if (authStatus?.role !== "admin") {
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
}

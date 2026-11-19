import type { QueryClient } from "@tanstack/react-query";
import type { AuthStatus } from "../types/dashboard.ts";
import { AUTH_STATUS_KEY } from "./keys.ts";

/** Account-scoped caches and in-flight results must never survive an account change. */
export async function applyAuthStatus(queryClient: QueryClient, status: AuthStatus) {
  const previous = queryClient.getQueryData<AuthStatus>(AUTH_STATUS_KEY);
  if (previous?.userId !== status.userId || previous?.authenticated !== status.authenticated) {
    await queryClient.cancelQueries();
    queryClient.clear();
  }
  queryClient.setQueryData<AuthStatus>(AUTH_STATUS_KEY, status);
}

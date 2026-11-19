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

/** Mutations cannot be cancelled like queries. Ignore callbacks from old screens/accounts. */
export function accountResult<T>(queryClient: QueryClient, apply: (data: T) => unknown) {
  const owner = queryClient.getQueryData<AuthStatus>(AUTH_STATUS_KEY)?.userId;
  return (data: T) => {
    const current = queryClient.getQueryData<AuthStatus>(AUTH_STATUS_KEY);
    if (owner && current?.authenticated && current.userId === owner) apply(data);
  };
}

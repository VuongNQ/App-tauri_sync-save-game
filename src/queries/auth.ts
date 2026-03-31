import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { checkAuthStatus, startOAuthLogin } from "../services/tauri";
import type { AuthStatus } from "../types/dashboard";
import { AUTH_STATUS_KEY } from "./keys";

export function useAuthStatusQuery() {
  return useQuery({
    queryKey: AUTH_STATUS_KEY,
    queryFn: checkAuthStatus,
  });
}

export function useLoginMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: startOAuthLogin,
    onSuccess: (data: AuthStatus) =>
      queryClient.setQueryData<AuthStatus>(AUTH_STATUS_KEY, data),
  });
}

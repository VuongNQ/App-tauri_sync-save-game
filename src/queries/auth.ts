import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { signIn, signOut } from "@choochmeque/tauri-plugin-google-auth-api";

import {
  checkAuthStatus,
  getOAuthCredentials,
  logout,
  saveAuthTokens,
} from "../services/tauri";
import type { AuthStatus } from "../types/dashboard";
import { AUTH_STATUS_KEY } from "./keys";

const SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive.appdata",
];

export function useAuthStatusQuery() {
  return useQuery({
    queryKey: AUTH_STATUS_KEY,
    queryFn: checkAuthStatus,
  });
}

export function useLoginMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<AuthStatus> => {
      // 1. Get credentials from Rust backend (never hardcode in frontend)
      const creds = await getOAuthCredentials();

      // 2. Use the plugin to run the OAuth flow
      const tokenResponse = await signIn({
        clientId: creds.clientId,
        clientSecret: creds.clientSecret || undefined,
        scopes: SCOPES,
      });

      // 3. Send tokens to Rust backend for persistence
      return saveAuthTokens({
        accessToken: tokenResponse.accessToken,
        refreshToken: tokenResponse.refreshToken ?? null,
        expiresAt: tokenResponse.expiresAt ?? null,
      });
    },
    onSuccess: (data: AuthStatus) =>
      queryClient.setQueryData<AuthStatus>(AUTH_STATUS_KEY, data),
  });
}

export function useLogoutMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<AuthStatus> => {
      await signOut();
      return logout();
    },
    onSuccess: (data: AuthStatus) =>
      queryClient.setQueryData<AuthStatus>(AUTH_STATUS_KEY, data),
  });
}

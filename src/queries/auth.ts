import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { signIn, signOut } from "@choochmeque/tauri-plugin-google-auth-api";

import { checkAuthStatus, getGoogleUserInfo, getOAuthCredentials, logout, saveAuthTokens } from "../services/tauri";
import type { AuthStatus } from "../types/dashboard";
import { AUTH_STATUS_KEY, GOOGLE_USER_INFO_KEY } from "./keys";

const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive.appdata",
  "https://www.googleapis.com/auth/datastore",
];

export function useAuthStatusQuery() {
  return useQuery({
    queryKey: AUTH_STATUS_KEY,
    queryFn: checkAuthStatus,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
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
        successHtmlResponse: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Save Game Sync — Connected</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #0f172a;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #e2e8f0;
    }
    .card {
      background: #1e293b;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 16px;
      padding: 2.5rem 3rem;
      text-align: center;
      max-width: 400px;
      width: 90%;
      box-shadow: 0 25px 50px rgba(0,0,0,0.4);
    }
    .icon {
      width: 56px; height: 56px;
      background: #22c55e;
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      margin: 0 auto 1.25rem;
      font-size: 1.75rem;
    }
    h1 { font-size: 1.25rem; font-weight: 700; margin-bottom: 0.5rem; }
    p { font-size: 0.9rem; color: #94a3b8; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✓</div>
    <h1>Google account connected</h1>
    <p>You can close this tab and return to Save Game Sync.</p>
  </div>
</body>
</html>`,
      });

      // 3. Send tokens to Rust backend for persistence
      return saveAuthTokens({
        accessToken: tokenResponse.accessToken,
        refreshToken: tokenResponse.refreshToken ?? null,
        expiresAt: tokenResponse.expiresAt ?? null,
      });
    },
    onSuccess: (data: AuthStatus) => queryClient.setQueryData<AuthStatus>(AUTH_STATUS_KEY, data),
  });
}

export function useLogoutMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<AuthStatus> => {
      await signOut();
      return logout();
    },
    onSuccess: (data: AuthStatus) => {
      queryClient.setQueryData<AuthStatus>(AUTH_STATUS_KEY, data);
      queryClient.removeQueries({ queryKey: GOOGLE_USER_INFO_KEY });
    },
  });
}

export function useGoogleUserInfoQuery() {
  const { data: authStatus } = useAuthStatusQuery();
  return useQuery({
    queryKey: GOOGLE_USER_INFO_KEY,
    queryFn: getGoogleUserInfo,
    enabled: authStatus?.authenticated === true,
  });
}

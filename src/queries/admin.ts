import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getAdminConfig, listUsers, updateAdminConfig, updateUserRole } from "../services/tauri";
import type { AdminConfig, UserProfile, UserRole } from "../types/dashboard";
import { AUTH_STATUS_KEY } from "./keys";

export const ADMIN_USERS_KEY = ["admin-users"] as const;
export const ADMIN_CONFIG_KEY = ["admin-config"] as const;

export function useAdminUsersQuery(enabled = true) {
  return useQuery({
    queryKey: ADMIN_USERS_KEY,
    queryFn: listUsers,
    enabled,
  });
}

export function useAdminConfigQuery(enabled = true) {
  return useQuery({
    queryKey: ADMIN_CONFIG_KEY,
    queryFn: getAdminConfig,
    enabled,
  });
}

export function useUpdateAdminConfigMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (config: AdminConfig) => updateAdminConfig(config),
    onSuccess: (data: AdminConfig) => queryClient.setQueryData<AdminConfig>(ADMIN_CONFIG_KEY, data),
  });
}

export function useUpdateUserRoleMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: UserRole }) => updateUserRole(userId, role),
    onSuccess: (data: UserProfile[]) => {
      queryClient.setQueryData<UserProfile[]>(ADMIN_USERS_KEY, data);
      void queryClient.invalidateQueries({ queryKey: AUTH_STATUS_KEY });
    },
  });
}

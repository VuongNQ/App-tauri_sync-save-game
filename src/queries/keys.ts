/** Centralised React Query key registry. */

export const DASHBOARD_KEY = ["dashboard"] as const;
export type DashboardKey = typeof DASHBOARD_KEY;

export const AUTH_STATUS_KEY = ["auth-status"] as const;
export type AuthStatusKey = typeof AUTH_STATUS_KEY;

export const SETTINGS_KEY = ["settings"] as const;
export type SettingsKey = typeof SETTINGS_KEY;

export const SAVE_INFO_KEY = ["save-info"] as const;
export type SaveInfoKey = typeof SAVE_INFO_KEY;

/** Centralised React Query key registry.
 *
 * All keys are plain const arrays so they are easy to invalidate and type-safe
 * when passed to `useQueryClient().setQueryData` / `invalidateQueries`.
 */

export const DASHBOARD_KEY = ["dashboard"] as const;
export type DashboardKey = typeof DASHBOARD_KEY;

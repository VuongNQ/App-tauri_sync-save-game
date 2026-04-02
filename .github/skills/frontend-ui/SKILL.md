---
name: frontend-ui
description: "Use when: creating React components, pages, hooks, routing, UI layout, styling, Vite config, TailwindCSS, frontend architecture for this Tauri app. Covers React 19 pure components, React Router 7, TailwindCSS 4, Vite 7, TypeScript 5.8+. Use for: new page, new component, form, layout, auth guard, route setup, query hook, mutation hook, frontend service function."
---

# Frontend UI — React 19 + TypeScript 5.8 + TailwindCSS 4

## Stack Versions

| Tool | Version | Notes |
|---|---|---|
| TypeScript | 5.8+ | Strict mode, `ES2020` target, `react-jsx` |
| React | 19 | Pure function components only — no classes |
| React Router | 7+ | `react-router` (not `react-router-dom` v6) |
| Vite | 7 | `@vitejs/plugin-react` + `@tailwindcss/vite` |
| TailwindCSS | 4 | Utility-first, `@import "tailwindcss"` in CSS |
| TanStack React Query | 5 | Server-state for all Tauri commands |

---

## Component Rules

### Pure Function Components

Every component is a plain function — no `React.FC`, no class components, no `forwardRef` unless the DOM ref is genuinely needed.

```tsx
interface Props {
  title: string;
  onAction: () => void;
}

export function MyCard({ title, onAction }: Props) {
  return (
    <div className="rounded-2xl border border-white/10 bg-slate-900/80 p-5">
      <h3>{title}</h3>
      <button onClick={onAction}>Go</button>
    </div>
  );
}
```

### Co-located Hooks

Extract logic into custom hooks **in the same file**, placed **below** the component export. Only extract into a separate file when the hook is reused by 2+ components.

```tsx
// ── Component ─────────────────────────────────────────────
export function GameSyncPanel({ gameId }: { gameId: string }) {
  const { isSyncing, sync } = useSyncGame(gameId);

  return (
    <button disabled={isSyncing} onClick={sync}>
      {isSyncing ? "Syncing…" : "Sync now"}
    </button>
  );
}

// ── Hook (same file) ──────────────────────────────────────
function useSyncGame(gameId: string) {
  const [isSyncing, setIsSyncing] = useState(false);

  const sync = async () => {
    setIsSyncing(true);
    try {
      await syncGameToCloud(gameId);
    } finally {
      setIsSyncing(false);
    }
  };

  return { isSyncing, sync };
}
```

### Props

- Define a `Props` interface (or `type`) directly above the component.
- Use destructuring in the parameter list.
- Default values via JS defaults, not `defaultProps`.
- Children: use `React.ReactNode` only when genuinely needed — prefer explicit props.

---

## Styling — TailwindCSS 4

### Setup

Global CSS file (`App.css` or `index.css`):

```css
@import "tailwindcss";

/* Base overrides only — no component classes here */
```

Vite plugin in `vite.config.ts`:

```ts
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
});
```

### Patterns

1. **Inline utility classes** for all styling — no CSS modules, no styled-components.
2. **Shared class strings** in `src/components/styles.ts` for commonly reused patterns (cards, buttons, badges):

```ts
export const CARD = "border border-white/10 bg-slate-900/80 rounded-3xl p-5";
export const BTN = "inline-flex items-center justify-center font-semibold transition-colors";
export const PRIMARY_BTN = `${BTN} rounded-2xl bg-gradient-to-br from-indigo-500 to-cyan-400 text-white`;
```

3. **Responsive** — mobile breakpoints with Tailwind `max-[px]:` or `min-[px]:` modifiers.
4. **Dark-first** — the app has a dark background; design all components for dark mode by default.
5. **No `@apply`** — keep styles in JSX. Exception: global base resets in the CSS file.

---

## React Router 7

### Package

Use `react-router` (v7+) — **not** the legacy `react-router-dom` v6 package.

```bash
npm install react-router
```

### Route Config

Define routes in `App.tsx` using `<Routes>` and `<Route>`:

```tsx
import { BrowserRouter, Routes, Route, Navigate } from "react-router";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<AuthGuard />}>
          <Route element={<AppLayout />}>
            <Route index element={<DashboardPage />} />
            <Route path="game/:id" element={<GameDetailPage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
```

### Auth Guard (Layout Route)

The auth guard is a layout route that checks Google OAuth status and redirects:

```tsx
import { Navigate, Outlet } from "react-router";

export function AuthGuard() {
  const { data: authStatus, isLoading } = useAuthStatusQuery();

  if (isLoading) return <LoadingScreen />;
  if (!authStatus?.authenticated) return <Navigate to="/login" replace />;

  return <Outlet />;
}
```

### Navigation

Use `useNavigate()` for programmatic navigation, `<Link>` for declarative links — both from `"react-router"`.

---

## TanStack React Query — Tauri Commands

### Query Client

Desktop-app defaults — no background refetching:

```tsx
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});
```

### Query Keys

Centralise in `src/queries/keys.ts`:

```ts
export const DASHBOARD_KEY = ["dashboard"] as const;
export const AUTH_STATUS_KEY = ["auth-status"] as const;
```

### Query Hooks

One file per domain in `src/queries/`. Each hook wraps `useQuery` or `useMutation`.

**Query pattern:**

```ts
export function useDashboardQuery() {
  return useQuery({
    queryKey: DASHBOARD_KEY,
    queryFn: loadDashboard,
  });
}
```

**Mutation pattern — always update cache with full DashboardData:**

```ts
function useSetDashboardCache() {
  const qc = useQueryClient();
  return (data: DashboardData) =>
    qc.setQueryData<DashboardData>(DASHBOARD_KEY, data);
}

export function useAddGameMutation() {
  const setCache = useSetDashboardCache();
  return useMutation({
    mutationFn: (payload: AddGamePayload) => addManualGame(payload),
    onSuccess: setCache,
  });
}
```

### Service Layer

All `invoke()` calls live in `src/services/tauri.ts` — components never call `invoke` directly:

```ts
import { invoke } from "@tauri-apps/api/core";

export async function loadDashboard(): Promise<DashboardData> {
  return invoke<DashboardData>("load_dashboard");
}
```

---

## TypeScript 5.8+ Conventions

- **Strict mode** enabled (`strict: true` in tsconfig).
- **Interfaces** for object shapes (props, API responses). **Types** for unions/aliases.
- **`satisfies`** operator for type-safe defaults:
  ```ts
  const DEFAULT_FORM = { name: "", source: "manual", savePath: null } satisfies AddGamePayload;
  ```
- **No enums** — use `string` union types:
  ```ts
  type GameSource = "steam" | "epic" | "emulator" | "manual";
  ```
- **No `any`** — use `unknown` and narrow explicitly.
- **Null over undefined** — match the Rust `Option<T>` → `T | null` convention.

---

## Vite 7 Config

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
}));
```

---

## File Organisation

```
src/
  App.tsx               # Router + top-level providers
  App.css               # @import "tailwindcss" + global base styles
  main.tsx              # ReactDOM.createRoot + QueryClientProvider
  types/
    dashboard.ts        # All shared TS interfaces (source of truth)
  services/
    tauri.ts            # All invoke() wrappers — the only file that talks to Rust
  queries/
    keys.ts             # Query key constants
    dashboard.ts        # useQuery / useMutation hooks for game data
    auth.ts             # useQuery / useMutation hooks for OAuth status
    index.ts            # Re-exports
  pages/
    LoginPage.tsx       # Google OAuth sign-in
    DashboardPage.tsx   # Game library overview
    GameDetailPage.tsx  # Single game detail + sync controls
    SettingsPage.tsx    # Global sync settings, account info
  components/
    styles.ts           # Shared Tailwind class-string constants
    AuthGuard.tsx       # Layout route — redirects unauthenticated to /login
    AppLayout.tsx       # Sidebar + <Outlet /> shell
    ...                 # Reusable UI components
  utils/
    index.ts            # Pure helper functions (norm, msg, slugify)
```

### Naming

- **Files**: PascalCase for components/pages (`GameCard.tsx`), camelCase for non-component modules (`tauri.ts`, `keys.ts`).
- **Exports**: Named exports only — no default exports.
- **Interfaces**: PascalCase, no `I` prefix (`Props`, `GameItem`, not `IGameItem`).

---

## Checklist — New Component

1. Create file in `src/components/` (reusable) or `src/pages/` (route-level).
2. Define `Props` interface → pure function component → named export.
3. Use Tailwind classes inline; add shared strings to `styles.ts` if reused 3+ times.
4. Extract complex logic into a hook **below the component in the same file**.
5. If the component calls Rust: add `invoke` wrapper in `services/tauri.ts` → query/mutation hook in `queries/` → use in component.
6. Wire route in `App.tsx` if it's a page.

## Checklist — New Query/Mutation

1. Add Tauri command wrapper in `services/tauri.ts`.
2. Add query key in `queries/keys.ts`.
3. Add hook in the appropriate `queries/*.ts` file.
4. Mutations that modify game data must call `setCache` with the full `DashboardData` on success.

---

## Anti-patterns — Do NOT

- Use `React.FC` or `React.FunctionComponent`.
- Create separate `hooks/` files for single-use hooks — keep them co-located.
- Use CSS modules, styled-components, or `@apply` in Tailwind.
- Call `invoke()` directly from components — always go through `services/tauri.ts`.
- Use `any` type — use `unknown` with type narrowing.
- Use `enum` — use string union types instead.
- Mutate query cache manually outside `onSuccess` — always return full state from backend.
- Use default exports.

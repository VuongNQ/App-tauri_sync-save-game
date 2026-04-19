---
applyTo: "src/**/*.{ts,tsx}"
description: >
  Use when: creating or editing any React component, page, hook, query hook, mutation hook, service function, route, form, layout, or Tailwind style in this Tauri app. Covers the full frontend architecture: component conventions, React Query patterns, service layer, routing, TypeScript, form validation, Tauri event integration, and device management UI (DevicesPage, useDevicesQuery, useRenameDeviceMutation, useRemoveDeviceMutation).
---

# Frontend UI — Structure & Workflow

## Stack

| Tool | Version |
|---|---|
| React | 19 — pure function components only |
| TypeScript | 5.8+ — strict mode, no `any` |
| React Router | 7 (`react-router`, not `react-router-dom`) |
| TanStack React Query | 5 |
| TailwindCSS | 4 — utility classes, no CSS modules |
| Vite | 7 |
| react-hook-form + zod | Forms + schema validation |

---

## File Organisation

```
src/
  App.tsx              # Router, top-level providers, Tauri event listeners
  main.tsx             # ReactDOM.createRoot + QueryClientProvider
  App.css              # @import "tailwindcss" + global base styles only
  types/
    dashboard.ts       # ALL shared TypeScript interfaces (single source of truth)
  services/
    tauri.ts           # All invoke() wrappers — ONLY place that calls invoke
  queries/
    keys.ts            # Query key constants
    auth.ts            # Auth query/mutation hooks
    dashboard.ts       # Game library query/mutation hooks
    detail.ts          # Per-game hooks: useSyncAndLaunchFlow (phase state machine)
    sync.ts            # Sync mutation hooks
    settings.ts        # Settings query/mutation hooks
    devices.ts         # Device management query/mutation hooks
    index.ts           # Re-exports from all query files
  pages/               # Route-level components (one file per route)
    LoginPage.tsx
    DashboardPage.tsx
    GameDetailPage/      # folder: index.tsx + hooks.ts + components/
    SettingsPage.tsx
    DevicesPage.tsx
  components/          # Reusable UI building blocks
    styles.ts          # Shared Tailwind class-string constants
    AppLayout.tsx      # Sidebar + <Outlet /> shell
    AuthGuard.tsx      # Route protection (layout route)
    DriveFilesSection.tsx  # Collapsible Drive file manager (rename, move, delete)
    VersionBackupsSection.tsx  # Collapsible version backup manager (create, restore, delete)
    ...
  utils/
    index.ts           # Pure helpers: norm(), msg(), formatLocalTime()
```

### Naming Rules

- **Files**: PascalCase for components/pages (`GameCard.tsx`), camelCase for modules (`tauri.ts`, `keys.ts`)
- **Exports**: Named exports only — **no default exports**
- **Interfaces**: PascalCase, no `I` prefix (`Props`, `GameEntry`, not `IGameEntry`)
- **Hook files**: Domain-scoped (`auth.ts`, `dashboard.ts`) — not named after the hook itself

---

## Component Conventions

### Pure Function Component

```tsx
interface Props {
  title: string;
  onAction: () => void;
}

export function MyCard({ title, onAction }: Props) {
  return (
    <div className={CARD}>
      <h3 className="text-white font-semibold">{title}</h3>
      <button className={PRIMARY_BTN} onClick={onAction}>Go</button>
    </div>
  );
}
```

**Rules:**
- Never use `React.FC` or `React.FunctionComponent`
- Define `Props` interface directly above the component
- Destructure props in the parameter list
- Use JS defaults — not `defaultProps`
- `children` type is `React.ReactNode` only when genuinely needed

### Co-located Hooks

Extract component logic into a custom hook **in the same file**, placed **below** the component export. Only move to a separate file when a hook is reused by 2+ components.

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

// ── Co-located hook (same file, below export) ─────────────
function useSyncGame(gameId: string) {
  const mutation = useSyncGameMutation();
  return {
    isSyncing: mutation.isPending,
    sync: () => mutation.mutate(gameId),
  };
}
```

---

## Routing

### Route Config (`App.tsx`)

```tsx
import { HashRouter, Routes, Route, Navigate } from "react-router";

<HashRouter>
  <Routes>
    <Route path="/login" element={<LoginPage />} />
    <Route element={<AuthGuard />}>
      <Route element={<AppLayout />}>
        <Route index element={<DashboardPage />} />
        <Route path="game/:id" element={<GameDetailPage />} />
        <Route path="devices" element={<DevicesPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
    </Route>
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes>
</HashRouter>
```

### Auth Guard (Layout Route)

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

- `useNavigate()` for programmatic navigation
- `<Link>` / `<NavLink>` for declarative links
- `useParams()` to read route params (e.g., `game/:id`)
- All from `"react-router"` (not `"react-router-dom"`)

---

## Service Layer (`src/services/tauri.ts`)

**The single source of all Tauri IPC.** Components and hooks **never** call `invoke` directly.

```ts
import { invoke } from "@tauri-apps/api/core";
import type { DashboardData, AddGamePayload, SyncResult } from "../types/dashboard";

// One function per Tauri command, typed with return type
export async function loadDashboard(): Promise<DashboardData> {
  return invoke<DashboardData>("load_dashboard");
}

export async function addManualGame(payload: AddGamePayload): Promise<DashboardData> {
  return invoke<DashboardData>("add_manual_game", { payload });
}

export async function syncGame(gameId: string): Promise<SyncResult> {
  return invoke<SyncResult>("sync_game", { gameId });
}

// Expands stored %VAR% tokens (e.g. %LOCALAPPDATA%) to absolute path on current machine
export async function expandSavePath(path: string): Promise<string> {
  return invoke<string>("expand_save_path", { path });
}

// Tokenises an absolute path back to portable %VAR% form — call after every file-picker selection
export async function contractPath(path: string): Promise<string> {
  return invoke<string>("contract_path", { path });
}

// Launches the game executable (expands %VAR% tokens at runtime)
export async function launchGame(gameId: string): Promise<void> {
  return invoke<void>("launch_game", { gameId });
}
```

**Rules:**
- No error handling inside service functions — let errors bubble to React Query / component
- Argument name must exactly match the Rust `#[tauri::command]` parameter names
- Return type matches the Rust command's `Result<T, String>` success type

---

## React Query Patterns

### QueryClient Config (`main.tsx`)

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

### Query Keys (`src/queries/keys.ts`)

```ts
export const DASHBOARD_KEY = ["dashboard"] as const;
export const AUTH_STATUS_KEY = ["auth-status"] as const;
export const VALIDATE_PATHS_KEY = ["validate-paths"] as const;
export const SETTINGS_KEY = ["settings"] as const;
export const GOOGLE_USER_INFO_KEY = ["google-user-info"] as const;
export const SAVE_INFO_KEY = ["save-info"] as const;
export const DEVICES_KEY = ["devices"] as const;
// Per-game dynamic keys — factory functions:
/** Prefix key — use for invalidating all cached folder queries of a game. */
export const driveFilesKey = (gameId: string) => ["drive-files", gameId] as const;
/** Specific key for a given folder inside a game's Drive folder tree. */
export const driveFilesFolderKey = (gameId: string, folderId: string) => ["drive-files", gameId, folderId] as const;
/** Full recursive flat listing of all files/folders in a game's Drive folder tree. */
export const driveFilesFlatKey = (gameId: string) => ["drive-files-flat", gameId] as const;
export const versionBackupsKey = (gameId: string) => ["version-backups", gameId] as const;
/** Reactive process-playing state for a single game — pushed by "game-status-changed" event from App.tsx. */
export const gamePlayingKey = (gameId: string) => ["game-playing", gameId] as const;
```

### Query Hook Pattern

```ts
export function useDashboardQuery() {
  return useQuery({
    queryKey: DASHBOARD_KEY,
    queryFn: loadDashboard,
  });
}
```

### Mutation Hook Pattern — Full Dashboard State Update

Every mutation that modifies game data returns the **full `DashboardData`** from Rust. Always use `setQueryData` in `onSuccess` — never manually patch cached entries.

```ts
function useSetDashboardCache() {
  const queryClient = useQueryClient();
  return (data: DashboardData) => {
    queryClient.setQueryData<DashboardData>(DASHBOARD_KEY, data);
    // Invalidate dependent queries as side-effects:
    void queryClient.invalidateQueries({ queryKey: VALIDATE_PATHS_KEY });
  };
}

export function useAddGameMutation() {
  const setCache = useSetDashboardCache();
  return useMutation({
    mutationFn: (payload: AddGamePayload) => addManualGame(payload),
    onSuccess: setCache,
  });
}
```

### VALIDATE_PATHS_KEY Invalidation Rule

Invalidate `VALIDATE_PATHS_KEY` in `onSuccess` whenever a mutation **writes files to disk** on the local machine. This clears the "save path does not exist" warning in `GameDetailPage` automatically.

**Mutations that must invalidate `VALIDATE_PATHS_KEY`:**
- `useRestoreFromCloudMutation` — downloads Drive files to local save path
- `useRestoreVersionBackupMutation` — downloads backup files to local save path

```ts
export function useRestoreVersionBackupMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ...,
    onSuccess: (_data, { gameId }) => {
      queryClient.invalidateQueries({ queryKey: DASHBOARD_KEY });
      queryClient.invalidateQueries({ queryKey: driveFilesKey(gameId) });
      queryClient.invalidateQueries({ queryKey: VALIDATE_PATHS_KEY }); // ← required
    },
  });
}
```

### Exe Path Validation Surfacing

`validate_save_paths` returns `PathValidation[]` where each entry includes:

```ts
export interface PathValidation {
  gameId: string;
  valid: boolean;               // save folder exists on this machine
  exePathValid: boolean | null; // null=exe_path not set, true=file found, false=file missing
}
```

Three places consume `ValidatePathsQuery` data to surface exe validation:

1. **`Header.tsx`** (GameDetailPage) — `canLaunch = !!game.exePath && exePathValid !== false`. Shows two distinct hints: "Set an exe path in Settings" / "⚠ Exe not found on this device".
2. **`GameSettingsForm`** — `exePathValid` prop passed to `GameExecutableSection`; shows a red warning banner when `false`.
3. **`DashboardPage` → `GamesList`** — `missingExeIds = new Set(validateQuery.data?.filter(v => v.exePathValid === false).map(v => v.gameId))` passed as a prop. `GamePlayButton` is disabled with red styling when `exeMissing === true`.

```tsx
// DashboardPage.tsx pattern
const missingExeIds = new Set(
  (validateQuery.data ?? []).filter(v => v.exePathValid === false).map(v => v.gameId)
);
<GamesList games={games} missingExeIds={missingExeIds} />

// GamesList.tsx pattern
const isExeMissing = missingExeIds?.has(g.id) ?? false;
```

### GameExecutableSection (GameSettingsForm)

`ExeNameSection` and `ExePathSection` have been merged into a single `GameExecutableSection` component inside `GameSettingsForm.tsx`.

- One Browse button fills `exePath` (via `contractPath()` after the file-picker) and **auto-fills `exeName`** from the basename.
- `useWatch({ name: "exeName" })` drives a dynamic hint: "Watcher will track: **X**".
- Accepts `exePathValid: boolean | null` prop; renders a red warning banner when `false`.
- Help text for `exePath` notes: **"Saved locally only"** — not synced to cloud, since paths differ between devices.

### Hook Naming

| Pattern | Example |
|---|---|
| Read: `use{Feature}Query` | `useDashboardQuery`, `useSettingsQuery` |
| Write: `use{Feature}Mutation` | `useAddGameMutation`, `useSyncGameMutation`, `useGetSaveInfoMutation` |
| Multi-step flow: `use{Feature}Flow` | `useSyncAndLaunchFlow` — chained mutations with a phase state machine |

### Multi-Step Flow Hook Pattern

When an action requires two sequential async steps (e.g. restore-then-launch), model it as a **phase state machine** hook kept in `detail.ts`, not as nested callbacks:

```ts
type LaunchPhase = "idle" | "syncing" | "launching";

export function useSyncAndLaunchFlow({ onError }: { onError?: (msg: string, canForce: boolean) => void } = {}) {
  const [phase, setPhase] = useState<LaunchPhase>("idle");

  const launchMutation = useMutation({
    mutationFn: (gameId: string) => launchGame(gameId),
    onSuccess: () => setPhase("idle"),
    onError: (err) => { setPhase("idle"); onError?.(String(err), false); },
  });

  const restoreMutation = useMutation({
    mutationFn: (gameId: string) => restoreFromCloud(gameId),
    onSuccess: (_data, gameId) => { setPhase("launching"); launchMutation.mutate(gameId); },
    onError: (err) => { setPhase("idle"); onError?.(String(err), true /* canForce */); },
  });

  function start(game: GameEntry) {
    // Skip restore when no Drive folder exists yet (nothing to pull down)
    if (!game.gdriveFolderId) { setPhase("launching"); launchMutation.mutate(game.id); return; }
    setPhase("syncing");
    restoreMutation.mutate(game.id);
  }

  function forceLaunch(gameId: string) { setPhase("launching"); launchMutation.mutate(gameId); }

  return { start, forceLaunch, phase, isPending: phase !== "idle" };
}
```

**Rules for flow hooks:**
- `canForce: true` is passed to `onError` only when the **sync** step fails (not launch) so the UI can offer a "Launch anyway" escape button.
- Keep `start()` guard logic (`gdriveFolderId == null`) inside the hook — callers just call `start(game)`.

---

## TypeScript Conventions

### Source of Truth: `src/types/dashboard.ts`

All interfaces live here. **Never duplicate type definitions** across files.

```ts
export interface SavePathEntry {
  label: string;             // user-defined label, e.g. "Memcard", "Save States"
  path: string | null;       // portable %VAR% path, or null if device-specific
  gdriveFolderId: string | null; // Drive folder for this path; index 0 = game root, i≥1 = path-{i}/ subfolder
  syncExcludes: string[];    // relative paths excluded from Drive sync for this specific path
}

export interface PathSaveInfo {
  label: string;      // matches SavePathEntry.label
  savePath: string;   // effective path for this index (unexpanded token form)
  totalSize: number;
  files: SaveFileInfo[];
}

export interface GameEntry {
  id: string;
  name: string;
  description: string | null;       // null, not undefined (Rust Option<T>)
  thumbnail: string | null;         // local file path or remote URL for logo
  source: GameSource;               // "manual" | "emulator"
  pathMode: "auto" | "per_device";  // "auto" = portable %VAR% paths shared across devices;
                                    // "per_device" = paths stored locally per machine (override key includes device UUID)
  savePaths: SavePathEntry[];       // ordered list; index 0 is primary. Replaces old savePath + syncExcludes.
  exeName: string | null;           // game executable filename (e.g. "MyGame.exe"); used by process monitor
  exePath: string | null;           // full exe path with %VAR% tokens (e.g. "%PROGRAMFILES%\\Steam\\game.exe"); used by launch_game
                                    // LOCAL-ONLY — stripped before any Firestore / Drive upload; never synced to cloud
  trackChanges: boolean;
  autoSync: boolean;
  lastLocalModified: string | null; // ISO 8601 (max across all paths)
  lastCloudModified: string | null;
  gdriveFolderId: string | null;
  cloudStorageBytes: number | null; // total bytes synced to Drive across ALL paths; null = never synced
}

export interface AppSettings {
  syncIntervalMinutes: number;
  startMinimised: boolean;
  runOnStartup: boolean;
  /**
   * Device-specific save-path overrides. Local-only — never written to Firestore.
   * Key format depends on GameEntry.pathMode:
   *   "auto"       game, index 0   → key = "{gameId}"
   *   "per_device" game, index 0   → key = "{gameId}:{deviceId}"
   */
  pathOverrides: Record<string, string>;
  /**
   * Device-specific save-path overrides for save_paths[i≥1]. Local-only — never written to Firestore.
   * Key format depends on GameEntry.pathMode:
   *   "auto"       game, index i   → key = "{gameId}:{i}"
   *   "per_device" game, index i   → key = "{gameId}:{deviceId}:{i}"
   */
  pathOverridesIndexed: Record<string, string>;
}

export interface DashboardData {
  games: GameEntry[];
  settings: AppSettings;
}

export type GameSource = "manual" | "emulator"; // string union, never enum

export interface DeviceInfo {
  id: string;
  name: string;              // user-editable display name (initially hostname)
  hostname: string;
  osName: string;
  osVersion: string;
  cpuName: string;
  cpuCores: number;
  totalRamMb: number;
  registeredAt: string;      // ISO 8601
  lastSeenAt: string;        // ISO 8601
  isCurrent?: boolean;       // computed locally — true on the current machine; never stored in Firestore
}
```

**camelCase ↔ snake_case mapping:** Rust uses `snake_case`, TypeScript uses `camelCase`. The Rust structs have `#[serde(rename_all = "camelCase")]` so serialisation is automatic. Always define TS types in camelCase.

### TypeScript Rules

- `strict: true` — always
- `null` over `undefined` — matches Rust `Option<T>` → `T | null`
- **No `any`** — use `unknown` and narrow with type guards
- **No `enum`** — use string union types
- `satisfies` for type-safe defaults:
  ```ts
  const DEFAULT_FORM = { name: "", source: "manual" as GameSource, savePath: null } satisfies AddGamePayload;
  ```
- Interfaces for object shapes; types for unions/aliases

---

## Form Handling

Use `react-hook-form` + `zod` for all forms. The Zod schema must match the TypeScript payload type.

```tsx
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

const schema = z.object({
  name: z.string().min(1, "Game name is required."),
  description: z.string().max(1000).nullable(),
  source: z.enum(["manual", "emulator"]),
}) satisfies z.ZodType<AddGamePayload>;

type FormValues = z.infer<typeof schema>;

export function AddGameForm({ onSuccess }: { onSuccess: () => void }) {
  const mutation = useAddGameMutation();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    defaultValues: { name: "", description: null, source: "manual" },
    resolver: zodResolver(schema),
  });

  const onSubmit = handleSubmit(async (data) => {
    await mutation.mutateAsync(data);
    onSuccess();
  });

  return (
    <form onSubmit={onSubmit}>
      <input {...register("name")} className={INPUT_CLS} placeholder="Game name" />
      {errors.name && <span className="text-red-400 text-xs">{errors.name.message}</span>}
      <button type="submit" className={PRIMARY_BTN} disabled={isSubmitting}>
        {isSubmitting ? "Saving…" : "Add Game"}
      </button>
    </form>
  );
}
```

---

## Styling — TailwindCSS 4

### Setup

```css
/* App.css */
@import "tailwindcss";
/* Base resets only — no component classes */
```

### Shared Class Constants (`src/components/styles.ts`)

All reused Tailwind class strings are exported as constants. Import and combine as needed.

```ts
export const CARD = "border border-white/10 bg-[rgba(14,22,40,0.82)] rounded-3xl p-5 backdrop-blur-sm";
export const PRIMARY_BTN = "inline-flex items-center justify-center font-semibold rounded-2xl bg-gradient-to-br from-[#6d7dff] to-[#55c5ff] text-white transition-colors";
export const SECONDARY_BTN = "inline-flex items-center justify-center font-semibold rounded-2xl bg-[rgba(86,133,255,0.16)] text-[#8ca5f1] hover:bg-[rgba(86,133,255,0.26)] transition-colors";
export const DANGER_BTN = "inline-flex items-center justify-center font-semibold rounded-2xl bg-[rgba(255,60,60,0.16)] text-[#ff6b6b] hover:bg-[rgba(255,60,60,0.28)] transition-colors";
export const INPUT_CLS = "w-full min-h-[46px] rounded-xl bg-[rgba(86,133,255,0.08)] border border-white/10 px-4 text-white placeholder-[#9aa8c7] focus:outline-none focus:ring-2 focus:ring-[#6d7dff]";
export const MUTED = "text-[#9aa8c7] text-sm";
export const TOGGLE_TRACK_ON = "bg-[#6d7dff]";
export const TOGGLE_TRACK_OFF = "bg-[rgba(140,165,241,0.2)]";
```

### Style Rules

1. **Inline utility classes** for all styling — no CSS modules, no styled-components, no `@apply`
2. Add class strings to `styles.ts` when a pattern is repeated in 3+ places
3. **Dark-first** — app has a dark background; all components designed for dark mode
4. Responsive with `max-[900px]:`, `max-[720px]:` breakpoints

---

## Tauri Event Listeners

Listen to Rust-emitted events in `App.tsx` — not inside individual components.

```tsx
import { listen } from "@tauri-apps/api/event";

function useAuthStatusCallbacks() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const unlistenPromise = listen<AuthStatus>("auth-status-changed", ({ payload }) => {
      queryClient.setQueryData<AuthStatus>(AUTH_STATUS_KEY, payload);
    });
    // After first-login cloud restore, refresh the game library.
    const unlistenRestorePromise = listen("library-restored", () => {
      void queryClient.invalidateQueries({ queryKey: DASHBOARD_KEY });
    });
    // Re-validate auth status when the window regains focus.
    const syncAuthStatus = () => { void queryClient.invalidateQueries({ queryKey: AUTH_STATUS_KEY }); };
    const handleVisibilityChange = () => { if (document.visibilityState === "visible") syncAuthStatus(); };
    window.addEventListener("focus", syncAuthStatus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("focus", syncAuthStatus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      void unlistenPromise.then(fn => fn());
      void unlistenRestorePromise.then(fn => fn());
    };
  }, [queryClient]);
}
```

**Events emitted by Rust:**

| Event | Payload | Cache action |
|---|---|---|
| `auth-status-changed` | `AuthStatus` | `setQueryData(AUTH_STATUS_KEY, payload)` |
| `library-restored` | — | `invalidateQueries(DASHBOARD_KEY)` — fires after first-login cloud restore |
| `post-login-sync-completed` | — | `invalidateQueries(DASHBOARD_KEY)` — fires after post-login sync-all-from-Drive |
| `sync-completed` | `SyncResult` | `invalidateQueries(DASHBOARD_KEY)` |
| `sync-error` | `{ gameId, error }` | display error toast |
| `game-sync-pending` | `{ gameId }` | show pending indicator |
| `game-status-changed` | `{ gameId, status: "playing" \| "idle" }` | `setQueryData(gamePlayingKey(gameId), status === "playing")` |

---

## Utility Functions (`src/utils/index.ts`)

| Function | Signature | Purpose |
|---|---|---|
| `norm` | `(v: string) => string \| null` | Trim string; return `null` if empty |
| `msg` | `(e: unknown, fallback?: string) => string` | Extract error message from unknown |
| `formatLocalTime` | `(iso: string \| null) => string` | Format ISO 8601 → locale date/time |

Use `norm()` when converting form string inputs to `string | null` for payloads.
Use `msg()` in `catch` blocks and mutation `onError` callbacks.

---

### Save Path Portability

Save paths in each `SavePathEntry.path` may contain Windows env-var tokens (`%LOCALAPPDATA%`, `%APPDATA%`, `%USERPROFILE%`, `%PROGRAMDATA%`, `%TEMP%`). These are stored intentionally — do **not** strip them.

- **Display**: show the token string as-is (or blank/"Not set" when `path` is `null` for device-specific paths).
- **Primary path**: `game.savePaths[0]?.path ?? null`.
- **Folder-picker `defaultPath`** (`SavePathCard.handleBrowse()`): call `expandSavePath(entry.path)` first if the value contains `%`, then extract the parent directory. Device-specific paths (no `%`) are used directly.
- Never pass a token path directly to any filesystem API on the frontend; always expand first.

### GameSettingsForm — Save Paths

`GameSettingsForm` renders a `SavePathsSection` component that manages the ordered list of `SavePathEntry` records:

- **`SavePathsSection`**: outer card with "+ Add save path" button; renders one `SavePathCard` per entry.
- **`SavePathCard`**: label input, folder-path browse button (uses `expandSavePath` for `%` paths before showing the folder-picker), and an embedded `SavePathExclusionsSection`.
- **`SavePathExclusionsSection`**: per-path exclusion list. The "Load files" button calls `getSaveInfo` and uses `pathInfos[index]` from the response to build a single-path `SaveInfo` object for the `SaveFileTree`. This is critical — **do not pass the full aggregate `SaveInfo`** or all paths' files will show for every path's exclusion tree.
- When a `SavePathEntry.path` is `null` (device-specific path not configured on this machine), `SavePathCard` shows a blue info banner prompting the user to Browse.

Form defaults:
```ts
savePaths: (gameSettings?.savePaths ?? []).map((e) => ({
  ...e,
  path: e.path ?? "",
  gdriveFolderId: e.gdriveFolderId ?? null,
}))
```

`onSaveSettings` maps the array back with `norm(entry.path)` per entry.

### SaveInfoPanel — Multi-Path Display

`SaveInfoPanel` in `SupportUI.tsx` accepts an optional `onOpenFolderForPath?: (rawPath: string) => void` prop:

- **Multi-path** (`info.pathInfos.length > 1`): renders one labelled `PathInfoSection` card per path. Each section shows: label, path (unexpanded), size badge, per-path open-folder button, and `SaveFileTree`. The global open-folder button is hidden.
- **Single-path** (`pathInfos.length <= 1`): unchanged single-path behavior with the global open-folder button.

```tsx
// Status.tsx — how to wire onOpenFolderForPath
<SaveInfoPanel
  info={saveInfo}
  onOpenFolderForPath={(rawPath) => {
    void expandSavePath(rawPath).then((p) => openPath(p));
  }}
/>
```

---

## Drive File Manager Components

### DriveFilesSection

**File**: `src/components/DriveFilesSection.tsx`  
**Props**: `{ gameId: string; gameFolderId: string; savePaths?: SavePathEntry[]; pathMode?: "auto" | "per_device" }`  
**Used in**: `GameDetailPage` — only rendered when `game.gdriveFolderId !== null`.

- Collapsible section; `useDriveFilesFlatQuery(gameId, isOpen)` — **single recursive fetch** when the section is first opened. Key: `driveFilesFlatKey(gameId)`. `staleTime: Infinity`.
- `buildDriveTree(items: DriveFileFlatItem[]): DriveTreeItem[]` — client-side tree builder that splits each `relativePath` on `/` to produce a typed union:
  - `DriveTreeLeaf { kind: "file", id, name, relativePath, size, modifiedTime, parentFolderId }`
  - `DriveTreeDir { kind: "folder", id | null, name, relativePath, children, totalSize, parentFolderId | null }`
- **Multi-path rendering**: tree is split into `otherRoots` (root files + non-path-N folders) and `pathNRoots` (folders matching `PATH_N_RE = /^path-(\d+)$/`).
  - `otherRoots` are rendered after a `SavePathSectionLabel` for `savePaths[0]`.
  - `pathNRoots` each get a `SavePathSectionLabel` header (label, per-device badge, path) rendered **above** them. The `path-N/` folder row itself is **not rendered** — only the folder's children are rendered flat at `depth=0`. If a path-N folder has no children yet, a `"No files synced yet for this path."` placeholder is shown.
  - `SavePathSectionLabel` shows the save path's `label` (blue pill), a `per-device` badge when `pathMode === "per_device"`, and the local path (or italic "Not configured on this device" when `path` is null).
- `PATH_N_RE = /^path-(\d+)$/` — used to identify path-N folders, extract index `i` to lookup `savePaths[i]`, and mark them as protected.
- **Protected items** (`.sync-meta.json`, `backups`, items under `backups/`, nested `*.sync-meta.json`, and `path-N` folder nodes themselves): displayed but actions (rename/move/delete) are disabled; show a `"protected"` badge. Check via `isProtected(relativePath)`.
- **Rename**: pencil button ✏️ → inline input replaces name text; `Enter` commits, `Escape` cancels.
- **Move**: folder icon button 📂 → `MoveFileModal` with radio list of **top-level subfolders** (items where `isFolder && !relativePath.includes("/")` and not protected); includes "game root" option. Receives `DriveFileFlatItem[]`.
- **Delete**: trash icon 🗑️ → `ConfirmModal` before calling `useDeleteDriveFileMutation`.
- Compact list rows inside a single `<ul>` with `border-b` separators: folder rows show `▼/►` toggle + blue `name/` + size badge; file rows show `↳` + name + size + formatted date.
- Move warning: files moved out of game root are removed from `.sync-meta.json` and will be re-uploaded on next sync.

### VersionBackupsSection

**File**: `src/components/VersionBackupsSection.tsx`  
**Props**: `{ gameId: string }`  
**Used in**: `GameDetailPage` — only rendered when `game.gdriveFolderId !== null`.

- Collapsible section; `useVersionBackupsQuery(gameId, isOpen)` — lazy fetch.
- **Create backup**: "+ Create backup" button → inline form with optional label input → `useCreateVersionBackupMutation`.
- Backup rows show: ISO 8601 timestamp, optional label, file count, total size.
- **Restore**: `ConfirmModal` with strong warning (overwrites both Drive and local saves) → `useRestoreVersionBackupMutation`.
- **Delete**: `ConfirmModal` → `useDeleteVersionBackupMutation`.
- Backup `name` field: `"{ISO-ts}"` or `"{ISO-ts} — {label}"` (em dash separator). Extract label as `name.includes(' — ') ? name.slice(name.indexOf(' — ') + 4) : null`.

### GameDetailPage Integration

Both sections are placed **between** the Sync actions card and the Danger Zone card:

```tsx
{game.gdriveFolderId && (
  <DriveFilesSection gameId={game.id} gameFolderId={game.gdriveFolderId} />
)}
{game.gdriveFolderId && (
  <VersionBackupsSection gameId={game.id} />
)}
{/* Danger zone */}
<div className={CARD}> ...
```

### Local Save Info (`SaveTreeNode`)

`SaveTreeNode` is a co-located component inside `GameDetailPage.tsx`. File-leaf nodes detect nested files by checking whether `node.relativePath` contains `/` or `\\`. When nested:

```tsx
const hasSubdir = node.relativePath.includes("/") || node.relativePath.includes("\\\\");
// ...
<span className="text-[#c7d3f7] truncate block">{node.name}</span>
{hasSubdir && (
  <span className="text-[0.65rem] text-[#9aa8c7]/60 truncate block" title={node.relativePath}>
    {node.relativePath.replace(/\\\\/g, "/")}
  </span>
)}
```

This shows the portable relative path (forward-slash normalised) as small muted secondary text below the filename so users can identify which subdirectory a save file belongs to.
```

---

## Checklists

### New Component

1. Place in `src/components/` (reusable) or `src/pages/` (route-level)
2. `Props` interface → pure function → **named export**
3. Import shared class constants from `styles.ts`; add new constants if reused 3+ times
4. Co-locate any hooks below the component export in the same file
5. If it calls Rust: add `invoke` wrapper in `services/tauri.ts` → query/mutation hook in `queries/` → use hook in component

### New Query / Mutation

1. Add Tauri command wrapper in `src/services/tauri.ts`
2. Add query key constant in `src/queries/keys.ts`
3. Add hook in the appropriate `src/queries/*.ts` file
4. Mutations that change game data: call `setCache(data)` with full `DashboardData` in `onSuccess`
5. Re-export from `src/queries/index.ts`

### New Page (Route)

1. Create file in `src/pages/`
2. Wire route in `App.tsx` inside the appropriate guard layer
3. Use `useParams()` for route params if needed
4. Compose from reusable `components/` — keep data-fetching logic in hooks, not JSX

### New Form

1. Define Zod schema above the component
2. Use `satisfies z.ZodType<Payload>` to enforce TS alignment
3. Use `react-hook-form` with `zodResolver`
4. Display field errors via `formState.errors`
5. Call mutation via `mutateAsync` inside `handleSubmit`

---

## Anti-patterns — Never Do

| Anti-pattern | Correct approach |
|---|---|
| `React.FC` / `React.FunctionComponent` | Plain `function MyComp(props: Props)` |
| Default export from a component file | Named export only |
| Call `invoke()` inside a component | Use `services/tauri.ts` wrapper → query hook |
| Use `any` type | Use `unknown` + type narrowing |
| Use `enum` | Use string union: `"manual" \| "emulator"` |
| Use `undefined` for optional fields | Use `null` (matches Rust `Option<T>`) |
| Manually patch a game's props in cache | Return full `DashboardData` from Rust and call `setQueryData` |
| Separate hook file for single-use hook | Co-locate below the component in the same file |
| `@apply` in CSS | Inline Tailwind utilities in JSX |
| Duplicate type definitions | All types in `src/types/dashboard.ts` |
| Listen to Tauri events inside page components | Central listener in `App.tsx` only |

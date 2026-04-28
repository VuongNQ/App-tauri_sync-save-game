---
description: "Instruction logic sync to drive and sync from drive to local on app from BE (Rust, Tauri) and FE (React). Use when: implementing sync to Drive, implementing sync from Drive to local, adding sync Tauri commands, tracing the full upload/download pipeline, modifying sync.rs, modifying gdrive.rs, adding sync React Query hooks, building sync UI components, handling sync conflicts, forced-direction sync (restore from cloud / push to cloud), debugging sync errors."
name: "Sync Local ↔ Drive Logic"
argument-hint: "Describe what sync behaviour you want to add, fix, or understand (e.g. 'upload on game exit', 'restore newest save from Drive', 'force push all paths to Drive')"
agent: "agent"
---

# Sync Local ↔ Drive Logic (Tauri 2 + React)

Implement or explain sync logic for this app following the exact conventions below.
Reference the instruction file [sync-service.instructions.md](../instructions/sync-service.instructions.md) for complete rules.

## Architecture at a Glance

```
Frontend (React)                        Backend (Rust / Tauri)
────────────────                        ───────────────────────
useSyncGameMutation()
  → syncGame(gameId)               →   sync_game
                                          effective_save_paths()     ← resolve local paths
                                          ensure_game_folder()       ← ensure Drive root folder
                                          for each path[i]:
                                            ensure_subfolder("path-{i}")  ← i≥1 only
                                            fetch_sync_meta()        ← Drive .sync-meta.json
                                            compare timestamps       ← local vs cloud mtime
                                            upload OR download
                                            update_sync_meta()       ← write back meta
                                          save_state()               ← persist timestamps
                                          emit "sync-completed"      → SyncResult payload

useSyncAllGamesMutation()
  → syncAllGames()                 →   sync_all_games  (loops sync_game per game)

useRestoreFromCloudMutation()
  → restoreFromCloud(gameId)       →   restore_from_cloud  (forced Drive → local)

usePushToCloudMutation()
  → pushToCloud(gameId)            →   push_to_cloud  (forced local → Drive)
```

## Key Files

| Layer | File | Role |
|---|---|---|
| Rust | `src-tauri/src/sync.rs` | Per-game sync algorithm |
| Rust | `src-tauri/src/gdrive.rs` | Drive REST API (upload, download, folder ops) |
| Rust | `src-tauri/src/watcher.rs` | Process monitor — triggers sync on game exit |
| Rust | `src-tauri/src/settings.rs` | `effective_save_paths()`, `apply_path_overrides()`, `save_state()` |
| Rust | `src-tauri/src/lib.rs` | Tauri command wiring + `apply_path_overrides` before every return |
| TS | `src/services/tauri.ts` | `invoke<T>()` wrappers — only place IPC is called |
| TS | `src/queries/sync.ts` | React Query mutation hooks |
| TS | `src/types/dashboard.ts` | `SyncResult`, `GameEntry`, `DashboardData` types |

## Sync Algorithm (per game, per path)

1. `effective_save_paths(game, settings)` → `Vec<Option<String>>` (one entry per `save_paths` element; device override wins).
2. For each index `i` with a non-null path:
   - `i == 0` → use `GameEntry.gdrive_folder_id` (cache it on first run via `ensure_game_folder`).
   - `i >= 1` → `gdrive::ensure_subfolder(app, root_folder_id, "path-{i}")` → cache in `save_paths[i].gdrive_folder_id`.
3. Fetch `.sync-meta.json` from that path's Drive folder.
4. **Storage quota check** (pre-upload): projected bytes + bytes from other games ≤ 200 MB.
5. **Compare** `local_mtime` vs `cloud_mtime`:
   - Local newer → upload local files to Drive.
   - Cloud newer → download Drive files to local.
   - Equal → no-op.
6. After sync: write `.sync-meta.json` back to Drive, update `GameEntry.last_local_modified` / `last_cloud_modified` / `cloud_storage_bytes` in local state, call `save_state()`.

## Sync Direction Variants

| Command | Direction | When to use |
|---|---|---|
| `sync_game` | Bidirectional (newest wins) | Normal background / manual sync |
| `push_to_cloud` | Local → Drive (forced) | User wants to overwrite cloud with local |
| `restore_from_cloud` | Drive → Local (forced) | User wants to overwrite local with cloud |
| `sync_all_games` | Bidirectional for all games | Periodic / "Sync All Now" tray action |

## Key Constraints

- **`apply_path_overrides` before every return**: Every `lib.rs` command must call `settings::apply_path_overrides(&mut state.games, &state.settings)` before building `DashboardData`. Forgetting this causes `null` paths in the UI.
- **`effective_save_paths` everywhere**: Never read `save_paths[i].path` directly at runtime — always call `effective_save_paths(game, settings)` to get the active path.
- **`ureq` is blocking**: Never call Drive API on the main thread without `tokio::task::spawn_blocking`. Watcher and background threads are fine.
- **401 retry once**: Wrap every Drive API call; on HTTP 401 force `gdrive_auth::get_access_token()` refresh and retry once.
- **Drive return type**: `Result<DashboardData, String>` for all Tauri sync commands; include the updated game entry in the returned state.
- **`sync_excludes`**: Before uploading, filter out any file whose relative path matches `SavePathEntry.sync_excludes` entries (trailing `/` = folder prefix).

## Tauri Events Emitted by Sync

| Event | Payload | Emitted by |
|---|---|---|
| `"sync-started"` | `{ gameId }` | `sync.rs` before sync begins |
| `"sync-completed"` | `SyncResult` | `sync.rs` after successful sync |
| `"sync-error"` | `{ gameId, error }` | `sync.rs` on sync failure |
| `"game-sync-pending"` | `{ gameId }` | `watcher.rs` when game exits but auto-sync is off |
| `"game-status-changed"` | `{ gameId, status: "playing" \| "idle" }` | `watcher.rs` on game process start/exit |

## Frontend Patterns

### Mutation hook skeleton (`src/queries/sync.ts`)
```ts
export function useSyncGameMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (gameId: string) => syncGame(gameId),   // invoke wrapper in tauri.ts
    onSuccess: (data) => applyDashboard(qc, data),       // apply full DashboardData
  });
}
```

### Listen to sync events
```ts
import { listen } from "@tauri-apps/api/event";
useEffect(() => {
  const unlisten = listen<SyncResult>("sync-completed", ({ payload }) => {
    // update UI from payload
  });
  return () => { unlisten.then(f => f()); };
}, []);
```

### `tauri.ts` invoke wrapper
```ts
export async function syncGame(gameId: string): Promise<DashboardData> {
  return invoke<DashboardData>("sync_game", { gameId });
}
```

## Common Pitfalls

- **Do not use `save_paths[i].path` directly**: use `effective_save_paths()` — override map may hold the real path.
- **Cache `gdrive_folder_id`** after `ensure_game_folder` / `ensure_subfolder` — never search Drive by name on every sync.
- **`cloud_storage_bytes` = sum across all paths** — recalculate after every upload.
- **`.sync-meta.json` is per-path**, not per-game root — each sub-path folder has its own file.
- **`sync_excludes` trailing `/`** means folder prefix; plain string means exact relative path match.
- **Forced-direction syncs** (`push_to_cloud` / `restore_from_cloud`) skip the timestamp comparison step.

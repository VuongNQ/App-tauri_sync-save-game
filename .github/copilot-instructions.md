# Copilot Instructions — Save Game Dashboard (Tauri 2 + React 19 + Rust)

## Architecture Overview

This is a **Windows desktop app** built with Tauri 2. The Rust backend detects installed games from Steam, Epic Games, and GOG Galaxy by reading launcher manifests and the Windows registry. The React frontend displays a dashboard where users map save-game folders to each detected game. Persistence is a JSON file in the OS app-data directory.

```
src/                        # React + TypeScript frontend
  types/dashboard.ts        # Shared TypeScript interfaces (source of truth for shape)
  services/tauri.ts         # All invoke() calls — only place that talks to Rust
  App.tsx / App.css         # Single-page dashboard (sidebar + game list + detail panel)
src-tauri/src/
  models.rs                 # Rust data types (mirrors types/dashboard.ts)
  detection.rs              # Steam / Epic / GOG detection + merge with stored state
  settings.rs               # JSON persistence (load_state / save_state / add/upsert)
  lib.rs                    # Tauri commands wired to handler functions
```

## Critical Data-Flow Pattern

Every Tauri command returns the **full `DashboardData`** — games are never mutated in the frontend state. The pattern is:

```
Rust command → Result<DashboardData, String> → invoke<DashboardData>() → applyDashboard()
```

`detection::load_dashboard()` is the single merge point: it runs all three launchers, then overlays saved `save_path` / `install_path` values from `games-library.json`. Call order in `lib.rs`:
1. `settings::load_state` → get persisted overrides
2. Detected games keyed by `id` in a `HashMap`
3. Stored records layered on top → new `is_available` logic for manual games

## Serialisation Convention

**All Rust structs use `#[serde(rename_all = "camelCase")]`**, so `install_path` in Rust maps to `installPath` in TypeScript. Never diverge from this — TypeScript types in `src/types/dashboard.ts` are the canonical field names.

## Windows-Only Code Guards

All registry and filesystem detection is gated:
```rust
#[cfg(target_os = "windows")]
fn detect_dashboard() -> DashboardData { ... }

#[cfg(not(target_os = "windows"))]
fn detect_dashboard() -> DashboardData { DashboardData::default() }
```

`winreg` is a Windows-only dependency in `Cargo.toml`:
```toml
[target.'cfg(windows)'.dependencies]
winreg = "0.55"
```

Import `HKEY` from `winreg::HKEY` (not `winreg::enums::HKEY` — that path does not exist in 0.55).

## Game ID Scheme

- Auto-detected games: `steam-{app_id}`, `epic-{catalog_item_id}`, `gog-{product_id}`
- Manually added games: `manual-{slugified_name}` with numeric suffix for collisions (handled by `ensure_unique_id` in `settings.rs`)
- IDs are stable keys — the merge in `detection.rs` relies on them matching across runs.

## Persistence

`settings.rs` persists **only manually-added games and save_path overrides** to:
`{AppData}/game-processing-sync/games-library.json`

The file is read via `app.path().app_data_dir()` (Tauri `Manager` trait). Always call `load_state` → mutate → `save_state` — never write the file directly.

## Developer Workflows

**Dev mode** (requires Rust toolchain on PATH):
```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
npm run tauri -- dev        # starts Vite + Tauri hot-reload
```

**Frontend-only check** (no Rust needed):
```powershell
npm run build               # tsc + vite build — catches all TS/CSS errors
```

**Release installer** (produces `.msi` + NSIS `.exe` under `src-tauri/target/release/bundle/`):
```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
npm run tauri -- build
```

> cargo is installed via rustup at `%USERPROFILE%\.cargo\bin`. If a new terminal doesn't find `cargo`, prepend that directory as shown above.

## Adding a New Tauri Command

1. Add the handler function signature in `lib.rs` using `AppHandle` as first argument.
2. Return `Result<DashboardData, String>` — all commands follow this shape.
3. Add it to `tauri::generate_handler![...]` in `lib.rs`.
4. Add a typed wrapper in `src/services/tauri.ts` using `invoke<DashboardData>()`.

## Key Tauri Plugins

- `tauri-plugin-dialog` — folder/file picker (`open()` from `@tauri-apps/plugin-dialog`)
- `tauri-plugin-opener` — opens files/URLs in system default apps
- Both must be registered in `lib.rs` via `.plugin(tauri_plugin_dialog::init())` **and** listed under `capabilities/default.json` (`"dialog:default"`, `"opener:default"`).

---
name: tauri2-config-debug-test
description: "Use when: configuring Tauri 2, adding Tauri plugins, registering capabilities, fixing CSP, managing Cargo.toml dependencies, debugging Rust backend commands, debugging Tauri IPC, writing tests, running build checks, diagnosing compile errors, securing OAuth secrets, hardening permissions. Covers tauri.conf.json, Cargo.toml, capabilities/default.json, plugin registration in lib.rs, option_env! secrets, println!/eprintln! log prefixes, Tauri DevTools, frontend build validation, Rust flycheck."
argument-hint: "Describe what you want to configure, debug, or test (e.g. 'add plugin-shell', 'fix CSP for new API domain', 'debug invoke error')"
---

# Tauri 2 — Config, Plugin, Security, Debug & Test

## When to Use

- Adding or upgrading a Tauri plugin (rust + JS side)
- Editing `tauri.conf.json` (window, bundle, updater, security)
- Adding capability permissions in `capabilities/default.json`
- Compiling secrets into the binary via `option_env!()`
- Diagnosing `invoke` errors, IPC panics, or command not found
- Debugging background threads or sync commands
- Running the frontend type-check / build validation
- Checking Rust compile errors before a full dev run

---

## 1 · Config (`tauri.conf.json`)

### Key sections and where they live

```jsonc
{
  "productName": "SyncSaveGame",        // shown in installer + window title bar
  "version": "0.1.23",                  // MUST match Cargo.toml [package].version
  "identifier": "com.vendor.AppName",   // reverse-DNS, stable — changing it breaks updater

  "app": {
    "windows": [{ "label": "main", "width": 1360, "height": 860 }],
    "security": { "csp": "..." }         // ← see Security section
  },

  "bundle": {
    "targets": ["msi", "nsis"],
    "createUpdaterArtifacts": true,       // needed for tauri-plugin-updater
    "active": true
  },

  "plugins": {
    "updater": {                          // configure updater plugin here, not in Cargo.toml
      "pubkey": "...",
      "endpoints": ["https://..."]
    }
  }
}
```

### Version sync rule
`tauri.conf.json` → `"version"` and `Cargo.toml` → `[package].version` **must always match**.
The CI release workflow bumps both atomically; never edit one without the other.

### Window label
The `"label"` value (`"main"`) must match every `app.get_window("main")` call in Rust and every capability `"windows": ["main"]` entry.

---

## 2 · Plugin Registration

Adding a plugin requires **three** coordinated changes. Miss any one and the command will panic at runtime.

### Step A — `Cargo.toml`

```toml
# Runtime dependency (all platforms):
tauri-plugin-dialog = "2"

# Platform-gated dependency example:
[target.'cfg(not(any(target_os = "android", target_os = "ios")))'.dependencies]
tauri-plugin-updater = "2"
```

### Step B — `src-tauri/src/lib.rs` (builder chain)

```rust
.plugin(tauri_plugin_dialog::init())
.plugin(tauri_plugin_opener::init())
.plugin(tauri_plugin_google_auth::init())
// Platform-gated:
#[cfg(not(any(target_os = "android", target_os = "ios")))]
.plugin(tauri_plugin_updater::Builder::new().build())
```

Order matters: register plugins **before** `.run(...)`.

### Step C — `capabilities/default.json`

```jsonc
{
  "permissions": [
    "core:default",
    "dialog:default",
    "opener:default",
    "google-auth:default",
    "updater:default",
    // Fine-grained permission with allow list:
    { "identifier": "opener:allow-open-path", "allow": [{ "path": "**" }] }
  ]
}
```

### Checklist for a new plugin

- [ ] Add crate to `Cargo.toml` (correct platform gate if needed)
- [ ] Call `.plugin(tauri_plugin_X::init())` in `lib.rs` builder
- [ ] Add `"plugin-name:default"` (or specific permissions) to `capabilities/default.json`
- [ ] Add JS import: `import { fn } from '@tauri-apps/plugin-name'`
- [ ] Verify `package.json` has `@tauri-apps/plugin-name` installed

---

## 3 · Security

### CSP (`tauri.conf.json` → `app.security.csp`)

Only allowlist the exact origins your app contacts:

```
default-src 'self';
connect-src 'self'
  https://accounts.google.com
  https://oauth2.googleapis.com
  https://www.googleapis.com
  https://firestore.googleapis.com
  http://127.0.0.1;
img-src 'self' asset: https: data: blob:;
style-src 'self' 'unsafe-inline'
```

**Rules:**
- Never use `connect-src *` — enumerate domains explicitly.
- `asset:` in `img-src` is required for Tauri local asset protocol (thumbnails, logos).
- Add `http://127.0.0.1` only if a plugin uses a local loopback (e.g. OAuth redirect).
- Adding a new API domain? Add it to `connect-src` **and** update this skill.

### OAuth secrets — `option_env!()` pattern

Secrets are compiled into the Rust binary, never shipped in JS:

```rust
// build.rs — inject at compile time from env vars
println!("cargo:rustc-env=GOOGLE_CLIENT_ID={}", ...);

// lib.rs — read at runtime
const CLIENT_ID: &str = env!("GOOGLE_CLIENT_ID");      // panics at build if missing
// or
let id = option_env!("GOOGLE_CLIENT_ID").unwrap_or(""); // silent empty string
```

The frontend fetches credentials via a Tauri command (`get_oauth_credentials`) — **never** hard-code them in TypeScript.

### Capability least-privilege

- Grant only the permissions actually invoked. Audit `capabilities/default.json` when removing a plugin.
- Prefer scoped permissions over blanket defaults where available:
  ```jsonc
  { "identifier": "fs:allow-read-file", "allow": [{ "path": "$APPDATA/**" }] }
  ```

---

## 4 · Debugging

### Log prefix convention

All `println!` / `eprintln!` use grep-friendly module prefixes:

| Prefix | Module |
|--------|--------|
| `[gdrive]` | `gdrive.rs` |
| `[sync]` | `sync.rs` |
| `[watcher]` | `watcher.rs` |
| `[auth]` | `gdrive_auth.rs` |
| `[settings]` | `settings.rs` |

```rust
println!("[sync] Starting sync for game: {game_id}");
eprintln!("[gdrive] Upload failed: {e}");
```

### IPC / `invoke` errors

When a frontend `invoke("command_name", payload)` fails:

1. Check the command is in `tauri::generate_handler![...]` in `lib.rs`
2. Check the Rust function is annotated `#[tauri::command]`
3. Check parameter names match — Tauri maps camelCase JS → snake_case Rust automatically via serde
4. Check the return type is `Result<T, String>` (not `Result<T, Error>`)
5. Open Tauri DevTools (F12 in dev mode) → Console tab for the real Rust panic message

### Inspecting background thread errors

Background threads (spawned via `std::thread::spawn`) swallow panics silently. Pattern to surface errors:

```rust
std::thread::spawn(move || {
    if let Err(e) = some_blocking_operation(&app_clone, &game_id) {
        eprintln!("[sync] background thread failed for {game_id}: {e}");
    }
});
```

Never `.unwrap()` inside a background thread — use `if let Err`.

### Tauri DevTools

In dev mode (`npm run tauri -- dev`), press **F12** or right-click → "Inspect" to open DevTools.
Rust `println!` output goes to the **terminal** running `tauri dev`, not to DevTools.
JS `console.log` goes to the DevTools **Console** tab.

### Common build errors

| Error | Cause | Fix |
|-------|-------|-----|
| `command X not found` | Missing from `generate_handler![]` | Add to handler list in `lib.rs` |
| `permission denied` | Missing capability entry | Add to `capabilities/default.json` |
| `CSP violation` | New domain not in CSP | Add to `connect-src` in `tauri.conf.json` |
| `versions mismatch` | `tauri.conf.json` version ≠ `Cargo.toml` | Sync both to same semver |
| `plugin not initialized` | Missing `.plugin(...)` call | Add to builder chain in `lib.rs` |
| `cargo: env var not found` | `env!()` used but var not set | Switch to `option_env!()` or set in CI |

---

## 5 · Test & Validation

### Fast check — frontend only (no Rust needed)

```powershell
npm run build   # tsc + vite build — catches all TypeScript and CSS errors
```

Run this first. It's fast (~10 s) and catches most TS/type mismatches before invoking cargo.

### Full dev run

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
npm run tauri -- dev
```

### Release build (CI artefacts)

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
npm run tauri -- build
# Outputs: src-tauri/target/release/bundle/{msi,nsis}/
```

### Rust compile check (no full link)

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
cd src-tauri ; cargo check 2>&1 | Select-Object -First 40
```

Faster than `cargo build`; surfaces type errors and missing imports without linking.

### Tauri command integration testing pattern

For Rust commands that don't need the full window, write a `#[cfg(test)]` unit test against the pure logic functions (not the `#[tauri::command]` wrapper):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_expand_env_vars_localappdata() {
        let path = "%LOCALAPPDATA%\\Game\\Saves";
        let expanded = expand_env_vars(path);
        assert!(expanded.contains("AppData\\Local"));
    }
}
```

Run with:
```powershell
cd src-tauri ; cargo test 2>&1
```

### Frontend service-layer testing

`src/services/tauri.ts` wraps all `invoke()` calls. Mock the module in tests:

```ts
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue({ games: [] }),
}));
```

---

## Quick Decision Table

| Task | File(s) to edit |
|------|-----------------|
| Add/change window size | `tauri.conf.json` → `app.windows` |
| Allow new API domain | `tauri.conf.json` → `app.security.csp` (connect-src) |
| Add a Tauri plugin | `Cargo.toml` + `lib.rs` builder + `capabilities/default.json` |
| Add a Tauri command | `lib.rs` → function + `generate_handler![]` |
| Compile a secret into binary | `build.rs` + `option_env!()` in `lib.rs` |
| Change installer targets | `tauri.conf.json` → `bundle.targets` |
| Debug an invoke error | DevTools console + Rust terminal output + handler list |
| Run type-check only | `npm run build` |
| Run Rust compile check | `cd src-tauri; cargo check` |

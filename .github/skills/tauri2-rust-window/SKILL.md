---
name: tauri2-rust-window
description: "Use when: writing Rust backend code for Tauri 2, adding Tauri commands in lib.rs, managing app windows from Rust (show/hide/focus/minimize), handling window events (CloseRequested, minimize to tray), emitting Tauri events from Rust, managing shared state with tauri::State, running background threads with AppHandle, using tokio::task::spawn_blocking for blocking HTTP in async commands, deciding whether to use an official Tauri 2 plugin or write custom Rust code. Covers AppHandle patterns, Manager trait, Emitter trait, plugin-first decision table, window lifecycle, setup hook, on_window_event, generate_handler, sync vs async command choice."
argument-hint: "Describe what you want to build or fix in Rust, e.g. 'hide window to tray on close', 'emit event after background task', 'add managed state for a cache'"
---

# Tauri 2 — Rust Backend & Window Management

## Plugin-First Decision Table

**Always check this table before writing custom Rust code.** If Tauri 2 has an official plugin that covers the need, use it — it handles permissions, capabilities, and cross-platform edge cases for you.

| Need | Use plugin | Cargo crate | When to write custom Rust instead |
|------|-----------|------------|----------------------------------|
| Open URL / file in OS default app | `tauri-plugin-opener` | `tauri-plugin-opener` | Never — plugin covers all cases |
| File / folder picker dialog | `tauri-plugin-dialog` | `tauri-plugin-dialog` | Never |
| Read / write files | `tauri-plugin-fs` | `tauri-plugin-fs` | Only if you need fine-grained `std::fs` control in a background thread |
| Shell / subprocess | `tauri-plugin-shell` | `tauri-plugin-shell` | Never for simple cases |
| OS notifications | `tauri-plugin-notification` | `tauri-plugin-notification` | Never |
| Clipboard | `tauri-plugin-clipboard-manager` | `tauri-plugin-clipboard-manager` | Never |
| In-app auto-update | `tauri-plugin-updater` | `tauri-plugin-updater` | Never |
| Deep links | `tauri-plugin-deep-link` | `tauri-plugin-deep-link` | Never |
| Persist window size/position | `tauri-plugin-window-state` | `tauri-plugin-window-state` | Never |
| Key-value store | `tauri-plugin-store` | `tauri-plugin-store` | Only if you need per-user JSON files with custom merge logic |
| HTTP requests | — | `ureq` (blocking) / `reqwest` (async) | Always — Tauri has no HTTP plugin; use `ureq` for Drive/Firestore API calls |
| OAuth / browser sign-in | Community plugin | `tauri-plugin-google-auth` | Only for providers not covered by the plugin |
| Process list / sysinfo | — | `sysinfo` | Always — no plugin for this |

> When in doubt: search [tauri.app/plugin](https://tauri.app/plugin/) before implementing from scratch.

---

## 1 · Core Rust Traits You Must Import

Every file that works with Tauri's runtime needs these traits in scope:

```rust
use tauri::{AppHandle, Manager};   // Manager = get_webview_window, manage, path, state
use tauri::Emitter;                 // emit() events to frontend
```

Access the window:
```rust
let win = app.get_webview_window("main").ok_or("window not found")?;
```

The label `"main"` must match the `"label"` value in `tauri.conf.json` → `app.windows`.

---

## 2 · Window Management from Rust

### Show / focus / restore

```rust
if let Some(win) = app.get_webview_window("main") {
    let _ = win.show();         // unhide if hidden
    let _ = win.unminimize();   // restore if minimised
    let _ = win.set_focus();    // bring to foreground
}
```

Always chain `.show()` + `.unminimize()` + `.set_focus()` — each covers a different
hidden state (hidden via `.hide()`, minimised via taskbar, or just unfocused).

### Hide (keep in tray)

```rust
if let Some(win) = app.get_webview_window("main") {
    let _ = win.hide();
}
```

### Intercept close → hide instead of quit

Register in the builder chain in `lib.rs`:

```rust
.on_window_event(|window, event| {
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        let _ = window.hide();
        api.prevent_close();    // cancel the OS close
    }
})
```

> Only prevents close when Tauri manages the event. `.exit(0)` on `AppHandle` always exits.

### Open a new window at runtime

```rust
use tauri::WebviewWindowBuilder;

let new_win = WebviewWindowBuilder::new(
    &app,
    "settings",                          // unique label
    tauri::WebviewUrl::App("/#/settings".into()),
)
.title("Settings")
.inner_size(900.0, 600.0)
.build()
.map_err(|e| e.to_string())?;
```

Register the label in `tauri.conf.json` windows array only if you want it pre-created at launch.
Runtime-created windows do **not** need to be listed in `tauri.conf.json`.

---

## 3 · Writing Tauri Commands

### Minimal sync command

```rust
#[tauri::command]
fn my_command(app: tauri::AppHandle, param: String) -> Result<MyResponse, String> {
    // ... pure Rust logic
    Ok(MyResponse { ... })
}
```

Rules:
- Return type **must** be `Result<T, String>` — Tauri serialises the `Err` variant as the rejection reason.
- Parameter names are automatically camelCase↔snake_case mapped by serde. `game_id` in Rust = `gameId` in TS.
- `AppHandle` is **always** the first parameter when you need access to Tauri runtime (windows, state, paths). It does NOT count as a frontend-supplied argument.

### Async command (for blocking I/O — e.g. HTTP calls)

`ureq` is a **blocking** HTTP client. Never call it directly in an `async fn` — wrap with `spawn_blocking`:

```rust
#[tauri::command]
async fn upload_data(app: tauri::AppHandle, game_id: String) -> Result<MyResult, String> {
    tokio::task::spawn_blocking(move || {
        // ureq / std::fs calls here — moved AppHandle into thread
        my_module::do_blocking_work(&app, &game_id)
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?
}
```

### Register in `generate_handler!`

```rust
.invoke_handler(tauri::generate_handler![
    my_command,
    upload_data,
    // ...
])
```

**Forgetting this is the #1 cause of "command not found" panics.**

### Sync vs Async decision

| Choose | When |
|--------|------|
| `fn` (sync) | Pure computation, JSON read/write, in-memory work |
| `async fn` + `spawn_blocking` | Any blocking I/O: `ureq` HTTP, `std::fs`, `walkdir`, `sysinfo` |
| `async fn` natively | Only if all called functions are already `async` (e.g. `reqwest`) |

---

## 4 · AppHandle Patterns

### Clone for background threads

`AppHandle` is cheap to clone — pass clones into threads:

```rust
let app_clone = app.clone();
std::thread::spawn(move || {
    if let Err(e) = some_blocking_work(&app_clone) {
        eprintln!("[module] background task failed: {e}");
    }
});
```

**Never move the original** `app` — you may still need it after spawning.

### App data directory

```rust
use tauri::Manager;

let data_dir = app.path().app_data_dir()
    .map_err(|e| format!("app_data_dir failed: {e}"))?;
let file_path = data_dir.join("my-file.json");
```

### Exit the application

```rust
app.exit(0);     // clean exit
```

---

## 5 · Managed State (`tauri::State`)

Use managed state for shared, in-memory data (caches, background thread handles, mutexes).

### Register in `setup` hook

```rust
use std::sync::{Arc, Mutex};

app.manage(Arc::new(Mutex::new(MyState::new())));
```

### Access in a command

```rust
#[tauri::command]
fn use_state(state: tauri::State<Arc<Mutex<MyState>>>) -> Result<(), String> {
    let mut s = state.lock().map_err(|e| e.to_string())?;
    s.do_something();
    Ok(())
}
```

`tauri::State<T>` is extracted automatically — it does **not** need to be passed from the frontend.

---

## 6 · Emitting Events from Rust

```rust
use tauri::Emitter;

// Emit to all windows
tauri::Emitter::emit(&app, "event-name", payload)?;

// Emit to a specific window
if let Some(win) = app.get_webview_window("main") {
    win.emit("event-name", payload)?;
}
```

Payloads must implement `serde::Serialize`. Use a struct with `#[derive(serde::Serialize, Clone)]`.

**From a background thread** — `Emitter` is available on `AppHandle` which is `Send + Sync`:

```rust
let app_clone = app.clone();
std::thread::spawn(move || {
    // ... work ...
    let _ = tauri::Emitter::emit(&app_clone, "sync-completed", result);
});
```

---

## 7 · Setup Hook Pattern

The `.setup()` closure is the right place to:
- Register managed state (`app.manage(...)`)
- Start background threads / watchers
- Build the system tray
- Apply initial window visibility settings

```rust
.setup(|app| {
    // 1. Managed state
    let manager = MyManager::new(app.handle().clone());
    app.manage(Arc::new(Mutex::new(manager)));

    // 2. Background watcher
    start_background_poll(app.handle());

    // 3. System tray
    tray::setup_tray(app).map_err(|e| e.to_string())?;

    // 4. Conditional window visibility
    if let Ok(settings) = settings::get_settings(app.handle()) {
        if settings.start_minimised {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.hide();
            }
        }
    }

    Ok(())
})
```

---

## 8 · Platform Gating

Wrap Windows-only code so the app still compiles on macOS/Linux:

```rust
#[cfg(target_os = "windows")]
fn register_startup(app: &AppHandle) {
    use winreg::enums::HKEY_CURRENT_USER;
    // ... write registry key
}

#[cfg(not(target_os = "windows"))]
fn register_startup(_app: &AppHandle) {}  // no-op
```

In `Cargo.toml`:

```toml
[target.'cfg(windows)'.dependencies]
winreg = "0.55"

[target.'cfg(not(any(target_os = "android", target_os = "ios")))'.dependencies]
tauri-plugin-updater = "2"
```

---

## 9 · Common Mistakes & Fixes

| Mistake | Symptom | Fix |
|---------|---------|-----|
| Calling `ureq` directly in `async fn` | Tokio runtime panics / thread starvation | Wrap in `tokio::task::spawn_blocking` |
| Forgetting `generate_handler![]` entry | `"command not found"` at runtime | Add to the list in `lib.rs` |
| Using `unwrap()` in a background thread | Silent panic, thread dies with no log | Use `if let Err(e) = ...` + `eprintln!` |
| Moving `app` into thread, then using it | Borrow-after-move compile error | Clone before spawning: `let ac = app.clone()` |
| `app.get_webview_window` returns `None` | Window label mismatch | Check `tauri.conf.json` `"label"` value |
| Missing `use tauri::Manager` | `get_webview_window` / `path` / `manage` not found | Add the import |
| Missing `use tauri::Emitter` | `.emit()` not found on AppHandle | Add the import |
| `winreg::enums::HKEY` path | Compile error on `winreg` 0.55 | Import from `winreg::HKEY` (not `enums`) |

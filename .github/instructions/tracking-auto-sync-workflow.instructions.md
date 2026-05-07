---
description: "Use when: modifying watcher.rs, sync.rs, lib.rs launch/tracking commands, tracking UI, or any workflow for game-close auto-sync to Google Drive. Covers process-tracking rules, exeName/exePath contract, startup arming behavior, and event semantics."
---

# Tracking And Auto-Sync Workflow Rules

## Scope

Apply these rules when implementing or reviewing process tracking and auto-sync-on-close behavior.

## Core Contract

- Process-exit sync is keyed by `exe_name` detection and `auto_sync` state.
- `exe_path` is optional for close-triggered sync. Never gate watcher-triggered sync on `exe_path` existence.
- `exe_name` is required for process close detection. If missing, tracking cannot be active.
- Keep behavior explicit in logs and UI text:
- Logs should explain why sync triggered or was skipped.
- UI should state `exe_name` is required and `exe_path` is optional for close-triggered sync.

## Watcher Lifecycle Rules

- Startup (`init_watchers`):
- If `track_changes=true` and valid local `exe_path` exists, skip ambient startup tracking and arm on Play.
- If `track_changes=true` and `exe_path` is empty/invalid, still register tracking at startup when `exe_name` exists.
- Play flow (`launch_game` + `arm_on_launch`):
- Arm watcher after successful launch when `track_changes=true` and `exe_name` is non-empty.
- Toggle flow (`toggle_track_changes`):
- Enabling should persist toggle state even when `exe_name` is missing; watcher can no-op and UI must show guidance.

## Event And Decision Semantics

- On process start: emit `game-status-changed` with `status: "playing"`.
- On process exit: emit `game-status-changed` with `status: "idle"` before sync decision.
- If `auto_sync=true`, attempt `sync::sync_game` with per-game lock.
- If lock is busy, skip duplicate sync and log reason.
- If `auto_sync=false`, emit `game-sync-pending`.

## Safety And Regression Guards

- Do not change Firestore/Drive schema or API command signatures when touching this workflow.
- Preserve `DashboardData` return pattern and `apply_path_overrides` behavior in command responses.
- Keep startup optimization and cross-device behavior:
- Device without valid `exe_path` can still track by `exe_name`.
- Device with valid `exe_path` should avoid unnecessary ambient polling until Play arms tracking.

## Validation Matrix

- Case A: `exe_path` set + `exe_name` set + `track_changes=true` + `auto_sync=true` -> sync on close.
- Case B: `exe_path` empty + `exe_name` set + `track_changes=true` + `auto_sync=true` -> sync on close.
- Case C: `exe_path` empty + `exe_name` set + `track_changes=true` + `auto_sync=false` -> emit `game-sync-pending`.
- Case D: `exe_name` empty + `track_changes=true` -> no tracking activation; show UI guidance.

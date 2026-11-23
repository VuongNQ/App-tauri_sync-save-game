# Save safety and rollout

The foundation below describes phase 1. Normal sync, Push and Restore now use
the [phase 3 versioned engine](cross-device-sync.md), with SHA-256 identity,
whole-game cloud CAS, tombstones and recoverable multi-path local application.
Legacy baseline/cloud metadata is preserved for migration, not used as the new
authoritative sync protocol.

## Implemented foundation

- Play invokes a single Rust `sync_and_launch_game` command. The operation gate
  remains held from safe bidirectional sync through launching the executable.
  First-time games without cloud data can launch directly. An explicit offline
  launch skips networking but still respects the gate and running-process check.
- Both changed sides, or a first-sync collision without a shared baseline, stop
  automatic sync. The sync dialog exposes the conflicting-file count and lets
  the user explicitly choose local Push or cloud Restore. It does not guess a
  winner from the machines' clocks.
- Downloads write to a unique sibling temporary file, check Content-Length when
  supplied, flush, back up the previous local bytes and then rename. Failed
  transfer, backup or rename retains the original destination. A whole game is
  **not** a single atomic transaction: completed files/paths can remain updated
  when a later file fails.
- Local library, token JSON and sync trackers also use temporary-file replacement.
  This prevents partial JSON writes; it is not an OS keyring implementation.
- Cloud file overwrites first create a recovery copy. Failed backup stops the
  overwrite. Recovery copies use a separate `recovery/` folder rather than
  pretending to be complete version snapshots.
- Save metadata paths are validated on Windows and Unix. Absolute paths,
  traversal, Windows alternate streams/device names and links/junctions are
  rejected. Downloads never guess file identity from a shared basename after
  a stale Drive ID.
- Explicit Restore respects each path's inclusion selection. Editing a selection
  no longer automatically deletes cloud files. Deletion remains an explicit UI
  action. Local deletions retain their cloud record until a versioned deletion
  protocol is implemented.
- Manual sync, post-login sync, watcher sync, backup operations, Drive mutations,
  game edits and launch share a per-game gate. Account changes, clearing Drive,
  adding games and cloud library refresh use an exclusive gate. This is an
  **in-process** gate, not cross-device or cross-process coordination.
- On Windows, save transfer and backup restore check the current process list
  when an executable name is configured. Configure the name even when tracking
  is off. No executable name means the app cannot reliably detect an externally
  launched game. A game can also start externally after the check.

## Recovering previous bytes

Local replacements preserve files under the app-data directory:

```
save-recovery/<unique-id>/save.bak
save-recovery/<unique-id>/original-path.txt
```

Close the game and app before manually copying `save.bak` back to the path in
`original-path.txt`. Copy rather than move the backup until recovery is verified.

Cloud recovery copies are inside each save path's Drive folder:

```
recovery/<unique-id>/<original-file-name>
recovery/<unique-id>/.recovery-meta.json
```

The record identifies the original Drive file/folder and relative save path when
available. These copies can be inspected through the app's Drive file manager;
guided restoration and automatic retention are follow-up work. They consume
Drive storage and are not included in the existing live-save quota counter.
Do not delete recovery data until the chosen save has been verified in-game.
Existing named version snapshots are still primary-path/root-file snapshots;
they are not full multi-path recovery archives.

## Upgrade behavior

Existing `games-library-<user-id>.json` files and Drive folders are preserved.
The local tracker has an additive `cloudState` field containing the exact cloud
timestamp, size and file ID observed at the last successful sync. Old trackers
can be read, but missing baseline information can require an explicit choice on
the next sync. Corrupt/unreadable trackers fail closed instead of being treated
as first sync. Older clients can still bypass these protections, so upgrade all
devices before testing the new workflow together.

## Validation

`npm ci`, `npm run lint`, `npm run build` and `node scripts/test-safety.mjs`.
The last command requires Rust on PATH, but no Tauri desktop libraries, Google
credentials or network. CI runs it on Linux and Windows, and separately runs
the actual Tauri library tests on Windows with `cargo test --locked --lib`.

Before releasing, use disposable save folders and a test Google account:

1. Sync from PC A, restore on PC B, play on B, sync, then return to A.
2. Modify A offline and click Play: local progress must not be force-restored.
3. Modify both machines: automatic sync stops, explicit choices keep recovery copies.
4. Interrupt a large download and retry. Verify original bytes and recovery files.
5. Run Play/Restore/Push simultaneously and attempt sign-out during sync.
6. Test multiple save paths, exclusions, duplicate leaf names and paths containing Unicode.
7. Upgrade a 0.1.30 install, resolve any legacy-baseline prompt and verify playtime.

## Remaining roadmap

| Milestone | Work | Exit condition |
|---|---|---|
| Account security | Code/Rules, DPAPI and tests prepared in [phase 2](account-security.md); existing Google ID namespaces retained | Activate and verify live project IAM/Auth/Rules and two-account access before release |
| Cross-device sync | Implemented in [phase 3](cross-device-sync.md): content hashes, whole-game CAS, tombstones, multi-path snapshots and recovery journals | Complete the documented live two-device Windows acceptance checks before release |
| Background/offline | Persistent task queue, idempotent playtime increments, working interval scheduler, 401 refresh, bounded retry, refresh caching | Restart/network loss retains pending work and does not duplicate playtime |
| Release | Unified version source, migration rollback, signed-updater upgrade check | Verified upgrade from 0.1.30 with recoverable state |
| Platform expansion | Separate Windows process/path/startup/device adapters, then validate Linux handheld/SteamOS paths and controller-friendly UI | A tested compatibility matrix per OS and save format |

The cloud identity migration requires the actual project configuration and a
tested data mapping; no production Rules/IAM, secrets, releases or live saves are
changed by this branch. Windows handheld PCs share the current Windows target.
SteamOS/Linux and incompatible game/emulator save formats need separate testing;
syncing bytes does not by itself convert save formats.

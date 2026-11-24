# Phase 3: cross-device save integrity

## Behavior

All normal sync, watcher sync, pre-launch sync, explicit Push and explicit Restore
use the same v2 engine. SHA-256 hashes identify content; modification times are
display information, never the conflict winner. Equal bytes converge even when
machine clocks or timestamps differ. A new device with different existing saves
must explicitly choose a direction.

The engine compares local content, the previous local/cloud baseline and the
current cloud manifest. Changes on both sides stop automatic sync. This also
applies to disjoint files: a game's memory card and save state may be one logical
save set, so automatic sync must not combine independently advanced sets.

Local deletion propagates only for a previously tracked, included file. Cloud
deletions are durable tombstones with a revision. An unchanged local copy is
removed with a recovery copy; an edited copy conflicts. A stale newly joined
device cannot resurrect a tombstone without an explicit Push. Files excluded by
a changed filter remain in cloud until the user invokes cleanup. Changing a
local folder/filter resets baseline trust; an unavailable previously synced
folder fails closed instead of publishing mass deletions.

### Startup cloud check

About 20 seconds after the app starts with a signed-in account, each game is
checked once, one at a time. If this device's baseline revision equals the cloud
manifest revision the game is up to date: one Firestore read, no hashing and no
Drive calls. Otherwise local files are hashed and planned with the same Merge
plan as a normal sync. Only a pure fast-forward (downloads and tombstone
deletes, no local edits and no conflicts) is applied automatically, through the
normal engine, when the `autoPullOnStartup` setting is on (default) and the
device is not on battery. Anything with local edits or conflicts is only
flagged ("Needs review"); legacy layouts are left to a normal sync. Running or
busy games are skipped. Results are exposed through `get_cloud_statuses` and the
`cloud-status-changed` event for the game list badges.

## Cloud publication

The authoritative document is:

```
users/{google-id}/syncMeta/v2-{sha256(game-id)}
```

It contains a versioned whole-game manifest: path labels, relative paths,
SHA-256, byte sizes, immutable Drive object IDs, tombstones and an operation ID.
The existing owner-only `syncMeta` Security Rules cover it; this change requires
no new collection permissions and does not deploy Rules or change IAM.
Legacy per-path Firestore mirrors cannot overwrite the v2 document.

Every uploaded save is a NEW Drive object under the game's `.save-sync-v2/`
folder, unless identical bytes (same SHA-256 and size) are already stored as an
object referenced by the current manifest or one of the newest snapshots; that
object is then reused. Published objects are never overwritten, and sync itself
never deletes them (see "Storage cleanup").
Only after all uploads, downloads, integrity checks, quota checks and local
rechecks succeed does a Firestore `documents:commit` publish the entire manifest.
The write uses `currentDocument.updateTime`, or `exists: false` for first use.
Concurrent devices cannot both publish from the same version. A lost response
is checked against the operation ID; the client never retries a blind overwrite.
A failed CAS leaves local saves/baseline unchanged and preserves orphan uploads.

The live-save quota remains based on active files. Immutable history, recovery
snapshots and interrupted uploads also consume Drive storage until the storage
cleanup below reclaims them. Manifests larger than
900,000 UTF-8 bytes are rejected before publication to stay below Firestore's
document limit; split unusually large file sets into separate game entries.

## Local transactions and recovery

New downloads are staged outside game folders and verified against both hash
and size. Before touching any live file, the engine writes and flushes original
copies, staged replacements and `journal.json` for ALL affected paths plus the
next baseline. The baseline participates in the same recoverable transaction.
An OS file lock prevents a second local app process from syncing the same game.

The storage directory is:

```
{app-data}/sync-v2/{sha256(google-id)}/{sha256(game-id)}/
  baseline.json
  operation.lock
  pending/journal.json
  recovery-*/journal.json
  recovery-*/before-N
  recovery-*/after-N
```

Before the next operation, an incomplete transaction restores previous saves
AND baseline. The journal records each target root/relative path and before/after
hash. If a file was edited after interruption, recovery stops and keeps every
copy for manual review rather than overwriting that progress. Completed and
rolled-back journals are retained as `recovery-*` directories. Close the game
and app before manual recovery; match `before-N` to record N in `journal.json`.
Do not delete recovery directories until the chosen save works in-game.

This is recoverable multi-file application, not an OS-atomic directory swap.
A crash can expose a partially applied set until recovery runs. External game
launches/file edits can race process checks; configure each game's executable
name and close it during sync. Cloud publication can succeed before a later
local failure; the next attempt uses the retained baseline and cloud revision
and may require explicit conflict resolution. Local recovery does not roll back
another device's cloud publication.

## Snapshots and file manager

New named backups include `.snapshot-v2.json` for all cloud save paths, nested
relative paths and deletion records. They pin immutable object IDs, so copying
each blob is unnecessary. `.backup-meta.json` marks the completed backup for the
existing UI. Before replacing a cloud save set, the engine creates a full
recovery snapshot. Restoring a snapshot uses the same staged verification,
server CAS and local journal as normal sync; subsequently introduced tracked
files become tombstones. Unconfigured/excluded paths on the current device are
preserved. New snapshots back up the currently published CLOUD set; sync local
progress first if it should be part of a named snapshot.

The file manager shows logical current files from the manifest instead of raw
object/history folders. Delete publishes a tombstone and keeps a snapshot;
other devices apply it on sync, with conflicts for edited copies. Rename/move
are disabled for immutable saves. Deleting a named snapshot removes its metadata;
its objects are reclaimed later by storage cleanup only if nothing else uses them.
Legacy snapshots remain listed; once v2 is active, legacy restore is refused
because those backups cannot represent a complete multi-path save set.

## Storage cleanup

Saves live in each user's own Drive `appDataFolder`, so history consumes the
user's Google storage, while Drive API calls are free. Cleanup runs on the
device (`drive_gc.rs` decides, `cross_device::run_gc` executes) and costs one
Firestore read per game (two if it deletes), and zero Firestore writes.

- Retention: automatic snapshots ("Before sync", "Before cloud deletion",
  "Before removing excluded files") keep the newest 10 plus all younger than
  14 days. User-named and legacy snapshots are never pruned. Pruning deletes
  only the snapshot folder; its objects become candidates.
- Live set: objects in the current manifest, objects in every retained snapshot
  (`.snapshot-v2.json`, cached locally per immutable folder ID), and every
  object younger than 7 days (uploads awaiting another device's CAS).
- Two phases: a run marks unreferenced objects in the local
  `gc-pending.json`. A later run, at least 24 hours after marking, deletes only
  marked objects that are still unreferenced, after re-reading the manifest
  immediately before deleting. Objects marked later wait their own 24 hours.
- Upload dedup only reuses objects of snapshots present at the start of that
  sync. A snapshot that disappears keeps its objects at least 24 more hours, far
  longer than any sync, so a reused object cannot be deleted under it.
- Worst case for a race is a failed download or restore on another device
  (SHA-256 verification stops it; local saves are untouched), never a broken
  current manifest.
- Schedule: in the background 30 s after a successful sync, at most once every
  7 days per game (or when marked objects are due), skipped while the game runs
  or another save operation holds it. "Clean up old save versions on Drive" in
  the game's Status tab runs it on demand, still two-phase.
- Not touched: legacy (pre-v2) files, `.sync-meta.json`, library/settings data.

## Upgrade and compatibility

1. Back up disposable/test saves and upgrade ALL participating devices together.
   The current app supports Windows PCs and Windows handhelds. Linux/SteamOS
   still require platform and protected-credential work from later phases.
2. Existing game IDs, libraries, Drive folders and `.sync-meta.json` remain intact.
   On first v2 use, the app downloads/hashes legacy bytes and copies them into
   immutable objects before publishing. A preexisting local copy with identical
   content needs no choice; different content requires Push/Restore.
3. Keep save-path ordering and labels stable after adoption. Changed layouts are
   rejected rather than matching the wrong memory card/save state. Device-local
   absolute folder locations can differ. Stable editable path IDs are future work.
4. Old clients do not understand v2 manifests and cannot participate safely:
   stop syncing with them. They may still edit the preserved legacy data; those
   edits are not imported again after v2 activation. Do not downgrade and sync
   expecting it to read new progress. Export/recover the desired bytes first.
5. Review the first sync on each device. A deleted/reset cloud manifest or revision
   moving backwards is refused for an established baseline. Explicit Remove game
   / Clear cloud data also clears that game's metadata and archives its local
   baseline so re-adding it starts a new relationship.

## Validation and acceptance

`cargo test --locked --manifest-path security/rust-tests/Cargo.toml` compiles the
production planner, filesystem journal, Firestore protocol and orchestrator with
deterministic desktop/Drive/Firestore adapters on Linux AND Windows. It exercises
PC → handheld → PC, nested multi-path saves, concurrent/disjoint edits, stale
CAS, deletions/recreation, corrupt downloads, legacy import, changed paths,
snapshot restore, failed multi-file application and interrupted-journal recovery.

`npm test --prefix security` runs the demo-only Firestore emulator, including
the production REST `documents:commit` wire shape: exactly one first-create
winner, exactly one updateTime winner and cross-account denial. Frontend checks
are `npm run lint`, `npx tsc --noEmit` and `npm run test:auth`. Existing CI also
builds the frontend and runs actual Tauri library tests on Windows.

Before release, test with two upgraded Windows installs and disposable saves:

- PC A upload → handheld B restore/play/upload → PC A restore; verify in-game.
- Edit both machines, including disjoint paths and equal-size edits; auto-sync
  must stop. Check Push/Restore and both recovery locations.
- Delete a file, sync both machines, then recreate it on an informed device.
  A stale third device with the old file must get a conflict, not resurrect it.
- Interrupt downloads, close the app during local application, and restart sync.
  Verify original saves/baseline recover together; post-crash edits must be kept.
- Restore a snapshot spanning nested memory cards and save states. Test Unicode,
  inclusion filters, unavailable folders and attempts to run two app instances.

No production credentials, live Rules, IAM, cloud data or releases are changed
by preparing or running these tests. Actual OAuth/Drive/Firestore transfers,
Windows process races and interrupted real installs still require this live
acceptance pass; mocks/emulator are not evidence those checks were performed.

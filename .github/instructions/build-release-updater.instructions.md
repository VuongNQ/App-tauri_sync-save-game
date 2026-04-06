---
description: "Use when: modifying the GitHub Actions release workflow, changing version bumping logic, adding new release secrets, configuring tauri-plugin-updater, implementing in-app update UI, adding Tauri updater commands, emitting update-download-progress events, checking for updates, installing updates, or troubleshooting signed releases. Covers the full CI/CD pipeline from push-to-main to published GitHub Release, the updater plugin wiring in Rust, update service functions, React Query hooks, and the SettingsPage update UI."
---
# Build, Release & In-App Updater

## CI/CD Pipeline — `release.yml`

### Trigger & Safety Guard
- Workflow fires on every push to `main`.
- A `if: "!startsWith(..., 'chore: bump version')"` guard prevents infinite loops when the bot commits the version bump.

### Version Bump Step
- Reads `src-tauri/tauri.conf.json` and increments the **patch** segment only.
- Mirrors the new version into `src-tauri/Cargo.toml` line matching `^version = ".*"$`.
- Commits both files as `github-actions[bot]` with message `chore: bump version to X.Y.Z`, then pushes.
- Never manually edit version fields in these files — the CI owns them.

### Build Step (`tauri-apps/tauri-action@v0`)
Required secrets (must exist in repo Settings → Secrets):

| Secret | Purpose |
|--------|---------|
| `GITHUB_TOKEN` | Create/update release + push version commit |
| `GOOGLE_CLIENT_ID` | Compiled into Rust binary via `option_env!()` |
| `GOOGLE_CLIENT_SECRET` | Compiled into Rust binary via `option_env!()` |
| `TAURI_SIGNING_PRIVATE_KEY` | Signs bundles so the updater can verify them |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the signing key |

- Release tag: `v__VERSION__` (substituted by tauri-action).
- Release name: `"Save Game Sync v__VERSION__"`.
- Releases are created as **draft** (`releaseDraft: true`) — publish manually after review.
- `tauri-action` automatically uploads `latest.json` alongside each installer bundle; this file is what the in-app updater polls.

### Adding a New Secret to the Build
1. Add the secret to GitHub repo Settings → Secrets.
2. Pass it as an `env:` entry to the "Build and publish" step.
3. Consume it in `build.rs` via `println!("cargo:rustc-env=MY_VAR={}", env::var("MY_VAR").unwrap_or_default())` and read with `option_env!("MY_VAR")` in Rust source.

---

## In-App Updater — Rust Side

### Plugin Registration (`lib.rs`)
```rust
.plugin(tauri_plugin_updater::Builder::new().build())
```
Register before `.setup()` in `tauri::Builder::default()` chain.

### `tauri.conf.json` — Updater Config
```json
"plugins": {
  "updater": {
    "pubkey": "<base64-encoded-minisign-pubkey>",
    "endpoints": [
      "https://github.com/VuongNQ/App-tauri_sync-save-game/releases/latest/download/latest.json"
    ],
    "windows": { "installMode": "passive" }
  }
}
```
- `pubkey` must match the private key used during signing. Generated once via `tauri signer generate`.
- `installMode: "passive"` shows a progress UI without requiring the user to click through.
- Change `endpoints` only if the GitHub repo is renamed — the path always ends in `.../releases/latest/download/latest.json`.

### `UpdateInfo` Model (`models.rs`)
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub available: bool,
    pub version: Option<String>,       // e.g. "0.2.0" — only when available
    pub current_version: String,       // always present
    pub body: Option<String>,          // release notes
}
```

### Tauri Commands (`lib.rs`)

**`check_for_update`** — async, returns `Result<UpdateInfo, String>`:
- Calls `app.updater()?.check().await`.
- Returns `UpdateInfo { available: false, ... }` when no update exists (not an error).

**`download_and_install_update`** — async, returns `Result<(), String>`:
- Re-checks for update; returns `Err("No update available")` if none.
- Streams download chunks and emits `"update-download-progress"` events:
  ```rust
  serde_json::json!({ "downloaded": u64, "total": u64 })
  ```
- After completion the app restarts automatically — no explicit restart call needed.
- Both commands are registered in `tauri::generate_handler![..., check_for_update, download_and_install_update]`.

---

## In-App Updater — Frontend Side

### Service Functions (`src/services/tauri.ts`)
```ts
export async function checkForUpdate(): Promise<UpdateInfo>
export async function downloadAndInstallUpdate(): Promise<void>
```
Both are plain `invoke<T>()` wrappers.

### TypeScript Type (`src/types/dashboard.ts`)
```ts
export interface UpdateInfo {
  available: boolean;
  version: string | null;
  currentVersion: string;
  body: string | null;
}
```

### React Query Hooks (`src/queries/settings.ts`)
```ts
export function useCheckForUpdateMutation()   // mutationFn: checkForUpdate
export function useInstallUpdateMutation()    // mutationFn: downloadAndInstallUpdate
```
Both use `useMutation` with no query-cache invalidation needed (install restarts the app).

### UI Pattern (`SettingsPage.tsx`)
The `useAppUpdater()` same-file hook composes both mutations plus Tauri event listening:

```ts
function useAppUpdater() {
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);

  const checkMutation  = useCheckForUpdateMutation();
  const installMutation = useInstallUpdateMutation();

  // Listen while install is pending
  useEffect(() => {
    if (!installMutation.isPending) return;
    let unlisten: (() => void) | undefined;
    listen<DownloadProgress>("update-download-progress", (e) => setProgress(e.payload))
      .then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [installMutation.isPending]);

  return { updateInfo, progress, checkMutation, installMutation, handleCheck, handleInstall };
}
```

Rules:
- Always unsubscribe the Tauri event listener in the `useEffect` cleanup.
- `progress` is `null` when no install is in progress.
- After `handleInstall` is called the app will restart — no navigation or state cleanup is needed.

---

## Generating a New Signing Keypair

Run once and store the output:
```powershell
npx tauri signer generate -w ./my-key.key
```
- The generated **private key** goes into the `TAURI_SIGNING_PRIVATE_KEY` secret.
- The corresponding **public key** goes into `tauri.conf.json` → `plugins.updater.pubkey`.
- Delete the local `.key` file after storing in secrets — never commit it.

---

## Common Mistakes

- **Version mismatch**: If `tauri.conf.json` and `Cargo.toml` versions diverge, the build fails. The CI bump step must update both atomically.
- **Missing `latest.json`**: `tauri-action` only uploads `latest.json` when the release target is a GitHub Release. Draft releases still get the file; the updater can poll drafts.
- **Unsigned bundles in dev**: `check_for_update` will error in `tauri dev` because no updater endpoint/key is active. Wrap with a dev guard or handle the `Err` from `app.updater()` gracefully.
- **`installMode: "basicUi"` vs `"passive"`**: `passive` is the right default for desktop; `basicUi` shows the full installer wizard which can confuse users.

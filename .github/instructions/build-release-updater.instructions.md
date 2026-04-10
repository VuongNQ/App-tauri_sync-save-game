---
description: "Use when: modifying the GitHub Actions release workflow, changing version bumping logic, adding new release secrets, configuring tauri-plugin-updater, implementing in-app update UI, checking for updates, installing updates, or troubleshooting signed releases. Covers the full CI/CD pipeline from push-to-main to published GitHub Release, the updater plugin wiring in Rust, the JS API (check/downloadAndInstall), the useAppUpdater hook, and the SettingsPage update UI."
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
| `GOOGLE_CLOUD_PROJECT_ID` | Firestore project ID compiled into Rust binary via `option_env!()` |
| `TAURI_SIGNING_PRIVATE_KEY` | Signs bundles so the updater can verify them |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the signing key |

- Release tag: `v__VERSION__` (substituted by tauri-action).
- Release name: `"Save Game Sync v__VERSION__"`.
- Releases are **published immediately** (`releaseDraft: false`) — required so `/releases/latest/download/latest.json` is publicly accessible for the in-app updater.
- `tauri-action` automatically uploads `latest.json` alongside each installer bundle; this file is what the in-app updater polls.
- The `.sig` file pattern for NSIS v2 bundles is `*-setup.exe.sig` (not `*.nsis.zip.sig` which is the legacy v1 format).

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

> **No custom Tauri commands needed.** The updater is driven entirely by the `@tauri-apps/plugin-updater` JS API. Do NOT add `check_for_update` or `download_and_install_update` Rust commands — the plugin exposes everything the frontend needs directly.

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

> **Removed.** There is no `UpdateInfo` Rust struct or TypeScript interface. The JS API's `Update` type (from `@tauri-apps/plugin-updater`) is used directly on the frontend.

### Tauri Commands (`lib.rs`)

> **None.** Do not add `check_for_update` or `download_and_install_update` Tauri commands. The `@tauri-apps/plugin-updater` JS package handles all update operations without custom Rust wiring.

---

## In-App Updater — Frontend Side

### Package
`@tauri-apps/plugin-updater` is the only update dependency needed on the frontend. Import directly:
```ts
import { check, type Update } from "@tauri-apps/plugin-updater";
import { getVersion } from "@tauri-apps/api/app";
```

### No Service Functions or React Query Hooks Needed
There are no `invoke()` wrappers, no `useCheckForUpdateMutation`, and no `useInstallUpdateMutation`. The JS API is called directly inside the `useAppUpdater` hook.

### UI Pattern (`SettingsPage.tsx`)

The `useAppUpdater()` same-file hook drives all update state:

```ts
type UpdateStatus = "idle" | "checking" | "available" | "up-to-date" | "downloading" | "installed" | "error";

function useAppUpdater() {
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [currentVersion, setCurrentVersion] = useState<string>("");
  const [update, setUpdate] = useState<Update | null>(null);
  const [progress, setProgress] = useState(0);
  const [updateError, setUpdateError] = useState<string | null>(null);

  useEffect(() => {
    getVersion().then(setCurrentVersion).catch(() => {});
  }, []);

  async function handleCheck() {
    setStatus("checking");
    setUpdateError(null);
    try {
      const result = await check();
      if (result) {
        setUpdate(result);
        setStatus("available");
      } else {
        setStatus("up-to-date");
      }
    } catch (e) {
      setUpdateError(String(e));
      setStatus("error");
    }
  }

  async function handleInstall() {
    if (!update) return;
    setStatus("downloading");
    setProgress(0);
    try {
      let downloaded = 0;
      let total = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          setProgress(total > 0 ? Math.round((downloaded / total) * 100) : 0);
        } else if (event.event === "Finished") {
          setProgress(100);
          setStatus("installed");
        }
      });
    } catch (e) {
      setUpdateError(String(e));
      setStatus("error");
    }
  }

  return { status, currentVersion, update, progress, updateError, handleCheck, handleInstall };
}
```

Rules:
- Use the `DownloadEvent` discriminated union — `event.event` is `"Started"`, `"Progress"`, or `"Finished"`.
- `event.data.contentLength` may be `undefined` (chunked transfer); guard with `?? 0`.
- After `handleInstall` resolves the app restarts automatically — no navigation or state cleanup needed.
- `status === "installed"` is briefly visible before the restart.
- Never use `listen("update-download-progress", ...)` — progress comes from the `downloadAndInstall` callback, not Tauri events.

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
- **Draft releases break the updater**: `releaseDraft: true` means the release is not public, so `/releases/latest/download/latest.json` returns 404. Always use `releaseDraft: false`.
- **Wrong `.sig` pattern**: NSIS v2 bundles produce `*-setup.exe.sig`. The old v1 pattern `*.nsis.zip.sig` will fail to find the signature file.
- **Adding custom Rust updater commands**: Do not add `check_for_update` or `download_and_install_update` Tauri commands. Use `check()` and `update.downloadAndInstall()` from `@tauri-apps/plugin-updater` directly in the frontend.
- **Using Tauri events for progress**: Do not use `listen("update-download-progress", ...)`. Progress comes from the `downloadAndInstall(callback)` argument — the event approach was the old custom-command pattern.
- **Unsigned bundles in dev**: `check()` will throw in `tauri dev` because no updater endpoint/key is active. Wrap in try/catch and handle gracefully.
- **`installMode: "basicUi"` vs `"passive"`**: `passive` is the right default for desktop; `basicUi` shows the full installer wizard which can confuse users.

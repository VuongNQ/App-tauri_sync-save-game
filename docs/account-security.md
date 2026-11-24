# Phase 2: account security

## Identity and data compatibility

Google OAuth authorizes Drive only. Firestore requests use a separate Firebase
Authentication ID token, exchanged from the same Google access token with
`accounts:signInWithIdp`. Only Firebase endpoints receive that exchange; the
Firestore transport never falls back to Drive OAuth/IAM credentials.

The existing `users/<google-id>`, `userProfiles/<google-id>`, local libraries,
tracker directories, device overrides and Drive folders keep their current IDs.
Rules authorize the Google provider identity in the **verified Firebase token**:
`request.auth.token.firebase.identities['google.com']`. A Firebase UID by itself
or an email address is not a substitute for the Google provider ID. No save,
Firestore document or local library is copied, renamed or deleted by this change.

Firebase response claims are checked for the expected project, issuer, Firebase
UID and Google identity. This local consistency check is not a JWT signature
verifier: the token is obtained over HTTPS directly from Firebase, and Firebase/
Firestore validate the actual credential and signature. It is never accepted
from a caller-supplied Firebase-token IPC payload.

## Protected credentials

Windows stores the complete Google + Firebase session as one encrypted
`oauth-session.dpapi` file in app data. DPAPI uses the current Windows user's
protection context, not machine-wide encryption. Both API refresh paths share
one refresh lock, preventing stale refresh results from overwriting each other.

On first read, a valid legacy `oauth-tokens.json` is encrypted, written and
reopened successfully before the plaintext file is removed. Failed encryption
or write retains the old file; a corrupt protected file never silently falls
back to plaintext. A copy of this ciphertext on another Windows user/device
typically requires signing in again; Windows domain/roaming protection contexts may differ. DPAPI does not protect against malicious processes
already running as the same Windows user. Check any manually made backups of
the old app-data directory separately: this migration does not scan other paths.

A damaged credential file can be removed with **Clear saved sign-in** on the
login screen before reconnecting. This clears credentials, not save files or
library data. Post-write verification failures restore the previous ciphertext.

No plaintext storage fallback exists on Linux/macOS. Those platforms need their
native secure-store adapters before the desktop app can support sign-in there.
The Windows implementation covers Windows PCs and Windows handhelds.

Google/Firebase refresh failures retain the stored session for local/offline
use; failed cloud authorization is reported rather than silently deleting local
credentials or using a different authentication mechanism. Candidate sign-in
verifies the Google account and Firebase project before replacing the previous
protected session. Runtime configuration missing a Firebase key fails closed
for Firestore; new sign-in reports the missing configuration.

## Authorization and administration

- `roles/<google-id>` is the sole role authority. Missing/unreadable roles mean
  `user`. Legacy `userProfiles.role` values do not grant privileges.
- First sign-in always creates a normal user. There is no client-side first-admin
  bootstrap and no directory listing requirement for ordinary sign-in.
- Rules allow users to read/write only their own games, settings, devices and
  sync metadata. Admins can list account profiles and manage roles/quota, but do
  not receive access to other users' game data.
- Client administrators cannot change their own protected role. Profile identity,
  registration and legacy role fields are immutable through self-service updates.
- Rules are enforced for direct REST/SDK requests too. UI route guards and Rust
  `require_admin` are additional checks, not the trust boundary.

## Account isolation

Sign-out and account replacement acquire a write gate and refuse while account
work is active. Captured background jobs and blocking IPC workers acquire a read
lease and check the scheduling account plus session generation before starting.
Queued work from an earlier session is cancelled, even after signing back into
the same Google account. The gate remains held throughout a background task,
including all of its dependent HTTP calls. Watcher registrations/timers reset
when accounts change and are rebuilt after the next library restore. A tracked
running game must exit first so its playtime can be saved.

On the frontend, an account change cancels in-flight queries and clears all
account-specific caches before installing the new auth status. Mutation cache
callbacks also verify their original account; delayed mutation replies cannot
repopulate another account's cache. Account route content remounts on ID changes
to clear component-local state. Role refreshes
for the same account keep its library cache. Rust sign-out succeeds before the
Google plugin is asked to sign out; a busy backend does not clear plugin state.

## Activation on the real project (not performed by this PR)

1. Identify the existing `GOOGLE_CLOUD_PROJECT_ID` used by this repo's releases.
   Enable Firebase Authentication/Google sign-in on **that same project**. Confirm
   the desktop OAuth client is accepted by the provider configuration.
2. Copy that project's Firebase Web API key to the build environment as
   `FIREBASE_WEB_API_KEY`. This is client configuration, not a service-account key.
   Existing Google OAuth credentials remain in their existing build variables.
   The release workflow checks required configuration before publishing.
3. Inspect the live Firestore Rules and IAM policy with a project administrator.
   Remove broad Firestore IAM grants to application end users, `allUsers` or
   `allAuthenticatedUsers` and retire any distributed administrative credentials.
   **Google OAuth/IAM requests can bypass Rules**, so deploying Rules alone does
   not secure legacy clients that still have IAM access. Do not release until
   that audit and access removal are verified.
4. Back up/export the database and record the original Rules/IAM policy. Use a
   staging project first; verify reads/writes with two actual Google accounts.
5. Deploy the reviewed rules manually from the repo root:
   `security/node_modules/.bin/firebase deploy --only firestore:rules --project YOUR_PROJECT`
   Verify the project argument; do not use the demo test project for deployment.
   For a named database (`FIRESTORE_DATABASE_ID`), deploy with
   `--only firestore:DATABASE_ID`; see `docs/firestore-named-database.md`.
6. Sign in once with the intended administrator to create/link its Firebase user.
   On a trusted workstation, configure Application Default Credentials for that
   explicit project. Run the role tool as a **dry run**:
   `node security/bootstrap-admin.mjs --project YOUR_PROJECT --uid FIREBASE_UID --google-id GOOGLE_ID --role admin`
   It checks Auth's Google provider mapping and disabled status. Review the target,
   then repeat with `--apply` to seed only `roles/<google-id>`. Never embed ADC or a
   service-account key in the desktop application, source, or a user-facing file.
   Existing legacy profile admin flags are intentionally not promoted automatically.
7. Build/install the new app, reconnect Google if needed, test directory/admin
   operations and cross-account denials. Upgrade every device. Revoke old OAuth
   grants with the obsolete datastore scope during a controlled reauthentication;
   new sign-ins request only identity and Drive scopes.

This repository has no connection that can read/change this project's live IAM
or Firebase Auth settings. No cloud Rules, IAM, role records, secrets or releases
are changed by preparing or testing the code. The activation checklist is a
release prerequisite, not evidence that the live project is already secured.

## Validation

- `npm run test:auth`: old cache removal, cancelled query results, same-account role refresh.
- `npm ci --prefix security` then `npm test --prefix security`: Rules emulator uses
  only `demo-save-game-sync`; no live Google/Firebase account is accessed.
- `node --test security/admin-policy.test.mjs`: bootstrap dry-run and identity mismatch refusal.
- `cargo test --locked --manifest-path security/rust-tests/Cargo.toml`: production
  identity/storage primitives without desktop libraries, on Linux and Windows.
- `cargo test --locked --lib --manifest-path src-tauri/Cargo.toml`: complete Windows
  library, including real DPAPI round-trip/tamper and session-gate tests.
- Live checks still required: actual Google-to-Firebase OAuth exchange/refresh,
  profile/role CRUD under deployed Rules, pre-upgrade credential migration on a
  real install, account switching during real transfers, and two-device save sync.

## Rollback

Keep the existing data namespaces and database export. A rollback that reads only
plaintext credentials will require Google sign-in again; do not decrypt or restore
plaintext tokens as a shortcut. Keep restrictive Rules/IAM in place: rolling back
security configuration to broad access is not an acceptable compatibility fix.

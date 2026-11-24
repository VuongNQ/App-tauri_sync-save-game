# Moving Firestore to a named database

Firestore cannot rename a database, including `(default)`. To use a different
name you create a new database, copy the data, and build the app against it.

The app reads the database id at **build time** from `FIRESTORE_DATABASE_ID`
(see `src-tauri/build.rs` and `firebase_auth::DATABASE_ID`). Empty or unset means
`(default)`, so builds without the variable behave exactly as before. Ids must be
4-63 lowercase letters, digits or hyphens, start with a letter and not end with a
hyphen; the app refuses to start Firebase calls with an invalid id.

The examples use `savegame` and `PROJECT` for your `GOOGLE_CLOUD_PROJECT_ID`.

## Cost: read this first

Firestore gives **exactly one free database per project**: the first one created.
Your `(default)` database already holds that free quota (50k reads, 20k writes
per day, 1 GiB). A second database is billed from its first read, and creating it
needs the Blaze (pay-as-you-go) plan. Deleting `(default)` later does **not** move
the free quota to an existing database; it goes to the *next database created*.
Managed export/import also needs billing enabled and a Cloud Storage bucket.

So there are two ways to do this:

- **Path A, keep `(default)`** (simplest, old data stays as a fallback, but every
  read and write to `savegame` is billed).
- **Path B, replace `(default)`** (export, delete `(default)`, create `savegame`,
  import). `savegame` becomes the free database. Sync is down between the delete
  and the new release, and `(default)` is gone, so keep the export.

Pick B if staying on the free quota matters.

## Steps

Run these on a machine where `gcloud auth login` and `firebase login` use an
owner/editor of `PROJECT`. Nothing in the app or CI can do this for you.

### 0. Stop writes

Quit the app on every device (tray icon > Quit) so nothing writes to
`(default)` while it is copied. Writes made after the export are not copied.

### 1. Find the current location and make a bucket

```bash
gcloud config set project PROJECT
gcloud firestore databases describe --database='(default)'   # note locationId
gcloud storage buckets create gs://PROJECT-firestore-migrate --location=LOCATION
```

Use the same `LOCATION` as `(default)` (for example `asia-southeast1` or `nam5`).

### 2. Export `(default)`

```bash
gcloud firestore export gs://PROJECT-firestore-migrate/from-default --database='(default)'
```

Wait for it to finish (`gcloud firestore operations list --database='(default)'`).

### 3. (Path B only) Delete `(default)`

Only after the export finished and you can see files in the bucket:

```bash
gcloud firestore databases delete --database='(default)'
```

### 4. Create `savegame`

```bash
gcloud firestore databases create --database=savegame --location=LOCATION --type=firestore-native
```

### 5. Deploy the security rules to it

`firebase.json` lists both `(default)` and `savegame`. Deploy only the new one:

```bash
npm ci --prefix security
security/node_modules/.bin/firebase deploy --only firestore:savegame --project PROJECT
```

For Path B, remove the `(default)` entry from `firebase.json` afterwards so a
plain `--only firestore:rules` deploy does not fail on a missing database.
**Never leave a database without rules deployed**: a new database starts locked
in production mode, but check in the Firebase console that the rules match
`security/firestore.rules`.

### 6. Import

```bash
gcloud firestore import gs://PROJECT-firestore-migrate/from-default --database=savegame
```

This copies everything, including `roles/` (admin) and `config/` documents, so
`security/bootstrap-admin.mjs` does not need to be re-run. If you do need it, pass
`--database savegame`.

### 7. Build and release against `savegame`

```bash
gh variable set FIRESTORE_DATABASE_ID --body savegame --repo VuongNQ/App-tauri_sync-save-game
```

The release workflow passes the repository **variable** (not a secret)
`FIRESTORE_DATABASE_ID` to the build. For local builds add
`FIRESTORE_DATABASE_ID=savegame` to `src-tauri/.env`. Then push a
`release-prod-*` tag as usual and update every device. Old builds keep talking
to `(default)`: on Path A they would write to stale data, on Path B they fail.

### 8. Check

Sign in on one device, open a game, sync, and confirm in the Firebase console
that `users/<googleId>/syncMeta/v2-...` updated in `savegame`, not `(default)`.

## Rollback

Path A: delete the `FIRESTORE_DATABASE_ID` variable and release again; the app
goes back to `(default)`. Anything written to `savegame` meanwhile is not in
`(default)` unless you export/import it back.

Path B: create `(default)` again, import the export (or a fresh export of
`savegame`), and release without the variable.

## Tests

`security/rules.test.mjs` loads the same rules into an emulated `savegame`
database and checks that owner isolation holds there too.

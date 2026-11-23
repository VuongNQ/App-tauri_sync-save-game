//! Deterministic adapters for integration tests of the production orchestrator.
#![allow(dead_code)]
use crate::{models::*, sync_v2::Manifest};
use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};

#[derive(Default)]
pub struct Cloud {
    manifest: Option<(Manifest, String)>,
    sequence: u64,
    blobs: BTreeMap<String, (String, String, Vec<u8>)>,
    folders: BTreeMap<(String, String), String>,
    fail_commit: bool,
    fail_download: bool,
    corrupt_download: bool,
    http_responses: std::collections::VecDeque<Result<(u16, String), String>>,
    http_requests: Vec<(String, String, String)>,
}
#[derive(Clone)]
pub struct AppHandle {
    root: PathBuf,
    state: Arc<Mutex<StoredState>>,
    cloud: Arc<Mutex<Cloud>>,
}
pub struct AppPath(PathBuf);
impl AppPath {
    pub fn app_data_dir(&self) -> Result<PathBuf, String> {
        Ok(self.0.clone())
    }
}
pub trait Manager {
    fn path(&self) -> AppPath;
}
impl Manager for AppHandle {
    fn path(&self) -> AppPath {
        AppPath(self.root.clone())
    }
}

pub mod watcher {
    pub fn ensure_game_stopped(_: &super::AppHandle, _: &str) -> Result<(), String> {
        Ok(())
    }
}
pub mod gdrive_auth {
    pub fn get_current_user_id(_: &super::AppHandle) -> Option<String> {
        Some("111111111111111111111".into())
    }
}
pub mod settings {
    use super::*;
    pub fn load_state(app: &AppHandle) -> Result<StoredState, String> {
        Ok(app.state.lock().unwrap().clone())
    }
    pub fn find_game<'a>(state: &'a StoredState, id: &str) -> Result<&'a GameEntry, String> {
        state
            .games
            .iter()
            .find(|g| g.id == id)
            .ok_or("Unknown game".into())
    }
    pub fn effective_save_paths(game: &GameEntry, _: &AppSettings) -> Vec<Option<String>> {
        game.save_paths.iter().map(|p| p.path.clone()).collect()
    }
    pub fn expand_env_vars(path: &str) -> String {
        path.into()
    }
    pub fn update_game_field(
        app: &AppHandle,
        id: &str,
        update: impl FnOnce(&mut GameEntry),
    ) -> Result<(), String> {
        let mut state = app.state.lock().unwrap();
        update(state.games.iter_mut().find(|g| g.id == id).unwrap());
        Ok(())
    }
}
pub mod firestore {
    use super::*;
    pub fn load_v2_manifest(
        app: &AppHandle,
        _: &str,
        _: &str,
    ) -> Result<Option<(Manifest, String)>, String> {
        Ok(app.cloud.lock().unwrap().manifest.clone())
    }
    pub fn commit_v2_manifest(
        app: &AppHandle,
        _: &str,
        _: &str,
        expected: Option<&str>,
        manifest: &Manifest,
    ) -> Result<(), String> {
        let mut cloud = app.cloud.lock().unwrap();
        if cloud.fail_commit {
            cloud.fail_commit = false;
            return Err("SAVE_CONFLICT: concurrent publication".into());
        }
        if expected != cloud.manifest.as_ref().map(|(_, v)| v.as_str()) {
            return Err("SAVE_CONFLICT: stale updateTime".into());
        }
        cloud.sequence += 1;
        let version = cloud.sequence.to_string();
        cloud.manifest = Some((manifest.clone(), version));
        Ok(())
    }
    pub fn load_admin_config(_: &AppHandle) -> Result<AdminConfig, String> {
        Ok(AdminConfig {
            drive_quota_bytes: 1_000_000,
        })
    }
}
pub mod firestore_http {
    use super::*;
    fn request(
        app: &AppHandle,
        method: &str,
        url: &str,
        body: &str,
    ) -> Result<(u16, String), String> {
        let mut cloud = app.cloud.lock().unwrap();
        cloud
            .http_requests
            .push((method.into(), url.into(), body.into()));
        cloud
            .http_responses
            .pop_front()
            .unwrap_or(Err("No mocked HTTP response".into()))
    }
    pub fn authed_get(app: &AppHandle, url: &str) -> Result<(u16, String), String> {
        request(app, "GET", url, "")
    }
    pub fn authed_delete(app: &AppHandle, url: &str) -> Result<(u16, String), String> {
        request(app, "DELETE", url, "")
    }
    pub fn authed_post_json(
        app: &AppHandle,
        url: &str,
        body: &str,
    ) -> Result<(u16, String), String> {
        request(app, "POST", url, body)
    }
    pub fn authed_patch_json(
        app: &AppHandle,
        url: &str,
        body: &str,
    ) -> Result<(u16, String), String> {
        request(app, "PATCH", url, body)
    }
}
pub mod gdrive {
    use super::*;
    use std::path::Path;
    pub fn ensure_game_folders(_: &AppHandle, _: &str) -> Result<(String, String), String> {
        Ok(("root".into(), "game-folder".into()))
    }
    pub fn ensure_subfolder(app: &AppHandle, parent: &str, name: &str) -> Result<String, String> {
        let mut cloud = app.cloud.lock().unwrap();
        let key = (parent.into(), name.into());
        if let Some(id) = cloud.folders.get(&key) {
            return Ok(id.clone());
        }
        cloud.sequence += 1;
        let id = format!("folder-{}", cloud.sequence);
        cloud.folders.insert(key, id.clone());
        Ok(id)
    }
    pub fn list_drive_items(app: &AppHandle, folder: &str) -> Result<Vec<DriveFileItem>, String> {
        let cloud = app.cloud.lock().unwrap();
        let mut result = vec![];
        for ((parent, name), id) in &cloud.folders {
            if parent == folder {
                result.push(DriveFileItem {
                    id: id.clone(),
                    name: name.clone(),
                    mime_type: "application/vnd.google-apps.folder".into(),
                    size: None,
                    modified_time: None,
                    is_folder: true,
                });
            }
        }
        for (id, (parent, name, bytes)) in &cloud.blobs {
            if parent == folder {
                result.push(DriveFileItem {
                    id: id.clone(),
                    name: name.clone(),
                    mime_type: "application/octet-stream".into(),
                    size: Some(bytes.len() as u64),
                    modified_time: None,
                    is_folder: false,
                });
            }
        }
        Ok(result)
    }
    pub fn download_sync_meta(
        app: &AppHandle,
        folder: &str,
    ) -> Result<(Option<SyncMeta>, Option<String>), String> {
        let cloud = app.cloud.lock().unwrap();
        if let Some((id, (_, _, data))) = cloud
            .blobs
            .iter()
            .find(|(_, (parent, name, _))| parent == folder && name == ".sync-meta.json")
        {
            return Ok((
                Some(serde_json::from_slice(data).map_err(|e| e.to_string())?),
                Some(id.clone()),
            ));
        }
        Ok((None, None))
    }
    pub fn download_file(app: &AppHandle, id: &str, target: &Path) -> Result<(), String> {
        let cloud = app.cloud.lock().unwrap();
        if cloud.fail_download {
            return Err("Interrupted download".into());
        }
        let mut bytes = cloud.blobs.get(id).ok_or("Unknown Drive object")?.2.clone();
        if cloud.corrupt_download {
            bytes.push(0);
        }
        crate::safe_files::atomic_write(target, &bytes)
    }
    pub fn upload_file(
        app: &AppHandle,
        folder: &str,
        path: &Path,
        existing: Option<&str>,
    ) -> Result<DriveFile, String> {
        assert!(existing.is_none(), "Versioned saves must be immutable");
        let data = fs::read(path).map_err(|e| e.to_string())?;
        let id = upload_json_to_folder(
            app,
            folder,
            path.file_name().unwrap().to_str().unwrap(),
            &data,
            None,
        )?;
        Ok(DriveFile {
            id,
            name: String::new(),
            modified_time: None,
            size: Some(data.len() as u64),
        })
    }
    pub fn upload_json_to_folder(
        app: &AppHandle,
        folder: &str,
        name: &str,
        bytes: &[u8],
        _: Option<&str>,
    ) -> Result<String, String> {
        let mut cloud = app.cloud.lock().unwrap();
        cloud.sequence += 1;
        let id = format!("blob-{}", cloud.sequence);
        cloud
            .blobs
            .insert(id.clone(), (folder.into(), name.into(), bytes.into()));
        Ok(id)
    }
    pub fn download_json_from_drive(app: &AppHandle, id: &str) -> Result<String, String> {
        String::from_utf8(
            app.cloud
                .lock()
                .unwrap()
                .blobs
                .get(id)
                .ok_or("Missing object")?
                .2
                .clone(),
        )
        .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        cross_device as sync,
        sync_v2::{self, Mode},
    };

    #[test]
    fn explicit_restore_can_recreate_a_missing_save_folder() {
        let d = Devices::new();
        Devices::write(&d.a, 0, "nested/slot", b"original");
        sync::execute(&d.a, "game-a", Mode::Merge).unwrap();
        fs::remove_dir_all(
            Devices::file(&d.a, 0, "nested/slot")
                .parent()
                .unwrap()
                .parent()
                .unwrap(),
        )
        .unwrap();
        assert!(sync::execute(&d.a, "game-a", Mode::Merge).is_err());
        sync::execute(&d.a, "game-a", Mode::Restore).unwrap();
        assert_eq!(
            fs::read(Devices::file(&d.a, 0, "nested/slot")).unwrap(),
            b"original"
        );
    }

    #[test]
    fn another_app_process_cannot_enter_the_same_game_transaction() {
        let d = Devices::new();
        Devices::write(&d.a, 0, "slot", b"original");
        let store =
            d.a.root
                .join("sync-v2")
                .join(sync_v2::hash_bytes(b"111111111111111111111"))
                .join(sync_v2::hash_bytes(b"game-a"));
        fs::create_dir_all(&store).unwrap();
        let lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(store.join("operation.lock"))
            .unwrap();
        lock.try_lock().unwrap();
        assert!(sync::execute(&d.a, "game-a", Mode::Merge)
            .unwrap_err()
            .contains("another app process"));
        assert!(d.a.cloud.lock().unwrap().manifest.is_none());
    }
    struct Devices {
        a: AppHandle,
        b: AppHandle,
        root: PathBuf,
    }
    impl Devices {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("two-device-sync-{:016x}", fastrand::u64(..)));
            let cloud = Arc::new(Mutex::new(Cloud::default()));
            let device = |name: &str| {
                let dir = root.join(name);
                fs::create_dir_all(&dir).unwrap();
                let game: GameEntry = serde_json::from_value(serde_json::json!({"id":"game-a", "name":"Game", "description":null, "thumbnail":null, "source":"manual", "trackChanges":false, "autoSync":false, "lastLocalModified":null, "lastCloudModified":null, "gdriveFolderId":"game-folder", "savePaths":[{"label":"Cards", "path":dir.join("cards")}, {"label":"States", "path":dir.join("states")}]})).unwrap();
                AppHandle {
                    root: dir.join("app-data"),
                    state: Arc::new(Mutex::new(StoredState {
                        games: vec![game],
                        ..Default::default()
                    })),
                    cloud: cloud.clone(),
                }
            };
            let a = device("pc");
            let b = device("handheld");
            Self { a, b, root }
        }
        fn file(app: &AppHandle, path: usize, name: &str) -> PathBuf {
            PathBuf::from(
                app.state.lock().unwrap().games[0].save_paths[path]
                    .path
                    .as_ref()
                    .unwrap(),
            )
            .join(name)
        }
        fn write(app: &AppHandle, path: usize, name: &str, data: &[u8]) {
            let p = Self::file(app, path, name);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, data).unwrap();
        }
    }
    impl Drop for Devices {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    #[test]
    fn pc_handheld_pc_round_trip_with_nested_multi_path_saves() {
        let d = Devices::new();
        Devices::write(&d.a, 0, "nested/slot.sav", b"card-A");
        Devices::write(&d.a, 1, "slot.sav", b"state-A");
        sync::execute(&d.a, "game-a", Mode::Merge).unwrap();
        sync::execute(&d.b, "game-a", Mode::Merge).unwrap();
        assert_eq!(
            fs::read(Devices::file(&d.b, 0, "nested/slot.sav")).unwrap(),
            b"card-A"
        );
        Devices::write(&d.b, 0, "nested/slot.sav", b"card-B");
        sync::execute(&d.b, "game-a", Mode::Merge).unwrap();
        sync::execute(&d.a, "game-a", Mode::Merge).unwrap();
        assert_eq!(
            fs::read(Devices::file(&d.a, 0, "nested/slot.sav")).unwrap(),
            b"card-B"
        );
        assert_eq!(
            fs::read(Devices::file(&d.a, 1, "slot.sav")).unwrap(),
            b"state-A"
        );
    }
    #[test]
    fn concurrent_edits_keep_both_and_require_explicit_resolution() {
        let d = Devices::new();
        Devices::write(&d.a, 0, "slot", b"old");
        sync::execute(&d.a, "game-a", Mode::Merge).unwrap();
        sync::execute(&d.b, "game-a", Mode::Merge).unwrap();
        Devices::write(&d.a, 0, "slot", b"AAA");
        Devices::write(&d.b, 0, "slot", b"BBB");
        sync::execute(&d.a, "game-a", Mode::Merge).unwrap();
        assert!(sync::execute(&d.b, "game-a", Mode::Merge)
            .unwrap_err()
            .starts_with("SAVE_CONFLICT"));
        assert_eq!(fs::read(Devices::file(&d.b, 0, "slot")).unwrap(), b"BBB");
        sync::execute(&d.b, "game-a", Mode::Restore).unwrap();
        assert_eq!(fs::read(Devices::file(&d.b, 0, "slot")).unwrap(), b"AAA");
    }
    #[test]
    fn deleted_files_do_not_resurrect_and_recreation_is_explicit() {
        let d = Devices::new();
        Devices::write(&d.a, 0, "slot", b"old");
        sync::execute(&d.a, "game-a", Mode::Merge).unwrap();
        sync::execute(&d.b, "game-a", Mode::Merge).unwrap();
        fs::remove_file(Devices::file(&d.a, 0, "slot")).unwrap();
        sync::execute(&d.a, "game-a", Mode::Merge).unwrap();
        sync::execute(&d.b, "game-a", Mode::Merge).unwrap();
        assert!(!Devices::file(&d.b, 0, "slot").exists());
        Devices::write(&d.b, 0, "slot", b"new");
        sync::execute(&d.b, "game-a", Mode::Merge).unwrap();
        sync::execute(&d.a, "game-a", Mode::Merge).unwrap();
        assert_eq!(fs::read(Devices::file(&d.a, 0, "slot")).unwrap(), b"new");
    }
    #[test]
    fn cas_failure_never_replaces_local_saves_or_baseline() {
        let d = Devices::new();
        Devices::write(&d.a, 0, "slot", b"old");
        sync::execute(&d.a, "game-a", Mode::Merge).unwrap();
        sync::execute(&d.b, "game-a", Mode::Merge).unwrap();
        Devices::write(&d.a, 0, "slot", b"new");
        sync::execute(&d.a, "game-a", Mode::Merge).unwrap();
        d.a.cloud.lock().unwrap().fail_commit = true;
        assert!(sync::execute(&d.b, "game-a", Mode::Merge).is_err());
        assert_eq!(fs::read(Devices::file(&d.b, 0, "slot")).unwrap(), b"old");
        sync::execute(&d.b, "game-a", Mode::Merge).unwrap();
        assert_eq!(fs::read(Devices::file(&d.b, 0, "slot")).unwrap(), b"new");
    }
    #[test]
    fn corrupt_download_leaves_all_paths_unchanged() {
        let d = Devices::new();
        Devices::write(&d.a, 0, "slot", b"old");
        Devices::write(&d.a, 1, "slot", b"state");
        sync::execute(&d.a, "game-a", Mode::Merge).unwrap();
        sync::execute(&d.b, "game-a", Mode::Merge).unwrap();
        Devices::write(&d.a, 0, "slot", b"new");
        Devices::write(&d.a, 1, "slot", b"new-state");
        sync::execute(&d.a, "game-a", Mode::Merge).unwrap();
        d.a.cloud.lock().unwrap().corrupt_download = true;
        assert!(sync::execute(&d.b, "game-a", Mode::Merge).is_err());
        assert_eq!(fs::read(Devices::file(&d.b, 0, "slot")).unwrap(), b"old");
        assert_eq!(fs::read(Devices::file(&d.b, 1, "slot")).unwrap(), b"state");
    }
    #[test]
    fn full_snapshot_restore_recovers_nested_files_in_every_path() {
        let d = Devices::new();
        Devices::write(&d.a, 0, "nested/slot", b"old-card");
        Devices::write(&d.a, 1, "slot", b"old-state");
        sync::execute(&d.a, "game-a", Mode::Merge).unwrap();
        let snapshot = sync::create_backup(&d.a, "game-a", Some("boss".into())).unwrap();
        assert_eq!(snapshot.total_files, 2);
        Devices::write(&d.a, 0, "nested/slot", b"new-card");
        Devices::write(&d.a, 1, "slot", b"new-state");
        Devices::write(&d.a, 1, "extra", b"extra");
        sync::execute(&d.a, "game-a", Mode::Merge).unwrap();
        sync::restore_backup(&d.a, "game-a", &snapshot.id)
            .unwrap()
            .unwrap();
        assert_eq!(
            fs::read(Devices::file(&d.a, 0, "nested/slot")).unwrap(),
            b"old-card"
        );
        assert_eq!(
            fs::read(Devices::file(&d.a, 1, "slot")).unwrap(),
            b"old-state"
        );
        assert!(!Devices::file(&d.a, 1, "extra").exists());
    }
    #[test]
    fn changed_root_is_not_interpreted_as_mass_deletion() {
        let d = Devices::new();
        Devices::write(&d.a, 0, "slot", b"old");
        sync::execute(&d.a, "game-a", Mode::Merge).unwrap();
        d.a.state.lock().unwrap().games[0].save_paths[0].path =
            Some(d.root.join("new-cards").to_string_lossy().into());
        sync::execute(&d.a, "game-a", Mode::Merge).unwrap();
        assert_eq!(fs::read(Devices::file(&d.a, 0, "slot")).unwrap(), b"old");
    }
    #[test]
    fn disappearing_drive_or_folder_does_not_publish_deletions() {
        let d = Devices::new();
        Devices::write(&d.a, 0, "slot", b"old");
        sync::execute(&d.a, "game-a", Mode::Merge).unwrap();
        fs::remove_dir_all(Devices::file(&d.a, 0, "slot").parent().unwrap()).unwrap();
        assert!(sync::execute(&d.a, "game-a", Mode::Merge).is_err());
        assert!(!d.a.cloud.lock().unwrap().manifest.as_ref().unwrap().0.files[0].deleted);
    }
    #[test]
    fn explicit_cloud_delete_preserves_object_for_snapshot_recovery() {
        let d = Devices::new();
        Devices::write(&d.a, 0, "slot", b"old");
        sync::execute(&d.a, "game-a", Mode::Merge).unwrap();
        let id = d.a.cloud.lock().unwrap().manifest.as_ref().unwrap().0.files[0]
            .object_id
            .clone()
            .unwrap();
        assert!(sync::delete_file(&d.a, "game-a", &id).unwrap());
        assert!(d.a.cloud.lock().unwrap().blobs.contains_key(&id));
        sync::execute(&d.a, "game-a", Mode::Merge).unwrap();
        assert!(!Devices::file(&d.a, 0, "slot").exists());
    }
    #[test]
    fn legacy_bytes_are_hashed_and_copied_before_v2_publication() {
        let d = Devices::new();
        let id =
            gdrive::upload_json_to_folder(&d.a, "game-folder", "slot", b"legacy", None).unwrap();
        let meta = SyncMeta {
            last_synced: None,
            files: vec![SyncFileEntry {
                path_file: "nested/slot".into(),
                size: 999,
                drive_file_id: Some(id.clone()),
                modified_time: Some("future-clock".into()),
            }],
        };
        gdrive::upload_json_to_folder(
            &d.a,
            "game-folder",
            ".sync-meta.json",
            &serde_json::to_vec(&meta).unwrap(),
            None,
        )
        .unwrap();
        sync::execute(&d.b, "game-a", Mode::Merge).unwrap();
        let cloud = d.a.cloud.lock().unwrap();
        let entry = &cloud.manifest.as_ref().unwrap().0.files[0];
        assert_eq!(
            entry.hash.as_deref(),
            Some(sync_v2::hash_bytes(b"legacy").as_str())
        );
        assert_ne!(entry.object_id.as_ref(), Some(&id));
        assert_eq!(
            fs::read(Devices::file(&d.b, 0, "nested/slot")).unwrap(),
            b"legacy"
        );
    }
    #[test]
    fn disjoint_edits_do_not_mix_incompatible_save_sets() {
        let d = Devices::new();
        Devices::write(&d.a, 0, "card", b"old");
        Devices::write(&d.a, 1, "state", b"old");
        sync::execute(&d.a, "game-a", Mode::Merge).unwrap();
        sync::execute(&d.b, "game-a", Mode::Merge).unwrap();
        Devices::write(&d.a, 0, "card", b"AAA");
        Devices::write(&d.b, 1, "state", b"BBB");
        sync::execute(&d.a, "game-a", Mode::Merge).unwrap();
        assert!(sync::execute(&d.b, "game-a", Mode::Merge)
            .unwrap_err()
            .starts_with("SAVE_CONFLICT"));
        let diff = sync::diff(&d.b, "game-a").unwrap();
        assert_eq!(diff.conflict_files.len(), 2);
    }
    #[test]
    fn excluded_paths_are_kept_until_explicit_cleanup() {
        let d = Devices::new();
        Devices::write(&d.a, 0, "card", b"card");
        Devices::write(&d.a, 0, "other", b"other");
        sync::execute(&d.a, "game-a", Mode::Merge).unwrap();
        d.a.state.lock().unwrap().games[0].save_paths[0].sync_includes = vec!["card".into()];
        sync::execute(&d.a, "game-a", Mode::Merge).unwrap();
        assert_eq!(
            d.a.cloud
                .lock()
                .unwrap()
                .manifest
                .as_ref()
                .unwrap()
                .0
                .files
                .iter()
                .filter(|e| !e.deleted)
                .count(),
            2
        );
        assert_eq!(sync::clean_excluded(&d.a, "game-a").unwrap(), 1);
        assert!(Devices::file(&d.a, 0, "other").exists());
    }
    #[test]
    fn protocol_transport_uses_server_cas_and_handles_ambiguous_success() {
        let d = Devices::new();
        let manifest = Manifest {
            protocol: 2,
            game_id: "game-a".into(),
            revision: 1,
            commit_id: "operation-1".into(),
            path_labels: vec!["Cards".into(), "States".into()],
            files: vec![],
        };
        d.a.cloud
            .lock()
            .unwrap()
            .http_responses
            .push_back(Ok((200, "{}".into())));
        crate::production_firestore::commit_v2_manifest(
            &d.a,
            "111",
            "game-a",
            Some("2026-01-01T00:00:00Z"),
            &manifest,
        )
        .unwrap();
        let mut cloud = d.a.cloud.lock().unwrap();
        let request = cloud.http_requests.last().unwrap();
        assert_eq!(request.0, "POST");
        assert!(request.1.ends_with("documents:commit"));
        let body: serde_json::Value = serde_json::from_str(&request.2).unwrap();
        assert_eq!(
            body["writes"][0]["currentDocument"]["updateTime"],
            "2026-01-01T00:00:00Z"
        );
        cloud.http_responses.push_back(Err("Response lost".into()));
        cloud.http_responses.push_back(Ok((200,serde_json::json!({"fields":{"data":{"stringValue":serde_json::to_string(&manifest).unwrap()}},"updateTime":"new-server-version"}).to_string())));
        drop(cloud);
        crate::production_firestore::commit_v2_manifest(&d.a, "111", "game-a", None, &manifest)
            .unwrap();
    }
    #[test]
    fn protocol_transport_maps_stale_version_to_conflict_without_retry() {
        let d = Devices::new();
        let manifest = Manifest {
            protocol: 2,
            game_id: "game-a".into(),
            revision: 1,
            commit_id: "operation-1".into(),
            path_labels: vec![],
            files: vec![],
        };
        d.a.cloud.lock().unwrap().http_responses.push_back(Ok((
            400,
            r#"{"error":{"status":"FAILED_PRECONDITION"}}"#.into(),
        )));
        let error = crate::production_firestore::commit_v2_manifest(
            &d.a,
            "111",
            "game-a",
            Some("old-version"),
            &manifest,
        )
        .unwrap_err();
        assert!(error.starts_with("SAVE_CONFLICT"));
        assert_eq!(d.a.cloud.lock().unwrap().http_requests.len(), 1);
    }
}

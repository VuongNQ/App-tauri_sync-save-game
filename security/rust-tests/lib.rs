#![allow(dead_code)]
// Compile the production primitives directly, without Tauri/GTK or live credentials.
#[path = "../../src-tauri/src/auth_identity.rs"]
mod auth_identity;
#[path = "../../src-tauri/src/safe_files.rs"]
mod safe_files;
#[path = "../../src-tauri/src/save_transaction.rs"]
mod save_transaction;
#[path = "../../src-tauri/src/secret_store.rs"]
mod secret_store;
#[path = "../../src-tauri/src/sync_v2.rs"]
mod sync_v2;

// Compile and exercise the real orchestration with deterministic cloud/desktop
// adapters. The production planner and filesystem transaction are not mocked.
#[cfg(test)]
extern crate self as tauri;
#[cfg(test)]
mod v2_harness;
#[cfg(test)]
use v2_harness::{firestore, firestore_http, gdrive, gdrive_auth, settings, watcher};
#[cfg(test)]
pub use v2_harness::{AppHandle, Manager};
#[cfg(test)]
#[path = "../../src-tauri/src/cross_device.rs"]
mod cross_device;
#[cfg(test)]
#[path = "../../src-tauri/src/models.rs"]
mod models;
#[cfg(test)]
#[path = "../../src-tauri/src/firestore.rs"]
mod production_firestore;

// Compile the production primitives directly, without Tauri/GTK or live credentials.
#[path = "../../src-tauri/src/safe_files.rs"]
mod safe_files;
#[path = "../../src-tauri/src/secret_store.rs"]
mod secret_store;
#[path = "../../src-tauri/src/auth_identity.rs"]
mod auth_identity;

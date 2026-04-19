/// Device management — collects local system information, generates a stable
/// device UUID from the Windows MachineGuid registry value, and syncs the
/// device record to Firestore at `users/{user_id}/devices/{device_id}`.

use chrono::Utc;
use tauri::AppHandle;

use crate::{
    firestore,
    gdrive_auth,
    models::DeviceInfo,
};

// ── Device ID ─────────────────────────────────────────────

/// Return a deterministic UUID string for the current machine derived by
/// SHA-256 hashing the Windows `MachineGuid` registry value and taking
/// the first 16 bytes formatted as `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`.
///
/// Returns `None` on non-Windows platforms or when the registry value cannot
/// be read (e.g. insufficient permissions).
#[cfg(target_os = "windows")]
pub fn get_machine_device_id() -> Option<String> {
    use sha2::{Digest, Sha256};
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;

    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let crypto = hklm
        .open_subkey("SOFTWARE\\Microsoft\\Cryptography")
        .ok()?;
    let machine_guid: String = crypto.get_value("MachineGuid").ok()?;

    let mut hasher = Sha256::new();
    hasher.update(machine_guid.as_bytes());
    let hash = hasher.finalize();

    // Use first 16 bytes to construct a UUID-like string.
    let b = &hash[..16];
    let uuid = format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        b[0], b[1], b[2], b[3],
        b[4], b[5],
        b[6], b[7],
        b[8], b[9],
        b[10], b[11], b[12], b[13], b[14], b[15],
    );
    Some(uuid)
}

#[cfg(not(target_os = "windows"))]
pub fn get_machine_device_id() -> Option<String> {
    None
}

// ── System info collection ────────────────────────────────

/// Collect system information for the current machine.
/// Preserves `registered_at` from Firestore if the device was previously
/// registered; otherwise sets it to the current UTC timestamp.
fn collect_device_info(app: &AppHandle, user_id: &str) -> Result<DeviceInfo, String> {
    use sysinfo::{CpuRefreshKind, MemoryRefreshKind, RefreshKind, System};

    let device_id = get_machine_device_id()
        .ok_or_else(|| "Unable to determine device ID on this platform".to_string())?;

    // Refresh only what we need — memory + CPU list (for brand + core count).
    let mut sys = System::new_with_specifics(
        RefreshKind::new()
            .with_memory(MemoryRefreshKind::everything())
            .with_cpu(CpuRefreshKind::everything()),
    );
    // A brief sleep allows sysinfo to populate CPU frequencies / brand on first poll.
    // We use std::thread::sleep to avoid blocking the async runtime.
    std::thread::sleep(std::time::Duration::from_millis(200));
    sys.refresh_cpu_list(CpuRefreshKind::everything());

    let hostname = System::host_name().unwrap_or_else(|| "Unknown".into());
    let os_name = System::name().unwrap_or_else(|| "Windows".into());
    let os_version = System::os_version().unwrap_or_else(|| "Unknown".into());

    let (cpu_name, cpu_cores) = if let Some(cpu) = sys.cpus().first() {
        (cpu.brand().to_string(), sys.cpus().len() as u32)
    } else {
        ("Unknown".into(), 0u32)
    };

    // Convert bytes → MB for RAM.
    let total_ram_mb = sys.total_memory() / (1024 * 1024);

    let now_iso = Utc::now().to_rfc3339();

    // Preserve registered_at if the device already exists in Firestore.
    let registered_at = firestore::load_device(app, user_id, &device_id)
        .ok()
        .flatten()
        .map(|d| d.registered_at)
        .unwrap_or_else(|| now_iso.clone());

    Ok(DeviceInfo {
        id: device_id,
        name: hostname.clone(), // initially equal to hostname; user can rename later
        hostname,
        os_name,
        os_version,
        cpu_name,
        cpu_cores,
        total_ram_mb,
        registered_at,
        last_seen_at: now_iso,
        is_current: false, // never stored; computed at query time
        // path overrides are not part of collect_device_info — they live in AppSettings
        // and are written to Firestore separately via save_device_path_overrides.
        path_overrides: std::collections::HashMap::new(),
        path_overrides_indexed: std::collections::HashMap::new(),
    })
}

// ── Public API ────────────────────────────────────────────

/// Upsert the current device's info into Firestore.
/// Call this from a background `std::thread::spawn` — it performs blocking HTTP.
pub fn register_current_device(app: &AppHandle) {
    let user_id = match gdrive_auth::get_current_user_id(app) {
        Some(id) => id,
        None => {
            println!("[devices] Skipping registration — no authenticated user");
            return;
        }
    };

    match collect_device_info(app, &user_id) {
        Ok(device) => match firestore::save_device(app, &user_id, &device) {
            Ok(_) => println!("[devices] Registered device '{}' for user {user_id}", device.id),
            Err(e) => eprintln!("[devices] Failed to save device to Firestore: {e}"),
        },
        Err(e) => eprintln!("[devices] Failed to collect device info: {e}"),
    }
}

// ── Tauri command handlers ────────────────────────────────

/// Load all devices for the authenticated user, marking the current device.
pub fn get_devices_cmd(app: &AppHandle) -> Result<Vec<DeviceInfo>, String> {
    let user_id = gdrive_auth::get_current_user_id(app)
        .ok_or_else(|| "Not authenticated".to_string())?;

    let current_id = get_machine_device_id();

    let mut devices = firestore::load_all_devices(app, &user_id)?;

    // Mark the device running this instance.
    if let Some(ref cid) = current_id {
        for d in devices.iter_mut() {
            d.is_current = &d.id == cid;
        }
    }

    // Sort: current device first, then by last_seen_at descending.
    devices.sort_by(|a, b| {
        b.is_current
            .cmp(&a.is_current)
            .then_with(|| b.last_seen_at.cmp(&a.last_seen_at))
    });

    Ok(devices)
}

/// Rename a device. Returns the updated device list (current device marked).
pub fn rename_device_cmd(
    app: &AppHandle,
    device_id: String,
    name: String,
) -> Result<Vec<DeviceInfo>, String> {
    let user_id = gdrive_auth::get_current_user_id(app)
        .ok_or_else(|| "Not authenticated".to_string())?;

    let mut device = firestore::load_device(app, &user_id, &device_id)?
        .ok_or_else(|| format!("Device '{device_id}' not found"))?;

    device.name = name;
    firestore::save_device(app, &user_id, &device)?;

    get_devices_cmd(app)
}

/// Remove a device from the user's registered device list.
/// Returns the updated device list. Refuses to remove the current device.
pub fn remove_device_cmd(app: &AppHandle, device_id: String) -> Result<Vec<DeviceInfo>, String> {
    let user_id = gdrive_auth::get_current_user_id(app)
        .ok_or_else(|| "Not authenticated".to_string())?;

    // Guard: cannot remove the device you are currently running on.
    if let Some(current_id) = get_machine_device_id() {
        if current_id == device_id {
            return Err("Cannot remove the device you are currently using".into());
        }
    }

    firestore::delete_device(app, &user_id, &device_id)?;
    get_devices_cmd(app)
}

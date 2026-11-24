//! Power-source check used to keep background transfers off battery.

/// True only when Windows reports the device is running on battery.
/// Unknown status and desktop PCs count as plugged in.
#[cfg(windows)]
pub fn on_battery() -> bool {
    use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    // SAFETY: GetSystemPowerStatus only writes into the struct we pass.
    unsafe {
        let mut status: SYSTEM_POWER_STATUS = std::mem::zeroed();
        GetSystemPowerStatus(&mut status) != 0 && status.ACLineStatus == 0
    }
}

#[cfg(not(windows))]
pub fn on_battery() -> bool {
    false
}

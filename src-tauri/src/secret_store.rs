//! OS-protected token files. Windows DPAPI binds ciphertext to the current OS user.
//! Other platforms fail closed until their native keystore adapter is implemented.
use serde::{de::DeserializeOwned, Serialize};
use std::{fs, io::ErrorKind, path::Path};

const HEADER: &[u8] = b"SAVE-SYNC-DPAPI-1\0";

pub fn load<T: DeserializeOwned + Serialize>(
    path: &Path,
    legacy: Option<&Path>,
) -> Result<Option<T>, String> {
    load_with(path, legacy, protect, unprotect)
}

pub fn save<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|_| "Cannot serialize credentials")?;
    write_with(path, &bytes, protect, unprotect)
}

pub fn delete(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Cannot remove stored credentials".into()),
    }
}

fn load_with<T: DeserializeOwned + Serialize>(
    path: &Path,
    legacy: Option<&Path>,
    seal: impl Fn(&[u8]) -> Result<Vec<u8>, String>,
    open: impl Fn(&[u8]) -> Result<Vec<u8>, String>,
) -> Result<Option<T>, String> {
    match fs::read(path) {
        Ok(bytes) => {
            let payload = bytes
                .strip_prefix(HEADER)
                .ok_or("Unsupported credential format; sign in again")?;
            let plain = open(payload)?;
            let value = serde_json::from_slice(&plain)
                .map_err(|_| "Stored credentials are invalid; sign in again")?;
            // A previous cleanup failure must not leave a plaintext credential behind.
            if let Some(old) = legacy {
                delete(old)?;
            }
            Ok(Some(value))
        }
        Err(e) if e.kind() == ErrorKind::NotFound => {
            let Some(old) = legacy else { return Ok(None) };
            let plain = match fs::read(old) {
                Ok(v) => v,
                Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
                Err(_) => return Err("Cannot read legacy credentials".into()),
            };
            let value: T = serde_json::from_slice(&plain)
                .map_err(|_| "Legacy credentials are invalid; sign in again")?;
            // Verify ciphertext can be reopened before removing the only old copy.
            write_with(path, &plain, seal, open)?;
            delete(old)?;
            Ok(Some(value))
        }
        Err(_) => Err("Cannot read protected credentials".into()),
    }
}

fn write_with(
    path: &Path,
    plain: &[u8],
    seal: impl Fn(&[u8]) -> Result<Vec<u8>, String>,
    open: impl Fn(&[u8]) -> Result<Vec<u8>, String>,
) -> Result<(), String> {
    let encrypted = seal(plain)?;
    if open(&encrypted)? != plain {
        return Err("Credential encryption verification failed".into());
    }
    let mut bytes = HEADER.to_vec();
    bytes.extend_from_slice(&encrypted);
    crate::safe_files::atomic_write(path, &bytes)?;
    let stored = fs::read(path).map_err(|_| "Cannot verify saved credentials")?;
    if open(
        stored
            .strip_prefix(HEADER)
            .ok_or("Cannot verify credential format")?,
    )? != plain
    {
        return Err("Saved credentials could not be reopened".into());
    }
    Ok(())
}

#[cfg(windows)]
fn dpapi(data: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(data.len()).map_err(|_| "Credentials too large")?,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: null_mut(),
    };
    // No CRYPTPROTECT_LOCAL_MACHINE: ciphertext belongs to this Windows user.
    let success = unsafe {
        if encrypt {
            CryptProtectData(
                &input,
                null(),
                null(),
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                null_mut(),
                null(),
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if success == 0 {
        return Err("Windows could not protect/unprotect credentials; sign in again on this Windows account".into());
    }
    // DPAPI allocates this buffer with LocalAlloc; always free after copying.
    let result = if output.cbData == 0 {
        Vec::new()
    } else {
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() }
    };
    unsafe {
        LocalFree(output.pbData.cast());
    }
    Ok(result)
}

fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
    #[cfg(windows)]
    {
        dpapi(data, true)
    }
    #[cfg(not(windows))]
    {
        let _ = data;
        Err("Secure credential storage is not supported on this platform yet".into())
    }
}

fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
    #[cfg(windows)]
    {
        dpapi(data, false)
    }
    #[cfg(not(windows))]
    {
        let _ = data;
        Err("Secure credential storage is not supported on this platform yet".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Temp(std::path::PathBuf);
    impl Temp {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "save-sync-secret-{}-{}",
                std::process::id(),
                fastrand::u64(..)
            ));
            fs::create_dir_all(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    // Test-only codec exercises migration failure handling, not cryptography.
    fn codec(bytes: &[u8]) -> Result<Vec<u8>, String> {
        Ok(bytes.iter().map(|b| b ^ 0xaa).collect())
    }

    #[test]
    fn migration_removes_plaintext_only_after_verified_protected_write() {
        let t = Temp::new();
        let old = t.0.join("old.json");
        let protected = t.0.join("tokens.bin");
        fs::write(&old, br#"{"refresh":"private-token"}"#).unwrap();
        let value: serde_json::Value = load_with(&protected, Some(&old), codec, codec)
            .unwrap()
            .unwrap();
        assert_eq!(value["refresh"], "private-token");
        assert!(!old.exists());
        assert!(!String::from_utf8_lossy(&fs::read(&protected).unwrap()).contains("private-token"));
    }

    #[test]
    fn failed_encryption_preserves_legacy_file() {
        let t = Temp::new();
        let old = t.0.join("old.json");
        fs::write(&old, b"{}").unwrap();
        let result: Result<Option<serde_json::Value>, _> = load_with(
            &t.0.join("new.bin"),
            Some(&old),
            |_| Err("keystore locked".into()),
            codec,
        );
        assert!(result.is_err());
        assert!(old.exists());
    }

    #[test]
    fn corrupt_protected_file_never_falls_back_to_plaintext() {
        let t = Temp::new();
        let old = t.0.join("old.json");
        let protected = t.0.join("new.bin");
        fs::write(&old, b"{}").unwrap();
        fs::write(&protected, b"corrupt").unwrap();
        let result: Result<Option<serde_json::Value>, _> =
            load_with(&protected, Some(&old), codec, codec);
        assert!(result.is_err());
        assert!(old.exists());
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_round_trip_and_tamper_rejection() {
        let secret = b"not-a-real-refresh-token";
        let encrypted = protect(secret).unwrap();
        assert_ne!(encrypted, secret);
        assert_eq!(unprotect(&encrypted).unwrap(), secret);
        assert!(unprotect(b"invalid DPAPI ciphertext").is_err());
    }
}

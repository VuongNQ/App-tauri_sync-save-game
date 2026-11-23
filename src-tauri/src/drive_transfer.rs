//! Fast, resilient transfers of immutable save objects to/from Google Drive.
//!
//! Compared to the generic helpers in `gdrive.rs` this module:
//! - streams large files with Drive's resumable protocol in 8 MiB chunks, so a
//!   dropped connection resumes from the last acknowledged byte instead of
//!   re-sending the whole file, and memory stays bounded;
//! - retries transient failures (network errors, 408/429/5xx, Drive rate-limit
//!   403s) with exponential backoff + jitter, which matters once transfers run
//!   in parallel;
//! - refreshes the access token on 401 and retries;
//! - reports byte-level progress through a [`Reporter`].
use crate::{gdrive_auth, http_client, sync_progress::Reporter};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
    time::Duration,
};
use tauri::{AppHandle, Manager};

const DRIVE_FILES_URL: &str = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD_URL: &str = "https://www.googleapis.com/upload/drive/v3/files";
/// Files above this size use the resumable protocol; smaller ones go in one
/// multipart request (one round trip, cheapest for typical small save files).
const RESUMABLE_THRESHOLD: u64 = 5 * 1024 * 1024;
/// Must be a multiple of 256 KiB (Drive requirement).
const CHUNK_SIZE: usize = 8 * 1024 * 1024;
const MAX_ATTEMPTS: u32 = 5;

fn transient_status(status: u16, body: &str) -> bool {
    matches!(status, 408 | 429 | 500..=599)
        || (status == 403
            && (body.contains("rateLimitExceeded") || body.contains("userRateLimitExceeded")))
}

fn backoff(attempt: u32) {
    let base = 400u64.saturating_mul(1 << attempt.min(5)).min(8_000);
    let jitter = fastrand::u64(0..=base / 2);
    std::thread::sleep(Duration::from_millis(base + jitter));
}

fn token(app: &AppHandle, refresh: bool) -> Result<String, String> {
    if refresh {
        gdrive_auth::force_refresh_access_token(app)
    } else {
        gdrive_auth::get_access_token(app)
    }
}

#[derive(serde::Deserialize)]
struct Created {
    id: String,
}

fn parse_id(body: &str) -> Result<String, String> {
    serde_json::from_str::<Created>(body)
        .map(|c| c.id)
        .map_err(|e| format!("Parse upload response: {e}"))
}

/// Upload `path` as a NEW Drive object in `folder_id` and return its ID.
/// Never overwrites an existing object (published blobs are immutable).
pub fn upload_object(
    app: &AppHandle,
    folder_id: &str,
    path: &Path,
    progress: &Reporter,
) -> Result<String, String> {
    let _session = crate::session::current(app)?;
    let size = std::fs::metadata(path)
        .map_err(|e| format!("Cannot stat {}: {e}", path.display()))?
        .len();
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Invalid file name")?;
    if size > RESUMABLE_THRESHOLD {
        upload_resumable(app, folder_id, path, name, size, progress)
    } else {
        upload_multipart(app, folder_id, path, name, progress)
    }
}

fn upload_multipart(
    app: &AppHandle,
    folder_id: &str,
    path: &Path,
    name: &str,
    progress: &Reporter,
) -> Result<String, String> {
    let bytes =
        std::fs::read(path).map_err(|e| format!("Cannot read file {}: {e}", path.display()))?;
    let boundary = format!("----boundary{}", fastrand::u64(..));
    let metadata = serde_json::json!({ "name": name, "parents": [folder_id] });
    let mut body = Vec::with_capacity(bytes.len() + 512);
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(b"Content-Type: application/json; charset=UTF-8\r\n\r\n");
    body.extend_from_slice(metadata.to_string().as_bytes());
    body.extend_from_slice(format!("\r\n--{boundary}\r\n").as_bytes());
    body.extend_from_slice(b"Content-Type: application/octet-stream\r\n\r\n");
    body.extend_from_slice(&bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--").as_bytes());
    let content_type = format!("multipart/related; boundary={boundary}");
    let url = format!("{DRIVE_UPLOAD_URL}?uploadType=multipart&fields=id");

    let mut refresh = false;
    let mut last = String::new();
    for attempt in 0..MAX_ATTEMPTS {
        let bearer = format!("Bearer {}", token(app, refresh)?);
        refresh = false;
        match http_client::make_agent()
            .post(&url)
            .header("Authorization", &bearer)
            .header("Content-Type", &content_type)
            .send(&body[..])
        {
            Ok(resp) => {
                let status = resp.status().as_u16();
                let text = resp.into_body().read_to_string().unwrap_or_default();
                if status == 200 {
                    progress.add_bytes(bytes.len() as u64);
                    return parse_id(&text);
                }
                if status == 401 {
                    refresh = true;
                } else if !transient_status(status, &text) {
                    return Err(format!("Upload failed for {name} (HTTP {status}): {text}"));
                }
                last = format!("HTTP {status}: {text}");
            }
            Err(e) => last = e.to_string(),
        }
        if attempt + 1 < MAX_ATTEMPTS && !refresh {
            backoff(attempt);
        }
    }
    Err(format!(
        "Upload failed for {name} after {MAX_ATTEMPTS} attempts: {last}"
    ))
}

/// Outcome of one request against a resumable session.
enum SessionState {
    /// Server holds bytes `[0, n)`.
    Partial(u64),
    Complete(String),
}

fn parse_range(resp: &ureq::http::Response<ureq::Body>) -> u64 {
    // "Range: bytes=0-N" => N + 1 bytes persisted; absent => none yet.
    resp.headers()
        .get("range")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.rsplit('-').next())
        .and_then(|n| n.trim().parse::<u64>().ok())
        .map_or(0, |n| n + 1)
}

fn session_response(
    resp: ureq::http::Response<ureq::Body>,
    name: &str,
) -> Result<Result<SessionState, (u16, String)>, String> {
    let status = resp.status().as_u16();
    if status == 308 {
        return Ok(Ok(SessionState::Partial(parse_range(&resp))));
    }
    let text = resp.into_body().read_to_string().unwrap_or_default();
    if status == 200 || status == 201 {
        return parse_id(&text).map(|id| Ok(SessionState::Complete(id)));
    }
    if status == 404 || status == 410 {
        return Err(format!(
            "Upload session for {name} expired (HTTP {status}); retry the sync"
        ));
    }
    Ok(Err((status, text)))
}

fn upload_resumable(
    app: &AppHandle,
    folder_id: &str,
    path: &Path,
    name: &str,
    size: u64,
    progress: &Reporter,
) -> Result<String, String> {
    let session = start_session(app, folder_id, name, size)?;
    let mut file = File::open(path).map_err(|e| format!("Cannot open {}: {e}", path.display()))?;
    let mut buffer = vec![0u8; CHUNK_SIZE];
    let mut offset = 0u64;
    let mut reported = 0u64;
    let mut failures = 0u32;
    let mut refresh = false;
    let mut last = String::new();

    let sync_reported = |offset: u64, reported: &mut u64| {
        if offset >= *reported {
            progress.add_bytes(offset - *reported);
        } else {
            progress.rewind_bytes(*reported - offset);
        }
        *reported = offset;
    };

    loop {
        if failures >= MAX_ATTEMPTS {
            return Err(format!(
                "Upload failed for {name} after {MAX_ATTEMPTS} attempts: {last}"
            ));
        }
        let bearer = format!("Bearer {}", token(app, refresh)?);
        refresh = false;
        // After a failure, ask the server how much it actually persisted.
        let request = if failures > 0 {
            session_request(&session, &bearer, &format!("bytes */{size}")).send_empty()
        } else {
            let len = ((size - offset) as usize).min(CHUNK_SIZE);
            file.seek(SeekFrom::Start(offset))
                .and_then(|_| file.read_exact(&mut buffer[..len]))
                .map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
            let range = format!("bytes {offset}-{}/{size}", offset + len as u64 - 1);
            session_request(&session, &bearer, &range).send(&buffer[..len])
        };
        match request {
            Ok(resp) => match session_response(resp, name)? {
                Ok(SessionState::Complete(id)) => {
                    sync_reported(size, &mut reported);
                    return Ok(id);
                }
                Ok(SessionState::Partial(n)) => {
                    offset = n.min(size);
                    sync_reported(offset, &mut reported);
                    if offset < size {
                        failures = 0;
                        continue;
                    }
                    // Every byte acknowledged but no file yet: ask again.
                    last = "Drive has not finalized the upload".into();
                }
                Err((401, text)) => {
                    refresh = true;
                    last = format!("HTTP 401: {text}");
                }
                Err((status, text)) if transient_status(status, &text) => {
                    last = format!("HTTP {status}: {text}");
                }
                Err((status, text)) => {
                    return Err(format!("Upload failed for {name} (HTTP {status}): {text}"));
                }
            },
            Err(e) => last = e.to_string(),
        }
        if !refresh {
            backoff(failures);
        }
        failures += 1;
    }
}

fn session_request<'a>(
    session: &'a str,
    bearer: &str,
    content_range: &str,
) -> ureq::RequestBuilder<ureq::typestate::WithBody> {
    http_client::make_agent()
        .put(session)
        // Drive answers an incomplete chunk with 308 (no Location): it must be
        // returned to us, not treated as a redirect.
        .config()
        .max_redirects(0)
        .build()
        .header("Authorization", bearer)
        .header("Content-Range", content_range)
}

fn start_session(
    app: &AppHandle,
    folder_id: &str,
    name: &str,
    size: u64,
) -> Result<String, String> {
    let url = format!("{DRIVE_UPLOAD_URL}?uploadType=resumable&fields=id");
    let metadata = serde_json::json!({ "name": name, "parents": [folder_id] }).to_string();
    let mut refresh = false;
    let mut last = String::new();
    for attempt in 0..MAX_ATTEMPTS {
        let bearer = format!("Bearer {}", token(app, refresh)?);
        refresh = false;
        match http_client::make_agent()
            .post(&url)
            .header("Authorization", &bearer)
            .header("Content-Type", "application/json; charset=UTF-8")
            .header("X-Upload-Content-Type", "application/octet-stream")
            .header("X-Upload-Content-Length", &size.to_string())
            .send(metadata.as_bytes())
        {
            Ok(resp) => {
                let status = resp.status().as_u16();
                if status == 200 {
                    if let Some(location) =
                        resp.headers().get("location").and_then(|v| v.to_str().ok())
                    {
                        return Ok(location.to_owned());
                    }
                    return Err("Drive did not return an upload session URL".into());
                }
                let text = resp.into_body().read_to_string().unwrap_or_default();
                if status == 401 {
                    refresh = true;
                } else if !transient_status(status, &text) {
                    return Err(format!(
                        "Cannot start upload for {name} (HTTP {status}): {text}"
                    ));
                }
                last = format!("HTTP {status}: {text}");
            }
            Err(e) => last = e.to_string(),
        }
        if attempt + 1 < MAX_ATTEMPTS && !refresh {
            backoff(attempt);
        }
    }
    Err(format!("Cannot start upload for {name}: {last}"))
}

/// Counts bytes as they stream from the network into the staging file.
struct Counting<'a, R> {
    inner: R,
    progress: &'a Reporter,
    read: u64,
}
impl<R: Read> Read for Counting<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.read += n as u64;
        self.progress.add_bytes(n as u64);
        Ok(n)
    }
}

/// Download Drive object `file_id` into `dest` (atomically replaced), retrying
/// transient failures from scratch. The caller verifies hash/size.
pub fn download_object(
    app: &AppHandle,
    file_id: &str,
    dest: &Path,
    progress: &Reporter,
) -> Result<(), String> {
    let _session = crate::session::current(app)?;
    let url = format!("{DRIVE_FILES_URL}/{file_id}?alt=media");
    let recovery_root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Cannot resolve recovery directory: {e}"))?
        .join("save-recovery");
    let mut refresh = false;
    let mut last = String::new();
    for attempt in 0..MAX_ATTEMPTS {
        let bearer = format!("Bearer {}", token(app, refresh)?);
        refresh = false;
        match http_client::make_agent()
            .get(&url)
            .header("Authorization", &bearer)
            .call()
        {
            Ok(resp) => {
                let status = resp.status().as_u16();
                if status == 200 {
                    let expected = resp
                        .headers()
                        .get("content-length")
                        .and_then(|v| v.to_str().ok())
                        .and_then(|v| v.parse::<u64>().ok());
                    let mut reader = Counting {
                        inner: resp.into_body().into_reader(),
                        progress,
                        read: 0,
                    };
                    match crate::safe_files::replace_from_reader(
                        dest,
                        &mut reader,
                        expected,
                        Some(&recovery_root),
                    ) {
                        Ok(_) => return Ok(()),
                        Err(e) => {
                            // Connection dropped mid-body: start over.
                            progress.rewind_bytes(reader.read);
                            last = e;
                        }
                    }
                } else {
                    let text = resp.into_body().read_to_string().unwrap_or_default();
                    if status == 401 {
                        refresh = true;
                    } else if !transient_status(status, &text) {
                        return Err(format!(
                            "Download failed for {file_id} (HTTP {status}): {text}"
                        ));
                    }
                    last = format!("HTTP {status}: {text}");
                }
            }
            Err(e) => last = e.to_string(),
        }
        if attempt + 1 < MAX_ATTEMPTS && !refresh {
            backoff(attempt);
        }
    }
    Err(format!(
        "Download failed for {file_id} after {MAX_ATTEMPTS} attempts: {last}"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_transient_errors() {
        assert!(transient_status(429, ""));
        assert!(transient_status(503, ""));
        assert!(transient_status(
            403,
            r#"{"reason":"userRateLimitExceeded"}"#
        ));
        assert!(!transient_status(
            403,
            r#"{"reason":"insufficientPermissions"}"#
        ));
        assert!(!transient_status(400, ""));
        assert!(!transient_status(404, ""));
    }

    #[test]
    fn chunk_size_is_drive_aligned() {
        assert_eq!(CHUNK_SIZE % (256 * 1024), 0);
        assert!(RESUMABLE_THRESHOLD < CHUNK_SIZE as u64 * 2);
    }
}

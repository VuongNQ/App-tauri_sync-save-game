//! Conservative three-way decisions: timestamps are identities, never a winner election.
#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    Upload,
    Download,
    Skip,
    Conflict,
}

pub fn decide(local_changed: bool, cloud_changed: bool, cloud_exists: bool) -> Decision {
    match (local_changed, cloud_changed, cloud_exists) {
        (true, true, true) => Decision::Conflict,
        (true, _, _) => Decision::Upload,
        (false, true, true) => Decision::Download,
        _ => Decision::Skip,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offline_changes_upload_without_restoring_over_local() {
        assert_eq!(decide(true, false, true), Decision::Upload);
    }

    #[test]
    fn two_changed_sides_and_first_sync_collisions_require_a_choice() {
        assert_eq!(decide(true, true, true), Decision::Conflict);
    }

    #[test]
    fn only_cloud_changes_download_and_unchanged_files_skip() {
        assert_eq!(decide(false, true, true), Decision::Download);
        assert_eq!(decide(false, false, true), Decision::Skip);
        assert_eq!(decide(true, false, false), Decision::Upload);
    }
}

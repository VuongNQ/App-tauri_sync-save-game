//! Pure retention and garbage-collection decisions for immutable v2 Drive objects.
//! No network, clocks or filesystem: callers pass listings and `now`.
//!
//! Safety model (see docs/cross-device-sync.md, "Storage cleanup"):
//! - An object is live if the current Firestore manifest or any retained
//!   snapshot references it, or if it is younger than the grace period
//!   (uploads from another device that has not yet won its CAS).
//! - Expired automatic snapshots are removed first; their objects only become
//!   candidates. A candidate is deleted on a LATER run, at least
//!   `confirm_hours` after it was marked, and only if it is still unreferenced.
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// Labels written by the engine itself. User-named snapshots are never pruned.
pub const AUTO_LABELS: [&str; 3] = [
    "Before sync",
    "Before cloud deletion",
    "Before removing excluded files",
];

#[derive(Debug, Clone, Copy)]
pub struct Policy {
    /// Always keep this many newest automatic snapshots.
    pub keep_auto_count: usize,
    /// Also keep every automatic snapshot younger than this.
    pub keep_auto_days: i64,
    /// Objects younger than this are never candidates.
    pub grace_days: i64,
    /// Minimum delay between marking a candidate and deleting it.
    pub confirm_hours: i64,
    /// Automatic background cleanup runs at most this often per game.
    pub auto_interval_days: i64,
}

pub const DEFAULT_POLICY: Policy = Policy {
    keep_auto_count: 10,
    keep_auto_days: 14,
    grace_days: 7,
    confirm_hours: 24,
    auto_interval_days: 7,
};

/// Snapshot folders are named `{rfc3339} — {label} [{operation id}]`.
pub fn parse_snapshot_name(name: &str) -> Option<(DateTime<Utc>, &str)> {
    let (time, rest) = name.split_once(" — ")?;
    let (label, _) = rest.rsplit_once(" [")?;
    let time = DateTime::parse_from_rfc3339(time).ok()?.with_timezone(&Utc);
    Some((time, label))
}

/// Return the IDs of automatic snapshots that fall outside the retention policy.
/// Unparseable, legacy and user-named snapshots are always kept.
pub fn snapshots_to_prune(
    folders: &[(String, String)],
    now: DateTime<Utc>,
    policy: &Policy,
) -> Vec<String> {
    let mut auto: Vec<_> = folders
        .iter()
        .filter_map(|(id, name)| {
            let (time, label) = parse_snapshot_name(name)?;
            AUTO_LABELS.contains(&label).then_some((time, id))
        })
        .collect();
    auto.sort_by(|a, b| b.0.cmp(&a.0));
    let cutoff = now - Duration::days(policy.keep_auto_days);
    auto.into_iter()
        .enumerate()
        .filter(|(i, (time, _))| *i >= policy.keep_auto_count && *time < cutoff)
        .map(|(_, (_, id))| id.clone())
        .collect()
}

/// Candidates marked by a previous run, kept only on this device.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingSweep {
    pub marked_at: Option<DateTime<Utc>>,
    pub objects: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SweepPlan {
    pub delete: Vec<String>,
    pub next: PendingSweep,
}

/// `objects` = (Drive ID, creation/modification time). Objects with an
/// unknown time are never deleted.
pub fn plan_sweep(
    objects: &[(String, Option<DateTime<Utc>>)],
    live: &BTreeSet<String>,
    pending: &PendingSweep,
    now: DateTime<Utc>,
    policy: &Policy,
) -> SweepPlan {
    let grace = now - Duration::days(policy.grace_days);
    let candidates: BTreeSet<String> = objects
        .iter()
        .filter(|(id, time)| !live.contains(id) && time.is_some_and(|t| t < grace))
        .map(|(id, _)| id.clone())
        .collect();
    let ripe = pending
        .marked_at
        .is_some_and(|t| now - t >= Duration::hours(policy.confirm_hours));
    if pending.marked_at.is_some() && !ripe {
        // Keep the original timer; do not delete or re-mark anything yet.
        // Drop marks that became live again so they can never be deleted later.
        let mut next = pending.clone();
        next.objects.retain(|id| candidates.contains(id));
        return SweepPlan {
            delete: Vec::new(),
            next,
        };
    }
    let delete: Vec<String> = if ripe {
        candidates
            .iter()
            .filter(|id| pending.objects.contains(*id))
            .cloned()
            .collect()
    } else {
        Vec::new()
    };
    let remaining: BTreeSet<String> = candidates
        .into_iter()
        .filter(|id| !delete.contains(id))
        .collect();
    SweepPlan {
        delete,
        next: PendingSweep {
            marked_at: (!remaining.is_empty()).then_some(now),
            objects: remaining,
        },
    }
}

pub fn auto_run_due(
    last_run: Option<DateTime<Utc>>,
    pending: &PendingSweep,
    now: DateTime<Utc>,
    policy: &Policy,
) -> bool {
    let interval_elapsed =
        last_run.is_none_or(|t| now - t >= Duration::days(policy.auto_interval_days));
    let pending_ripe = pending
        .marked_at
        .is_some_and(|t| now - t >= Duration::hours(policy.confirm_hours));
    interval_elapsed || pending_ripe
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }
    fn name(time: &str, label: &str) -> String {
        format!("{time} — {label} [abc123]")
    }

    #[test]
    fn parses_engine_snapshot_names_only() {
        let snapshot = name("2026-11-01T10:00:00.5+00:00", "Before sync");
        let (time, label) = parse_snapshot_name(&snapshot).unwrap();
        assert_eq!(time, t("2026-11-01T10:00:00.5Z"));
        assert_eq!(label, "Before sync");
        assert!(parse_snapshot_name("2024-01-01 manual backup").is_none());
        let user = name("2026-11-01T10:00:00Z", "boss fight");
        assert!(!AUTO_LABELS.contains(&parse_snapshot_name(&user).unwrap().1));
    }

    #[test]
    fn keeps_newest_auto_snapshots_recent_ones_and_all_user_snapshots() {
        let policy = Policy {
            keep_auto_count: 2,
            keep_auto_days: 14,
            ..DEFAULT_POLICY
        };
        let now = t("2026-11-30T00:00:00Z");
        let folders = vec![
            ("u".to_string(), name("2026-01-01T00:00:00Z", "boss fight")),
            ("legacy".to_string(), "2025-01-01 old backup".to_string()),
            (
                "a1".to_string(),
                name("2026-10-01T00:00:00Z", "Before sync"),
            ),
            (
                "a2".to_string(),
                name("2026-10-02T00:00:00Z", "Before sync"),
            ),
            (
                "a3".to_string(),
                name("2026-10-03T00:00:00Z", "Before cloud deletion"),
            ),
            (
                "a4".to_string(),
                name("2026-10-04T00:00:00Z", "Before sync"),
            ),
            (
                "recent".to_string(),
                name("2026-11-25T00:00:00Z", "Before sync"),
            ),
        ];
        let mut pruned = snapshots_to_prune(&folders, now, &policy);
        pruned.sort();
        // recent + a4 are the two newest; recent is also within 14 days.
        assert_eq!(pruned, vec!["a1", "a2", "a3"]);
    }

    #[test]
    fn two_phase_sweep_never_deletes_live_young_or_freshly_marked_objects() {
        let policy = DEFAULT_POLICY;
        let old = Some(t("2026-01-01T00:00:00Z"));
        let objects = vec![
            ("live".to_string(), old),
            ("orphan".to_string(), old),
            ("young".to_string(), Some(t("2026-11-29T00:00:00Z"))),
            ("unknown".to_string(), None),
        ];
        let live: BTreeSet<_> = ["live".to_string()].into();
        let now = t("2026-11-30T00:00:00Z");

        let first = plan_sweep(&objects, &live, &PendingSweep::default(), now, &policy);
        assert!(first.delete.is_empty());
        assert_eq!(first.next.objects, ["orphan".to_string()].into());

        let early = plan_sweep(
            &objects,
            &live,
            &first.next,
            now + Duration::hours(23),
            &policy,
        );
        assert!(early.delete.is_empty());
        assert_eq!(early.next, first.next);

        let later = plan_sweep(
            &objects,
            &live,
            &first.next,
            now + Duration::hours(25),
            &policy,
        );
        assert_eq!(later.delete, vec!["orphan".to_string()]);
        assert_eq!(later.next, PendingSweep::default());
    }

    #[test]
    fn object_referenced_again_before_confirmation_is_kept() {
        let policy = DEFAULT_POLICY;
        let old = Some(t("2026-01-01T00:00:00Z"));
        let objects = vec![("x".to_string(), old), ("y".to_string(), old)];
        let now = t("2026-11-30T00:00:00Z");
        let first = plan_sweep(
            &objects,
            &BTreeSet::new(),
            &PendingSweep::default(),
            now,
            &policy,
        );
        assert_eq!(first.next.objects.len(), 2);
        // A snapshot restore or dedup re-referenced x in the meantime.
        let live: BTreeSet<_> = ["x".to_string()].into();
        let early = plan_sweep(
            &objects,
            &live,
            &first.next,
            now + Duration::hours(1),
            &policy,
        );
        assert_eq!(early.next.objects, ["y".to_string()].into());
        let later = plan_sweep(
            &objects,
            &live,
            &early.next,
            now + Duration::hours(30),
            &policy,
        );
        assert_eq!(later.delete, vec!["y".to_string()]);
    }

    #[test]
    fn newly_found_candidates_wait_a_full_confirmation_period() {
        let policy = DEFAULT_POLICY;
        let old = Some(t("2026-01-01T00:00:00Z"));
        let now = t("2026-11-30T00:00:00Z");
        let first = plan_sweep(
            &[("x".to_string(), old)],
            &BTreeSet::new(),
            &PendingSweep::default(),
            now,
            &policy,
        );
        let objects = vec![("x".to_string(), old), ("new".to_string(), old)];
        let later = plan_sweep(
            &objects,
            &BTreeSet::new(),
            &first.next,
            now + Duration::hours(25),
            &policy,
        );
        assert_eq!(later.delete, vec!["x".to_string()]);
        assert_eq!(later.next.objects, ["new".to_string()].into());
        assert_eq!(later.next.marked_at, Some(now + Duration::hours(25)));
    }

    #[test]
    fn auto_run_schedule() {
        let p = DEFAULT_POLICY;
        let now = t("2026-11-30T00:00:00Z");
        assert!(auto_run_due(None, &PendingSweep::default(), now, &p));
        assert!(!auto_run_due(
            Some(now - Duration::days(1)),
            &PendingSweep::default(),
            now,
            &p
        ));
        let pending = PendingSweep {
            marked_at: Some(now - Duration::hours(25)),
            objects: ["x".into()].into(),
        };
        assert!(auto_run_due(
            Some(now - Duration::days(1)),
            &pending,
            now,
            &p
        ));
    }
}

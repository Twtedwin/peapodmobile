//! # Progression: levels, garden growth, achievements
//!
//! ## Purpose
//! The three derived views of a pod's progress that are pure functions of stored
//! counters, so they can live outside the database entirely:
//! - **Level** from XP, plus the next threshold and the fraction of the way
//!   there (port of `levelFromXp` and `gardenPlotCapacity` from
//!   `src/lib/peapodData.js`).
//! - **Garden growth** for each planted slot at a caller-supplied instant (port
//!   of `plantGrowth`).
//! - **Achievement tracks** with every unlocked tier and progress toward the
//!   next (port of `computeAchievementGroups` / `buildGroup` from
//!   `src/lib/achievements.js`).
//!
//! Every threshold, level name, capacity formula and tier list is read from
//! `packages/shared/data/rules/progression.json` and
//! `packages/shared/data/rules/garden.json`, so the app, the API and this
//! service can never disagree about what level a pod is.
//!
//! ## Inputs
//! XP as an integer; garden entries with `planted_at_ms` (epoch milliseconds)
//! and `grows_seconds`; the three achievement counters.
//!
//! ## Outputs
//! `LevelResponse`, `GardenGrowthResponse`, `AchievementResponse`.
//!
//! ## Who calls this
//! `services/api` on behalf of `POST /progression/level`,
//! `POST /progression/garden-growth` and `POST /progression/achievements`.
//!
//! ## Why the caller supplies `now_ms`
//! Growth is a function of elapsed time, and this service must never read its
//! own clock: the API already knows "now" for the request it is serving, and
//! passing it in is what makes the endpoint reproducible in tests and immune to
//! clock skew between containers.

use crate::error::AppError;
use crate::models::{
    AchievementGroup, AchievementRequest, AchievementResponse, AchievementTier, GardenEntryKind,
    GrowthEntryInput, GrowthResult, LevelResponse,
};
use crate::rules::{AchievementTrackRule, GARDEN, PROGRESSION};

/// The level a pod occupies at a given XP total.
///
/// # Parameters
/// - `xp`: total XP earned. Values below the first threshold (0) still give
///   level 1.
///
/// # Returns
/// The level number, 1..=6 with the shipped ladder.
///
/// # Algorithm
/// Walk `progression.json -> worldLevels` in file order and keep the last level
/// whose `xp` threshold has been reached. This is exactly the original's
/// `for (const l of worldLevels) if (xp >= l.xp) current = l.level`, and it
/// relies on the file being in ascending order -- which `rules.rs` asserts in
/// its tests.
///
/// # Edge cases
/// Starts at 1, so a pod with 0 (or somehow negative) XP is level 1 rather than
/// level 0. Levels are never stored, always derived, so a pod's level and XP
/// cannot drift apart.
pub fn level_from_xp(xp: i64) -> i64 {
    let mut current = 1;
    for level in &PROGRESSION.world_levels {
        if xp >= level.xp {
            current = level.level;
        }
    }
    current
}

/// Garden slots unlocked at a level.
///
/// # Parameters
/// - `level`: the pod's world level.
///
/// # Returns
/// `min(max, base + max(1, level) * perLevel)`, which with the shipped rule
/// (`base = 2`, `perLevel = 2`, `max = 12`) is `min(12, 2 + max(1, level) * 2)`:
/// 4 slots at level 1, 6 at level 2, ... hard-capped at 12 from level 5 on.
///
/// # Why it is shaped like this
/// From `progression.json`: "The garden starts small and opens new ground as the
/// pod grows. Capacity is never purchasable -- it always reflects real
/// progression."
///
/// # Edge cases
/// `max(1, level)` means level 0 or a negative level still yields the level-1
/// capacity rather than an empty (or negative) garden.
pub fn garden_plot_capacity(level: i64) -> i64 {
    let rule = &PROGRESSION.garden_plot_capacity;
    let effective_level = level.max(1);
    (rule.base + effective_level * rule.per_level).min(rule.max)
}

/// Builds the full level view for an XP total.
///
/// # Parameters
/// - `xp`: total XP. The handler rejects negatives with a `400`.
///
/// # Returns
/// The current level's number, name and description; the XP threshold of the
/// level occupied; the next level's threshold (`None` at max level); `progress`
/// as a 0..1 fraction of the way to that next level; and the garden capacity
/// unlocked.
///
/// # `progress`
/// `(xp - current_level_xp) / (next_level_xp - current_level_xp)`, clamped to
/// 0..1, and exactly `1.0` at max level (there is nothing left to progress
/// toward, and the UI draws a full bar rather than an empty one).
///
/// # Errors
/// `AppError::Internal` if `worldLevels` is empty or the current level is
/// missing from it. Both are impossible for a rule file that passed
/// `rules::warm_up()`, but they are surfaced rather than panicked on so one bad
/// deploy cannot take the process down mid-request.
pub fn level_view(xp: i64) -> Result<LevelResponse, AppError> {
    let levels = &PROGRESSION.world_levels;
    let level = level_from_xp(xp);

    let index = levels
        .iter()
        .position(|l| l.level == level)
        .ok_or_else(|| AppError::internal("worldLevels does not contain the computed level"))?;
    let current = &levels[index];
    let next = levels.get(index + 1);

    let progress = match next {
        Some(next) => {
            let span = (next.xp - current.xp) as f64;
            if span <= 0.0 {
                // Two levels sharing a threshold would make the fraction
                // meaningless; treat the current level as complete.
                1.0
            } else {
                (((xp - current.xp) as f64) / span).clamp(0.0, 1.0)
            }
        }
        // Max level: always a full bar.
        None => 1.0,
    };

    Ok(LevelResponse {
        level: current.level,
        name: current.name.clone(),
        description: current.description.clone(),
        current_level_xp: current.xp,
        next_level_xp: next.map(|n| n.xp),
        progress,
        plot_capacity: garden_plot_capacity(current.level),
    })
}

/// How grown one garden entry is, 0..1.
///
/// # Parameters
/// - `entry`: the slot to evaluate.
/// - `now_ms`: evaluation instant, epoch milliseconds, supplied by the caller.
///
/// # Returns
/// `min(1, elapsed_seconds / grows_seconds + water_boost)`.
///
/// # Rules preserved from the original (`garden.json -> growth`)
/// - **Decorations are always 1.0.** They are cosmetic and always render fully
///   grown.
/// - **A plant with no `planted_at_ms` is always 1.0.** It is a pre-seeded
///   living record of a past memory, not something the pod is waiting on.
/// - **Growth never decreases and a plant never dies**, so the garden never
///   punishes a pod for being away. This function is monotonic in `now_ms` by
///   construction.
/// - `water_boost` is additive: "Watering nudges a plant forward by 30% of its
///   total grow time", capped by `waterBoostCap` so repeated watering cannot
///   instantly mature a plant.
///
/// # Edge cases and deliberate deviations
/// - `grows_seconds <= 0` falls back to 60 s. The original wrote
///   `entry.growsSeconds || 60`, where `0` is falsy and therefore became 60;
///   this reproduces that *and* removes any possibility of dividing by zero.
/// - The result is clamped **below at 0** as well as above at 1. The original
///   had no lower clamp, but `planted_at_ms` was always in the past there. A
///   caller passing a future planting instant would otherwise produce a negative
///   growth, which `compute.schema.json` forbids (`growth` is 0..1). This is the
///   only intentional behavioural change in this module.
/// - `water_boost` is clamped into `[0, waterBoostCap]` for the same
///   contract-compliance reason.
pub fn plant_growth(entry: &GrowthEntryInput, now_ms: i64) -> f64 {
    if entry.kind == GardenEntryKind::Decor {
        return 1.0;
    }
    let planted_at_ms = match entry.planted_at_ms {
        Some(ms) => ms,
        // Pre-seeded memory: already fully grown.
        None => return 1.0,
    };

    let grows_seconds = if entry.grows_seconds > 0 { entry.grows_seconds } else { 60 };
    let elapsed_seconds = (now_ms - planted_at_ms) as f64 / 1000.0;
    let water_boost = entry
        .water_boost
        .clamp(0.0, GARDEN.growth.water_boost_cap);

    (elapsed_seconds / grows_seconds as f64 + water_boost).clamp(0.0, 1.0)
}

/// Evaluates a whole garden at one instant.
///
/// # Parameters
/// - `entries`: the pod's occupied slots.
/// - `now_ms`: evaluation instant, epoch milliseconds.
///
/// # Returns
/// One result per entry, **in request order**, each with its growth and a
/// `mature` flag. `mature` is `growth >= 1.0`, which is when a plant may be
/// harvested.
pub fn garden_growth(entries: &[GrowthEntryInput], now_ms: i64) -> Vec<GrowthResult> {
    entries
        .iter()
        .map(|entry| {
            let growth = plant_growth(entry, now_ms);
            GrowthResult { id: entry.id.clone(), growth, mature: growth >= 1.0 }
        })
        .collect()
}

/// Builds one achievement track, or `None` when nothing is unlocked yet.
///
/// # Parameters
/// - `track`: the track definition from `progression.json`.
/// - `value`: the pod's current value for the track's metric.
///
/// # Returns
/// `Some(group)` listing **every** unlocked tier (not just the latest), so the
/// UI can page back through the pod's history rather than showing only the most
/// recent badge. `None` when the pod has not reached the first tier, which is
/// how a track is omitted entirely instead of rendered empty.
///
/// # `progress`
/// Measured from the **frontier** (the highest unlocked tier) toward the next
/// one: `(value - frontier.threshold) / (next.threshold - frontier.threshold)`,
/// clamped to 0..1. Exactly `1.0` when the whole track is complete.
///
/// # Edge cases
/// - Relies on tiers being in ascending threshold order, which `rules.rs`
///   asserts. The frontier is therefore the last tier that passed the filter.
/// - Two tiers with the same threshold would give a zero-width span; that is
///   treated as complete rather than dividing by zero.
fn build_group(track: &AchievementTrackRule, value: i64) -> Option<AchievementGroup> {
    // Indices into `track.tiers` of every tier the pod has reached.
    let unlocked_indices: Vec<usize> = track
        .tiers
        .iter()
        .enumerate()
        .filter(|(_, tier)| value >= tier.threshold)
        .map(|(index, _)| index)
        .collect();

    let frontier_index = *unlocked_indices.last()?;
    let frontier = &track.tiers[frontier_index];
    let next = track.tiers.get(frontier_index + 1);

    let progress = match next {
        Some(next) => {
            let span = (next.threshold - frontier.threshold) as f64;
            if span <= 0.0 {
                1.0
            } else {
                (((value - frontier.threshold) as f64) / span).clamp(0.0, 1.0)
            }
        }
        // Track complete.
        None => 1.0,
    };

    let tiers = unlocked_indices
        .iter()
        .map(|&index| {
            let tier = &track.tiers[index];
            AchievementTier {
                threshold: tier.threshold,
                label: tier.label.clone(),
                description: tier.description.clone(),
            }
        })
        .collect();

    Some(AchievementGroup {
        key: track.key.clone(),
        title: track.title.clone(),
        tiers,
        progress,
    })
}

/// Builds every achievement track that has at least one unlocked tier.
///
/// # Parameters
/// - `req`: the three counters. `pinned_journey_days` is `None` when the pod has
///   not pinned a count-up date.
///
/// # Returns
/// The unlocked tracks in `progression.json` order.
///
/// # How a metric is chosen
/// Each track in the rule file names the metric it measures, and this function
/// maps that name onto a request field:
/// - `peas_count` -> pod size, floored at 1. The original wrote
///   `peasCount || 1`, i.e. a missing or zero pod size counts as 1, because a
///   pod always contains at least the member asking -- which is what makes the
///   "First Pod" tier unlockable on day one.
/// - `dates_count` -> used as given. Zero unlocks nothing, so the "Journey Log"
///   track is simply absent until the pod logs its first date.
/// - `pinned_journey_days` -> only when present. A pod with no pinned date does
///   not see a "Time Together" track sitting at zero.
/// - Any other metric name is **skipped**, so adding a track to the rule file
///   before this service knows how to source its metric degrades to "that track
///   is missing" rather than to a `500`.
pub fn compute_achievement_groups(req: &AchievementRequest) -> AchievementResponse {
    let mut groups: Vec<AchievementGroup> = Vec::new();

    for track in &PROGRESSION.achievement_tracks {
        let value = match track.metric.as_str() {
            "peas_count" => Some(if req.peas_count > 0 { req.peas_count } else { 1 }),
            "dates_count" => Some(req.dates_count),
            "pinned_journey_days" => req.pinned_journey_days,
            _ => None,
        };
        if let Some(value) = value {
            if let Some(group) = build_group(track, value) {
                groups.push(group);
            }
        }
    }

    AchievementResponse { groups }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_from_xp_boundaries() {
        // Thresholds from progression.json: 0, 120, 280, 460, 700, 1000.
        assert_eq!(level_from_xp(0), 1);
        assert_eq!(level_from_xp(1), 1);
        assert_eq!(level_from_xp(119), 1);
        assert_eq!(level_from_xp(120), 2, "exactly on a threshold levels up");
        assert_eq!(level_from_xp(279), 2);
        assert_eq!(level_from_xp(280), 3);
        assert_eq!(level_from_xp(459), 3);
        assert_eq!(level_from_xp(460), 4);
        assert_eq!(level_from_xp(699), 4);
        assert_eq!(level_from_xp(700), 5);
        assert_eq!(level_from_xp(999), 5);
        assert_eq!(level_from_xp(1000), 6);
        assert_eq!(level_from_xp(1_000_000), 6, "the ladder tops out at 6");
    }

    #[test]
    fn plot_capacity_grows_then_caps_at_twelve() {
        assert_eq!(garden_plot_capacity(1), 4);
        assert_eq!(garden_plot_capacity(2), 6);
        assert_eq!(garden_plot_capacity(3), 8);
        assert_eq!(garden_plot_capacity(4), 10);
        assert_eq!(garden_plot_capacity(5), 12);
        // 2 + 6*2 = 14, capped.
        assert_eq!(garden_plot_capacity(6), 12, "capacity is hard-capped at 12");
        assert_eq!(garden_plot_capacity(99), 12);
        // max(1, level) protects against a nonsensical level.
        assert_eq!(garden_plot_capacity(0), 4);
        assert_eq!(garden_plot_capacity(-5), 4);
    }

    #[test]
    fn level_view_reports_the_next_threshold_and_progress() {
        let mid = level_view(200).expect("level view for 200 xp");
        assert_eq!(mid.level, 2);
        assert_eq!(mid.name, "Growing Together");
        assert_eq!(mid.current_level_xp, 120);
        assert_eq!(mid.next_level_xp, Some(280));
        // (200 - 120) / (280 - 120) = 0.5
        assert!((mid.progress - 0.5).abs() < 1e-9);
        assert_eq!(mid.plot_capacity, 6);

        let fresh = level_view(0).expect("level view for 0 xp");
        assert_eq!(fresh.level, 1);
        assert_eq!(fresh.current_level_xp, 0);
        assert_eq!(fresh.next_level_xp, Some(120));
        assert_eq!(fresh.progress, 0.0);

        let maxed = level_view(5000).expect("level view at max level");
        assert_eq!(maxed.level, 6);
        assert_eq!(maxed.next_level_xp, None);
        assert_eq!(maxed.progress, 1.0, "a maxed pod shows a full bar");
        assert_eq!(maxed.plot_capacity, 12);
    }

    /// Builds a plant entry.
    fn plant(planted_at_ms: Option<i64>, grows_seconds: i64, water_boost: f64) -> GrowthEntryInput {
        GrowthEntryInput {
            id: "g1".to_string(),
            kind: GardenEntryKind::Plant,
            planted_at_ms,
            grows_seconds,
            water_boost,
        }
    }

    #[test]
    fn growth_is_elapsed_time_over_grow_time() {
        let now = 1_700_000_000_000_i64;
        // Half of a 60 s grow time.
        let half = plant(Some(now - 30_000), 60, 0.0);
        assert!((plant_growth(&half, now) - 0.5).abs() < 1e-9);
        // Exactly mature.
        let done = plant(Some(now - 60_000), 60, 0.0);
        assert_eq!(plant_growth(&done, now), 1.0);
        // Past mature stays at 1.0 -- growth never overshoots and never decays.
        let old = plant(Some(now - 600_000), 60, 0.0);
        assert_eq!(plant_growth(&old, now), 1.0);
        // Just planted.
        let fresh = plant(Some(now), 60, 0.0);
        assert_eq!(plant_growth(&fresh, now), 0.0);
    }

    #[test]
    fn watering_adds_to_growth_without_ever_exceeding_one() {
        let now = 1_700_000_000_000_i64;
        // 0.25 elapsed + 0.3 water = 0.55.
        let watered = plant(Some(now - 15_000), 60, 0.3);
        assert!((plant_growth(&watered, now) - 0.55).abs() < 1e-9);
        // A boost big enough to overshoot is capped at 1.0.
        let drenched = plant(Some(now - 30_000), 60, 0.9);
        assert_eq!(plant_growth(&drenched, now), 1.0);
    }

    #[test]
    fn decor_and_preseeded_plants_are_always_fully_grown() {
        let now = 1_700_000_000_000_i64;
        let decor = GrowthEntryInput {
            id: "d1".to_string(),
            kind: GardenEntryKind::Decor,
            planted_at_ms: Some(now),
            grows_seconds: 9_999,
            water_boost: 0.0,
        };
        assert_eq!(plant_growth(&decor, now), 1.0);
        // A memory planted before the app knew when: fully grown.
        assert_eq!(plant_growth(&plant(None, 60, 0.0), now), 1.0);
    }

    #[test]
    fn zero_grow_seconds_falls_back_to_sixty_instead_of_dividing_by_zero() {
        let now = 1_700_000_000_000_i64;
        let weird = plant(Some(now - 30_000), 0, 0.0);
        // Falls back to 60 s, so 30 s elapsed is half grown.
        assert!((plant_growth(&weird, now) - 0.5).abs() < 1e-9);
    }

    #[test]
    fn a_future_planting_instant_clamps_to_zero() {
        let now = 1_700_000_000_000_i64;
        let future = plant(Some(now + 60_000), 60, 0.0);
        assert_eq!(
            plant_growth(&future, now),
            0.0,
            "growth must stay within the 0..1 the schema promises"
        );
    }

    #[test]
    fn garden_growth_preserves_request_order_and_flags_maturity() {
        let now = 1_700_000_000_000_i64;
        let entries = vec![
            GrowthEntryInput { id: "a".into(), ..plant(Some(now - 60_000), 60, 0.0) },
            GrowthEntryInput { id: "b".into(), ..plant(Some(now - 10_000), 60, 0.0) },
        ];
        let out = garden_growth(&entries, now);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].id, "a");
        assert!(out[0].mature);
        assert_eq!(out[1].id, "b");
        assert!(!out[1].mature);
    }

    #[test]
    fn achievements_expose_every_unlocked_tier_and_progress_from_the_frontier() {
        // 3 peas: "First Pod" (1) and "First Pea" (2) are unlocked; the frontier
        // is 2 and the next tier is 5, so progress = (3-2)/(5-2) = 1/3.
        let out = compute_achievement_groups(&AchievementRequest {
            peas_count: 3,
            dates_count: 0,
            pinned_journey_days: None,
        });
        assert_eq!(out.groups.len(), 1, "only pod_growth has unlocked tiers");
        let growth = &out.groups[0];
        assert_eq!(growth.key, "pod_growth");
        assert_eq!(growth.tiers.len(), 2);
        assert_eq!(growth.tiers[0].label, "First Pod");
        assert_eq!(growth.tiers[1].label, "First Pea");
        assert!((growth.progress - 1.0 / 3.0).abs() < 1e-9);
    }

    #[test]
    fn a_completed_track_reports_progress_one() {
        let out = compute_achievement_groups(&AchievementRequest {
            peas_count: 10,
            dates_count: 4,
            pinned_journey_days: None,
        });
        let growth = out
            .groups
            .iter()
            .find(|g| g.key == "pod_growth")
            .expect("pod_growth must be present");
        assert_eq!(growth.tiers.len(), 4, "all four tiers unlocked");
        assert_eq!(growth.progress, 1.0);

        // journey_log has a single tier, so one date completes it.
        let journey = out
            .groups
            .iter()
            .find(|g| g.key == "journey_log")
            .expect("journey_log unlocks at 1 date");
        assert_eq!(journey.tiers.len(), 1);
        assert_eq!(journey.progress, 1.0);
    }

    #[test]
    fn zero_peas_still_unlocks_the_first_tier() {
        // The original's `peasCount || 1`: a pod always contains its creator.
        let out = compute_achievement_groups(&AchievementRequest {
            peas_count: 0,
            dates_count: 0,
            pinned_journey_days: None,
        });
        let growth = out
            .groups
            .iter()
            .find(|g| g.key == "pod_growth")
            .expect("pod_growth is unlocked even at zero");
        assert_eq!(growth.tiers.len(), 1);
        assert_eq!(growth.tiers[0].label, "First Pod");
    }

    #[test]
    fn the_time_together_track_is_omitted_without_a_pinned_date() {
        let without = compute_achievement_groups(&AchievementRequest {
            peas_count: 2,
            dates_count: 1,
            pinned_journey_days: None,
        });
        assert!(
            !without.groups.iter().any(|g| g.key == "time_together"),
            "no pinned date -> no Time Together track at all"
        );

        // 400 days: the 100-day and 1-year tiers are unlocked, next is 730.
        let with = compute_achievement_groups(&AchievementRequest {
            peas_count: 2,
            dates_count: 1,
            pinned_journey_days: Some(400),
        });
        let time = with
            .groups
            .iter()
            .find(|g| g.key == "time_together")
            .expect("400 days unlocks two tiers");
        assert_eq!(time.tiers.len(), 2);
        assert_eq!(time.tiers[1].label, "1 Year");
        // (400 - 365) / (730 - 365) = 35/365
        assert!((time.progress - 35.0 / 365.0).abs() < 1e-9);

        // Below the first tier the track is absent rather than empty.
        let early = compute_achievement_groups(&AchievementRequest {
            peas_count: 2,
            dates_count: 1,
            pinned_journey_days: Some(30),
        });
        assert!(!early.groups.iter().any(|g| g.key == "time_together"));
    }
}

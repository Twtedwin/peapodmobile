//! # Rule files: the shared contract, embedded at compile time
//!
//! ## Purpose
//! Every threshold this service uses -- distances, speeds, durations, XP
//! ladders, harmony weights, growth formulas -- lives in
//! `packages/shared/data/rules/*.json`, which is the single source of truth
//! shared by the Expo app, the Node API and this service. Those files are
//! pulled in here with `include_str!`, so:
//!
//! - The numbers are *compile-time constants sourced from the contract* rather
//!   than literals re-typed into Rust (which is how the three implementations
//!   would silently drift apart).
//! - A typo in a rule file is a build failure of the container, not a runtime
//!   surprise on the first request that happens to touch that value.
//! - The container needs no config files, no volumes and no network to know its
//!   own thresholds.
//!
//! ## Inputs
//! Four JSON documents, read from disk **at build time** by the compiler:
//! - `geo.json`          -> distance/speed/duration thresholds for location features
//! - `progression.json`  -> world levels, plot capacity formula, achievement tracks
//! - `decisions.json`    -> harmony formula, outcome ordering, stage mapping
//! - `garden.json`       -> plant growth formula and water boost
//!
//! The `include_str!` paths are relative to *this file*: from
//! `services/compute/src/rules.rs`, `../../../` is the repository root. This is
//! also why the Docker build context is the repo root (see `Dockerfile`) --
//! the rule files must exist next to the sources before `cargo build` runs.
//!
//! ## Outputs
//! Four `LazyLock` statics (`GEO`, `PROGRESSION`, `DECISIONS`, `GARDEN`) holding
//! typed, parsed structs. Parsing happens once, on first access, and panics on
//! malformed input -- `warm_up()` is called from `main()` so that panic happens
//! at start-up rather than mid-request.
//!
//! ## Who calls this
//! Every other module in this service. Nothing outside the service reads these
//! statics.
//!
//! ## A note on the JSON shape
//! The rule files are written to be read by humans, so they contain two things
//! a naive deserialiser trips over:
//!
//! 1. `_comment` keys (sometimes a string, sometimes an array of strings) that
//!    carry design rationale. Serde ignores unknown fields by default, so these
//!    simply never appear in the structs below -- do not add
//!    `deny_unknown_fields` to anything in this file.
//! 2. Many thresholds are wrapped as `{"value": N, "why": "..."}` instead of a
//!    bare number, so the justification travels with the number. Those map to
//!    [`Threshold<T>`], and callers read `.value`. The `why` text is preserved
//!    in the struct (and quoted inline at the point of use throughout this
//!    service) precisely because the reasoning matters as much as the number.

use std::collections::BTreeMap;
use std::sync::LazyLock;

use serde::Deserialize;

// ---------------------------------------------------------------------------
// Embedded documents
// ---------------------------------------------------------------------------

/// Raw text of `packages/shared/data/rules/geo.json`, baked into the binary.
const GEO_JSON: &str = include_str!("../../../packages/shared/data/rules/geo.json");
/// Raw text of `packages/shared/data/rules/progression.json`.
const PROGRESSION_JSON: &str = include_str!("../../../packages/shared/data/rules/progression.json");
/// Raw text of `packages/shared/data/rules/decisions.json`.
const DECISIONS_JSON: &str = include_str!("../../../packages/shared/data/rules/decisions.json");
/// Raw text of `packages/shared/data/rules/garden.json`.
const GARDEN_JSON: &str = include_str!("../../../packages/shared/data/rules/garden.json");

// ---------------------------------------------------------------------------
// Shared wrapper
// ---------------------------------------------------------------------------

/// A single tuned threshold together with the reason it has that value.
///
/// The rule files use `{"value": 150, "why": "matches the geofence entry
/// radius ..."}` for anything whose number was chosen rather than derived, so
/// the justification cannot be separated from the value by a refactor.
///
/// * `T` is whatever the JSON holds: `f64` for metres/speeds/ratios, `i64` for
///   millisecond durations, `usize` for window sizes.
/// * `why` defaults to an empty string so a threshold may omit it.
#[derive(Debug, Clone, Deserialize)]
pub struct Threshold<T> {
    /// The number itself, in the units named by the surrounding key
    /// (`*_m` metres, `*_ms` milliseconds, `*_mps` metres per second).
    pub value: T,
    /// Why this number, copied from the rule file. Never used for control flow.
    #[serde(default)]
    pub why: String,
}

// ---------------------------------------------------------------------------
// geo.json
// ---------------------------------------------------------------------------

/// Everything in `geo.json`. Field names are snake_case Rust; the `rename`
/// attributes carry the exact JSON keys (which mix camelCase with explicit
/// `_m` / `_ms` / `_mps` unit suffixes, so `rename_all` cannot express them).
#[derive(Debug, Clone, Deserialize)]
pub struct GeoRules {
    /// Mean Earth radius in metres, used by the haversine formula.
    #[serde(rename = "earthRadiusM")]
    pub earth_radius_m: f64,
    pub proximity: ProximityRules,
    pub geofence: GeofenceRules,
    #[serde(rename = "activityBands")]
    pub activity_bands: ActivityBandRules,
    #[serde(rename = "tripReconstruction")]
    pub trip_reconstruction: TripReconstructionRules,
    pub presence: PresenceRules,
    pub tracking: TrackingRules,
}

/// "How close is close" thresholds.
#[derive(Debug, Clone, Deserialize)]
pub struct ProximityRules {
    /// Below this two members render as "Together" instead of a distance.
    #[serde(rename = "togetherThreshold_m")]
    pub together_threshold_m: Threshold<f64>,
    /// How close counts as being "at" a saved place.
    #[serde(rename = "placeRadius_m")]
    pub place_radius_m: Threshold<f64>,
}

/// Geofence radii. Present for completeness; this service only reads them in
/// tests, because entering/leaving a fence is stateful and therefore belongs to
/// `services/api`, not here.
#[derive(Debug, Clone, Deserialize)]
pub struct GeofenceRules {
    #[serde(rename = "enterRadius_m")]
    pub enter_radius_m: Threshold<f64>,
    #[serde(rename = "exitRadius_m")]
    pub exit_radius_m: Threshold<f64>,
}

/// Speed cut-offs that turn a raw m/s reading into a human label.
#[derive(Debug, Clone, Deserialize)]
pub struct ActivityBandRules {
    #[serde(rename = "stationaryBelow_mps")]
    pub stationary_below_mps: Threshold<f64>,
    #[serde(rename = "walkingBelow_mps")]
    pub walking_below_mps: Threshold<f64>,
    #[serde(rename = "cyclingBelow_mps")]
    pub cycling_below_mps: Threshold<f64>,
    #[serde(rename = "drivingThreshold_mps")]
    pub driving_threshold_mps: Threshold<f64>,
}

/// The trip-reconstruction pipeline's thresholds, in pipeline order.
#[derive(Debug, Clone, Deserialize)]
pub struct TripReconstructionRules {
    /// Ground speed above which a fix is a bad GPS lock rather than movement.
    #[serde(rename = "maxPlausibleSpeed_mps")]
    pub max_plausible_speed_mps: Threshold<f64>,
    /// A fix must be both implausibly fast AND this far away to be discarded.
    #[serde(rename = "teleportMinJump_m")]
    pub teleport_min_jump_m: Threshold<f64>,
    /// How far a fix must be from both neighbours to be a V-spike suspect.
    #[serde(rename = "spikeNeighbourDist_m")]
    pub spike_neighbour_dist_m: Threshold<f64>,
    /// Neighbours closer to each other than this fraction of the suspect's
    /// distance confirms the V-spike.
    #[serde(rename = "spikeCollapseRatio")]
    pub spike_collapse_ratio: Threshold<f64>,
    /// Interior fixes with a worse accuracy radius than this are dropped.
    #[serde(rename = "poorAccuracyCutoff_m")]
    pub poor_accuracy_cutoff_m: Threshold<f64>,
    /// A gap longer than this ends a run (tracking paused).
    #[serde(rename = "tripGap_ms")]
    pub trip_gap_ms: Threshold<i64>,
    /// Staying inside this radius for `stop_duration_ms` counts as an arrival.
    #[serde(rename = "stopRadius_m")]
    pub stop_radius_m: Threshold<f64>,
    /// How long a member must stay put for the stop to be a trip boundary.
    #[serde(rename = "stopDuration_ms")]
    pub stop_duration_ms: Threshold<i64>,
    /// Once within this distance of the final fix, the member has arrived.
    #[serde(rename = "arrivalRadius_m")]
    pub arrival_radius_m: Threshold<f64>,
    /// Minimum path length before a run counts as a trip at all.
    #[serde(rename = "minTripDistance_m")]
    pub min_trip_distance_m: Threshold<f64>,
    /// A run must also have reached this far from its start.
    #[serde(rename = "minNetDisplacement_m")]
    pub min_net_displacement_m: Threshold<f64>,
    /// A peak above this means driving, not cycling.
    #[serde(rename = "drivingMaxSpeed_mps")]
    pub driving_max_speed_mps: Threshold<f64>,
    /// A sustained average above this also means driving.
    #[serde(rename = "drivingAvgSpeed_mps")]
    pub driving_avg_speed_mps: Threshold<f64>,
    /// Half-window of the moving average (4 -> a 9-point window).
    #[serde(rename = "smoothingHalfWindow")]
    pub smoothing_half_window: Threshold<usize>,
    /// Spacing when reducing a route to router waypoints.
    #[serde(rename = "routerWaypointGap_m")]
    pub router_waypoint_gap_m: Threshold<f64>,
}

/// Presence rules. Stateful (needs "now" and the ping table), so only the
/// number is exposed here; the decision lives in `services/api`.
#[derive(Debug, Clone, Deserialize)]
pub struct PresenceRules {
    #[serde(rename = "onlineThreshold_ms")]
    pub online_threshold_ms: Threshold<i64>,
}

/// Device-side tracking rules. Included so the whole file round-trips and so a
/// future endpoint can read them without touching this module again.
#[derive(Debug, Clone, Deserialize)]
pub struct TrackingRules {
    #[serde(rename = "minMovementToPing_m")]
    pub min_movement_to_ping_m: Threshold<f64>,
    #[serde(rename = "heartbeatInterval_ms")]
    pub heartbeat_interval_ms: Threshold<i64>,
    #[serde(rename = "dwellClusterRadius_m")]
    pub dwell_cluster_radius_m: Threshold<f64>,
    #[serde(rename = "dwellSettle_ms")]
    pub dwell_settle_ms: Threshold<i64>,
}

// ---------------------------------------------------------------------------
// progression.json
// ---------------------------------------------------------------------------

/// The subset of `progression.json` this service needs.
///
/// `xpRewards`, `peanutEarnRules`, `startingBalances` and `milestoneDays` are
/// intentionally absent: awarding XP and Peanuts is a stateful write, so it
/// belongs to `services/api`. Serde ignores those keys.
#[derive(Debug, Clone, Deserialize)]
pub struct ProgressionRules {
    /// The six world levels, ascending by `xp`.
    #[serde(rename = "worldLevels")]
    pub world_levels: Vec<WorldLevel>,
    #[serde(rename = "gardenPlotCapacity")]
    pub garden_plot_capacity: PlotCapacityRule,
    /// Tiered achievement tracks, each bound to one input metric.
    #[serde(rename = "achievementTracks")]
    pub achievement_tracks: Vec<AchievementTrackRule>,
}

/// One rung of the world ladder.
#[derive(Debug, Clone, Deserialize)]
pub struct WorldLevel {
    pub level: i64,
    pub name: String,
    pub description: String,
    /// Cumulative XP at which this level is reached.
    pub xp: i64,
}

/// `capacity = min(max, base + max(1, level) * perLevel)`.
#[derive(Debug, Clone, Deserialize)]
pub struct PlotCapacityRule {
    pub base: i64,
    #[serde(rename = "perLevel")]
    pub per_level: i64,
    pub max: i64,
}

/// A tiered achievement track and the request field that drives it.
#[derive(Debug, Clone, Deserialize)]
pub struct AchievementTrackRule {
    pub key: String,
    pub title: String,
    /// Name of the metric this track measures. Matches a field of
    /// `AchievementRequest`: `peas_count`, `dates_count` or
    /// `pinned_journey_days`.
    pub metric: String,
    /// Tiers in ascending threshold order.
    pub tiers: Vec<AchievementTierRule>,
}

/// One tier of a track.
#[derive(Debug, Clone, Deserialize)]
pub struct AchievementTierRule {
    pub threshold: i64,
    pub label: String,
    pub description: String,
}

// ---------------------------------------------------------------------------
// decisions.json
// ---------------------------------------------------------------------------

/// The subset of `decisions.json` this service needs.
///
/// `categories`, `outcomeCopy`, `boardSections`, `compromiseFallbacks` and
/// `aiSuggestionInterleave` are presentation concerns owned by the app, and
/// `outcomeRules` is documentation of an order that must be expressed in code
/// (see `decisions::outcome_of`), so none of them are modelled here.
#[derive(Debug, Clone, Deserialize)]
pub struct DecisionRules {
    pub harmony: HarmonyRules,
    #[serde(rename = "stageMapping")]
    pub stage_mapping: StageMappingRules,
}

/// Weights of the harmony formula:
/// `((want + maybe*maybeWeight) / total) * 100 - (no / total) * noPenaltyWeight`
/// then `+creatorWantedBonus`, `-aiSourcePenalty`, then clamped.
#[derive(Debug, Clone, Deserialize)]
pub struct HarmonyRules {
    /// A "maybe" is genuine partial interest, so it counts as half support.
    #[serde(rename = "maybeWeight")]
    pub maybe_weight: f64,
    /// A "no" costs this much on top of contributing nothing: one person
    /// actively opposed matters more than one person merely absent.
    #[serde(rename = "noPenaltyWeight")]
    pub no_penalty_weight: f64,
    #[serde(rename = "creatorWantedBonus")]
    pub creator_wanted_bonus: Threshold<f64>,
    #[serde(rename = "aiSourcePenalty")]
    pub ai_source_penalty: Threshold<f64>,
    pub clamp: ClampRule,
}

/// Inclusive bounds applied to harmony before rounding.
#[derive(Debug, Clone, Deserialize)]
pub struct ClampRule {
    pub min: f64,
    pub max: f64,
}

/// Outcome -> pipeline stage, plus the legacy stage names that collapse onto a
/// modern one. The JSON keys are already snake_case, so no renames are needed.
#[derive(Debug, Clone, Deserialize)]
pub struct StageMappingRules {
    pub deciding: String,
    pub everyone_in: String,
    pub work_it_out: String,
    pub maybe_later: String,
    pub not_for_us: String,
    /// `discussing` and `becoming_real` both mean "the pod agreed", which is
    /// now simply `planned` -- there is no separate planning-together stage.
    #[serde(rename = "legacyAliases")]
    pub legacy_aliases: BTreeMap<String, String>,
}

// ---------------------------------------------------------------------------
// garden.json
// ---------------------------------------------------------------------------

/// The subset of `garden.json` this service needs: only the growth formula.
/// Catalogs (species, seeds, decor, crops) are content owned by the app and the
/// API, and are not needed to answer "how grown is this plant right now".
#[derive(Debug, Clone, Deserialize)]
pub struct GardenRules {
    pub growth: GrowthRules,
}

/// `growth = min(1, elapsedSeconds / growsSeconds + waterBoost)`.
#[derive(Debug, Clone, Deserialize)]
pub struct GrowthRules {
    /// How far one watering nudges a plant along, as a fraction of its total
    /// grow time.
    #[serde(rename = "waterBoostPerWatering")]
    pub water_boost_per_watering: Threshold<f64>,
    /// Upper bound on the accumulated water boost, so repeated watering cannot
    /// instantly mature a plant.
    #[serde(rename = "waterBoostCap")]
    pub water_boost_cap: f64,
}

// ---------------------------------------------------------------------------
// Lazily parsed statics
// ---------------------------------------------------------------------------

/// Parsed `geo.json`. Panics on first access if the embedded file is malformed.
pub static GEO: LazyLock<GeoRules> = LazyLock::new(|| {
    serde_json::from_str(GEO_JSON).expect("packages/shared/data/rules/geo.json is malformed")
});

/// Parsed `progression.json`.
pub static PROGRESSION: LazyLock<ProgressionRules> = LazyLock::new(|| {
    serde_json::from_str(PROGRESSION_JSON)
        .expect("packages/shared/data/rules/progression.json is malformed")
});

/// Parsed `decisions.json`.
pub static DECISIONS: LazyLock<DecisionRules> = LazyLock::new(|| {
    serde_json::from_str(DECISIONS_JSON)
        .expect("packages/shared/data/rules/decisions.json is malformed")
});

/// Parsed `garden.json`.
pub static GARDEN: LazyLock<GardenRules> = LazyLock::new(|| {
    serde_json::from_str(GARDEN_JSON).expect("packages/shared/data/rules/garden.json is malformed")
});

/// Forces all four rule documents to parse.
///
/// Called once from `main()` before the listener is bound. Without this, a
/// malformed rule file would only blow up on the first request that happened to
/// touch it -- with it, the container refuses to start, which is what a
/// deployment pipeline can actually see.
///
/// Returns a one-line summary suitable for a start-up log message.
pub fn warm_up() -> String {
    let levels = GEO.trip_reconstruction.trip_gap_ms.value;
    let world_levels = PROGRESSION.world_levels.len();
    let tracks = PROGRESSION.achievement_tracks.len();
    let maybe_weight = DECISIONS.harmony.maybe_weight;
    let water = GARDEN.growth.water_boost_per_watering.value;
    format!(
        "rules loaded (tripGap_ms={levels}, worldLevels={world_levels}, achievementTracks={tracks}, maybeWeight={maybe_weight}, waterBoostPerWatering={water})"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_rule_file_parses() {
        // Touching each static forces its LazyLock initialiser to run. If any
        // rule file drifts from the structs above, this test fails at build
        // time in CI rather than at 3am in production.
        let _ = warm_up();
    }

    #[test]
    fn geo_thresholds_match_the_contract() {
        // Spot-check the numbers the trip pipeline is most sensitive to, so an
        // accidental edit to geo.json is caught here.
        let t = &GEO.trip_reconstruction;
        assert_eq!(GEO.earth_radius_m, 6_371_000.0);
        assert_eq!(t.max_plausible_speed_mps.value, 35.0);
        assert_eq!(t.teleport_min_jump_m.value, 80.0);
        assert_eq!(t.spike_neighbour_dist_m.value, 50.0);
        assert_eq!(t.spike_collapse_ratio.value, 0.5);
        assert_eq!(t.poor_accuracy_cutoff_m.value, 50.0);
        assert_eq!(t.trip_gap_ms.value, 720_000);
        assert_eq!(t.stop_radius_m.value, 80.0);
        assert_eq!(t.stop_duration_ms.value, 300_000);
        assert_eq!(t.arrival_radius_m.value, 80.0);
        assert_eq!(t.min_trip_distance_m.value, 80.0);
        assert_eq!(t.min_net_displacement_m.value, 60.0);
        assert_eq!(t.driving_max_speed_mps.value, 7.0);
        assert_eq!(t.driving_avg_speed_mps.value, 6.0);
        assert_eq!(t.smoothing_half_window.value, 4);
        assert_eq!(t.router_waypoint_gap_m.value, 250.0);
        assert_eq!(GEO.proximity.place_radius_m.value, 150.0);
        assert_eq!(GEO.proximity.together_threshold_m.value, 100.0);
    }

    #[test]
    fn why_text_survives_parsing() {
        // The justification is the point of the {value, why} wrapper: if it
        // stopped being carried through, the numbers would lose their rationale.
        assert!(!GEO.trip_reconstruction.min_net_displacement_m.why.is_empty());
    }

    #[test]
    fn world_levels_are_ascending_and_complete() {
        // level_from_xp() walks this list in order and relies on ascending xp.
        let levels = &PROGRESSION.world_levels;
        assert_eq!(levels.len(), 6);
        for pair in levels.windows(2) {
            assert!(pair[0].xp < pair[1].xp, "worldLevels must ascend by xp");
            assert!(pair[0].level < pair[1].level, "worldLevels must ascend by level");
        }
        assert_eq!(levels[0].xp, 0, "level 1 must start at 0 xp");
    }

    #[test]
    fn achievement_tiers_are_ascending() {
        // build_group() takes the LAST unlocked tier as the frontier, which is
        // only the highest one if thresholds ascend.
        for track in &PROGRESSION.achievement_tracks {
            for pair in track.tiers.windows(2) {
                assert!(
                    pair[0].threshold < pair[1].threshold,
                    "tiers of {} must ascend",
                    track.key
                );
            }
        }
    }

    #[test]
    fn harmony_and_stage_rules_match_the_contract() {
        let h = &DECISIONS.harmony;
        assert_eq!(h.maybe_weight, 0.5);
        assert_eq!(h.no_penalty_weight, 15.0);
        assert_eq!(h.creator_wanted_bonus.value, 4.0);
        assert_eq!(h.ai_source_penalty.value, 4.0);
        assert_eq!(h.clamp.min, 0.0);
        assert_eq!(h.clamp.max, 100.0);

        let s = &DECISIONS.stage_mapping;
        assert_eq!(s.everyone_in, "planned");
        assert_eq!(s.work_it_out, "considering");
        assert_eq!(s.not_for_us, "archived");
        assert_eq!(s.legacy_aliases.get("discussing").map(String::as_str), Some("planned"));
        assert_eq!(
            s.legacy_aliases.get("becoming_real").map(String::as_str),
            Some("planned")
        );
    }

    #[test]
    fn garden_growth_rules_match_the_contract() {
        assert_eq!(GARDEN.growth.water_boost_per_watering.value, 0.3);
        assert_eq!(GARDEN.growth.water_boost_cap, 1.0);
    }
}

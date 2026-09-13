//! # Wire DTOs
//!
//! ## Purpose
//! One Rust type per request and response object in
//! `packages/shared/schemas/compute.schema.json`, plus the itinerary types it
//! borrows from `packages/shared/schemas/domain.schema.json`. Field names here
//! are byte-for-byte identical to the schema (snake_case, no serde renaming of
//! DTO fields), because this shape is the *only* contract between
//! `services/api` and this service, and `services/api` also ships a pure
//! TypeScript re-implementation of every algorithm here. If a field name drifts,
//! the two implementations stop being substitutable.
//!
//! ## Inputs / outputs
//! Inputs are deserialised from JSON request bodies; outputs are serialised into
//! JSON response bodies. Nothing in this module computes anything -- the
//! algorithms live in `geo`, `trips`, `decisions`, `progression`, `wallet` and
//! `itinerary`.
//!
//! ## Who calls this
//! `services/api` over a private network. There is no public client.
//!
//! ## Conventions enforced here
//! - **Money is always integer minor units** (`i64` cents). No `f64` ever holds
//!   an amount; see `wallet.rs` for how percentages become exact integers.
//! - **Timestamps are epoch milliseconds** (`*_at_ms: i64`). Date *strings* only
//!   appear where the schema says `format: date` (an itinerary day's calendar
//!   date), never inside a loop.
//! - Schema `default:` becomes `#[serde(default)]` (or `default = "fn"` when the
//!   default is not `Default::default()`), so an omitted field behaves exactly
//!   as the schema promises rather than 400-ing.
//! - Schema `type: ["x", "null"]` becomes `Option<T>`.
//! - Schema `enum:` becomes a Rust enum, so an invalid value is rejected by the
//!   deserialiser (surfacing as a `400` via `AppError`) instead of flowing into
//!   the algorithms as an unexpected string.

use serde::{Deserialize, Serialize};

use crate::rules::GEO;

// ---------------------------------------------------------------------------
// serde default helpers
//
// Each of these exists because the schema declares a non-zero default. Where
// the same number also appears in a rule file, the helper reads it from there
// rather than repeating the literal.
// ---------------------------------------------------------------------------

/// Default `radius_m` for `POST /geo/nearest-place`.
///
/// Sourced from `geo.json -> proximity.placeRadius_m` (150 m), whose `why` is:
/// "How close counts as being 'at' a saved place. Matches the geofence entry
/// radius so 'at a place' and 'inside the fence' can never disagree."
fn default_place_radius_m() -> f64 {
    GEO.proximity.place_radius_m.value
}

/// Default `grows_seconds` for a garden entry: 60 s, from the schema's
/// `GrowthEntryInput.grows_seconds` default (and `GardenEntry.grows_seconds` in
/// the domain schema). A minute is the shortest grow time any catalog item uses.
fn default_grows_seconds() -> i64 {
    60
}

/// Default `peas_count`: 1. A pod always contains at least the member asking,
/// which is what makes the "First Pod" tier unlockable on day one.
fn default_peas_count() -> i64 {
    1
}

/// Default `travellers`: 2. Peapod's smallest pod is a pair.
fn default_travellers() -> i64 {
    2
}

/// Default `currency`: SGD, matching every `currency` default in the domain
/// schema. Only ever echoed back on cost lines -- this service does no FX.
fn default_currency() -> String {
    "SGD".to_string()
}

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/// A bare coordinate pair in WGS84 degrees.
#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
pub struct GeoPoint {
    pub latitude: f64,
    pub longitude: f64,
}

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------

/// Liveness payload. Deliberately contains no dependency checks: this service
/// has no database, no cache and no upstreams, so "the process is answering" is
/// the whole of its health.
#[derive(Debug, Clone, Serialize)]
pub struct HealthResponse {
    /// Always the literal `"ok"` (the schema pins it to that one value).
    pub status: &'static str,
    /// Service name, so a shared load balancer log is unambiguous.
    pub service: &'static str,
    /// Crate version from `Cargo.toml`, baked in at compile time.
    pub version: &'static str,
}

// ---------------------------------------------------------------------------
// POST /geo/activity
// ---------------------------------------------------------------------------

/// Body of `POST /geo/activity`: `{"speed": 4.2}`.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct ActivitySpeedRequest {
    /// Metres per second. Defaults to 0 (stationary) when omitted, matching the
    /// original JavaScript's `speedMs || 0`.
    #[serde(default)]
    pub speed: f64,
}

/// A human label for a speed reading.
///
/// Phones do not expose OS-level activity recognition to this layer, so speed
/// is the only signal available; `driving` is broken out separately because the
/// map uses it to decide whether to road-snap a line.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ActivityClassification {
    /// One of `Stationary`, `Walking`, `Cycling`, `Driving`.
    pub label: &'static str,
    pub driving: bool,
}

// ---------------------------------------------------------------------------
// POST /geo/nearest-place
// ---------------------------------------------------------------------------

/// One saved place, reduced to the fields the proximity check reads.
#[derive(Debug, Clone, Deserialize)]
pub struct PlaceInput {
    pub id: String,
    pub latitude: f64,
    pub longitude: f64,
}

/// Find which saved place, if any, a member is currently at.
#[derive(Debug, Clone, Deserialize)]
pub struct NearestPlaceRequest {
    pub location: GeoPoint,
    /// Candidate places, in the caller's own order. Order is significant --
    /// see `geo::nearest_place`.
    pub places: Vec<PlaceInput>,
    /// Metres. Defaults to the geofence entry radius so "at a place" and
    /// "inside the fence" agree.
    #[serde(default = "default_place_radius_m")]
    pub radius_m: f64,
}

/// The matched place, or nulls when the member is not at any of them.
#[derive(Debug, Clone, Serialize)]
pub struct NearestPlaceResponse {
    pub place_id: Option<String>,
    /// Metres from the member to that place. Null exactly when `place_id` is.
    pub distance_m: Option<f64>,
}

// ---------------------------------------------------------------------------
// POST /trips/reconstruct
// ---------------------------------------------------------------------------

/// One GPS fix as fed to trip reconstruction.
///
/// `Copy` on purpose: the pipeline in `trips.rs` builds several filtered vectors
/// of these, and copying 40 bytes is cheaper and far simpler to read than
/// threading lifetimes through six stages.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct PingInput {
    pub latitude: f64,
    pub longitude: f64,
    /// Epoch milliseconds, UTC. Milliseconds (not a date string) so the hot
    /// loops never parse a date -- re-parsing dates per ping per window is what
    /// made the original JavaScript freeze on long ping histories.
    pub recorded_at_ms: i64,
    /// Metres per second, as reported by the device. Defaults to 0.
    #[serde(default)]
    pub speed: f64,
    /// Accuracy radius in metres. Defaults to 0, which is treated as "good"
    /// exactly like the original (`typeof accuracy === "number" ? ... : 0`).
    #[serde(default)]
    pub accuracy: f64,
    /// The tracker's own driving flag. Trusted when set.
    #[serde(default)]
    pub is_driving: bool,
}

/// Reconstruct the most recent confirmed journey from one member's history.
#[derive(Debug, Clone, Deserialize)]
pub struct ReconstructTripRequest {
    /// Need not be sorted; the service sorts by `recorded_at_ms` first.
    pub pings: Vec<PingInput>,
}

/// A drawable journey.
#[derive(Debug, Clone, Serialize)]
pub struct ReconstructedTrip {
    /// Ordered `[latitude, longitude]` pairs: the smoothed polyline with the
    /// stationary tail at the destination trimmed off.
    pub points: Vec<[f64; 2]>,
    /// Epoch ms of the first point of the drawn route.
    pub start_at_ms: i64,
    /// Epoch ms of the arrival fix (the last point of the drawn route).
    pub arrival_at_ms: i64,
    /// Total path length along the polyline, kilometres.
    pub distance_km: f64,
    /// Straight-line metres from first to last point. Distinguishes a real
    /// journey from stationary GPS jitter.
    pub net_displacement_m: f64,
    /// Farthest the member ever got from the start, metres. Catches a round trip
    /// that returns home, whose net displacement is near zero.
    pub max_dist_from_start_m: f64,
    /// Path length divided by duration, metres per second.
    pub avg_speed_ms: f64,
    /// True when the run looks like a car trip, so the caller may road-snap it.
    pub is_driving: bool,
}

/// The last confirmed trip, or `null`.
#[derive(Debug, Clone, Serialize)]
pub struct ReconstructTripResponse {
    /// `None` when the member has not travelled far enough to confirm a trip. A
    /// journey in progress does not replace the previous one, so no false line
    /// flashes onto the map while a real trip is still building up.
    pub trip: Option<ReconstructedTrip>,
}

// ---------------------------------------------------------------------------
// POST /decisions/evaluate
// ---------------------------------------------------------------------------

/// A member's stance on an idea.
///
/// Deliberately three-valued: `maybe` is a real answer, not a missing one, and
/// it is what routes an idea to "maybe later" instead of a compromise
/// negotiation.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Stance {
    Want,
    Maybe,
    No,
}

/// Where an idea came from. AI-sourced ideas take a small harmony penalty so a
/// human's proposal outranks a machine's at equal support.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SourceType {
    User,
    Ai,
}

impl Default for SourceType {
    /// Schema default for `source_type`.
    fn default() -> Self {
        SourceType::User
    }
}

/// Lifecycle status of the idea record itself (not its vote outcome).
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DecisionStatus {
    Active,
    Archived,
    Converted,
}

impl Default for DecisionStatus {
    /// Schema default for `status`.
    fn default() -> Self {
        DecisionStatus::Active
    }
}

/// One vote.
#[derive(Debug, Clone, Deserialize)]
pub struct DecisionMemberVote {
    pub voter_id: String,
    pub stance: Stance,
}

/// Evaluate one idea against its pod.
#[derive(Debug, Clone, Deserialize)]
pub struct EvaluateDecisionRequest {
    /// The full membership. This is what makes "everyone has voted" decidable:
    /// counts are taken over members, so a vote from a non-member is ignored
    /// and a member who has not voted is genuinely missing.
    pub member_ids: Vec<String>,
    pub votes: Vec<DecisionMemberVote>,
    /// The creator's pre-vote, recorded at submission so they never swipe their
    /// own idea. Worth a small harmony bonus when it is `want`.
    #[serde(default)]
    pub creator_stance: Option<Stance>,
    #[serde(default)]
    pub source_type: SourceType,
    #[serde(default)]
    pub status: DecisionStatus,
    /// When set, wins over the computed stage. Free-form in the schema; see
    /// `decisions::stage_of` for how unknown values are handled.
    #[serde(default)]
    pub stage_override: Option<String>,
}

/// The five possible group outcomes.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    /// Not everyone has responded yet, so nothing is revealed.
    Deciding,
    /// Unanimous enthusiasm. Becomes a real plan with no further negotiation.
    EveryoneIn,
    /// Genuinely divided. The only outcome that opens the compromise flow.
    WorkItOut,
    /// Lukewarm across the board.
    MaybeLater,
    /// Enough active opposition that it is archived.
    NotForUs,
}

/// Where an idea sits in the pipeline.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Deciding,
    /// The "Work It Out" bucket for a divided pod.
    Considering,
    MaybeLater,
    Planned,
    Archived,
    Converted,
}

impl Stage {
    /// Parses one of the six stage names as written in `decisions.json`'s
    /// `stageMapping` (and in the domain schema's `IdeaStage` enum).
    ///
    /// Returns `None` for anything else, which is how an unrecognised
    /// `stage_override` gets ignored rather than smuggled into a response field
    /// the schema constrains to these six values.
    pub fn from_contract_str(raw: &str) -> Option<Stage> {
        match raw {
            "deciding" => Some(Stage::Deciding),
            "considering" => Some(Stage::Considering),
            "maybe_later" => Some(Stage::MaybeLater),
            "planned" => Some(Stage::Planned),
            "archived" => Some(Stage::Archived),
            "converted" => Some(Stage::Converted),
            _ => None,
        }
    }
}

/// The aggregate.
///
/// Callers must not reveal any of these counts to a member until `all_voted` is
/// true -- hiding individual and aggregate support until everybody has answered
/// is the core fairness rule of the feature, and it is enforced in
/// `services/api`, not here.
#[derive(Debug, Clone, Serialize)]
pub struct EvaluateDecisionResponse {
    pub want: i64,
    pub maybe: i64,
    pub no: i64,
    /// Pod size (`member_ids.len()`), not the number of votes.
    pub total: i64,
    /// How many *members* have voted.
    pub voted_count: i64,
    pub all_voted: bool,
    pub outcome: Outcome,
    pub stage: Stage,
    /// Rounded percentage, clamped to 0..100.
    pub harmony: i64,
}

// ---------------------------------------------------------------------------
// POST /progression/level
// ---------------------------------------------------------------------------

/// Ask where a pod sits on the world ladder.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct LevelRequest {
    /// Total XP earned by the pod. Never negative (validated in the handler).
    pub xp: i64,
}

/// Where a pod sits on the six-level progression, plus what it takes to reach
/// the next one.
#[derive(Debug, Clone, Serialize)]
pub struct LevelResponse {
    pub level: i64,
    pub name: String,
    pub description: String,
    /// XP threshold of the level the pod currently occupies.
    pub current_level_xp: i64,
    /// XP threshold of the next level, or `None` at max level.
    pub next_level_xp: Option<i64>,
    /// Fraction of the way to the next level, 0..1. Always 1 at max level.
    pub progress: f64,
    /// Garden slots unlocked at this level.
    pub plot_capacity: i64,
}

// ---------------------------------------------------------------------------
// POST /progression/garden-growth
// ---------------------------------------------------------------------------

/// A garden slot holds either a plant (grows over time) or a decoration
/// (cosmetic, always fully grown).
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GardenEntryKind {
    Plant,
    Decor,
}

impl Default for GardenEntryKind {
    /// Schema default for `kind`.
    fn default() -> Self {
        GardenEntryKind::Plant
    }
}

/// One garden entry to evaluate.
#[derive(Debug, Clone, Deserialize)]
pub struct GrowthEntryInput {
    pub id: String,
    #[serde(default)]
    pub kind: GardenEntryKind,
    /// Epoch ms the plant was planted. `None` means a pre-seeded living record
    /// of a past memory, which counts as fully grown.
    #[serde(default)]
    pub planted_at_ms: Option<i64>,
    /// Seconds of real elapsed time from planting to maturity.
    #[serde(default = "default_grows_seconds")]
    pub grows_seconds: i64,
    /// Additive growth bonus from watering, 0..1.
    #[serde(default)]
    pub water_boost: f64,
}

/// Evaluate a whole garden at one instant.
#[derive(Debug, Clone, Deserialize)]
pub struct GardenGrowthRequest {
    pub entries: Vec<GrowthEntryInput>,
    /// Evaluation instant in epoch ms, supplied by the caller so results are
    /// reproducible in tests. This service never reads its own clock.
    pub now_ms: i64,
}

/// How grown one entry is.
#[derive(Debug, Clone, Serialize)]
pub struct GrowthResult {
    pub id: String,
    /// 0..1.
    pub growth: f64,
    /// True at growth 1.0, when the plant may be harvested.
    pub mature: bool,
}

/// Growth for every requested entry, in request order.
#[derive(Debug, Clone, Serialize)]
pub struct GardenGrowthResponse {
    pub growth: Vec<GrowthResult>,
}

// ---------------------------------------------------------------------------
// POST /progression/achievements
// ---------------------------------------------------------------------------

/// The three counters that drive the achievement tracks.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct AchievementRequest {
    /// Pod size. Defaults to 1 (a pod always has at least its creator).
    #[serde(default = "default_peas_count")]
    pub peas_count: i64,
    /// Number of dates/activities logged.
    #[serde(default)]
    pub dates_count: i64,
    /// Days since the pod's earliest pinned count-up date. `None` when the pod
    /// has not pinned one, in which case the "Time Together" track is omitted
    /// entirely rather than shown at zero.
    #[serde(default)]
    pub pinned_journey_days: Option<i64>,
}

/// One tier of a track.
#[derive(Debug, Clone, Serialize)]
pub struct AchievementTier {
    pub threshold: i64,
    pub label: String,
    pub description: String,
}

/// A tiered track with every tier already unlocked, so the UI can page back
/// through the pod's history rather than showing only the latest badge.
#[derive(Debug, Clone, Serialize)]
pub struct AchievementGroup {
    pub key: String,
    pub title: String,
    /// Unlocked tiers only, ascending.
    pub tiers: Vec<AchievementTier>,
    /// Progress from the frontier tier toward the next one, 0..1. Exactly 1
    /// when the track is complete.
    pub progress: f64,
}

/// Only tracks with at least one unlocked tier appear.
#[derive(Debug, Clone, Serialize)]
pub struct AchievementResponse {
    pub groups: Vec<AchievementGroup>,
}

// ---------------------------------------------------------------------------
// POST /wallet/split
// ---------------------------------------------------------------------------

/// One party's percentage share.
#[derive(Debug, Clone, Deserialize)]
pub struct SplitShare {
    pub party_id: String,
    /// 0..100. Floating point on the wire because that is how the app stores a
    /// bill's `split_percent`, but it never touches the output amounts -- see
    /// `wallet::split_amount`.
    pub percent: f64,
}

/// Split an amount across members by percentage.
#[derive(Debug, Clone, Deserialize)]
pub struct SplitRequest {
    /// Integer minor units (cents). Never a float: a bill split must not be
    /// able to lose or invent a fraction of a cent.
    pub amount_minor: i64,
    pub shares: Vec<SplitShare>,
}

/// One party's exact allocation.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SplitAllocation {
    pub party_id: String,
    pub amount_minor: i64,
}

/// Allocations plus their sum.
#[derive(Debug, Clone, Serialize)]
pub struct SplitResponse {
    /// Same order as the request's `shares`.
    pub allocations: Vec<SplitAllocation>,
    /// Sum of allocations. Guaranteed equal to the requested `amount_minor`.
    pub total_minor: i64,
}

// ---------------------------------------------------------------------------
// POST /itinerary/generate
// ---------------------------------------------------------------------------

/// How busy each day should be.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Pace {
    Relaxed,
    Balanced,
    Packed,
}

impl Default for Pace {
    /// Schema default for `pace`.
    fn default() -> Self {
        Pace::Balanced
    }
}

impl Pace {
    /// How many *sightseeing* activities a full day gets at this pace.
    ///
    /// Travel days (arrival, intercity transit, departure) get one fewer,
    /// because a flight or a train plus a hotel change eats a slot.
    pub fn activity_slots(self) -> usize {
        match self {
            Pace::Relaxed => 2,
            Pace::Balanced => 3,
            Pace::Packed => 4,
        }
    }
}

/// Which price column of the travel dataset to read.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BudgetTier {
    Budget,
    Mid,
    Luxury,
}

impl Default for BudgetTier {
    /// Schema default for `budget_tier`.
    fn default() -> Self {
        BudgetTier::Mid
    }
}

/// The direction a pod gave the planner.
///
/// The pod chooses destination, dates, pace, style and budget; the planner
/// builds the whole connected trip from flights through to the return leg.
#[derive(Debug, Clone, Deserialize)]
pub struct ItineraryRequest {
    /// One or more country ids or names. Matched case-insensitively against the
    /// travel dataset; unknown entries still produce a usable plan (see
    /// `itinerary.rs`).
    pub countries: Vec<String>,
    /// Optional narrower regions/cities within those countries.
    #[serde(default)]
    pub regions: Vec<String>,
    /// Trip length in days, 1..=30.
    pub days: i64,
    #[serde(default = "default_travellers")]
    pub travellers: i64,
    /// Travel-style tags such as `food`, `nature`, `relaxed`. Used to rank
    /// candidate activities and to word the personalisation note.
    #[serde(default)]
    pub personalities: Vec<String>,
    #[serde(default)]
    pub pace: Pace,
    #[serde(default)]
    pub budget_tier: BudgetTier,
    /// `YYYY-MM-DD`. When present, each day carries a real calendar date.
    #[serde(default)]
    pub start_date: Option<String>,
    /// Free-text things the pod insists on; boosts matching activities.
    #[serde(default)]
    pub must_see: Vec<String>,
    /// Free-text things to keep out; matching activities are dropped.
    #[serde(default)]
    pub avoid: Vec<String>,
    #[serde(default = "default_currency")]
    pub currency: String,
    /// Optional deterministic seed. Supplying one makes generation reproducible,
    /// which the tests rely on. When absent, a seed is derived from the request
    /// itself, so the same request still yields the same itinerary.
    #[serde(default)]
    pub seed: Option<i64>,
}

/// What kind of itinerary entry this is. `flight` and `train` entries are
/// `locked`: the editor must refuse to reorder them because everything else on
/// the day is timed around them.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ActivityKind {
    Flight,
    Transfer,
    Hotel,
    Activity,
    Meal,
    Train,
    Free,
}

impl Default for ActivityKind {
    /// Domain-schema default for `ItineraryActivity.kind`.
    fn default() -> Self {
        ActivityKind::Activity
    }
}

/// Which cost-breakdown bucket an entry's money lands in.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum CostCategory {
    Flights,
    Accommodation,
    Activities,
    Food,
    Transport,
    Other,
}

impl Default for CostCategory {
    /// Domain-schema default for `CostLine.category`.
    fn default() -> Self {
        CostCategory::Other
    }
}

/// A single itinerary entry.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ItineraryActivity {
    /// Stable within one response; used by the editor as a React key.
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub kind: ActivityKind,
    /// 24-hour local clock time, `HH:MM`. Entries within a day never overlap.
    pub start_time: String,
    #[serde(default)]
    pub duration_minutes: i64,
    /// City or venue, for the line under the title.
    #[serde(default)]
    pub location: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    /// Integer minor units for the WHOLE pod (already multiplied by
    /// `travellers` / rooms / nights where that applies), so the cost breakdown
    /// is exactly the sum of these numbers.
    #[serde(default)]
    pub cost_minor: i64,
    /// True for flights and intercity trains.
    #[serde(default)]
    pub locked: bool,
    #[serde(default)]
    pub emoji: String,
}

/// One day of a trip.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ItineraryDay {
    /// 1-based day number.
    pub day: i64,
    /// `YYYY-MM-DD`, or `None` when the pod gave no start date.
    pub date: Option<String>,
    pub city: String,
    /// One-line description of the day's shape.
    pub summary: String,
    /// Ordered, non-overlapping.
    pub activities: Vec<ItineraryActivity>,
}

/// One line of a trip's cost breakdown.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CostLine {
    pub label: String,
    /// Integer minor units.
    pub amount_minor: i64,
    pub currency: String,
    pub category: CostCategory,
}

/// The generated plan.
#[derive(Debug, Clone, Serialize)]
pub struct ItineraryResponse {
    pub days: Vec<ItineraryDay>,
    /// One line per non-empty category, in a fixed category order.
    pub cost_breakdown: Vec<CostLine>,
    /// Sum of every `cost_breakdown` line, which is also the sum of every
    /// activity's `cost_minor`.
    pub total_minor: i64,
    /// Cities visited, in visit order, de-duplicated.
    pub cities: Vec<String>,
    /// One sentence explaining how the pod's style shaped the plan, shown under
    /// the itinerary header.
    pub personalization_note: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_defaults_match_the_schema() {
        // Only latitude/longitude/recorded_at_ms are required; the rest default.
        let p: PingInput = serde_json::from_str(
            r#"{"latitude": 1.3, "longitude": 103.8, "recorded_at_ms": 1700000000000}"#,
        )
        .expect("minimal ping must deserialise");
        assert_eq!(p.speed, 0.0);
        assert_eq!(p.accuracy, 0.0);
        assert!(!p.is_driving);
    }

    #[test]
    fn nearest_place_radius_defaults_to_the_geofence_radius() {
        let r: NearestPlaceRequest = serde_json::from_str(
            r#"{"location": {"latitude": 1.0, "longitude": 2.0}, "places": []}"#,
        )
        .expect("minimal nearest-place request must deserialise");
        assert_eq!(r.radius_m, 150.0);
    }

    #[test]
    fn decision_defaults_match_the_schema() {
        let r: EvaluateDecisionRequest =
            serde_json::from_str(r#"{"member_ids": ["a"], "votes": []}"#)
                .expect("minimal decision request must deserialise");
        assert_eq!(r.source_type, SourceType::User);
        assert_eq!(r.status, DecisionStatus::Active);
        assert!(r.creator_stance.is_none());
        assert!(r.stage_override.is_none());
    }

    #[test]
    fn an_invalid_stance_is_a_deserialisation_error() {
        // This is what turns a bad enum value into a 400 instead of letting an
        // unexpected string reach the aggregation code.
        let err = serde_json::from_str::<DecisionMemberVote>(
            r#"{"voter_id": "a", "stance": "yes"}"#,
        );
        assert!(err.is_err(), "\"yes\" is not a valid stance");
    }

    #[test]
    fn outcome_and_stage_serialise_as_snake_case() {
        assert_eq!(
            serde_json::to_string(&Outcome::EveryoneIn).unwrap(),
            "\"everyone_in\""
        );
        assert_eq!(
            serde_json::to_string(&Outcome::WorkItOut).unwrap(),
            "\"work_it_out\""
        );
        assert_eq!(
            serde_json::to_string(&Outcome::NotForUs).unwrap(),
            "\"not_for_us\""
        );
        assert_eq!(
            serde_json::to_string(&Stage::MaybeLater).unwrap(),
            "\"maybe_later\""
        );
        assert_eq!(
            serde_json::to_string(&Stage::Considering).unwrap(),
            "\"considering\""
        );
    }

    #[test]
    fn itinerary_defaults_match_the_schema() {
        let r: ItineraryRequest =
            serde_json::from_str(r#"{"countries": ["japan"], "days": 5}"#)
                .expect("minimal itinerary request must deserialise");
        assert_eq!(r.travellers, 2);
        assert_eq!(r.pace, Pace::Balanced);
        assert_eq!(r.budget_tier, BudgetTier::Mid);
        assert_eq!(r.currency, "SGD");
        assert!(r.regions.is_empty());
        assert!(r.must_see.is_empty());
        assert!(r.avoid.is_empty());
        assert!(r.seed.is_none());
    }

    #[test]
    fn garden_entry_defaults_match_the_schema() {
        let e: GrowthEntryInput =
            serde_json::from_str(r#"{"id": "g1"}"#).expect("minimal garden entry must deserialise");
        assert_eq!(e.kind, GardenEntryKind::Plant);
        assert_eq!(e.grows_seconds, 60);
        assert_eq!(e.water_boost, 0.0);
        assert!(e.planted_at_ms.is_none());
    }

    #[test]
    fn achievement_defaults_match_the_schema() {
        let a: AchievementRequest =
            serde_json::from_str("{}").expect("empty achievement request must deserialise");
        assert_eq!(a.peas_count, 1);
        assert_eq!(a.dates_count, 0);
        assert!(a.pinned_journey_days.is_none());
    }

    #[test]
    fn pace_slots_follow_the_documented_cadence() {
        assert_eq!(Pace::Relaxed.activity_slots(), 2);
        assert_eq!(Pace::Balanced.activity_slots(), 3);
        assert_eq!(Pace::Packed.activity_slots(), 4);
    }
}

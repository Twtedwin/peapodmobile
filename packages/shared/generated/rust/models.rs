//! GENERATED FILE -- DO NOT EDIT BY HAND.
//!
//! Regenerate with:  npm run codegen  (from packages/shared)
//! Source of truth:  packages/shared/schemas/*.schema.json
//!
//! These serde structs mirror Peapod's cross-service payload contract. Editing
//! this file directly will be overwritten, and worse, will make Rust disagree
//! with TypeScript and Python about what a payload looks like. Change the
//! schema instead, then regenerate.
//!
//! Generated from: compute.schema.json, core.schema.json, domain.schema.json

#![allow(dead_code)]

/// A bare coordinate pair in WGS84 degrees.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GeoPoint {
    pub latitude: f64,
    pub longitude: f64,
}

/// A GPS fix as fed to trip reconstruction. Only the fields the algorithm reads are included; timestamps arrive as epoch milliseconds so no date parsing happens inside the hot loop.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PingInput {
    pub latitude: f64,
    pub longitude: f64,
    /// Epoch milliseconds, UTC.
    pub recorded_at_ms: i64,
    /// Metres per second.
    #[serde(default)]
    pub speed: Option<f64>,
    /// Metres. Interior fixes worse than 50 m are dropped.
    #[serde(default)]
    pub accuracy: Option<f64>,
    #[serde(default)]
    pub is_driving: Option<bool>,
}

/// Reconstruct the most recent confirmed journey from one member's ping history. Input need not be sorted; the service sorts by recorded_at_ms first.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ReconstructTripRequest {
    pub pings: Vec<PingInput>,
}

/// A drawable journey. 'points' is the smoothed polyline with the stationary tail at the destination trimmed off, so the line ends where the member actually arrived rather than smearing into a cluster of dots.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ReconstructedTrip {
    /// Ordered [latitude, longitude] pairs.
    pub points: Vec<Vec<f64>>,
    pub start_at_ms: i64,
    pub arrival_at_ms: i64,
    /// Total path length walked along the polyline.
    pub distance_km: f64,
    /// Straight-line distance from first to last point. Distinguishes a real journey from stationary GPS jitter.
    pub net_displacement_m: f64,
    /// Farthest the member ever got from the start. Catches a round trip that returns home, whose net displacement is near zero.
    pub max_dist_from_start_m: f64,
    pub avg_speed_ms: f64,
    /// True when the run looks like a car trip, so the caller may road-snap the line.
    pub is_driving: bool,
}

/// The last confirmed trip, or null when the member has not travelled far enough to confirm one. A journey in progress does not replace the previous one, so no false line flashes onto the map while a real trip is still building up.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ReconstructTripResponse {
    pub trip: Option<ReconstructedTrip>,
}

/// A human label for a speed reading. Phones do not expose OS-level activity recognition to this layer, so speed is the only signal available.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ActivityClassification {
    pub label: String,
    pub driving: bool,
}

/// Find which saved place, if any, a member is currently at.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct NearestPlaceRequest {
    pub location: GeoPoint,
    pub places: Vec<serde_json::Value>,
    /// Defaults to the geofence entry radius so 'at a place' and 'inside the fence' agree.
    #[serde(default)]
    pub radius_m: Option<f64>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct NearestPlaceResponse {
    pub place_id: Option<String>,
    pub distance_m: Option<f64>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DecisionMemberVote {
    pub voter_id: String,
    pub stance: String,
}

/// Evaluate one idea against its pod. member_ids is the full membership, which is what makes 'everyone has voted' decidable.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct EvaluateDecisionRequest {
    pub member_ids: Vec<String>,
    pub votes: Vec<DecisionMemberVote>,
    #[serde(default)]
    pub creator_stance: Option<String>,
    #[serde(default)]
    pub source_type: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub stage_override: Option<String>,
}

/// The aggregate. Callers must not reveal any of these counts to a member until all_voted is true -- hiding individual and aggregate support until everybody has answered is the core fairness rule of the feature.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct EvaluateDecisionResponse {
    pub want: i64,
    pub maybe: i64,
    pub no: i64,
    pub total: i64,
    pub voted_count: i64,
    pub all_voted: bool,
    pub outcome: String,
    pub stage: String,
    /// Rounded percentage, clamped to 0..100.
    pub harmony: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct LevelRequest {
    pub xp: i64,
}

/// Where a pod sits on the six-level progression, plus what it takes to reach the next one.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct LevelResponse {
    pub level: i64,
    pub name: String,
    pub description: String,
    /// XP threshold of the level the pod currently occupies.
    pub current_level_xp: i64,
    /// Null at max level.
    pub next_level_xp: Option<i64>,
    /// Fraction of the way to the next level. Always 1 at max level.
    pub progress: f64,
    /// Garden slots unlocked at this level.
    pub plot_capacity: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GrowthEntryInput {
    pub id: String,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub planted_at_ms: Option<i64>,
    #[serde(default)]
    pub grows_seconds: Option<i64>,
    #[serde(default)]
    pub water_boost: Option<f64>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GardenGrowthRequest {
    pub entries: Vec<GrowthEntryInput>,
    /// Evaluation instant, supplied by the caller so results are reproducible in tests.
    pub now_ms: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GardenGrowthResponse {
    pub growth: Vec<serde_json::Value>,
}

/// Split an amount across members by percentage. Percentages are floating point but the output must be exact integers that sum to the input, so the service allocates the rounding remainder deterministically rather than rounding each share independently.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SplitRequest {
    pub amount_minor: i64,
    pub shares: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SplitResponse {
    pub allocations: Vec<serde_json::Value>,
    /// Sum of allocations. Guaranteed equal to the requested amount_minor.
    pub total_minor: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AchievementRequest {
    pub peas_count: i64,
    pub dates_count: i64,
    #[serde(default)]
    pub pinned_journey_days: Option<i64>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AchievementTier {
    pub threshold: i64,
    pub label: String,
    pub description: String,
}

/// A tiered track with every tier already unlocked, so the UI can page back through the pod's history rather than showing only the latest badge.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AchievementGroup {
    pub key: String,
    pub title: String,
    pub tiers: Vec<AchievementTier>,
    /// Progress from the frontier tier toward the next one. 1 when the track is complete.
    pub progress: f64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AchievementResponse {
    pub groups: Vec<AchievementGroup>,
}

/// The direction a pod gave the planner. The pod chooses destination, dates, pace, style, and budget; the planner builds the whole connected trip from flights through to the return leg.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ItineraryRequest {
    pub countries: Vec<String>,
    #[serde(default)]
    pub regions: Option<Vec<String>>,
    pub days: i64,
    #[serde(default)]
    pub travellers: Option<i64>,
    /// Travel-style tags such as 'food', 'nature', 'relaxed'. Used to rank candidate activities.
    #[serde(default)]
    pub personalities: Option<Vec<String>>,
    #[serde(default)]
    pub pace: Option<String>,
    #[serde(default)]
    pub budget_tier: Option<String>,
    #[serde(default)]
    pub start_date: Option<String>,
    #[serde(default)]
    pub must_see: Option<Vec<String>>,
    #[serde(default)]
    pub avoid: Option<Vec<String>>,
    #[serde(default)]
    pub currency: Option<String>,
    /// Optional deterministic seed. Supplying one makes generation reproducible, which the tests rely on.
    #[serde(default)]
    pub seed: Option<i64>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ItineraryResponse {
    pub days: Vec<ItineraryDay>,
    pub cost_breakdown: Vec<CostLine>,
    pub total_minor: i64,
    pub cities: Vec<String>,
    /// One sentence explaining how the pod's style shaped the plan, shown under the itinerary header.
    pub personalization_note: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct HealthResponse {
    pub status: String,
    pub service: String,
    pub version: String,
}

/// Columns present on every record. created_by_id is the owner used by the ownership branch of every row-level policy; it is set server-side from the verified access token and is never accepted from a client payload.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AuditFields {
    /// Primary key.
    pub id: String,
    /// UTC creation timestamp.
    pub created_at: String,
    /// UTC timestamp of the last mutation.
    pub updated_at: String,
    /// The user who created the row. Server-assigned.
    pub created_by_id: String,
}

/// What kind of group this pod is. Drives copy throughout the app (a couple sees different wording than a friend group).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum PodGroupType {
    #[serde(rename = "couple")]
    Couple,
    #[serde(rename = "family")]
    Family,
    #[serde(rename = "friends")]
    Friends,
}

/// A member's role in a pod. 'admin' is surfaced in the UI as a 'Seed' -- the only role allowed to rename the pod, generate invite codes, change roles, remove members, or delete the pod.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum PodRole {
    #[serde(rename = "admin")]
    Admin,
    #[serde(rename = "member")]
    Member,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum PlaceCategory {
    #[serde(rename = "home")]
    Home,
    #[serde(rename = "work")]
    Work,
    #[serde(rename = "food")]
    Food,
    #[serde(rename = "date")]
    Date,
    #[serde(rename = "travel")]
    Travel,
    #[serde(rename = "other")]
    Other,
}

/// Whether the geofence fired on entry or exit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum PlaceAlertEvent {
    #[serde(rename = "arrived")]
    Arrived,
    #[serde(rename = "left")]
    Left,
}

/// Who a plan is for. Decides who receives the day-before reminder: 'self' notifies only the creator, 'specific' notifies participant_ids, 'pod' notifies every member.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum PlanAudience {
    #[serde(rename = "self")]
    Self,
    #[serde(rename = "specific")]
    Specific,
    #[serde(rename = "pod")]
    Pod,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum PlanRepeat {
    #[serde(rename = "none")]
    None,
    #[serde(rename = "daily")]
    Daily,
    #[serde(rename = "weekly")]
    Weekly,
    #[serde(rename = "monthly")]
    Monthly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum NotificationKind {
    #[serde(rename = "info")]
    Info,
    #[serde(rename = "message")]
    Message,
    #[serde(rename = "pod_message")]
    PodMessage,
    #[serde(rename = "nudge")]
    Nudge,
    #[serde(rename = "place_alert")]
    PlaceAlert,
    #[serde(rename = "date_reminder")]
    DateReminder,
    #[serde(rename = "plan_reminder")]
    PlanReminder,
}

/// A pod: the small group that shares location, plans, money, and a world. Everything else in the system is scoped to a pod.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Pod {
    pub name: String,
    #[serde(default)]
    pub emoji: Option<String>,
    #[serde(default)]
    pub group_type: Option<PodGroupType>,
    /// When false, members' past movement trails are hidden from the map. A privacy switch owned by the pod admin.
    #[serde(default)]
    pub trip_history_enabled: Option<bool>,
    /// Primary key.
    pub id: String,
    /// UTC creation timestamp.
    pub created_at: String,
    /// UTC timestamp of the last mutation.
    pub updated_at: String,
    /// The user who created the row. Server-assigned.
    pub created_by_id: String,
}

/// Joins a user to a pod with a role. Clients never write this table directly; all changes go through the privileged pod routes so admin checks cannot be bypassed.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PodMembership {
    pub pod_id: String,
    pub user_id: String,
    #[serde(default)]
    pub role: Option<PodRole>,
    /// Primary key.
    pub id: String,
    /// UTC creation timestamp.
    pub created_at: String,
    /// UTC timestamp of the last mutation.
    pub updated_at: String,
    /// The user who created the row. Server-assigned.
    pub created_by_id: String,
}

/// A short-lived join code. Codes are six characters and expire ten minutes after issue, matching the original behaviour.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PodInvite {
    pub pod_id: String,
    pub code: String,
    pub expires_at: String,
    /// Primary key.
    pub id: String,
    /// UTC creation timestamp.
    pub created_at: String,
    /// UTC timestamp of the last mutation.
    pub updated_at: String,
    /// The user who created the row. Server-assigned.
    pub created_by_id: String,
}

/// An account. Credentials live in the Python security service; this record holds only the profile fields the app renders.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct User {
    pub email: String,
    pub display_name: String,
    #[serde(default)]
    pub avatar_url: Option<String>,
    /// Set once the user has completed the location + notification onboarding screen. The app shell redirects to that screen while this is false.
    #[serde(default)]
    pub permissions_granted: Option<bool>,
    /// Platform-level role, distinct from PodRole. 'admin' is a Peapod operator, used by the escape hatch in every row-level policy.
    #[serde(default)]
    pub role: Option<String>,
    /// Primary key.
    pub id: String,
    /// UTC creation timestamp.
    pub created_at: String,
    /// UTC timestamp of the last mutation.
    pub updated_at: String,
    /// The user who created the row. Server-assigned.
    pub created_by_id: String,
}

/// One GPS fix from one member's device. The highest-volume table in the system: written every time a member moves past the movement threshold, and read in bulk by the compute service to reconstruct trips.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct LocationPing {
    pub latitude: f64,
    pub longitude: f64,
    /// Ground speed in metres per second, as reported by the OS.
    #[serde(default)]
    pub speed: Option<f64>,
    /// Horizontal accuracy radius in metres. Fixes worse than 50 m are discarded during trip reconstruction.
    #[serde(default)]
    pub accuracy: Option<f64>,
    /// Degrees clockwise from true north.
    #[serde(default)]
    pub heading: Option<f64>,
    /// Device-side guess that this fix was taken in a vehicle.
    #[serde(default)]
    pub is_driving: Option<bool>,
    #[serde(default)]
    pub pod_id: Option<String>,
    /// Primary key.
    pub id: String,
    /// UTC creation timestamp.
    pub created_at: String,
    /// UTC timestamp of the last mutation.
    pub updated_at: String,
    /// The user who created the row. Server-assigned.
    pub created_by_id: String,
}

/// Device telemetry shown on a member's card. The *_supported flags exist because some platforms refuse to report battery or connection type, and the UI must show 'N/A' rather than a misleading zero.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PhoneStatus {
    pub battery_level: f64,
    #[serde(default)]
    pub is_charging: Option<bool>,
    #[serde(default)]
    pub connection_type: Option<String>,
    #[serde(default)]
    pub signal_bars: Option<f64>,
    #[serde(default)]
    pub battery_supported: Option<bool>,
    #[serde(default)]
    pub connection_supported: Option<bool>,
    #[serde(default)]
    pub pod_id: Option<String>,
    /// Primary key.
    pub id: String,
    /// UTC creation timestamp.
    pub created_at: String,
    /// UTC timestamp of the last mutation.
    pub updated_at: String,
    /// The user who created the row. Server-assigned.
    pub created_by_id: String,
}

/// A saved place: home, work, a regular cafe. Doubles as a geofence -- arriving within 150 m creates a PlaceAlert and notifies the pod. A non-null expires_at makes the place temporary (useful for a one-off meeting point).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FavouritePlace {
    pub name: String,
    #[serde(default)]
    pub address: Option<String>,
    pub latitude: f64,
    pub longitude: f64,
    #[serde(default)]
    pub category: Option<PlaceCategory>,
    #[serde(default)]
    pub expires_at: Option<String>,
    #[serde(default)]
    pub pod_id: Option<String>,
    /// Primary key.
    pub id: String,
    /// UTC creation timestamp.
    pub created_at: String,
    /// UTC timestamp of the last mutation.
    pub updated_at: String,
    /// The user who created the row. Server-assigned.
    pub created_by_id: String,
}

/// An audit trail of geofence crossings. Written by the device that crossed the fence, read to render 'Sarah arrived at Home'.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PlaceAlert {
    pub place_name: String,
    pub event: PlaceAlertEvent,
    #[serde(default)]
    pub latitude: Option<f64>,
    #[serde(default)]
    pub longitude: Option<f64>,
    #[serde(default)]
    pub pod_id: Option<String>,
    /// Primary key.
    pub id: String,
    /// UTC creation timestamp.
    pub created_at: String,
    /// UTC timestamp of the last mutation.
    pub updated_at: String,
    /// The user who created the row. Server-assigned.
    pub created_by_id: String,
}

/// Anything with a date that is not a full trip: a reminder, a call, a date night. Appears in the unified Plans list alongside trips.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Plan {
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    pub start_time: String,
    #[serde(default)]
    pub end_time: Option<String>,
    #[serde(default)]
    pub location_name: Option<String>,
    #[serde(default)]
    pub for_whom: Option<PlanAudience>,
    /// Only meaningful when for_whom is 'specific'.
    #[serde(default)]
    pub participant_ids: Option<Vec<String>>,
    #[serde(default)]
    pub repeat_frequency: Option<PlanRepeat>,
    #[serde(default)]
    pub pod_id: Option<String>,
    /// Primary key.
    pub id: String,
    /// UTC creation timestamp.
    pub created_at: String,
    /// UTC timestamp of the last mutation.
    pub updated_at: String,
    /// The user who created the row. Server-assigned.
    pub created_by_id: String,
}

/// A chat message. A null recipient_id makes it a pod-wide group message; a set recipient_id makes it a one-to-one message. Messages are pruned after seven days by a scheduled job.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Message {
    #[serde(default)]
    pub recipient_id: Option<String>,
    #[serde(default)]
    pub pod_id: Option<String>,
    pub text: String,
    /// Primary key.
    pub id: String,
    /// UTC creation timestamp.
    pub created_at: String,
    /// UTC timestamp of the last mutation.
    pub updated_at: String,
    /// The user who created the row. Server-assigned.
    pub created_by_id: String,
}

/// An in-app notification addressed to one user. Read/update/delete are restricted to the recipient or the creator.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Notification {
    pub title: String,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub emoji: Option<String>,
    #[serde(default)]
    pub is_read: Option<bool>,
    #[serde(default)]
    pub recipient_id: Option<String>,
    #[serde(default)]
    #[serde(rename = "type")]
    pub kind: Option<NotificationKind>,
    #[serde(default)]
    pub pod_id: Option<String>,
    /// Primary key.
    pub id: String,
    /// UTC creation timestamp.
    pub created_at: String,
    /// UTC timestamp of the last mutation.
    pub updated_at: String,
    /// The user who created the row. Server-assigned.
    pub created_by_id: String,
}

/// A pod milestone. count_up dates power 'Together for 1,124 days'; count-down dates power 'Sarah's birthday in 12 days'. The milestone job reads count_up dates to celebrate day 100, 200, 365, 500, 730, and 1000.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ImportantDate {
    pub title: String,
    /// Calendar date, no time component. Parsed as UTC midnight to avoid off-by-one-day errors across time zones.
    pub date: String,
    #[serde(default)]
    pub count_up: Option<bool>,
    /// True for yearly events like birthdays.
    #[serde(default)]
    pub recurring: Option<bool>,
    #[serde(default)]
    pub emoji: Option<String>,
    /// The single pinned date is the pod's headline journey, shown on the profile.
    #[serde(default)]
    pub pinned: Option<bool>,
    #[serde(default)]
    pub pod_id: Option<String>,
    /// Primary key.
    pub id: String,
    /// UTC creation timestamp.
    pub created_at: String,
    /// UTC timestamp of the last mutation.
    pub updated_at: String,
    /// The user who created the row. Server-assigned.
    pub created_by_id: String,
}

/// The trip lifecycle, preserved exactly from the original app. 'suggestion' is something Peapod proposed, 'draft' is being built in the wizard, 'planned' is agreed, 'booked' is paid for, 'completed' has happened and has fed the world, garden, and scratch map.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum TripStatus {
    #[serde(rename = "suggestion")]
    Suggestion,
    #[serde(rename = "draft")]
    Draft,
    #[serde(rename = "planned")]
    Planned,
    #[serde(rename = "booked")]
    Booked,
    #[serde(rename = "completed")]
    Completed,
}

/// How the trip came to exist. Rendered as a badge so members can tell an idea they voted into being from one somebody built by hand.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum TripOrigin {
    #[serde(rename = "manual")]
    Manual,
    #[serde(rename = "peapod_suggested")]
    PeapodSuggested,
    #[serde(rename = "decide_together")]
    DecideTogether,
    #[serde(rename = "bucket_list")]
    BucketList,
}

/// A member's stance on an idea. Deliberately three-valued: 'maybe' is a real answer, not a missing one, and it is what routes an idea to 'maybe later' instead of a compromise negotiation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum VoteStance {
    #[serde(rename = "want")]
    Want,
    #[serde(rename = "maybe")]
    Maybe,
    #[serde(rename = "no")]
    No,
}

/// Where an idea sits in the decision pipeline. 'deciding' means not everyone has voted yet and no aggregate is revealed. 'considering' is the Work It Out bucket for a divided pod.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum IdeaStage {
    #[serde(rename = "deciding")]
    Deciding,
    #[serde(rename = "considering")]
    Considering,
    #[serde(rename = "maybe_later")]
    MaybeLater,
    #[serde(rename = "planned")]
    Planned,
    #[serde(rename = "archived")]
    Archived,
    #[serde(rename = "converted")]
    Converted,
}

/// A garden slot holds either a plant (grows over time, may be harvested) or a decoration (cosmetic, always fully grown).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum GardenEntryKind {
    #[serde(rename = "plant")]
    Plant,
    #[serde(rename = "decor")]
    Decor,
}

/// The distinction the product cares most about in the garden: 'earned' seeds are granted only by real shared experiences and can never be bought, while 'shop' seeds are cosmetic and cost Peanuts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum SeedProvenance {
    #[serde(rename = "earned")]
    Earned,
    #[serde(rename = "shop")]
    Shop,
}

/// A trip and its generated itinerary. The itinerary and cost breakdown are stored as JSON documents rather than normalised tables because they are always read and written whole, and their shape is owned by the Rust itinerary generator.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Trip {
    pub id: String,
    pub pod_id: String,
    #[serde(default)]
    pub created_by_id: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    pub title: String,
    /// Human-readable headline destination, e.g. 'Japan' or 'Tokyo & Kyoto'.
    pub destination: String,
    #[serde(default)]
    pub country: Option<String>,
    #[serde(default)]
    pub emoji: Option<String>,
    pub status: TripStatus,
    #[serde(default)]
    pub origin: Option<TripOrigin>,
    #[serde(default)]
    pub start_date: Option<String>,
    #[serde(default)]
    pub end_date: Option<String>,
    /// True when the pod picked a rough month rather than exact dates.
    #[serde(default)]
    pub flexible_dates: Option<bool>,
    #[serde(default)]
    pub participant_ids: Option<Vec<String>>,
    #[serde(default)]
    pub cities: Option<Vec<String>>,
    /// Target budget in minor units (cents).
    #[serde(default)]
    pub budget_minor: Option<i64>,
    #[serde(default)]
    pub currency: Option<String>,
    /// Day-by-day plan produced by the compute service.
    #[serde(default)]
    pub itinerary: Option<Vec<ItineraryDay>>,
    #[serde(default)]
    pub cost_breakdown: Option<Vec<CostLine>>,
    /// Set after completion.
    #[serde(default)]
    pub rating: Option<i64>,
    /// Set when the trip was created by an agreed Decide Together idea.
    #[serde(default)]
    pub source_idea_id: Option<String>,
    #[serde(default)]
    pub completed_at: Option<String>,
}

/// One day of a trip. Activities are ordered and carry clock times so the editor can re-time a day when an activity is dragged.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ItineraryDay {
    pub day: i64,
    #[serde(default)]
    pub date: Option<String>,
    pub city: String,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub activities: Option<Vec<ItineraryActivity>>,
}

/// A single itinerary entry. 'locked' is true for flights and intercity trains: the editor must refuse to reorder them because everything else on the day is timed around them.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ItineraryActivity {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub kind: Option<String>,
    /// 24-hour local clock time, HH:MM.
    pub start_time: String,
    #[serde(default)]
    pub duration_minutes: Option<i64>,
    #[serde(default)]
    pub location: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub cost_minor: Option<i64>,
    #[serde(default)]
    pub locked: Option<bool>,
    #[serde(default)]
    pub emoji: Option<String>,
}

/// One line of a trip's cost breakdown. Lines sharing a label are merged and summed when the breakdown is rendered.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CostLine {
    pub label: String,
    pub amount_minor: i64,
    #[serde(default)]
    pub currency: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
}

/// A proposal in the Decide Together pipeline. Its stage is derived from its votes by the compute service, except when an operator has pinned an explicit stage.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Idea {
    pub id: String,
    pub pod_id: String,
    #[serde(default)]
    pub created_by_id: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    pub title: String,
    #[serde(default)]
    pub emoji: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub destination: Option<String>,
    #[serde(default)]
    pub country: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    /// AI-sourced ideas take a small harmony penalty so a human's proposal outranks a machine's at equal support.
    #[serde(default)]
    pub source_type: Option<String>,
    #[serde(default)]
    pub estimated_cost_minor: Option<i64>,
    #[serde(default)]
    pub duration_days: Option<i64>,
    #[serde(default)]
    pub activities: Option<Vec<String>>,
    #[serde(default)]
    pub preferred_month: Option<String>,
    #[serde(default)]
    pub preferred_dates: Option<String>,
    /// The creator's pre-vote, recorded at submission so they never swipe their own idea.
    #[serde(default)]
    pub creator_stance: Option<VoteStance>,
    /// When set, wins over the computed stage.
    #[serde(default)]
    pub stage_override: Option<String>,
    #[serde(default)]
    pub compromise_options: Option<Vec<String>>,
    #[serde(default)]
    pub ai_rationale: Option<String>,
    #[serde(default)]
    pub converted_trip_id: Option<String>,
}

/// One member's stance on one idea. Unique per (idea, voter). Never exposed to other members until every member has voted -- the API filters these out of responses while the idea is still in 'deciding'.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct IdeaVote {
    pub id: String,
    pub idea_id: String,
    pub voter_id: String,
    pub stance: VoteStance,
    #[serde(default)]
    pub created_at: Option<String>,
}

/// One row per pod holding the shared progression counters. Level is always derived from xp rather than stored, so the two can never drift apart.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PodWorld {
    pub pod_id: String,
    pub xp: i64,
    /// The pod's spendable currency.
    pub peanuts: i64,
    #[serde(default)]
    pub updated_at: Option<String>,
}

/// One occupied slot in the pod's garden. A plant with a null planted_at is a pre-seeded living record of a past memory and counts as fully grown; a plant with a planted_at grows in real time from that instant.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GardenEntry {
    pub id: String,
    pub pod_id: String,
    #[serde(default)]
    pub kind: Option<GardenEntryKind>,
    /// Zero-based slot index. Must be below the pod's plot capacity.
    pub slot: i64,
    /// Identifier into garden.json (a seed, species, or decoration).
    pub catalog_id: String,
    pub name: String,
    #[serde(default)]
    pub emoji: Option<String>,
    #[serde(default)]
    pub rarity: Option<String>,
    #[serde(default)]
    pub provenance: Option<SeedProvenance>,
    /// Why this plant exists, e.g. 'From “Our first trip to Japan”'.
    #[serde(default)]
    pub source_label: Option<String>,
    #[serde(default)]
    pub memory_id: Option<String>,
    #[serde(default)]
    pub planted_at: Option<String>,
    #[serde(default)]
    pub grows_seconds: Option<i64>,
    /// Additive growth bonus from watering, capped at 1.0. Growth never decreases and a plant never dies.
    #[serde(default)]
    pub water_boost: Option<f64>,
    #[serde(default)]
    pub watered_at: Option<String>,
    #[serde(default)]
    pub harvested_at: Option<String>,
}

/// An unplanted seed the pod owns, with how it was obtained. Earned seeds are the meaningful ones and are granted only by completing real experiences.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SeedInventoryItem {
    pub id: String,
    pub pod_id: String,
    pub catalog_id: String,
    pub provenance: SeedProvenance,
    #[serde(default)]
    pub quantity: Option<i64>,
    #[serde(default)]
    pub earned_reason: Option<String>,
}

/// A captured moment: photos, a caption, a place. Creating one awards XP and Peanuts and grants an earned garden seed chosen by the memory's tag.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Memory {
    pub id: String,
    pub pod_id: String,
    #[serde(default)]
    pub created_by_id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub caption: Option<String>,
    pub date: String,
    #[serde(default)]
    pub location: Option<String>,
    #[serde(default)]
    pub latitude: Option<f64>,
    #[serde(default)]
    pub longitude: Option<f64>,
    /// Drives which earned seed and which collectible the memory can unlock.
    #[serde(default)]
    pub tag: Option<String>,
    #[serde(default)]
    pub photo_urls: Option<Vec<String>>,
    #[serde(default)]
    pub trip_id: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
}

/// Records that a pod has earned a collectible from the catalog. Collectibles are only ever unlocked by real activity -- a completed trip, a check-in, a milestone.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct UnlockedCollectible {
    pub id: String,
    pub pod_id: String,
    pub catalog_id: String,
    #[serde(default)]
    pub earned_by: Option<String>,
    #[serde(default)]
    pub memory_id: Option<String>,
    pub unlocked_at: String,
    /// True when the pod has placed this collectible as a landmark in their 3D world.
    #[serde(default)]
    pub displayed: Option<bool>,
}

/// A dream destination. The product rule is that 'visited' is reachable only by completing a trip, never by editing the item directly.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct BucketListItem {
    pub id: String,
    pub pod_id: String,
    #[serde(default)]
    pub created_by_id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub emoji: Option<String>,
    #[serde(default)]
    pub country: Option<String>,
    #[serde(default)]
    pub latitude: Option<f64>,
    #[serde(default)]
    pub longitude: Option<f64>,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub trip_id: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
}

/// A date or activity scheduled from the activity library.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DateActivity {
    pub id: String,
    pub pod_id: String,
    #[serde(default)]
    pub created_by_id: Option<String>,
    #[serde(default)]
    pub catalog_id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub emoji: Option<String>,
    #[serde(default)]
    pub is_online: Option<bool>,
    #[serde(default)]
    pub scheduled_at: Option<String>,
    #[serde(default)]
    pub participant_ids: Option<Vec<String>>,
    #[serde(default)]
    pub status: Option<String>,
}

/// The pod's shared wallet. Simulated: no real money moves until a payment provider is wired (see SETUP-EXTERNAL-APIS.md). Balance is integer minor units.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Wallet {
    pub pod_id: String,
    pub currency: String,
    pub balance_minor: i64,
    #[serde(default)]
    pub updated_at: Option<String>,
}

/// A recurring shared expense. split_percent maps user id to their percentage share; the compute service turns those percentages into exact minor-unit amounts that always sum to the total.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WalletBill {
    pub id: String,
    pub pod_id: String,
    pub name: String,
    #[serde(default)]
    pub emoji: Option<String>,
    pub amount_minor: i64,
    pub due_date: String,
    #[serde(default)]
    pub frequency: Option<String>,
    #[serde(default)]
    pub paid_by_id: Option<String>,
    /// User id to percentage. Must sum to 100.
    #[serde(default)]
    pub split_percent: Option<std::collections::HashMap<String, f64>>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub last_paid_at: Option<String>,
}

/// A travel fund: a savings goal members contribute to, optionally linked to a trip so it can be spent on booking it.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WalletGoal {
    pub id: String,
    pub pod_id: String,
    pub name: String,
    #[serde(default)]
    pub emoji: Option<String>,
    pub target_minor: i64,
    #[serde(default)]
    pub saved_minor: Option<i64>,
    #[serde(default)]
    pub trip_id: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
}

/// An append-only ledger entry. Every balance change writes one; the balance on the Wallet row is a cached sum and can always be rebuilt from these.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WalletTransaction {
    pub id: String,
    pub pod_id: String,
    #[serde(default)]
    pub actor_id: Option<String>,
    pub kind: String,
    /// Signed: positive credits the wallet, negative debits it.
    pub amount_minor: i64,
    pub description: String,
    #[serde(default)]
    pub bill_id: Option<String>,
    #[serde(default)]
    pub goal_id: Option<String>,
    #[serde(default)]
    pub trip_id: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
}

/// A reward bought from the store with Peanuts.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RewardRedemption {
    pub id: String,
    pub pod_id: String,
    #[serde(default)]
    pub redeemed_by_id: Option<String>,
    pub catalog_id: String,
    pub peanut_cost: i64,
    #[serde(default)]
    pub redeemed_at: Option<String>,
}

"""
GENERATED FILE -- DO NOT EDIT BY HAND.

Regenerate with:  npm run codegen  (from packages/shared)
Source of truth:  packages/shared/schemas/*.schema.json

These Pydantic models mirror Peapod's cross-service payload contract. Editing
this file directly will be overwritten, and worse, will make Python disagree
with TypeScript and Rust about what a payload looks like. Change the schema
instead, then regenerate.

Generated from: compute.schema.json, core.schema.json, domain.schema.json
"""

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

PodGroupType = Literal["couple", "family", "friends"]  # What kind of group this pod is. Drives copy throughout the app (a couple sees different wording than a friend group).
PodRole = Literal["admin", "member"]  # A member's role in a pod. 'admin' is surfaced in the UI as a 'Seed' -- the only role allowed to rename the pod, generate invite codes, change roles, remove members, or delete the pod.
PlaceCategory = Literal["home", "work", "food", "date", "travel", "other"]
PlaceAlertEvent = Literal["arrived", "left"]  # Whether the geofence fired on entry or exit.
PlanAudience = Literal["self", "specific", "pod"]  # Who a plan is for. Decides who receives the day-before reminder: 'self' notifies only the creator, 'specific' notifies participant_ids, 'pod' notifies every member.
PlanRepeat = Literal["none", "daily", "weekly", "monthly"]
NotificationKind = Literal["info", "message", "pod_message", "nudge", "place_alert", "date_reminder", "plan_reminder"]
TripStatus = Literal["suggestion", "draft", "planned", "booked", "completed"]  # The trip lifecycle, preserved exactly from the original app. 'suggestion' is something Peapod proposed, 'draft' is being built in the wizard, 'planned' is agreed, 'booked' is paid for, 'completed' has happened and has fed the world, garden, and scratch map.
TripOrigin = Literal["manual", "peapod_suggested", "decide_together", "bucket_list"]  # How the trip came to exist. Rendered as a badge so members can tell an idea they voted into being from one somebody built by hand.
VoteStance = Literal["want", "maybe", "no"]  # A member's stance on an idea. Deliberately three-valued: 'maybe' is a real answer, not a missing one, and it is what routes an idea to 'maybe later' instead of a compromise negotiation.
IdeaStage = Literal["deciding", "considering", "maybe_later", "planned", "archived", "converted"]  # Where an idea sits in the decision pipeline. 'deciding' means not everyone has voted yet and no aggregate is revealed. 'considering' is the Work It Out bucket for a divided pod.
GardenEntryKind = Literal["plant", "decor"]  # A garden slot holds either a plant (grows over time, may be harvested) or a decoration (cosmetic, always fully grown).
SeedProvenance = Literal["earned", "shop"]  # The distinction the product cares most about in the garden: 'earned' seeds are granted only by real shared experiences and can never be bought, while 'shop' seeds are cosmetic and cost Peanuts.

class GeoPoint(BaseModel):
    """
    A bare coordinate pair in WGS84 degrees.
    """
    model_config = ConfigDict(extra="forbid")

    latitude: float
    longitude: float

class PingInput(BaseModel):
    """
    A GPS fix as fed to trip reconstruction. Only the fields the algorithm reads are included; timestamps arrive as epoch milliseconds so no date parsing happens inside the hot loop.
    """
    model_config = ConfigDict(extra="forbid")

    latitude: float
    longitude: float
    recorded_at_ms: int  # Epoch milliseconds, UTC.
    speed: float = 0  # Metres per second.
    accuracy: float = 0  # Metres. Interior fixes worse than 50 m are dropped.
    is_driving: bool = False

class ReconstructTripRequest(BaseModel):
    """
    Reconstruct the most recent confirmed journey from one member's ping history. Input need not be sorted; the service sorts by recorded_at_ms first.
    """
    model_config = ConfigDict(extra="forbid")

    pings: List[PingInput]

class ReconstructedTrip(BaseModel):
    """
    A drawable journey. 'points' is the smoothed polyline with the stationary tail at the destination trimmed off, so the line ends where the member actually arrived rather than smearing into a cluster of dots.
    """
    model_config = ConfigDict(extra="forbid")

    points: List[List[float]]  # Ordered [latitude, longitude] pairs.
    start_at_ms: int
    arrival_at_ms: int
    distance_km: float  # Total path length walked along the polyline.
    net_displacement_m: float  # Straight-line distance from first to last point. Distinguishes a real journey from stationary GPS jitter.
    max_dist_from_start_m: float  # Farthest the member ever got from the start. Catches a round trip that returns home, whose net displacement is near zero.
    avg_speed_ms: float
    is_driving: bool  # True when the run looks like a car trip, so the caller may road-snap the line.

class ReconstructTripResponse(BaseModel):
    """
    The last confirmed trip, or null when the member has not travelled far enough to confirm one. A journey in progress does not replace the previous one, so no false line flashes onto the map while a real trip is still building up.
    """
    model_config = ConfigDict(extra="forbid")

    trip: Optional[ReconstructedTrip]

class ActivityClassification(BaseModel):
    """
    A human label for a speed reading. Phones do not expose OS-level activity recognition to this layer, so speed is the only signal available.
    """
    model_config = ConfigDict(extra="forbid")

    label: Literal["Stationary", "Walking", "Cycling", "Driving"]
    driving: bool

class NearestPlaceRequest(BaseModel):
    """
    Find which saved place, if any, a member is currently at.
    """
    model_config = ConfigDict(extra="forbid")

    location: GeoPoint
    places: List[Dict[str, Any]]
    radius_m: float = 150  # Defaults to the geofence entry radius so 'at a place' and 'inside the fence' agree.

class NearestPlaceResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    place_id: Optional[str]
    distance_m: Optional[float]

class DecisionMemberVote(BaseModel):
    model_config = ConfigDict(extra="forbid")

    voter_id: str
    stance: Literal["want", "maybe", "no"]

class EvaluateDecisionRequest(BaseModel):
    """
    Evaluate one idea against its pod. member_ids is the full membership, which is what makes 'everyone has voted' decidable.
    """
    model_config = ConfigDict(extra="forbid")

    member_ids: List[str]
    votes: List[DecisionMemberVote]
    creator_stance: Optional[Literal["want", "maybe", "no", null]] = None
    source_type: Literal["user", "ai"] = "user"
    status: Literal["active", "archived", "converted"] = "active"
    stage_override: Optional[str] = None

class EvaluateDecisionResponse(BaseModel):
    """
    The aggregate. Callers must not reveal any of these counts to a member until all_voted is true -- hiding individual and aggregate support until everybody has answered is the core fairness rule of the feature.
    """
    model_config = ConfigDict(extra="forbid")

    want: int
    maybe: int
    no: int
    total: int
    voted_count: int
    all_voted: bool
    outcome: Literal["deciding", "everyone_in", "work_it_out", "maybe_later", "not_for_us"]
    stage: Literal["deciding", "considering", "maybe_later", "planned", "archived", "converted"]
    harmony: int  # Rounded percentage, clamped to 0..100.

class LevelRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    xp: int

class LevelResponse(BaseModel):
    """
    Where a pod sits on the six-level progression, plus what it takes to reach the next one.
    """
    model_config = ConfigDict(extra="forbid")

    level: int
    name: str
    description: str
    current_level_xp: int  # XP threshold of the level the pod currently occupies.
    next_level_xp: Optional[int]  # Null at max level.
    progress: float  # Fraction of the way to the next level. Always 1 at max level.
    plot_capacity: int  # Garden slots unlocked at this level.

class GrowthEntryInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    kind: Literal["plant", "decor"] = "plant"
    planted_at_ms: Optional[int] = None
    grows_seconds: int = 60
    water_boost: float = 0

class GardenGrowthRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    entries: List[GrowthEntryInput]
    now_ms: int  # Evaluation instant, supplied by the caller so results are reproducible in tests.

class GardenGrowthResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    growth: List[Dict[str, Any]]

class SplitRequest(BaseModel):
    """
    Split an amount across members by percentage. Percentages are floating point but the output must be exact integers that sum to the input, so the service allocates the rounding remainder deterministically rather than rounding each share independently.
    """
    model_config = ConfigDict(extra="forbid")

    amount_minor: int
    shares: List[Dict[str, Any]]

class SplitResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    allocations: List[Dict[str, Any]]
    total_minor: int  # Sum of allocations. Guaranteed equal to the requested amount_minor.

class AchievementRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    peas_count: int
    dates_count: int
    pinned_journey_days: Optional[int] = None

class AchievementTier(BaseModel):
    model_config = ConfigDict(extra="forbid")

    threshold: int
    label: str
    description: str

class AchievementGroup(BaseModel):
    """
    A tiered track with every tier already unlocked, so the UI can page back through the pod's history rather than showing only the latest badge.
    """
    model_config = ConfigDict(extra="forbid")

    key: str
    title: str
    tiers: List[AchievementTier]
    progress: float  # Progress from the frontier tier toward the next one. 1 when the track is complete.

class AchievementResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    groups: List[AchievementGroup]

class ItineraryRequest(BaseModel):
    """
    The direction a pod gave the planner. The pod chooses destination, dates, pace, style, and budget; the planner builds the whole connected trip from flights through to the return leg.
    """
    model_config = ConfigDict(extra="forbid")

    countries: List[str]
    days: int
    regions: List[str] = Field(default_factory=list)
    travellers: int = 2
    personalities: List[str] = Field(default_factory=list)  # Travel-style tags such as 'food', 'nature', 'relaxed'. Used to rank candidate activities.
    pace: Literal["relaxed", "balanced", "packed"] = "balanced"
    budget_tier: Literal["budget", "mid", "luxury"] = "mid"
    start_date: Optional[str] = None
    must_see: List[str] = Field(default_factory=list)
    avoid: List[str] = Field(default_factory=list)
    currency: str = "SGD"
    seed: Optional[int] = None  # Optional deterministic seed. Supplying one makes generation reproducible, which the tests rely on.

class ItineraryResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    days: List[ItineraryDay]
    cost_breakdown: List[CostLine]
    total_minor: int
    cities: List[str]
    personalization_note: str  # One sentence explaining how the pod's style shaped the plan, shown under the itinerary header.

class HealthResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["ok"]
    service: str
    version: str

class AuditFields(BaseModel):
    """
    Columns present on every record. created_by_id is the owner used by the ownership branch of every row-level policy; it is set server-side from the verified access token and is never accepted from a client payload.
    """
    model_config = ConfigDict(extra="forbid")

    id: str  # Primary key.
    created_at: str  # UTC creation timestamp.
    updated_at: str  # UTC timestamp of the last mutation.
    created_by_id: str  # The user who created the row. Server-assigned.

class Pod(BaseModel):
    """
    A pod: the small group that shares location, plans, money, and a world. Everything else in the system is scoped to a pod.
    """
    model_config = ConfigDict(extra="forbid")

    name: str
    id: str  # Primary key.
    created_at: str  # UTC creation timestamp.
    updated_at: str  # UTC timestamp of the last mutation.
    created_by_id: str  # The user who created the row. Server-assigned.
    emoji: str = "❤️"
    group_type: Optional[PodGroupType] = None
    trip_history_enabled: bool = True  # When false, members' past movement trails are hidden from the map. A privacy switch owned by the pod admin.

class PodMembership(BaseModel):
    """
    Joins a user to a pod with a role. Clients never write this table directly; all changes go through the privileged pod routes so admin checks cannot be bypassed.
    """
    model_config = ConfigDict(extra="forbid")

    pod_id: str
    user_id: str
    id: str  # Primary key.
    created_at: str  # UTC creation timestamp.
    updated_at: str  # UTC timestamp of the last mutation.
    created_by_id: str  # The user who created the row. Server-assigned.
    role: Optional[PodRole] = None

class PodInvite(BaseModel):
    """
    A short-lived join code. Codes are six characters and expire ten minutes after issue, matching the original behaviour.
    """
    model_config = ConfigDict(extra="forbid")

    pod_id: str
    code: str
    expires_at: str
    id: str  # Primary key.
    created_at: str  # UTC creation timestamp.
    updated_at: str  # UTC timestamp of the last mutation.
    created_by_id: str  # The user who created the row. Server-assigned.

class User(BaseModel):
    """
    An account. Credentials live in the Python security service; this record holds only the profile fields the app renders.
    """
    model_config = ConfigDict(extra="forbid")

    email: str
    display_name: str
    id: str  # Primary key.
    created_at: str  # UTC creation timestamp.
    updated_at: str  # UTC timestamp of the last mutation.
    created_by_id: str  # The user who created the row. Server-assigned.
    avatar_url: Optional[str] = None
    permissions_granted: bool = False  # Set once the user has completed the location + notification onboarding screen. The app shell redirects to that screen while this is false.
    role: Literal["admin", "user"] = "user"  # Platform-level role, distinct from PodRole. 'admin' is a Peapod operator, used by the escape hatch in every row-level policy.

class LocationPing(BaseModel):
    """
    One GPS fix from one member's device. The highest-volume table in the system: written every time a member moves past the movement threshold, and read in bulk by the compute service to reconstruct trips.
    """
    model_config = ConfigDict(extra="forbid")

    latitude: float
    longitude: float
    id: str  # Primary key.
    created_at: str  # UTC creation timestamp.
    updated_at: str  # UTC timestamp of the last mutation.
    created_by_id: str  # The user who created the row. Server-assigned.
    speed: float = 0  # Ground speed in metres per second, as reported by the OS.
    accuracy: float = 0  # Horizontal accuracy radius in metres. Fixes worse than 50 m are discarded during trip reconstruction.
    heading: float = 0  # Degrees clockwise from true north.
    is_driving: bool = False  # Device-side guess that this fix was taken in a vehicle.
    pod_id: Optional[str] = None

class PhoneStatus(BaseModel):
    """
    Device telemetry shown on a member's card. The *_supported flags exist because some platforms refuse to report battery or connection type, and the UI must show 'N/A' rather than a misleading zero.
    """
    model_config = ConfigDict(extra="forbid")

    battery_level: float
    id: str  # Primary key.
    created_at: str  # UTC creation timestamp.
    updated_at: str  # UTC timestamp of the last mutation.
    created_by_id: str  # The user who created the row. Server-assigned.
    is_charging: bool = False
    connection_type: str = "unknown"
    signal_bars: float = 0
    battery_supported: bool = True
    connection_supported: bool = True
    pod_id: Optional[str] = None

class FavouritePlace(BaseModel):
    """
    A saved place: home, work, a regular cafe. Doubles as a geofence -- arriving within 150 m creates a PlaceAlert and notifies the pod. A non-null expires_at makes the place temporary (useful for a one-off meeting point).
    """
    model_config = ConfigDict(extra="forbid")

    name: str
    latitude: float
    longitude: float
    id: str  # Primary key.
    created_at: str  # UTC creation timestamp.
    updated_at: str  # UTC timestamp of the last mutation.
    created_by_id: str  # The user who created the row. Server-assigned.
    address: Optional[str] = None
    category: Optional[PlaceCategory] = None
    expires_at: Optional[str] = None
    pod_id: Optional[str] = None

class PlaceAlert(BaseModel):
    """
    An audit trail of geofence crossings. Written by the device that crossed the fence, read to render 'Sarah arrived at Home'.
    """
    model_config = ConfigDict(extra="forbid")

    place_name: str
    event: PlaceAlertEvent
    id: str  # Primary key.
    created_at: str  # UTC creation timestamp.
    updated_at: str  # UTC timestamp of the last mutation.
    created_by_id: str  # The user who created the row. Server-assigned.
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    pod_id: Optional[str] = None

class Plan(BaseModel):
    """
    Anything with a date that is not a full trip: a reminder, a call, a date night. Appears in the unified Plans list alongside trips.
    """
    model_config = ConfigDict(extra="forbid")

    title: str
    start_time: str
    id: str  # Primary key.
    created_at: str  # UTC creation timestamp.
    updated_at: str  # UTC timestamp of the last mutation.
    created_by_id: str  # The user who created the row. Server-assigned.
    description: Optional[str] = None
    end_time: Optional[str] = None
    location_name: Optional[str] = None
    for_whom: Optional[PlanAudience] = None
    participant_ids: List[str] = Field(default_factory=list)  # Only meaningful when for_whom is 'specific'.
    repeat_frequency: Optional[PlanRepeat] = None
    pod_id: Optional[str] = None

class Message(BaseModel):
    """
    A chat message. A null recipient_id makes it a pod-wide group message; a set recipient_id makes it a one-to-one message. Messages are pruned after seven days by a scheduled job.
    """
    model_config = ConfigDict(extra="forbid")

    text: str
    id: str  # Primary key.
    created_at: str  # UTC creation timestamp.
    updated_at: str  # UTC timestamp of the last mutation.
    created_by_id: str  # The user who created the row. Server-assigned.
    recipient_id: Optional[str] = None
    pod_id: Optional[str] = None

class Notification(BaseModel):
    """
    An in-app notification addressed to one user. Read/update/delete are restricted to the recipient or the creator.
    """
    model_config = ConfigDict(extra="forbid")

    title: str
    id: str  # Primary key.
    created_at: str  # UTC creation timestamp.
    updated_at: str  # UTC timestamp of the last mutation.
    created_by_id: str  # The user who created the row. Server-assigned.
    body: Optional[str] = None
    emoji: str = "❤️"
    is_read: bool = False
    recipient_id: Optional[str] = None
    type: Optional[NotificationKind] = None
    pod_id: Optional[str] = None

class ImportantDate(BaseModel):
    """
    A pod milestone. count_up dates power 'Together for 1,124 days'; count-down dates power 'Sarah's birthday in 12 days'. The milestone job reads count_up dates to celebrate day 100, 200, 365, 500, 730, and 1000.
    """
    model_config = ConfigDict(extra="forbid")

    title: str
    date: str  # Calendar date, no time component. Parsed as UTC midnight to avoid off-by-one-day errors across time zones.
    id: str  # Primary key.
    created_at: str  # UTC creation timestamp.
    updated_at: str  # UTC timestamp of the last mutation.
    created_by_id: str  # The user who created the row. Server-assigned.
    count_up: bool = True
    recurring: bool = False  # True for yearly events like birthdays.
    emoji: str = "❤️"
    pinned: bool = False  # The single pinned date is the pod's headline journey, shown on the profile.
    pod_id: Optional[str] = None

class Trip(BaseModel):
    """
    A trip and its generated itinerary. The itinerary and cost breakdown are stored as JSON documents rather than normalised tables because they are always read and written whole, and their shape is owned by the Rust itinerary generator.
    """
    model_config = ConfigDict(extra="forbid")

    id: str
    pod_id: str
    title: str
    destination: str  # Human-readable headline destination, e.g. 'Japan' or 'Tokyo & Kyoto'.
    status: TripStatus
    created_by_id: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    country: Optional[str] = None
    emoji: str = "✈️"
    origin: Optional[TripOrigin] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    flexible_dates: bool = False  # True when the pod picked a rough month rather than exact dates.
    participant_ids: List[str] = Field(default_factory=list)
    cities: List[str] = Field(default_factory=list)
    budget_minor: Optional[int] = None  # Target budget in minor units (cents).
    currency: str = "SGD"
    itinerary: List[ItineraryDay] = Field(default_factory=list)  # Day-by-day plan produced by the compute service.
    cost_breakdown: List[CostLine] = Field(default_factory=list)
    rating: Optional[int] = None  # Set after completion.
    source_idea_id: Optional[str] = None  # Set when the trip was created by an agreed Decide Together idea.
    completed_at: Optional[str] = None

class ItineraryDay(BaseModel):
    """
    One day of a trip. Activities are ordered and carry clock times so the editor can re-time a day when an activity is dragged.
    """
    model_config = ConfigDict(extra="forbid")

    day: int
    city: str
    date: Optional[str] = None
    summary: str = ""
    activities: List[ItineraryActivity] = Field(default_factory=list)

class ItineraryActivity(BaseModel):
    """
    A single itinerary entry. 'locked' is true for flights and intercity trains: the editor must refuse to reorder them because everything else on the day is timed around them.
    """
    model_config = ConfigDict(extra="forbid")

    id: str
    title: str
    start_time: str  # 24-hour local clock time, HH:MM.
    kind: Literal["flight", "transfer", "hotel", "activity", "meal", "train", "free"] = "activity"
    duration_minutes: int = 60
    location: Optional[str] = None
    notes: Optional[str] = None
    cost_minor: int = 0
    locked: bool = False
    emoji: str = "📍"

class CostLine(BaseModel):
    """
    One line of a trip's cost breakdown. Lines sharing a label are merged and summed when the breakdown is rendered.
    """
    model_config = ConfigDict(extra="forbid")

    label: str
    amount_minor: int
    currency: str = "SGD"
    category: Literal["flights", "accommodation", "activities", "food", "transport", "other"] = "other"

class Idea(BaseModel):
    """
    A proposal in the Decide Together pipeline. Its stage is derived from its votes by the compute service, except when an operator has pinned an explicit stage.
    """
    model_config = ConfigDict(extra="forbid")

    id: str
    pod_id: str
    title: str
    created_by_id: Optional[str] = None
    created_at: Optional[str] = None
    emoji: str = "💡"
    description: Optional[str] = None
    destination: Optional[str] = None
    country: Optional[str] = None
    category: Literal["travel", "food", "activity", "nature", "culture", "adventure", "themepark", "shopping"] = "activity"
    source_type: Literal["user", "ai"] = "user"  # AI-sourced ideas take a small harmony penalty so a human's proposal outranks a machine's at equal support.
    estimated_cost_minor: Optional[int] = None
    duration_days: Optional[int] = None
    activities: List[str] = Field(default_factory=list)
    preferred_month: Optional[str] = None
    preferred_dates: Optional[str] = None
    creator_stance: Optional[VoteStance] = None  # The creator's pre-vote, recorded at submission so they never swipe their own idea.
    stage_override: Optional[str] = None  # When set, wins over the computed stage.
    compromise_options: List[str] = Field(default_factory=list)
    ai_rationale: Optional[str] = None
    converted_trip_id: Optional[str] = None

class IdeaVote(BaseModel):
    """
    One member's stance on one idea. Unique per (idea, voter). Never exposed to other members until every member has voted -- the API filters these out of responses while the idea is still in 'deciding'.
    """
    model_config = ConfigDict(extra="forbid")

    id: str
    idea_id: str
    voter_id: str
    stance: VoteStance
    created_at: Optional[str] = None

class PodWorld(BaseModel):
    """
    One row per pod holding the shared progression counters. Level is always derived from xp rather than stored, so the two can never drift apart.
    """
    model_config = ConfigDict(extra="forbid")

    pod_id: str
    xp: int
    peanuts: int  # The pod's spendable currency.
    updated_at: Optional[str] = None

class GardenEntry(BaseModel):
    """
    One occupied slot in the pod's garden. A plant with a null planted_at is a pre-seeded living record of a past memory and counts as fully grown; a plant with a planted_at grows in real time from that instant.
    """
    model_config = ConfigDict(extra="forbid")

    id: str
    pod_id: str
    slot: int  # Zero-based slot index. Must be below the pod's plot capacity.
    catalog_id: str  # Identifier into garden.json (a seed, species, or decoration).
    name: str
    kind: Optional[GardenEntryKind] = None
    emoji: Optional[str] = None
    rarity: Literal["common", "special", "rare", "treasured"] = "common"
    provenance: Optional[SeedProvenance] = None
    source_label: Optional[str] = None  # Why this plant exists, e.g. 'From “Our first trip to Japan”'.
    memory_id: Optional[str] = None
    planted_at: Optional[str] = None
    grows_seconds: int = 60
    water_boost: float = 0  # Additive growth bonus from watering, capped at 1.0. Growth never decreases and a plant never dies.
    watered_at: Optional[str] = None
    harvested_at: Optional[str] = None

class SeedInventoryItem(BaseModel):
    """
    An unplanted seed the pod owns, with how it was obtained. Earned seeds are the meaningful ones and are granted only by completing real experiences.
    """
    model_config = ConfigDict(extra="forbid")

    id: str
    pod_id: str
    catalog_id: str
    provenance: SeedProvenance
    quantity: int = 1
    earned_reason: Optional[str] = None

class Memory(BaseModel):
    """
    A captured moment: photos, a caption, a place. Creating one awards XP and Peanuts and grants an earned garden seed chosen by the memory's tag.
    """
    model_config = ConfigDict(extra="forbid")

    id: str
    pod_id: str
    title: str
    date: str
    created_by_id: Optional[str] = None
    caption: Optional[str] = None
    location: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    tag: Literal["everyday", "place", "travel", "milestone", "anniversary", "activity", "culinary", "nature", "treasured"] = "everyday"  # Drives which earned seed and which collectible the memory can unlock.
    photo_urls: List[str] = Field(default_factory=list)
    trip_id: Optional[str] = None
    created_at: Optional[str] = None

class UnlockedCollectible(BaseModel):
    """
    Records that a pod has earned a collectible from the catalog. Collectibles are only ever unlocked by real activity -- a completed trip, a check-in, a milestone.
    """
    model_config = ConfigDict(extra="forbid")

    id: str
    pod_id: str
    catalog_id: str
    unlocked_at: str
    earned_by: Optional[str] = None
    memory_id: Optional[str] = None
    displayed: bool = False  # True when the pod has placed this collectible as a landmark in their 3D world.

class BucketListItem(BaseModel):
    """
    A dream destination. The product rule is that 'visited' is reachable only by completing a trip, never by editing the item directly.
    """
    model_config = ConfigDict(extra="forbid")

    id: str
    pod_id: str
    title: str
    created_by_id: Optional[str] = None
    emoji: str = "🌟"
    country: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    state: Literal["dream", "planned", "visited"] = "dream"
    trip_id: Optional[str] = None
    created_at: Optional[str] = None

class DateActivity(BaseModel):
    """
    A date or activity scheduled from the activity library.
    """
    model_config = ConfigDict(extra="forbid")

    id: str
    pod_id: str
    title: str
    created_by_id: Optional[str] = None
    catalog_id: Optional[str] = None
    emoji: str = "📅"
    is_online: bool = False
    scheduled_at: Optional[str] = None
    participant_ids: List[str] = Field(default_factory=list)
    status: Literal["scheduled", "completed", "cancelled"] = "scheduled"

class Wallet(BaseModel):
    """
    The pod's shared wallet. Simulated: no real money moves until a payment provider is wired (see SETUP-EXTERNAL-APIS.md). Balance is integer minor units.
    """
    model_config = ConfigDict(extra="forbid")

    pod_id: str
    currency: str
    balance_minor: int
    updated_at: Optional[str] = None

class WalletBill(BaseModel):
    """
    A recurring shared expense. split_percent maps user id to their percentage share; the compute service turns those percentages into exact minor-unit amounts that always sum to the total.
    """
    model_config = ConfigDict(extra="forbid")

    id: str
    pod_id: str
    name: str
    amount_minor: int
    due_date: str
    emoji: str = "🧾"
    frequency: Literal["once", "weekly", "monthly", "yearly"] = "monthly"
    paid_by_id: Optional[str] = None
    split_percent: Dict[str, float] = Field(default_factory=dict)  # User id to percentage. Must sum to 100.
    category: str = "other"
    last_paid_at: Optional[str] = None

class WalletGoal(BaseModel):
    """
    A travel fund: a savings goal members contribute to, optionally linked to a trip so it can be spent on booking it.
    """
    model_config = ConfigDict(extra="forbid")

    id: str
    pod_id: str
    name: str
    target_minor: int
    emoji: str = "✈️"
    saved_minor: int = 0
    trip_id: Optional[str] = None
    created_at: Optional[str] = None

class WalletTransaction(BaseModel):
    """
    An append-only ledger entry. Every balance change writes one; the balance on the Wallet row is a cached sum and can always be rebuilt from these.
    """
    model_config = ConfigDict(extra="forbid")

    id: str
    pod_id: str
    kind: Literal["deposit", "withdrawal", "bill_payment", "goal_contribution", "trip_booking", "request", "reward_redemption"]
    amount_minor: int  # Signed: positive credits the wallet, negative debits it.
    description: str
    actor_id: Optional[str] = None
    bill_id: Optional[str] = None
    goal_id: Optional[str] = None
    trip_id: Optional[str] = None
    created_at: Optional[str] = None

class RewardRedemption(BaseModel):
    """
    A reward bought from the store with Peanuts.
    """
    model_config = ConfigDict(extra="forbid")

    id: str
    pod_id: str
    catalog_id: str
    peanut_cost: int
    redeemed_by_id: Optional[str] = None
    redeemed_at: Optional[str] = None


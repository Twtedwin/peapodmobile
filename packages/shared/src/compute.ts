/**
 * MODULE: @peapod/shared/compute
 *
 * PURPOSE
 *   TypeScript mirrors of `schemas/compute.schema.json` -- the request and
 *   response payloads of the Rust compute service.
 *
 * INPUTS  : none (type declarations only)
 * OUTPUTS : compile-time types
 *
 * CONSUMED BY
 *   - services/api  : typing the compute HTTP client AND its TypeScript fallback,
 *                     which is what lets the two be substituted for each other
 *   - apps/mobile   : typing compute results that pass through the API
 *
 * WHY A FALLBACK EXISTS AT ALL
 *   Rust owns the maths because trip reconstruction over thousands of GPS fixes
 *   is genuinely hot, and because exact integer money splitting deserves a
 *   language that will not quietly hand back a float. But the compute service is
 *   an extra process, and an extra process is an extra way for a development
 *   environment to be broken. Every endpoint here therefore has a pure
 *   TypeScript twin in `packages/shared/algorithms/`, wired up as a fallback in
 *   `services/api/src/compute/`. The app degrades in speed, never in function.
 *
 *   The two implementations must agree. `services/api` has parity tests that run
 *   the same fixtures through both and compare.
 */

import type { CostLine, ItineraryDay } from './domain.js';

// ---------------------------------------------------------------------------
// Geo
// ---------------------------------------------------------------------------

/** A bare coordinate pair in WGS84 degrees. */
export interface GeoPoint {
  latitude: number;
  longitude: number;
}

/**
 * A GPS fix as fed to trip reconstruction.
 *
 * Only the fields the algorithm actually reads are included, and the timestamp
 * arrives as epoch milliseconds rather than an ISO string. That matters: the
 * original JavaScript re-parsed a `Date` per fix per loop iteration, which made
 * reconstruction quadratic in date construction and was the cause of a
 * recurring UI freeze. Numbers in, no parsing in the hot loop.
 */
export interface PingInput {
  latitude: number;
  longitude: number;
  /** Epoch milliseconds, UTC. */
  recorded_at_ms: number;
  /** Metres per second. */
  speed: number;
  /** Accuracy radius in metres. Interior fixes worse than 50 m are dropped. */
  accuracy: number;
  is_driving: boolean;
}

export interface ReconstructTripRequest {
  pings: PingInput[];
}

/**
 * A drawable journey.
 *
 * `points` is the smoothed polyline with the stationary tail at the destination
 * trimmed off, so the line ends where the member actually arrived instead of
 * smearing into a cluster of dots while their phone sat on a table.
 */
export interface ReconstructedTrip {
  /** Ordered `[latitude, longitude]` pairs. */
  points: [number, number][];
  start_at_ms: number;
  arrival_at_ms: number;
  /** Total path length along the polyline, in kilometres. */
  distance_km: number;
  /** Straight-line distance from first point to last. Distinguishes a real journey from stationary jitter. */
  net_displacement_m: number;
  /** Farthest the member ever got from the start. Catches a round trip whose net displacement is near zero. */
  max_dist_from_start_m: number;
  avg_speed_ms: number;
  /** True when the run looks like a car trip, so the caller may road-snap the line. */
  is_driving: boolean;
}

/**
 * The last confirmed trip, or null.
 *
 * Null means the member has not travelled far enough to confirm one. A journey
 * still in progress deliberately does NOT replace the previous result, so no
 * false line flashes onto the map while a real trip is still building up.
 */
export interface ReconstructTripResponse {
  trip: ReconstructedTrip | null;
}

export type ActivityLabel = 'Stationary' | 'Walking' | 'Cycling' | 'Driving';

/**
 * A human label for a speed reading.
 *
 * Speed is the only signal available at this layer -- neither platform exposes
 * OS-level activity recognition to the app without extra entitlements -- so a
 * stationary car in traffic reads as "Stationary". That is a known limitation,
 * not a bug.
 */
export interface ActivityClassification {
  label: ActivityLabel;
  driving: boolean;
}

export interface NearestPlaceRequest {
  location: GeoPoint;
  places: { id: string; latitude: number; longitude: number }[];
  /** Defaults to the geofence entry radius so "at a place" and "inside the fence" cannot disagree. */
  radius_m?: number;
}

export interface NearestPlaceResponse {
  place_id: string | null;
  distance_m: number | null;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export interface DecisionMemberVote {
  voter_id: string;
  stance: 'want' | 'maybe' | 'no';
}

export interface EvaluateDecisionRequest {
  /** The full membership. This is what makes "everyone has voted" decidable. */
  member_ids: string[];
  votes: DecisionMemberVote[];
  creator_stance?: 'want' | 'maybe' | 'no' | null;
  source_type?: 'user' | 'ai';
  status?: 'active' | 'archived' | 'converted';
  stage_override?: string | null;
}

export type DecisionOutcome = 'deciding' | 'everyone_in' | 'work_it_out' | 'maybe_later' | 'not_for_us';

/**
 * The aggregate view of an idea.
 *
 * CALLERS MUST NOT reveal any of these counts to a member until `all_voted` is
 * true. Hiding both individual stances and the running tally until everybody has
 * answered is the core fairness rule of Decide Together -- it is what stops the
 * first two votes from deciding the outcome by social pressure.
 */
export interface EvaluateDecisionResponse {
  want: number;
  maybe: number;
  no: number;
  total: number;
  voted_count: number;
  all_voted: boolean;
  outcome: DecisionOutcome;
  stage: 'deciding' | 'considering' | 'maybe_later' | 'planned' | 'archived' | 'converted';
  /** Rounded percentage, clamped to 0..100. */
  harmony: number;
}

// ---------------------------------------------------------------------------
// Progression
// ---------------------------------------------------------------------------

export interface LevelRequest {
  xp: number;
}

export interface LevelResponse {
  level: number;
  name: string;
  description: string;
  /** XP threshold of the level the pod currently occupies. */
  current_level_xp: number;
  /** Null at max level. */
  next_level_xp: number | null;
  /** Fraction of the way to the next level, 0..1. Always 1 at max level. */
  progress: number;
  /** Garden slots unlocked at this level. */
  plot_capacity: number;
}

export interface GrowthEntryInput {
  id: string;
  kind: 'plant' | 'decor';
  /** Null means pre-seeded from a past memory, which counts as fully grown. */
  planted_at_ms: number | null;
  grows_seconds: number;
  water_boost: number;
}

export interface GardenGrowthRequest {
  entries: GrowthEntryInput[];
  /** Evaluation instant, supplied by the caller so results are reproducible in tests. */
  now_ms: number;
}

export interface GardenGrowthResponse {
  growth: { id: string; growth: number; mature: boolean }[];
}

export interface AchievementRequest {
  peas_count: number;
  dates_count: number;
  pinned_journey_days: number | null;
}

export interface AchievementTier {
  threshold: number;
  label: string;
  description: string;
}

/**
 * A tiered achievement track.
 *
 * `tiers` contains every tier already unlocked, not just the newest one, so the
 * UI can let a pod page back through their own history instead of showing a
 * single current badge.
 */
export interface AchievementGroup {
  key: string;
  title: string;
  tiers: AchievementTier[];
  /** Progress from the frontier tier toward the next. 1 when the track is complete. */
  progress: number;
}

export interface AchievementResponse {
  groups: AchievementGroup[];
}

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

export interface SplitRequest {
  amount_minor: number;
  shares: { party_id: string; percent: number }[];
}

export interface SplitResponse {
  allocations: { party_id: string; amount_minor: number }[];
  /** Sum of allocations. Guaranteed equal to the requested `amount_minor`. */
  total_minor: number;
}

// ---------------------------------------------------------------------------
// Itinerary
// ---------------------------------------------------------------------------

export type BudgetTier = 'budget' | 'mid' | 'luxury';
export type TripPace = 'relaxed' | 'balanced' | 'packed';

/**
 * The direction a pod gave the planner.
 *
 * The product intent: the pod chooses destination, dates, pace, style, and
 * budget, and the planner builds the whole connected trip from the outbound
 * flight through to the return leg. The pod never has to assemble logistics by
 * hand, and never has a plan imposed that they cannot then edit.
 */
export interface ItineraryRequest {
  countries: string[];
  regions: string[];
  days: number;
  travellers: number;
  /** Travel-style tags such as `food`, `nature`, `relaxed`. Used to rank candidate activities. */
  personalities: string[];
  pace: TripPace;
  budget_tier: BudgetTier;
  start_date: string | null;
  must_see: string[];
  avoid: string[];
  currency: string;
  /** Supplying a seed makes generation reproducible, which the parity tests rely on. */
  seed: number | null;
}

export interface ItineraryResponse {
  days: ItineraryDay[];
  cost_breakdown: CostLine[];
  total_minor: number;
  cities: string[];
  /** One sentence explaining how the pod's style shaped the plan, shown under the itinerary header. */
  personalization_note: string;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export interface HealthResponse {
  status: 'ok';
  service: string;
  version: string;
}

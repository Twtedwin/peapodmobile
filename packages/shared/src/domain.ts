/**
 * MODULE: @peapod/shared/domain
 *
 * PURPOSE
 *   TypeScript mirrors of `schemas/domain.schema.json` -- the product records
 *   that used to exist only as in-memory React state and static seed data.
 *   Trips, ideas, the world, the garden, and the wallet are now real persisted
 *   records shared by every member of a pod.
 *
 * INPUTS  : none (type declarations only)
 * OUTPUTS : compile-time types
 *
 * CONSUMED BY
 *   - apps/mobile   : screen props and API response typing
 *   - services/api  : route handlers and Drizzle row mapping
 *
 * MONEY REPRESENTATION -- read before touching anything with a `_minor` suffix.
 *   Every monetary value in Peapod is an INTEGER count of the currency's minor
 *   unit (cents for SGD/USD, yen for JPY). Never a float, and never a decimal
 *   string. Floats cannot represent 0.1 exactly, so splitting a $10.00 bill
 *   three ways with floats loses or invents fractions of a cent, and a shared
 *   wallet that silently drifts is worse than useless. Format for display only
 *   at the last possible moment, with `formatMinor()` from ./money.
 */

import type { IsoDate, IsoDateTime, PodId, TripId, UserId } from './entities.js';

// ---------------------------------------------------------------------------
// Trips
// ---------------------------------------------------------------------------

/**
 * The trip lifecycle, preserved exactly from the original app.
 *
 *   suggestion -> draft -> planned -> booked -> completed
 *
 * `suggestion` is something Peapod proposed and nobody has committed to.
 * `draft` is mid-wizard. `planned` is agreed. `booked` is paid for. `completed`
 * has happened, and completion is the ONLY thing that feeds the world, garden,
 * scratch map, and collectibles -- which is why a pod cannot mark a bucket-list
 * item "visited" by hand.
 */
export type TripStatus = 'suggestion' | 'draft' | 'planned' | 'booked' | 'completed';

/** How a trip came to exist. Rendered as a badge on the trip card. */
export type TripOrigin = 'manual' | 'peapod_suggested' | 'decide_together' | 'bucket_list';

/** A single itinerary entry's kind. `flight` and `train` are always locked. */
export type ActivityKind = 'flight' | 'transfer' | 'hotel' | 'activity' | 'meal' | 'train' | 'free';

export type CostCategory = 'flights' | 'accommodation' | 'activities' | 'food' | 'transport' | 'other';

export interface ItineraryActivity {
  id: string;
  title: string;
  kind: ActivityKind;
  /** 24-hour local clock time, `HH:MM`. */
  start_time: string;
  duration_minutes: number;
  location: string | null;
  notes: string | null;
  cost_minor: number;
  /**
   * True for flights and intercity trains. The itinerary editor must refuse to
   * reorder a locked activity, because every other activity on the day is timed
   * around it -- dragging a flight would silently invalidate the whole day.
   */
  locked: boolean;
  emoji: string;
}

export interface ItineraryDay {
  /** One-based day number within the trip. */
  day: number;
  date: IsoDate | null;
  city: string;
  summary: string;
  activities: ItineraryActivity[];
}

/** One line of a trip's cost breakdown. Lines sharing a label are merged and summed for display. */
export interface CostLine {
  label: string;
  amount_minor: number;
  currency: string;
  category: CostCategory;
}

export interface Trip {
  id: TripId;
  pod_id: PodId;
  created_by_id: UserId;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
  title: string;
  /** Human-readable headline destination, e.g. "Japan" or "Tokyo & Kyoto". */
  destination: string;
  country: string | null;
  emoji: string;
  status: TripStatus;
  origin: TripOrigin;
  start_date: IsoDate | null;
  end_date: IsoDate | null;
  /** True when the pod picked a rough month instead of exact dates. */
  flexible_dates: boolean;
  participant_ids: UserId[];
  cities: string[];
  budget_minor: number | null;
  currency: string;
  /** Stored whole as a JSON document; its shape is owned by the Rust itinerary generator. */
  itinerary: ItineraryDay[];
  cost_breakdown: CostLine[];
  /** 1-5, set after completion. */
  rating: number | null;
  /** Set when an agreed Decide Together idea created this trip. */
  source_idea_id: string | null;
  completed_at: IsoDateTime | null;
}

// ---------------------------------------------------------------------------
// Decide Together
// ---------------------------------------------------------------------------

/**
 * A member's stance on an idea.
 *
 * Deliberately three-valued. `maybe` is a real answer, not a missing one, and
 * it is what routes an idea to "maybe later" rather than into a compromise
 * negotiation nobody asked for.
 */
export type VoteStance = 'want' | 'maybe' | 'no';

/**
 * Where an idea sits in the pipeline.
 *
 * `deciding` means not everyone has voted and NO aggregate may be revealed.
 * `considering` is the Work It Out bucket for a divided pod.
 */
export type IdeaStage = 'deciding' | 'considering' | 'maybe_later' | 'planned' | 'archived' | 'converted';

export type IdeaCategory =
  | 'travel'
  | 'food'
  | 'activity'
  | 'nature'
  | 'culture'
  | 'adventure'
  | 'themepark'
  | 'shopping';

export interface Idea {
  id: string;
  pod_id: PodId;
  created_by_id: UserId;
  created_at: IsoDateTime;
  title: string;
  emoji: string;
  description: string | null;
  destination: string | null;
  country: string | null;
  category: IdeaCategory;
  /** AI-sourced ideas take a small harmony penalty so a human's proposal outranks a machine's at equal support. */
  source_type: 'user' | 'ai';
  estimated_cost_minor: number | null;
  duration_days: number | null;
  activities: string[];
  preferred_month: string | null;
  preferred_dates: string | null;
  /** The creator's pre-vote, recorded at submission so they never swipe their own idea. */
  creator_stance: VoteStance | null;
  /** When set, wins over the computed stage. Operator escape hatch. */
  stage_override: IdeaStage | null;
  compromise_options: string[];
  ai_rationale: string | null;
  converted_trip_id: TripId | null;
}

/**
 * One member's stance on one idea. Unique per (idea, voter).
 *
 * PRIVACY: these are never serialised to a client while the idea is still in
 * the `deciding` stage. The API strips them, because seeing that two people
 * already said "want" is exactly the bandwagon pressure the hidden-vote rule
 * exists to prevent.
 */
export interface IdeaVote {
  id: string;
  idea_id: string;
  voter_id: UserId;
  stance: VoteStance;
  created_at: IsoDateTime;
}

// ---------------------------------------------------------------------------
// World, garden, memories
// ---------------------------------------------------------------------------

/**
 * One row per pod holding the shared progression counters.
 *
 * Level is deliberately NOT stored -- it is always derived from `xp` via the
 * thresholds in `data/rules/progression.json`, so the two can never drift.
 */
export interface PodWorld {
  pod_id: PodId;
  xp: number;
  /** The pod's spendable currency. */
  peanuts: number;
  updated_at: IsoDateTime;
}

export type GardenEntryKind = 'plant' | 'decor';

export type GardenRarity = 'common' | 'special' | 'rare' | 'treasured';

/**
 * Where a seed came from -- the distinction the garden is built around.
 *
 * `earned` seeds are granted only by real shared experiences and can never be
 * bought. `shop` seeds are cosmetic and cost Peanuts.
 */
export type SeedProvenance = 'earned' | 'shop';

export interface GardenEntry {
  id: string;
  pod_id: PodId;
  kind: GardenEntryKind;
  /** Zero-based slot index. Must be below the pod's plot capacity. */
  slot: number;
  /** Identifier into `data/rules/garden.json`. */
  catalog_id: string;
  name: string;
  emoji: string;
  rarity: GardenRarity;
  provenance: SeedProvenance;
  /** Why this plant exists, e.g. `From "Our first trip to Japan"`. */
  source_label: string | null;
  memory_id: string | null;
  /**
   * When the plant went into the soil. A null value means it is a pre-seeded
   * living record of a past memory and counts as fully grown immediately.
   */
  planted_at: IsoDateTime | null;
  grows_seconds: number;
  /** Additive growth bonus from watering, capped at 1.0. Growth never decreases and a plant never dies. */
  water_boost: number;
  watered_at: IsoDateTime | null;
  harvested_at: IsoDateTime | null;
}

export interface SeedInventoryItem {
  id: string;
  pod_id: PodId;
  catalog_id: string;
  provenance: SeedProvenance;
  quantity: number;
  earned_reason: string | null;
}

/** Drives which earned seed and which collectible a memory can unlock. */
export type MemoryTag =
  | 'everyday'
  | 'place'
  | 'travel'
  | 'milestone'
  | 'anniversary'
  | 'activity'
  | 'culinary'
  | 'nature'
  | 'treasured';

export interface Memory {
  id: string;
  pod_id: PodId;
  created_by_id: UserId;
  title: string;
  caption: string | null;
  date: IsoDate;
  location: string | null;
  latitude: number | null;
  longitude: number | null;
  tag: MemoryTag;
  /** At most three, matching the check-in UI. */
  photo_urls: string[];
  trip_id: TripId | null;
  created_at: IsoDateTime;
}

export interface UnlockedCollectible {
  id: string;
  pod_id: PodId;
  catalog_id: string;
  earned_by: string;
  memory_id: string | null;
  unlocked_at: IsoDateTime;
  /** True when the pod has placed this collectible as a landmark in their 3D world. */
  displayed: boolean;
}

/**
 * A dream destination.
 *
 * `visited` is reachable only by completing a linked trip, never by editing the
 * item -- saving a dream must not look like having been there.
 */
export interface BucketListItem {
  id: string;
  pod_id: PodId;
  created_by_id: UserId;
  title: string;
  emoji: string;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  state: 'dream' | 'planned' | 'visited';
  trip_id: TripId | null;
  created_at: IsoDateTime;
}

export interface DateActivity {
  id: string;
  pod_id: PodId;
  created_by_id: UserId;
  /** Identifier into the activity library, when scheduled from the catalog. */
  catalog_id: string | null;
  title: string;
  emoji: string;
  is_online: boolean;
  scheduled_at: IsoDateTime | null;
  participant_ids: UserId[];
  status: 'scheduled' | 'completed' | 'cancelled';
}

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

/**
 * The pod's shared wallet.
 *
 * SIMULATED: no real money moves. Every screen that touches money keeps its
 * "simulated" labelling until a payment provider is wired -- see
 * SETUP-EXTERNAL-APIS.md. The ledger is built correctly anyway (append-only,
 * integer minor units) so switching to real money is a provider integration
 * rather than a rewrite.
 */
export interface Wallet {
  pod_id: PodId;
  currency: string;
  balance_minor: number;
  updated_at: IsoDateTime;
}

export interface WalletBill {
  id: string;
  pod_id: PodId;
  name: string;
  emoji: string;
  amount_minor: number;
  due_date: IsoDate;
  frequency: 'once' | 'weekly' | 'monthly' | 'yearly';
  paid_by_id: UserId | null;
  /**
   * User id to percentage share. Must sum to 100.
   *
   * Percentages are turned into exact minor-unit amounts by the compute
   * service, which allocates the rounding remainder deterministically so the
   * shares always sum back to the total.
   */
  split_percent: Record<string, number>;
  category: string;
  last_paid_at: IsoDateTime | null;
}

/** A travel fund: a savings goal members contribute to, optionally linked to a trip. */
export interface WalletGoal {
  id: string;
  pod_id: PodId;
  name: string;
  emoji: string;
  target_minor: number;
  saved_minor: number;
  trip_id: TripId | null;
  created_at: IsoDateTime;
}

export type WalletTransactionKind =
  | 'deposit'
  | 'withdrawal'
  | 'bill_payment'
  | 'goal_contribution'
  | 'trip_booking'
  | 'request'
  | 'reward_redemption';

/**
 * An append-only ledger entry.
 *
 * Every balance change writes one. `Wallet.balance_minor` is a cached sum and
 * can always be rebuilt from these rows, which is what makes the balance
 * auditable rather than merely believable.
 */
export interface WalletTransaction {
  id: string;
  pod_id: PodId;
  actor_id: UserId | null;
  kind: WalletTransactionKind;
  /** Signed: positive credits the wallet, negative debits it. */
  amount_minor: number;
  description: string;
  bill_id: string | null;
  goal_id: string | null;
  trip_id: TripId | null;
  created_at: IsoDateTime;
}

export interface RewardRedemption {
  id: string;
  pod_id: PodId;
  redeemed_by_id: UserId;
  catalog_id: string;
  peanut_cost: number;
  redeemed_at: IsoDateTime;
}

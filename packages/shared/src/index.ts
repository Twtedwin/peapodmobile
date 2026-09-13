/**
 * MODULE: @peapod/shared
 *
 * PURPOSE
 *   The single public entry point to Peapod's cross-language contract. Import
 *   everything from `@peapod/shared`; never reach into a subpath.
 *
 * INPUTS  : none (barrel export)
 * OUTPUTS : types, rule constants, catalogs, and pure algorithm implementations
 *
 * CONSUMED BY
 *   - apps/mobile   (via Metro, resolved to TypeScript source so no build step
 *                    is needed before `npx expo start` works)
 *   - services/api  (via the compiled output in dist/)
 *
 * ============================================================================
 * WHAT LIVES WHERE
 * ============================================================================
 *   schemas/*.schema.json   The authoritative payload shapes. The Python
 *                           (Pydantic) and Rust (serde) models are GENERATED
 *                           from these by `npm run codegen`. The TypeScript
 *                           types in src/ are hand-written mirrors, verified
 *                           against the schemas by `npm run codegen:check`.
 *
 *   data/rules/*.json       Every threshold, reward value, and game rule.
 *                           Consumed by all four languages: TypeScript imports
 *                           them, Rust embeds them with include_str!, Python
 *                           reads them from disk. There is therefore exactly one
 *                           copy of every magic number in the whole system.
 *
 *   data/catalog/*.json     Static content: rewards, collectibles, the travel
 *                           dataset, the activity library, destinations.
 *
 *   data/seed/*.json        Demo data loaded by `npm run db:seed`.
 *
 *   src/algorithms/         Pure TypeScript twins of the Rust compute service,
 *                           used as its fallback and for frame-rate-sensitive
 *                           work on the client.
 */

// ---------------------------------------------------------------------------
// Record types
// ---------------------------------------------------------------------------

export type {
  AuditFields,
  CreateInput,
  FavouritePlace,
  Id,
  ImportantDate,
  IsoDate,
  IsoDateTime,
  LocationPing,
  MemoryId,
  Message,
  Notification,
  NotificationKind,
  PhoneStatus,
  PlaceAlert,
  PlaceAlertEvent,
  PlaceCategory,
  Plan,
  PlanAudience,
  PlanRepeat,
  Pod,
  PodGroupType,
  PodId,
  PodInvite,
  PodMembership,
  PodRole,
  TripId,
  UpdateInput,
  User,
  UserId,
} from './entities.js';

export type {
  ActivityKind,
  BucketListItem,
  CostCategory,
  CostLine,
  DateActivity,
  GardenEntry,
  GardenEntryKind,
  GardenRarity,
  Idea,
  IdeaCategory,
  IdeaStage,
  IdeaVote,
  ItineraryActivity,
  ItineraryDay,
  Memory,
  MemoryTag,
  PodWorld,
  RewardRedemption,
  SeedInventoryItem,
  SeedProvenance,
  Trip,
  TripOrigin,
  TripStatus,
  UnlockedCollectible,
  VoteStance,
  Wallet,
  WalletBill,
  WalletGoal,
  WalletTransaction,
  WalletTransactionKind,
} from './domain.js';

// ---------------------------------------------------------------------------
// Compute service payloads
// ---------------------------------------------------------------------------

export type {
  AchievementGroup,
  AchievementRequest,
  AchievementResponse,
  AchievementTier,
  ActivityClassification,
  ActivityLabel,
  BudgetTier,
  DecisionMemberVote,
  DecisionOutcome,
  EvaluateDecisionRequest,
  EvaluateDecisionResponse,
  GardenGrowthRequest,
  GardenGrowthResponse,
  GeoPoint,
  GrowthEntryInput,
  HealthResponse,
  ItineraryRequest,
  ItineraryResponse,
  LevelRequest,
  LevelResponse,
  NearestPlaceRequest,
  NearestPlaceResponse,
  PingInput,
  ReconstructedTrip,
  ReconstructTripRequest,
  ReconstructTripResponse,
  SplitRequest,
  SplitResponse,
  TripPace,
} from './compute.js';

// ---------------------------------------------------------------------------
// Rules and catalogs
// ---------------------------------------------------------------------------

export {
  ALL_GARDEN_SEEDS,
  COLLECTIBLES,
  DECISIONS,
  findDecor,
  findSeed,
  GARDEN,
  GEO,
  PROGRESSION,
  REWARDS,
  threshold,
} from './rules.js';

export type {
  AchievementTierRule,
  AchievementTrackRule,
  GardenDecorRule,
  GardenSeedRule,
  GardenSpeciesRule,
  Threshold,
  WorldLevel,
} from './rules.js';

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

export {
  formatMinor,
  mergeCostLines,
  minorUnitsPerMajor,
  parseMajorToMinor,
  sumMinor,
} from './money.js';

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

export {
  daysBetween,
  daysSince,
  daysUntil,
  dwellLabel,
  journeyHeadline,
  lastSeenLabel,
  nextYearlyOccurrence,
  planOccursOn,
  safeDate,
  startOfUtcDay,
} from './dates.js';

// ---------------------------------------------------------------------------
// Algorithms (pure TypeScript twins of the Rust compute service)
// ---------------------------------------------------------------------------

export * from './algorithms/index.js';

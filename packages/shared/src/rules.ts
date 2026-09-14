/**
 * MODULE: @peapod/shared/rules
 *
 * PURPOSE
 *   Typed access to the rule and catalog JSON in `../data/`. Those files are the
 *   single source of truth for every threshold, reward value, and catalog entry
 *   in Peapod; this module is the TypeScript door onto them.
 *
 * INPUTS  : the JSON files in ../data/ (imported at build time, not read from disk)
 * OUTPUTS : frozen, typed constant objects
 *
 * CONSUMED BY
 *   - apps/mobile              : rendering thresholds, costs, level names, catalogs
 *   - services/api             : awarding XP and Peanuts, seeding, compute fallbacks
 *   - packages/shared/algorithms : every ported algorithm reads its constants here
 *   (the Rust service embeds the same files with include_str!, and the Python
 *    service reads them from disk -- all three therefore agree by construction)
 *
 * WHY IMPORT THE JSON RATHER THAN READ IT
 *   React Native has no filesystem module. Importing makes the JSON part of the
 *   bundle, which works identically in Metro, Node, and a browser, and turns a
 *   malformed file into a build error instead of a runtime crash on a user's phone.
 *
 * THE `{ value, why }` WRAPPER
 *   Many thresholds in geo.json are objects like
 *     { "value": 150, "why": "Matches the geofence entry radius so ..." }
 *   rather than bare numbers. That is deliberate: a magic number with its
 *   justification attached cannot drift away from its reasoning the way a code
 *   comment can. `threshold()` below unwraps them.
 */

import decisionsJson from '../data/rules/decisions.json' with { type: 'json' };
import gardenJson from '../data/rules/garden.json' with { type: 'json' };
import geoJson from '../data/rules/geo.json' with { type: 'json' };
import progressionJson from '../data/rules/progression.json' with { type: 'json' };
import collectiblesJson from '../data/catalog/collectibles.json' with { type: 'json' };
import rewardsJson from '../data/catalog/rewards.json' with { type: 'json' };

// ---------------------------------------------------------------------------
// Unwrapping helpers
// ---------------------------------------------------------------------------

/** A documented threshold: the number plus the reason it is that number. */
export interface Threshold {
  value: number;
  why: string;
}

/**
 * Reads the number out of a documented threshold.
 *
 * @param t A `{ value, why }` object from one of the rule files.
 * @returns The bare numeric value, in whatever unit the key name declares.
 */
export function threshold(t: Threshold): number {
  return t.value;
}

/**
 * Strips the `_comment` documentation keys out of a lookup table.
 *
 * JSON has no comment syntax, so the rule files document themselves with
 * `_comment` keys sitting alongside the real data. That is the right trade for
 * a file four languages have to read, but it means a table of numbers is not
 * actually a `Record<string, number>` until the documentation is removed.
 *
 * @param table A rule-file object mixing numeric entries with `_`-prefixed docs.
 * @returns The same table with every `_`-prefixed key removed, frozen.
 */
function numericTable(table: Record<string, unknown>): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};

  for (const [key, value] of Object.entries(table)) {
    if (key.startsWith('_')) continue;
    if (typeof value === 'number') out[key] = value;
  }

  return Object.freeze(out);
}

// ---------------------------------------------------------------------------
// Geo and tracking rules
// ---------------------------------------------------------------------------

/**
 * Every distance, speed, and duration constant used by the location features,
 * flattened into bare numbers for convenience.
 *
 * Unit suffixes are part of the name on purpose: `_m` metres, `_ms`
 * milliseconds, `_mps` metres per second. A number here without its unit in the
 * name would be the easiest possible bug to introduce.
 *
 * The reasoning behind each value lives in `../data/rules/geo.json` -- read it
 * before changing any of them, and re-test against real GPS traces rather than
 * rounding a value because it looks untidy.
 */
export const GEO = Object.freeze({
  earthRadius_m: geoJson.earthRadiusM,

  /** Below this, two members render as "Together" instead of a distance. */
  togetherThreshold_m: threshold(geoJson.proximity.togetherThreshold_m),
  /** How close counts as being "at" a saved place. Equals the geofence entry radius. */
  placeRadius_m: threshold(geoJson.proximity.placeRadius_m),

  geofenceEnter_m: threshold(geoJson.geofence.enterRadius_m),
  /** Larger than the entry radius on purpose; the gap is hysteresis that stops alert flapping. */
  geofenceExit_m: threshold(geoJson.geofence.exitRadius_m),

  stationaryBelow_mps: threshold(geoJson.activityBands.stationaryBelow_mps),
  walkingBelow_mps: threshold(geoJson.activityBands.walkingBelow_mps),
  cyclingBelow_mps: threshold(geoJson.activityBands.cyclingBelow_mps),
  drivingThreshold_mps: threshold(geoJson.activityBands.drivingThreshold_mps),

  maxPlausibleSpeed_mps: threshold(geoJson.tripReconstruction.maxPlausibleSpeed_mps),
  teleportMinJump_m: threshold(geoJson.tripReconstruction.teleportMinJump_m),
  spikeNeighbourDist_m: threshold(geoJson.tripReconstruction.spikeNeighbourDist_m),
  spikeCollapseRatio: geoJson.tripReconstruction.spikeCollapseRatio.value,
  poorAccuracyCutoff_m: threshold(geoJson.tripReconstruction.poorAccuracyCutoff_m),
  tripGap_ms: threshold(geoJson.tripReconstruction.tripGap_ms),
  stopRadius_m: threshold(geoJson.tripReconstruction.stopRadius_m),
  stopDuration_ms: threshold(geoJson.tripReconstruction.stopDuration_ms),
  arrivalRadius_m: threshold(geoJson.tripReconstruction.arrivalRadius_m),
  minTripDistance_m: threshold(geoJson.tripReconstruction.minTripDistance_m),
  minNetDisplacement_m: threshold(geoJson.tripReconstruction.minNetDisplacement_m),
  drivingMaxSpeed_mps: threshold(geoJson.tripReconstruction.drivingMaxSpeed_mps),
  drivingAvgSpeed_mps: threshold(geoJson.tripReconstruction.drivingAvgSpeed_mps),
  smoothingHalfWindow: geoJson.tripReconstruction.smoothingHalfWindow.value,
  routerWaypointGap_m: threshold(geoJson.tripReconstruction.routerWaypointGap_m),

  /** A member is online when their newest ping is younger than this. Evaluated server-side. */
  onlineThreshold_ms: threshold(geoJson.presence.onlineThreshold_ms),

  minMovementToPing_m: threshold(geoJson.tracking.minMovementToPing_m),
  heartbeatInterval_ms: threshold(geoJson.tracking.heartbeatInterval_ms),
  dwellClusterRadius_m: threshold(geoJson.tracking.dwellClusterRadius_m),
  dwellSettle_ms: threshold(geoJson.tracking.dwellSettle_ms),
} as const);

// ---------------------------------------------------------------------------
// Progression rules
// ---------------------------------------------------------------------------

export interface WorldLevel {
  level: number;
  name: string;
  description: string;
  /** Cumulative XP at which this level begins. */
  xp: number;
}

export interface AchievementTierRule {
  threshold: number;
  label: string;
  description: string;
}

export interface AchievementTrackRule {
  key: string;
  title: string;
  metric: 'peas_count' | 'dates_count' | 'pinned_journey_days';
  tiers: AchievementTierRule[];
}

/**
 * The six-level world progression, XP and Peanut reward tables, plot capacity
 * formula, celebrated milestone days, and achievement tracks.
 *
 * These numbers came verbatim from the original app so an existing pod's level
 * and balance keep meaning what they used to.
 */
export const PROGRESSION = Object.freeze({
  worldLevels: progressionJson.worldLevels as readonly WorldLevel[],

  /** Garden slots = min(max, base + level * perLevel). Capacity is never purchasable. */
  plotCapacity: Object.freeze({
    base: progressionJson.gardenPlotCapacity.base,
    perLevel: progressionJson.gardenPlotCapacity.perLevel,
    max: progressionJson.gardenPlotCapacity.max,
  }),

  /** XP granted per action. Keyed by action name, e.g. `completeTrip`. */
  xp: numericTable(progressionJson.xpRewards),

  /** Peanuts granted per action. Keyed by action name, e.g. `completeTrip`. */
  peanuts: numericTable(progressionJson.peanutEarnRules),

  /** What a brand-new pod starts with: zero of everything, and a bare garden. */
  starting: Object.freeze({
    xp: progressionJson.startingBalances.xp,
    peanuts: progressionJson.startingBalances.peanuts,
  }),

  /** Day counts the scheduled milestone job celebrates. */
  milestoneDays: progressionJson.milestoneDays.days as readonly number[],

  achievementTracks: progressionJson.achievementTracks as readonly AchievementTrackRule[],
} as const);

// ---------------------------------------------------------------------------
// Decision rules
// ---------------------------------------------------------------------------

/**
 * The Decide Together rules: harmony weights, outcome thresholds, stage mapping,
 * display copy, and compromise fallbacks.
 *
 * The fairness guarantee these encode -- nobody sees any stance or aggregate
 * until every member has voted -- is enforced in the API's serialisation layer,
 * not here. This module only supplies the arithmetic.
 */
export const DECISIONS = Object.freeze({
  categories: decisionsJson.categories,

  harmony: Object.freeze({
    /** A "maybe" counts as half support: it is partial interest, not an abstention. */
    maybeWeight: decisionsJson.harmony.maybeWeight,
    /** A "no" costs this weight on top of contributing nothing, because active opposition matters more than absence. */
    noPenaltyWeight: decisionsJson.harmony.noPenaltyWeight,
    creatorWantedBonus: decisionsJson.harmony.creatorWantedBonus.value,
    aiSourcePenalty: decisionsJson.harmony.aiSourcePenalty.value,
    min: decisionsJson.harmony.clamp.min,
    max: decisionsJson.harmony.clamp.max,
  }),

  outcomeCopy: decisionsJson.outcomeCopy,
  boardSections: decisionsJson.boardSections,
  stageMapping: decisionsJson.stageMapping,
  compromiseFallbacks: decisionsJson.compromiseFallbacks,
  /** Peapod's own suggestions are mixed into the swipe queue this often, so members never hit a run of machine ideas. */
  aiInterleaveEveryNth: decisionsJson.aiSuggestionInterleave.everyNthCard,
} as const);

// ---------------------------------------------------------------------------
// Garden rules
// ---------------------------------------------------------------------------

export interface GardenSpeciesRule {
  id: string;
  name: string;
  emoji: string;
  rarity: 'common' | 'special' | 'rare' | 'treasured';
  /** The real-life moment this species stands for. */
  experience: string;
  peanutYield: number;
}

export interface GardenSeedRule {
  id: string;
  name: string;
  emoji: string;
  rarity: 'common' | 'special' | 'rare' | 'treasured';
  growsSeconds: number;
  produce: string;
  description: string;
  /** Present only on shop seeds. Earned seeds have no price by design. */
  peanutCost?: number;
  /** Present only on earned seeds. Which real experience grants them. */
  triggerTypes?: string[];
}

export interface GardenDecorRule {
  id: string;
  name: string;
  emoji: string;
  peanutCost: number;
  description: string;
}

/**
 * The garden catalogs and growth rules.
 *
 * The distinction the whole feature rests on: `earnedSeeds` are granted only by
 * real shared experiences and can never be bought, while `shopSeeds` and `decor`
 * are cosmetic purchases. Do not add a price to an earned seed.
 */
export const GARDEN = Object.freeze({
  rarities: gardenJson.rarities,
  species: gardenJson.species.items as readonly GardenSpeciesRule[],
  shopSeeds: gardenJson.shopSeeds.items as readonly GardenSeedRule[],
  earnedSeeds: gardenJson.earnedSeeds.items as readonly GardenSeedRule[],
  decor: gardenJson.decor.items as readonly GardenDecorRule[],
  crops: gardenJson.crops.items,

  /** Watering adds this much growth, capped so repeated watering cannot instantly mature a plant. */
  waterBoostPerWatering: gardenJson.growth.waterBoostPerWatering.value,
  waterBoostCap: gardenJson.growth.waterBoostCap,

  memoryTagToSpecies: gardenJson.memoryTagToSpecies as Readonly<Record<string, string>>,
  memoryTagToEarnedSeed: gardenJson.memoryTagToEarnedSeed,
  tripToEarnedSeed: gardenJson.tripToEarnedSeed,
  slotLayout: gardenJson.slotLayout,
} as const);

/** Every seed, shop and earned, in one lookup-friendly list. */
export const ALL_GARDEN_SEEDS: readonly GardenSeedRule[] = Object.freeze([
  ...GARDEN.shopSeeds,
  ...GARDEN.earnedSeeds,
]);

/**
 * Finds a seed in either catalog by id.
 *
 * @param id A seed catalog id, e.g. `seed_lavender` or `earn_sakura`.
 * @returns The seed rule, or undefined when the id is unknown (which means a
 *          stale record referencing a seed that has since been removed --
 *          callers should render a neutral placeholder rather than crash).
 */
export function findSeed(id: string): GardenSeedRule | undefined {
  return ALL_GARDEN_SEEDS.find((seed) => seed.id === id);
}

/**
 * Finds a decoration by id.
 *
 * @param id A decor catalog id, e.g. `dec_lantern`.
 * @returns The decor rule, or undefined when the id is unknown.
 */
export function findDecor(id: string): GardenDecorRule | undefined {
  return GARDEN.decor.find((decor) => decor.id === id);
}

// ---------------------------------------------------------------------------
// Catalogs
// ---------------------------------------------------------------------------

/** The Peanut reward store. Costs are in Peanuts, never money. */
export const REWARDS = Object.freeze(rewardsJson.items);

/**
 * Collectibles and the curated check-in landmarks.
 *
 * Every collectible is earned by something real -- a completed trip, a check-in,
 * a milestone. None can be bought, and saving a dream never unlocks one.
 */
export const COLLECTIBLES = Object.freeze({
  categories: collectiblesJson.categories,
  rarities: collectiblesJson.rarities,
  items: collectiblesJson.items,
  checkInPlaces: collectiblesJson.checkInPlaces.items,
} as const);

/**
 * MODULE: @peapod/shared/algorithms/progression
 *
 * PURPOSE
 *   Everything that turns a pod's real activity into visible growth: XP levels,
 *   garden plot capacity, plant growth over time, and tiered achievements.
 *
 * INPUTS  : XP totals, garden entries with plant timestamps, activity counters
 * OUTPUTS : level descriptions, growth fractions 0..1, achievement tracks
 *
 * CONSUMED BY
 *   - services/api  : the TypeScript fallback for the /progression/* endpoints,
 *                     and reward granting when an experience is recorded
 *   - apps/mobile   : the garden and world screens, which animate growth every
 *                     frame and so must compute it locally rather than poll
 *   (services/compute has the Rust twin in src/progression.rs)
 *
 * ============================================================================
 * TWO PRODUCT RULES THAT MUST SURVIVE ANY REFACTOR
 * ============================================================================
 *   1. PLANTS NEVER DIE AND GROWTH NEVER DECREASES. A pod that ignores the app
 *      for a month comes back to a garden exactly as they left it, only further
 *      along. Peapod is not a game that punishes absence -- it is a record of a
 *      relationship, and a withered garden would be a lie about one.
 *
 *   2. PLOT CAPACITY IS NEVER PURCHASABLE. Slots come only from levelling up,
 *      which comes only from real shared experiences. Selling space would make
 *      the garden a measure of spending instead of a measure of living.
 */

import { GARDEN, PROGRESSION } from '../rules.js';
import type {
  AchievementGroup,
  AchievementRequest,
  AchievementResponse,
  GardenGrowthRequest,
  GardenGrowthResponse,
  GrowthEntryInput,
  LevelResponse,
} from '../compute.js';

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

/**
 * The pod's level for a given XP total.
 *
 * Walks the whole threshold table rather than binary-searching: there are six
 * levels, so clarity beats cleverness, and walking forwards means the highest
 * satisfied threshold naturally wins even if the table were ever unsorted.
 *
 * @param xp Total XP earned by the pod. Negative values are treated as 0.
 * @returns A level between 1 and the maximum defined level.
 */
export function levelFromXp(xp: number): number {
  const safeXp = Math.max(0, xp);

  let current = 1;
  for (const level of PROGRESSION.worldLevels) {
    if (safeXp >= level.xp) current = level.level;
  }

  return current;
}

/**
 * Garden slots unlocked at a level.
 *
 * Formula: `min(max, base + max(1, level) * perLevel)` -- currently
 * `min(12, 2 + level * 2)`, so level 1 gives 4 slots and level 5 onward gives
 * the full 12.
 *
 * @param level The pod's level. Values below 1 are clamped up to 1, so a
 *              malformed level still yields a usable garden rather than zero slots.
 * @returns The number of slots, never above the hard cap.
 */
export function gardenPlotCapacity(level: number): number {
  const { base, perLevel, max } = PROGRESSION.plotCapacity;
  return Math.min(max, base + Math.max(1, level) * perLevel);
}

/**
 * The full level description for an XP total, including progress to the next level.
 *
 * @param xp Total XP earned by the pod.
 * @returns Level number, name, blurb, the current and next thresholds, a 0..1
 *          progress fraction, and the garden capacity that level unlocks.
 *
 * EDGE CASES
 *   - At maximum level `next_level_xp` is null and `progress` is 1, so a
 *     progress bar renders full rather than empty or NaN.
 *   - If two levels ever shared a threshold, the progress denominator would be
 *     zero; that is guarded so the result is 1 rather than Infinity.
 */
export function levelInfo(xp: number): LevelResponse {
  const levels = PROGRESSION.worldLevels;
  const level = levelFromXp(xp);

  const currentIndex = levels.findIndex((entry) => entry.level === level);
  // Fall back to the first level if the table and the computed level ever
  // disagree, rather than indexing out of bounds.
  const current = levels[currentIndex] ?? levels[0]!;
  const next = currentIndex >= 0 ? levels[currentIndex + 1] : undefined;

  let progress = 1;
  if (next) {
    const span = next.xp - current.xp;
    progress = span > 0 ? Math.min(1, Math.max(0, (Math.max(0, xp) - current.xp) / span)) : 1;
  }

  return {
    level: current.level,
    name: current.name,
    description: current.description,
    current_level_xp: current.xp,
    next_level_xp: next ? next.xp : null,
    progress,
    plot_capacity: gardenPlotCapacity(current.level),
  };
}

// ---------------------------------------------------------------------------
// Garden growth
// ---------------------------------------------------------------------------

/**
 * How grown a single garden entry is.
 *
 * FORMULA: `min(1, elapsedSeconds / growsSeconds + waterBoost)`
 *
 * Two cases short-circuit to fully grown:
 *   - A DECORATION has no growth concept; it is placed, not planted.
 *   - A plant with a null `planted_at` is a pre-seeded living record of a past
 *     memory. When a pod's garden is seeded from memories they already made,
 *     those plants must appear as the mature record they represent -- making a
 *     pod wait to "grow" a trip they took three years ago would be nonsense.
 *
 * @param entry  The garden entry.
 * @param now_ms Evaluation instant as epoch milliseconds. Passed in rather than
 *               read from the clock so results are reproducible in tests and
 *               identical across the Rust and TypeScript implementations.
 * @returns A fraction from 0 to 1, where 1 means mature and harvestable.
 *
 * EDGE CASES
 *   - A zero or missing `grows_seconds` would divide by zero; it is treated as
 *     instantly mature, which is the safe direction (a stuck plant is a worse
 *     bug than an early one).
 *   - A `planted_at` in the future yields negative elapsed time, which clamps
 *     to 0 rather than going negative.
 */
export function plantGrowth(entry: GrowthEntryInput, now_ms: number): number {
  if (entry.kind === 'decor') return 1;
  if (entry.planted_at_ms == null) return 1;

  const growsSeconds = entry.grows_seconds;
  if (!growsSeconds || growsSeconds <= 0) return 1;

  const elapsedSeconds = Math.max(0, (now_ms - entry.planted_at_ms) / 1000);
  const boost = Math.min(GARDEN.waterBoostCap, entry.water_boost ?? 0);

  return Math.min(1, elapsedSeconds / growsSeconds + boost);
}

/**
 * Growth for a whole garden.
 *
 * @param request Entries plus the evaluation instant.
 * @returns One result per entry, preserving input order so the caller can zip it
 *          back onto its own list without a lookup.
 */
export function gardenGrowth(request: GardenGrowthRequest): GardenGrowthResponse {
  return {
    growth: request.entries.map((entry) => {
      const growth = plantGrowth(entry, request.now_ms);
      return { id: entry.id, growth, mature: growth >= 1 };
    }),
  };
}

/**
 * The water boost a plant should have after being watered once more.
 *
 * Watering nudges a plant forward rather than completing it, and the total boost
 * is capped so that repeatedly tapping water cannot instantly mature a plant --
 * the garden should reward attention, not tapping.
 *
 * @param currentBoost The plant's existing boost, 0..1.
 * @returns The new boost, capped.
 */
export function applyWatering(currentBoost: number): number {
  return Math.min(GARDEN.waterBoostCap, (currentBoost ?? 0) + GARDEN.waterBoostPerWatering);
}

/**
 * The local (x, z) offset of a garden slot, for placing plants in the 3D world.
 *
 * Lays the slots out as a near-square grid centred on the raised bed: columns
 * are `ceil(sqrt(capacity))`, and the grid is shifted by half its extent so the
 * centre of the arrangement sits at the origin.
 *
 * @param slot     Zero-based slot index.
 * @param capacity The pod's total plot capacity, which sets the grid dimensions.
 * @returns `[x, z]` in the bed's local units.
 */
export function gardenSlotLocal(slot: number, capacity: number): [number, number] {
  const cap = Math.max(1, capacity);
  const cols = Math.ceil(Math.sqrt(cap));
  const rows = Math.ceil(cap / cols);

  const stepX = GARDEN.slotLayout.spreadX / Math.max(1, cols);
  const stepZ = GARDEN.slotLayout.spreadZ / Math.max(1, rows);

  const row = Math.floor(Math.max(0, slot) / cols);
  const col = Math.max(0, slot) % cols;

  return [(col - (cols - 1) / 2) * stepX, (row - (rows - 1) / 2) * stepZ];
}

// ---------------------------------------------------------------------------
// Earned seeds and species
// ---------------------------------------------------------------------------

/**
 * Which garden species a memory's tag grows.
 *
 * @param tag The memory's tag. Unknown and missing tags fall through to the default.
 * @returns A species id from `garden.json`.
 */
export function speciesForTag(tag: string | null | undefined): string {
  const key = (tag ?? '').toLowerCase();
  return GARDEN.memoryTagToSpecies[key] ?? GARDEN.memoryTagToSpecies['_default'] ?? 'companion';
}

/**
 * Which EARNED seed a memory grants.
 *
 * Evaluated in the order defined by `garden.json`, first match winning:
 *   1. A milestone or anniversary tag grants the rare Memory Tree.
 *   2. A location or title mentioning Japan grants Sakura. This special case is
 *      deliberate and is the clearest expression of the whole earned-seed idea:
 *      a Sakura tree in a pod's garden means they actually went to Japan, and
 *      nothing else can put one there.
 *   3. Then the general tags: travel grants Pine, a new place grants Compass.
 *
 * @param memory.tag      The memory's tag.
 * @param memory.location Where it happened.
 * @param memory.title    Its title, also searched for the location keywords.
 * @returns An earned-seed catalog id. Never a shop seed.
 */
export function earnedSeedForMemory(memory: {
  tag?: string | null;
  location?: string | null;
  title?: string | null;
}): string {
  const tag = (memory.tag ?? '').toLowerCase();
  const haystack = `${memory.location ?? ''} ${memory.title ?? ''}`.toLowerCase();

  for (const rule of GARDEN.memoryTagToEarnedSeed.order) {
    if (rule.match === 'tag' && rule.values.includes(tag)) return rule.seed;
    if (rule.match === 'locationOrTitleContains' && rule.values.some((needle) => haystack.includes(needle))) {
      return rule.seed;
    }
  }

  return GARDEN.memoryTagToEarnedSeed._default;
}

/**
 * Which EARNED seed completing a trip grants.
 *
 * @param trip.destination The trip's headline destination.
 * @param trip.country     Its country, also searched.
 * @returns An earned-seed catalog id: Sakura for Japan, otherwise a Pine Cone.
 */
export function earnedSeedForTrip(trip: { destination?: string | null; country?: string | null }): string {
  const haystack = `${trip.destination ?? ''} ${trip.country ?? ''}`.toLowerCase();

  for (const rule of GARDEN.tripToEarnedSeed.order) {
    if (rule.match === 'destinationContains' && rule.values.some((needle) => haystack.includes(needle))) {
      return rule.seed;
    }
  }

  return GARDEN.tripToEarnedSeed._default;
}

// ---------------------------------------------------------------------------
// Achievements
// ---------------------------------------------------------------------------

/**
 * Builds one tiered achievement track.
 *
 * Returns EVERY tier already unlocked, not just the newest, so the UI can let a
 * pod page back through their own history rather than replacing yesterday's
 * badge with today's. Progress is measured from the frontier tier (the latest
 * unlocked one) toward the next.
 *
 * @param key    Stable track identifier.
 * @param title  Display title.
 * @param tiers  All tiers, ascending by threshold.
 * @param value  The pod's current value for this track's metric.
 * @returns The group, or null when not even the first tier is unlocked -- a
 *          track with nothing achieved is hidden rather than shown empty.
 */
function buildGroup(
  key: string,
  title: string,
  tiers: readonly { threshold: number; label: string; description: string }[],
  value: number,
): AchievementGroup | null {
  const unlocked = tiers.filter((tier) => value >= tier.threshold);
  if (unlocked.length === 0) return null;

  const frontier = unlocked[unlocked.length - 1]!;
  const frontierIndex = tiers.indexOf(frontier);
  const next = tiers[frontierIndex + 1];

  let progress = 1;
  if (next) {
    const span = next.threshold - frontier.threshold;
    progress = span > 0 ? Math.min(1, Math.max(0, (value - frontier.threshold) / span)) : 1;
  }

  return {
    key,
    title,
    tiers: unlocked.map((tier) => ({
      threshold: tier.threshold,
      label: tier.label,
      description: tier.description,
    })),
    progress,
  };
}

/**
 * Computes every achievement track for a pod.
 *
 * @param request.peas_count          How many members the pod has.
 * @param request.dates_count         How many important dates they have recorded.
 * @param request.pinned_journey_days Days elapsed on the pinned headline journey,
 *                                    or null when nothing is pinned -- in which
 *                                    case the time-together track is omitted
 *                                    entirely rather than shown at zero.
 * @returns The unlocked tracks, in a stable display order.
 */
export function computeAchievements(request: AchievementRequest): AchievementResponse {
  const groups: AchievementGroup[] = [];

  const metricValue = (metric: string): number | null => {
    switch (metric) {
      case 'peas_count':
        // Defaults to 1: a pod always contains at least the person looking at it,
        // so the "First Pod" tier is unlocked the moment a pod exists.
        return request.peas_count || 1;
      case 'dates_count':
        return request.dates_count;
      case 'pinned_journey_days':
        return request.pinned_journey_days;
      default:
        return null;
    }
  };

  for (const track of PROGRESSION.achievementTracks) {
    const value = metricValue(track.metric);
    if (value == null) continue; // nothing pinned, so the track does not apply

    const group = buildGroup(track.key, track.title, track.tiers, value);
    if (group) groups.push(group);
  }

  return { groups };
}

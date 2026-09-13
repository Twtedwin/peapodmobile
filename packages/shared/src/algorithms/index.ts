/**
 * MODULE: @peapod/shared/algorithms
 *
 * PURPOSE
 *   Barrel export for the pure TypeScript implementations of every algorithm the
 *   Rust compute service owns.
 *
 * INPUTS  : none (re-exports only)
 * OUTPUTS : the algorithm functions
 *
 * CONSUMED BY
 *   - services/api  : `src/compute/fallback.ts` wraps these into the same
 *                     interface as the HTTP client, so the API can substitute
 *                     one for the other transparently
 *   - apps/mobile   : the screens that need results at frame rate (garden growth
 *                     animation, live distance readouts, split preview sliders)
 *                     call these directly instead of round-tripping to the server
 *
 * ============================================================================
 * WHY TWO IMPLEMENTATIONS OF THE SAME MATHS EXIST
 * ============================================================================
 *   Rust owns the maths in production: trip reconstruction runs over thousands
 *   of GPS fixes per member, and exact integer money splitting deserves a
 *   language that will not quietly hand back a float.
 *
 *   But an extra service is an extra thing that can be down, and a developer who
 *   has not started the Rust container should still get a working app. So every
 *   compute endpoint has a twin here. The consequence is a hard rule:
 *
 *     ANY CHANGE TO AN ALGORITHM MUST BE MADE IN BOTH PLACES.
 *
 *   The parity tests in `services/api/test/compute-parity.test.ts` run identical
 *   fixtures through both implementations and fail if the outputs differ, so a
 *   one-sided change is caught rather than discovered in production.
 */

// Spherical geometry, proximity, and speed classification.
export {
  areTogether,
  classifyActivity,
  downsampleByDistance,
  formatDistance,
  haversine,
  isDriving,
  isInsideGeofence,
  nearestPlace,
  toKmh,
} from './geo.js';

// GPS trip reconstruction.
export { agoLabel, lastTripFrom } from './trips.js';

// Decide Together tallying, outcomes, and harmony scoring.
export {
  compromiseSuggestions,
  consensusScore,
  evaluateDecision,
  interestOf,
  interleaveSuggestions,
  outcomeOf,
  stageOf,
} from './decisions.js';
export type { IdeaStageValue, InterestTally } from './decisions.js';

// XP levels, garden growth, earned seeds, and achievements.
export {
  applyWatering,
  computeAchievements,
  earnedSeedForMemory,
  earnedSeedForTrip,
  gardenGrowth,
  gardenPlotCapacity,
  gardenSlotLocal,
  levelFromXp,
  levelInfo,
  plantGrowth,
  speciesForTag,
} from './progression.js';

// Exact integer money splitting and wallet arithmetic.
export {
  balanceFromLedger,
  daysUntilDue,
  goalProgress,
  isValidSplit,
  splitAmount,
  splitEqually,
} from './wallet.js';

// Connected-trip generation from the travel catalog.
export { generateItinerary } from './itinerary.js';

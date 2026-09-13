/**
 * MODULE: @peapod/shared/algorithms/trips
 *
 * PURPOSE
 *   Reconstructs the one journey worth drawing from a member's raw GPS history.
 *   This is the most subtle algorithm in Peapod, and the one users judge the
 *   product by: if the line on the map is wrong, the app looks broken.
 *
 * INPUTS  : an unordered list of GPS fixes (lat, lng, epoch ms, speed, accuracy)
 * OUTPUTS : the most recent CONFIRMED trip as a smoothed polyline plus metrics,
 *           or null when the member has not actually travelled
 *
 * CONSUMED BY
 *   - services/api  : the TypeScript fallback for POST /trips/reconstruct
 *   (services/compute has the Rust twin in src/trips.rs, which is what normally
 *    runs -- this pipeline is O(n) but n is thousands of fixes per member)
 *
 * ============================================================================
 * THE PIPELINE, IN ORDER. THE ORDER IS LOAD-BEARING.
 * ============================================================================
 *
 *   1. SORT by timestamp. Callers may pass fixes in any order.
 *
 *   2. FILTER TELEPORTS. Remove fixes that put the member somewhere they could
 *      not physically have been. This MUST happen before trip detection: a
 *      single bad GPS lock two kilometres away would otherwise register as a
 *      journey the member never made, and shoot the line off across the city.
 *
 *   3. SPLIT INTO RUNS by long gaps between fixes. A gap means tracking was
 *      paused, not that the member teleported.
 *
 *   4. SPLIT EACH RUN AT INTERIOR STOPS. A stop is an arrival, and an arrival
 *      ends a trip. Without this, driving home and then driving out again
 *      renders as one continuous line that retraces itself.
 *
 *   5. BUILD each candidate: measure it, trim the stationary tail at the
 *      destination, sense whether it was a car trip.
 *
 *   6. CONFIRM. A candidate is only a real trip if the member both covered
 *      enough ground AND got far enough from where they started.
 *
 *   7. Return the LAST confirmed candidate. An unconfirmed journey in progress
 *      does not replace the previous result, so no false line flashes onto the
 *      map while a real trip is still accumulating.
 *
 * ============================================================================
 * WHY CONFIRMATION NEEDS TWO CONDITIONS
 * ============================================================================
 *   A phone sitting on a table still produces fixes, and those fixes wander by
 *   10-20 m each. Summed over an hour, that wander accumulates hundreds of
 *   metres of "path length" while the phone never moved at all. Path length
 *   alone would therefore draw a trip for a stationary member every time.
 *
 *   Requiring real DISPLACEMENT fixes that. But plain end-to-end displacement
 *   would then reject a genuine round walk that returns home, whose start and
 *   end are the same point. So the second condition is satisfied by EITHER net
 *   displacement OR the farthest the member ever got from the start -- a round
 *   walk passes on the second, stationary jitter fails on both.
 */

import { GEO } from '../rules.js';
import type { PingInput, ReconstructedTrip } from '../compute.js';
import { haversine } from './geo.js';

/** A fix that has passed sorting, with its timestamp already numeric. */
type Fix = PingInput;

// ---------------------------------------------------------------------------
// Step 2: teleport removal
// ---------------------------------------------------------------------------

/**
 * Removes GPS "teleports" -- fixes placing the member somewhere they could not
 * physically have been.
 *
 * TWO PASSES:
 *
 *   Pass 1, impossible jumps. If getting from the previous kept fix to this one
 *   would require travelling faster than any realistic ground vehicle, this fix
 *   is a bad lock. Note the AND with a minimum jump distance: a 5 m wobble
 *   between two fixes one second apart also implies an "impossible" 18 km/h of
 *   noise, and filtering those would strip out legitimate slow movement. Only a
 *   jump that is both implausibly fast and genuinely far is discarded.
 *
 *   Pass 2, V-spikes. The classic single-fix outlier: the position darts far
 *   away for exactly one fix and snaps straight back. It is recognisable because
 *   the suspect point is far from BOTH temporal neighbours while those two
 *   neighbours are close to each other. Pass 1 cannot catch this on its own,
 *   because if the spike is far enough out, the jump back looks equally
 *   impossible and the algorithm cannot tell which of the two is the liar.
 *
 * @param pings Fixes sorted ascending by `recorded_at_ms`.
 * @returns The surviving fixes, still sorted. First and last are always kept.
 */
function filterTeleports(pings: readonly Fix[]): Fix[] {
  if (pings.length < 3) return [...pings];

  // --- Pass 1: impossible speed between consecutive fixes ---
  const speedFiltered: Fix[] = [pings[0]!];
  for (let i = 1; i < pings.length; i++) {
    const previous = speedFiltered[speedFiltered.length - 1]!;
    const current = pings[i]!;

    const elapsedSeconds = (current.recorded_at_ms - previous.recorded_at_ms) / 1000;
    const jump_m = haversine(previous.latitude, previous.longitude, current.latitude, current.longitude);

    const impossiblyFast = elapsedSeconds > 0 && jump_m / elapsedSeconds > GEO.maxPlausibleSpeed_mps;
    const genuinelyFar = jump_m > GEO.teleportMinJump_m;
    if (impossiblyFast && genuinelyFar) continue;

    speedFiltered.push(current);
  }

  if (speedFiltered.length < 3) return speedFiltered;

  // --- Pass 2: V-spikes ---
  const out: Fix[] = [speedFiltered[0]!];
  for (let i = 1; i < speedFiltered.length - 1; i++) {
    const previous = speedFiltered[i - 1]!;
    const current = speedFiltered[i]!;
    const next = speedFiltered[i + 1]!;

    const toPrevious = haversine(previous.latitude, previous.longitude, current.latitude, current.longitude);
    const toNext = haversine(current.latitude, current.longitude, next.latitude, next.longitude);
    const neighbourGap = haversine(previous.latitude, previous.longitude, next.latitude, next.longitude);

    const farFromBoth = toPrevious > GEO.spikeNeighbourDist_m && toNext > GEO.spikeNeighbourDist_m;
    // The neighbours being much closer to each other than to the suspect point
    // is the signature of an out-and-back excursion by a single bad fix.
    const neighboursCollapse = neighbourGap < Math.min(toPrevious, toNext) * GEO.spikeCollapseRatio;
    if (farFromBoth && neighboursCollapse) continue;

    out.push(current);
  }

  out.push(speedFiltered[speedFiltered.length - 1]!);
  return out;
}

// ---------------------------------------------------------------------------
// Step 4: split a run at interior stops
// ---------------------------------------------------------------------------

/**
 * Splits one time-continuous run into sub-trips at interior stops.
 *
 * A "stop" is a fix after which the member stays within the stop radius for at
 * least the stop duration -- five minutes inside 80 m. That is long enough to
 * ignore a red light or a quick pick-up, short enough to catch a real arrival.
 *
 * The sub-trip before a stop ends AT the arrival fix; the next sub-trip begins
 * when the member leaves the stationary cluster. This is what stops a fresh
 * journey from being drawn as a continuation of the previous one.
 *
 * PERFORMANCE
 *   The window scan uses two pointers, and `j` only ever moves forward, so the
 *   time scan is linear overall. The original JavaScript constructed a `Date`
 *   per fix per iteration, which made this quadratic in date parsing and was
 *   the direct cause of a recurring UI freeze whenever a new fix arrived. Do not
 *   reintroduce per-iteration timestamp parsing here.
 *
 * @param run Fixes from a single uninterrupted tracking period, sorted ascending.
 * @returns One or more sub-trips, in chronological order. Never empty.
 */
function splitRunByStops(run: readonly Fix[]): Fix[][] {
  if (run.length < 2) return [[...run]];

  const subTrips: Fix[][] = [];
  let segmentStart = 0;
  let i = 0;
  let j = 0;

  while (i < run.length - 1) {
    const anchor = run[i]!;
    const anchorTime = anchor.recorded_at_ms;

    // Advance the window end to the first fix at least stopDuration after the
    // anchor. `j` never moves backwards, which is what keeps this linear.
    if (j < i) j = i;
    while (j < run.length && run[j]!.recorded_at_ms - anchorTime < GEO.stopDuration_ms) j++;

    // How far the member strayed from the anchor within that window.
    let farthest_m = 0;
    for (let k = i; k < j; k++) {
      const fix = run[k]!;
      const distance_m = haversine(anchor.latitude, anchor.longitude, fix.latitude, fix.longitude);
      if (distance_m > farthest_m) farthest_m = distance_m;
    }

    // When `j` ran off the end, the window never actually reached the full stop
    // duration, so measure what we really observed instead of assuming it.
    const elapsed_ms =
      j < run.length ? GEO.stopDuration_ms : j > i ? run[j - 1]!.recorded_at_ms - anchorTime : 0;

    const isStop = elapsed_ms >= GEO.stopDuration_ms && farthest_m <= GEO.stopRadius_m;

    if (isStop) {
      // Extend the stop over every following fix still inside the radius -- the
      // member sitting at their destination.
      let k = i;
      while (
        k < run.length &&
        haversine(anchor.latitude, anchor.longitude, run[k]!.latitude, run[k]!.longitude) <= GEO.stopRadius_m
      ) {
        k++;
      }

      // The trip before the stop runs up to and including the arrival fix.
      if (i >= segmentStart) subTrips.push(run.slice(segmentStart, i + 1));

      segmentStart = k; // the next trip starts after the stationary cluster
      i = k;
    } else {
      i++;
    }
  }

  if (segmentStart < run.length) subTrips.push(run.slice(segmentStart));
  return subTrips;
}

// ---------------------------------------------------------------------------
// Step 5 helpers: cleaning and smoothing the drawn line
// ---------------------------------------------------------------------------

/**
 * Removes jitter from a route BEFORE smoothing, so the drawn line reads as the
 * path actually travelled rather than a scribble.
 *
 * TWO PASSES:
 *   1. Drop interior fixes whose reported accuracy is worse than the cutoff. A
 *      fix with a 200 m accuracy radius can be a couple of streets away from
 *      where the member really was.
 *   2. Drop V-spikes, by the same geometric test as teleport filtering but at a
 *      finer scale -- this is about cosmetic wobble, not impossible travel.
 *
 * The first and last fixes are always kept, so the "Left X min ago" origin pin
 * and the destination stay exactly where the member was.
 *
 * @param points A single sub-trip's fixes.
 * @returns The cleaned fixes.
 */
function cleanRoutePoints(points: readonly Fix[]): Fix[] {
  if (points.length < 3) return [...points];

  // --- Pass 1: poor accuracy ---
  const accuracyFiltered: Fix[] = [points[0]!];
  for (let i = 1; i < points.length - 1; i++) {
    const fix = points[i]!;
    const accuracy_m = typeof fix.accuracy === 'number' ? fix.accuracy : 0;
    if (accuracy_m > GEO.poorAccuracyCutoff_m) continue;
    accuracyFiltered.push(fix);
  }
  accuracyFiltered.push(points[points.length - 1]!);

  if (accuracyFiltered.length < 3) return accuracyFiltered;

  // --- Pass 2: V-spikes ---
  // Compares against the last KEPT point rather than the raw previous one, so a
  // run of consecutive spikes cannot chain into looking legitimate.
  const out: Fix[] = [accuracyFiltered[0]!];
  for (let i = 1; i < accuracyFiltered.length - 1; i++) {
    const previous = out[out.length - 1]!;
    const current = accuracyFiltered[i]!;
    const next = accuracyFiltered[i + 1]!;

    const toPrevious = haversine(previous.latitude, previous.longitude, current.latitude, current.longitude);
    const toNext = haversine(current.latitude, current.longitude, next.latitude, next.longitude);
    const neighbourGap = haversine(previous.latitude, previous.longitude, next.latitude, next.longitude);

    if (
      toPrevious > GEO.spikeNeighbourDist_m &&
      toNext > GEO.spikeNeighbourDist_m &&
      neighbourGap < Math.min(toPrevious, toNext) * GEO.spikeCollapseRatio
    ) {
      continue;
    }

    out.push(current);
  }

  out.push(accuracyFiltered[accuracyFiltered.length - 1]!);
  return out;
}

/**
 * Smooths a polyline with a moving average so the line follows the path instead
 * of zig-zagging with residual GPS jitter. A real walk should read as a clean
 * curve, not a scribble of small jumps.
 *
 * The endpoints are preserved exactly, and all the DETECTION metrics (path
 * length, displacement, speed) are computed from the raw fixes before this runs.
 * Smoothing therefore only changes how the line looks, never whether a trip is
 * confirmed or how far it is reported to be.
 *
 * @param points Ordered `[latitude, longitude]` pairs.
 * @returns A polyline of the same length, with interior points averaged over a
 *          window of `2 * halfWindow + 1` points, clamped at the edges.
 */
function smoothTrip(points: readonly [number, number][]): [number, number][] {
  // Below five points a moving average has nothing useful to average over and
  // would just flatten a short, legitimate path.
  if (points.length < 5) return [...points];

  const halfWindow = GEO.smoothingHalfWindow;
  const out: [number, number][] = [points[0]!];

  for (let i = 1; i < points.length - 1; i++) {
    let sumLat = 0;
    let sumLng = 0;
    let count = 0;

    // Clamped to interior indices only: including the fixed endpoints in the
    // average would drag the start and end of the line inward.
    const from = Math.max(1, i - halfWindow);
    const to = Math.min(points.length - 2, i + halfWindow);
    for (let j = from; j <= to; j++) {
      const point = points[j]!;
      sumLat += point[0];
      sumLng += point[1];
      count++;
    }

    out.push([sumLat / count, sumLng / count]);
  }

  out.push(points[points.length - 1]!);
  return out;
}

// ---------------------------------------------------------------------------
// Step 5: build a candidate trip
// ---------------------------------------------------------------------------

/**
 * Turns a sub-trip's fixes into a measured, drawable candidate.
 *
 * STEPS:
 *   1. Sum the path length over every raw fix.
 *   2. Find the arrival: walk backwards from the final fix to the last fix that
 *      was still meaningfully far from it. Everything after that is "arrived and
 *      sitting still" and is kept out of the drawn route, so the line ends at
 *      the destination instead of smearing into a dot cluster there.
 *   3. Sense whether this was a car trip, so the caller may road-snap it. Trust
 *      the device's own flag, and back it up with speed, because the flag is a
 *      heuristic too.
 *   4. Measure net displacement and the farthest distance reached from the
 *      start. These two are what the confirmation test in `lastTripFrom` uses.
 *   5. Clean and smooth the polyline for display.
 *
 * @param points A candidate sub-trip's fixes, sorted ascending.
 * @returns The measured candidate, or null when it has fewer than two route
 *          points and so cannot be drawn at all.
 */
function buildTrip(points: readonly Fix[]): ReconstructedTrip | null {
  if (points.length < 2) return null;

  // --- 1. Path length over the raw fixes ---
  let pathLength_m = 0;
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1]!;
    const current = points[i]!;
    pathLength_m += haversine(previous.latitude, previous.longitude, current.latitude, current.longitude);
  }

  // --- 2. Trim the stationary tail at the destination ---
  const finalFix = points[points.length - 1]!;
  let arrivalIndex = -1;
  for (let i = points.length - 2; i >= 0; i--) {
    const fix = points[i]!;
    if (haversine(fix.latitude, fix.longitude, finalFix.latitude, finalFix.longitude) > GEO.arrivalRadius_m) {
      arrivalIndex = i;
      break;
    }
  }
  // arrivalIndex === -1 means every fix was already within the arrival radius of
  // the last one, i.e. the member never left: keep the whole thing and let the
  // confirmation test reject it.
  const routeEnd = arrivalIndex < 0 ? points.length - 1 : arrivalIndex;
  const route = points.slice(0, routeEnd + 1);
  if (route.length < 2) return null;

  // --- 3. Driving detection ---
  let maxSpeed_mps = 0;
  let anyDeviceDrivingFlag = false;
  for (const fix of route) {
    if (fix.is_driving) anyDeviceDrivingFlag = true;
    if (typeof fix.speed === 'number' && fix.speed > maxSpeed_mps) maxSpeed_mps = fix.speed;
  }

  const firstRoutePoint = route[0]!;
  const durationSeconds = (points[routeEnd]!.recorded_at_ms - firstRoutePoint.recorded_at_ms) / 1000;
  const avgSpeed_mps = durationSeconds > 0 ? pathLength_m / durationSeconds : 0;

  const is_driving =
    anyDeviceDrivingFlag ||
    maxSpeed_mps >= GEO.drivingMaxSpeed_mps ||
    avgSpeed_mps >= GEO.drivingAvgSpeed_mps;

  // --- 4. Displacement metrics used by confirmation ---
  const lastRoutePoint = route[route.length - 1]!;
  const net_displacement_m = haversine(
    firstRoutePoint.latitude,
    firstRoutePoint.longitude,
    lastRoutePoint.latitude,
    lastRoutePoint.longitude,
  );

  let max_dist_from_start_m = 0;
  for (const fix of route) {
    const distance_m = haversine(
      firstRoutePoint.latitude,
      firstRoutePoint.longitude,
      fix.latitude,
      fix.longitude,
    );
    if (distance_m > max_dist_from_start_m) max_dist_from_start_m = distance_m;
  }

  // --- 5. Cosmetic cleanup for the drawn line ---
  const cleaned = cleanRoutePoints(route);
  const polyline = smoothTrip(cleaned.map((fix): [number, number] => [fix.latitude, fix.longitude]));

  return {
    points: polyline,
    start_at_ms: firstRoutePoint.recorded_at_ms,
    arrival_at_ms: points[routeEnd]!.recorded_at_ms,
    distance_km: pathLength_m / 1000,
    net_displacement_m,
    max_dist_from_start_m,
    avg_speed_ms: avgSpeed_mps,
    is_driving,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Reconstructs the most recent CONFIRMED trip from a member's GPS history.
 *
 * @param pings A member's fixes, in any order. Safe to pass an empty array.
 * @returns The last confirmed trip, or null when the member has not travelled
 *          far enough for one to be confirmed.
 *
 * EDGE CASES
 *   - Fewer than two fixes: null.
 *   - A stationary phone producing hours of jitter: null, because the
 *     displacement condition fails.
 *   - A trip currently in progress that has not yet met the thresholds: null,
 *     and the caller should keep showing whatever it had before rather than
 *     clearing the map.
 */
export function lastTripFrom(pings: readonly PingInput[] | null | undefined): ReconstructedTrip | null {
  if (!pings || pings.length === 0) return null;

  // --- 1. Sort ---
  const sortedRaw = [...pings].sort((a, b) => a.recorded_at_ms - b.recorded_at_ms);

  // --- 2. Teleports out, before any trip detection ---
  const sorted = filterTeleports(sortedRaw);
  if (sorted.length < 2) return null;

  // --- 3. Split into runs at long gaps (tracking paused) ---
  const runs: Fix[][] = [];
  let currentRun: Fix[] = [sorted[0]!];
  for (let i = 1; i < sorted.length; i++) {
    const gap_ms = sorted[i]!.recorded_at_ms - sorted[i - 1]!.recorded_at_ms;
    if (gap_ms > GEO.tripGap_ms) {
      runs.push(currentRun);
      currentRun = [sorted[i]!];
    } else {
      currentRun.push(sorted[i]!);
    }
  }
  runs.push(currentRun);

  // --- 4. Split each run at interior stops (arrivals) ---
  const candidates: Fix[][] = [];
  for (const run of runs) candidates.push(...splitRunByStops(run));

  // --- 5 & 6. Build and confirm; keep the most recent confirmed one ---
  let lastConfirmed: ReconstructedTrip | null = null;
  for (const candidate of candidates) {
    const trip = buildTrip(candidate);
    if (!trip) continue;

    const coveredEnoughGround = trip.distance_km * 1000 >= GEO.minTripDistance_m;
    // Either measure of displacement satisfies this: net displacement catches a
    // one-way journey, max distance from start catches a round trip that
    // returned home. Stationary jitter satisfies neither.
    const actuallyWentSomewhere =
      Math.max(trip.net_displacement_m, trip.max_dist_from_start_m) >= GEO.minNetDisplacement_m;

    if (coveredEnoughGround && actuallyWentSomewhere) lastConfirmed = trip;
  }

  return lastConfirmed;
}

/**
 * Renders how long ago a trip ended.
 *
 * The label deliberately stops being precise after an hour, and the caller
 * removes the overlay entirely at 90 minutes -- a stale "left 4 hours ago"
 * banner is clutter, not information.
 *
 * @param elapsed_ms Milliseconds since the member left.
 * @returns `"Just now"`, `"Left 12 min ago"`, or `"Left 1hr ago"`.
 */
export function agoLabel(elapsed_ms: number): string {
  const minutes = Math.round(elapsed_ms / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `Left ${minutes} min ago`;
  return 'Left 1hr ago';
}

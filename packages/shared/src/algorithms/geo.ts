/**
 * MODULE: @peapod/shared/algorithms/geo
 *
 * PURPOSE
 *   Spherical geometry and speed classification. The foundation every other
 *   location feature is built on: presence, geofencing, "together" detection,
 *   trip reconstruction, and the distance shown on a member's card.
 *
 * INPUTS  : coordinates in WGS84 decimal degrees; speeds in metres per second
 * OUTPUTS : distances in metres; labels as plain strings
 *
 * CONSUMED BY
 *   - services/api  : the TypeScript fallback for the Rust compute service
 *   - apps/mobile   : live distance readouts, which must update at frame rate
 *                     and so are computed locally rather than round-tripped
 *   (services/compute has the Rust twin of this module in src/geo.rs)
 *
 * ACCURACY NOTE
 *   Every function here models the Earth as a sphere of a single radius. That is
 *   off by up to about 0.5% versus a proper ellipsoidal calculation, because the
 *   Earth is flattened at the poles. For this product that error is irrelevant:
 *   the largest distance anything here decides on is a 220 m geofence, where
 *   0.5% is one metre -- far inside consumer GPS accuracy, which is 5-50 m on a
 *   good day. Using a Vincenty or Karney solution would add real complexity to
 *   buy precision that GPS noise would immediately swamp.
 */

import { GEO } from '../rules.js';
import type { ActivityClassification, ActivityLabel } from '../compute.js';

/** Degrees to radians. Hoisted so it is not recomputed inside the distance loops. */
const DEG_TO_RAD = Math.PI / 180;

/**
 * Great-circle distance between two coordinates.
 *
 * Uses the haversine formula, which stays numerically stable for the small
 * distances this app cares about. (The simpler spherical law of cosines loses
 * precision badly under about 1 km because it takes the arccosine of a value
 * extremely close to 1.)
 *
 * @param lat1 Latitude of the first point, decimal degrees.
 * @param lon1 Longitude of the first point, decimal degrees.
 * @param lat2 Latitude of the second point, decimal degrees.
 * @param lon2 Longitude of the second point, decimal degrees.
 * @returns Distance in METRES. Always non-negative.
 *
 * EDGE CASES
 *   - Identical points return exactly 0.
 *   - Handles the antimeridian correctly: the formula works on the difference of
 *     longitudes through a sine, so a jump from +179 to -179 degrees is treated
 *     as the 2-degree hop it really is, not a 358-degree one.
 */
export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLon = (lon2 - lon1) * DEG_TO_RAD;

  // `a` is the square of half the chord length between the points.
  const sinHalfLat = Math.sin(dLat / 2);
  const sinHalfLon = Math.sin(dLon / 2);
  const a =
    sinHalfLat * sinHalfLat +
    Math.cos(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) * sinHalfLon * sinHalfLon;

  // atan2 rather than asin: atan2 stays accurate as `a` approaches 1
  // (antipodal points), where asin would lose all precision.
  return GEO.earthRadius_m * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Finds the first saved place a location falls inside.
 *
 * Returns the FIRST match rather than the closest, matching the original
 * behaviour. That is intentional and worth keeping: saved places are ordered
 * with the most significant first (home, work), and when two overlap -- a cafe
 * inside a mall, say -- the earlier one is the more meaningful label. Picking
 * the geometrically nearest would flip the label back and forth as GPS drifted
 * between two nearby places.
 *
 * @param location The member's current position.
 * @param places   Candidate saved places, in significance order.
 * @param radius_m How close counts as "at" the place. Defaults to the shared
 *                 place radius, which equals the geofence entry radius so the
 *                 two can never disagree.
 * @returns The matching place and its distance in metres, or null when the
 *          member is not at any saved place.
 */
export function nearestPlace<T extends { latitude: number; longitude: number }>(
  location: { latitude: number; longitude: number } | null | undefined,
  places: readonly T[] | null | undefined,
  radius_m: number = GEO.placeRadius_m,
): { place: T; distance_m: number } | null {
  if (!location || !places || places.length === 0) return null;

  for (const place of places) {
    const distance_m = haversine(location.latitude, location.longitude, place.latitude, place.longitude);
    if (distance_m <= radius_m) return { place, distance_m };
  }

  return null;
}

/**
 * Renders a distance for display.
 *
 * The precision deliberately coarsens with distance, because precision the GPS
 * cannot support reads as false confidence. "1.2 km" is honest; "1,237 m" is
 * not, when the fix itself is +/- 20 m.
 *
 * @param metres Distance in metres, or null/undefined when unknown.
 * @returns A short label: `"Together"`, `"420 m"`, `"1.2 km"`, `"38 km"`, or an
 *          em dash when the distance is unknown.
 */
export function formatDistance(metres: number | null | undefined): string {
  if (metres == null) return '—';
  // Below the together threshold the exact number is noise, and the social fact
  // ("you are in the same place") is what the member wants to read.
  if (metres <= GEO.togetherThreshold_m) return 'Together';
  if (metres < 1000) return `${Math.round(metres)} m`;
  if (metres < 10000) return `${(metres / 1000).toFixed(1)} km`;
  return `${Math.round(metres / 1000)} km`;
}

/**
 * Converts metres per second to whole kilometres per hour.
 *
 * @param mps Speed in metres per second. Null and undefined are treated as 0.
 * @returns Speed in km/h, rounded to an integer.
 */
export function toKmh(mps: number | null | undefined): number {
  return Math.round((mps ?? 0) * 3.6);
}

/**
 * Whether a speed reading looks like vehicle travel.
 *
 * @param mps Speed in metres per second.
 * @returns True above roughly 11 km/h.
 */
export function isDriving(mps: number | null | undefined): boolean {
  return (mps ?? 0) > GEO.drivingThreshold_mps;
}

/**
 * Classifies a speed reading into a human activity label.
 *
 * Band boundaries, from `data/rules/geo.json`:
 *   < 0.6 m/s  (~2 km/h)   Stationary  -- standing still, or pure GPS noise
 *   < 1.6 m/s  (~6 km/h)   Walking
 *   < 3.0 m/s  (~11 km/h)  Cycling     -- or a brisk jog
 *   >= 3.0 m/s             Driving
 *
 * @param mps Speed in metres per second.
 * @returns The label plus a driving flag, so callers do not re-derive it.
 *
 * KNOWN LIMITATION
 *   This is best-effort. Neither mobile platform gives this layer the
 *   accelerometer-based activity recognition that would distinguish a passenger
 *   on a bus from a cyclist, so a car stopped at a red light reads as
 *   "Stationary" and a fast downhill cyclist reads as "Driving".
 */
export function classifyActivity(mps: number | null | undefined): ActivityClassification {
  const speed = mps ?? 0;

  let label: ActivityLabel;
  if (speed < GEO.stationaryBelow_mps) label = 'Stationary';
  else if (speed < GEO.walkingBelow_mps) label = 'Walking';
  else if (speed < GEO.cyclingBelow_mps) label = 'Cycling';
  else label = 'Driving';

  return { label, driving: label === 'Driving' };
}

/**
 * Reduces a dense polyline to distance-spaced waypoints.
 *
 * WHY THIS EXISTS
 *   Road-snapping routers behave badly at both extremes. Feed one every raw GPS
 *   fix and it U-turns onto noisy mid-block points, drawing the same street
 *   twice. Feed it only origin and destination and it collapses a real revisit
 *   into a single pass, so a street the member genuinely drove down twice is
 *   drawn once. Spacing waypoints a few hundred metres apart follows the actual
 *   path while staying sparse enough to avoid the phantom U-turns.
 *
 * @param points   Ordered `[latitude, longitude]` pairs.
 * @param minGap_m Minimum spacing between kept waypoints, in metres.
 * @returns A subset of the input, always including the first and last points so
 *          the origin pin and destination stay exactly where the member was.
 */
export function downsampleByDistance(
  points: readonly [number, number][],
  minGap_m: number = GEO.routerWaypointGap_m,
): [number, number][] {
  if (points.length <= 2) return [...points];

  const first = points[0]!;
  const out: [number, number][] = [first];
  let last = first;

  // Interior points only -- the final point is appended unconditionally below.
  for (let i = 1; i < points.length - 1; i++) {
    const candidate = points[i]!;
    if (haversine(last[0], last[1], candidate[0], candidate[1]) >= minGap_m) {
      out.push(candidate);
      last = candidate;
    }
  }

  out.push(points[points.length - 1]!);
  return out;
}

/**
 * Whether two members are close enough to render as "Together".
 *
 * @param a First member's position.
 * @param b Second member's position.
 * @returns True within the together threshold (100 m). False when either
 *          position is unknown -- absence of data is not evidence of proximity.
 */
export function areTogether(
  a: { latitude: number; longitude: number } | null | undefined,
  b: { latitude: number; longitude: number } | null | undefined,
): boolean {
  if (!a || !b) return false;
  return haversine(a.latitude, a.longitude, b.latitude, b.longitude) <= GEO.togetherThreshold_m;
}

/**
 * Decides whether a geofence state should flip, using hysteresis.
 *
 * WHY TWO RADII
 *   With a single boundary, a member sitting near the edge of their geofence
 *   fires arrived/left/arrived/left forever as GPS wanders a few metres, and
 *   every flip notifies the whole pod. Entry uses the tighter radius (150 m) and
 *   exit the looser one (220 m), so leaving requires travelling meaningfully
 *   further than arriving did. The 70 m gap has to be crossed before the state
 *   can change back.
 *
 * @param distance_m Current distance from the place's centre, in metres.
 * @param wasInside  Whether the member was considered inside on the previous fix.
 * @returns True when the member should now be considered inside the fence.
 */
export function isInsideGeofence(distance_m: number, wasInside: boolean): boolean {
  return wasInside ? distance_m <= GEO.geofenceExit_m : distance_m <= GEO.geofenceEnter_m;
}

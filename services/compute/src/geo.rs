//! # Geo primitives
//!
//! ## Purpose
//! The distance and speed maths every location feature is built on. This is a
//! faithful port of the original `src/lib/geo.js`; the thresholds it compares
//! against are read from `packages/shared/data/rules/geo.json` via
//! `crate::rules::GEO` rather than re-typed as literals.
//!
//! ## Inputs
//! Bare coordinates in WGS84 degrees, speeds in metres per second, and lists of
//! saved places. Nothing here is stateful and nothing reads a clock.
//!
//! ## Outputs
//! Distances in **metres** (always metres inside this module -- only
//! `format_distance` ever produces kilometres, and only as display text),
//! human-readable labels, and place matches.
//!
//! ## Who calls this
//! - `crate::trips`, on every ping pair of the reconstruction pipeline. This is
//!   the hottest code in the service, which is why `haversine` takes plain
//!   `f64`s rather than a struct.
//! - `POST /geo/nearest-place` and `POST /geo/activity`, called by
//!   `services/api` when rendering a member's presence card.

use crate::models::{ActivityClassification, GeoPoint, PlaceInput};
use crate::rules::GEO;

/// Great-circle distance between two points, in **metres**.
///
/// # Parameters
/// - `lat1`, `lon1`: first point, WGS84 degrees.
/// - `lat2`, `lon2`: second point, WGS84 degrees.
///
/// # Returns
/// Metres along the surface of a sphere of radius
/// `geo.json -> earthRadiusM` (6 371 000 m, the mean Earth radius).
///
/// # Algorithm (haversine), step by step
/// 1. Convert the latitude and longitude *differences* to radians.
/// 2. `a` = the square of half the chord length between the points:
///    `sin²(Δlat/2) + cos(lat1)·cos(lat2)·sin²(Δlon/2)`.
/// 3. The central angle is `2·atan2(√a, √(1-a))`. Using `atan2` rather than
///    `asin(√a)` keeps the result numerically stable for antipodal points.
/// 4. Multiply the angle (radians) by the radius to get metres.
///
/// # Edge cases
/// - Identical points return exactly `0.0`.
/// - A spherical Earth is an approximation; error against WGS84 ellipsoidal
///   distance is well under 0.5%, which is far smaller than the GPS accuracy
///   this service filters on, so it is irrelevant here.
/// - `NaN` inputs propagate as `NaN`. The caller (`services/api`) validates
///   coordinates before storing pings, so this is not defended against.
pub fn haversine(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let radius_m = GEO.earth_radius_m;
    let d_lat = (lat2 - lat1).to_radians();
    let d_lon = (lon2 - lon1).to_radians();
    let a = (d_lat / 2.0).sin().powi(2)
        + lat1.to_radians().cos() * lat2.to_radians().cos() * (d_lon / 2.0).sin().powi(2);
    radius_m * 2.0 * a.sqrt().atan2((1.0 - a).sqrt())
}

/// Human-readable distance text.
///
/// # Parameters
/// - `metres`: `None` when the distance is unknown (e.g. the other member has
///   never pinged).
///
/// # Returns
/// - `"—"` (an em dash) when unknown.
/// - `"Together"` at or below `geo.json -> proximity.togetherThreshold_m`
///   (100 m). The `why`: "Roughly the width of a building, so being in the same
///   cafe reads as together despite GPS scatter."
/// - `"NNN m"` below 1 km, rounded to the metre.
/// - `"N.N km"` below 10 km, one decimal.
/// - `"NN km"` at 10 km and above, rounded to the kilometre -- one decimal of a
///   double-digit kilometre figure is noise, not information.
///
/// # Edge cases
/// Rounding uses Rust's round-half-away-from-zero, whereas JavaScript's
/// `Math.round` is round-half-up. They differ only for negative halves, and a
/// distance is never negative, so the two implementations agree.
pub fn format_distance(metres: Option<f64>) -> String {
    let m = match metres {
        Some(m) => m,
        None => return "—".to_string(),
    };
    if m <= GEO.proximity.together_threshold_m.value {
        return "Together".to_string();
    }
    if m < 1000.0 {
        return format!("{} m", m.round() as i64);
    }
    if m < 10_000.0 {
        return format!("{:.1} km", m / 1000.0);
    }
    format!("{} km", (m / 1000.0).round() as i64)
}

/// Metres per second to whole kilometres per hour.
///
/// # Parameters
/// - `metres_per_second`: as reported by the device.
///
/// # Returns
/// `round(m/s × 3.6)` as an integer. Whole km/h because the UI shows a badge,
/// not an instrument reading.
pub fn to_kmh(metres_per_second: f64) -> i64 {
    (metres_per_second * 3.6).round() as i64
}

/// Turns a speed reading into a human activity label.
///
/// # Parameters
/// - `speed_ms`: metres per second. A missing reading arrives as `0.0` (see
///   `PingInput`'s `#[serde(default)]`), which classifies as `Stationary`,
///   exactly like the original JavaScript's `speedMs || 0`.
///
/// # Returns
/// One of `Stationary`, `Walking`, `Cycling`, `Driving`, plus a `driving` flag
/// the map uses to decide whether to road-snap a line.
///
/// # Bands (all from `geo.json -> activityBands`)
/// - `< 0.6 m/s` -> Stationary. "Under about 2 km/h -- standing still, or GPS
///   noise."
/// - `< 1.6 m/s` -> Walking. "About 2 to 6 km/h -- walking pace."
/// - `< 3.0 m/s` -> Cycling. "About 6 to 11 km/h -- cycling or a brisk jog."
/// - `>= 3.0 m/s` -> Driving. "Above about 11 km/h is treated as driving."
///
/// # Edge cases
/// The bands are strictly increasing and checked in order, so a value exactly
/// on a boundary falls into the *higher* band (0.6 m/s is Walking, not
/// Stationary) -- identical to the original's `<` comparisons.
pub fn classify_activity(speed_ms: f64) -> ActivityClassification {
    let bands = &GEO.activity_bands;
    if speed_ms < bands.stationary_below_mps.value {
        return ActivityClassification { label: "Stationary", driving: false };
    }
    if speed_ms < bands.walking_below_mps.value {
        return ActivityClassification { label: "Walking", driving: false };
    }
    if speed_ms < bands.cycling_below_mps.value {
        return ActivityClassification { label: "Cycling", driving: false };
    }
    ActivityClassification { label: "Driving", driving: true }
}

/// Whether a speed reading counts as driving on its own.
///
/// # Parameters
/// - `speed_ms`: metres per second.
///
/// # Returns
/// `true` above `geo.json -> activityBands.drivingThreshold_mps` (3.0 m/s,
/// about 11 km/h). Strictly greater-than, matching the original `> 3`.
pub fn is_driving(speed_ms: f64) -> bool {
    speed_ms > GEO.activity_bands.driving_threshold_mps.value
}

/// Finds the saved place a member counts as being "at".
///
/// # Parameters
/// - `location`: where the member is now.
/// - `places`: candidate places **in the caller's order** -- see the note below.
/// - `radius_m`: metres. `POST /geo/nearest-place` defaults this to
///   `geo.json -> proximity.placeRadius_m` (150 m), which is also the geofence
///   entry radius, "so 'at a place' and 'inside the fence' can never disagree".
///
/// # Returns
/// `Some((place_id, distance_m))` for the match, or `None` when the member is
/// outside every place's radius.
///
/// # Important: this returns the FIRST match, not the closest
/// The original `nearestPlace()` returned the first place within the radius and
/// this port keeps that behaviour deliberately, because the caller relies on it:
/// places are passed in the app's own priority order (a timed/temporary place
/// before a permanent one), so "first within the radius" is a *preference*
/// order, not an accident. Picking the geometrically nearest place instead would
/// silently change which place a member appears to be at whenever two overlap.
/// The distance returned is the distance to that first match.
///
/// # Edge cases
/// - An empty `places` list returns `None`.
/// - A non-positive `radius_m` returns `None` for every place, since the
///   comparison is `<=` against a distance that is `>= 0`; only a member sitting
///   exactly on a place would match at radius 0. The handler rejects negative
///   radii outright.
pub fn nearest_place(
    location: &GeoPoint,
    places: &[PlaceInput],
    radius_m: f64,
) -> Option<(String, f64)> {
    for place in places {
        let distance_m = haversine(
            location.latitude,
            location.longitude,
            place.latitude,
            place.longitude,
        );
        if distance_m <= radius_m {
            return Some((place.id.clone(), distance_m));
        }
    }
    None
}

/// Reduces a polyline to distance-spaced waypoints.
///
/// # Parameters
/// - `points`: ordered `[latitude, longitude]` pairs.
/// - `min_gap_m`: minimum spacing in metres. Callers pass
///   `geo.json -> tripReconstruction.routerWaypointGap_m` (250 m).
///
/// # Returns
/// A new vector that always begins with the first point and ends with the last,
/// with interior points thinned so consecutive kept points are at least
/// `min_gap_m` apart along the path.
///
/// # Why 250 m
/// From the rule file: "Feeding every raw fix makes the router U-turn onto noisy
/// mid-block points and draw the same road twice; routing only origin to
/// destination collapses real revisits into a single pass. This spacing follows
/// the actual path while staying sparse enough to avoid both failures."
///
/// # Algorithm
/// Walk the interior points, keeping a running `last_kept`. A point is kept when
/// it is at least `min_gap_m` from `last_kept` (not from its predecessor), so a
/// dense cluster collapses to one waypoint instead of ratcheting forward.
///
/// # Edge cases
/// Inputs of 2 points or fewer are returned unchanged -- there is no interior to
/// thin, and both endpoints must survive.
pub fn downsample_by_distance(points: &[[f64; 2]], min_gap_m: f64) -> Vec<[f64; 2]> {
    if points.len() <= 2 {
        return points.to_vec();
    }
    let mut out: Vec<[f64; 2]> = Vec::with_capacity(points.len());
    out.push(points[0]);
    let mut last_kept = points[0];
    // `points.len() - 1` is safe: len > 2 here. The last point is appended
    // unconditionally after the loop, so the loop stops one short of it.
    for point in &points[1..points.len() - 1] {
        if haversine(last_kept[0], last_kept[1], point[0], point[1]) >= min_gap_m {
            out.push(*point);
            last_kept = *point;
        }
    }
    out.push(points[points.len() - 1]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One degree of longitude at the equator on a sphere of radius R is
    /// `R · π/180`. With R = 6 371 000 m that is 111 194.93 m, which is a
    /// closed-form check on the whole formula rather than on a memorised number.
    #[test]
    fn haversine_matches_the_closed_form_at_the_equator() {
        let expected = 6_371_000.0 * std::f64::consts::PI / 180.0;
        let d = haversine(0.0, 0.0, 0.0, 1.0);
        assert!(
            (d - expected).abs() < 0.001,
            "one degree of longitude at the equator: got {d}, expected {expected}"
        );
        // A degree of latitude is the same arc on a sphere.
        let d_lat = haversine(0.0, 0.0, 1.0, 0.0);
        assert!((d_lat - expected).abs() < 0.001, "one degree of latitude: got {d_lat}");
    }

    /// A known real-world pair: London (51.5007, -0.1246) to Paris
    /// (48.8567, 2.3508) is roughly 343 km great-circle.
    #[test]
    fn haversine_matches_a_known_city_pair() {
        let d = haversine(51.5007, -0.1246, 48.8567, 2.3508);
        assert!(
            d > 340_000.0 && d < 345_000.0,
            "London to Paris should be ~343 km, got {d} m"
        );
    }

    #[test]
    fn haversine_is_zero_for_identical_points_and_symmetric() {
        assert_eq!(haversine(1.3521, 103.8198, 1.3521, 103.8198), 0.0);
        let forward = haversine(1.3521, 103.8198, 35.6762, 139.6503);
        let backward = haversine(35.6762, 139.6503, 1.3521, 103.8198);
        assert!((forward - backward).abs() < 1e-6);
    }

    #[test]
    fn format_distance_covers_every_band() {
        assert_eq!(format_distance(None), "—");
        // At or below the 100 m together threshold.
        assert_eq!(format_distance(Some(0.0)), "Together");
        assert_eq!(format_distance(Some(100.0)), "Together");
        // Metres.
        assert_eq!(format_distance(Some(100.4)), "100 m");
        assert_eq!(format_distance(Some(999.6)), "1000 m");
        // Sub-10 km, one decimal.
        assert_eq!(format_distance(Some(1000.0)), "1.0 km");
        assert_eq!(format_distance(Some(5432.0)), "5.4 km");
        // Double-digit kilometres, whole numbers.
        assert_eq!(format_distance(Some(10_000.0)), "10 km");
        assert_eq!(format_distance(Some(15_400.0)), "15 km");
    }

    #[test]
    fn to_kmh_rounds_to_whole_units() {
        assert_eq!(to_kmh(0.0), 0);
        assert_eq!(to_kmh(1.0), 4); // 3.6 -> 4
        assert_eq!(to_kmh(10.0), 36);
        assert_eq!(to_kmh(27.777), 100);
    }

    #[test]
    fn activity_bands_match_the_rule_file() {
        assert_eq!(classify_activity(0.0).label, "Stationary");
        assert_eq!(classify_activity(0.59).label, "Stationary");
        // Boundaries fall into the higher band, as in the original.
        assert_eq!(classify_activity(0.6).label, "Walking");
        assert_eq!(classify_activity(1.59).label, "Walking");
        assert_eq!(classify_activity(1.6).label, "Cycling");
        assert_eq!(classify_activity(2.99).label, "Cycling");
        assert_eq!(classify_activity(3.0).label, "Driving");
        assert!(classify_activity(3.0).driving);
        assert!(!classify_activity(2.9).driving);
    }

    #[test]
    fn is_driving_is_strictly_above_the_threshold() {
        assert!(!is_driving(3.0));
        assert!(is_driving(3.01));
    }

    #[test]
    fn nearest_place_returns_the_first_match_inside_the_radius() {
        let here = GeoPoint { latitude: 1.3000, longitude: 103.8000 };
        // ~11 m away: comfortably inside 150 m.
        let close = PlaceInput { id: "home".into(), latitude: 1.3001, longitude: 103.8000 };
        // ~11 km away: outside.
        let far = PlaceInput { id: "office".into(), latitude: 1.4000, longitude: 103.8000 };

        let hit = nearest_place(&here, &[close.clone(), far.clone()], 150.0);
        let (id, distance) = hit.expect("the close place should match");
        assert_eq!(id, "home");
        assert!(distance < 150.0);

        assert!(nearest_place(&here, &[far.clone()], 150.0).is_none());
        assert!(nearest_place(&here, &[], 150.0).is_none());

        // Order is a preference order: when two places both contain the member,
        // the earlier one wins even if the later one is nearer.
        let nearer = PlaceInput { id: "nearer".into(), latitude: 1.30000, longitude: 103.80000 };
        let hit = nearest_place(&here, &[close, nearer], 150.0);
        assert_eq!(hit.expect("first match wins").0, "home");
    }

    #[test]
    fn downsample_keeps_endpoints_and_thins_the_middle() {
        // Five points about 11 m apart. With a 250 m gap every interior point is
        // dropped and only the endpoints survive.
        let dense: Vec<[f64; 2]> = (0..5).map(|i| [1.3 + (i as f64) * 0.0001, 103.8]).collect();
        let out = downsample_by_distance(&dense, 250.0);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0], dense[0]);
        assert_eq!(out[1], dense[4]);

        // With a tiny gap, every point survives.
        let out = downsample_by_distance(&dense, 1.0);
        assert_eq!(out.len(), 5);

        // Two points or fewer pass straight through.
        assert_eq!(downsample_by_distance(&dense[..2], 250.0).len(), 2);
        assert_eq!(downsample_by_distance(&[], 250.0).len(), 0);
    }
}

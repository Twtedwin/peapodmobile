//! # Trip reconstruction
//!
//! ## Purpose
//! Turns one member's raw GPS ping history into *the one journey worth drawing*
//! on the map. This is a faithful port of `src/lib/lastTrip.js`; every
//! threshold comes from `packages/shared/data/rules/geo.json ->
//! tripReconstruction`, and the reasoning quoted in the comments below is copied
//! from that file's `why` fields and from the original JavaScript's comments.
//!
//! ## Inputs
//! `&[PingInput]` -- latitude, longitude, `recorded_at_ms` (epoch
//! milliseconds), optional `speed` (m/s), `accuracy` (m) and `is_driving`.
//! Input need not be sorted. Timestamps are milliseconds precisely so that no
//! stage of this pipeline ever parses a date string: the original JavaScript
//! constructed a `Date` per ping per window, which was the heavy part of a
//! recurring UI freeze whenever this ran on a new ping.
//!
//! ## Output
//! `Option<ReconstructedTrip>` -- the LAST CONFIRMED trip, or `None`.
//! Distances in the response are kilometres for `distance_km` and metres for
//! everything else; times are epoch milliseconds.
//!
//! ## Who calls this
//! `services/api` on behalf of `POST /trips/reconstruct`, when the mobile app
//! renders a pod member's last journey. `services/api` also has a TypeScript
//! re-implementation of this exact pipeline as a fallback, so any behavioural
//! change here must be mirrored there.
//!
//! ## The pipeline, in order (order is load-bearing)
//! ```text
//!   sort by recorded_at_ms
//!     -> filter_teleports          impossible-speed pass, then V-spike pass
//!       -> split into runs         at gaps longer than tripGap_ms
//!         -> split_run_by_stops    at interior arrivals (two-pointer window)
//!           -> build_trip          path length, trim stationary tail, driving
//!                                  detection, net displacement, max distance
//!             -> clean_route_points  accuracy filter, then V-spike pass
//!               -> smooth_trip       9-point moving average, exact endpoints
//!                 -> keep the LAST run that clears both confirmation gates
//! ```
//! Teleports are removed *before* trip detection because otherwise a single bad
//! GPS fix invents a journey the member never made. Smoothing happens *last*,
//! and only on the drawn points, because it changes how the line looks and must
//! not change any detection metric.

use crate::geo::haversine;
use crate::models::{PingInput, ReconstructedTrip};
use crate::rules::GEO;

/// Upper bound on how many pings one request may carry.
///
/// `split_run_by_stops` scans a bounded time window per ping, so the pipeline is
/// effectively linear in practice, but the window is bounded by *time* and not
/// by count -- a pathological history (thousands of fixes inside five minutes)
/// would make that scan quadratic. The device only writes a ping after moving
/// 25 m or every 4 minutes (`geo.json -> tracking`), so a genuine history of a
/// few weeks is far below this ceiling; anything above it is a bug or an abuse
/// and is rejected with a `400` by the handler.
pub const MAX_PINGS: usize = 50_000;

/// Reconstructs the most recent confirmed journey.
///
/// # Parameters
/// - `pings`: one member's fixes, in any order. Not mutated.
///
/// # Returns
/// `Some(trip)` for the most recent run that is confirmed as a real journey, or
/// `None` when the member has not travelled far enough for any run to qualify.
///
/// # Confirmation gates (both must hold)
/// 1. `distance_km * 1000 >= minTripDistance_m` (80 m) -- "Minimum path length
///    before a run counts as a trip at all."
/// 2. `max(net_displacement_m, max_dist_from_start_m) >= minNetDisplacement_m`
///    (60 m) -- "Stationary jitter accumulates path length without ever leaving
///    the spot, so path length alone would draw false trips; requiring real
///    displacement filters those out while still counting a round walk that
///    returns home."
///
/// The *last* confirmed run wins, and an unconfirmed run never replaces it, so
/// a journey that has only just started does not flash a false line onto the map
/// while the real trip is still building up.
///
/// # Edge cases
/// - Empty input -> `None`.
/// - A single ping -> `None` (a run needs two points to be drawable).
/// - Ties in `recorded_at_ms` keep their relative input order, because the sort
///   is stable (matching `Array.prototype.sort`, which is also stable).
pub fn reconstruct_last_trip(pings: &[PingInput]) -> Option<ReconstructedTrip> {
    if pings.is_empty() {
        return None;
    }

    // Step 1: sort by time. The caller is allowed to hand us rows straight out
    // of a database in any order.
    let mut sorted: Vec<PingInput> = pings.to_vec();
    sorted.sort_by_key(|p| p.recorded_at_ms);

    // Step 2: drop GPS teleports BEFORE trip detection, so a bad fix cannot
    // register a journey the member never made or shoot the line off to a place
    // they never were.
    let sorted = filter_teleports(&sorted);
    if sorted.is_empty() {
        return None;
    }

    // Step 3: split by long time gaps -- a gap longer than tripGap_ms
    // (12 minutes) means tracking paused, which ends the run.
    let trip_gap_ms = GEO.trip_reconstruction.trip_gap_ms.value;
    let mut runs: Vec<Vec<PingInput>> = Vec::new();
    let mut run: Vec<PingInput> = vec![sorted[0]];
    for i in 1..sorted.len() {
        let gap_ms = sorted[i].recorded_at_ms - sorted[i - 1].recorded_at_ms;
        if gap_ms > trip_gap_ms {
            runs.push(std::mem::take(&mut run));
            run = vec![sorted[i]];
        } else {
            run.push(sorted[i]);
        }
    }
    runs.push(run);

    // Step 4: split each run at interior stops (destination arrivals), so each
    // real journey is its own sub-trip and a new trip is never drawn as a
    // continuation that retraces the old route.
    let mut sub_trips: Vec<Vec<PingInput>> = Vec::new();
    for r in &runs {
        sub_trips.extend(split_run_by_stops(r));
    }

    // Step 5: build each sub-trip and keep the last one that clears both gates.
    let min_trip_distance_m = GEO.trip_reconstruction.min_trip_distance_m.value;
    let min_net_displacement_m = GEO.trip_reconstruction.min_net_displacement_m.value;
    let mut last_confirmed: Option<ReconstructedTrip> = None;
    for sub in &sub_trips {
        let trip = match build_trip(sub) {
            Some(t) => t,
            None => continue,
        };
        let travelled_far_enough = trip.distance_km * 1000.0 >= min_trip_distance_m;
        let actually_left_the_spot =
            trip.net_displacement_m.max(trip.max_dist_from_start_m) >= min_net_displacement_m;
        if travelled_far_enough && actually_left_the_spot {
            last_confirmed = Some(trip);
        }
    }
    last_confirmed
}

/// Drops GPS "teleports" from a time-sorted ping series.
///
/// # Parameters
/// - `pings`: time-sorted fixes.
///
/// # Returns
/// A new vector with impossible fixes removed. The first and last fixes always
/// survive.
///
/// # Algorithm: two passes, in this order
/// **Pass 1 -- impossible jumps.** Walk forward comparing each fix against the
/// last *kept* fix (not its raw predecessor, so a run of bad fixes is all
/// measured from the last good one). Drop a fix when it would require
/// faster-than-any-vehicle travel:
/// `dt > 0 && distance/dt > maxPlausibleSpeed_mps && distance > teleportMinJump_m`.
/// - `maxPlausibleSpeed_mps` = 35 m/s: "About 126 km/h. A fix implying faster
///   ground travel than this is a bad GPS lock, not movement."
/// - `teleportMinJump_m` = 80 m: "A fix must be both implausibly fast AND this
///   far away before it is discarded, so tiny jitter at a standstill is left
///   alone."
/// - `dt > 0` guards against a division by zero when two fixes share a
///   timestamp; such a pair is kept.
///
/// **Pass 2 -- V-spikes.** A classic single-ping outlier: the location darted
/// away for one fix and snapped straight back. An interior fix is dropped when
/// it is more than `spikeNeighbourDist_m` (50 m) from *both* temporal
/// neighbours while those neighbours are closer to each other than
/// `spikeCollapseRatio` (0.5) times the smaller of those two distances.
///
/// # A deliberate asymmetry, preserved from the original
/// Pass 2 compares against `speed_filtered[i - 1]` -- the *input* predecessor --
/// whereas `clean_route_points` (the same V-spike test, applied later to the
/// drawn route) compares against the last *kept* point. The two functions
/// genuinely differ in the original JavaScript, and the difference is observable
/// on two adjacent spikes, so both behaviours are reproduced exactly rather than
/// unified into one helper.
///
/// # Edge cases
/// Fewer than 3 pings are returned unchanged: there is no interior fix to test.
pub fn filter_teleports(pings: &[PingInput]) -> Vec<PingInput> {
    if pings.len() < 3 {
        return pings.to_vec();
    }
    let rules = &GEO.trip_reconstruction;
    let max_speed_mps = rules.max_plausible_speed_mps.value;
    let min_jump_m = rules.teleport_min_jump_m.value;
    let spike_dist_m = rules.spike_neighbour_dist_m.value;
    let collapse_ratio = rules.spike_collapse_ratio.value;

    // ---- Pass 1: impossible jumps ----
    let mut speed_filtered: Vec<PingInput> = Vec::with_capacity(pings.len());
    speed_filtered.push(pings[0]);
    for cur in &pings[1..] {
        // `last()` is Some because we pushed pings[0] above and never pop.
        let prev = *speed_filtered
            .last()
            .expect("speed_filtered always holds at least the first ping");
        let dt_s = (cur.recorded_at_ms - prev.recorded_at_ms) as f64 / 1000.0;
        let d_m = haversine(prev.latitude, prev.longitude, cur.latitude, cur.longitude);
        if dt_s > 0.0 && d_m / dt_s > max_speed_mps && d_m > min_jump_m {
            continue;
        }
        speed_filtered.push(*cur);
    }
    if speed_filtered.len() < 3 {
        return speed_filtered;
    }

    // ---- Pass 2: V-spikes ----
    let mut out: Vec<PingInput> = Vec::with_capacity(speed_filtered.len());
    out.push(speed_filtered[0]);
    for i in 1..speed_filtered.len() - 1 {
        let prev = speed_filtered[i - 1];
        let cur = speed_filtered[i];
        let next = speed_filtered[i + 1];
        let d_prev = haversine(prev.latitude, prev.longitude, cur.latitude, cur.longitude);
        let d_next = haversine(cur.latitude, cur.longitude, next.latitude, next.longitude);
        let d_prev_next = haversine(prev.latitude, prev.longitude, next.latitude, next.longitude);
        if d_prev > spike_dist_m
            && d_next > spike_dist_m
            && d_prev_next < d_prev.min(d_next) * collapse_ratio
        {
            continue;
        }
        out.push(cur);
    }
    out.push(speed_filtered[speed_filtered.len() - 1]);
    out
}

/// Splits one time-continuous run into sub-trips at interior stops.
///
/// # Parameters
/// - `run`: pings with no gap longer than `tripGap_ms` between them.
///
/// # Returns
/// One or more sub-trips, in time order, together covering the run. A run with
/// no interior stop comes back as a single sub-trip.
///
/// # What counts as a stop
/// A ping after which the member stays within `stopRadius_m` (80 m) for at least
/// `stopDuration_ms` (5 minutes). From the rule file: 5 minutes is "long enough
/// to ignore red lights and pick-up stops, short enough to catch a real
/// arrival". The sub-trip before the stop ends *at* the arrival ping; the next
/// sub-trip begins when the member leaves the stop cluster. This is what stops a
/// new trip from being drawn as a continuation of the previous one.
///
/// # Algorithm, step by step
/// 1. Copy every timestamp into `times` once. (The original re-parsed a `Date`
///    per ping per iteration; that was the expensive part of the freeze this
///    rewrite fixed.)
/// 2. Two pointers, `i` (candidate stop) and `j` (window end). `j` only ever
///    advances, so the time scan over the whole run is linear.
/// 3. Advance `j` while `times[j] - times[i] < stopDuration_ms`, giving the
///    half-open window `[i, j)` of pings within the stop duration of `i`.
/// 4. `farthest` = the greatest distance from `run[i]` to any ping in that
///    window.
/// 5. `elapsed` is `stopDuration_ms` when the window was cut short by `j`
///    reaching the duration (i.e. `j` is still inside the run), otherwise the
///    real span of the tail of the run. So a stop can only be confirmed when a
///    full `stopDuration_ms` was actually observed -- a member sitting still at
///    the very end of the history is not yet an arrival.
/// 6. If `elapsed >= stopDuration_ms` and `farthest <= stopRadius_m`, ping `i`
///    is a confirmed stop: extend forward over every subsequent ping still
///    inside the stop radius (the member sitting at the destination), emit
///    `run[seg_start ..= i]` as the completed sub-trip, and restart after the
///    stationary cluster.
/// 7. Otherwise advance `i` by one and try again.
///
/// # Edge cases
/// - Runs shorter than 2 pings come back as a single sub-trip unchanged.
/// - `i` strictly increases in both branches (the stop branch jumps to `k`,
///   which is always at least `i + 1` because `run[i]` is trivially within its
///   own stop radius), so the loop always terminates.
pub fn split_run_by_stops(run: &[PingInput]) -> Vec<Vec<PingInput>> {
    if run.len() < 2 {
        return vec![run.to_vec()];
    }
    let stop_duration_ms = GEO.trip_reconstruction.stop_duration_ms.value;
    let stop_radius_m = GEO.trip_reconstruction.stop_radius_m.value;

    // Step 1: timestamps, once.
    let times: Vec<i64> = run.iter().map(|p| p.recorded_at_ms).collect();

    let mut sub_trips: Vec<Vec<PingInput>> = Vec::new();
    let mut seg_start: usize = 0;
    let mut i: usize = 0;
    let mut j: usize = 0;

    while i + 1 < run.len() {
        let t0 = times[i];
        // Step 2/3: the window end never moves backwards.
        if j < i {
            j = i;
        }
        while j < run.len() && times[j] - t0 < stop_duration_ms {
            j += 1;
        }

        // Step 4: how far the member strayed inside the window.
        let mut farthest_m = 0.0_f64;
        for k in i..j {
            let d = haversine(
                run[i].latitude,
                run[i].longitude,
                run[k].latitude,
                run[k].longitude,
            );
            if d > farthest_m {
                farthest_m = d;
            }
        }

        // Step 5: only a fully observed stop duration counts.
        let elapsed_ms = if j < run.len() {
            stop_duration_ms
        } else if j > i {
            times[j - 1] - t0
        } else {
            0
        };
        let is_stop = elapsed_ms >= stop_duration_ms && farthest_m <= stop_radius_m;

        if is_stop {
            // Step 6: extend over the whole stationary cluster.
            let mut k = i;
            while k < run.len()
                && haversine(
                    run[i].latitude,
                    run[i].longitude,
                    run[k].latitude,
                    run[k].longitude,
                ) <= stop_radius_m
            {
                k += 1;
            }
            if i >= seg_start {
                // Inclusive of the arrival ping, so the drawn line reaches the
                // destination instead of stopping short of it.
                sub_trips.push(run[seg_start..=i].to_vec());
            }
            seg_start = k;
            i = k;
        } else {
            // Step 7.
            i += 1;
        }
    }

    if seg_start < run.len() {
        sub_trips.push(run[seg_start..].to_vec());
    }
    sub_trips
}

/// Turns one sub-trip's pings into a drawable journey with its metrics.
///
/// # Parameters
/// - `pts`: one sub-trip's pings, time-ordered.
///
/// # Returns
/// `None` when the sub-trip is too short to draw (fewer than two points, before
/// or after trimming). Otherwise a [`ReconstructedTrip`] whose `points` are
/// cleaned and smoothed and whose metrics are computed from the RAW points.
///
/// # Algorithm, step by step
/// 1. **Path length** (`dist`): sum of haversine distances over *all* `pts`,
///    including the stationary tail. This is the original's behaviour and it is
///    kept deliberately -- see the note on `distance_km` below.
/// 2. **Trim the stationary tail.** The last ping is the destination. Walk
///    backwards to the last ping still further than `arrivalRadius_m` (80 m)
///    from it; everything after that is "arrived and sitting still". From the
///    rule file: later fixes "are a stationary tail and are trimmed off the
///    drawn route so it does not smear into a dot cluster". If every ping is
///    within the arrival radius (a run that never left), the route is the whole
///    series.
/// 3. **Driving detection.** Trust the tracker's `is_driving` on any point of
///    the route, and back it up with speed: a peak at or above
///    `drivingMaxSpeed_mps` (7 m/s -- "a peak above this in the run means
///    driving, not cycling") or an average at or above `drivingAvgSpeed_mps`
///    (6 m/s -- "a sustained average above this also means driving").
/// 4. **Average speed**: path length over the route's duration in seconds. Zero
///    when the duration is zero.
/// 5. **Net displacement**: straight-line metres from the route's first point to
///    its last. "GPS jitter wanders but stays near one spot, so its path length
///    can creep past the minimum while its net displacement stays ~0."
/// 6. **Max distance from start**: the farthest the member ever got from the
///    start. "A round walk that returns near its start has ~0 end-to-end net
///    displacement but DID travel out to a real turnaround point."
/// 7. **Clean, then smooth** the route's coordinates for drawing only.
///
/// # Note on `distance_km` and `avg_speed_ms`
/// `distance_km` is the path length over *all* pings while `avg_speed_ms`
/// divides that by the *trimmed* route's duration. That is exactly what the
/// original did, and the confirmation gate in `reconstruct_last_trip` is
/// calibrated against these numbers, so "fixing" it would silently change which
/// runs confirm as trips. Left as-is on purpose.
pub fn build_trip(pts: &[PingInput]) -> Option<ReconstructedTrip> {
    if pts.len() < 2 {
        return None;
    }
    let rules = &GEO.trip_reconstruction;
    let arrival_radius_m = rules.arrival_radius_m.value;
    let driving_max_speed_mps = rules.driving_max_speed_mps.value;
    let driving_avg_speed_mps = rules.driving_avg_speed_mps.value;

    // Step 1: total path length over every ping, metres.
    let mut dist_m = 0.0_f64;
    for i in 1..pts.len() {
        dist_m += haversine(
            pts[i - 1].latitude,
            pts[i - 1].longitude,
            pts[i].latitude,
            pts[i].longitude,
        );
    }

    // Step 2: trim the stationary tail at the destination.
    let final_ping = pts[pts.len() - 1];
    let mut arrival_idx: Option<usize> = None;
    // Walk backwards from the second-to-last ping.
    for i in (0..pts.len() - 1).rev() {
        let d = haversine(
            pts[i].latitude,
            pts[i].longitude,
            final_ping.latitude,
            final_ping.longitude,
        );
        if d > arrival_radius_m {
            arrival_idx = Some(i);
            break;
        }
    }
    // No ping was far from the destination -> the member never really left, so
    // keep the whole series (matching the original's `arrivalIdx < 0` branch).
    let route_end = arrival_idx.unwrap_or(pts.len() - 1);
    let route = &pts[..=route_end];
    if route.len() < 2 {
        return None;
    }

    // Step 3: was this a car trip? The map road-snaps a driving line but draws a
    // walk or bike ride as-is.
    let mut max_speed_ms = 0.0_f64;
    let mut any_driving = false;
    for p in route {
        if p.is_driving {
            any_driving = true;
        }
        if p.speed > max_speed_ms {
            max_speed_ms = p.speed;
        }
    }

    // Step 4: average speed over the trimmed route's duration.
    let duration_s = (pts[route_end].recorded_at_ms - route[0].recorded_at_ms) as f64 / 1000.0;
    let avg_speed_ms = if duration_s > 0.0 { dist_m / duration_s } else { 0.0 };
    let is_driving = any_driving
        || max_speed_ms >= driving_max_speed_mps
        || avg_speed_ms >= driving_avg_speed_mps;

    // Step 5: net straight-line displacement.
    let last_route_point = route[route.len() - 1];
    let net_displacement_m = haversine(
        route[0].latitude,
        route[0].longitude,
        last_route_point.latitude,
        last_route_point.longitude,
    );

    // Step 6: farthest point reached from the start.
    let mut max_dist_from_start_m = 0.0_f64;
    for p in route {
        let d = haversine(route[0].latitude, route[0].longitude, p.latitude, p.longitude);
        if d > max_dist_from_start_m {
            max_dist_from_start_m = d;
        }
    }

    // Step 7: cosmetic passes, applied only to the drawn coordinates.
    let cleaned = clean_route_points(route);
    let raw_points: Vec<[f64; 2]> = cleaned.iter().map(|p| [p.latitude, p.longitude]).collect();

    Some(ReconstructedTrip {
        points: smooth_trip(&raw_points),
        start_at_ms: route[0].recorded_at_ms,
        arrival_at_ms: pts[route_end].recorded_at_ms,
        distance_km: dist_m / 1000.0,
        net_displacement_m,
        max_dist_from_start_m,
        avg_speed_ms,
        is_driving,
    })
}

/// Removes GPS jitter from a route's points before smoothing.
///
/// # Parameters
/// - `pts`: the trimmed route's pings.
///
/// # Returns
/// A new vector with bad interior fixes removed; the first and last pings always
/// survive, so the "left X min ago" origin pin and the destination stay exactly
/// where the member actually was.
///
/// # Algorithm: two passes, in this order
/// **Pass 1 -- poor accuracy.** Drop interior fixes whose reported accuracy
/// radius is worse than `poorAccuracyCutoff_m` (50 m): "a bad GPS lock -- the
/// point can be tens of metres off the true spot."
///
/// **Pass 2 -- V-spikes.** Same shape as the second pass of
/// `filter_teleports`, but comparing against the last *kept* point rather than
/// the input predecessor (see the note in that function -- the asymmetry is in
/// the original and is preserved).
///
/// # Edge cases
/// Fewer than 3 points, before or after the accuracy pass, are returned as-is.
pub fn clean_route_points(pts: &[PingInput]) -> Vec<PingInput> {
    if pts.len() < 3 {
        return pts.to_vec();
    }
    let rules = &GEO.trip_reconstruction;
    let accuracy_cutoff_m = rules.poor_accuracy_cutoff_m.value;
    let spike_dist_m = rules.spike_neighbour_dist_m.value;
    let collapse_ratio = rules.spike_collapse_ratio.value;

    // ---- Pass 1: accuracy ----
    let mut acc_filtered: Vec<PingInput> = Vec::with_capacity(pts.len());
    acc_filtered.push(pts[0]);
    for p in &pts[1..pts.len() - 1] {
        if p.accuracy > accuracy_cutoff_m {
            continue;
        }
        acc_filtered.push(*p);
    }
    acc_filtered.push(pts[pts.len() - 1]);
    if acc_filtered.len() < 3 {
        return acc_filtered;
    }

    // ---- Pass 2: V-spikes, measured from the last kept point ----
    let mut out: Vec<PingInput> = Vec::with_capacity(acc_filtered.len());
    out.push(acc_filtered[0]);
    for i in 1..acc_filtered.len() - 1 {
        let prev = *out.last().expect("out always holds at least the first point");
        let cur = acc_filtered[i];
        let next = acc_filtered[i + 1];
        let d_prev = haversine(prev.latitude, prev.longitude, cur.latitude, cur.longitude);
        let d_next = haversine(cur.latitude, cur.longitude, next.latitude, next.longitude);
        let d_prev_next = haversine(prev.latitude, prev.longitude, next.latitude, next.longitude);
        if d_prev > spike_dist_m
            && d_next > spike_dist_m
            && d_prev_next < d_prev.min(d_next) * collapse_ratio
        {
            continue;
        }
        out.push(cur);
    }
    out.push(acc_filtered[acc_filtered.len() - 1]);
    out
}

/// Smooths a polyline with a moving average so the drawn line follows the actual
/// path instead of zig-zagging with GPS jitter.
///
/// # Parameters
/// - `pts`: ordered `[latitude, longitude]` pairs.
///
/// # Returns
/// A new vector of the same length. The endpoints are copied through exactly;
/// each interior point is replaced by the mean of the interior points within
/// `smoothingHalfWindow` (4) of it, clamped at the edges -- a 9-point window.
///
/// # Why this is safe
/// From the rule file: "Smoothing changes only how the line looks -- all
/// detection metrics are computed from the raw points beforehand." `build_trip`
/// calls this last, after every metric has been computed.
///
/// # Edge cases
/// - Fewer than 5 points are returned unchanged: a 9-point average of 4 points
///   is meaningless, and the original used the same guard.
/// - The window deliberately excludes the endpoints (`j` runs over
///   `1 ..= len-2`), so an exact-but-noisy first fix cannot drag its neighbours.
/// - `i.saturating_sub(half_window)` cannot underflow; `max(1, ...)` then keeps
///   the window off the endpoints.
pub fn smooth_trip(pts: &[[f64; 2]]) -> Vec<[f64; 2]> {
    if pts.len() < 5 {
        return pts.to_vec();
    }
    let half_window = GEO.trip_reconstruction.smoothing_half_window.value;

    let mut out: Vec<[f64; 2]> = Vec::with_capacity(pts.len());
    out.push(pts[0]);
    // len >= 5, so `pts.len() - 2 >= 3` and the interior range is non-empty.
    let last_interior = pts.len() - 2;
    for i in 1..=last_interior {
        let lo = std::cmp::max(1, i.saturating_sub(half_window));
        let hi = std::cmp::min(last_interior, i + half_window);
        let mut sum_lat = 0.0_f64;
        let mut sum_lng = 0.0_f64;
        let mut n = 0.0_f64;
        for j in lo..=hi {
            sum_lat += pts[j][0];
            sum_lng += pts[j][1];
            n += 1.0;
        }
        // n >= 1 because lo <= i <= hi.
        out.push([sum_lat / n, sum_lng / n]);
    }
    out.push(pts[pts.len() - 1]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Roughly 11.1 m per 0.0001 degree of latitude, which makes the fixtures
    /// below easy to reason about in metres.
    const BASE_LAT: f64 = 1.3000;
    const BASE_LNG: f64 = 103.8000;
    const T0: i64 = 1_700_000_000_000;

    /// Builds a ping `lat_steps * ~11.1 m` north of the base point at
    /// `T0 + seconds`.
    fn ping(lat_steps: f64, seconds: i64) -> PingInput {
        PingInput {
            latitude: BASE_LAT + lat_steps * 0.0001,
            longitude: BASE_LNG,
            recorded_at_ms: T0 + seconds * 1000,
            speed: 1.2,
            accuracy: 5.0,
            is_driving: false,
        }
    }

    #[test]
    fn no_pings_and_one_ping_produce_no_trip() {
        assert!(reconstruct_last_trip(&[]).is_none());
        assert!(reconstruct_last_trip(&[ping(0.0, 0)]).is_none());
    }

    #[test]
    fn stationary_jitter_is_not_a_trip() {
        // Twenty fixes wandering inside a few metres. The accumulated path
        // length can pass 80 m while the member never leaves the spot, which is
        // exactly what the net-displacement gate exists to reject.
        let mut pings = Vec::new();
        for i in 0..20 {
            let wobble = if i % 2 == 0 { 0.00002 } else { -0.00002 };
            pings.push(PingInput {
                latitude: BASE_LAT + wobble,
                longitude: BASE_LNG,
                recorded_at_ms: T0 + (i as i64) * 20_000,
                speed: 0.2,
                accuracy: 8.0,
                is_driving: false,
            });
        }
        assert!(
            reconstruct_last_trip(&pings).is_none(),
            "jitter must not draw a trip"
        );
    }

    #[test]
    fn a_straight_walk_is_confirmed_and_measured() {
        // 30 fixes, ~11 m apart, one per 20 s -> ~333 m over ~10 minutes.
        let pings: Vec<PingInput> = (0..30).map(|i| ping(i as f64, (i as i64) * 20)).collect();
        let trip = reconstruct_last_trip(&pings).expect("a 330 m walk is a trip");

        assert!(
            trip.distance_km > 0.30 && trip.distance_km < 0.36,
            "path length should be ~0.33 km, got {}",
            trip.distance_km
        );
        // The drawn route stops at the arrival radius: the last ~7 fixes are
        // inside 80 m of the destination, so they are trimmed off and the net
        // displacement is measured to the trim point (~232 m), not to the very
        // last fix. `distance_km` above still covers the whole path, which is
        // the original's behaviour.
        assert!(
            trip.net_displacement_m > 200.0 && trip.net_displacement_m < 250.0,
            "net displacement should be ~232 m after trimming, got {}",
            trip.net_displacement_m
        );
        // Straight line out: the farthest point IS the last drawn point.
        assert!((trip.max_dist_from_start_m - trip.net_displacement_m).abs() < 1.0);
        assert_eq!(trip.start_at_ms, T0);
        assert!(!trip.is_driving, "0.5 m/s average is not driving");
        assert!(trip.points.len() >= 2);
        // Endpoints survive smoothing exactly.
        assert_eq!(trip.points[0][0], pings[0].latitude);
    }

    #[test]
    fn a_round_walk_that_returns_home_is_still_a_trip() {
        // Out 200 m and back. Net displacement ends near zero, so only
        // max_dist_from_start can confirm this run -- which is precisely why the
        // gate is `max(net, maxDist) >= 60 m`.
        let mut pings = Vec::new();
        for i in 0..18 {
            pings.push(ping(i as f64, (i as i64) * 20));
        }
        for i in (0..18).rev() {
            pings.push(ping(i as f64, (36 - i as i64) * 20));
        }
        let trip = reconstruct_last_trip(&pings).expect("a round walk is a trip");
        // Ends within ~90 m of home (the drawn route is trimmed once the member
        // is inside the 80 m arrival radius of their final fix), so the net
        // displacement gate alone would have rejected this real journey.
        assert!(
            trip.net_displacement_m < 100.0,
            "comes back to near the start, got {} m",
            trip.net_displacement_m
        );
        assert!(
            trip.max_dist_from_start_m > 150.0,
            "but it really went somewhere: {} m",
            trip.max_dist_from_start_m
        );
    }

    #[test]
    fn a_teleport_cannot_invent_a_journey() {
        // A stationary member plus one bad fix ~1100 km away for a single ping.
        // Pass 1 of filter_teleports must discard it, leaving no trip at all.
        let mut pings: Vec<PingInput> = (0..10)
            .map(|i| PingInput {
                latitude: BASE_LAT,
                longitude: BASE_LNG,
                recorded_at_ms: T0 + (i as i64) * 30_000,
                speed: 0.1,
                accuracy: 6.0,
                is_driving: false,
            })
            .collect();
        pings.insert(
            5,
            PingInput {
                latitude: BASE_LAT + 10.0, // ~1111 km north in 30 s
                longitude: BASE_LNG,
                recorded_at_ms: T0 + 5 * 30_000 + 1,
                speed: 0.1,
                accuracy: 6.0,
                is_driving: false,
            },
        );
        assert!(
            reconstruct_last_trip(&pings).is_none(),
            "a bad lock must not become a 1100 km trip"
        );
    }

    #[test]
    fn a_v_spike_is_removed_but_a_real_turn_is_kept() {
        // Three points where the middle one darted ~330 m sideways and snapped
        // back: the neighbours are 11 m apart, far closer to each other than
        // half the distance to the suspect. It must be dropped.
        let spike = vec![
            ping(0.0, 0),
            PingInput { longitude: BASE_LNG + 0.003, ..ping(0.0, 20) },
            ping(1.0, 40),
        ];
        let out = filter_teleports(&spike);
        assert_eq!(out.len(), 3, "a 3-point series is returned unchanged");

        // With a fourth point the interior spike becomes testable.
        let spike = vec![
            ping(0.0, 0),
            PingInput { longitude: BASE_LNG + 0.003, ..ping(0.0, 20) },
            ping(1.0, 40),
            ping(2.0, 60),
        ];
        let out = filter_teleports(&spike);
        assert_eq!(out.len(), 3, "the darted fix is dropped");

        // A genuine walk has no spikes and survives intact.
        let walk: Vec<PingInput> = (0..6).map(|i| ping(i as f64, (i as i64) * 20)).collect();
        assert_eq!(filter_teleports(&walk).len(), 6);
    }

    #[test]
    fn a_five_minute_stop_splits_a_run_into_two_trips() {
        // Walk out 200 m, sit still for 10 minutes, then walk on 200 m. The stop
        // is an arrival, so the run must split, and only the SECOND leg is
        // returned as the last confirmed trip.
        let mut pings: Vec<PingInput> = Vec::new();
        for i in 0..18 {
            pings.push(ping(i as f64, (i as i64) * 20)); // 0..340 s
        }
        // Ten minutes parked at the same spot, one fix per minute. Each gap is
        // 60 s, well under the 12-minute tripGap, so this stays one run.
        for i in 0..10 {
            pings.push(ping(17.0, 360 + (i as i64) * 60)); // 360..900 s
        }
        for i in 1..18 {
            pings.push(ping(17.0 + i as f64, 960 + (i as i64) * 20));
        }

        let runs = split_run_by_stops(&pings);
        assert!(
            runs.len() >= 2,
            "the 10-minute stop must split the run, got {} sub-trip(s)",
            runs.len()
        );

        let trip = reconstruct_last_trip(&pings).expect("the second leg is a trip");
        // The second leg starts at 960 s, not at 0 s: a new trip is not drawn as
        // a continuation of the previous one.
        assert!(
            trip.start_at_ms >= T0 + 900_000,
            "the last trip must be the leg after the stop, started at {}",
            trip.start_at_ms
        );
    }

    #[test]
    fn a_long_gap_splits_runs_and_only_the_last_trip_is_returned() {
        // Two separate walks an hour apart (far beyond the 12-minute tripGap).
        let mut pings: Vec<PingInput> = (0..15).map(|i| ping(i as f64, (i as i64) * 20)).collect();
        for i in 0..15 {
            pings.push(PingInput {
                latitude: BASE_LAT + 0.05 + (i as f64) * 0.0001,
                longitude: BASE_LNG,
                recorded_at_ms: T0 + 3_600_000 + (i as i64) * 20_000,
                speed: 1.2,
                accuracy: 5.0,
                is_driving: false,
            });
        }
        let trip = reconstruct_last_trip(&pings).expect("the later walk is a trip");
        assert!(
            trip.start_at_ms >= T0 + 3_600_000,
            "the most recent run wins"
        );
    }

    #[test]
    fn input_order_does_not_matter() {
        let ordered: Vec<PingInput> = (0..20).map(|i| ping(i as f64, (i as i64) * 20)).collect();
        let mut shuffled = ordered.clone();
        shuffled.reverse();
        let a = reconstruct_last_trip(&ordered).expect("trip from ordered pings");
        let b = reconstruct_last_trip(&shuffled).expect("trip from reversed pings");
        assert_eq!(a.start_at_ms, b.start_at_ms);
        assert_eq!(a.arrival_at_ms, b.arrival_at_ms);
        assert!((a.distance_km - b.distance_km).abs() < 1e-9);
    }

    #[test]
    fn the_stationary_tail_is_trimmed_from_the_drawn_route() {
        // Walk 200 m, then twelve fixes parked at the destination but spaced
        // only 10 s apart, so they never accumulate the 5 minutes needed to be
        // treated as a stop. They must still be trimmed off the drawn line.
        let mut pings: Vec<PingInput> = (0..18).map(|i| ping(i as f64, (i as i64) * 20)).collect();
        for i in 0..12 {
            pings.push(ping(17.0, 360 + (i as i64) * 10));
        }
        let trip = reconstruct_last_trip(&pings).expect("the walk is a trip");
        // The arrival time is the moment the member reached the destination
        // area, not the timestamp of the last parked fix.
        assert!(
            trip.arrival_at_ms < T0 + 460_000,
            "arrival should be trimmed back, got {}",
            trip.arrival_at_ms
        );
    }

    #[test]
    fn driving_is_detected_from_the_tracker_flag_and_from_speed() {
        // 30 fixes ~111 m apart every 10 s -> ~11 m/s, comfortably driving.
        let fast: Vec<PingInput> = (0..30)
            .map(|i| PingInput {
                latitude: BASE_LAT + (i as f64) * 0.001,
                longitude: BASE_LNG,
                recorded_at_ms: T0 + (i as i64) * 10_000,
                speed: 11.0,
                accuracy: 5.0,
                is_driving: false,
            })
            .collect();
        let trip = reconstruct_last_trip(&fast).expect("a drive is a trip");
        assert!(trip.is_driving, "11 m/s peaks and average must read as driving");

        // A slow walk where the tracker itself says "driving" is trusted.
        let flagged: Vec<PingInput> = (0..20)
            .map(|i| PingInput { is_driving: true, ..ping(i as f64, (i as i64) * 20) })
            .collect();
        let trip = reconstruct_last_trip(&flagged).expect("still a trip");
        assert!(trip.is_driving, "the tracker's own flag is trusted");
    }

    #[test]
    fn poor_accuracy_interior_fixes_are_dropped_but_endpoints_survive() {
        let pts = vec![
            PingInput { accuracy: 90.0, ..ping(0.0, 0) },  // first: always kept
            PingInput { accuracy: 90.0, ..ping(1.0, 20) }, // interior: dropped
            PingInput { accuracy: 10.0, ..ping(2.0, 40) }, // interior: kept
            PingInput { accuracy: 90.0, ..ping(3.0, 60) }, // last: always kept
        ];
        let out = clean_route_points(&pts);
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].recorded_at_ms, pts[0].recorded_at_ms);
        assert_eq!(out[2].recorded_at_ms, pts[3].recorded_at_ms);
    }

    #[test]
    fn smoothing_preserves_length_and_endpoints() {
        let raw: Vec<[f64; 2]> = (0..9)
            .map(|i| {
                let wobble = if i % 2 == 0 { 0.0001 } else { -0.0001 };
                [BASE_LAT + (i as f64) * 0.001 + wobble, BASE_LNG]
            })
            .collect();
        let out = smooth_trip(&raw);
        assert_eq!(out.len(), raw.len(), "smoothing never changes point count");
        assert_eq!(out[0], raw[0], "first point is exact");
        assert_eq!(out[out.len() - 1], raw[raw.len() - 1], "last point is exact");

        // Fewer than 5 points pass straight through.
        assert_eq!(smooth_trip(&raw[..4]), raw[..4].to_vec());
    }
}

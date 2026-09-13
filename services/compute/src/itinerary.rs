//! # Itinerary generation
//!
//! ## Purpose
//! Builds a connected, day-by-day trip from the travel catalog: inbound
//! flight, city clusters, locked intercity trains/flights, hotels, meals,
//! activities ranked by the pod's travel personalities, and the return leg.
//! Costs are integer minor units and the breakdown is defined as the sum of
//! every activity's `cost_minor`, so the two can never drift.
//!
//! ## Inputs
//! An [`ItineraryRequest`]: destination countries, optional regions, trip
//! length in days (1..=30), traveller count, personalities, pace, budget
//! tier, optional start date, must-see / avoid lists, currency, and an
//! optional deterministic seed.
//!
//! The catalog is `packages/shared/data/catalog/travel-dataset.json`, loaded
//! at runtime from `TRAVEL_DATASET_PATH` or the well-known repo-relative
//! path. It is **not** embedded with `include_str!` so a catalog edit does
//! not require a rebuild (docker-compose mounts it). If the file is missing
//! or unusable, a plausible synthetic itinerary is produced instead -- this
//! endpoint never returns `500` for a content problem.
//!
//! ## Outputs
//! [`ItineraryResponse`]: ordered days, a cost breakdown whose amounts sum
//! to `total_minor`, the cities visited, and a one-line personalisation note
//! that names the pod's personalities.
//!
//! ## Who calls this
//! `POST /itinerary/generate` via `src/main.rs`. `packages/shared/src/algorithms/itinerary.ts`
//! is the TypeScript twin used as the API fallback.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::Deserialize;

use crate::error::AppError;
use crate::models::{
    ActivityKind, BudgetTier, CostCategory, CostLine, ItineraryActivity, ItineraryDay,
    ItineraryRequest, ItineraryResponse, Pace,
};

// ---------------------------------------------------------------------------
// Catalog shape (mirrors travel-dataset.json; unknown keys such as `_comment`
// are ignored by serde on purpose -- do not add deny_unknown_fields.)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
struct TravelDataset {
    #[serde(default)]
    countries: Vec<CatalogCountry>,
}

#[derive(Debug, Clone, Deserialize)]
struct CatalogCountry {
    id: String,
    name: String,
    #[serde(default)]
    emoji: String,
    #[allow(dead_code)]
    #[serde(default)]
    currency: String,
    #[serde(default)]
    flight_cost_minor_by_tier: CostByTier,
    #[serde(default)]
    cities: Vec<CatalogCity>,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct CostByTier {
    #[serde(default)]
    budget: i64,
    #[serde(default)]
    mid: i64,
    #[serde(default)]
    luxury: i64,
}

impl CostByTier {
    /// Picks the column matching the pod's budget tier, in minor units.
    fn get(&self, tier: BudgetTier) -> i64 {
        match tier {
            BudgetTier::Budget => self.budget,
            BudgetTier::Mid => self.mid,
            BudgetTier::Luxury => self.luxury,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
struct CatalogCity {
    id: String,
    name: String,
    #[serde(default)]
    region: String,
    #[serde(default)]
    activities: Vec<CatalogActivity>,
    #[serde(default)]
    hotels: Vec<CatalogHotel>,
    #[serde(default)]
    transport_to: Vec<CatalogTransport>,
}

#[derive(Debug, Clone, Deserialize)]
struct CatalogActivity {
    id: String,
    title: String,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    emoji: String,
    #[serde(default)]
    duration_minutes: i64,
    #[serde(default)]
    cost_minor_by_tier: CostByTier,
    #[serde(default)]
    tags: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct CatalogHotel {
    id: String,
    name: String,
    #[serde(default)]
    tier: String,
    #[serde(default)]
    night_cost_minor: i64,
    #[serde(default)]
    emoji: String,
}

#[derive(Debug, Clone, Deserialize)]
struct CatalogTransport {
    city_id: String,
    #[serde(default)]
    mode: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    duration_minutes: i64,
    #[serde(default)]
    cost_minor_by_tier: CostByTier,
    #[serde(default)]
    emoji: String,
}

/// A city the planner will actually spend days in, possibly synthetic.
#[derive(Debug, Clone)]
struct Stop {
    city_id: String,
    city_name: String,
    country_name: String,
    /// Return fare from Singapore, per person, already picked for the tier.
    /// `0` means "this is home / a local trip" -- no locked flights.
    flight_cost_minor: i64,
    activities: Vec<CatalogActivity>,
    hotels: Vec<CatalogHotel>,
    transport_to: Vec<CatalogTransport>,
}

// ---------------------------------------------------------------------------
// Deterministic RNG and request hashing
// ---------------------------------------------------------------------------

/// xorshift64* -- tiny, no extra crate, reproducible across platforms.
///
/// `state` is never 0: xorshift's all-zero state is a fixed point, so we
/// force the low bit on at construction. Period is 2^64 - 1.
struct Rng {
    state: u64,
}

impl Rng {
    fn new(seed: u64) -> Self {
        Self { state: seed | 1 }
    }

    fn next_u64(&mut self) -> u64 {
        let mut x = self.state;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.state = x;
        x
    }

    /// Uniform in `0..n`. Returns 0 when `n == 0` so an empty pool cannot panic.
    fn gen_index(&mut self, n: usize) -> usize {
        if n == 0 {
            0
        } else {
            (self.next_u64() as usize) % n
        }
    }
}

/// FNV-1a 64-bit offset basis. Chosen so a missing `seed` still yields a
/// stable itinerary for the same request across processes and languages
/// (`std::hash::DefaultHasher` is *not* stable across Rust versions).
const FNV_OFFSET: u64 = 0xcbf29ce484222325;
/// FNV-1a 64-bit prime.
const FNV_PRIME: u64 = 0x100000001b3;

fn fnv1a_byte(hash: u64, byte: u8) -> u64 {
    (hash ^ byte as u64).wrapping_mul(FNV_PRIME)
}

fn fnv1a_str(mut hash: u64, s: &str) -> u64 {
    for b in s.as_bytes() {
        hash = fnv1a_byte(hash, *b);
    }
    // A 0x1f separator so "ab"+"c" and "a"+"bc" do not collide.
    fnv1a_byte(hash, 0x1f)
}

/// Derives a seed from the request fields that actually change the plan.
///
/// Field order is load-bearing and mirrored in the TypeScript twin: countries,
/// regions, days, travellers, personalities, pace, budget, start_date,
/// must_see, avoid, currency. `seed` itself is excluded (it *is* the seed
/// when present).
fn hash_request(req: &ItineraryRequest) -> u64 {
    let mut h = FNV_OFFSET;
    for c in &req.countries {
        h = fnv1a_str(h, c);
    }
    h = fnv1a_byte(h, 0x00);
    for r in &req.regions {
        h = fnv1a_str(h, r);
    }
    h = fnv1a_byte(h, 0x00);
    h = fnv1a_str(h, &req.days.to_string());
    h = fnv1a_str(h, &req.travellers.to_string());
    for p in &req.personalities {
        h = fnv1a_str(h, p);
    }
    h = fnv1a_byte(h, 0x00);
    h = fnv1a_str(h, match req.pace {
        Pace::Relaxed => "relaxed",
        Pace::Balanced => "balanced",
        Pace::Packed => "packed",
    });
    h = fnv1a_str(h, match req.budget_tier {
        BudgetTier::Budget => "budget",
        BudgetTier::Mid => "mid",
        BudgetTier::Luxury => "luxury",
    });
    h = fnv1a_str(h, req.start_date.as_deref().unwrap_or(""));
    for m in &req.must_see {
        h = fnv1a_str(h, m);
    }
    h = fnv1a_byte(h, 0x00);
    for a in &req.avoid {
        h = fnv1a_str(h, a);
    }
    h = fnv1a_byte(h, 0x00);
    fnv1a_str(h, &req.currency)
}

// ---------------------------------------------------------------------------
// Dataset loading
// ---------------------------------------------------------------------------

static DATASET: OnceLock<Option<TravelDataset>> = OnceLock::new();

/// Candidate locations for the travel catalog, first hit wins.
///
/// 1. `TRAVEL_DATASET_PATH` -- what docker-compose sets (`/app/data/travel-dataset.json`).
/// 2. Next to the crate, via `CARGO_MANIFEST_DIR` -- what `cargo test` sees.
/// 3. Repo-relative from the process cwd, both from the repo root and from
///    `services/compute`.
fn dataset_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(p) = std::env::var("TRAVEL_DATASET_PATH") {
        if !p.is_empty() {
            out.push(PathBuf::from(p));
        }
    }
    // CARGO_MANIFEST_DIR is services/compute at compile time. In the runtime
    // image that directory does not exist, so this candidate simply fails open.
    out.push(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/shared/data/catalog/travel-dataset.json"),
    );
    out.push(PathBuf::from("packages/shared/data/catalog/travel-dataset.json"));
    out.push(PathBuf::from("../../packages/shared/data/catalog/travel-dataset.json"));
    out
}

fn load_dataset() -> Option<&'static TravelDataset> {
    DATASET
        .get_or_init(|| {
            for path in dataset_candidates() {
                let text = match std::fs::read_to_string(&path) {
                    Ok(t) => t,
                    Err(_) => continue,
                };
                match serde_json::from_str::<TravelDataset>(&text) {
                    Ok(ds) if !ds.countries.is_empty() => {
                        tracing::info!(path = %path.display(), countries = ds.countries.len(), "loaded travel dataset");
                        return Some(ds);
                    }
                    Ok(_) => {
                        tracing::warn!(path = %path.display(), "travel dataset parsed but has no countries");
                    }
                    Err(err) => {
                        tracing::warn!(path = %path.display(), error = %err, "travel dataset unusable");
                    }
                }
            }
            tracing::warn!("no usable travel dataset; itineraries will be synthetic");
            None
        })
        .as_ref()
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/// Builds a connected itinerary for the request.
///
/// # Parameters
/// - `req.days`: trip length. Must be `1..=30` or this returns
///   [`AppError::BadRequest`]. That is the only way this function fails -- a
///   missing catalog, unknown country, or empty activity pool all degrade to
///   a synthetic plan rather than a `500`.
///
/// # Returns
/// A plan whose `cost_breakdown` amounts sum to `total_minor`, which is also
/// the sum of every activity's `cost_minor`. Flights and trains have
/// `locked = true`. The same request (or the same `seed`) always produces
/// the same plan.
///
/// # Errors
/// `AppError::bad_request` when `days` is outside `1..=30`.
pub fn generate_itinerary(req: &ItineraryRequest) -> Result<ItineraryResponse, AppError> {
    if !(1..=30).contains(&req.days) {
        return Err(AppError::bad_request("days must be between 1 and 30"));
    }

    let seed = match req.seed {
        Some(s) => s as u64,
        None => hash_request(req),
    };
    let mut rng = Rng::new(seed);

    let travellers = req.travellers.max(1);
    // One double room per two travellers, rounding up. A 2-person pod is 1
    // room; a 3-person pod is 2 rooms. Floored at 1 so a malformed 0 still
    // prices a room.
    let rooms = (travellers + 1) / 2;

    let stops = select_stops(req, &mut rng);
    let day_counts = allocate_days(stops.len(), req.days as usize);

    let mut id_seq: u32 = 0;
    let mut used: HashSet<String> = HashSet::new();
    let mut days: Vec<ItineraryDay> = Vec::new();
    let mut day_number: i64 = 1;

    for (stop_idx, stop) in stops.iter().enumerate() {
        let n = *day_counts.get(stop_idx).unwrap_or(&1);
        let is_first_stop = stop_idx == 0;
        let is_last_stop = stop_idx + 1 == stops.len();
        let hotel = pick_hotel(stop, req.budget_tier);
        // Last stop checks out on the final morning, so it has one fewer night.
        // A 1-day trip therefore has 0 hotel nights, which is a day-trip.
        let nights = if is_last_stop { n.saturating_sub(1) } else { n };
        let hotel_cost = match &hotel {
            Some(h) => h.night_cost_minor.saturating_mul(nights as i64).saturating_mul(rooms),
            None => 0,
        };
        let mut hotel_cost_remaining = hotel_cost;

        for d in 0..n {
            let is_arrival = is_first_stop && d == 0;
            // A 1-day trip is both arrival and departure so we emit inbound
            // *and* outbound on the same calendar day.
            let is_departure = is_last_stop && d + 1 == n;
            let is_transit = !is_first_stop && d == 0;
            let prev_stop = if is_transit { Some(&stops[stop_idx - 1]) } else { None };

            let date = req
                .start_date
                .as_deref()
                .and_then(|s| offset_date(s, day_number - 1));

            let activities = build_day(
                stop,
                prev_stop,
                BuildDayOpts {
                    day_number,
                    is_arrival,
                    is_departure,
                    is_transit,
                    is_one_day: req.days == 1,
                    pace: req.pace,
                    budget_tier: req.budget_tier,
                    travellers,
                    personalities: &req.personalities,
                    must_see: &req.must_see,
                    avoid: &req.avoid,
                    hotel: hotel,
                    hotel_cost: if d == 0 { hotel_cost_remaining } else { 0 },
                    flight_cost: if is_arrival {
                        stop.flight_cost_minor.saturating_mul(travellers)
                    } else {
                        0
                    },
                },
                &mut rng,
                &mut used,
                &mut id_seq,
            );
            if d == 0 {
                hotel_cost_remaining = 0;
            }

            let summary = day_summary(is_arrival, is_departure, is_transit, &stop.city_name);
            days.push(ItineraryDay {
                day: day_number,
                date,
                city: stop.city_name.clone(),
                summary,
                activities,
            });
            day_number += 1;
        }
    }

    let (cost_breakdown, total_minor) = cost_breakdown(&days, &req.currency);
    let cities = unique_cities(&days);
    let personalization_note = personalization_note(req, &cities);

    Ok(ItineraryResponse { days, cost_breakdown, total_minor, cities, personalization_note })
}

// ---------------------------------------------------------------------------
// Stop selection
// ---------------------------------------------------------------------------

fn norm(s: &str) -> String {
    s.trim().to_ascii_lowercase().replace(' ', "-")
}

fn country_aliases(needle: &str) -> Vec<String> {
    let n = norm(needle);
    let mut out = vec![n.clone()];
    match n.as_str() {
        "uk" | "gb" | "britain" | "england" | "great-britain" => out.push("united-kingdom".into()),
        "united-states" | "united-states-of-america" | "america" | "us" => out.push("usa".into()),
        "korea" | "south-korea" | "republic-of-korea" => out.push("south-korea".into()),
        "viet-nam" => out.push("vietnam".into()),
        _ => {}
    }
    out
}

fn country_matches(country: &CatalogCountry, needle: &str) -> bool {
    let aliases = country_aliases(needle);
    aliases.iter().any(|a| {
        a == &norm(&country.id) || a == &norm(&country.name) || country.name.eq_ignore_ascii_case(needle)
    })
}

fn city_matches_region(city: &CatalogCity, region: &str) -> bool {
    let r = norm(region);
    norm(&city.id) == r
        || norm(&city.name) == r
        || norm(&city.region) == r
        || city.name.eq_ignore_ascii_case(region)
}

/// How many distinct cities a trip of this length can comfortably visit.
///
/// 1..=3 days stay put (a long weekend is not a multi-city tour). 4..=6 can
/// take a second city. 7..=10 a third. Longer trips cap at 4 so the plan
/// does not become a highlight reel of airports.
fn city_budget(days: i64) -> usize {
    match days {
        1..=3 => 1,
        4..=6 => 2,
        7..=10 => 3,
        _ => 4,
    }
}

fn select_stops(req: &ItineraryRequest, rng: &mut Rng) -> Vec<Stop> {
    let dataset = load_dataset();
    let max_cities = city_budget(req.days);
    let mut stops: Vec<Stop> = Vec::new();

    let country_needles: Vec<String> = if req.countries.is_empty() {
        vec!["Destination".into()]
    } else {
        req.countries.clone()
    };

    for needle in &country_needles {
        let catalog_country = dataset.and_then(|ds| ds.countries.iter().find(|c| country_matches(c, needle)));
        match catalog_country {
            Some(country) => {
                let mut cities: Vec<&CatalogCity> = country.cities.iter().collect();
                if !req.regions.is_empty() {
                    let filtered: Vec<&CatalogCity> = cities
                        .iter()
                        .copied()
                        .filter(|c| req.regions.iter().any(|r| city_matches_region(c, r)))
                        .collect();
                    if !filtered.is_empty() {
                        cities = filtered;
                    }
                    // Empty filter: keep every city rather than producing a
                    // plan for the wrong country. Unknown regions are ignored.
                }
                if cities.is_empty() {
                    stops.push(synthetic_stop(needle, country.name.as_str(), country.emoji.as_str()));
                    continue;
                }
                // Prefer catalog order (hub first -- Tokyo, London, ...) so a
                // seed-less request is stable; the RNG only shuffles *which*
                // extra cities join on a long trip, not the hub.
                let take = (max_cities.saturating_sub(stops.len())).max(1).min(cities.len());
                for city in cities.into_iter().take(take) {
                    stops.push(Stop {
                        city_id: city.id.clone(),
                        city_name: city.name.clone(),
                        country_name: country.name.clone(),
                        flight_cost_minor: country.flight_cost_minor_by_tier.get(req.budget_tier),
                        activities: city.activities.clone(),
                        hotels: city.hotels.clone(),
                        transport_to: city.transport_to.clone(),
                    });
                }
            }
            None => {
                let emoji = dataset
                    .and_then(|ds| ds.countries.first().map(|c| c.emoji.as_str()))
                    .unwrap_or("📍");
                stops.push(synthetic_stop(needle, needle, emoji));
            }
        }
        if stops.len() >= max_cities {
            break;
        }
    }

    if stops.is_empty() {
        stops.push(synthetic_stop("Destination", "Destination", "📍"));
    }
    if stops.len() > max_cities {
        stops.truncate(max_cities);
    }
    // City order is catalog order (hub first) so a Tokyo trip always starts in
    // Tokyo. The RNG is reserved for activity picks, not city permutation.
    let _ = rng;
    stops
}

/// Invents a one-city stop when the catalog has no match.
///
/// Used for unknown countries *and* for a missing dataset, so the caller
/// always gets a usable plan. Costs are plausible SGD-cent stand-ins and are
/// documented next to each literal.
fn synthetic_stop(needle: &str, country_name: &str, _emoji: &str) -> Stop {
    let name = title_case(needle);
    let local = norm(needle) == "singapore";
    Stop {
        city_id: norm(needle),
        city_name: name.clone(),
        country_name: title_case(country_name),
        // 0 for Singapore (home). Otherwise a mid-tier return fare of S$650.00
        // (65000 cents) -- a plausible short-haul Asia return, not a guess at FX.
        flight_cost_minor: if local { 0 } else { 65_000 },
        activities: synthetic_activities(&name),
        hotels: vec![
            CatalogHotel {
                id: format!("{}-hotel-budget", norm(needle)),
                name: format!("{name} Inn"),
                tier: "budget".into(),
                night_cost_minor: 9_000, // S$90 / night
                emoji: "🏨".into(),
            },
            CatalogHotel {
                id: format!("{}-hotel-mid", norm(needle)),
                name: format!("{name} City Hotel"),
                tier: "mid".into(),
                night_cost_minor: 18_000, // S$180 / night
                emoji: "🏨".into(),
            },
            CatalogHotel {
                id: format!("{}-hotel-luxury", norm(needle)),
                name: format!("{name} Grand"),
                tier: "luxury".into(),
                night_cost_minor: 45_000, // S$450 / night
                emoji: "🏨".into(),
            },
        ],
        transport_to: Vec::new(),
    }
}

fn synthetic_activities(city: &str) -> Vec<CatalogActivity> {
    // Durations in minutes. Costs in minor units per person (SGD-cent stand-ins).
    struct Spec {
        id: &'static str,
        title: String,
        kind: &'static str,
        emoji: &'static str,
        mins: i64,
        cost: i64,
        tags: &'static [&'static str],
    }
    let specs = [
        Spec {
            id: "explore",
            title: format!("Explore {city}"),
            kind: "activity",
            emoji: "📍",
            mins: 120,
            cost: 0,
            tags: &["local", "photo", "culture"],
        },
        Spec {
            id: "market",
            title: "Local market".into(),
            kind: "meal",
            emoji: "🍜",
            mins: 75,
            cost: 2_500,
            tags: &["food", "local"],
        },
        Spec {
            id: "walk",
            title: "Neighbourhood walking tour".into(),
            kind: "activity",
            emoji: "🚶",
            mins: 90,
            cost: 0,
            tags: &["local", "relaxed"],
        },
        Spec {
            id: "viewpoint",
            title: "Scenic viewpoint".into(),
            kind: "activity",
            emoji: "📷",
            mins: 60,
            cost: 0,
            tags: &["photo", "romantic"],
        },
        Spec {
            id: "museum",
            title: "City museum".into(),
            kind: "activity",
            emoji: "🏛️",
            mins: 90,
            cost: 1_500,
            tags: &["culture", "history"],
        },
        Spec {
            id: "park",
            title: "City park".into(),
            kind: "activity",
            emoji: "🌳",
            mins: 75,
            cost: 0,
            tags: &["nature", "relaxed"],
        },
        Spec {
            id: "dinner",
            title: format!("Dinner in {city}"),
            kind: "meal",
            emoji: "🍽️",
            mins: 90,
            cost: 4_500,
            tags: &["food"],
        },
        Spec {
            id: "cafe",
            title: "Neighbourhood cafe".into(),
            kind: "meal",
            emoji: "☕",
            mins: 45,
            cost: 1_200,
            tags: &["food", "relaxed"],
        },
    ];
    specs
        .into_iter()
        .map(|spec| CatalogActivity {
            id: format!("{city}-{}", spec.id).to_ascii_lowercase().replace(' ', "-"),
            title: spec.title,
            kind: spec.kind.into(),
            emoji: spec.emoji.into(),
            duration_minutes: spec.mins,
            cost_minor_by_tier: CostByTier {
                budget: spec.cost / 2,
                mid: spec.cost,
                luxury: spec.cost * 2,
            },
            tags: spec.tags.iter().map(|t| (*t).to_string()).collect(),
        })
        .collect()
}

fn title_case(s: &str) -> String {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return "Destination".into();
    }
    trimmed
        .split(|c: char| c == '-' || c == '_' || c.is_whitespace())
        .filter(|p| !p.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + &chars.as_str().to_ascii_lowercase(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Spreads `total` days across `n` cities, at least 1 each, with a modest
/// extra weight on the first (hub) city -- matching the original engine's 1.4
/// vs 1.0 weights, rounded.
fn allocate_days(n: usize, total: usize) -> Vec<usize> {
    if n == 0 {
        return vec![total.max(1)];
    }
    if n == 1 {
        return vec![total.max(1)];
    }
    let n = n.min(total.max(1));
    let weights: Vec<f64> = (0..n).map(|i| if i == 0 { 1.4 } else { 1.0 }).collect();
    let sum: f64 = weights.iter().sum();
    let mut days: Vec<usize> = weights
        .iter()
        .map(|w| ((w / sum) * total as f64).round().max(1.0) as usize)
        .collect();
    let mut diff = total as i64 - days.iter().sum::<usize>() as i64;
    let mut i = 0usize;
    while diff > 0 {
        days[i % n] += 1;
        diff -= 1;
        i += 1;
    }
    while diff < 0 {
        let mut idx = None;
        let mut max = 1usize;
        for (j, d) in days.iter().enumerate() {
            if *d > max {
                max = *d;
                idx = Some(j);
            }
        }
        match idx {
            Some(j) => {
                days[j] -= 1;
                diff += 1;
            }
            None => break,
        }
    }
    days
}

fn pick_hotel<'a>(stop: &'a Stop, tier: BudgetTier) -> Option<&'a CatalogHotel> {
    let wanted = match tier {
        BudgetTier::Budget => "budget",
        BudgetTier::Mid => "mid",
        BudgetTier::Luxury => "luxury",
    };
    stop.hotels
        .iter()
        .find(|h| h.tier.eq_ignore_ascii_case(wanted))
        .or_else(|| stop.hotels.first())
}

// ---------------------------------------------------------------------------
// Per-day builder
// ---------------------------------------------------------------------------

struct BuildDayOpts<'a> {
    day_number: i64,
    is_arrival: bool,
    is_departure: bool,
    is_transit: bool,
    is_one_day: bool,
    pace: Pace,
    budget_tier: BudgetTier,
    travellers: i64,
    personalities: &'a [String],
    must_see: &'a [String],
    avoid: &'a [String],
    hotel: Option<&'a CatalogHotel>,
    hotel_cost: i64,
    flight_cost: i64,
}

/// Minutes of padding inserted between two consecutive entries so they cannot
/// overlap even when the previous duration is 0. 15 minutes is a short walk
/// or a metro hop, not a scheduled layover.
const GAP_MINUTES: i64 = 15;

struct Clock {
    /// Minutes from local midnight. Kept in `0..24*60` so `HH:MM` never wraps
    /// into the next calendar day -- leftover activities are dropped instead
    /// of colliding with tomorrow's flight.
    minutes: i64,
}

impl Clock {
    fn at(hour: i64, minute: i64) -> Self {
        Self { minutes: hour * 60 + minute }
    }

    fn hhmm(&self) -> String {
        let h = (self.minutes / 60).clamp(0, 23);
        let m = self.minutes % 60;
        format!("{h:02}:{m:02}")
    }

    /// True when there is still room for `duration_minutes` plus the 15-minute
    /// gap before 22:00 (last dinner seating we will schedule).
    fn fits(&self, duration_minutes: i64) -> bool {
        self.minutes + duration_minutes + GAP_MINUTES <= 22 * 60
    }

    fn bump(&mut self, duration_minutes: i64) {
        self.minutes += duration_minutes.max(0) + GAP_MINUTES;
    }
}

fn next_id(seq: &mut u32, day: i64) -> String {
    *seq += 1;
    format!("d{day}-a{seq:02}")
}

fn kind_from_catalog(raw: &str) -> ActivityKind {
    match raw.to_ascii_lowercase().as_str() {
        "flight" => ActivityKind::Flight,
        "transfer" => ActivityKind::Transfer,
        "hotel" => ActivityKind::Hotel,
        "meal" => ActivityKind::Meal,
        "train" => ActivityKind::Train,
        "free" => ActivityKind::Free,
        _ => ActivityKind::Activity,
    }
}

fn locked_kind(kind: ActivityKind) -> bool {
    matches!(kind, ActivityKind::Flight | ActivityKind::Train)
}

fn build_day(
    stop: &Stop,
    prev_stop: Option<&Stop>,
    opts: BuildDayOpts<'_>,
    rng: &mut Rng,
    used: &mut HashSet<String>,
    id_seq: &mut u32,
) -> Vec<ItineraryActivity> {
    let mut out = Vec::new();
    let mut clock = if opts.is_arrival && stop.flight_cost_minor > 0 {
        Clock::at(8, 0) // outbound from Singapore, typical morning long-haul
    } else if opts.is_transit {
        Clock::at(8, 30)
    } else {
        Clock::at(8, 0)
    };

    let push = |out: &mut Vec<ItineraryActivity>,
                clock: &mut Clock,
                id_seq: &mut u32,
                title: String,
                kind: ActivityKind,
                duration_minutes: i64,
                location: Option<String>,
                notes: Option<String>,
                cost_minor: i64,
                emoji: String| {
        let duration_minutes = duration_minutes.max(15); // never a 0-minute slot; 15 min is a coffee
        let act = ItineraryActivity {
            id: next_id(id_seq, opts.day_number),
            title,
            kind,
            start_time: clock.hhmm(),
            duration_minutes,
            location,
            notes,
            cost_minor,
            locked: locked_kind(kind),
            emoji,
        };
        clock.bump(duration_minutes);
        out.push(act);
    };

    // ---- Arrival: locked inbound flight + airport transfer + check-in ----
    if opts.is_arrival && stop.flight_cost_minor > 0 {
        // 420 min = 7 hours, a typical SIN → NRT / LHR block. Regional hops
        // are shorter but a single default keeps the day shape stable.
        push(
            &mut out,
            &mut clock,
            id_seq,
            format!("Flight · Singapore → {}", stop.city_name),
            ActivityKind::Flight,
            420,
            Some(stop.city_name.clone()),
            Some("Return fare, priced for the whole pod.".into()),
            opts.flight_cost,
            "✈️".into(),
        );
        push(
            &mut out,
            &mut clock,
            id_seq,
            "Airport transfer to hotel".into(),
            ActivityKind::Transfer,
            45, // 45 min is a typical airport-express ride
            Some(stop.city_name.clone()),
            None,
            2_500 * opts.travellers, // S$25 per person stand-in when the catalog has no express
            "🚆".into(),
        );
    } else if opts.is_arrival && stop.flight_cost_minor == 0 {
        push(
            &mut out,
            &mut clock,
            id_seq,
            "Start from home".into(),
            ActivityKind::Free,
            30,
            Some(stop.city_name.clone()),
            Some("A local trip -- no flight to catch.".into()),
            0,
            "🏠".into(),
        );
    }

    // ---- Intercity transit (locked when the catalog says train/flight) ----
    if opts.is_transit {
        if let Some(prev) = prev_stop {
            let leg = prev
                .transport_to
                .iter()
                .find(|t| t.city_id == stop.city_id)
                .or_else(|| prev.transport_to.first());
            match leg {
                Some(t) => {
                    let kind = match t.mode.to_ascii_lowercase().as_str() {
                        "flight" => ActivityKind::Flight,
                        "train" => ActivityKind::Train,
                        _ => ActivityKind::Transfer,
                    };
                    let duration = if t.duration_minutes > 0 { t.duration_minutes } else { 120 };
                    push(
                        &mut out,
                        &mut clock,
                        id_seq,
                        if t.title.is_empty() {
                            format!("{} → {}", prev.city_name, stop.city_name)
                        } else {
                            t.title.clone()
                        },
                        kind,
                        duration,
                        Some(stop.city_name.clone()),
                        None,
                        t.cost_minor_by_tier.get(opts.budget_tier).saturating_mul(opts.travellers),
                        if t.emoji.is_empty() { "🚆".into() } else { t.emoji.clone() },
                    );
                }
                None => {
                    push(
                        &mut out,
                        &mut clock,
                        id_seq,
                        format!("Train · {} → {}", prev.city_name, stop.city_name),
                        ActivityKind::Train,
                        120, // 2 h default when the catalog has no leg
                        Some(stop.city_name.clone()),
                        None,
                        6_000 * opts.travellers, // S$60 per person stand-in
                        "🚆".into(),
                    );
                }
            }
        }
    }

    if let Some(hotel) = opts.hotel {
        if opts.hotel_cost > 0 && !opts.is_departure {
            push(
                &mut out,
                &mut clock,
                id_seq,
                format!("Check in — {}", hotel.name),
                ActivityKind::Hotel,
                30,
                Some(stop.city_name.clone()),
                Some("Hotel nights for this city, priced for the whole pod.".into()),
                opts.hotel_cost,
                if hotel.emoji.is_empty() { "🏨".into() } else { hotel.emoji.clone() },
            );
        } else if !opts.is_arrival && !opts.is_departure {
            push(
                &mut out,
                &mut clock,
                id_seq,
                format!("Breakfast at {}", hotel.name),
                ActivityKind::Meal,
                45,
                Some(stop.city_name.clone()),
                Some("Included with the room.".into()),
                0,
                "🍳".into(),
            );
        }
    }

    // Travel days (arrival / transit / departure) get one fewer sightseeing
    // slot because a flight or a train plus a hotel change eats a slot.
    let mut slots = opts.pace.activity_slots();
    if opts.is_arrival || opts.is_departure || opts.is_transit {
        slots = slots.saturating_sub(1).max(1);
    }
    if opts.is_one_day {
        slots = 1;
    }

    let mut picked = 0usize;
    while picked < slots && clock.fits(60) {
        match pick_activity(stop, opts.personalities, opts.must_see, opts.avoid, used, rng, false) {
            Some(act) => {
                let duration = if act.duration_minutes > 0 { act.duration_minutes } else { 75 };
                if !clock.fits(duration) {
                    break;
                }
                let kind = kind_from_catalog(&act.kind);
                // Sightseeing slots skip meals -- meals are scheduled below so
                // lunch/dinner cannot steal a morning slot.
                if kind == ActivityKind::Meal {
                    used.remove(&act.id);
                    // Fall through to a non-meal pick: mark this id used so we
                    // don't loop forever, then try again excluding meals.
                    if let Some(act2) =
                        pick_activity(stop, opts.personalities, opts.must_see, opts.avoid, used, rng, true)
                    {
                        let duration = if act2.duration_minutes > 0 { act2.duration_minutes } else { 75 };
                        if !clock.fits(duration) {
                            break;
                        }
                        let kind = kind_from_catalog(&act2.kind);
                        push(
                            &mut out,
                            &mut clock,
                            id_seq,
                            act2.title.clone(),
                            kind,
                            duration,
                            Some(stop.city_name.clone()),
                            None,
                            act2.cost_minor_by_tier.get(opts.budget_tier).saturating_mul(opts.travellers),
                            if act2.emoji.is_empty() { "📍".into() } else { act2.emoji.clone() },
                        );
                        picked += 1;
                    } else {
                        break;
                    }
                    continue;
                }
                push(
                    &mut out,
                    &mut clock,
                    id_seq,
                    act.title.clone(),
                    kind,
                    duration,
                    Some(stop.city_name.clone()),
                    None,
                    act.cost_minor_by_tier.get(opts.budget_tier).saturating_mul(opts.travellers),
                    if act.emoji.is_empty() { "📍".into() } else { act.emoji.clone() },
                );
                picked += 1;
            }
            None => {
                push(
                    &mut out,
                    &mut clock,
                    id_seq,
                    format!("Free time in {}", stop.city_name),
                    ActivityKind::Free,
                    90,
                    Some(stop.city_name.clone()),
                    Some("The catalog ran dry -- a breathing gap rather than a repeated attraction.".into()),
                    0,
                    "🛋️".into(),
                );
                picked += 1;
            }
        }
    }

    // Lunch around 12:30 if we have not passed it. Dinner around 19:00.
    insert_meal(
        &mut out,
        stop,
        opts.budget_tier,
        opts.travellers,
        opts.personalities,
        opts.avoid,
        used,
        id_seq,
        opts.day_number,
        true,
    );
    if !opts.is_departure {
        insert_meal(
            &mut out,
            stop,
            opts.budget_tier,
            opts.travellers,
            opts.personalities,
            opts.avoid,
            used,
            id_seq,
            opts.day_number,
            false,
        );
    }

    // ---- Departure: locked outbound. Cost is 0 because the return fare was
    // already charged on the inbound (the catalog stores a round-trip). ----
    if opts.is_departure && stop.flight_cost_minor > 0 {
        let preferred = if opts.is_one_day { "18:00" } else { "17:00" };
        out.push(ItineraryActivity {
            id: next_id(id_seq, opts.day_number),
            title: format!("Flight · {} → Singapore", stop.city_name),
            kind: ActivityKind::Flight,
            start_time: unique_start_time(&out, preferred),
            duration_minutes: 420,
            location: Some(stop.city_name.clone()),
            notes: Some("Return leg; fare already counted on the inbound.".into()),
            cost_minor: 0,
            locked: true,
            emoji: "✈️".into(),
        });
    } else if opts.is_departure && stop.flight_cost_minor == 0 {
        out.push(ItineraryActivity {
            id: next_id(id_seq, opts.day_number),
            title: "Head home".into(),
            kind: ActivityKind::Free,
            start_time: unique_start_time(&out, "17:00"),
            duration_minutes: 30,
            location: Some(stop.city_name.clone()),
            notes: Some("Wrap up a local day.".into()),
            cost_minor: 0,
            locked: false,
            emoji: "🏠".into(),
        });
    }

    out.sort_by(|a, b| a.start_time.cmp(&b.start_time).then(a.id.cmp(&b.id)));
    out
}

/// Inserts a lunch (preferred 12:30) or dinner (preferred 19:00) if the day
/// does not already have a meal in that window. Prefers catalog meals whose
/// tags include `food`. The start time is nudged by 15-minute steps when the
/// preferred slot is already taken, so two entries never share `HH:MM`.
fn insert_meal(
    out: &mut Vec<ItineraryActivity>,
    stop: &Stop,
    tier: BudgetTier,
    travellers: i64,
    personalities: &[String],
    avoid: &[String],
    used: &mut HashSet<String>,
    id_seq: &mut u32,
    day: i64,
    lunch: bool,
) {
    let preferred = if lunch { "12:30" } else { "19:00" };
    let occupied = out.iter().any(|a| {
        a.kind == ActivityKind::Meal && times_close(&a.start_time, preferred, 90)
    });
    if occupied {
        return;
    }
    // Don't drop a meal on top of a locked flight.
    if out.iter().any(|a| a.locked && times_close(&a.start_time, preferred, 60)) {
        return;
    }

    let meal = stop
        .activities
        .iter()
        .filter(|a| {
            a.kind.eq_ignore_ascii_case("meal") && !used.contains(&a.id) && !is_avoided(a, avoid)
        })
        .max_by_key(|a| activity_score(a, personalities, &[]));

    let (title, cost, emoji, duration, notes) = match meal {
        Some(m) => {
            used.insert(m.id.clone());
            (
                m.title.clone(),
                m.cost_minor_by_tier.get(tier).saturating_mul(travellers),
                if m.emoji.is_empty() { "🍽️".into() } else { m.emoji.clone() },
                if m.duration_minutes > 0 { m.duration_minutes } else { 75 },
                None,
            )
        }
        None => (
            if lunch { format!("Lunch in {}", stop.city_name) } else { format!("Dinner in {}", stop.city_name) },
            (if lunch { 3_000 } else { 6_000 }) * travellers, // S$30 lunch / S$60 dinner per person
            if lunch { "🍽️".into() } else { "🍷".into() },
            75,
            Some("A nearby spot the planner picked.".into()),
        ),
    };

    out.push(ItineraryActivity {
        id: next_id(id_seq, day),
        title,
        kind: ActivityKind::Meal,
        start_time: unique_start_time(out, preferred),
        duration_minutes: duration,
        location: Some(stop.city_name.clone()),
        notes,
        cost_minor: cost,
        locked: false,
        emoji,
    });
}

/// Picks `preferred` unless another entry already starts then, in which case
/// it walks forward in 15-minute steps until 22:00.
fn unique_start_time(out: &[ItineraryActivity], preferred: &str) -> String {
    let mut mins = parse_hhmm(preferred).unwrap_or(12 * 60 + 30);
    for _ in 0..32 {
        // 32 * 15 min = 8 h of searching; enough to clear a packed afternoon.
        let candidate = format_hhmm(mins);
        if !out.iter().any(|a| a.start_time == candidate) {
            return candidate;
        }
        mins += GAP_MINUTES;
        if mins >= 22 * 60 {
            break;
        }
    }
    format_hhmm(mins.min(22 * 60 - 1))
}

fn parse_hhmm(hhmm: &str) -> Option<i64> {
    let (h, m) = hhmm.split_once(':')?;
    Some(h.parse::<i64>().ok()? * 60 + m.parse::<i64>().ok()?)
}

fn format_hhmm(minutes: i64) -> String {
    let h = (minutes / 60).clamp(0, 23);
    let m = minutes.rem_euclid(60);
    format!("{h:02}:{m:02}")
}

fn times_close(a: &str, b: &str, window_minutes: i64) -> bool {
    match (parse_hhmm(a), parse_hhmm(b)) {
        (Some(x), Some(y)) => (x - y).abs() < window_minutes,
        _ => false,
    }
}

fn is_avoided(act: &CatalogActivity, avoid: &[String]) -> bool {
    avoid.iter().any(|needle| {
        let n = needle.to_ascii_lowercase();
        act.title.to_ascii_lowercase().contains(&n)
            || act.tags.iter().any(|t| t.eq_ignore_ascii_case(needle))
    })
}

/// Higher is better. Tag overlap with personalities is +2 each; a must-see
/// substring match on the title is +8 so an explicit request outranks style.
fn activity_score(act: &CatalogActivity, personalities: &[String], must_see: &[String]) -> i64 {
    let mut s = 0_i64;
    for tag in &act.tags {
        if personalities.iter().any(|p| p.eq_ignore_ascii_case(tag)) {
            s += 2;
        }
    }
    for m in must_see {
        let needle = m.to_ascii_lowercase();
        if act.title.to_ascii_lowercase().contains(&needle)
            || act.tags.iter().any(|t| t.eq_ignore_ascii_case(m))
        {
            s += 8;
        }
    }
    s
}

fn pick_activity(
    stop: &Stop,
    personalities: &[String],
    must_see: &[String],
    avoid: &[String],
    used: &mut HashSet<String>,
    rng: &mut Rng,
    skip_meals: bool,
) -> Option<CatalogActivity> {
    let mut pool: Vec<&CatalogActivity> = stop
        .activities
        .iter()
        .filter(|a| {
            !used.contains(&a.id)
                && !is_avoided(a, avoid)
                && !(skip_meals && a.kind.eq_ignore_ascii_case("meal"))
        })
        .collect();
    if pool.is_empty() {
        // Recycle the pool rather than stall the day -- a 30-day trip will
        // exhaust even Tokyo. Re-using an attraction is better than a blank.
        pool = stop
            .activities
            .iter()
            .filter(|a| !(skip_meals && a.kind.eq_ignore_ascii_case("meal")) && !is_avoided(a, avoid))
            .collect();
    }
    if pool.is_empty() {
        return None;
    }
    pool.sort_by(|a, b| {
        let sa = activity_score(a, personalities, must_see);
        let sb = activity_score(b, personalities, must_see);
        sb.cmp(&sa).then(a.id.cmp(&b.id))
    });
    // Among the top 3, pick by rng so two trips with different seeds diverge
    // without ignoring the ranking.
    let take = pool.len().min(3);
    let choice = pool[rng.gen_index(take)];
    used.insert(choice.id.clone());
    Some(choice.clone())
}

fn day_summary(arrival: bool, departure: bool, transit: bool, city: &str) -> String {
    if arrival && departure {
        format!("In and out of {city} in a single day")
    } else if arrival {
        format!("Arrive in {city}")
    } else if departure {
        format!("Depart {city}")
    } else if transit {
        format!("Travel to {city}")
    } else {
        format!("A full day in {city}")
    }
}

fn category_of(kind: ActivityKind) -> CostCategory {
    match kind {
        ActivityKind::Flight => CostCategory::Flights,
        ActivityKind::Hotel => CostCategory::Accommodation,
        ActivityKind::Activity => CostCategory::Activities,
        ActivityKind::Meal => CostCategory::Food,
        ActivityKind::Train | ActivityKind::Transfer => CostCategory::Transport,
        ActivityKind::Free => CostCategory::Other,
    }
}

fn label_of(cat: CostCategory) -> &'static str {
    match cat {
        CostCategory::Flights => "Flights",
        CostCategory::Accommodation => "Accommodation",
        CostCategory::Activities => "Activities",
        CostCategory::Food => "Food",
        CostCategory::Transport => "Transport",
        CostCategory::Other => "Other",
    }
}

/// One line per non-empty category, in the enum's declaration order
/// (flights, accommodation, activities, food, transport, other). Amounts
/// are the summed `cost_minor` of matching activities, so
/// `sum(breakdown) == sum(activities) == total_minor` by construction.
fn cost_breakdown(days: &[ItineraryDay], currency: &str) -> (Vec<CostLine>, i64) {
    let mut buckets: BTreeMap<CostCategory, i64> = BTreeMap::new();
    for day in days {
        for act in &day.activities {
            *buckets.entry(category_of(act.kind)).or_insert(0) += act.cost_minor;
        }
    }
    let order = [
        CostCategory::Flights,
        CostCategory::Accommodation,
        CostCategory::Activities,
        CostCategory::Food,
        CostCategory::Transport,
        CostCategory::Other,
    ];
    let lines: Vec<CostLine> = order
        .into_iter()
        .filter_map(|cat| {
            let amount = *buckets.get(&cat).unwrap_or(&0);
            if amount == 0 {
                return None;
            }
            Some(CostLine {
                label: label_of(cat).to_string(),
                amount_minor: amount,
                currency: currency.to_string(),
                category: cat,
            })
        })
        .collect();
    let total_minor: i64 = lines.iter().map(|l| l.amount_minor).sum();
    (lines, total_minor)
}

fn unique_cities(days: &[ItineraryDay]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for day in days {
        if seen.insert(day.city.clone()) {
            out.push(day.city.clone());
        }
    }
    out
}

fn personalization_note(req: &ItineraryRequest, cities: &[String]) -> String {
    let route = if cities.is_empty() {
        "the destination".to_string()
    } else {
        cities.join(" → ")
    };
    let days = req.days;
    let day_word = if days == 1 { "day" } else { "days" };
    if req.personalities.is_empty() {
        format!("A {} {day_word} plan across {route}.", pace_label(req.pace))
    } else {
        let styles = req
            .personalities
            .iter()
            .map(|p| p.trim())
            .filter(|p| !p.is_empty())
            .map(title_case)
            .collect::<Vec<_>>()
            .join(", ");
        format!("Tuned to your {styles} style across {route} over {days} {day_word}.")
    }
}

fn pace_label(pace: Pace) -> &'static str {
    match pace {
        Pace::Relaxed => "relaxed",
        Pace::Balanced => "balanced",
        Pace::Packed => "packed",
    }
}

/// Adds `days` (0-based) to a `YYYY-MM-DD` calendar date.
///
/// Returns `None` when the string is not a real Gregorian date, in which case
/// the itinerary day simply carries `date: null` rather than 400-ing -- a
/// malformed start date should not block a plan. Units: whole calendar days.
fn offset_date(start: &str, days: i64) -> Option<String> {
    let mut parts = start.split('-');
    let y: i32 = parts.next()?.parse().ok()?;
    let m: u32 = parts.next()?.parse().ok()?;
    let d: u32 = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    if !(1..=12).contains(&m) || d == 0 {
        return None;
    }
    let mut year = y;
    let mut month = m;
    let mut day = d as i64 + days;
    loop {
        let dim = days_in_month(year, month) as i64;
        if day >= 1 && day <= dim {
            return Some(format!("{year:04}-{month:02}-{day:02}"));
        }
        if day > dim {
            day -= dim;
            month += 1;
            if month > 12 {
                month = 1;
                year += 1;
            }
        } else {
            month = if month == 1 {
                year -= 1;
                12
            } else {
                month - 1
            };
            day += days_in_month(year, month) as i64;
        }
        // 30-day trips cannot walk this far; the cap is a runaway-input guard.
        if year < 1 || year > 9999 {
            return None;
        }
    }
}

fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if is_leap(year) {
                29
            } else {
                28
            }
        }
        _ => 30,
    }
}

fn is_leap(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(days: i64, countries: &[&str]) -> ItineraryRequest {
        ItineraryRequest {
            countries: countries.iter().map(|s| (*s).to_string()).collect(),
            regions: Vec::new(),
            days,
            travellers: 2,
            personalities: vec!["food".into(), "culture".into()],
            pace: Pace::Balanced,
            budget_tier: BudgetTier::Mid,
            start_date: Some("2026-04-01".into()),
            must_see: Vec::new(),
            avoid: Vec::new(),
            currency: "SGD".into(),
            seed: Some(42),
        }
    }

    #[test]
    fn days_outside_one_to_thirty_are_rejected() {
        assert!(generate_itinerary(&req(0, &["japan"])).is_err());
        assert!(generate_itinerary(&req(31, &["japan"])).is_err());
        assert!(generate_itinerary(&req(-1, &["japan"])).is_err());
        assert!(generate_itinerary(&req(1, &["japan"])).is_ok());
        assert!(generate_itinerary(&req(30, &["japan"])).is_ok());
    }

    #[test]
    fn cost_breakdown_sums_to_total_and_to_activity_costs() {
        let plan = generate_itinerary(&req(5, &["japan"])).expect("5 days in japan");
        let from_lines: i64 = plan.cost_breakdown.iter().map(|l| l.amount_minor).sum();
        let from_acts: i64 = plan
            .days
            .iter()
            .flat_map(|d| d.activities.iter())
            .map(|a| a.cost_minor)
            .sum();
        assert_eq!(from_lines, plan.total_minor);
        assert_eq!(from_acts, plan.total_minor);
        assert_eq!(plan.days.len(), 5);
        assert!(!plan.cities.is_empty());
        assert!(plan.personalization_note.to_ascii_lowercase().contains("food"));
        assert!(plan.personalization_note.to_ascii_lowercase().contains("culture"));
    }

    #[test]
    fn flights_and_trains_are_locked() {
        let plan = generate_itinerary(&req(7, &["japan"])).expect("7 days");
        let locked: Vec<&ItineraryActivity> = plan
            .days
            .iter()
            .flat_map(|d| d.activities.iter())
            .filter(|a| a.kind == ActivityKind::Flight || a.kind == ActivityKind::Train)
            .collect();
        assert!(!locked.is_empty(), "a 7-day Japan trip should include a flight or a train");
        assert!(locked.iter().all(|a| a.locked));
        // Non-transport entries must not be locked.
        for day in &plan.days {
            for a in &day.activities {
                if a.kind != ActivityKind::Flight && a.kind != ActivityKind::Train {
                    assert!(!a.locked, "{} should not be locked", a.title);
                }
            }
        }
    }

    #[test]
    fn the_same_seed_is_byte_stable() {
        let a = generate_itinerary(&req(4, &["japan"])).unwrap();
        let b = generate_itinerary(&req(4, &["japan"])).unwrap();
        assert_eq!(a.total_minor, b.total_minor);
        assert_eq!(a.cities, b.cities);
        assert_eq!(a.days.len(), b.days.len());
        for (da, db) in a.days.iter().zip(b.days.iter()) {
            assert_eq!(da.city, db.city);
            assert_eq!(da.activities.len(), db.activities.len());
            for (aa, ab) in da.activities.iter().zip(db.activities.iter()) {
                assert_eq!(aa.title, ab.title);
                assert_eq!(aa.start_time, ab.start_time);
                assert_eq!(aa.cost_minor, ab.cost_minor);
            }
        }
    }

    #[test]
    fn unknown_countries_still_produce_a_plan() {
        let plan = generate_itinerary(&req(3, &["atlantis"])).expect("synthetic");
        assert_eq!(plan.days.len(), 3);
        assert_eq!(plan.days[0].city, "Atlantis");
        let from_lines: i64 = plan.cost_breakdown.iter().map(|l| l.amount_minor).sum();
        assert_eq!(from_lines, plan.total_minor);
    }

    #[test]
    fn a_one_day_trip_has_arrival_and_departure() {
        let plan = generate_itinerary(&req(1, &["japan"])).expect("day trip");
        assert_eq!(plan.days.len(), 1);
        let kinds: Vec<ActivityKind> = plan.days[0].activities.iter().map(|a| a.kind).collect();
        assert!(kinds.contains(&ActivityKind::Flight) || plan.days[0].city == "Japan");
    }

    #[test]
    fn start_dates_advance_one_calendar_day_at_a_time() {
        let plan = generate_itinerary(&req(3, &["japan"])).unwrap();
        assert_eq!(plan.days[0].date.as_deref(), Some("2026-04-01"));
        assert_eq!(plan.days[1].date.as_deref(), Some("2026-04-02"));
        assert_eq!(plan.days[2].date.as_deref(), Some("2026-04-03"));
    }

    #[test]
    fn offset_date_crosses_month_and_leap_boundaries() {
        assert_eq!(offset_date("2026-01-31", 1).as_deref(), Some("2026-02-01"));
        assert_eq!(offset_date("2024-02-28", 1).as_deref(), Some("2024-02-29"));
        assert_eq!(offset_date("2025-02-28", 1).as_deref(), Some("2025-03-01"));
        assert!(offset_date("not-a-date", 0).is_none());
    }

    #[test]
    fn activities_within_a_day_do_not_share_a_start_time() {
        let plan = generate_itinerary(&req(5, &["japan"])).unwrap();
        for day in &plan.days {
            let mut times: Vec<&str> = day.activities.iter().map(|a| a.start_time.as_str()).collect();
            let before = times.len();
            times.sort();
            times.dedup();
            assert_eq!(times.len(), before, "day {} has overlapping start times", day.day);
        }
    }
}

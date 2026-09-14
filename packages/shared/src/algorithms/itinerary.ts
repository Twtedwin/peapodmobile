/**
 * MODULE: @peapod/shared/algorithms/itinerary
 *
 * PURPOSE
 *   TypeScript twin of `services/compute/src/itinerary.rs`. Builds a connected,
 *   day-by-day trip from the travel catalog (inbound flight, city clusters,
 *   locked trains/flights, hotels, meals, personality-ranked activities, return
 *   leg). Used as the API fallback when the Rust service is not running.
 *
 * INPUTS  : ItineraryRequest (countries, days 1..=30, personalities, pace, ...)
 * OUTPUTS : ItineraryResponse -- days, cost_breakdown summing to total_minor,
 *           cities, personalization_note that names the personalities
 *
 * CONSUMED BY
 *   - services/api  : the TypeScript fallback for POST /itinerary/generate
 *   (services/compute has the Rust twin in src/itinerary.rs)
 *
 * DETERMINISM
 *   The same request (or the same `seed`) always produces the same plan. A
 *   missing seed is derived with FNV-1a 64-bit over the request fields, matching
 *   the Rust hasher so the two implementations can be compared.
 *
 * FAILURES
 *   `days` outside 1..=30 throws. A missing/unknown catalog country does NOT
 *   throw -- a plausible synthetic itinerary is returned instead, matching the
 *   Rust service's "never 500 for a content problem" rule.
 */

import travelDatasetJson from '../../data/catalog/travel-dataset.json' with { type: 'json' };
import type { BudgetTier, ItineraryRequest, ItineraryResponse, TripPace } from '../compute.js';
import type { ActivityKind, CostCategory, CostLine, ItineraryActivity, ItineraryDay } from '../domain.js';

// ---------------------------------------------------------------------------
// Catalog (imported JSON; `_comment` / `$schemaVersion` are ignored)
// ---------------------------------------------------------------------------

interface CostByTier {
  budget: number;
  mid: number;
  luxury: number;
}

interface CatalogActivity {
  id: string;
  title: string;
  kind: string;
  emoji: string;
  duration_minutes: number;
  cost_minor_by_tier: CostByTier;
  tags: string[];
}

interface CatalogHotel {
  id: string;
  name: string;
  tier: string;
  night_cost_minor: number;
  emoji: string;
}

interface CatalogTransport {
  city_id: string;
  mode: string;
  title: string;
  duration_minutes: number;
  cost_minor_by_tier: CostByTier;
  emoji: string;
}

interface CatalogCity {
  id: string;
  name: string;
  region: string;
  activities: CatalogActivity[];
  hotels: CatalogHotel[];
  transport_to: CatalogTransport[];
}

interface CatalogCountry {
  id: string;
  name: string;
  emoji?: string;
  flight_cost_minor_by_tier: CostByTier;
  cities: CatalogCity[];
}

interface TravelDataset {
  countries: CatalogCountry[];
}

const DATASET = travelDatasetJson as unknown as TravelDataset;

function tierCost(table: CostByTier | undefined, tier: BudgetTier): number {
  if (!table) return 0;
  if (tier === 'budget') return table.budget ?? 0;
  if (tier === 'luxury') return table.luxury ?? 0;
  return table.mid ?? 0;
}

// ---------------------------------------------------------------------------
// FNV-1a 64-bit (matches itinerary.rs). JS numbers are IEEE-754, so we keep
// the 64-bit state in BigInt and emit a Number only as the xorshift seed,
// truncated to unsigned 32-bit -- plenty of entropy for a 30-day shuffle.
// ---------------------------------------------------------------------------

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;

function fnv1aByte(hash: bigint, byte: number): bigint {
  return ((hash ^ BigInt(byte)) * FNV_PRIME) & 0xffffffffffffffffn;
}

function fnv1aStr(hash: bigint, s: string): bigint {
  let h = hash;
  for (let i = 0; i < s.length; i++) h = fnv1aByte(h, s.charCodeAt(i) & 0xff);
  return fnv1aByte(h, 0x1f);
}

function hashRequest(req: ItineraryRequest): bigint {
  let h = FNV_OFFSET;
  for (const c of req.countries) h = fnv1aStr(h, c);
  h = fnv1aByte(h, 0x00);
  for (const r of req.regions ?? []) h = fnv1aStr(h, r);
  h = fnv1aByte(h, 0x00);
  h = fnv1aStr(h, String(req.days));
  h = fnv1aStr(h, String(req.travellers ?? 2));
  for (const p of req.personalities ?? []) h = fnv1aStr(h, p);
  h = fnv1aByte(h, 0x00);
  h = fnv1aStr(h, req.pace ?? 'balanced');
  h = fnv1aStr(h, req.budget_tier ?? 'mid');
  h = fnv1aStr(h, req.start_date ?? '');
  for (const m of req.must_see ?? []) h = fnv1aStr(h, m);
  h = fnv1aByte(h, 0x00);
  for (const a of req.avoid ?? []) h = fnv1aStr(h, a);
  h = fnv1aByte(h, 0x00);
  return fnv1aStr(h, req.currency ?? 'SGD');
}

/** xorshift64 with the low bit forced on so state 0 cannot stick. */
class Rng {
  private state: bigint;
  constructor(seed: bigint) {
    this.state = seed | 1n;
  }
  next(): bigint {
    let x = this.state;
    x ^= (x << 13n) & 0xffffffffffffffffn;
    x ^= x >> 7n;
    x ^= (x << 17n) & 0xffffffffffffffffn;
    x &= 0xffffffffffffffffn;
    this.state = x;
    return x;
  }
  /** Uniform in `0..n`. Returns 0 when the pool is empty. */
  genIndex(n: number): number {
    if (n <= 0) return 0;
    return Number(this.next() % BigInt(n));
  }
}

// ---------------------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------------------

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/ /g, '-');
}

function countryMatches(country: CatalogCountry, needle: string): boolean {
  const n = norm(needle);
  const aliases = [n];
  if (['uk', 'gb', 'britain', 'england', 'great-britain'].includes(n)) aliases.push('united-kingdom');
  if (['united-states', 'united-states-of-america', 'america', 'us'].includes(n)) aliases.push('usa');
  return aliases.some((a) => a === norm(country.id) || a === norm(country.name));
}

function cityMatchesRegion(city: CatalogCity, region: string): boolean {
  const r = norm(region);
  return norm(city.id) === r || norm(city.name) === r || norm(city.region) === r;
}

function titleCase(s: string): string {
  const trimmed = s.trim();
  if (!trimmed) return 'Destination';
  return trimmed
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function cityBudget(days: number): number {
  if (days <= 3) return 1;
  if (days <= 6) return 2;
  if (days <= 10) return 3;
  return 4;
}

function paceSlots(pace: TripPace | undefined): number {
  if (pace === 'relaxed') return 2;
  if (pace === 'packed') return 4;
  return 3; // balanced default
}

function allocateDays(n: number, total: number): number[] {
  if (n <= 1) return [Math.max(1, total)];
  const count = Math.min(n, Math.max(1, total));
  const weights = Array.from({ length: count }, (_, i) => (i === 0 ? 1.4 : 1));
  const sum = weights.reduce((a, b) => a + b, 0);
  const days = weights.map((w) => Math.max(1, Math.round((w / sum) * total)));
  let diff = total - days.reduce((a, b) => a + b, 0);
  let i = 0;
  while (diff > 0) {
    days[i % count]! += 1;
    diff--;
    i++;
  }
  while (diff < 0) {
    let idx = -1;
    let max = 1;
    days.forEach((d, j) => {
      if (d > max) {
        max = d;
        idx = j;
      }
    });
    if (idx < 0) break;
    days[idx]! -= 1;
    diff++;
  }
  return days;
}

interface Stop {
  city_id: string;
  city_name: string;
  flight_cost_minor: number;
  activities: CatalogActivity[];
  hotels: CatalogHotel[];
  transport_to: CatalogTransport[];
}

function syntheticActivities(city: string): CatalogActivity[] {
  const specs: Array<[string, string, string, string, number, number, string[]]> = [
    ['explore', `Explore ${city}`, 'activity', '📍', 120, 0, ['local', 'photo', 'culture']],
    ['market', 'Local market', 'meal', '🍜', 75, 2500, ['food', 'local']],
    ['walk', 'Neighbourhood walking tour', 'activity', '🚶', 90, 0, ['local', 'relaxed']],
    ['viewpoint', 'Scenic viewpoint', 'activity', '📷', 60, 0, ['photo', 'romantic']],
    ['museum', 'City museum', 'activity', '🏛️', 90, 1500, ['culture', 'history']],
    ['park', 'City park', 'activity', '🌳', 75, 0, ['nature', 'relaxed']],
    ['dinner', `Dinner in ${city}`, 'meal', '🍽️', 90, 4500, ['food']],
    ['cafe', 'Neighbourhood cafe', 'meal', '☕', 45, 1200, ['food', 'relaxed']],
  ];
  return specs.map(([id, title, kind, emoji, mins, cost, tags]) => ({
    id: `${norm(city)}-${id}`,
    title,
    kind,
    emoji,
    duration_minutes: mins,
    cost_minor_by_tier: { budget: Math.floor(cost / 2), mid: cost, luxury: cost * 2 },
    tags,
  }));
}

function syntheticStop(needle: string, tier: BudgetTier): Stop {
  const name = titleCase(needle);
  const local = norm(needle) === 'singapore';
  return {
    city_id: norm(needle),
    city_name: name,
    flight_cost_minor: local ? 0 : 65_000, // S$650 return stand-in
    activities: syntheticActivities(name),
    hotels: [
      { id: `${norm(needle)}-hotel-budget`, name: `${name} Inn`, tier: 'budget', night_cost_minor: 9_000, emoji: '🏨' },
      { id: `${norm(needle)}-hotel-mid`, name: `${name} City Hotel`, tier: 'mid', night_cost_minor: 18_000, emoji: '🏨' },
      { id: `${norm(needle)}-hotel-luxury`, name: `${name} Grand`, tier: 'luxury', night_cost_minor: 45_000, emoji: '🏨' },
    ],
    transport_to: [],
  };
}

function selectStops(req: ItineraryRequest, tier: BudgetTier): Stop[] {
  const maxCities = cityBudget(req.days);
  const needles = req.countries.length > 0 ? req.countries : ['Destination'];
  const countries = DATASET.countries ?? [];
  const stops: Stop[] = [];

  for (const needle of needles) {
    const country = countries.find((c) => countryMatches(c, needle));
    if (!country || !country.cities?.length) {
      stops.push(syntheticStop(needle, tier));
    } else {
      let cities = country.cities;
      if (req.regions && req.regions.length > 0) {
        const filtered = cities.filter((c) => req.regions.some((r) => cityMatchesRegion(c, r)));
        if (filtered.length > 0) cities = filtered;
      }
      const take = Math.max(1, Math.min(maxCities - stops.length, cities.length));
      for (const city of cities.slice(0, take)) {
        stops.push({
          city_id: city.id,
          city_name: city.name,
          flight_cost_minor: tierCost(country.flight_cost_minor_by_tier, tier),
          activities: city.activities ?? [],
          hotels: city.hotels ?? [],
          transport_to: city.transport_to ?? [],
        });
      }
    }
    if (stops.length >= maxCities) break;
  }

  if (stops.length === 0) stops.push(syntheticStop('Destination', tier));
  return stops.slice(0, maxCities);
}

function pickHotel(stop: Stop, tier: BudgetTier): CatalogHotel | undefined {
  return stop.hotels.find((h) => h.tier.toLowerCase() === tier) ?? stop.hotels[0];
}

function kindFromCatalog(raw: string): ActivityKind {
  const k = raw.toLowerCase();
  if (k === 'flight' || k === 'transfer' || k === 'hotel' || k === 'meal' || k === 'train' || k === 'free') {
    return k;
  }
  return 'activity';
}

function lockedKind(kind: ActivityKind): boolean {
  return kind === 'flight' || kind === 'train';
}

function categoryOf(kind: ActivityKind): CostCategory {
  if (kind === 'flight') return 'flights';
  if (kind === 'hotel') return 'accommodation';
  if (kind === 'activity') return 'activities';
  if (kind === 'meal') return 'food';
  if (kind === 'train' || kind === 'transfer') return 'transport';
  return 'other';
}

function labelOf(cat: CostCategory): string {
  if (cat === 'flights') return 'Flights';
  if (cat === 'accommodation') return 'Accommodation';
  if (cat === 'activities') return 'Activities';
  if (cat === 'food') return 'Food';
  if (cat === 'transport') return 'Transport';
  return 'Other';
}

function activityScore(act: CatalogActivity, personalities: string[], mustSee: string[]): number {
  let s = 0;
  for (const tag of act.tags ?? []) {
    if (personalities.some((p) => p.toLowerCase() === tag.toLowerCase())) s += 2;
  }
  for (const m of mustSee) {
    const n = m.toLowerCase();
    if (act.title.toLowerCase().includes(n) || (act.tags ?? []).some((t) => t.toLowerCase() === n)) s += 8;
  }
  return s;
}

function isAvoided(act: CatalogActivity, avoid: string[]): boolean {
  return avoid.some((needle) => {
    const n = needle.toLowerCase();
    return act.title.toLowerCase().includes(n) || (act.tags ?? []).some((t) => t.toLowerCase() === needle.toLowerCase());
  });
}

function pickActivity(
  stop: Stop,
  personalities: string[],
  mustSee: string[],
  avoid: string[],
  used: Set<string>,
  rng: Rng,
  skipMeals: boolean,
): CatalogActivity | undefined {
  let pool = stop.activities.filter(
    (a) => !used.has(a.id) && !isAvoided(a, avoid) && !(skipMeals && a.kind.toLowerCase() === 'meal'),
  );
  if (pool.length === 0) {
    pool = stop.activities.filter((a) => !(skipMeals && a.kind.toLowerCase() === 'meal') && !isAvoided(a, avoid));
  }
  if (pool.length === 0) return undefined;
  pool.sort((a, b) => activityScore(b, personalities, mustSee) - activityScore(a, personalities, mustSee) || (a.id < b.id ? -1 : 1));
  const choice = pool[rng.genIndex(Math.min(3, pool.length))]!;
  used.add(choice.id);
  return choice;
}

function hhmm(minutes: number): string {
  const h = Math.max(0, Math.min(23, Math.floor(minutes / 60)));
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function offsetDate(start: string, days: number): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(start);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1; // JS Date months are 0-based
  const day = Number(match[3]);
  const dt = new Date(Date.UTC(year, month, day + days));
  if (Number.isNaN(dt.getTime())) return null;
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

let idSeq = 0;
function nextId(day: number): string {
  idSeq += 1;
  return `d${day}-a${String(idSeq).padStart(2, '0')}`;
}

const GAP_MINUTES = 15; // padding so two entries cannot share a start time

function buildDay(
  stop: Stop,
  prev: Stop | undefined,
  opts: {
    dayNumber: number;
    isArrival: boolean;
    isDeparture: boolean;
    isTransit: boolean;
    isOneDay: boolean;
    pace: TripPace;
    budgetTier: BudgetTier;
    travellers: number;
    personalities: string[];
    mustSee: string[];
    avoid: string[];
    hotel: CatalogHotel | undefined;
    hotelCost: number;
    flightCost: number;
  },
  rng: Rng,
  used: Set<string>,
): ItineraryActivity[] {
  const out: ItineraryActivity[] = [];
  let minutes = opts.isTransit ? 8 * 60 + 30 : 8 * 60;

  const push = (
    title: string,
    kind: ActivityKind,
    durationMinutes: number,
    costMinor: number,
    emoji: string,
    notes: string | null = null,
  ) => {
    const duration = Math.max(15, durationMinutes); // never a 0-minute slot
    out.push({
      id: nextId(opts.dayNumber),
      title,
      kind,
      start_time: hhmm(minutes),
      duration_minutes: duration,
      location: stop.city_name,
      notes,
      cost_minor: costMinor,
      locked: lockedKind(kind),
      emoji,
    });
    minutes += duration + GAP_MINUTES;
  };

  if (opts.isArrival && stop.flight_cost_minor > 0) {
    push(`Flight · Singapore → ${stop.city_name}`, 'flight', 420, opts.flightCost, '✈️', 'Return fare, priced for the whole pod.');
    push('Airport transfer to hotel', 'transfer', 45, 2500 * opts.travellers, '🚆');
  } else if (opts.isArrival && stop.flight_cost_minor === 0) {
    push('Start from home', 'free', 30, 0, '🏠', 'A local trip -- no flight to catch.');
  }

  if (opts.isTransit && prev) {
    const leg = prev.transport_to.find((t) => t.city_id === stop.city_id) ?? prev.transport_to[0];
    if (leg) {
      const kind: ActivityKind = leg.mode.toLowerCase() === 'flight' ? 'flight' : leg.mode.toLowerCase() === 'train' ? 'train' : 'transfer';
      push(leg.title || `${prev.city_name} → ${stop.city_name}`, kind, leg.duration_minutes || 120, tierCost(leg.cost_minor_by_tier, opts.budgetTier) * opts.travellers, leg.emoji || '🚆');
    } else {
      push(`Train · ${prev.city_name} → ${stop.city_name}`, 'train', 120, 6000 * opts.travellers, '🚆');
    }
  }

  if (opts.hotel && opts.hotelCost > 0 && !opts.isDeparture) {
    push(`Check in — ${opts.hotel.name}`, 'hotel', 30, opts.hotelCost, opts.hotel.emoji || '🏨', 'Hotel nights for this city, priced for the whole pod.');
  } else if (opts.hotel && !opts.isArrival && !opts.isDeparture) {
    push(`Breakfast at ${opts.hotel.name}`, 'meal', 45, 0, '🍳', 'Included with the room.');
  }

  let slots = paceSlots(opts.pace);
  if (opts.isArrival || opts.isDeparture || opts.isTransit) slots = Math.max(1, slots - 1);
  if (opts.isOneDay) slots = 1;

  for (let i = 0; i < slots; i++) {
    const act = pickActivity(stop, opts.personalities, opts.mustSee, opts.avoid, used, rng, true);
    if (!act) {
      push(`Free time in ${stop.city_name}`, 'free', 90, 0, '🛋️');
      continue;
    }
    push(act.title, kindFromCatalog(act.kind), act.duration_minutes || 75, tierCost(act.cost_minor_by_tier, opts.budgetTier) * opts.travellers, act.emoji || '📍');
  }

  const hasLunch = out.some((a) => a.kind === 'meal' && a.start_time >= '12:00' && a.start_time < '14:00');
  if (!hasLunch) {
    const meal = stop.activities.find((a) => a.kind.toLowerCase() === 'meal' && !used.has(a.id));
    if (meal) used.add(meal.id);
    out.push({
      id: nextId(opts.dayNumber),
      title: meal?.title ?? `Lunch in ${stop.city_name}`,
      kind: 'meal',
      start_time: '12:30',
      duration_minutes: meal?.duration_minutes || 75,
      location: stop.city_name,
      notes: meal ? null : 'A nearby spot the planner picked.',
      cost_minor: meal ? tierCost(meal.cost_minor_by_tier, opts.budgetTier) * opts.travellers : 3000 * opts.travellers,
      locked: false,
      emoji: meal?.emoji || '🍽️',
    });
  }
  if (!opts.isDeparture) {
    const hasDinner = out.some((a) => a.kind === 'meal' && a.start_time >= '18:00');
    if (!hasDinner) {
      const meal = stop.activities.find((a) => a.kind.toLowerCase() === 'meal' && !used.has(a.id));
      if (meal) used.add(meal.id);
      out.push({
        id: nextId(opts.dayNumber),
        title: meal?.title ?? `Dinner in ${stop.city_name}`,
        kind: 'meal',
        start_time: '19:00',
        duration_minutes: meal?.duration_minutes || 75,
        location: stop.city_name,
        notes: meal ? null : 'A nearby spot the planner picked.',
        cost_minor: meal ? tierCost(meal.cost_minor_by_tier, opts.budgetTier) * opts.travellers : 6000 * opts.travellers,
        locked: false,
        emoji: meal?.emoji || '🍷',
      });
    }
  }

  if (opts.isDeparture && stop.flight_cost_minor > 0) {
    out.push({
      id: nextId(opts.dayNumber),
      title: `Flight · ${stop.city_name} → Singapore`,
      kind: 'flight',
      start_time: opts.isOneDay ? '18:00' : '17:00',
      duration_minutes: 420,
      location: stop.city_name,
      notes: 'Return leg; fare already counted on the inbound.',
      cost_minor: 0,
      locked: true,
      emoji: '✈️',
    });
  } else if (opts.isDeparture && stop.flight_cost_minor === 0) {
    out.push({
      id: nextId(opts.dayNumber),
      title: 'Head home',
      kind: 'free',
      start_time: '17:00',
      duration_minutes: 30,
      location: stop.city_name,
      notes: 'Wrap up a local day.',
      cost_minor: 0,
      locked: false,
      emoji: '🏠',
    });
  }

  out.sort((a, b) => a.start_time.localeCompare(b.start_time) || a.id.localeCompare(b.id));
  return out;
}

function costBreakdown(days: ItineraryDay[], currency: string): { lines: CostLine[]; total: number } {
  const buckets = new Map<CostCategory, number>();
  for (const day of days) {
    for (const act of day.activities) {
      const cat = categoryOf(act.kind);
      buckets.set(cat, (buckets.get(cat) ?? 0) + act.cost_minor);
    }
  }
  const order: CostCategory[] = ['flights', 'accommodation', 'activities', 'food', 'transport', 'other'];
  const lines: CostLine[] = [];
  for (const cat of order) {
    const amount = buckets.get(cat) ?? 0;
    if (amount === 0) continue;
    lines.push({ label: labelOf(cat), amount_minor: amount, currency, category: cat });
  }
  const total = lines.reduce((s, l) => s + l.amount_minor, 0);
  return { lines, total };
}

/**
 * Generates a connected itinerary.
 *
 * @param request.days Must be 1..=30; anything else throws.
 * @returns Days, a cost breakdown that sums to `total_minor`, cities, and a
 *          personalisation note that names the pod's personalities.
 *
 * EDGE CASES
 *   - Unknown country / empty catalog: a synthetic city named after the request.
 *   - `seed` missing: derived from the request via FNV-1a, so repeats match.
 *   - Flights and trains are `locked: true`.
 */
export function generateItinerary(request: ItineraryRequest): ItineraryResponse {
  if (request.days < 1 || request.days > 30) {
    throw new Error('days must be between 1 and 30');
  }

  const seed = request.seed != null ? BigInt(request.seed) & 0xffffffffffffffffn : hashRequest(request);
  const rng = new Rng(seed);
  idSeq = 0;

  const travellers = Math.max(1, request.travellers ?? 2);
  const rooms = Math.floor((travellers + 1) / 2); // one double per two travellers
  const tier: BudgetTier = request.budget_tier ?? 'mid';
  const pace: TripPace = request.pace ?? 'balanced';
  const personalities = request.personalities ?? [];
  const mustSee = request.must_see ?? [];
  const avoid = request.avoid ?? [];
  const currency = request.currency ?? 'SGD';

  const stops = selectStops(request, tier);
  const dayCounts = allocateDays(stops.length, request.days);
  const used = new Set<string>();
  const days: ItineraryDay[] = [];
  let dayNumber = 1;

  for (let si = 0; si < stops.length; si++) {
    const stop = stops[si]!;
    const n = dayCounts[si] ?? 1;
    const isFirst = si === 0;
    const isLast = si === stops.length - 1;
    const hotel = pickHotel(stop, tier);
    const nights = isLast ? Math.max(0, n - 1) : n;
    const hotelCost = hotel ? hotel.night_cost_minor * nights * rooms : 0;
    let hotelCharged = false;

    for (let d = 0; d < n; d++) {
      const isArrival = isFirst && d === 0;
      const isDeparture = isLast && d + 1 === n;
      const isTransit = !isFirst && d === 0;
      days.push({
        day: dayNumber,
        date: request.start_date ? offsetDate(request.start_date, dayNumber - 1) : null,
        city: stop.city_name,
        summary: isArrival && isDeparture
          ? `In and out of ${stop.city_name} in a single day`
          : isArrival
            ? `Arrive in ${stop.city_name}`
            : isDeparture
              ? `Depart ${stop.city_name}`
              : isTransit
                ? `Travel to ${stop.city_name}`
                : `A full day in ${stop.city_name}`,
        activities: buildDay(
          stop,
          isTransit ? stops[si - 1] : undefined,
          {
            dayNumber,
            isArrival,
            isDeparture,
            isTransit,
            isOneDay: request.days === 1,
            pace,
            budgetTier: tier,
            travellers,
            personalities,
            mustSee,
            avoid,
            hotel,
            hotelCost: !hotelCharged ? hotelCost : 0,
            flightCost: isArrival ? stop.flight_cost_minor * travellers : 0,
          },
          rng,
          used,
        ),
      });
      if (!hotelCharged) hotelCharged = true;
      dayNumber += 1;
    }
  }

  const { lines, total } = costBreakdown(days, currency);
  const cities: string[] = [];
  for (const day of days) {
    if (!cities.includes(day.city)) cities.push(day.city);
  }

  const route = cities.length ? cities.join(' → ') : 'the destination';
  const dayWord = request.days === 1 ? 'day' : 'days';
  const personalization_note = personalities.length
    ? `Tuned to your ${personalities.map(titleCase).join(', ')} style across ${route} over ${request.days} ${dayWord}.`
    : `A ${pace} ${dayWord} plan across ${route}.`;

  return { days, cost_breakdown: lines, total_minor: total, cities, personalization_note };
}

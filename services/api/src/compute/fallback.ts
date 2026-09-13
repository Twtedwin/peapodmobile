/**
 * MODULE: services/api/src/compute/fallback
 *
 * PURPOSE
 *   Pure TypeScript stand-in for the Rust compute service. Every function
 *   here wraps an algorithm from `@peapod/shared` so the HTTP client and
 *   this module are substitutable -- same request in, same response out.
 *
 * INPUTS  : the compute request payloads from `@peapod/shared`
 * OUTPUTS : the matching response payloads
 *
 * WHY A STUB ITINERARY
 *   `generateItinerary` is not in the shared algorithms package (the Rust
 *   service owns the travel-dataset walk). When the compute service is
 *   down we still owe the client an `ItineraryResponse`, so we build N
 *   placeholder days that match the type rather than 500ing the planner.
 */

import {
  classifyActivity,
  computeAchievements,
  evaluateDecision,
  gardenGrowth,
  lastTripFrom,
  levelInfo,
  nearestPlace,
  splitAmount,
} from '@peapod/shared';
import type {
  AchievementRequest,
  AchievementResponse,
  ActivityClassification,
  EvaluateDecisionRequest,
  EvaluateDecisionResponse,
  GardenGrowthRequest,
  GardenGrowthResponse,
  ItineraryActivity,
  ItineraryDay,
  ItineraryRequest,
  ItineraryResponse,
  LevelRequest,
  LevelResponse,
  NearestPlaceRequest,
  NearestPlaceResponse,
  ReconstructTripRequest,
  ReconstructTripResponse,
  SplitRequest,
  SplitResponse,
} from '@peapod/shared';

export function reconstructTrip(request: ReconstructTripRequest): ReconstructTripResponse {
  return { trip: lastTripFrom(request.pings) };
}

export function evaluate(request: EvaluateDecisionRequest): EvaluateDecisionResponse {
  return evaluateDecision(request);
}

export function split(request: SplitRequest): SplitResponse {
  return splitAmount(request);
}

export function level(request: LevelRequest): LevelResponse {
  return levelInfo(request.xp);
}

export function growth(request: GardenGrowthRequest): GardenGrowthResponse {
  return gardenGrowth(request);
}

export function achievements(request: AchievementRequest): AchievementResponse {
  return computeAchievements(request);
}

export function nearest(request: NearestPlaceRequest): NearestPlaceResponse {
  const hit = nearestPlace(request.location, request.places, request.radius_m);
  return {
    place_id: hit ? (hit.place as { id: string }).id : null,
    distance_m: hit?.distance_m ?? null,
  };
}

export function activity(speed: number): ActivityClassification {
  return classifyActivity(speed);
}

/**
 * Placeholder itinerary used when the Rust generator is unreachable.
 *
 * Builds `request.days` days of three locked-free activities each, labelled
 * with the requested countries so the planner screen is still navigable.
 * Cost lines are zeros -- a stub must not invent a budget the pod did not
 * ask for.
 */
export function generateItineraryStub(request: ItineraryRequest): ItineraryResponse {
  const dayCount = Math.max(1, Math.min(30, Math.round(request.days) || 1));
  const city = request.regions[0] ?? request.countries[0] ?? 'Destination';
  const start = request.start_date ? new Date(`${request.start_date}T00:00:00.000Z`) : null;

  const days: ItineraryDay[] = [];
  for (let i = 0; i < dayCount; i++) {
    const date =
      start && !Number.isNaN(start.getTime())
        ? new Date(start.getTime() + i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
        : null;

    const slot = (title: string, kind: ItineraryActivity['kind'], hour: string, emoji: string): ItineraryActivity => ({
      id: `stub-${i + 1}-${hour}`,
      title,
      kind,
      start_time: hour,
      duration_minutes: 90,
      location: city,
      notes: 'Placeholder -- compute service was unavailable.',
      cost_minor: 0,
      locked: kind === 'flight' || kind === 'train',
      emoji,
    });

    days.push({
      day: i + 1,
      date,
      city,
      summary: `Day ${i + 1} in ${city}`,
      activities: [
        slot(i === 0 ? `Arrive in ${city}` : `Morning in ${city}`, i === 0 ? 'flight' : 'activity', '09:00', i === 0 ? '✈️' : '☀️'),
        slot(`Explore ${city}`, 'activity', '13:00', '🗺️'),
        slot(i === dayCount - 1 ? `Depart ${city}` : `Evening in ${city}`, i === dayCount - 1 ? 'flight' : 'meal', '19:00', i === dayCount - 1 ? '✈️' : '🍽️'),
      ],
    });
  }

  return {
    days,
    cost_breakdown: [],
    total_minor: 0,
    cities: [city],
    personalization_note: 'Generated locally because the compute service was unavailable. Treat this as a sketch.',
  };
}

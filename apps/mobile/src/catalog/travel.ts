/**
 * MODULE: apps/mobile/src/catalog/travel.ts
 *
 * PURPOSE
 *   Thin typed view over the shared travel dataset so the trip wizard can
 *   list countries and regions without reaching into JSON by hand.
 *
 * INPUTS  : packages/shared/data/catalog/travel-dataset.json
 * OUTPUTS : country + region records
 * CONSUMED BY : app/trip/index.tsx
 */

import dataset from '@peapod/shared/data/catalog/travel-dataset.json';

export interface TravelRegion {
  id: string;
  name: string;
  latitude?: number;
  longitude?: number;
}

export interface TravelCountry {
  id: string;
  name: string;
  emoji: string;
  currency: string;
  regions: TravelRegion[];
}

interface DatasetShape {
  countries?: {
    id: string;
    name: string;
    emoji: string;
    currency?: string;
    regions?: TravelRegion[];
  }[];
}

const raw = dataset as DatasetShape;

export const TRAVEL_COUNTRIES: TravelCountry[] = (raw.countries ?? []).map((country) => ({
  id: country.id,
  name: country.name,
  emoji: country.emoji,
  currency: country.currency ?? 'SGD',
  regions: country.regions ?? [],
}));

export const TRAVEL_PERSONALITIES = [
  { id: 'food', label: 'Food', emoji: '🍜' },
  { id: 'nature', label: 'Nature', emoji: '🌿' },
  { id: 'culture', label: 'Culture', emoji: '🏛️' },
  { id: 'adventure', label: 'Adventure', emoji: '🏔️' },
  { id: 'relaxed', label: 'Relaxed', emoji: '😌' },
  { id: 'romantic', label: 'Romantic', emoji: '💕' },
  { id: 'shopping', label: 'Shopping', emoji: '🛍️' },
  { id: 'themepark', label: 'Theme parks', emoji: '🎢' },
  { id: 'photo', label: 'Photo', emoji: '📸' },
  { id: 'history', label: 'History', emoji: '📜' },
];

/**
 * MODULE: apps/mobile/src/catalog/activities.ts
 *
 * PURPOSE
 *   The Date / Activity library, ported from the original discovery screen.
 *   Lives in the app rather than the shared package because it is display
 *   copy, not a cross-language contract.
 *
 * INPUTS  : none
 * OUTPUTS : activity records + filter lists
 * CONSUMED BY : app/date.tsx
 */

export interface CatalogActivity {
  id: string;
  title: string;
  emoji: string;
  format: 'online' | 'offline';
  contexts: string[];
  category: string;
  duration: string;
  description: string;
}

export const ACTIVITY_CATEGORIES = [
  'Romantic',
  'Food',
  'Movies',
  'Games',
  'Creative',
  'Conversation',
  'Outdoors',
  'Music',
];

export const DATE_ACTIVITIES: CatalogActivity[] = [
  { id: 'a_movie', title: 'Virtual Movie Night', emoji: '🎬', format: 'online', contexts: ['Long Distance', 'General'], category: 'Movies', duration: '2 hours', description: 'Pick a movie, press play at the same time and watch together over a call.' },
  { id: 'a_game', title: 'Multiplayer Game Night', emoji: '🎮', format: 'online', contexts: ['Long Distance', 'General'], category: 'Games', duration: '2 hours', description: 'Jump into an online multiplayer game you both enjoy.' },
  { id: 'a_recipe', title: 'Same Recipe Challenge', emoji: '🍳', format: 'online', contexts: ['Long Distance', 'General'], category: 'Food', duration: '2 hours', description: 'Cook the same recipe from your own kitchens, then compare over video.' },
  { id: 'a_questions', title: 'Pod Question Challenge', emoji: '💬', format: 'online', contexts: ['Long Distance', 'General'], category: 'Conversation', duration: '1 hour', description: 'Take turns answering meaningful questions.' },
  { id: 'a_stars', title: 'Stargazing Call', emoji: '🌌', format: 'online', contexts: ['Long Distance', 'General'], category: 'Romantic', duration: '1 hour', description: 'Find a spot under the sky and look at the same stars.' },
  { id: 'a_playlist', title: 'Playlist Challenge', emoji: '🎵', format: 'online', contexts: ['Long Distance', 'General'], category: 'Music', duration: '1 hour', description: 'Each build a playlist from the same prompt, then listen together.' },
  { id: 'd_sunset', title: 'Sunset walk at the bay', emoji: '🌅', format: 'offline', contexts: ['Local'], category: 'Romantic', duration: '1 hr', description: 'Golden hour, no cost — just the two of you and a view.' },
  { id: 'd_picnic', title: 'Beach picnic', emoji: '🧺', format: 'offline', contexts: ['Local'], category: 'Food', duration: '2 hrs', description: 'Bring snacks from home and claim a spot on the sand.' },
  { id: 'd_wander', title: 'Explore a new neighbourhood', emoji: '🚶', format: 'offline', contexts: ['Local', 'General'], category: 'Outdoors', duration: '2–3 hrs', description: 'Wander somewhere new with no plan and see what you find.' },
  { id: 'd_cafe', title: 'Café afternoon', emoji: '☕', format: 'offline', contexts: ['Local', 'General'], category: 'Food', duration: '2 hrs', description: 'Flat whites and people-watching, nowhere to be.' },
  { id: 'd_pottery', title: 'Pottery class', emoji: '🏺', format: 'offline', contexts: ['Local', 'General'], category: 'Creative', duration: '2.5 hrs', description: 'Beginner-friendly — get your hands dirty and make something.' },
  { id: 'd_photo', title: 'Photo walk', emoji: '📸', format: 'offline', contexts: ['Local', 'General'], category: 'Creative', duration: '1.5 hrs', description: 'Pick a stretch of street and photograph it together.' },
];

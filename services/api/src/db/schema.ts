/**
 * MODULE: services/api/src/db/schema
 *
 * PURPOSE
 *   Drizzle table definitions for every domain record Peapod persists. Column
 *   names are snake_case and match `@peapod/shared` entities/domain field
 *   names one-for-one, so a selected row can be returned as JSON without a
 *   mapping layer.
 *
 * INPUTS  : none (declarations only)
 * OUTPUTS : `pgTable` objects consumed by route handlers and by drizzle-kit
 *
 * WHY HAND-WRITTEN RATHER THAN GENERATED
 *   The TypeScript types in `@peapod/shared` are the contract. Generating
 *   Drizzle from them would hide the indexes, defaults, and JSONB shapes that
 *   are the actual reason this file exists. Keep the two in step by eye;
 *   `packages/shared/schemas/*.schema.json` is the referee.
 *
 * MONEY
 *   Every `*_minor` column is INTEGER cents (or the currency's minor unit).
 *   Never numeric/float -- see the warning at the top of
 *   `packages/shared/src/domain.ts`.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type {
  CostLine,
  IdeaCategory,
  IdeaStage,
  ItineraryDay,
  MemoryTag,
  NotificationKind,
  PlaceCategory,
  PlanAudience,
  PlanRepeat,
  PodGroupType,
  PodRole,
  SeedProvenance,
  TripOrigin,
  TripStatus,
  VoteStance,
  WalletTransactionKind,
} from '@peapod/shared';

/** UUID primary key with a database-side default, so inserts that omit `id` still get one. */
const idColumn = () => uuid('id').primaryKey().default(sql`gen_random_uuid()`);

/** timestamptz stored as a JS Date; Fastify JSON-encodes it to ISO-8601 on the way out. */
const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

const auditColumns = {
  id: idColumn(),
  created_at: timestamptz('created_at').notNull().defaultNow(),
  updated_at: timestamptz('updated_at').notNull().defaultNow(),
  created_by_id: uuid('created_by_id').notNull(),
};

const emptyArray = sql`'[]'::jsonb`;
const emptyObject = sql`'{}'::jsonb`;

// ---------------------------------------------------------------------------
// Core records (packages/shared/src/entities.ts)
// ---------------------------------------------------------------------------

/**
 * Account profile. Credentials never appear here -- those live exclusively
 * in the security service's own tables. `created_by_id` is the user's own
 * id: an account creates itself.
 */
export const users = pgTable(
  'users',
  {
    ...auditColumns,
    email: text('email').notNull(),
    display_name: text('display_name').notNull(),
    avatar_url: text('avatar_url'),
    permissions_granted: boolean('permissions_granted').notNull().default(false),
    role: text('role').$type<'admin' | 'user'>().notNull().default('user'),
  },
  (t) => [uniqueIndex('users_email_idx').on(t.email)],
);

export const pods = pgTable(
  'pods',
  {
    ...auditColumns,
    name: text('name').notNull(),
    emoji: text('emoji').notNull().default('❤️'),
    group_type: text('group_type').$type<PodGroupType>().notNull().default('couple'),
    trip_history_enabled: boolean('trip_history_enabled').notNull().default(true),
  },
  (t) => [index('pods_created_by_id_idx').on(t.created_by_id)],
);

/**
 * Joins a user to a pod. Clients never write this table directly -- every
 * change goes through the privileged pod routes so admin checks cannot be
 * bypassed.
 */
export const podMemberships = pgTable(
  'pod_memberships',
  {
    ...auditColumns,
    pod_id: uuid('pod_id').notNull(),
    user_id: uuid('user_id').notNull(),
    role: text('role').$type<PodRole>().notNull().default('member'),
  },
  (t) => [
    uniqueIndex('pod_memberships_pod_user_idx').on(t.pod_id, t.user_id),
    index('pod_memberships_pod_id_idx').on(t.pod_id),
    index('pod_memberships_user_id_idx').on(t.user_id),
  ],
);

/** Six-character join code that expires ten minutes after issue. */
export const podInvites = pgTable(
  'pod_invites',
  {
    ...auditColumns,
    pod_id: uuid('pod_id').notNull(),
    code: text('code').notNull(),
    expires_at: timestamptz('expires_at').notNull(),
  },
  (t) => [
    uniqueIndex('pod_invites_code_idx').on(t.code),
    index('pod_invites_pod_id_idx').on(t.pod_id),
  ],
);

/**
 * One GPS fix from one device. Highest-volume table in the system. Presence
 * is derived live: a member is online when their newest ping is younger
 * than 10 minutes (see `GEO.onlineThreshold_ms`).
 */
export const locationPings = pgTable(
  'location_pings',
  {
    ...auditColumns,
    latitude: doublePrecision('latitude').notNull(),
    longitude: doublePrecision('longitude').notNull(),
    speed: doublePrecision('speed').notNull().default(0),
    accuracy: doublePrecision('accuracy').notNull().default(0),
    heading: doublePrecision('heading').notNull().default(0),
    is_driving: boolean('is_driving').notNull().default(false),
    pod_id: uuid('pod_id'),
  },
  (t) => [
    index('location_pings_pod_id_idx').on(t.pod_id),
    index('location_pings_created_by_id_idx').on(t.created_by_id),
    index('location_pings_created_at_idx').on(t.created_at),
  ],
);

export const phoneStatuses = pgTable(
  'phone_statuses',
  {
    ...auditColumns,
    battery_level: integer('battery_level').notNull().default(0),
    is_charging: boolean('is_charging').notNull().default(false),
    connection_type: text('connection_type').notNull().default('unknown'),
    signal_bars: integer('signal_bars').notNull().default(0),
    battery_supported: boolean('battery_supported').notNull().default(true),
    connection_supported: boolean('connection_supported').notNull().default(true),
    pod_id: uuid('pod_id'),
  },
  (t) => [
    index('phone_statuses_pod_id_idx').on(t.pod_id),
    index('phone_statuses_created_by_id_idx').on(t.created_by_id),
  ],
);

export const favouritePlaces = pgTable(
  'favourite_places',
  {
    ...auditColumns,
    name: text('name').notNull(),
    address: text('address'),
    latitude: doublePrecision('latitude').notNull(),
    longitude: doublePrecision('longitude').notNull(),
    category: text('category').$type<PlaceCategory>().notNull().default('other'),
    expires_at: timestamptz('expires_at'),
    pod_id: uuid('pod_id'),
  },
  (t) => [index('favourite_places_pod_id_idx').on(t.pod_id)],
);

export const placeAlerts = pgTable(
  'place_alerts',
  {
    ...auditColumns,
    place_name: text('place_name').notNull(),
    event: text('event').$type<'arrived' | 'left'>().notNull(),
    latitude: doublePrecision('latitude'),
    longitude: doublePrecision('longitude'),
    pod_id: uuid('pod_id'),
  },
  (t) => [index('place_alerts_pod_id_idx').on(t.pod_id)],
);

export const plans = pgTable(
  'plans',
  {
    ...auditColumns,
    title: text('title').notNull(),
    description: text('description'),
    start_time: timestamptz('start_time').notNull(),
    end_time: timestamptz('end_time'),
    location_name: text('location_name'),
    for_whom: text('for_whom').$type<PlanAudience>().notNull().default('pod'),
    participant_ids: jsonb('participant_ids').$type<string[]>().notNull().default(emptyArray),
    repeat_frequency: text('repeat_frequency').$type<PlanRepeat>().notNull().default('none'),
    pod_id: uuid('pod_id'),
  },
  (t) => [index('plans_pod_id_idx').on(t.pod_id)],
);

/**
 * A chat message. Null `recipient_id` is pod-wide; a set `recipient_id` is
 * one-to-one. Pod messages are pruned after seven days; global DMs use a null
 * pod_id and are retained.
 */
export const messages = pgTable(
  'messages',
  {
    ...auditColumns,
    recipient_id: uuid('recipient_id'),
    pod_id: uuid('pod_id'),
    text: text('text').notNull(),
  },
  (t) => [
    index('messages_pod_id_idx').on(t.pod_id),
    index('messages_recipient_id_idx').on(t.recipient_id),
    index('messages_created_at_idx').on(t.created_at),
  ],
);

export const notifications = pgTable(
  'notifications',
  {
    ...auditColumns,
    title: text('title').notNull(),
    body: text('body'),
    emoji: text('emoji').notNull().default('🫘'),
    is_read: boolean('is_read').notNull().default(false),
    recipient_id: uuid('recipient_id'),
    type: text('type').$type<NotificationKind>().notNull().default('info'),
    pod_id: uuid('pod_id'),
  },
  (t) => [
    index('notifications_pod_id_idx').on(t.pod_id),
    index('notifications_recipient_id_idx').on(t.recipient_id),
  ],
);

export const importantDates = pgTable(
  'important_dates',
  {
    ...auditColumns,
    title: text('title').notNull(),
    date: date('date', { mode: 'string' }).notNull(),
    count_up: boolean('count_up').notNull().default(false),
    recurring: boolean('recurring').notNull().default(false),
    emoji: text('emoji').notNull().default('📅'),
    pinned: boolean('pinned').notNull().default(false),
    pod_id: uuid('pod_id'),
  },
  (t) => [index('important_dates_pod_id_idx').on(t.pod_id)],
);

// ---------------------------------------------------------------------------
// Product records that used to be in-memory fakes (packages/shared/src/domain.ts)
// ---------------------------------------------------------------------------

export const trips = pgTable(
  'trips',
  {
    ...auditColumns,
    pod_id: uuid('pod_id').notNull(),
    title: text('title').notNull(),
    destination: text('destination').notNull(),
    country: text('country'),
    emoji: text('emoji').notNull().default('✈️'),
    status: text('status').$type<TripStatus>().notNull().default('draft'),
    origin: text('origin').$type<TripOrigin>().notNull().default('manual'),
    start_date: date('start_date', { mode: 'string' }),
    end_date: date('end_date', { mode: 'string' }),
    flexible_dates: boolean('flexible_dates').notNull().default(false),
    participant_ids: jsonb('participant_ids').$type<string[]>().notNull().default(emptyArray),
    cities: jsonb('cities').$type<string[]>().notNull().default(emptyArray),
    budget_minor: integer('budget_minor'),
    currency: text('currency').notNull().default('SGD'),
    itinerary: jsonb('itinerary').$type<ItineraryDay[]>().notNull().default(emptyArray),
    cost_breakdown: jsonb('cost_breakdown').$type<CostLine[]>().notNull().default(emptyArray),
    rating: integer('rating'),
    source_idea_id: uuid('source_idea_id'),
    completed_at: timestamptz('completed_at'),
  },
  (t) => [index('trips_pod_id_idx').on(t.pod_id)],
);

export const ideas = pgTable(
  'ideas',
  {
    ...auditColumns,
    pod_id: uuid('pod_id').notNull(),
    title: text('title').notNull(),
    emoji: text('emoji').notNull().default('💡'),
    description: text('description'),
    destination: text('destination'),
    country: text('country'),
    category: text('category').$type<IdeaCategory>().notNull().default('activity'),
    source_type: text('source_type').$type<'user' | 'ai'>().notNull().default('user'),
    estimated_cost_minor: integer('estimated_cost_minor'),
    duration_days: integer('duration_days'),
    activities: jsonb('activities').$type<string[]>().notNull().default(emptyArray),
    preferred_month: text('preferred_month'),
    preferred_dates: text('preferred_dates'),
    creator_stance: text('creator_stance').$type<VoteStance>(),
    stage_override: text('stage_override').$type<IdeaStage>(),
    compromise_options: jsonb('compromise_options').$type<string[]>().notNull().default(emptyArray),
    ai_rationale: text('ai_rationale'),
    converted_trip_id: uuid('converted_trip_id'),
  },
  (t) => [index('ideas_pod_id_idx').on(t.pod_id)],
);

/** Unique per (idea, voter). Never serialised to a client while the idea is still deciding. */
export const ideaVotes = pgTable(
  'idea_votes',
  {
    id: idColumn(),
    idea_id: uuid('idea_id').notNull(),
    voter_id: uuid('voter_id').notNull(),
    stance: text('stance').$type<VoteStance>().notNull(),
    created_at: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('idea_votes_idea_voter_idx').on(t.idea_id, t.voter_id),
    index('idea_votes_idea_id_idx').on(t.idea_id),
  ],
);

/** One row per pod. Level is NEVER stored -- it is derived from `xp`. */
export const podWorlds = pgTable('pod_worlds', {
  pod_id: uuid('pod_id').primaryKey(),
  xp: integer('xp').notNull().default(0),
  peanuts: integer('peanuts').notNull().default(0),
  updated_at: timestamptz('updated_at').notNull().defaultNow(),
});

export const gardenEntries = pgTable(
  'garden_entries',
  {
    id: idColumn(),
    pod_id: uuid('pod_id').notNull(),
    kind: text('kind').$type<'plant' | 'decor'>().notNull().default('plant'),
    slot: integer('slot').notNull(),
    catalog_id: text('catalog_id').notNull(),
    name: text('name').notNull(),
    emoji: text('emoji').notNull(),
    rarity: text('rarity').$type<'common' | 'special' | 'rare' | 'treasured'>().notNull().default('common'),
    provenance: text('provenance').$type<SeedProvenance>().notNull().default('earned'),
    source_label: text('source_label'),
    memory_id: uuid('memory_id'),
    planted_at: timestamptz('planted_at'),
    grows_seconds: integer('grows_seconds').notNull().default(60),
    water_boost: doublePrecision('water_boost').notNull().default(0),
    watered_at: timestamptz('watered_at'),
    harvested_at: timestamptz('harvested_at'),
  },
  (t) => [index('garden_entries_pod_id_idx').on(t.pod_id)],
);

export const seedInventory = pgTable(
  'seed_inventory',
  {
    id: idColumn(),
    pod_id: uuid('pod_id').notNull(),
    catalog_id: text('catalog_id').notNull(),
    provenance: text('provenance').$type<SeedProvenance>().notNull().default('earned'),
    quantity: integer('quantity').notNull().default(1),
    earned_reason: text('earned_reason'),
  },
  (t) => [
    uniqueIndex('seed_inventory_pod_catalog_idx').on(t.pod_id, t.catalog_id, t.provenance),
    index('seed_inventory_pod_id_idx').on(t.pod_id),
  ],
);

export const memories = pgTable(
  'memories',
  {
    id: idColumn(),
    pod_id: uuid('pod_id').notNull(),
    created_by_id: uuid('created_by_id').notNull(),
    title: text('title').notNull(),
    caption: text('caption'),
    date: date('date', { mode: 'string' }).notNull(),
    location: text('location'),
    latitude: doublePrecision('latitude'),
    longitude: doublePrecision('longitude'),
    tag: text('tag').$type<MemoryTag>().notNull().default('everyday'),
    photo_urls: jsonb('photo_urls').$type<string[]>().notNull().default(emptyArray),
    trip_id: uuid('trip_id'),
    created_at: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('memories_pod_id_idx').on(t.pod_id),
    index('memories_created_by_id_idx').on(t.created_by_id),
  ],
);

export const unlockedCollectibles = pgTable(
  'unlocked_collectibles',
  {
    id: idColumn(),
    pod_id: uuid('pod_id').notNull(),
    catalog_id: text('catalog_id').notNull(),
    earned_by: text('earned_by').notNull(),
    memory_id: uuid('memory_id'),
    unlocked_at: timestamptz('unlocked_at').notNull().defaultNow(),
    displayed: boolean('displayed').notNull().default(false),
  },
  (t) => [
    uniqueIndex('unlocked_collectibles_pod_catalog_idx').on(t.pod_id, t.catalog_id),
    index('unlocked_collectibles_pod_id_idx').on(t.pod_id),
  ],
);

export const bucketListItems = pgTable(
  'bucket_list_items',
  {
    id: idColumn(),
    pod_id: uuid('pod_id').notNull(),
    created_by_id: uuid('created_by_id').notNull(),
    title: text('title').notNull(),
    emoji: text('emoji').notNull().default('✨'),
    country: text('country'),
    latitude: doublePrecision('latitude'),
    longitude: doublePrecision('longitude'),
    state: text('state').$type<'dream' | 'planned' | 'visited'>().notNull().default('dream'),
    trip_id: uuid('trip_id'),
    created_at: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [index('bucket_list_items_pod_id_idx').on(t.pod_id)],
);

export const dateActivities = pgTable(
  'date_activities',
  {
    id: idColumn(),
    pod_id: uuid('pod_id').notNull(),
    created_by_id: uuid('created_by_id').notNull(),
    catalog_id: text('catalog_id'),
    title: text('title').notNull(),
    emoji: text('emoji').notNull().default('💛'),
    is_online: boolean('is_online').notNull().default(false),
    scheduled_at: timestamptz('scheduled_at'),
    participant_ids: jsonb('participant_ids').$type<string[]>().notNull().default(emptyArray),
    status: text('status').$type<'scheduled' | 'completed' | 'cancelled'>().notNull().default('scheduled'),
  },
  (t) => [index('date_activities_pod_id_idx').on(t.pod_id)],
);

/**
 * The pod's shared wallet. SIMULATED: no real money moves. Every JSON
 * response that touches this table is labelled `{ simulated: true, ... }`
 * until a payment provider is wired (see SETUP-EXTERNAL-APIS.md).
 */
export const wallets = pgTable('wallets', {
  pod_id: uuid('pod_id').primaryKey(),
  currency: text('currency').notNull().default('SGD'),
  balance_minor: integer('balance_minor').notNull().default(0),
  updated_at: timestamptz('updated_at').notNull().defaultNow(),
});

export const walletBills = pgTable(
  'wallet_bills',
  {
    id: idColumn(),
    pod_id: uuid('pod_id').notNull(),
    name: text('name').notNull(),
    emoji: text('emoji').notNull().default('🧾'),
    amount_minor: integer('amount_minor').notNull(),
    due_date: date('due_date', { mode: 'string' }).notNull(),
    frequency: text('frequency').$type<'once' | 'weekly' | 'monthly' | 'yearly'>().notNull().default('monthly'),
    paid_by_id: uuid('paid_by_id'),
    split_percent: jsonb('split_percent').$type<Record<string, number>>().notNull().default(emptyObject),
    category: text('category').notNull().default('other'),
    last_paid_at: timestamptz('last_paid_at'),
  },
  (t) => [index('wallet_bills_pod_id_idx').on(t.pod_id)],
);

export const walletGoals = pgTable(
  'wallet_goals',
  {
    id: idColumn(),
    pod_id: uuid('pod_id').notNull(),
    name: text('name').notNull(),
    emoji: text('emoji').notNull().default('🎯'),
    target_minor: integer('target_minor').notNull(),
    saved_minor: integer('saved_minor').notNull().default(0),
    trip_id: uuid('trip_id'),
    created_at: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [index('wallet_goals_pod_id_idx').on(t.pod_id)],
);

/** Append-only ledger. `wallets.balance_minor` is a cached sum of these rows. */
export const walletTransactions = pgTable(
  'wallet_transactions',
  {
    id: idColumn(),
    pod_id: uuid('pod_id').notNull(),
    actor_id: uuid('actor_id'),
    kind: text('kind').$type<WalletTransactionKind>().notNull(),
    amount_minor: integer('amount_minor').notNull(),
    description: text('description').notNull(),
    bill_id: uuid('bill_id'),
    goal_id: uuid('goal_id'),
    trip_id: uuid('trip_id'),
    created_at: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [index('wallet_transactions_pod_id_idx').on(t.pod_id)],
);

export const rewardRedemptions = pgTable(
  'reward_redemptions',
  {
    id: idColumn(),
    pod_id: uuid('pod_id').notNull(),
    redeemed_by_id: uuid('redeemed_by_id').notNull(),
    catalog_id: text('catalog_id').notNull(),
    peanut_cost: integer('peanut_cost').notNull(),
    redeemed_at: timestamptz('redeemed_at').notNull().defaultNow(),
  },
  (t) => [index('reward_redemptions_pod_id_idx').on(t.pod_id)],
);

/** Convenience re-export so `drizzle({ schema })` can discover relations later. */
export const schema = {
  users,
  pods,
  podMemberships,
  podInvites,
  locationPings,
  phoneStatuses,
  favouritePlaces,
  placeAlerts,
  plans,
  messages,
  notifications,
  importantDates,
  trips,
  ideas,
  ideaVotes,
  podWorlds,
  gardenEntries,
  seedInventory,
  memories,
  unlockedCollectibles,
  bucketListItems,
  dateActivities,
  wallets,
  walletBills,
  walletGoals,
  walletTransactions,
  rewardRedemptions,
};

/**
 * MODULE: services/api/src/db/seed
 *
 * PURPOSE
 *   Idempotent demo-pod loader. Upserts four profile rows, one friends pod,
 *   memberships, Singapore places, plans, ideas with votes, two trips, a
 *   simulated wallet, garden plants, memories, and a handful of notifications.
 *
 * INPUTS  : DATABASE_URL (via env.ts); the live schema (callers should have
 *           already run `ensureSchema()`)
 * OUTPUTS : the demo world, keyed by the FIXED uuids below so re-running is
 *           a no-op rather than a duplicate
 *
 * WHY FIXED UUIDS
 *   The security service creates credentials independently. Sharing known
 *   ids lets a local login for `alex@peapod.local` land on the same profile
 *   the seed just wrote, and lets the documentation in
 *   `packages/shared/data/seed/demo.json` name every row.
 *
 * CREDENTIALS
 *   This seeder never writes a password, OTP, or refresh token. Those tables
 *   belong to the security service.
 */

import { db, sqlClient } from './client.js';
import { ensureSchema } from './ensure.js';
import {
  bucketListItems,
  favouritePlaces,
  gardenEntries,
  ideaVotes,
  ideas,
  importantDates,
  locationPings,
  memories,
  notifications,
  plans,
  podMemberships,
  podWorlds,
  pods,
  trips,
  unlockedCollectibles,
  users,
  walletGoals,
  walletTransactions,
  wallets,
} from './schema.js';

/**
 * Fixed identifiers. Changing any of these breaks the documented demo.json.
 *
 * WHY HEX ONLY
 *   Postgres `uuid` rejects any character outside 0-9/a-f. Mnemonic tails
 *   like `m1` or `v1` look like UUIDs but fail at insert with `22P02`. The
 *   last group must also be exactly 12 hex digits.
 */
export const SEED_IDS = {
  alex: '00000000-0000-0000-0000-000000000001',
  sarah: '00000000-0000-0000-0000-000000000002',
  john: '00000000-0000-0000-0000-000000000003',
  emily: '00000000-0000-0000-0000-000000000004',
  pod: '00000000-0000-0000-0000-0000000000aa',
  memberAlex: '00000000-0000-0000-0000-000000000011',
  memberSarah: '00000000-0000-0000-0000-000000000012',
  memberJohn: '00000000-0000-0000-0000-000000000013',
  memberEmily: '00000000-0000-0000-0000-000000000014',
  tripJapan: '00000000-0000-0000-0000-0000000000b1',
  tripUk: '00000000-0000-0000-0000-0000000000b2',
  ideaPenang: '00000000-0000-0000-0000-0000000000c1',
  ideaPottery: '00000000-0000-0000-0000-0000000000c2',
  placeHome: '00000000-0000-0000-0000-0000000000d1',
  placeGardens: '00000000-0000-0000-0000-0000000000d2',
  placeEastCoast: '00000000-0000-0000-0000-0000000000d3',
  placeTiongBahru: '00000000-0000-0000-0000-0000000000d4',
  dateTogether: '00000000-0000-0000-0000-0000000000e1',
  planPicnic: '00000000-0000-0000-0000-0000000000e2',
  memoryJapan: '00000000-0000-0000-0000-0000000000f1',
  memoryMerlion: '00000000-0000-0000-0000-0000000000f2',
  gardenSakura: '00000000-0000-0000-0000-0000000000a1',
  gardenClover: '00000000-0000-0000-0000-0000000000a2',
  walletTx: '00000000-0000-0000-0000-00000000aa01',
  walletGoal: '00000000-0000-0000-0000-00000000aa02',
  votePenangAlex: '00000000-0000-0000-0000-000000000021',
  votePenangSarah: '00000000-0000-0000-0000-000000000022',
  votePenangJohn: '00000000-0000-0000-0000-000000000023',
  votePenangEmily: '00000000-0000-0000-0000-000000000024',
  votePotteryAlex: '00000000-0000-0000-0000-000000000025',
  votePotterySarah: '00000000-0000-0000-0000-000000000026',
  notifWelcome: '00000000-0000-0000-0000-000000000031',
  bucketUk: '00000000-0000-0000-0000-000000000041',
  collectibleTorii: '00000000-0000-0000-0000-000000000051',
  pingAlex: '00000000-0000-0000-0000-000000000061',
  pingSarah: '00000000-0000-0000-0000-000000000062',
} as const;

const ALL_MEMBERS = [SEED_IDS.alex, SEED_IDS.sarah, SEED_IDS.john, SEED_IDS.emily];

const now = () => new Date();

export async function seedDemo(): Promise<void> {
  const stamped = now();

  // --- users (profiles only) ----------------------------------------------
  const userRows = [
    { id: SEED_IDS.alex, email: 'alex@peapod.local', display_name: 'Alex' },
    { id: SEED_IDS.sarah, email: 'sarah@peapod.local', display_name: 'Sarah' },
    { id: SEED_IDS.john, email: 'john@peapod.local', display_name: 'John' },
    { id: SEED_IDS.emily, email: 'emily@peapod.local', display_name: 'Emily' },
  ].map((u) => ({
    ...u,
    created_by_id: u.id,
    created_at: stamped,
    updated_at: stamped,
    avatar_url: null,
    permissions_granted: true,
    role: 'user' as const,
  }));

  for (const row of userRows) {
    await db
      .insert(users)
      .values(row)
      .onConflictDoUpdate({
        target: users.id,
        set: {
          email: row.email,
          display_name: row.display_name,
          permissions_granted: true,
          updated_at: stamped,
        },
      });
  }

  // --- pod ----------------------------------------------------------------
  await db
    .insert(pods)
    .values({
      id: SEED_IDS.pod,
      created_by_id: SEED_IDS.alex,
      created_at: stamped,
      updated_at: stamped,
      name: 'The Pod',
      emoji: '🫘',
      group_type: 'friends',
      trip_history_enabled: true,
    })
    .onConflictDoUpdate({
      target: pods.id,
      set: { name: 'The Pod', emoji: '🫘', group_type: 'friends', updated_at: stamped },
    });

  const memberSpecs: { user_id: string; role: 'admin' | 'member'; id: string }[] = [
    { id: SEED_IDS.memberAlex, user_id: SEED_IDS.alex, role: 'admin' },
    { id: SEED_IDS.memberSarah, user_id: SEED_IDS.sarah, role: 'member' },
    { id: SEED_IDS.memberJohn, user_id: SEED_IDS.john, role: 'member' },
    { id: SEED_IDS.memberEmily, user_id: SEED_IDS.emily, role: 'member' },
  ];
  for (const member of memberSpecs) {
    await db
      .insert(podMemberships)
      .values({
        id: member.id,
        created_by_id: SEED_IDS.alex,
        created_at: stamped,
        updated_at: stamped,
        pod_id: SEED_IDS.pod,
        user_id: member.user_id,
        role: member.role,
      })
      .onConflictDoUpdate({
        target: podMemberships.id,
        set: { role: member.role, updated_at: stamped },
      });
  }

  // --- places around Singapore (1.3521, 103.8198 is the city centroid) ----
  const places = [
    {
      id: SEED_IDS.placeHome,
      name: 'Home',
      address: 'Central Singapore',
      latitude: 1.3521,
      longitude: 103.8198,
      category: 'home' as const,
    },
    {
      id: SEED_IDS.placeGardens,
      name: 'Gardens by the Bay',
      address: '18 Marina Gardens Dr',
      latitude: 1.2816,
      longitude: 103.8636,
      category: 'date' as const,
    },
    {
      id: SEED_IDS.placeEastCoast,
      name: 'East Coast Park',
      address: 'East Coast Park Service Rd',
      latitude: 1.3006,
      longitude: 103.9122,
      category: 'other' as const,
    },
    {
      id: SEED_IDS.placeTiongBahru,
      name: 'Tiong Bahru',
      address: 'Tiong Bahru, Singapore',
      latitude: 1.2868,
      longitude: 103.827,
      category: 'food' as const,
    },
  ];
  for (const place of places) {
    await db
      .insert(favouritePlaces)
      .values({
        ...place,
        created_by_id: SEED_IDS.alex,
        created_at: stamped,
        updated_at: stamped,
        pod_id: SEED_IDS.pod,
        expires_at: null,
      })
      .onConflictDoUpdate({
        target: favouritePlaces.id,
        set: { name: place.name, latitude: place.latitude, longitude: place.longitude, updated_at: stamped },
      });
  }

  // --- important date (pinned count-up: powers milestone job + journey headline)
  await db
    .insert(importantDates)
    .values({
      id: SEED_IDS.dateTogether,
      created_by_id: SEED_IDS.alex,
      created_at: stamped,
      updated_at: stamped,
      title: 'Together since',
      date: '2023-08-17',
      count_up: true,
      recurring: false,
      emoji: '💛',
      pinned: true,
      pod_id: SEED_IDS.pod,
    })
    .onConflictDoUpdate({
      target: importantDates.id,
      set: { pinned: true, count_up: true, updated_at: stamped },
    });

  // --- plan: picnic tomorrow-ish so the reminder job has something to find
  const picnicStart = new Date(stamped.getTime() + 26 * 60 * 60 * 1000);
  await db
    .insert(plans)
    .values({
      id: SEED_IDS.planPicnic,
      created_by_id: SEED_IDS.sarah,
      created_at: stamped,
      updated_at: stamped,
      title: 'Sunset picnic at East Coast',
      description: 'Snacks, a blanket, no agenda.',
      start_time: picnicStart,
      end_time: new Date(picnicStart.getTime() + 3 * 60 * 60 * 1000),
      location_name: 'East Coast Park',
      for_whom: 'pod',
      participant_ids: ALL_MEMBERS,
      repeat_frequency: 'none',
      pod_id: SEED_IDS.pod,
    })
    .onConflictDoUpdate({
      target: plans.id,
      set: { title: 'Sunset picnic at East Coast', updated_at: stamped },
    });

  // --- trips: one completed (Japan), one planned (UK)
  await db
    .insert(trips)
    .values({
      id: SEED_IDS.tripJapan,
      created_by_id: SEED_IDS.alex,
      created_at: stamped,
      updated_at: stamped,
      pod_id: SEED_IDS.pod,
      title: 'Japan — Tokyo, Kyoto, Osaka',
      destination: 'Japan',
      country: 'Japan',
      emoji: '🗾',
      status: 'completed',
      origin: 'manual',
      start_date: '2026-03-10',
      end_date: '2026-03-18',
      flexible_dates: false,
      participant_ids: ALL_MEMBERS,
      cities: ['Tokyo', 'Kyoto', 'Osaka'],
      budget_minor: 480000,
      currency: 'SGD',
      itinerary: [
        {
          day: 1,
          date: '2026-03-10',
          city: 'Tokyo',
          summary: 'Arrive and wander Shibuya.',
          activities: [
            {
              id: 'jp1',
              title: 'Arrive Haneda',
              kind: 'flight',
              start_time: '08:30',
              duration_minutes: 60,
              location: 'HND',
              notes: null,
              cost_minor: 0,
              locked: true,
              emoji: '✈️',
            },
          ],
        },
      ],
      cost_breakdown: [
        { label: 'Flights', amount_minor: 180000, currency: 'SGD', category: 'flights' },
        { label: 'Hotels', amount_minor: 160000, currency: 'SGD', category: 'accommodation' },
      ],
      rating: 5,
      source_idea_id: null,
      completed_at: new Date('2026-03-18T12:00:00.000Z'),
    })
    .onConflictDoUpdate({
      target: trips.id,
      set: { status: 'completed', updated_at: stamped },
    });

  await db
    .insert(trips)
    .values({
      id: SEED_IDS.tripUk,
      created_by_id: SEED_IDS.sarah,
      created_at: stamped,
      updated_at: stamped,
      pod_id: SEED_IDS.pod,
      title: 'UK — London & Edinburgh',
      destination: 'United Kingdom',
      country: 'United Kingdom',
      emoji: '🇬🇧',
      status: 'planned',
      origin: 'decide_together',
      start_date: '2027-03-14',
      end_date: '2027-03-21',
      flexible_dates: false,
      participant_ids: [SEED_IDS.alex, SEED_IDS.sarah],
      cities: ['London', 'Edinburgh'],
      budget_minor: 305000,
      currency: 'SGD',
      itinerary: [],
      cost_breakdown: [
        { label: 'Flights (return, 2 pax)', amount_minor: 140000, currency: 'SGD', category: 'flights' },
        { label: 'Hotels (7 nights)', amount_minor: 105000, currency: 'SGD', category: 'accommodation' },
      ],
      rating: null,
      source_idea_id: null,
      completed_at: null,
    })
    .onConflictDoUpdate({
      target: trips.id,
      set: { status: 'planned', updated_at: stamped },
    });

  // --- ideas + votes ------------------------------------------------------
  await db
    .insert(ideas)
    .values({
      id: SEED_IDS.ideaPenang,
      created_by_id: SEED_IDS.alex,
      created_at: stamped,
      updated_at: stamped,
      pod_id: SEED_IDS.pod,
      title: 'Weekend in Penang',
      emoji: '🍜',
      description: '48 hours of Georgetown food.',
      destination: 'Penang',
      country: 'Malaysia',
      category: 'travel',
      source_type: 'user',
      estimated_cost_minor: 80000,
      duration_days: 3,
      activities: ['Street food crawl', 'Street art walk'],
      preferred_month: null,
      preferred_dates: null,
      creator_stance: 'want',
      stage_override: null,
      compromise_options: [],
      ai_rationale: null,
      converted_trip_id: null,
    })
    .onConflictDoUpdate({
      target: ideas.id,
      set: { title: 'Weekend in Penang', updated_at: stamped },
    });

  await db
    .insert(ideas)
    .values({
      id: SEED_IDS.ideaPottery,
      created_by_id: SEED_IDS.sarah,
      created_at: stamped,
      updated_at: stamped,
      pod_id: SEED_IDS.pod,
      title: 'Pottery class in Joo Chiat',
      emoji: '🏺',
      description: 'The studio you both loved last March has a couples slot.',
      destination: 'Singapore',
      country: 'Singapore',
      category: 'activity',
      source_type: 'user',
      estimated_cost_minor: 9000,
      duration_days: 1,
      activities: ['Couples throwing class'],
      preferred_month: null,
      preferred_dates: null,
      creator_stance: 'want',
      stage_override: null,
      compromise_options: [],
      ai_rationale: null,
      converted_trip_id: null,
    })
    .onConflictDoUpdate({
      target: ideas.id,
      set: { title: 'Pottery class in Joo Chiat', updated_at: stamped },
    });

  const voteRows: { id: string; idea_id: string; voter_id: string; stance: 'want' | 'maybe' | 'no' }[] = [
    { id: SEED_IDS.votePenangAlex, idea_id: SEED_IDS.ideaPenang, voter_id: SEED_IDS.alex, stance: 'want' },
    { id: SEED_IDS.votePenangSarah, idea_id: SEED_IDS.ideaPenang, voter_id: SEED_IDS.sarah, stance: 'want' },
    { id: SEED_IDS.votePenangJohn, idea_id: SEED_IDS.ideaPenang, voter_id: SEED_IDS.john, stance: 'maybe' },
    { id: SEED_IDS.votePenangEmily, idea_id: SEED_IDS.ideaPenang, voter_id: SEED_IDS.emily, stance: 'want' },
    { id: SEED_IDS.votePotteryAlex, idea_id: SEED_IDS.ideaPottery, voter_id: SEED_IDS.alex, stance: 'want' },
    { id: SEED_IDS.votePotterySarah, idea_id: SEED_IDS.ideaPottery, voter_id: SEED_IDS.sarah, stance: 'want' },
  ];
  for (const vote of voteRows) {
    await db
      .insert(ideaVotes)
      .values({ ...vote, created_at: stamped })
      .onConflictDoUpdate({
        target: ideaVotes.id,
        set: { stance: vote.stance },
      });
  }

  // --- world + wallet (simulated) -----------------------------------------
  await db
    .insert(podWorlds)
    .values({ pod_id: SEED_IDS.pod, xp: 520, peanuts: 780, updated_at: stamped })
    .onConflictDoUpdate({
      target: podWorlds.pod_id,
      set: { xp: 520, peanuts: 780, updated_at: stamped },
    });

  await db
    .insert(wallets)
    .values({ pod_id: SEED_IDS.pod, currency: 'SGD', balance_minor: 248500, updated_at: stamped })
    .onConflictDoUpdate({
      target: wallets.pod_id,
      set: { balance_minor: 248500, updated_at: stamped },
    });

  await db
    .insert(walletTransactions)
    .values({
      id: SEED_IDS.walletTx,
      pod_id: SEED_IDS.pod,
      actor_id: SEED_IDS.alex,
      kind: 'deposit',
      amount_minor: 248500,
      description: 'Opening simulated balance',
      bill_id: null,
      goal_id: null,
      trip_id: null,
      created_at: stamped,
    })
    .onConflictDoUpdate({
      target: walletTransactions.id,
      set: { amount_minor: 248500, description: 'Opening simulated balance' },
    });

  await db
    .insert(walletGoals)
    .values({
      id: SEED_IDS.walletGoal,
      pod_id: SEED_IDS.pod,
      name: 'UK trip fund',
      emoji: '🇬🇧',
      target_minor: 305000,
      saved_minor: 120000,
      trip_id: SEED_IDS.tripUk,
      created_at: stamped,
    })
    .onConflictDoUpdate({
      target: walletGoals.id,
      set: { saved_minor: 120000 },
    });

  // --- garden -------------------------------------------------------------
  await db
    .insert(gardenEntries)
    .values({
      id: SEED_IDS.gardenSakura,
      pod_id: SEED_IDS.pod,
      kind: 'plant',
      slot: 0,
      catalog_id: 'earn_sakura',
      name: 'Sakura Tree',
      emoji: '🌸',
      rarity: 'special',
      provenance: 'earned',
      source_label: 'From "Japan — Tokyo, Kyoto, Osaka"',
      memory_id: SEED_IDS.memoryJapan,
      planted_at: null, // pre-seeded living record: counts as fully grown
      grows_seconds: 110,
      water_boost: 0,
      watered_at: null,
      harvested_at: null,
    })
    .onConflictDoUpdate({
      target: gardenEntries.id,
      set: { name: 'Sakura Tree', catalog_id: 'earn_sakura' },
    });

  await db
    .insert(gardenEntries)
    .values({
      id: SEED_IDS.gardenClover,
      pod_id: SEED_IDS.pod,
      kind: 'plant',
      slot: 1,
      catalog_id: 'earn_companion',
      name: 'Companion Sprout',
      emoji: '🌱',
      rarity: 'common',
      provenance: 'earned',
      source_label: 'From everyday time together',
      memory_id: null,
      planted_at: new Date(stamped.getTime() - 30 * 60 * 1000),
      grows_seconds: 45,
      water_boost: 0.1,
      watered_at: stamped,
      harvested_at: null,
    })
    .onConflictDoUpdate({
      target: gardenEntries.id,
      set: { water_boost: 0.1 },
    });

  // --- memories + collectibles + bucket list ------------------------------
  await db
    .insert(memories)
    .values({
      id: SEED_IDS.memoryJapan,
      pod_id: SEED_IDS.pod,
      created_by_id: SEED_IDS.alex,
      title: 'Our first trip to Japan',
      caption: 'Cherry blossoms in Kyoto, ramen in Osaka.',
      date: '2023-11-04',
      location: 'Kyoto, Japan',
      latitude: 35.0116,
      longitude: 135.7681,
      tag: 'travel',
      photo_urls: ['https://images.unsplash.com/photo-1493976040374-85c8e12f0c0e?auto=format&fit=crop&w=600&q=70'],
      trip_id: SEED_IDS.tripJapan,
      created_at: stamped,
    })
    .onConflictDoUpdate({
      target: memories.id,
      set: { title: 'Our first trip to Japan' },
    });

  await db
    .insert(memories)
    .values({
      id: SEED_IDS.memoryMerlion,
      pod_id: SEED_IDS.pod,
      created_by_id: SEED_IDS.sarah,
      title: 'Our Merlion Visit',
      caption: 'Tourists in our own city for an afternoon.',
      date: '2026-08-17',
      location: 'Marina Bay, Singapore',
      latitude: 1.2868,
      longitude: 103.8545,
      tag: 'place',
      photo_urls: ['https://images.unsplash.com/photo-1565967511849-76a60a516170?auto=format&fit=crop&w=600&q=70'],
      trip_id: null,
      created_at: stamped,
    })
    .onConflictDoUpdate({
      target: memories.id,
      set: { title: 'Our Merlion Visit' },
    });

  await db
    .insert(unlockedCollectibles)
    .values({
      id: SEED_IDS.collectibleTorii,
      pod_id: SEED_IDS.pod,
      catalog_id: 'jp_torii',
      earned_by: 'Completed the Japan trip',
      memory_id: SEED_IDS.memoryJapan,
      unlocked_at: stamped,
      displayed: true,
    })
    .onConflictDoUpdate({
      target: unlockedCollectibles.id,
      set: { displayed: true },
    });

  await db
    .insert(bucketListItems)
    .values({
      id: SEED_IDS.bucketUk,
      pod_id: SEED_IDS.pod,
      created_by_id: SEED_IDS.sarah,
      title: 'Visit the UK',
      emoji: '🇬🇧',
      country: 'United Kingdom',
      latitude: 51.5074,
      longitude: -0.1278,
      state: 'planned',
      trip_id: SEED_IDS.tripUk,
      created_at: stamped,
    })
    .onConflictDoUpdate({
      target: bucketListItems.id,
      set: { state: 'planned', trip_id: SEED_IDS.tripUk },
    });

  // --- notifications + live presence pings --------------------------------
  await db
    .insert(notifications)
    .values({
      id: SEED_IDS.notifWelcome,
      created_by_id: SEED_IDS.alex,
      created_at: stamped,
      updated_at: stamped,
      title: 'Welcome to The Pod',
      body: 'Alex, Sarah, John, and Emily are sharing this space.',
      emoji: '🫘',
      is_read: false,
      recipient_id: SEED_IDS.sarah,
      type: 'info',
      pod_id: SEED_IDS.pod,
    })
    .onConflictDoUpdate({
      target: notifications.id,
      set: { title: 'Welcome to The Pod', updated_at: stamped },
    });

  // Alex is online (ping just now); Sarah's last ping is 20 minutes old.
  await db
    .insert(locationPings)
    .values({
      id: SEED_IDS.pingAlex,
      created_by_id: SEED_IDS.alex,
      created_at: stamped,
      updated_at: stamped,
      latitude: 1.3521,
      longitude: 103.8198,
      speed: 0,
      accuracy: 12,
      heading: 0,
      is_driving: false,
      pod_id: SEED_IDS.pod,
    })
    .onConflictDoUpdate({
      target: locationPings.id,
      set: { created_at: stamped, updated_at: stamped, latitude: 1.3521, longitude: 103.8198 },
    });

  await db
    .insert(locationPings)
    .values({
      id: SEED_IDS.pingSarah,
      created_by_id: SEED_IDS.sarah,
      created_at: new Date(stamped.getTime() - 20 * 60 * 1000),
      updated_at: stamped,
      latitude: 1.2816,
      longitude: 103.8636,
      speed: 0,
      accuracy: 18,
      heading: 90,
      is_driving: false,
      pod_id: SEED_IDS.pod,
    })
    .onConflictDoUpdate({
      target: locationPings.id,
      set: { latitude: 1.2816, longitude: 103.8636 },
    });

}

async function main(): Promise<void> {
  await ensureSchema();
  await seedDemo();
  console.log('Demo pod seeded (alex / sarah / john / emily @ The Pod).');
  await sqlClient.end({ timeout: 5 });
}

// Only run when invoked as the CLI (`tsx src/db/seed.ts`), not when imported.
const invokedDirectly = process.argv[1]?.includes('seed');
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
    void sqlClient.end({ timeout: 5 });
  });
}

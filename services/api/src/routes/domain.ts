/**
 * MODULE: services/api/src/routes/domain
 *
 * PURPOSE
 *   Compact but real CRUD for every pod-scoped record that is not a
 *   privileged pod mutation. Each handler: authorize membership, insert or
 *   update, publish a realtime event. Owner-or-admin is required for
 *   updates and deletes (see `src/policy/rls.ts`).
 *
 * WHY ONE FILE
 *   The handlers are the same shape twenty times. Splitting them into twenty
 *   files would hide the pattern; keeping them together makes a missing
 *   `publish()` or a skipped membership check obvious in review.
 */

import { and, asc, desc, eq, gte, isNull, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { evaluateDecision } from '@peapod/shared';
import { db } from '../db/client.js';
import {
  bucketListItems,
  dateActivities,
  favouritePlaces,
  gardenEntries,
  ideaVotes,
  ideas,
  importantDates,
  locationPings,
  memories,
  messages,
  notifications,
  phoneStatuses,
  placeAlerts,
  plans,
  podWorlds,
  rewardRedemptions,
  seedInventory,
  trips,
  unlockedCollectibles,
  users,
  walletBills,
  walletGoals,
  walletTransactions,
  wallets,
} from '../db/schema.js';
import { badRequest, notFound } from '../http.js';
import {
  listMemberIds,
  requireNotificationAccess,
  requireOwnerOrAdmin,
  requirePodMemberOrOperator,
} from '../policy/rls.js';
import { publish } from '../realtime/hub.js';
import { parseBody, stamp, touch, uuidParam } from './helpers.js';

function podIdOf(request: FastifyRequest): string {
  return uuidParam(request, 'podId');
}

export async function registerDomain(app: FastifyInstance): Promise<void> {
  // -----------------------------------------------------------------------
  // Places
  // -----------------------------------------------------------------------
  app.get('/pods/:podId/places', async (request) => {
    const podId = podIdOf(request);
    await requirePodMemberOrOperator(request.user, podId);
    return db.select().from(favouritePlaces).where(eq(favouritePlaces.pod_id, podId));
  });

  app.post('/pods/:podId/places', async (request, reply) => {
    const podId = podIdOf(request);
    await requirePodMemberOrOperator(request.user, podId);
    const body = parseBody(
      z.object({
        name: z.string().min(1),
        address: z.string().nullable().optional(),
        latitude: z.number(),
        longitude: z.number(),
        category: z.enum(['home', 'work', 'food', 'date', 'travel', 'other']).optional(),
        expires_at: z.string().datetime().nullable().optional(),
      }),
      request.body,
    );
    const [row] = await db
      .insert(favouritePlaces)
      .values({
        ...stamp(request.user),
        ...body,
        expires_at: body.expires_at ? new Date(body.expires_at) : null,
        pod_id: podId,
      })
      .returning();
    publish(podId, { entity: 'favourite_places', action: 'insert', row });
    reply.code(201);
    return row;
  });

  app.patch('/pods/:podId/places/:id', async (request) => {
    const podId = podIdOf(request);
    const id = uuidParam(request, 'id');
    const [existing] = await db.select().from(favouritePlaces).where(eq(favouritePlaces.id, id)).limit(1);
    if (!existing) throw notFound('Place not found');
    await requireOwnerOrAdmin(request.user, podId, existing);
    const body = parseBody(z.object({
      name: z.string().min(1).optional(),
      address: z.string().nullable().optional(),
      latitude: z.number().optional(),
      longitude: z.number().optional(),
      category: z.enum(['home', 'work', 'food', 'date', 'travel', 'other']).optional(),
      expires_at: z.string().datetime().nullable().optional(),
    }), request.body);
    const [row] = await db
      .update(favouritePlaces)
      .set({
        ...body,
        expires_at: body.expires_at === undefined ? undefined : body.expires_at ? new Date(body.expires_at) : null,
        ...touch(),
      })
      .where(eq(favouritePlaces.id, id))
      .returning();
    publish(podId, { entity: 'favourite_places', action: 'update', row });
    return row;
  });

  app.delete('/pods/:podId/places/:id', async (request, reply) => {
    const podId = podIdOf(request);
    const id = uuidParam(request, 'id');
    const [existing] = await db.select().from(favouritePlaces).where(eq(favouritePlaces.id, id)).limit(1);
    if (!existing) throw notFound('Place not found');
    await requireOwnerOrAdmin(request.user, podId, existing);
    await db.delete(favouritePlaces).where(eq(favouritePlaces.id, id));
    publish(podId, { entity: 'favourite_places', action: 'delete', row: existing });
    reply.code(204);
    return null;
  });

  app.get('/pods/:podId/place-alerts', async (request) => {
    const podId = podIdOf(request);
    await requirePodMemberOrOperator(request.user, podId);
    return db.select().from(placeAlerts).where(eq(placeAlerts.pod_id, podId)).orderBy(desc(placeAlerts.created_at));
  });

  app.post('/pods/:podId/place-alerts', async (request, reply) => {
    const podId = podIdOf(request);
    await requirePodMemberOrOperator(request.user, podId);
    const body = parseBody(
      z.object({
        place_name: z.string().min(1),
        event: z.enum(['arrived', 'left']),
        latitude: z.number().nullable().optional(),
        longitude: z.number().nullable().optional(),
      }),
      request.body,
    );
    const [row] = await db.insert(placeAlerts).values({ ...stamp(request.user), ...body, pod_id: podId }).returning();
    publish(podId, { entity: 'place_alerts', action: 'insert', row });
    reply.code(201);
    return row;
  });

  // -----------------------------------------------------------------------
  // Plans + important dates
  // -----------------------------------------------------------------------
  app.get('/pods/:podId/plans', async (request) => {
    const podId = podIdOf(request);
    await requirePodMemberOrOperator(request.user, podId);
    return db.select().from(plans).where(eq(plans.pod_id, podId));
  });

  app.post('/pods/:podId/plans', async (request, reply) => {
    const podId = podIdOf(request);
    await requirePodMemberOrOperator(request.user, podId);
    const body = parseBody(
      z.object({
        title: z.string().min(1),
        description: z.string().nullable().optional(),
        start_time: z.string(),
        end_time: z.string().nullable().optional(),
        location_name: z.string().nullable().optional(),
        for_whom: z.enum(['self', 'specific', 'pod']).optional(),
        participant_ids: z.array(z.string().uuid()).optional(),
        repeat_frequency: z.enum(['none', 'daily', 'weekly', 'monthly']).optional(),
      }),
      request.body,
    );
    const [row] = await db
      .insert(plans)
      .values({
        ...stamp(request.user),
        title: body.title,
        description: body.description ?? null,
        start_time: new Date(body.start_time),
        end_time: body.end_time ? new Date(body.end_time) : null,
        location_name: body.location_name ?? null,
        for_whom: body.for_whom ?? 'pod',
        participant_ids: body.participant_ids ?? [],
        repeat_frequency: body.repeat_frequency ?? 'none',
        pod_id: podId,
      })
      .returning();
    publish(podId, { entity: 'plans', action: 'insert', row });
    reply.code(201);
    return row;
  });

  app.patch('/pods/:podId/plans/:id', async (request) => {
    const podId = podIdOf(request);
    const id = uuidParam(request, 'id');
    const [existing] = await db.select().from(plans).where(eq(plans.id, id)).limit(1);
    if (!existing) throw notFound('Plan not found');
    await requireOwnerOrAdmin(request.user, podId, existing);
    const body = parseBody(
      z.object({
        title: z.string().min(1).optional(),
        description: z.string().nullable().optional(),
        start_time: z.string().optional(),
        end_time: z.string().nullable().optional(),
        location_name: z.string().nullable().optional(),
        for_whom: z.enum(['self', 'specific', 'pod']).optional(),
        participant_ids: z.array(z.string().uuid()).optional(),
        repeat_frequency: z.enum(['none', 'daily', 'weekly', 'monthly']).optional(),
      }),
      request.body,
    );
    const [row] = await db
      .update(plans)
      .set({
        ...body,
        start_time: body.start_time ? new Date(body.start_time) : undefined,
        end_time: body.end_time === undefined ? undefined : body.end_time ? new Date(body.end_time) : null,
        ...touch(),
      })
      .where(eq(plans.id, id))
      .returning();
    publish(podId, { entity: 'plans', action: 'update', row });
    return row;
  });

  app.delete('/pods/:podId/plans/:id', async (request, reply) => {
    const podId = podIdOf(request);
    const id = uuidParam(request, 'id');
    const [existing] = await db.select().from(plans).where(eq(plans.id, id)).limit(1);
    if (!existing) throw notFound('Plan not found');
    await requireOwnerOrAdmin(request.user, podId, existing);
    await db.delete(plans).where(eq(plans.id, id));
    publish(podId, { entity: 'plans', action: 'delete', row: existing });
    reply.code(204);
    return null;
  });

  app.get('/pods/:podId/important-dates', async (request) => {
    const podId = podIdOf(request);
    await requirePodMemberOrOperator(request.user, podId);
    return db.select().from(importantDates).where(eq(importantDates.pod_id, podId));
  });

  app.post('/pods/:podId/important-dates', async (request, reply) => {
    const podId = podIdOf(request);
    await requirePodMemberOrOperator(request.user, podId);
    const body = parseBody(
      z.object({
        title: z.string().min(1),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        count_up: z.boolean().optional(),
        recurring: z.boolean().optional(),
        emoji: z.string().optional(),
        pinned: z.boolean().optional(),
      }),
      request.body,
    );
    const [row] = await db.insert(importantDates).values({ ...stamp(request.user), ...body, pod_id: podId }).returning();
    publish(podId, { entity: 'important_dates', action: 'insert', row });
    reply.code(201);
    return row;
  });

  app.patch('/pods/:podId/important-dates/:id', async (request) => {
    const podId = podIdOf(request);
    const id = uuidParam(request, 'id');
    const [existing] = await db.select().from(importantDates).where(eq(importantDates.id, id)).limit(1);
    if (!existing) throw notFound('Date not found');
    await requireOwnerOrAdmin(request.user, podId, existing);
    const body = parseBody(
      z.object({
        title: z.string().min(1).optional(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        count_up: z.boolean().optional(),
        recurring: z.boolean().optional(),
        emoji: z.string().optional(),
        pinned: z.boolean().optional(),
      }),
      request.body,
    );
    const [row] = await db.update(importantDates).set({ ...body, ...touch() }).where(eq(importantDates.id, id)).returning();
    publish(podId, { entity: 'important_dates', action: 'update', row });
    return row;
  });

  app.delete('/pods/:podId/important-dates/:id', async (request, reply) => {
    const podId = podIdOf(request);
    const id = uuidParam(request, 'id');
    const [existing] = await db.select().from(importantDates).where(eq(importantDates.id, id)).limit(1);
    if (!existing) throw notFound('Date not found');
    await requireOwnerOrAdmin(request.user, podId, existing);
    await db.delete(importantDates).where(eq(importantDates.id, id));
    publish(podId, { entity: 'important_dates', action: 'delete', row: existing });
    reply.code(204);
    return null;
  });

  // -----------------------------------------------------------------------
  // Messages + notifications
  // -----------------------------------------------------------------------
  app.get('/direct-messages/:userId', async (request) => {
    const otherUserId = uuidParam(request, 'userId');
    if (otherUserId === request.user.id) throw badRequest('You cannot message yourself');
    const [other] = await db.select({ id: users.id }).from(users).where(eq(users.id, otherUserId)).limit(1);
    if (!other) throw notFound('User not found');

    return db
      .select()
      .from(messages)
      .where(
        and(
          isNull(messages.pod_id),
          or(
            and(
              eq(messages.created_by_id, request.user.id),
              eq(messages.recipient_id, otherUserId),
            ),
            and(
              eq(messages.created_by_id, otherUserId),
              eq(messages.recipient_id, request.user.id),
            ),
          ),
        ),
      )
      .orderBy(asc(messages.created_at));
  });

  app.post('/direct-messages/:userId', async (request, reply) => {
    const otherUserId = uuidParam(request, 'userId');
    if (otherUserId === request.user.id) throw badRequest('You cannot message yourself');
    const [other] = await db.select({ id: users.id }).from(users).where(eq(users.id, otherUserId)).limit(1);
    if (!other) throw notFound('User not found');
    const { text } = parseBody(
      z.object({ text: z.string().trim().min(1).max(2000) }),
      request.body,
    );
    const [row] = await db
      .insert(messages)
      .values({
        ...stamp(request.user),
        text,
        recipient_id: otherUserId,
        pod_id: null,
      })
      .returning();
    reply.code(201);
    return row;
  });

  app.get('/pods/:podId/messages', async (request) => {
    const podId = podIdOf(request);
    await requirePodMemberOrOperator(request.user, podId);
    return db.select().from(messages).where(eq(messages.pod_id, podId)).orderBy(desc(messages.created_at));
  });

  app.post('/pods/:podId/messages', async (request, reply) => {
    const podId = podIdOf(request);
    await requirePodMemberOrOperator(request.user, podId);
    const body = parseBody(
      z.object({
        text: z.string().trim().min(1).max(2000),
        recipient_id: z.string().uuid().nullable().optional(),
      }),
      request.body,
    );
    const [row] = await db
      .insert(messages)
      .values({ ...stamp(request.user), text: body.text, recipient_id: body.recipient_id ?? null, pod_id: podId })
      .returning();
    publish(podId, { entity: 'messages', action: 'insert', row });
    reply.code(201);
    return row;
  });

  app.delete('/pods/:podId/messages/:id', async (request, reply) => {
    const podId = podIdOf(request);
    const id = uuidParam(request, 'id');
    const [existing] = await db.select().from(messages).where(eq(messages.id, id)).limit(1);
    if (!existing) throw notFound('Message not found');
    await requireOwnerOrAdmin(request.user, podId, existing);
    await db.delete(messages).where(eq(messages.id, id));
    publish(podId, { entity: 'messages', action: 'delete', row: existing });
    reply.code(204);
    return null;
  });

  /**
   * A nudge is a lightweight, pod-scoped notification to one member. The
   * recipient must still belong to the pod; accepting an arbitrary user id
   * here would leak cross-pod social actions.
   */
  app.post('/pods/:podId/nudges', async (request, reply) => {
    const podId = podIdOf(request);
    await requirePodMemberOrOperator(request.user, podId);
    const { recipient_id } = parseBody(
      z.object({ recipient_id: z.string().uuid() }),
      request.body,
    );
    const memberIds = await listMemberIds(podId);
    if (!memberIds.includes(recipient_id)) throw notFound('Pod member not found');
    if (recipient_id === request.user.id) throw badRequest('You cannot nudge yourself');

    const [sender] = await db
      .select({ display_name: users.display_name })
      .from(users)
      .where(eq(users.id, request.user.id))
      .limit(1);
    const [row] = await db
      .insert(notifications)
      .values({
        ...stamp(request.user),
        title: `${sender?.display_name ?? 'A pea'} nudged you`,
        body: 'Open Peapod to see what your pod is up to.',
        emoji: '🎉',
        is_read: false,
        recipient_id,
        type: 'nudge',
        pod_id: podId,
      })
      .returning();
    publish(podId, { entity: 'notifications', action: 'insert', row });
    reply.code(201);
    return row;
  });

  app.get('/notifications', async (request) => {
    return db
      .select()
      .from(notifications)
      .where(eq(notifications.recipient_id, request.user.id))
      .orderBy(desc(notifications.created_at));
  });

  app.patch('/notifications/:id', async (request) => {
    const id = uuidParam(request, 'id');
    const [existing] = await db.select().from(notifications).where(eq(notifications.id, id)).limit(1);
    if (!existing) throw notFound('Notification not found');
    await requireNotificationAccess(request.user, existing);
    const body = parseBody(z.object({ is_read: z.boolean().optional() }), request.body);
    const [row] = await db.update(notifications).set({ ...body, ...touch() }).where(eq(notifications.id, id)).returning();
    if (existing.pod_id) publish(existing.pod_id, { entity: 'notifications', action: 'update', row });
    return row;
  });

  app.delete('/notifications/:id', async (request, reply) => {
    const id = uuidParam(request, 'id');
    const [existing] = await db.select().from(notifications).where(eq(notifications.id, id)).limit(1);
    if (!existing) throw notFound('Notification not found');
    await requireNotificationAccess(request.user, existing);
    await db.delete(notifications).where(eq(notifications.id, id));
    if (existing.pod_id) publish(existing.pod_id, { entity: 'notifications', action: 'delete', row: existing });
    reply.code(204);
    return null;
  });

  // -----------------------------------------------------------------------
  // Location pings + phone status
  // -----------------------------------------------------------------------
  app.post('/location/pings', async (request, reply) => {
    const body = parseBody(
      z.object({
        latitude: z.number(),
        longitude: z.number(),
        speed: z.number().optional(),
        accuracy: z.number().optional(),
        heading: z.number().optional(),
        is_driving: z.boolean().optional(),
        pod_id: z.string().uuid().nullable().optional(),
      }),
      request.body,
    );
    if (body.pod_id) await requirePodMemberOrOperator(request.user, body.pod_id);
    const [row] = await db
      .insert(locationPings)
      .values({
        ...stamp(request.user),
        latitude: body.latitude,
        longitude: body.longitude,
        speed: body.speed ?? 0,
        accuracy: body.accuracy ?? 0,
        heading: body.heading ?? 0,
        is_driving: body.is_driving ?? false,
        pod_id: body.pod_id ?? null,
      })
      .returning();
    if (body.pod_id) publish(body.pod_id, { entity: 'location_pings', action: 'insert', row });
    reply.code(201);
    return row;
  });

  app.get('/pods/:podId/pings', async (request) => {
    const podId = podIdOf(request);
    await requirePodMemberOrOperator(request.user, podId);
    return db.select().from(locationPings).where(eq(locationPings.pod_id, podId)).orderBy(desc(locationPings.created_at)).limit(500);
  });

  app.post('/pods/:podId/phone-status', async (request, reply) => {
    const podId = podIdOf(request);
    await requirePodMemberOrOperator(request.user, podId);
    const body = parseBody(
      z.object({
        battery_level: z.number().int().min(0).max(100),
        is_charging: z.boolean().optional(),
        connection_type: z.string().optional(),
        signal_bars: z.number().int().min(0).max(4).optional(),
        battery_supported: z.boolean().optional(),
        connection_supported: z.boolean().optional(),
      }),
      request.body,
    );
    const [row] = await db.insert(phoneStatuses).values({ ...stamp(request.user), ...body, pod_id: podId }).returning();
    publish(podId, { entity: 'phone_statuses', action: 'insert', row });
    reply.code(201);
    return row;
  });

  app.get('/pods/:podId/phone-status', async (request) => {
    const podId = podIdOf(request);
    await requirePodMemberOrOperator(request.user, podId);
    return db.select().from(phoneStatuses).where(eq(phoneStatuses.pod_id, podId)).orderBy(desc(phoneStatuses.created_at));
  });

  // -----------------------------------------------------------------------
  // Trips
  // -----------------------------------------------------------------------
  app.get('/pods/:podId/trips', async (request) => {
    const podId = podIdOf(request);
    await requirePodMemberOrOperator(request.user, podId);
    return db.select().from(trips).where(eq(trips.pod_id, podId));
  });

  app.post('/pods/:podId/trips', async (request, reply) => {
    const podId = podIdOf(request);
    await requirePodMemberOrOperator(request.user, podId);
    const body = parseBody(
      z.object({
        title: z.string().min(1),
        destination: z.string().min(1),
        country: z.string().nullable().optional(),
        emoji: z.string().optional(),
        status: z.enum(['suggestion', 'draft', 'planned', 'booked', 'completed']).optional(),
        origin: z.enum(['manual', 'peapod_suggested', 'decide_together', 'bucket_list']).optional(),
        start_date: z.string().nullable().optional(),
        end_date: z.string().nullable().optional(),
        flexible_dates: z.boolean().optional(),
        participant_ids: z.array(z.string().uuid()).optional(),
        cities: z.array(z.string()).optional(),
        budget_minor: z.number().int().nullable().optional(),
        currency: z.string().optional(),
        itinerary: z.array(z.unknown()).optional(),
        cost_breakdown: z.array(z.unknown()).optional(),
        rating: z.number().int().min(1).max(5).nullable().optional(),
        source_idea_id: z.string().uuid().nullable().optional(),
      }),
      request.body,
    );
    const [row] = await db
      .insert(trips)
      .values({
        ...stamp(request.user),
        pod_id: podId,
        title: body.title,
        destination: body.destination,
        country: body.country ?? null,
        emoji: body.emoji ?? '✈️',
        status: body.status ?? 'draft',
        origin: body.origin ?? 'manual',
        start_date: body.start_date ?? null,
        end_date: body.end_date ?? null,
        flexible_dates: body.flexible_dates ?? false,
        participant_ids: body.participant_ids ?? [request.user.id],
        cities: body.cities ?? [],
        budget_minor: body.budget_minor ?? null,
        currency: body.currency ?? 'SGD',
        itinerary: (body.itinerary ?? []) as never,
        cost_breakdown: (body.cost_breakdown ?? []) as never,
        rating: body.rating ?? null,
        source_idea_id: body.source_idea_id ?? null,
      })
      .returning();
    publish(podId, { entity: 'trips', action: 'insert', row });
    reply.code(201);
    return row;
  });

  app.patch('/pods/:podId/trips/:id', async (request) => {
    const podId = podIdOf(request);
    const id = uuidParam(request, 'id');
    const [existing] = await db.select().from(trips).where(eq(trips.id, id)).limit(1);
    if (!existing) throw notFound('Trip not found');
    await requireOwnerOrAdmin(request.user, podId, existing);
    const body = parseBody(z.record(z.unknown()), request.body);
    const patch: Record<string, unknown> = { ...body, ...touch() };
    if (body['status'] === 'completed' && !existing.completed_at) patch.completed_at = new Date();
    const [row] = await db.update(trips).set(patch as never).where(eq(trips.id, id)).returning();
    publish(podId, { entity: 'trips', action: 'update', row });
    return row;
  });

  app.delete('/pods/:podId/trips/:id', async (request, reply) => {
    const podId = podIdOf(request);
    const id = uuidParam(request, 'id');
    const [existing] = await db.select().from(trips).where(eq(trips.id, id)).limit(1);
    if (!existing) throw notFound('Trip not found');
    await requireOwnerOrAdmin(request.user, podId, existing);
    await db.delete(trips).where(eq(trips.id, id));
    publish(podId, { entity: 'trips', action: 'delete', row: existing });
    reply.code(204);
    return null;
  });

  // -----------------------------------------------------------------------
  // Ideas + votes. Hidden-vote rule: strip stances while deciding.
  // everyone_in converts the idea into a planned trip with origin decide_together.
  // -----------------------------------------------------------------------
  app.get('/pods/:podId/ideas', async (request) => {
    const podId = podIdOf(request);
    await requirePodMemberOrOperator(request.user, podId);
    const ideaRows = await db.select().from(ideas).where(eq(ideas.pod_id, podId));
    const memberIds = await listMemberIds(podId);
    const allVotes = await db.select().from(ideaVotes);
    return ideaRows.map((idea) => serializeIdea(idea, allVotes.filter((v) => v.idea_id === idea.id), memberIds));
  });

  app.post('/pods/:podId/ideas', async (request, reply) => {
    const podId = podIdOf(request);
    await requirePodMemberOrOperator(request.user, podId);
    const body = parseBody(
      z.object({
        title: z.string().min(1),
        emoji: z.string().optional(),
        description: z.string().nullable().optional(),
        destination: z.string().nullable().optional(),
        country: z.string().nullable().optional(),
        category: z.enum(['travel', 'food', 'activity', 'nature', 'culture', 'adventure', 'themepark', 'shopping']).optional(),
        source_type: z.enum(['user', 'ai']).optional(),
        estimated_cost_minor: z.number().int().nullable().optional(),
        duration_days: z.number().int().nullable().optional(),
        activities: z.array(z.string()).optional(),
        preferred_month: z.string().nullable().optional(),
        preferred_dates: z.string().nullable().optional(),
        creator_stance: z.enum(['want', 'maybe', 'no']).nullable().optional(),
        compromise_options: z.array(z.string()).optional(),
      }),
      request.body,
    );
    const [idea] = await db
      .insert(ideas)
      .values({
        ...stamp(request.user),
        pod_id: podId,
        title: body.title,
        emoji: body.emoji ?? '💡',
        description: body.description ?? null,
        destination: body.destination ?? null,
        country: body.country ?? null,
        category: body.category ?? 'activity',
        source_type: body.source_type ?? 'user',
        estimated_cost_minor: body.estimated_cost_minor ?? null,
        duration_days: body.duration_days ?? null,
        activities: body.activities ?? [],
        preferred_month: body.preferred_month ?? null,
        preferred_dates: body.preferred_dates ?? null,
        creator_stance: body.creator_stance ?? 'want',
        compromise_options: body.compromise_options ?? [],
      })
      .returning();
    if (!idea) throw badRequest('Failed to create idea');
    // Creator pre-votes so they never swipe their own idea.
    const stance = body.creator_stance ?? 'want';
    await db.insert(ideaVotes).values({ idea_id: idea.id, voter_id: request.user.id, stance });
    publish(podId, { entity: 'ideas', action: 'insert', row: idea });
    reply.code(201);
    const memberIds = await listMemberIds(podId);
    return serializeIdea(idea, [{ voter_id: request.user.id, stance }], memberIds);
  });

  app.post('/pods/:podId/ideas/:id/votes', async (request) => {
    const podId = podIdOf(request);
    await requirePodMemberOrOperator(request.user, podId);
    const id = uuidParam(request, 'id');
    const { stance } = parseBody(z.object({ stance: z.enum(['want', 'maybe', 'no']) }), request.body);
    const [idea] = await db.select().from(ideas).where(eq(ideas.id, id)).limit(1);
    if (!idea || idea.pod_id !== podId) throw notFound('Idea not found');

    const existing = await db
      .select()
      .from(ideaVotes)
      .where(and(eq(ideaVotes.idea_id, id), eq(ideaVotes.voter_id, request.user.id)))
      .limit(1);
    if (existing[0]) {
      await db.update(ideaVotes).set({ stance }).where(eq(ideaVotes.id, existing[0].id));
    } else {
      await db.insert(ideaVotes).values({ idea_id: id, voter_id: request.user.id, stance });
    }

    const votes = await db.select().from(ideaVotes).where(eq(ideaVotes.idea_id, id));
    const memberIds = await listMemberIds(podId);
    const evaluation = evaluateDecision({
      member_ids: memberIds,
      votes: votes.map((v) => ({ voter_id: v.voter_id, stance: v.stance })),
      creator_stance: idea.creator_stance,
      source_type: idea.source_type,
      stage_override: idea.stage_override,
    });

    // Unanimous enthusiasm becomes a real planned trip. Origin is
    // decide_together so the trip card can badge where it came from.
    if (evaluation.outcome === 'everyone_in' && !idea.converted_trip_id) {
      const [trip] = await db
        .insert(trips)
        .values({
          ...stamp(request.user),
          pod_id: podId,
          title: idea.title,
          destination: idea.destination ?? idea.title,
          country: idea.country,
          emoji: idea.emoji,
          status: 'planned',
          origin: 'decide_together',
          participant_ids: memberIds,
          cities: [],
          currency: 'SGD',
          itinerary: [],
          cost_breakdown: [],
          source_idea_id: idea.id,
          budget_minor: idea.estimated_cost_minor,
        })
        .returning();
      if (trip) {
        await db
          .update(ideas)
          .set({ converted_trip_id: trip.id, stage_override: 'converted', ...touch() })
          .where(eq(ideas.id, id));
        publish(podId, { entity: 'trips', action: 'insert', row: trip });
      }
    }

    const refreshed = (await db.select().from(ideas).where(eq(ideas.id, id)).limit(1))[0]!;
    publish(podId, { entity: 'ideas', action: 'update', row: serializeIdea(refreshed, votes, memberIds) });
    return serializeIdea(refreshed, votes, memberIds);
  });

  app.delete('/pods/:podId/ideas/:id', async (request, reply) => {
    const podId = podIdOf(request);
    const id = uuidParam(request, 'id');
    const [existing] = await db.select().from(ideas).where(eq(ideas.id, id)).limit(1);
    if (!existing) throw notFound('Idea not found');
    await requireOwnerOrAdmin(request.user, podId, existing);
    await db.delete(ideaVotes).where(eq(ideaVotes.idea_id, id));
    await db.delete(ideas).where(eq(ideas.id, id));
    publish(podId, { entity: 'ideas', action: 'delete', row: existing });
    reply.code(204);
    return null;
  });

  // -----------------------------------------------------------------------
  // Wallet -- every response is labelled simulated: true
  // -----------------------------------------------------------------------
  app.get('/pods/:podId/wallet', async (request) => {
    const podId = podIdOf(request);
    await requirePodMemberOrOperator(request.user, podId);
    const [wallet] = await db.select().from(wallets).where(eq(wallets.pod_id, podId)).limit(1);
    const bills = await db.select().from(walletBills).where(eq(walletBills.pod_id, podId));
    const goals = await db.select().from(walletGoals).where(eq(walletGoals.pod_id, podId));
    const transactions = await db
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.pod_id, podId))
      .orderBy(desc(walletTransactions.created_at));
    return { simulated: true, wallet: wallet ?? { pod_id: podId, currency: 'SGD', balance_minor: 0 }, bills, goals, transactions };
  });

  app.post('/pods/:podId/wallet/transactions', async (request, reply) => {
    const podId = podIdOf(request);
    await requirePodMemberOrOperator(request.user, podId);
    const body = parseBody(
      z.object({
        kind: z.enum(['deposit', 'withdrawal', 'bill_payment', 'goal_contribution', 'trip_booking', 'request', 'reward_redemption']),
        amount_minor: z.number().int(),
        description: z.string().min(1),
        bill_id: z.string().uuid().nullable().optional(),
        goal_id: z.string().uuid().nullable().optional(),
        trip_id: z.string().uuid().nullable().optional(),
      }),
      request.body,
    );
    const [tx] = await db
      .insert(walletTransactions)
      .values({
        pod_id: podId,
        actor_id: request.user.id,
        kind: body.kind,
        amount_minor: body.amount_minor,
        description: body.description,
        bill_id: body.bill_id ?? null,
        goal_id: body.goal_id ?? null,
        trip_id: body.trip_id ?? null,
      })
      .returning();
    const [wallet] = await db.select().from(wallets).where(eq(wallets.pod_id, podId)).limit(1);
    const next = (wallet?.balance_minor ?? 0) + body.amount_minor;
    if (wallet) {
      await db.update(wallets).set({ balance_minor: next, updated_at: new Date() }).where(eq(wallets.pod_id, podId));
    } else {
      await db.insert(wallets).values({ pod_id: podId, currency: 'SGD', balance_minor: next });
    }
    publish(podId, { entity: 'wallet_transactions', action: 'insert', row: tx });
    reply.code(201);
    return { simulated: true, transaction: tx, balance_minor: next };
  });

  app.post('/pods/:podId/wallet/bills', async (request, reply) => {
    const podId = podIdOf(request);
    await requirePodMemberOrOperator(request.user, podId);
    const body = parseBody(
      z.object({
        name: z.string().min(1),
        emoji: z.string().optional(),
        amount_minor: z.number().int(),
        due_date: z.string(),
        frequency: z.enum(['once', 'weekly', 'monthly', 'yearly']).optional(),
        paid_by_id: z.string().uuid().nullable().optional(),
        split_percent: z.record(z.number()).optional(),
        category: z.string().optional(),
      }),
      request.body,
    );
    const [row] = await db
      .insert(walletBills)
      .values({
        pod_id: podId,
        name: body.name,
        emoji: body.emoji ?? '🧾',
        amount_minor: body.amount_minor,
        due_date: body.due_date,
        frequency: body.frequency ?? 'monthly',
        paid_by_id: body.paid_by_id ?? null,
        split_percent: body.split_percent ?? {},
        category: body.category ?? 'other',
      })
      .returning();
    publish(podId, { entity: 'wallet_bills', action: 'insert', row });
    reply.code(201);
    return { simulated: true, bill: row };
  });

  app.post('/pods/:podId/wallet/goals', async (request, reply) => {
    const podId = podIdOf(request);
    await requirePodMemberOrOperator(request.user, podId);
    const body = parseBody(
      z.object({
        name: z.string().min(1),
        emoji: z.string().optional(),
        target_minor: z.number().int(),
        saved_minor: z.number().int().optional(),
        trip_id: z.string().uuid().nullable().optional(),
      }),
      request.body,
    );
    const [row] = await db
      .insert(walletGoals)
      .values({
        pod_id: podId,
        name: body.name,
        emoji: body.emoji ?? '🎯',
        target_minor: body.target_minor,
        saved_minor: body.saved_minor ?? 0,
        trip_id: body.trip_id ?? null,
      })
      .returning();
    publish(podId, { entity: 'wallet_goals', action: 'insert', row });
    reply.code(201);
    return { simulated: true, goal: row };
  });

  // -----------------------------------------------------------------------
  // Garden + world + memories + bucket list
  // -----------------------------------------------------------------------
  app.get('/pods/:podId/garden', async (request) => {
    const podId = podIdOf(request);
    await requirePodMemberOrOperator(request.user, podId);
    const entries = await db.select().from(gardenEntries).where(eq(gardenEntries.pod_id, podId));
    const inventory = await db.select().from(seedInventory).where(eq(seedInventory.pod_id, podId));
    return { entries, inventory };
  });

  app.post('/pods/:podId/garden', async (request, reply) => {
    const podId = podIdOf(request);
    await requirePodMemberOrOperator(request.user, podId);
    const body = parseBody(
      z.object({
        kind: z.enum(['plant', 'decor']).optional(),
        slot: z.number().int().min(0),
        catalog_id: z.string(),
        name: z.string(),
        emoji: z.string(),
        rarity: z.enum(['common', 'special', 'rare', 'treasured']).optional(),
        provenance: z.enum(['earned', 'shop']).optional(),
        source_label: z.string().nullable().optional(),
        memory_id: z.string().uuid().nullable().optional(),
        grows_seconds: z.number().int().optional(),
      }),
      request.body,
    );
    const [row] = await db
      .insert(gardenEntries)
      .values({
        pod_id: podId,
        kind: body.kind ?? 'plant',
        slot: body.slot,
        catalog_id: body.catalog_id,
        name: body.name,
        emoji: body.emoji,
        rarity: body.rarity ?? 'common',
        provenance: body.provenance ?? 'earned',
        source_label: body.source_label ?? null,
        memory_id: body.memory_id ?? null,
        planted_at: new Date(),
        grows_seconds: body.grows_seconds ?? 60,
        water_boost: 0,
      })
      .returning();
    publish(podId, { entity: 'garden_entries', action: 'insert', row });
    reply.code(201);
    return row;
  });

  app.post('/pods/:podId/garden/:id/water', async (request) => {
    const podId = podIdOf(request);
    await requirePodMemberOrOperator(request.user, podId);
    const id = uuidParam(request, 'id');
    const [existing] = await db.select().from(gardenEntries).where(eq(gardenEntries.id, id)).limit(1);
    if (!existing) throw notFound('Garden entry not found');
    const boost = Math.min(1, (existing.water_boost ?? 0) + 0.08);
    const [row] = await db
      .update(gardenEntries)
      .set({ water_boost: boost, watered_at: new Date() })
      .where(eq(gardenEntries.id, id))
      .returning();
    publish(podId, { entity: 'garden_entries', action: 'update', row });
    return row;
  });

  app.get('/pods/:podId/date-activities', async (request) => {
    const podId = podIdOf(request);
    await requirePodMemberOrOperator(request.user, podId);
    return db
      .select()
      .from(dateActivities)
      .where(eq(dateActivities.pod_id, podId))
      .orderBy(desc(dateActivities.scheduled_at));
  });

  app.post('/pods/:podId/date-activities', async (request, reply) => {
    const podId = podIdOf(request);
    await requirePodMemberOrOperator(request.user, podId);
    const body = parseBody(
      z.object({
        catalog_id: z.string().min(1).nullable().optional(),
        title: z.string().min(1).max(120),
        emoji: z.string().max(8).optional(),
        is_online: z.boolean().optional(),
        scheduled_at: z.coerce.date().nullable().optional(),
        participant_ids: z.array(z.string().uuid()).optional(),
        status: z.enum(['scheduled', 'completed', 'cancelled']).optional(),
      }),
      request.body,
    );
    const [row] = await db
      .insert(dateActivities)
      .values({
        pod_id: podId,
        created_by_id: request.user.id,
        catalog_id: body.catalog_id ?? null,
        title: body.title,
        emoji: body.emoji ?? '💛',
        is_online: body.is_online ?? false,
        scheduled_at: body.scheduled_at ?? null,
        participant_ids: body.participant_ids ?? [],
        status: body.status ?? 'scheduled',
      })
      .returning();
    publish(podId, { entity: 'date_activities', action: 'insert', row });
    reply.code(201);
    return row;
  });

  app.post('/pods/:podId/rewards/redeem', async (request) => {
    const podId = podIdOf(request);
    await requirePodMemberOrOperator(request.user, podId);
    const body = parseBody(
      z.object({
        catalog_id: z.string().min(1).max(100),
        peanut_cost: z.number().int().positive(),
      }),
      request.body,
    );

    const result = await db.transaction(async (tx) => {
      const [world] = await tx
        .update(podWorlds)
        .set({
          peanuts: sql`${podWorlds.peanuts} - ${body.peanut_cost}`,
          updated_at: new Date(),
        })
        .where(and(eq(podWorlds.pod_id, podId), gte(podWorlds.peanuts, body.peanut_cost)))
        .returning();
      if (!world) throw badRequest('Not enough Peanuts');

      const [redemption] = await tx
        .insert(rewardRedemptions)
        .values({
          pod_id: podId,
          redeemed_by_id: request.user.id,
          catalog_id: body.catalog_id,
          peanut_cost: body.peanut_cost,
        })
        .returning();
      return { world, redemption };
    });

    publish(podId, { entity: 'reward_redemptions', action: 'insert', row: result.redemption });
    return { simulated: true, ...result };
  });

  app.get('/pods/:podId/world', async (request) => {
    const podId = podIdOf(request);
    await requirePodMemberOrOperator(request.user, podId);
    const [world] = await db.select().from(podWorlds).where(eq(podWorlds.pod_id, podId)).limit(1);
    const collectibles = await db.select().from(unlockedCollectibles).where(eq(unlockedCollectibles.pod_id, podId));
    const activities = await db.select().from(dateActivities).where(eq(dateActivities.pod_id, podId));
    const redemptions = await db.select().from(rewardRedemptions).where(eq(rewardRedemptions.pod_id, podId));
    return { world: world ?? { pod_id: podId, xp: 0, peanuts: 0 }, collectibles, date_activities: activities, redemptions };
  });

  app.get('/pods/:podId/memories', async (request) => {
    const podId = podIdOf(request);
    await requirePodMemberOrOperator(request.user, podId);
    return db.select().from(memories).where(eq(memories.pod_id, podId)).orderBy(desc(memories.created_at));
  });

  app.post('/pods/:podId/memories', async (request, reply) => {
    const podId = podIdOf(request);
    await requirePodMemberOrOperator(request.user, podId);
    const body = parseBody(
      z.object({
        title: z.string().min(1),
        caption: z.string().nullable().optional(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        location: z.string().nullable().optional(),
        latitude: z.number().nullable().optional(),
        longitude: z.number().nullable().optional(),
        tag: z.enum(['everyday', 'place', 'travel', 'milestone', 'anniversary', 'activity', 'culinary', 'nature', 'treasured']).optional(),
        photo_urls: z.array(z.string()).optional(),
        trip_id: z.string().uuid().nullable().optional(),
      }),
      request.body,
    );
    const [row] = await db
      .insert(memories)
      .values({
        pod_id: podId,
        created_by_id: request.user.id,
        title: body.title,
        caption: body.caption ?? null,
        date: body.date,
        location: body.location ?? null,
        latitude: body.latitude ?? null,
        longitude: body.longitude ?? null,
        tag: body.tag ?? 'everyday',
        photo_urls: (body.photo_urls ?? []).slice(0, 3),
        trip_id: body.trip_id ?? null,
      })
      .returning();
    publish(podId, { entity: 'memories', action: 'insert', row });
    reply.code(201);
    return row;
  });

  app.delete('/pods/:podId/memories/:id', async (request, reply) => {
    const podId = podIdOf(request);
    const id = uuidParam(request, 'id');
    const [existing] = await db.select().from(memories).where(eq(memories.id, id)).limit(1);
    if (!existing) throw notFound('Memory not found');
    await requireOwnerOrAdmin(request.user, podId, existing);
    await db.delete(memories).where(eq(memories.id, id));
    publish(podId, { entity: 'memories', action: 'delete', row: existing });
    reply.code(204);
    return null;
  });

  app.get('/pods/:podId/bucket-list', async (request) => {
    const podId = podIdOf(request);
    await requirePodMemberOrOperator(request.user, podId);
    return db.select().from(bucketListItems).where(eq(bucketListItems.pod_id, podId));
  });

  app.post('/pods/:podId/bucket-list', async (request, reply) => {
    const podId = podIdOf(request);
    await requirePodMemberOrOperator(request.user, podId);
    const body = parseBody(
      z.object({
        title: z.string().min(1),
        emoji: z.string().optional(),
        country: z.string().nullable().optional(),
        latitude: z.number().nullable().optional(),
        longitude: z.number().nullable().optional(),
        state: z.enum(['dream', 'planned', 'visited']).optional(),
        trip_id: z.string().uuid().nullable().optional(),
      }),
      request.body,
    );
    if (body.state === 'visited') {
      throw badRequest('visited is reachable only by completing a linked trip, never by editing the item');
    }
    const [row] = await db
      .insert(bucketListItems)
      .values({
        pod_id: podId,
        created_by_id: request.user.id,
        title: body.title,
        emoji: body.emoji ?? '✨',
        country: body.country ?? null,
        latitude: body.latitude ?? null,
        longitude: body.longitude ?? null,
        state: body.state ?? 'dream',
        trip_id: body.trip_id ?? null,
      })
      .returning();
    publish(podId, { entity: 'bucket_list_items', action: 'insert', row });
    reply.code(201);
    return row;
  });

  app.patch('/pods/:podId/bucket-list/:id', async (request) => {
    const podId = podIdOf(request);
    const id = uuidParam(request, 'id');
    const [existing] = await db.select().from(bucketListItems).where(eq(bucketListItems.id, id)).limit(1);
    if (!existing) throw notFound('Item not found');
    await requireOwnerOrAdmin(request.user, podId, existing);
    const body = parseBody(
      z.object({
        title: z.string().min(1).optional(),
        emoji: z.string().optional(),
        country: z.string().nullable().optional(),
        latitude: z.number().nullable().optional(),
        longitude: z.number().nullable().optional(),
        state: z.enum(['dream', 'planned']).optional(),
        trip_id: z.string().uuid().nullable().optional(),
      }),
      request.body,
    );
    const [row] = await db.update(bucketListItems).set(body).where(eq(bucketListItems.id, id)).returning();
    publish(podId, { entity: 'bucket_list_items', action: 'update', row });
    return row;
  });

  app.delete('/pods/:podId/bucket-list/:id', async (request, reply) => {
    const podId = podIdOf(request);
    const id = uuidParam(request, 'id');
    const [existing] = await db.select().from(bucketListItems).where(eq(bucketListItems.id, id)).limit(1);
    if (!existing) throw notFound('Item not found');
    await requireOwnerOrAdmin(request.user, podId, existing);
    await db.delete(bucketListItems).where(eq(bucketListItems.id, id));
    publish(podId, { entity: 'bucket_list_items', action: 'delete', row: existing });
    reply.code(204);
    return null;
  });
}

/**
 * Strip individual stances (and the running tally) while the idea is still
 * deciding. Revealing that two people already said "want" is exactly the
 * bandwagon pressure the hidden-vote rule exists to prevent.
 */
function serializeIdea(
  idea: typeof ideas.$inferSelect,
  votes: { voter_id: string; stance: 'want' | 'maybe' | 'no' }[],
  memberIds: string[],
) {
  const evaluation = evaluateDecision({
    member_ids: memberIds,
    votes,
    creator_stance: idea.creator_stance,
    source_type: idea.source_type,
    stage_override: idea.stage_override,
  });
  const revealed = evaluation.all_voted;
  return {
    ...idea,
    evaluation: revealed ? evaluation : { all_voted: false, voted_count: evaluation.voted_count, total: evaluation.total, outcome: 'deciding', stage: 'deciding' },
    votes: revealed ? votes : [],
  };
}

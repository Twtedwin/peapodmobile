/**
 * MODULE: services/api/src/routes/pods
 *
 * PURPOSE
 *   Pod lifecycle and membership. These are the privileged routes: renaming,
 *   deleting, inviting, changing roles, and kicking a member all go through
 *   `requirePrivilegedPodAction` so the security service's authorize check
 *   and the local Seed role cannot be bypassed by a generic CRUD write.
 *
 * INPUTS  : authenticated requests
 * OUTPUTS : pod / membership / invite / presence JSON
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { GEO } from '@peapod/shared';
import { db } from '../db/client.js';
import {
  locationPings,
  phoneStatuses,
  podInvites,
  podMemberships,
  podWorlds,
  pods,
  users,
  wallets,
} from '../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../http.js';
import {
  isPlatformAdmin,
  requirePodMemberOrOperator,
  requirePrivilegedPodAction,
} from '../policy/rls.js';
import { publish } from '../realtime/hub.js';
import { inviteCode, parseBody, stamp, touch, uuidParam } from './helpers.js';

const createPodBody = z.object({
  name: z.string().min(1).max(60),
  emoji: z.string().max(8).optional(),
  group_type: z.enum(['couple', 'family', 'friends']).optional(),
});

const patchPodBody = z.object({
  name: z.string().min(1).max(60).optional(),
  emoji: z.string().max(8).optional(),
  group_type: z.enum(['couple', 'family', 'friends']).optional(),
  trip_history_enabled: z.boolean().optional(),
});

// Invite generation uses six uppercase letters/numbers. Validate the same
// contract at the boundary so mistyped or fabricated codes fail immediately.
const joinBody = z.object({ code: z.string().trim().regex(/^[A-Za-z0-9]{6}$/) });
const roleBody = z.object({ role: z.enum(['admin', 'member']) });

export async function registerPods(app: FastifyInstance): Promise<void> {
  app.get('/pods', async (request) => {
    const user = request.user;
    const memberships = await db
      .select()
      .from(podMemberships)
      .where(eq(podMemberships.user_id, user.id));
    if (memberships.length === 0) return [];
    const ids = memberships.map((m) => m.pod_id);
    const rows = await db.select().from(pods).where(inArray(pods.id, ids));
    const roleByPod = new Map(memberships.map((m) => [m.pod_id, m.role]));
    return rows.map((row) => ({ ...row, my_role: roleByPod.get(row.id) ?? 'member' }));
  });

  app.post('/pods', async (request, reply) => {
    const body = parseBody(createPodBody, request.body);
    const user = request.user;
    const id = randomUUID();
    const audit = stamp(user);

    const [pod] = await db
      .insert(pods)
      .values({
        id,
        ...audit,
        name: body.name,
        emoji: body.emoji ?? '❤️',
        group_type: body.group_type ?? 'couple',
        trip_history_enabled: true,
      })
      .returning();
    if (!pod) throw badRequest('Failed to create pod');

    await db.insert(podMemberships).values({
      ...stamp(user),
      pod_id: pod.id,
      user_id: user.id,
      role: 'admin',
    });
    await db.insert(podWorlds).values({ pod_id: pod.id, xp: 0, peanuts: 0 });
    await db.insert(wallets).values({ pod_id: pod.id, currency: 'SGD', balance_minor: 0 });

    publish(pod.id, { entity: 'pods', action: 'insert', row: pod });
    reply.code(201);
    return pod;
  });

  app.get('/pods/:id', async (request) => {
    const id = uuidParam(request, 'id');
    await requirePodMemberOrOperator(request.user, id);
    const [pod] = await db.select().from(pods).where(eq(pods.id, id)).limit(1);
    if (!pod) throw notFound('Pod not found');
    return pod;
  });

  app.patch('/pods/:id', async (request) => {
    const id = uuidParam(request, 'id');
    await requirePrivilegedPodAction(request.user, id, 'pod.update');
    const body = parseBody(patchPodBody, request.body);
    const [updated] = await db
      .update(pods)
      .set({ ...body, ...touch() })
      .where(eq(pods.id, id))
      .returning();
    if (!updated) throw notFound('Pod not found');
    publish(id, { entity: 'pods', action: 'update', row: updated });
    return updated;
  });

  app.delete('/pods/:id', async (request, reply) => {
    const id = uuidParam(request, 'id');
    await requirePrivilegedPodAction(request.user, id, 'pod.delete');
    const [deleted] = await db.delete(pods).where(eq(pods.id, id)).returning();
    if (!deleted) throw notFound('Pod not found');
    // Memberships and invites hang off the pod; drop them so a re-created
    // pod with a recycled id cannot inherit a ghost roster.
    await db.delete(podMemberships).where(eq(podMemberships.pod_id, id));
    await db.delete(podInvites).where(eq(podInvites.pod_id, id));
    publish(id, { entity: 'pods', action: 'delete', row: deleted });
    reply.code(204);
    return null;
  });

  app.post('/pods/:id/invites', async (request, reply) => {
    const id = uuidParam(request, 'id');
    await requirePrivilegedPodAction(request.user, id, 'pod.invite');
    const code = inviteCode();
    const expires_at = new Date(Date.now() + 10 * 60 * 1000);
    const [invite] = await db
      .insert(podInvites)
      .values({ ...stamp(request.user), pod_id: id, code, expires_at })
      .returning();
    reply.code(201);
    return invite;
  });

  app.post('/pods/join', async (request) => {
    const { code } = parseBody(joinBody, request.body);
    const normalised = code.trim().toUpperCase();
    const [invite] = await db
      .select()
      .from(podInvites)
      .where(eq(podInvites.code, normalised))
      .limit(1);
    if (!invite) throw notFound('Invite not found');
    if (invite.expires_at.getTime() < Date.now()) throw badRequest('Invite has expired');

    const existing = await db
      .select({ id: podMemberships.id })
      .from(podMemberships)
      .where(and(eq(podMemberships.pod_id, invite.pod_id), eq(podMemberships.user_id, request.user.id)))
      .limit(1);
    if (existing[0]) throw conflict('Already a member of this pod');

    const [membership] = await db
      .insert(podMemberships)
      .values({
        ...stamp(request.user),
        pod_id: invite.pod_id,
        user_id: request.user.id,
        role: 'member',
      })
      .returning();
    publish(invite.pod_id, { entity: 'pod_memberships', action: 'insert', row: membership });
    const [pod] = await db.select().from(pods).where(eq(pods.id, invite.pod_id)).limit(1);
    return { pod, membership };
  });

  app.get('/pods/:id/members', async (request) => {
    const id = uuidParam(request, 'id');
    await requirePodMemberOrOperator(request.user, id);
    const rows = await db
      .select({
        membership: podMemberships,
        user: {
          id: users.id,
          email: users.email,
          display_name: users.display_name,
          avatar_url: users.avatar_url,
          role: users.role,
        },
      })
      .from(podMemberships)
      .innerJoin(users, eq(users.id, podMemberships.user_id))
      .where(eq(podMemberships.pod_id, id));
    return rows.map((row) => ({ ...row.membership, user: row.user }));
  });

  app.post('/pods/:id/members/:userId/role', async (request) => {
    const id = uuidParam(request, 'id');
    const userId = uuidParam(request, 'userId');
    await requirePrivilegedPodAction(request.user, id, 'pod.change_role');
    const { role } = parseBody(roleBody, request.body);
    const [updated] = await db
      .update(podMemberships)
      .set({ role, ...touch() })
      .where(and(eq(podMemberships.pod_id, id), eq(podMemberships.user_id, userId)))
      .returning();
    if (!updated) throw notFound('Membership not found');
    publish(id, { entity: 'pod_memberships', action: 'update', row: updated });
    return updated;
  });

  app.delete('/pods/:id/members/:userId', async (request, reply) => {
    const id = uuidParam(request, 'id');
    const userId = uuidParam(request, 'userId');
    const selfLeave = userId === request.user.id;
    if (!selfLeave) await requirePrivilegedPodAction(request.user, id, 'pod.remove_member');
    else await requirePodMemberOrOperator(request.user, id);

    if (selfLeave && !isPlatformAdmin(request.user)) {
      const [mine] = await db
        .select()
        .from(podMemberships)
        .where(and(eq(podMemberships.pod_id, id), eq(podMemberships.user_id, userId)))
        .limit(1);
      if (mine?.role === 'admin') {
        const admins = await db
          .select({ id: podMemberships.id })
          .from(podMemberships)
          .where(and(eq(podMemberships.pod_id, id), eq(podMemberships.role, 'admin')));
        if (admins.length <= 1) throw forbidden('The last Seed cannot leave; transfer the role first');
      }
    }

    const [deleted] = await db
      .delete(podMemberships)
      .where(and(eq(podMemberships.pod_id, id), eq(podMemberships.user_id, userId)))
      .returning();
    if (!deleted) throw notFound('Membership not found');
    publish(id, { entity: 'pod_memberships', action: 'delete', row: deleted });
    reply.code(204);
    return null;
  });

  /**
   * Latest ping per member. Online iff the ping is younger than
   * GEO.onlineThreshold_ms (10 minutes). Presence is never stored; it is
   * derived from this query so every viewer shares one clock.
   */
  app.get('/pods/:id/presence', async (request) => {
    const id = uuidParam(request, 'id');
    await requirePodMemberOrOperator(request.user, id);
    const members = await db
      .select({
        user_id: podMemberships.user_id,
        role: podMemberships.role,
        display_name: users.display_name,
        avatar_url: users.avatar_url,
      })
      .from(podMemberships)
      .innerJoin(users, eq(users.id, podMemberships.user_id))
      .where(eq(podMemberships.pod_id, id));

    const pings = await db
      .select()
      .from(locationPings)
      .where(eq(locationPings.pod_id, id))
      .orderBy(desc(locationPings.created_at));

    const latest = new Map<string, (typeof pings)[number]>();
    for (const ping of pings) {
      if (!latest.has(ping.created_by_id)) latest.set(ping.created_by_id, ping);
    }

    const statuses = await db
      .select()
      .from(phoneStatuses)
      .where(eq(phoneStatuses.pod_id, id))
      .orderBy(desc(phoneStatuses.created_at));
    const latestStatus = new Map<string, (typeof statuses)[number]>();
    for (const status of statuses) {
      if (!latestStatus.has(status.created_by_id)) latestStatus.set(status.created_by_id, status);
    }

    const threshold = GEO.onlineThreshold_ms;
    const now = Date.now();
    return members.map((member) => {
      const ping = latest.get(member.user_id);
      const age = ping ? now - ping.created_at.getTime() : null;
      return {
        user_id: member.user_id,
        display_name: member.display_name,
        avatar_url: member.avatar_url,
        role: member.role,
        online: age != null && age < threshold,
        last_seen_at: ping?.created_at ?? null,
        ping: ping ?? null,
        phone_status: latestStatus.get(member.user_id) ?? null,
      };
    });
  });
}

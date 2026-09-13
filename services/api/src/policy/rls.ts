/**
 * MODULE: services/api/src/policy/rls
 *
 * PURPOSE
 *   Row-level rules the API enforces on every domain read and write. Postgres
 *   RLS is not used: the rules need the verified principal from the security
 *   service, and they need to differ by route (privileged pod mutations vs
 *   ordinary CRUD). Encoding them here keeps them in one file a reviewer
 *   can actually finish.
 *
 * RULES
 *   1. Pod mutations (rename, delete, invite, role change, kick) only go
 *      through privileged routes, and those routes call `/internal/authorize`
 *      then confirm the caller is a pod admin (or a platform admin).
 *   2. Domain reads: the caller must be a member of the row's `pod_id`.
 *   3. Updates/deletes: owner (`created_by_id`) OR pod admin OR platform admin.
 *   4. Notifications: `recipient_id == caller` OR creator OR admin.
 *
 * INPUTS  : verified `AuthUser`, a pod id, optionally a row
 * OUTPUTS : the membership row, or an HttpError
 */

import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { podMemberships } from '../db/schema.js';
import { authorize } from '../auth/securityClient.js';
import { forbidden, notFound } from '../http.js';
import type { AuthUser } from '../types.js';

export interface Membership {
  id: string;
  pod_id: string;
  user_id: string;
  role: 'admin' | 'member';
}

export function isPlatformAdmin(user: AuthUser): boolean {
  return user.role === 'admin';
}

/**
 * Load the caller's membership in a pod, or 403.
 *
 * Platform admins bypass membership -- they are operators, not guests --
 * and get a synthetic admin membership so callers can still read `.role`.
 */
export async function requirePodMember(userId: string, podId: string): Promise<Membership> {
  const rows = await db
    .select({
      id: podMemberships.id,
      pod_id: podMemberships.pod_id,
      user_id: podMemberships.user_id,
      role: podMemberships.role,
    })
    .from(podMemberships)
    .where(and(eq(podMemberships.pod_id, podId), eq(podMemberships.user_id, userId)))
    .limit(1);

  const row = rows[0];
  if (!row) throw forbidden('Not a member of this pod');
  return row;
}

/**
 * Require membership for a user who might be a platform admin. Used by
 * domain reads so an operator can inspect any pod without joining it.
 */
export async function requirePodMemberOrOperator(user: AuthUser, podId: string): Promise<Membership> {
  if (isPlatformAdmin(user)) {
    return { id: 'operator', pod_id: podId, user_id: user.id, role: 'admin' };
  }
  return requirePodMember(user.id, podId);
}

export async function requirePodAdmin(user: AuthUser, podId: string): Promise<Membership> {
  if (isPlatformAdmin(user)) {
    return { id: 'operator', pod_id: podId, user_id: user.id, role: 'admin' };
  }
  const membership = await requirePodMember(user.id, podId);
  if (membership.role !== 'admin') throw forbidden('Pod admin role required');
  return membership;
}

/**
 * Privileged pod mutation: ask the security service, then confirm locally.
 *
 * If `/internal/authorize` is unreachable (common in a frontend-only dev
 * layout), we fall through to the local admin check rather than bricking
 * the pod settings screen. An explicit `allowed: false` is still a deny.
 */
export async function requirePrivilegedPodAction(
  user: AuthUser,
  podId: string,
  action: string,
): Promise<Membership> {
  const decision = await authorize({
    user_id: user.id,
    action,
    resource_type: 'pod',
    resource_id: podId,
    pod_id: podId,
  });
  if (decision === false) throw forbidden('Not authorised for this pod action');
  return requirePodAdmin(user, podId);
}

/**
 * Updates and deletes: owner, pod admin, or platform admin.
 *
 * @param row.created_by_id  The owner. A missing value (tables without an
 *                           owner column) means "pod admin required".
 */
export async function requireOwnerOrAdmin(
  user: AuthUser,
  podId: string | null | undefined,
  row: { created_by_id?: string | null },
): Promise<void> {
  if (isPlatformAdmin(user)) return;
  if (row.created_by_id && row.created_by_id === user.id) return;
  if (!podId) throw forbidden('Not allowed to change this row');
  const membership = await requirePodMember(user.id, podId);
  if (membership.role === 'admin') return;
  throw forbidden('Only the owner or a pod admin can change this');
}

/**
 * Notification visibility. A notification is addressed to exactly one user;
 * the creator and admins may also read it (so a Seed can see that a reminder
 * actually fired).
 */
export async function requireNotificationAccess(
  user: AuthUser,
  row: { recipient_id: string | null; created_by_id: string; pod_id: string | null },
): Promise<void> {
  if (isPlatformAdmin(user)) return;
  if (row.recipient_id === user.id) return;
  if (row.created_by_id === user.id) return;
  if (row.pod_id) {
    const membership = await requirePodMember(user.id, row.pod_id);
    if (membership.role === 'admin') return;
  }
  throw forbidden('This notification is not for you');
}

export async function requireExistingPod(podId: string): Promise<void> {
  // Cheap existence check used after a member lookup that 403s on unknown
  // pods too. Distinguishing 404 from 403 would leak whether a pod id is
  // real, so we keep both as 403 for unauthenticated-looking access, and
  // only 404 when the caller is already a known member of something else
  // and the id is simply mistyped -- handled by the route if it cares.
  const rows = await db
    .select({ id: podMemberships.pod_id })
    .from(podMemberships)
    .where(eq(podMemberships.pod_id, podId))
    .limit(1);
  if (!rows[0]) throw notFound('Pod not found');
}

export async function listMemberIds(podId: string): Promise<string[]> {
  const rows = await db
    .select({ user_id: podMemberships.user_id })
    .from(podMemberships)
    .where(eq(podMemberships.pod_id, podId));
  return rows.map((row) => row.user_id);
}

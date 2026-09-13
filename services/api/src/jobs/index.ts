/**
 * MODULE: services/api/src/jobs
 *
 * PURPOSE
 *   Four cron jobs, all in Asia/Singapore:
 *
 *     03:00  prune chat messages older than 7 days
 *     09:00  plan reminders for tomorrow (honours for_whom / participant_ids)
 *     09:00  important-date reminders (recurring dates use next yearly occurrence)
 *     08:00  milestone notifications at 100 / 200 / 365 / 500 / 730 / 1000 days
 *            from the pod's earliest pinned count-up date
 *
 * INPUTS  : the live database
 * OUTPUTS : deleted rows, and inserted `notifications` rows (plus a realtime
 *           publish so an open app sees them without a refresh)
 *
 * WHY ASIA/SINGAPORE
 *   The product is launched there first and "tomorrow" on a plan is a
 *   calendar day in the pod's home zone, not UTC. node-cron's `timezone`
 *   option is what makes 09:00 mean 09:00 SGT even when the process runs
 *   on a UTC host.
 *
 * PRESENCE
 *   Not a job. A member is online when their newest ping is younger than
 *   10 minutes, computed live on GET /pods/:id/presence.
 */

import cron from 'node-cron';
import { and, eq, isNotNull, lt, sql } from 'drizzle-orm';
import { daysSince, nextYearlyOccurrence, planOccursOn, PROGRESSION } from '@peapod/shared';
import { db } from '../db/client.js';
import { importantDates, messages, notifications, plans, podMemberships } from '../db/schema.js';
import { publish } from '../realtime/hub.js';

const TZ = 'Asia/Singapore';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Calendar date in Asia/Singapore as a UTC-midnight Date (matches `@peapod/shared/dates`). */
export function singaporeCalendarDate(now = new Date()): Date {
  const shifted = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
}

function addUtcDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function insertNotification(row: {
  created_by_id: string;
  title: string;
  body: string;
  emoji: string;
  recipient_id: string;
  type: 'date_reminder' | 'plan_reminder' | 'info';
  pod_id: string;
}): Promise<void> {
  const [created] = await db
    .insert(notifications)
    .values({
      ...row,
      is_read: false,
    })
    .returning();
  if (created) publish(row.pod_id, { entity: 'notifications', action: 'insert', row: created });
}

async function alreadyNotified(recipientId: string, title: string, since: Date): Promise<boolean> {
  const rows = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.recipient_id, recipientId),
        eq(notifications.title, title),
        sql`${notifications.created_at} >= ${since}`,
      ),
    )
    .limit(1);
  return Boolean(rows[0]);
}

async function memberIdsFor(podId: string): Promise<string[]> {
  const rows = await db
    .select({ user_id: podMemberships.user_id })
    .from(podMemberships)
    .where(eq(podMemberships.pod_id, podId));
  return rows.map((row) => row.user_id);
}

/** Recipients of a plan reminder, honouring for_whom / participant_ids. */
function planRecipients(plan: {
  created_by_id: string;
  for_whom: string;
  participant_ids: string[] | null;
  memberIds: string[];
}): string[] {
  if (plan.for_whom === 'self') return [plan.created_by_id];
  if (plan.for_whom === 'specific') {
    const ids = plan.participant_ids ?? [];
    return ids.filter((id) => plan.memberIds.includes(id));
  }
  return plan.memberIds;
}

export async function pruneOldMessages(): Promise<number> {
  const cutoff = new Date(Date.now() - 7 * MS_PER_DAY);
  // Ephemeral pod chat is pruned; global direct-message history has pod_id
  // null and remains available when either user switches or leaves a pod.
  const deleted = await db
    .delete(messages)
    .where(and(isNotNull(messages.pod_id), lt(messages.created_at, cutoff)))
    .returning({ id: messages.id });
  return deleted.length;
}

export async function sendPlanReminders(now = new Date()): Promise<number> {
  const tomorrow = addUtcDays(singaporeCalendarDate(now), 1);
  const rows = await db.select().from(plans);
  let sent = 0;
  const since = singaporeCalendarDate(now);

  for (const plan of rows) {
    if (!plan.pod_id) continue;
    if (!planOccursOn({ start_time: plan.start_time.toISOString(), end_time: plan.end_time?.toISOString() ?? null, repeat_frequency: plan.repeat_frequency }, tomorrow)) {
      continue;
    }
    const memberIds = await memberIdsFor(plan.pod_id);
    const recipients = planRecipients({
      created_by_id: plan.created_by_id,
      for_whom: plan.for_whom,
      participant_ids: plan.participant_ids,
      memberIds,
    });
    const title = `Tomorrow: ${plan.title}`;
    for (const recipient of recipients) {
      if (await alreadyNotified(recipient, title, since)) continue;
      await insertNotification({
        created_by_id: plan.created_by_id,
        title,
        body: plan.location_name ? `At ${plan.location_name}` : 'From your shared plans.',
        emoji: '📌',
        recipient_id: recipient,
        type: 'plan_reminder',
        pod_id: plan.pod_id,
      });
      sent++;
    }
  }
  return sent;
}

export async function sendDateReminders(now = new Date()): Promise<number> {
  const tomorrow = addUtcDays(singaporeCalendarDate(now), 1);
  const tomorrowIso = isoDate(tomorrow);
  const rows = await db.select().from(importantDates);
  let sent = 0;
  const since = singaporeCalendarDate(now);

  for (const dateRow of rows) {
    if (!dateRow.pod_id) continue;
    let occurs = dateRow.date === tomorrowIso;
    if (!occurs && dateRow.recurring) {
      const next = nextYearlyOccurrence(dateRow.date, now);
      occurs = Boolean(next && isoDate(next) === tomorrowIso);
    }
    if (!occurs) continue;

    const members = await memberIdsFor(dateRow.pod_id);
    const title = `Tomorrow: ${dateRow.title}`;
    for (const recipient of members) {
      if (await alreadyNotified(recipient, title, since)) continue;
      await insertNotification({
        created_by_id: dateRow.created_by_id,
        title,
        body: dateRow.count_up ? 'A milestone on your journey.' : 'A date you marked together.',
        emoji: dateRow.emoji || '📅',
        recipient_id: recipient,
        type: 'date_reminder',
        pod_id: dateRow.pod_id,
      });
      sent++;
    }
  }
  return sent;
}

export async function sendMilestoneNotifications(now = new Date()): Promise<number> {
  const milestones = PROGRESSION.milestoneDays;
  const pinned = await db
    .select()
    .from(importantDates)
    .where(and(eq(importantDates.pinned, true), eq(importantDates.count_up, true)));

  // Earliest pinned count-up date per pod -- that is the pod's headline journey.
  const earliest = new Map<string, (typeof pinned)[number]>();
  for (const row of pinned) {
    if (!row.pod_id) continue;
    const current = earliest.get(row.pod_id);
    if (!current || row.date < current.date) earliest.set(row.pod_id, row);
  }

  let sent = 0;
  const since = singaporeCalendarDate(now);

  for (const [podId, row] of earliest) {
    const elapsed = daysSince(row.date, now);
    if (!milestones.includes(elapsed)) continue;
    const members = await memberIdsFor(podId);
    const title = `${elapsed} days together`;
    for (const recipient of members) {
      if (await alreadyNotified(recipient, title, since)) continue;
      await insertNotification({
        created_by_id: row.created_by_id,
        title,
        body: `Today marks ${elapsed} days from ${row.title}.`,
        emoji: '🎉',
        recipient_id: recipient,
        type: 'info',
        pod_id: podId,
      });
      sent++;
    }
  }
  return sent;
}

/** Register all four schedules. Safe to call once at boot. */
export function startJobs(): void {
  cron.schedule('0 3 * * *', () => void pruneOldMessages(), { timezone: TZ });
  cron.schedule('0 9 * * *', () => void sendPlanReminders(), { timezone: TZ });
  cron.schedule('0 9 * * *', () => void sendDateReminders(), { timezone: TZ });
  cron.schedule('0 8 * * *', () => void sendMilestoneNotifications(), { timezone: TZ });
}

/**
 * MODULE: @peapod/shared/dates
 *
 * PURPOSE
 *   Date and duration helpers. Small, but disproportionately important: almost
 *   every date bug in this product class is a time-zone bug, and every one of
 *   them is user-visible ("Together for 1,123 days" when it should be 1,124).
 *
 * INPUTS  : ISO calendar dates (`YYYY-MM-DD`), ISO timestamps, epoch millis
 * OUTPUTS : day counts, human labels, occurrence tests
 *
 * CONSUMED BY
 *   - apps/mobile   : journey counters, countdowns, "last seen" labels
 *   - services/api  : the scheduled reminder and milestone jobs, which have to
 *                     agree with the app about what day it is
 *
 * ============================================================================
 * THE RULE: CALENDAR DATES ARE UTC MIDNIGHT, ALWAYS
 * ============================================================================
 *   `new Date('2023-08-17')` is parsed by JavaScript as UTC midnight, but
 *   `new Date('2023-08-17T00:00:00')` (no zone) is parsed as LOCAL midnight.
 *   Mixing the two shifts the day for every user not on UTC, so a pod in
 *   Singapore (UTC+8) sees their anniversary counter tick over eight hours
 *   early, and a pod in Los Angeles sees it tick over a day late.
 *
 *   Every function here parses calendar dates as UTC midnight and compares whole
 *   UTC days. A "day" in Peapod means a calendar day, not 86,400,000
 *   milliseconds -- which also makes these functions immune to daylight saving,
 *   where a local day can be 23 or 25 hours long.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Parses a value into a Date, safely.
 *
 * @param value An ISO timestamp, an ISO calendar date, epoch milliseconds, a
 *              Date, or null.
 * @returns A valid Date, or null when the input cannot be parsed. Never returns
 *          an `Invalid Date`, because those propagate silently and surface as
 *          "NaN days together" three screens away from the cause.
 */
export function safeDate(value: string | number | Date | null | undefined): Date | null {
  if (value == null) return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === 'number') {
    const fromMillis = new Date(value);
    return Number.isNaN(fromMillis.getTime()) ? null : fromMillis;
  }

  // A bare `YYYY-MM-DD` is pinned to UTC midnight explicitly rather than relying
  // on the engine's parsing rules, which differ between a bare date and a
  // date-time without a zone.
  const normalised = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value;

  const parsed = new Date(normalised);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Truncates an instant to UTC midnight of the same calendar day.
 *
 * @param date Any instant.
 * @returns A new Date at 00:00:00.000 UTC on that day.
 */
export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0));
}

/**
 * Whole calendar days between two instants, in UTC.
 *
 * @param from Earlier instant.
 * @param to   Later instant. Defaults to now.
 * @returns Whole days. Negative when `to` precedes `from`.
 */
export function daysBetween(from: Date, to: Date = new Date()): number {
  return Math.round((startOfUtcDay(to).getTime() - startOfUtcDay(from).getTime()) / MS_PER_DAY);
}

/**
 * Days elapsed since a pod's count-up date -- the "Together for N days" number.
 *
 * @param isoDate The date the journey started, `YYYY-MM-DD`.
 * @param now     Reference instant. Defaults to now.
 * @returns Whole days, at least 0. A future start date reads as 0 rather than
 *          negative, since "together for -5 days" is meaningless.
 */
export function daysSince(isoDate: string, now: Date = new Date()): number {
  const start = safeDate(isoDate);
  if (!start) return 0;
  return Math.max(0, daysBetween(start, now));
}

/**
 * Days remaining until a count-down date.
 *
 * @param isoDate The target date, `YYYY-MM-DD`.
 * @param now     Reference instant. Defaults to now.
 * @returns Whole days. 0 means today; negative means it has passed.
 */
export function daysUntil(isoDate: string, now: Date = new Date()): number {
  const target = safeDate(isoDate);
  if (!target) return 0;
  return daysBetween(now, target);
}

/**
 * The next occurrence of a recurring yearly date, such as a birthday.
 *
 * @param isoDate The original date, `YYYY-MM-DD`. Only its month and day matter.
 * @param now     Reference instant. Defaults to now.
 * @returns The next occurrence at UTC midnight, or null if the input is unparseable.
 *
 * EDGE CASES
 *   - Today counts as the next occurrence, not as already past, so a birthday
 *     shows "Today" rather than jumping a year ahead.
 *   - 29 February in a non-leap year rolls to 1 March, which is what
 *     `Date.UTC` does with an out-of-range day. That is a deliberate choice over
 *     skipping the event entirely.
 */
export function nextYearlyOccurrence(isoDate: string, now: Date = new Date()): Date | null {
  const original = safeDate(isoDate);
  if (!original) return null;

  const today = startOfUtcDay(now);
  const month = original.getUTCMonth();
  const day = original.getUTCDate();

  const thisYear = new Date(Date.UTC(today.getUTCFullYear(), month, day, 0, 0, 0, 0));
  if (thisYear.getTime() >= today.getTime()) return thisYear;

  return new Date(Date.UTC(today.getUTCFullYear() + 1, month, day, 0, 0, 0, 0));
}

/**
 * Whether a repeating plan occurs on a given calendar day.
 *
 * Walks forward from the plan's original start in its repeat step, looking for a
 * match. This is the logic the scheduled reminder job uses to decide who to
 * notify tomorrow.
 *
 * @param plan.start_time       When the plan first occurs, ISO timestamp.
 * @param plan.end_time         Optional end, making the plan a multi-day span.
 * @param plan.repeat_frequency `none`, `daily`, `weekly`, or `monthly`.
 * @param target                The calendar day being tested.
 * @returns True when the plan occurs on that day.
 *
 * WHY WALK RATHER THAN COMPUTE
 *   A closed-form test is easy for daily and weekly, but monthly is not: adding
 *   one month to 31 January lands on 3 March, and the sequence of "the 31st of
 *   each month" is genuinely irregular. Walking with the platform's own date
 *   arithmetic reproduces whatever the app itself would show. The loop is capped
 *   so a plan started years ago cannot spin forever.
 */
export function planOccursOn(
  plan: { start_time: string; end_time?: string | null; repeat_frequency?: string | null },
  target: Date,
): boolean {
  const start = safeDate(plan.start_time);
  if (!start) return false;

  const targetDay = startOfUtcDay(target);
  const sameDay = (candidate: Date): boolean =>
    startOfUtcDay(candidate).getTime() === targetDay.getTime();

  const frequency = plan.repeat_frequency ?? 'none';

  // --- Non-repeating ---
  if (frequency === 'none') {
    // A plan with an end time spans a range, so any day inside the range counts.
    if (plan.end_time) {
      const end = safeDate(plan.end_time);
      if (end) {
        const startDay = startOfUtcDay(start).getTime();
        const endDay = startOfUtcDay(end).getTime();
        const day = targetDay.getTime();
        return day >= startDay && day <= endDay;
      }
    }
    return sameDay(start);
  }

  // --- Repeating: step forward from the original start ---
  // 400 iterations covers just over a year of daily repeats, which is the
  // horizon the reminder job needs. The `cursor <= target` guard normally exits
  // far sooner; the counter is only a runaway guard.
  const cursor = new Date(start.getTime());
  for (let i = 0; i < 400 && startOfUtcDay(cursor).getTime() <= targetDay.getTime(); i++) {
    if (sameDay(cursor)) return true;

    if (frequency === 'daily') cursor.setUTCDate(cursor.getUTCDate() + 1);
    else if (frequency === 'weekly') cursor.setUTCDate(cursor.getUTCDate() + 7);
    else cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  return false;
}

/**
 * A short "last seen" label.
 *
 * @param elapsed_ms Milliseconds since the member was last heard from.
 * @returns `"Just now"`, `"12 min ago"`, `"3 hr ago"`, or `"2 days ago"`.
 */
export function lastSeenLabel(elapsed_ms: number): string {
  const minutes = Math.floor(elapsed_ms / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;

  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

/**
 * How long a member has been somewhere, phrased as a duration.
 *
 * @param since_ms When they settled, epoch milliseconds.
 * @param now_ms   Reference instant, epoch milliseconds. Defaults to now.
 * @returns `"just arrived"`, `"25m"`, `"2h 10m"`, or `"3d"`.
 */
export function dwellLabel(since_ms: number, now_ms: number = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now_ms - since_ms) / 60000);
  if (minutes < 1) return 'just arrived';
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  if (hours < 24) return remainderMinutes > 0 ? `${hours}h ${remainderMinutes}m` : `${hours}h`;

  return `${Math.floor(hours / 24)}d`;
}

/**
 * A friendly headline for a long journey.
 *
 * @param days Days elapsed.
 * @returns `"1,124 days"` under two years, otherwise `"3 years, 2 months"`.
 *          Switching units keeps the number meaningful: "1,850 days" is hard to
 *          feel, "5 years" is not.
 */
export function journeyHeadline(days: number): string {
  if (days < 730) return `${days.toLocaleString('en-US')} days`;

  const years = Math.floor(days / 365);
  const months = Math.floor((days % 365) / 30);

  const yearPart = years === 1 ? '1 year' : `${years} years`;
  if (months === 0) return yearPart;

  const monthPart = months === 1 ? '1 month' : `${months} months`;
  return `${yearPart}, ${monthPart}`;
}

/**
 * MODULE: @peapod/shared/entities
 *
 * PURPOSE
 *   TypeScript mirrors of `schemas/core.schema.json` -- the twelve core Peapod
 *   records. Field names and enum values are the product contract and must
 *   stay stable.
 *
 * INPUTS  : none (type declarations only, no runtime code)
 * OUTPUTS : compile-time types
 *
 * CONSUMED BY
 *   - apps/mobile      : typing API responses and React Query caches
 *   - services/api     : typing route handlers, and cross-checked against the
 *                        Drizzle table definitions in src/db/schema.ts
 *
 * WHY THESE ARE HAND-WRITTEN
 *   The JSON Schemas generate the Python and Rust models (see scripts/codegen.mjs)
 *   but the TypeScript types are hand-maintained, because TS is the language the
 *   schemas were authored against and hand-written types give far better editor
 *   hints (literal unions, branded ids) than a generator would. `npm run
 *   codegen:check` verifies the two never drift apart.
 */

// ---------------------------------------------------------------------------
// Branded identifiers
// ---------------------------------------------------------------------------

/**
 * A UUID string tagged with the table it points at.
 *
 * Plain `string` ids are easy to mix up -- passing a pod id where a user id was
 * expected type-checks fine and fails at runtime. Branding makes that a compile
 * error while still being a plain string at runtime (zero cost).
 */
export type Id<TTable extends string> = string & { readonly __table?: TTable };

export type UserId = Id<'users'>;
export type PodId = Id<'pods'>;
export type TripId = Id<'trips'>;
export type IdeaId = Id<'ideas'>;
export type MemoryId = Id<'memories'>;

/** An ISO-8601 timestamp with a UTC offset, e.g. `2026-09-09T13:01:00.000Z`. */
export type IsoDateTime = string;

/** An ISO-8601 calendar date with no time component, e.g. `2026-09-09`. */
export type IsoDate = string;

// ---------------------------------------------------------------------------
// Audit columns
// ---------------------------------------------------------------------------

/**
 * Present on every record.
 *
 * `created_by_id` is the owner used by the ownership branch of every row-level
 * policy. It is always assigned server-side from the verified access token and
 * is stripped from client payloads before a write -- otherwise a client could
 * forge ownership and grant itself update/delete rights on somebody else's row.
 */
export interface AuditFields {
  id: string;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
  created_by_id: UserId;
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export type PodGroupType = 'couple' | 'family' | 'friends';

/**
 * A member's role within one pod.
 *
 * `admin` is shown in the UI as a "Seed". It is the only role permitted to
 * rename the pod, generate invite codes, change another member's role, remove
 * members, or delete the pod. Distinct from `User.role`, which is a
 * platform-operator flag.
 */
export type PodRole = 'admin' | 'member';

export type PlaceCategory = 'home' | 'work' | 'food' | 'date' | 'travel' | 'other';

/** Whether a geofence crossing was an entry or an exit. */
export type PlaceAlertEvent = 'arrived' | 'left';

/**
 * Who a plan is for, which decides who gets the day-before reminder:
 * `self` notifies only the creator, `specific` notifies `participant_ids`,
 * `pod` notifies every member.
 */
export type PlanAudience = 'self' | 'specific' | 'pod';

export type PlanRepeat = 'none' | 'daily' | 'weekly' | 'monthly';

export type NotificationKind =
  | 'info'
  | 'message'
  | 'pod_message'
  | 'nudge'
  | 'place_alert'
  | 'date_reminder'
  | 'plan_reminder';

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** The small group that shares location, plans, money, and a world. */
export interface Pod extends AuditFields {
  name: string;
  emoji: string;
  group_type: PodGroupType;
  /** When false, members' past movement trails are hidden from the map. */
  trip_history_enabled: boolean;
}

/**
 * Joins a user to a pod with a role.
 *
 * Clients never write this table directly. Every change goes through the
 * privileged pod routes so the admin checks cannot be bypassed.
 */
export interface PodMembership extends AuditFields {
  pod_id: PodId;
  user_id: UserId;
  role: PodRole;
}

/** A six-character join code that expires ten minutes after issue. */
export interface PodInvite extends AuditFields {
  pod_id: PodId;
  code: string;
  expires_at: IsoDateTime;
}

/**
 * An account.
 *
 * Credentials never appear here -- password hashes, OTP secrets, and refresh
 * tokens live exclusively in the Python security service's own tables.
 */
export interface User extends AuditFields {
  email: string;
  display_name: string;
  avatar_url: string | null;
  /**
   * Set once the user finishes the location + notification onboarding screen.
   * The app shell redirects to that screen while this is false.
   */
  permissions_granted: boolean;
  /** Platform-level role. `admin` means a Peapod operator, not a pod Seed. */
  role: 'admin' | 'user';
}

/**
 * One GPS fix from one device.
 *
 * The highest-volume table in the system. Written whenever a member moves past
 * the movement threshold, and read in bulk by the compute service to
 * reconstruct journeys.
 */
export interface LocationPing extends AuditFields {
  latitude: number;
  longitude: number;
  /** Ground speed in metres per second, as reported by the OS. */
  speed: number;
  /** Horizontal accuracy radius in metres. Fixes worse than 50 m are dropped during reconstruction. */
  accuracy: number;
  /** Degrees clockwise from true north. */
  heading: number;
  /** Device-side guess that this fix was taken in a vehicle. */
  is_driving: boolean;
  pod_id: PodId | null;
}

/**
 * Device telemetry for a member's card.
 *
 * The `*_supported` flags exist because some platforms refuse to report battery
 * level or connection type. Without them the UI would render a misleading 0%
 * instead of an honest "N/A".
 */
export interface PhoneStatus extends AuditFields {
  /** Percentage, 0-100. */
  battery_level: number;
  is_charging: boolean;
  connection_type: string;
  /** 0-4. */
  signal_bars: number;
  battery_supported: boolean;
  connection_supported: boolean;
  pod_id: PodId | null;
}

/**
 * A saved place, which doubles as a geofence.
 *
 * A non-null `expires_at` makes the place temporary -- handy for a one-off
 * meeting point that should not clutter the map forever.
 */
export interface FavouritePlace extends AuditFields {
  name: string;
  address: string | null;
  latitude: number;
  longitude: number;
  category: PlaceCategory;
  expires_at: IsoDateTime | null;
  pod_id: PodId | null;
}

/** An audit trail of geofence crossings, e.g. "Sarah arrived at Home". */
export interface PlaceAlert extends AuditFields {
  place_name: string;
  event: PlaceAlertEvent;
  latitude: number | null;
  longitude: number | null;
  pod_id: PodId | null;
}

/** Anything with a date that is not a full trip: a reminder, a call, a date night. */
export interface Plan extends AuditFields {
  title: string;
  description: string | null;
  start_time: IsoDateTime;
  end_time: IsoDateTime | null;
  location_name: string | null;
  for_whom: PlanAudience;
  /** Only meaningful when `for_whom` is `specific`. */
  participant_ids: UserId[];
  repeat_frequency: PlanRepeat;
  pod_id: PodId | null;
}

/**
 * A chat message.
 *
 * A null `recipient_id` makes it a pod-wide group message; a set `recipient_id`
 * makes it one-to-one. Pod chat is pruned after seven days; direct messages
 * with a null pod_id are retained globally.
 */
export interface Message extends AuditFields {
  recipient_id: UserId | null;
  pod_id: PodId | null;
  text: string;
}

/** An in-app notification addressed to exactly one user. */
export interface Notification extends AuditFields {
  title: string;
  body: string | null;
  emoji: string;
  is_read: boolean;
  recipient_id: UserId | null;
  type: NotificationKind;
  pod_id: PodId | null;
}

/**
 * A pod milestone.
 *
 * `count_up` dates power "Together for 1,124 days"; count-down dates power
 * "Sarah's birthday in 12 days". The milestone job reads count-up dates to
 * celebrate days 100, 200, 365, 500, 730, and 1000.
 */
export interface ImportantDate extends AuditFields {
  title: string;
  /**
   * Calendar date with no time component. Always parsed as UTC midnight --
   * parsing it in local time shifts the day for anyone east or west of UTC and
   * makes a "days together" counter off by one.
   */
  date: IsoDate;
  count_up: boolean;
  /** True for yearly events like birthdays. */
  recurring: boolean;
  emoji: string;
  /** The single pinned date is the pod's headline journey. */
  pinned: boolean;
  pod_id: PodId | null;
}

// ---------------------------------------------------------------------------
// Write payloads
// ---------------------------------------------------------------------------

/**
 * The shape a client may send when creating a record.
 *
 * Strips the audit columns, because all four are server-assigned. Accepting
 * `created_by_id` from a client would let it forge ownership.
 */
export type CreateInput<T extends AuditFields> = Omit<T, keyof AuditFields>;

/** The shape a client may send when updating a record: any subset of the writable fields. */
export type UpdateInput<T extends AuditFields> = Partial<CreateInput<T>>;

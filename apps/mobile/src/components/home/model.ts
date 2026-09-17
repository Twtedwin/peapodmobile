/**
 * Pure view-model helpers for the live pod map.
 *
 * Keeping geometry and labels out of React makes map camera behaviour and
 * member cards deterministic and straightforward to test.
 */

import { formatDistance, haversine, lastSeenLabel as formatLastSeen, nearestPlace } from '@peapod/shared';

import type { LocalFix } from '@/hooks/useLocationPings';
import type { MemberRow, PlaceRow, PresenceRow } from '@/hooks/usePodData';
import { spacing } from '@/theme';

export const INVITE_CODE_PATTERN = /^[A-Z0-9]{6}$/;

/** Horizontal inset of the member carousel, in density-independent pixels. */
export const MEMBER_CAROUSEL_PADDING = spacing.lg;

/** Gap between carousel cards, in density-independent pixels. */
export const MEMBER_CAROUSEL_GAP = spacing.sm;

/**
 * Edge padding for fitToCoordinates, in density-independent pixels.
 *
 * Top clears the floating pod pill and circular actions. Bottom clears the
 * current-user pill that sits just above the member sheet. Left/right keep
 * avatar markers from clipping the screen edge.
 */
export const MAP_FIT_PADDING = {
  top: 72,
  right: 48,
  bottom: 88,
  left: 48,
} as const;

export interface MapPea {
  member: MemberRow;
  latitude?: number;
  longitude?: number;
  speed: number;
  accuracy?: number;
  online: boolean;
  lastSeen?: string;
  battery?: number;
  charging: boolean;
  connection?: string;
  distanceLabel: string;
  locationLabel: string;
  lastSeenLabel: string;
  isMe: boolean;
}

export function presenceFor(list: PresenceRow[], userId: string): PresenceRow | undefined {
  return list.find((row) => row.user_id === userId);
}

export function buildMapPeas(
  members: MemberRow[],
  presence: PresenceRow[],
  places: PlaceRow[],
  meId: string | undefined,
  myFix: LocalFix | null,
  now = Date.now(),
): MapPea[] {
  return members.map((member) => {
    const row = presenceFor(presence, member.id);
    const isMe = member.id === meId;
    const latitude = isMe && myFix ? myFix.latitude : row?.latitude;
    const longitude = isMe && myFix ? myFix.longitude : row?.longitude;
    const speed = isMe && myFix ? myFix.speed : row?.speed ?? 0;
    const lastSeen = row?.last_seen_at ?? row?.recorded_at ?? row?.updated_at;
    const atPlace =
      latitude != null && longitude != null
        ? nearestPlace({ latitude, longitude }, places)
        : null;

    let distanceLabel = '—';
    if (isMe) distanceLabel = 'You';
    else if (myFix && latitude != null && longitude != null) {
      distanceLabel = formatDistance(haversine(myFix.latitude, myFix.longitude, latitude, longitude));
    }

    const lastSeenText = lastSeen
      ? formatLastSeen(Math.max(0, now - new Date(lastSeen).getTime()))
      : isMe && myFix
        ? 'Just now'
        : 'No location yet';

    const locationLabel = atPlace
      ? `At ${atPlace.place.name}`
      : isMe && myFix
        ? 'Live location'
        : latitude != null && longitude != null
          ? 'Sharing location'
          : 'No location yet';

    return {
      member,
      latitude,
      longitude,
      speed,
      accuracy: row?.accuracy,
      online: isMe ? Boolean(myFix) : Boolean(row?.online),
      lastSeen,
      battery: row?.battery_level,
      charging: Boolean(row?.is_charging),
      connection: row?.connection_type,
      distanceLabel,
      locationLabel,
      lastSeenLabel: lastSeenText,
      isMe,
    };
  });
}

export function coordinateBounds(peas: MapPea[]): { latitude: number; longitude: number }[] {
  return peas.flatMap((pea) =>
    pea.latitude == null || pea.longitude == null
      ? []
      : [{ latitude: pea.latitude, longitude: pea.longitude }],
  );
}

/**
 * Width of one member card so two full cards and half of a third are visible.
 *
 * Visible strip: card + gap + card + gap + 0.5 card = 2.5 cards + 2 gaps.
 * Units: density-independent pixels.
 */
export function memberCarouselCardWidth(windowWidth: number): number {
  const horizontalPadding = MEMBER_CAROUSEL_PADDING * 2;
  return (windowWidth - horizontalPadding - 2 * MEMBER_CAROUSEL_GAP) / 2.5;
}

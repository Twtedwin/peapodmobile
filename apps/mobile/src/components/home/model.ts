/**
 * Pure view-model helpers for the live pod map.
 *
 * Keeping geometry and labels out of React makes map camera behaviour and
 * member cards deterministic and straightforward to test.
 */

import { formatDistance, haversine, lastSeenLabel, nearestPlace } from '@peapod/shared';

import type { LocalFix } from '@/hooks/useLocationPings';
import type { MemberRow, PlaceRow, PresenceRow } from '@/hooks/usePodData';

export const INVITE_CODE_PATTERN = /^[A-Z0-9]{6}$/;

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

    const seenLabel = lastSeen
      ? lastSeenLabel(Math.max(0, now - new Date(lastSeen).getTime()))
      : isMe && myFix
        ? 'now'
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
      locationLabel: atPlace
        ? `At ${atPlace.place.name} · ${seenLabel}`
        : isMe && myFix
          ? `Live location · ${seenLabel}`
          : seenLabel,
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

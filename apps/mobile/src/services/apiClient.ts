/**
 * Peapod's public network and data boundary.
 *
 * Every screen, hook, foreground watcher, and background task imports this
 * module. HTTP and WebSocket traffic share EXPO_PUBLIC_API_URL; the WebSocket
 * scheme is derived automatically. Endpoint paths and transport payloads live
 * here so UI components do not depend on the future database implementation.
 */

import {
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  asArray,
  authGet,
  authPatch,
  authPost,
  request,
  unwrap,
} from '@/api/client';
import { subscribeRealtime } from '@/api/realtime';
import type {
  LocationData,
  Message,
  PhoneStatus,
  Place,
  Pod,
  PodMember,
  Presence,
} from '@/models/api';

export * from '@/api/client';
export type { RealtimeEvent } from '@/api/realtime';
export { subscribeRealtime };
export type {
  AuthenticatedUser,
  LocationData,
  Message,
  PhoneStatus,
  Place,
  Pod,
  PodMember,
  Presence,
  User,
} from '@/models/api';

type RawPresence = Presence & {
  ping?: Partial<LocationData> & { created_at?: string; updated_at?: string } | null;
  phone_status?: PhoneStatus | null;
};

export function normalizeMember(raw: PodMember): PodMember {
  const user = raw.user;
  const userId = raw.user_id || user?.id || raw.id || '';
  return {
    ...raw,
    id: userId,
    membership_id: raw.membership_id || raw.id || '',
    user_id: userId,
    display_name: raw.display_name || user?.display_name || 'Pea',
    avatar_url: raw.avatar_url ?? user?.avatar_url ?? null,
    email: raw.email || user?.email,
    role: raw.role === 'admin' ? 'admin' : 'member',
  };
}

function normalizePresence(row: RawPresence): Presence {
  return {
    ...row,
    latitude: row.latitude ?? row.ping?.latitude,
    longitude: row.longitude ?? row.ping?.longitude,
    speed: row.speed ?? row.ping?.speed,
    accuracy: row.accuracy ?? row.ping?.accuracy,
    heading: row.heading ?? row.ping?.heading,
    recorded_at: row.recorded_at ?? row.ping?.created_at,
    updated_at: row.updated_at ?? row.ping?.updated_at,
    battery_level: row.battery_level ?? row.phone_status?.battery_level,
    is_charging: row.is_charging ?? row.phone_status?.is_charging,
    connection_type: row.connection_type ?? row.phone_status?.connection_type,
    signal_bars: row.signal_bars ?? row.phone_status?.signal_bars,
  };
}

export function normalizePresenceList(raw: unknown): Presence[] {
  const unwrapped = unwrap<unknown>(raw, ['presence', 'items', 'data']);
  if (Array.isArray(unwrapped)) return (unwrapped as RawPresence[]).map(normalizePresence);
  if (unwrapped && typeof unwrapped === 'object') {
    return Object.entries(unwrapped as Record<string, unknown>)
      .filter(([, value]) => value && typeof value === 'object')
      .map(([user_id, value]) =>
        normalizePresence({ user_id, ...(value as object) } as RawPresence),
      );
  }
  return [];
}

export const apiClient = {
  request,
  get: apiGet,
  post: apiPost,
  patch: apiPatch,
  delete: apiDelete,
  auth: {
    get: authGet,
    post: authPost,
    patch: authPatch,
  },
  realtime: {
    subscribeToPod: subscribeRealtime,
  },
  pods: {
    list: async () =>
      asArray<Pod>(unwrap(await apiGet<unknown>('/pods'), ['pods', 'items', 'data'])),
    members: async (podId: string) =>
      asArray<PodMember>(
        unwrap(await apiGet<unknown>(`/pods/${podId}/members`), ['members', 'items', 'data']),
      ).map(normalizeMember),
    presence: async (podId: string) =>
      normalizePresenceList(await apiGet<unknown>(`/pods/${podId}/presence`)),
    places: async (podId: string) =>
      asArray<Place>(
        unwrap(await apiGet<unknown>(`/pods/${podId}/places`), ['places', 'items', 'data']),
      ),
    create: (body: { name: string; emoji?: string; group_type?: Pod['group_type'] }) =>
      apiPost<Pod>('/pods', body),
    join: (code: string) => apiPost<{ pod: Pod }>('/pods/join', { code }),
    sendMessage: (podId: string, text: string) =>
      apiPost<Message>(`/pods/${podId}/messages`, {
        text,
        recipient_id: null,
        pod_id: podId,
      }),
    messages: async (podId: string, recipientId?: string | null) => {
      const query = recipientId ? `?recipient_id=${encodeURIComponent(recipientId)}` : '';
      return asArray<Message>(
        unwrap(await apiGet<unknown>(`/pods/${podId}/messages${query}`), ['messages', 'items', 'data']),
      );
    },
    nudge: (podId: string, recipientId: string) =>
      apiPost(`/pods/${podId}/nudges`, { recipient_id: recipientId }),
  },
  location: {
    sendPing: (podId: string, location: LocationData & { is_driving: boolean }) =>
      apiPost('/location/pings', {
        latitude: location.latitude,
        longitude: location.longitude,
        speed: location.speed,
        accuracy: location.accuracy,
        heading: location.heading,
        is_driving: location.is_driving,
        pod_id: podId,
      }),
    sendPhoneStatus: (podId: string, status: PhoneStatus & {
      battery_supported: boolean;
      connection_supported: boolean;
    }) => apiPost(`/pods/${podId}/phone-status`, status),
  },
  directMessages: {
    list: async (userId: string) =>
      asArray<Message>(
        unwrap(await apiGet<unknown>(`/direct-messages/${userId}`), ['messages', 'items', 'data']),
      ),
    send: (userId: string, text: string) =>
      apiPost<Message>(`/direct-messages/${userId}`, { text }),
  },
  payload: {
    asArray,
    unwrap,
  },
} as const;

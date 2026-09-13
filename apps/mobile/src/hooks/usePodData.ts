/**
 * MODULE: apps/mobile/src/hooks/usePodData.ts
 *
 * PURPOSE
 *   Shared React Query hooks for the current pod. One file so cache keys
 *   (`['pod', id, 'members']` etc.) cannot drift between Home, Plans, and You.
 *
 * INPUTS  : currentPodId from the session store
 * OUTPUTS : query objects
 * CONSUMED BY : tab screens and the trip wizard
 */

import { useQuery } from '@tanstack/react-query';

import type { Place, Pod, PodMember, Presence } from '@/models/api';
import {
  apiClient,
  apiGet,
  asArray,
  normalizeMember,
  normalizePresenceList,
  unwrap,
} from '@/services/apiClient';
import { useSession } from '@/store/session';

export type MemberRow = PodMember;
export type PodRow = Pod;
export type PlaceRow = Place;
export type PresenceRow = Presence;
export { normalizeMember, normalizePresenceList };

function podPath(podId: string, suffix: string): string {
  return `/pods/${podId}${suffix}`;
}

export function useCurrentPodId(): string | null {
  return useSession((s) => s.currentPodId);
}

export function useMembers(podId: string | null) {
  return useQuery({
    queryKey: ['pod', podId, 'members'],
    enabled: Boolean(podId),
    queryFn: () => apiClient.pods.members(podId!),
  });
}

export function usePresence(podId: string | null) {
  return useQuery({
    queryKey: ['pod', podId, 'presence'],
    enabled: Boolean(podId),
    refetchInterval: 15_000,
    queryFn: () => apiClient.pods.presence(podId!),
  });
}

export function usePods() {
  return useQuery({
    queryKey: ['pods'],
    queryFn: () => apiClient.pods.list(),
  });
}

export function usePlaces(podId: string | null) {
  return useQuery({
    queryKey: ['pod', podId, 'places'],
    enabled: Boolean(podId),
    queryFn: () => apiClient.pods.places(podId!),
  });
}

export function usePlans(podId: string | null) {
  return useQuery({
    queryKey: ['pod', podId, 'plans'],
    enabled: Boolean(podId),
    queryFn: async () => {
      const raw = await apiGet<unknown>(podPath(podId!, '/plans'));
      return asArray(unwrap(raw, ['plans', 'items', 'data']));
    },
  });
}

export function useTrips(podId: string | null) {
  return useQuery({
    queryKey: ['pod', podId, 'trips'],
    enabled: Boolean(podId),
    queryFn: async () => {
      const raw = await apiGet<unknown>(podPath(podId!, '/trips'));
      return asArray(unwrap(raw, ['trips', 'items', 'data']));
    },
  });
}

export function useIdeas(podId: string | null) {
  return useQuery({
    queryKey: ['pod', podId, 'ideas'],
    enabled: Boolean(podId),
    queryFn: async () => {
      const raw = await apiGet<unknown>(podPath(podId!, '/ideas'));
      return asArray(unwrap(raw, ['ideas', 'items', 'data']));
    },
  });
}

export function useWorld(podId: string | null) {
  return useQuery({
    queryKey: ['pod', podId, 'world'],
    enabled: Boolean(podId),
    queryFn: async () => apiGet<unknown>(podPath(podId!, '/world')),
  });
}

export function useGarden(podId: string | null) {
  return useQuery({
    queryKey: ['pod', podId, 'garden'],
    enabled: Boolean(podId),
    queryFn: async () => {
      const raw = await apiGet<unknown>(podPath(podId!, '/garden'));
      return asArray(unwrap(raw, ['garden', 'entries', 'items', 'data']));
    },
  });
}

export function useWallet(podId: string | null) {
  return useQuery({
    queryKey: ['pod', podId, 'wallet'],
    enabled: Boolean(podId),
    queryFn: async () => apiGet<unknown>(podPath(podId!, '/wallet')),
  });
}

export function useNotifications(podId: string | null) {
  return useQuery({
    queryKey: ['pod', podId, 'notifications'],
    enabled: Boolean(podId),
    queryFn: async () => {
      const raw = await apiGet<unknown>('/notifications');
      return asArray<Record<string, unknown>>(unwrap(raw, ['notifications', 'items', 'data']))
        .filter((row) => row.pod_id == null || row.pod_id === podId);
    },
  });
}

export function useMessages(podId: string | null, recipientId?: string | null) {
  return useQuery({
    queryKey: ['pod', podId, 'messages', recipientId ?? 'group'],
    enabled: Boolean(podId),
    refetchInterval: 8_000,
    queryFn: () => apiClient.pods.messages(podId!, recipientId),
  });
}

/** Pod-independent private history between the caller and one other user. */
export function useDirectMessages(userId: string | null) {
  return useQuery({
    queryKey: ['direct-messages', userId],
    enabled: Boolean(userId),
    refetchInterval: 5_000,
    queryFn: () => apiClient.directMessages.list(userId!),
  });
}

export function useBucketList(podId: string | null) {
  return useQuery({
    queryKey: ['pod', podId, 'bucket-list'],
    enabled: Boolean(podId),
    queryFn: async () => {
      const raw = await apiGet<unknown>(podPath(podId!, '/bucket-list'));
      return asArray(unwrap(raw, ['items', 'bucket_list', 'data']));
    },
  });
}

export function useDateActivities(podId: string | null) {
  return useQuery({
    queryKey: ['pod', podId, 'date-activities'],
    enabled: Boolean(podId),
    queryFn: async () => {
      const raw = await apiGet<unknown>(podPath(podId!, '/date-activities'));
      return asArray(unwrap(raw, ['activities', 'items', 'data']));
    },
  });
}

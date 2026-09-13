import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-constants', () => ({
  default: { expoConfig: { extra: { apiUrl: 'http://api.test:8080' } } },
}));

vi.mock('@/store/session', () => ({
  useSession: Object.assign(vi.fn(), {
    getState: () => ({ accessToken: null }),
  }),
}));

import { normalizeMember, normalizePresenceList } from '@/hooks/usePodData';

describe('pod API normalization', () => {
  it('uses the profile id while retaining the membership id', () => {
    expect(
      normalizeMember({
        id: 'membership-1',
        membership_id: '',
        user_id: 'user-1',
        display_name: '',
        user: { id: 'user-1', display_name: 'Alex' },
      }),
    ).toMatchObject({
      id: 'user-1',
      membership_id: 'membership-1',
      display_name: 'Alex',
    });
  });

  it('flattens nested ping and phone status data for the map', () => {
    expect(
      normalizePresenceList([
        {
          user_id: 'user-1',
          online: true,
          last_seen_at: '2026-09-13T12:00:00.000Z',
          ping: { latitude: 1.35, longitude: 103.82, speed: 4, created_at: 'ping-time' },
          phone_status: { battery_level: 72, connection_type: 'wifi' },
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        user_id: 'user-1',
        latitude: 1.35,
        longitude: 103.82,
        speed: 4,
        recorded_at: 'ping-time',
        battery_level: 72,
        connection_type: 'wifi',
      }),
    ]);
  });
});

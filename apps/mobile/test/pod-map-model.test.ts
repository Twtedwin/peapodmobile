import { describe, expect, it } from 'vitest';

import {
  buildMapPeas,
  coordinateBounds,
  INVITE_CODE_PATTERN,
} from '@/components/home/model';
import { trackingMode } from '@/location/trackingPolicy';

const member = {
  id: 'user-1',
  membership_id: 'membership-1',
  user_id: 'user-1',
  display_name: 'Alex',
};

describe('pod map view model', () => {
  it('accepts exactly six alphanumeric invite characters', () => {
    expect(INVITE_CODE_PATTERN.test('ABC123')).toBe(true);
    expect(INVITE_CODE_PATTERN.test('ABCDE')).toBe(false);
    expect(INVITE_CODE_PATTERN.test('ABC-12')).toBe(false);
    expect(INVITE_CODE_PATTERN.test('abc123')).toBe(false);
  });

  it('builds current-user distance and camera coordinates', () => {
    const peas = buildMapPeas(
      [member],
      [],
      [],
      'user-1',
      { latitude: 1.35, longitude: 103.82, speed: 2, accuracy: 5, heading: 0 },
      0,
    );

    expect(peas[0]).toMatchObject({
      isMe: true,
      online: true,
      distanceLabel: 'You',
      latitude: 1.35,
      longitude: 103.82,
    });
    expect(coordinateBounds(peas)).toEqual([{ latitude: 1.35, longitude: 103.82 }]);
  });

  it('keeps Expo Go foreground-only and native builds background-capable', () => {
    expect(trackingMode('expo')).toBe('foreground-only');
    expect(trackingMode('standalone')).toBe('background-capable');
  });
});

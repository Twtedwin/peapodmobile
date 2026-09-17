import { describe, expect, it } from 'vitest';

import { formatDistance, haversine } from '@peapod/shared';

import {
  buildMapPeas,
  coordinateBounds,
  INVITE_CODE_PATTERN,
  MEMBER_CAROUSEL_GAP,
  MEMBER_CAROUSEL_PADDING,
  memberCarouselCardWidth,
} from '@/components/home/model';
import { trackingMode } from '@/location/trackingPolicy';

const member = {
  id: 'user-1',
  membership_id: 'membership-1',
  user_id: 'user-1',
  display_name: 'Alex',
};

const other = {
  id: 'user-2',
  membership_id: 'membership-2',
  user_id: 'user-2',
  display_name: 'Sam',
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
      locationLabel: 'Live location',
      lastSeenLabel: 'Just now',
      latitude: 1.35,
      longitude: 103.82,
    });
    expect(coordinateBounds(peas)).toEqual([{ latitude: 1.35, longitude: 103.82 }]);
  });

  it('labels haversine distance between the current user and another pea', () => {
    const peas = buildMapPeas(
      [member, other],
      [{ user_id: 'user-2', latitude: 1.35, longitude: 104.82, speed: 0 }],
      [],
      'user-1',
      { latitude: 1.35, longitude: 103.82, speed: 0, accuracy: 5, heading: 0 },
      0,
    );

    const metres = haversine(1.35, 103.82, 1.35, 104.82);
    expect(peas[0]?.distanceLabel).toBe('You');
    expect(peas[1]?.distanceLabel).toBe(formatDistance(metres));
    expect(peas[1]?.distanceLabel).not.toBe('You');
    expect(peas[1]?.distanceLabel).not.toBe('—');
    expect(peas[1]?.locationLabel).toBe('Sharing location');
  });

  it('sizes carousel cards so two full cards and half of a third are visible', () => {
    const windowWidth = 390;
    const width = memberCarouselCardWidth(windowWidth);
    expect(width).toBe(
      (windowWidth - MEMBER_CAROUSEL_PADDING * 2 - 2 * MEMBER_CAROUSEL_GAP) / 2.5,
    );
    expect(2.5 * width + 2 * MEMBER_CAROUSEL_GAP + MEMBER_CAROUSEL_PADDING * 2).toBe(
      windowWidth,
    );
  });

  it('keeps Expo Go foreground-only and native builds background-capable', () => {
    expect(trackingMode('expo')).toBe('foreground-only');
    expect(trackingMode('standalone')).toBe('background-capable');
  });
});

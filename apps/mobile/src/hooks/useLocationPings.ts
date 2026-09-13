/**
 * MODULE: apps/mobile/src/hooks/useLocationPings.ts
 *
 * PURPOSE
 *   Watches GPS while the Home tab is mounted and POSTs a ping whenever the
 *   member has moved past the shared movement threshold (or the heartbeat
 *   interval has elapsed). Uses expo-location, which ships in Expo Go.
 *
 * INPUTS  : current pod id, GEO thresholds from @peapod/shared
 * OUTPUTS : the last known coordinate (for the local marker)
 * CONSUMED BY : the Home tab
 */

import { useEffect, useRef, useState } from 'react';
import * as Battery from 'expo-battery';
import * as Location from 'expo-location';
import * as Network from 'expo-network';
import { GEO, haversine, isDriving } from '@peapod/shared';

import { startBackgroundLocation } from '@/location/backgroundLocation';
import { apiClient } from '@/services/apiClient';

export interface LocalFix {
  latitude: number;
  longitude: number;
  speed: number;
  accuracy: number;
  heading: number;
}

export function batteryPercent(level: number): number {
  return Math.max(0, Math.min(100, Math.round(level * 100)));
}

async function postPhoneStatus(podId: string): Promise<void> {
  const [level, state, network] = await Promise.all([
    Battery.getBatteryLevelAsync(),
    Battery.getBatteryStateAsync(),
    Network.getNetworkStateAsync(),
  ]);
  const batterySupported = level >= 0;
  const connectionType = String(network.type ?? 'UNKNOWN').toLowerCase();

  await apiClient.location.sendPhoneStatus(podId, {
    battery_level: batterySupported ? batteryPercent(level) : 0,
    is_charging: state === Battery.BatteryState.CHARGING || state === Battery.BatteryState.FULL,
    connection_type: connectionType,
    battery_supported: batterySupported,
    connection_supported: network.isConnected != null,
  });
}

export function useLocationPings(podId: string | null): LocalFix | null {
  const [fix, setFix] = useState<LocalFix | null>(null);
  const lastSent = useRef<{ lat: number; lng: number; at: number } | null>(null);

  useEffect(() => {
    if (!podId) return;
    let sub: Location.LocationSubscription | null = null;
    let cancelled = false;

    (async () => {
      const existing = await Location.getForegroundPermissionsAsync();
      if (existing.status !== 'granted') return;

      // Expo Go returns foreground-only; native EAS builds request "always"
      // access and register the persistent OS task.
      await startBackgroundLocation().catch(() => undefined);
      await postPhoneStatus(podId).catch(() => undefined);

      sub = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.Balanced,
          timeInterval: GEO.heartbeatInterval_ms,
          distanceInterval: GEO.minMovementToPing_m,
        },
        async (position) => {
          if (cancelled) return;
          const { latitude, longitude, speed, accuracy, heading } = position.coords;
          const next: LocalFix = {
            latitude,
            longitude,
            speed: speed ?? 0,
            accuracy: accuracy ?? 0,
            heading: heading ?? 0,
          };
          setFix(next);

          const now = Date.now();
          const prev = lastSent.current;
          const moved = prev
            ? haversine(prev.lat, prev.lng, latitude, longitude) >= GEO.minMovementToPing_m
            : true;
          const heartbeat = prev ? now - prev.at >= GEO.heartbeatInterval_ms : true;
          if (!moved && !heartbeat) return;

          lastSent.current = { lat: latitude, lng: longitude, at: now };
          try {
            await apiClient.location.sendPing(podId, {
              latitude,
              longitude,
              speed: next.speed,
              accuracy: next.accuracy,
              heading: next.heading,
              is_driving: isDriving(next.speed),
            });
          } catch {
            // A missed ping is not worth a red screen; the next watch tick retries.
          }
        },
      );
    })();

    return () => {
      cancelled = true;
      sub?.remove();
    };
  }, [podId]);

  useEffect(() => {
    if (!podId) return;
    const timer = setInterval(() => {
      void postPhoneStatus(podId).catch(() => undefined);
    }, GEO.heartbeatInterval_ms);
    return () => clearInterval(timer);
  }, [podId]);

  return fix;
}

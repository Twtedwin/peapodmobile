/**
 * MODULE: apps/mobile/src/location/backgroundLocation
 *
 * PURPOSE
 *   Registers the native background-location task at module scope and exposes
 *   lifecycle helpers used by the foreground hook. Expo Go deliberately falls
 *   back to foreground-only tracking; development and store builds continue
 *   sending heartbeat pings while the app is backgrounded.
 *
 * INPUTS  : encrypted session, expo-location task events
 * OUTPUTS : POST /location/pings
 * CALLED BY: apps/mobile/index.ts and useLocationPings
 */

import Constants from 'expo-constants';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { isDriving } from '@peapod/shared';

import { apiClient } from '@/services/apiClient';
import { hydrateSessionForTask, useSession } from '@/store/session';
import { trackingMode } from './trackingPolicy';

export const BACKGROUND_LOCATION_TASK = 'peapod-background-location';

type LocationTaskData = { locations?: Location.LocationObject[] };

TaskManager.defineTask<LocationTaskData>(BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
  if (error || !data?.locations?.length) return;

  await hydrateSessionForTask();
  const { accessToken, currentPodId } = useSession.getState();
  if (!accessToken || !currentPodId) return;

  const position = data.locations[data.locations.length - 1];
  if (!position) return;
  const { latitude, longitude, speed, accuracy, heading } = position.coords;

  try {
    await apiClient.location.sendPing(currentPodId, {
      latitude,
      longitude,
      speed: speed ?? 0,
      accuracy: accuracy ?? 0,
      heading: heading ?? 0,
      is_driving: isDriving(speed ?? 0),
    });
  } catch {
    // The next native heartbeat retries. Background jobs must never crash the app.
  }
});

/** Expo Go cannot execute background location tasks on current SDKs. */
export function supportsBackgroundLocation(): boolean {
  const ownership = (Constants as unknown as { appOwnership?: string }).appOwnership;
  return trackingMode(ownership) === 'background-capable';
}

export async function startBackgroundLocation(): Promise<'started' | 'foreground-only' | 'denied'> {
  if (!supportsBackgroundLocation()) return 'foreground-only';

  const foreground = await Location.getForegroundPermissionsAsync();
  if (foreground.status !== 'granted') return 'denied';

  const background = await Location.requestBackgroundPermissionsAsync();
  if (background.status !== 'granted') return 'denied';

  const alreadyStarted = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
  if (!alreadyStarted) {
    await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
      accuracy: Location.Accuracy.Balanced,
      distanceInterval: 25,
      deferredUpdatesDistance: 25,
      deferredUpdatesInterval: 4 * 60 * 1000,
      pausesUpdatesAutomatically: false,
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: 'Peapod location sharing',
        notificationBody: 'Your current pod can see your live location.',
        notificationColor: '#7CDB6A',
      },
    });
  }
  return 'started';
}

export async function stopBackgroundLocation(): Promise<void> {
  if (!supportsBackgroundLocation()) return;
  if (await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK)) {
    await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
  }
}

/**
 * MODULE: apps/mobile/src/notifications.ts
 *
 * PURPOSE
 *   Ask for notification permission without importing `expo-notifications`
 *   while running inside Expo Go.
 *
 * WHY THIS FILE EXISTS
 *   From SDK 53, Expo Go no longer includes Android remote-push native code.
 *   Importing `expo-notifications` in Go loads DevicePushTokenAutoRegistration,
 *   which throws and takes the permissions screen down with it. In Expo Go we
 *   skip that import entirely; a later EAS/dev-client build still gets the
 *   real permission prompt.
 *
 * INPUTS  : none
 * OUTPUTS : void (declined or unsupported is not an error)
 * CONSUMED BY : apps/mobile/app/permissions.tsx
 */

import Constants, { ExecutionEnvironment } from 'expo-constants';

/** True when the JS is running inside the Expo Go client, not a store/dev build. */
const isExpoGo =
  Constants.executionEnvironment === ExecutionEnvironment.StoreClient ||
  Constants.appOwnership === 'expo';

/**
 * Request OS notification permission when the native module exists.
 * No-ops in Expo Go so the rest of onboarding can continue.
 */
export async function requestNotificationPermission(): Promise<void> {
  if (isExpoGo) return;
  const Notifications = await import('expo-notifications');
  await Notifications.requestPermissionsAsync();
}

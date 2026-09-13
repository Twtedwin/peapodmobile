/**
 * FILE: apps/mobile/index.ts
 *
 * PURPOSE
 *   App entry used by Expo (`"main"` in package.json). Installs the keep-awake
 *   guard before expo-router loads, because expo-router is what first calls
 *   activateKeepAwakeAsync during development.
 */

import '@/keepAwakeGuard';
// Background tasks must be defined before React mounts so the OS can launch
// them in a headless JavaScript context.
import '@/location/backgroundLocation';
import 'expo-router/entry';

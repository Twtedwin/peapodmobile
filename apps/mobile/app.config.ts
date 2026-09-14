/**
 * FILE: apps/mobile/app.config.ts
 *
 * PURPOSE
 *   The Expo application manifest. Everything the OS needs to know about the
 *   app before any JavaScript runs: its identity, its icons, the permission
 *   strings the user is shown, and the handful of values the JavaScript wants
 *   to read back at runtime.
 *
 * INPUTS
 *   - process.env.EXPO_PUBLIC_API_URL : base URL of services/api. Anything
 *     prefixed EXPO_PUBLIC_ is inlined into the bundle by Metro, so it is
 *     readable on the device. Never put a secret in one. Auth (`/auth/*`) is
 *     the same origin; the API proxies it to the security service.
 *   - Realtime derives its ws/wss origin from EXPO_PUBLIC_API_URL so HTTP and
 *     WebSocket traffic cannot accidentally point at different deployments.
 *   - process.env.GOOGLE_MAPS_IOS_API_KEY / GOOGLE_MAPS_ANDROID_API_KEY :
 *     optional, see the MAPS section below.
 *
 * OUTPUTS
 *   An ExpoConfig object. Expo CLI calls the default export at start/build time.
 *
 * CONSUMED BY
 *   - Expo CLI and EAS Build (the whole file)
 *
 * WHY .ts AND NOT app.json
 *   A static app.json cannot read environment variables. The API URL differs
 *   between a laptop on a home network, a preview build, and production, and
 *   baking it into a committed JSON file would mean editing that file to run
 *   the app - which is exactly how a wrong URL ends up committed.
 */

import type { ExpoConfig } from 'expo/config';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Asset paths must be relative to the Expo project root, which in this
 * monorepo is the repository root (EAS and `npx expo prebuild` both run
 * there). `./assets/splash.png` would look at `<repo>/assets/splash.png`
 * and miss the real files. Resolve from this file against the repo root so
 * the path is always `./apps/mobile/assets/<file>`, independent of cwd.
 */
const mobileDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(mobileDirectory, '../..');
const asset = (fileName: string): string =>
  `./${relative(repoRoot, resolve(mobileDirectory, 'assets', fileName)).replaceAll('\\', '/')}`;

const icon = asset('icon.png');
const adaptiveIcon = asset('adaptive-icon.png');
const splashImage = asset('splash.png');

// ---------------------------------------------------------------------------
// MAPS - PLACEHOLDER API KEYS
// ---------------------------------------------------------------------------
// react-native-maps can render with either the platform's own map provider or
// with Google Maps. Google Maps needs a per-platform API key, which is a
// billable credential and therefore is NOT committed here.
//
// Both keys are documented in SETUP-EXTERNAL-APIS.md at the repository root.
// Supply them as environment variables (or as EAS build secrets) and they are
// picked up automatically:
//
//     GOOGLE_MAPS_IOS_API_KEY=...
//     GOOGLE_MAPS_ANDROID_API_KEY=...
//
// WITHOUT THEM THE APP STILL WORKS. When a key is absent the config below
// omits it entirely and react-native-maps falls back to the platform default
// provider - Apple Maps on iOS, and on Android the map surface supplied by
// Expo Go itself. Every marker, polyline and camera call in
// src/components/map/ is written against the provider-agnostic API, so nothing
// in the app changes shape when a key is later added.
// ---------------------------------------------------------------------------
const googleMapsIosApiKey = process.env.GOOGLE_MAPS_IOS_API_KEY;
const googleMapsAndroidApiKey = process.env.GOOGLE_MAPS_ANDROID_API_KEY;

const config: ExpoConfig = {
  name: 'Peapod',
  slug: 'peapod',
  scheme: 'peapod',
  version: '1.0.0',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  icon,
  // SDK 57 / React Native 0.86 always use the New Architecture, so the former
  // `newArchEnabled` opt-in is no longer a valid manifest field.

  // The splash screen is configured through the expo-splash-screen plugin
  // below rather than a top-level `splash` key, which SDK 54 supersedes.
  // Placeholder PNGs live in apps/mobile/assets; replace them with branded
  // artwork when it exists. A missing path is a hard prebuild failure.

  ios: {
    bundleIdentifier: 'app.peapod.mobile',
    supportsTablet: false,
    // buildNumber is deliberately NOT set here. EAS owns it - see the
    // `autoIncrement` flags in eas.json. Hardcoding it means two builds can
    // share a number, and App Store Connect rejects the second one.
    infoPlist: {
      // Every one of these strings is shown verbatim in the iOS permission
      // dialog. A missing string is an App Store rejection, and a vague one is
      // a permission the user declines.
      NSLocationWhenInUseUsageDescription:
        'Peapod shares your live location with your pod so you can see where each other are, and tells you when a pea arrives at or leaves a saved place.',
      NSLocationAlwaysAndWhenInUseUsageDescription:
        'Peapod keeps your pod up to date with your location while the app is in the background, so arrival and departure alerts still reach them when your phone is in your pocket.',
      NSPhotoLibraryUsageDescription:
        'Peapod needs your photo library so you can choose a profile picture and add photos to the memories your pod shares.',
      NSCameraUsageDescription:
        'Peapod needs the camera so you can take a profile picture or capture a photo for a memory without leaving the app.',
      // Non-exempt encryption: the app uses only HTTPS, which is exempt. Saying
      // so up front skips an export-compliance question on every TestFlight
      // upload.
      ITSAppUsesNonExemptEncryption: false,
    },
    // Only emit the `config` block when a key actually exists, so an absent key
    // means "use Apple Maps" rather than "use Google Maps with an empty key",
    // which renders a grey grid.
    ...(googleMapsIosApiKey
      ? { config: { googleMapsApiKey: googleMapsIosApiKey } }
      : {}),
  },

  android: {
    package: 'app.peapod.mobile',
    // versionCode is deliberately NOT set. EAS owns it - see eas.json. Google
    // Play rejects an upload whose versionCode is not strictly greater than the
    // last one, and a hand-maintained number gets that wrong eventually.
    adaptiveIcon: {
      foregroundImage: adaptiveIcon,
      backgroundColor: '#0F1512',
    },
    permissions: [
      // Fine location is what makes "Together" (a 100 m threshold) meaningful.
      'ACCESS_FINE_LOCATION',
      // Coarse is requested alongside it because Android 12+ lets the user grant
      // only approximate location; without this the app gets nothing at all
      // when they choose that option.
      'ACCESS_COARSE_LOCATION',
      // Native development/store builds keep the pod map current while the
      // app is backgrounded. Expo Go ignores these and stays foreground-only.
      'ACCESS_BACKGROUND_LOCATION',
      'FOREGROUND_SERVICE',
      'FOREGROUND_SERVICE_LOCATION',
      // Android 13+ requires an explicit runtime grant before any notification
      // can be posted.
      'POST_NOTIFICATIONS',
    ],
    ...(googleMapsAndroidApiKey
      ? { config: { googleMaps: { apiKey: googleMapsAndroidApiKey } } }
      : {}),
  },

  plugins: [
    // expo-router turns the app/ directory into the navigator tree.
    'expo-router',
    // Config plugins that only set Info.plist / AndroidManifest strings. None
    // of these adds native code, so Expo Go can still run the app: Expo Go
    // already contains every one of these modules, and the strings below are
    // only consumed by a real build.
    [
      'expo-location',
      {
        locationWhenInUsePermission:
          'Peapod shares your live location with your pod so you can see where each other are.',
        locationAlwaysAndWhenInUsePermission:
          'Peapod keeps your pod up to date while the app is in the background.',
        isIosBackgroundLocationEnabled: true,
        isAndroidBackgroundLocationEnabled: true,
        isAndroidForegroundServiceEnabled: true,
      },
    ],
    [
      'expo-image-picker',
      {
        photosPermission:
          'Peapod needs your photo library so you can choose a profile picture and add photos to shared memories.',
        cameraPermission:
          'Peapod needs the camera so you can take a profile picture or capture a memory.',
      },
    ],
    [
      'expo-splash-screen',
      {
        backgroundColor: '#0F1512',
        resizeMode: 'contain',
        image: splashImage,
        imageWidth: 200,
        android: {
          backgroundColor: '#0F1512',
          image: splashImage,
        },
      },
    ],
  ],

  experiments: {
    // Required by expo-router: it needs the bundler to emit route metadata.
    typedRoutes: false,
  },

  extra: {
    /**
     * True when at least one Google Maps key was supplied, so the map wrapper
     * can pick a provider without re-reading environment variables (they are
     * not available at runtime; only `extra` is).
     */
    hasGoogleMapsKey: Boolean(googleMapsIosApiKey ?? googleMapsAndroidApiKey),
    eas: {
      "projectId": "b0bb6413-d841-4ff2-9f55-1ec72c2a8172"
    },
  },
};

export default config;

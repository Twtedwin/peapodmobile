/**
 * FILE: app.config.ts (repository root)
 *
 * PURPOSE
 *   Let `npx expo start` from the monorepo root resolve the real Expo app in
 *   `apps/mobile`. Without this file (and the root `"main": "expo-router/entry"`),
 *   Expo treats the repo as a classic App.tsx project and fails with
 *   `Unable to resolve "../../App" from "node_modules/expo/AppEntry.js"`.
 *
 * WHY THIS IS A WRAPPER
 *   The canonical manifest lives in `apps/mobile/app.config.ts`. This file
 *   re-exports it and tells expo-router that the route tree is
 *   `apps/mobile/app`, not a non-existent `./app` at the repo root.
 */
import type { ExpoConfig } from 'expo/config';

import mobileConfig from './apps/mobile/app.config.ts';

function pluginsWithoutRouter(
  plugins: ExpoConfig['plugins'],
): NonNullable<ExpoConfig['plugins']> {
  return (plugins ?? []).filter((plugin) => {
    const name = Array.isArray(plugin) ? plugin[0] : plugin;
    return name !== 'expo-router';
  });
}

const config: ExpoConfig = {
  ...mobileConfig,
  plugins: [
    ['expo-router', { root: './apps/mobile/app' }],
    ...pluginsWithoutRouter(mobileConfig.plugins),
  ],
  extra: {
    ...mobileConfig.extra,
    // Expo CLI reads this (not the plugin `root` option) to set
    // transform.routerRoot. Without it, expo-router looks for ./app at the
    // repo root, finds nothing, and ships the onboarding tutorial instead.
    router: {
      ...(typeof mobileConfig.extra?.router === 'object' && mobileConfig.extra.router
        ? mobileConfig.extra.router
        : {}),
      root: './apps/mobile/app',
    },
  },
};

export default config;

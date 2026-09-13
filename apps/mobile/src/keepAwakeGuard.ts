/**
 * MODULE: apps/mobile/src/keepAwakeGuard.ts
 *
 * PURPOSE
 *   Stop Expo Go on Android from redboxing "Unable to activate keep awake".
 *
 * WHY THIS EXISTS
 *   Expo's dev client calls the native KeepAwake module so the screen stays
 *   on while Metro is connected. On some Android phones (and on every reload
 *   before the Activity is ready) that native call rejects. The rejection is
 *   unhandled, so it looks like signup or login crashed when it did not.
 *
 *   Wrapping `activate` here swallows only that native failure. The rest of
 *   the app is unchanged; the screen may dim in those cases, which is fine.
 *
 * INPUTS  : none (side-effect import)
 * OUTPUTS : none
 * CONSUMED BY : apps/mobile/index.ts, before expo-router/entry loads
 */

import { requireNativeModule } from 'expo';

try {
  const native = requireNativeModule('ExpoKeepAwake') as {
    activate?: (tag: string) => unknown;
  };
  const original = native.activate?.bind(native);
  if (original) {
    native.activate = (tag: string) => {
      try {
        const result = original(tag) as Promise<void> | void;
        if (result && typeof (result as Promise<void>).then === 'function') {
          return (result as Promise<void>).catch(() => undefined);
        }
        return result;
      } catch {
        return undefined;
      }
    };
  }
} catch {
  // Web, tests, or a binary without the module: nothing to wrap.
}

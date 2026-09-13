/**
 * MODULE: apps/mobile/src/store/session.ts
 *
 * PURPOSE
 *   The one piece of client state that outlives a screen: who is signed in,
 *   their tokens, which pod they are looking at, and whether the UI is dark.
 *   Tokens live in expo-secure-store so they survive process death without
 *   sitting in AsyncStorage (which is not encrypted on Android).
 *
 * INPUTS  : auth responses, SecureStore, the You-tab dark-mode toggle
 * OUTPUTS : a zustand store
 *
 * CONSUMED BY
 *   - app/_layout.tsx (hydrate on boot)
 *   - src/api/client.ts (read tokens, write rotated ones)
 *   - every screen that needs the current user or pod
 */

import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';

import type { AuthUser } from '@/services/apiClient';

const ACCESS_KEY = 'peapod.access_token';
const REFRESH_KEY = 'peapod.refresh_token';
const USER_KEY = 'peapod.user';
const POD_KEY = 'peapod.current_pod_id';
const DARK_KEY = 'peapod.dark_mode';

interface SessionState {
  hydrated: boolean;
  accessToken: string | null;
  refreshToken: string | null;
  user: AuthUser | null;
  currentPodId: string | null;
  darkMode: boolean;

  hydrate: () => Promise<void>;
  applyTokens: (access: string, refresh: string, user?: AuthUser) => Promise<void>;
  setUser: (user: AuthUser) => Promise<void>;
  setCurrentPodId: (podId: string | null) => Promise<void>;
  setDarkMode: (dark: boolean) => Promise<void>;
  signOut: () => Promise<void>;
}

async function write(key: string, value: string | null): Promise<void> {
  if (value == null || value === '') {
    await SecureStore.deleteItemAsync(key);
    return;
  }
  await SecureStore.setItemAsync(key, value);
}

export const useSession = create<SessionState>((set, get) => ({
  hydrated: false,
  accessToken: null,
  refreshToken: null,
  user: null,
  currentPodId: null,
  darkMode: true,

  /**
   * Reads SecureStore into memory. Called once from the root layout. A
   * missing or corrupt user blob is treated as signed-out, not as a crash.
   */
  hydrate: async () => {
    try {
      const [access, refresh, userJson, podId, dark] = await Promise.all([
        SecureStore.getItemAsync(ACCESS_KEY),
        SecureStore.getItemAsync(REFRESH_KEY),
        SecureStore.getItemAsync(USER_KEY),
        SecureStore.getItemAsync(POD_KEY),
        SecureStore.getItemAsync(DARK_KEY),
      ]);
      let user: AuthUser | null = null;
      if (userJson) {
        try {
          user = JSON.parse(userJson) as AuthUser;
        } catch {
          user = null;
        }
      }
      set({
        accessToken: access,
        refreshToken: refresh,
        user,
        currentPodId: podId,
        darkMode: dark !== 'false',
        hydrated: true,
      });
    } catch {
      set({ hydrated: true });
    }
  },

  applyTokens: async (access, refresh, user) => {
    await Promise.all([
      write(ACCESS_KEY, access),
      write(REFRESH_KEY, refresh),
      user ? write(USER_KEY, JSON.stringify(user)) : Promise.resolve(),
    ]);
    set({
      accessToken: access,
      refreshToken: refresh,
      user: user ?? get().user,
    });
  },

  setUser: async (user) => {
    await write(USER_KEY, JSON.stringify(user));
    set({ user });
  },

  setCurrentPodId: async (podId) => {
    await write(POD_KEY, podId);
    set({ currentPodId: podId });
  },

  setDarkMode: async (dark) => {
    await write(DARK_KEY, dark ? 'true' : 'false');
    set({ darkMode: dark });
  },

  signOut: async () => {
    // Remove the native foreground service immediately; otherwise Android can
    // keep showing location sharing after credentials have been erased.
    await import('@/location/backgroundLocation')
      .then(({ stopBackgroundLocation }) => stopBackgroundLocation())
      .catch(() => undefined);
    await Promise.all([
      write(ACCESS_KEY, null),
      write(REFRESH_KEY, null),
      write(USER_KEY, null),
      write(POD_KEY, null),
    ]);
    set({
      accessToken: null,
      refreshToken: null,
      user: null,
      currentPodId: null,
    });
  },
}));

/**
 * Populate the same encrypted session state inside a headless background task.
 * Native task launches do not mount the React tree, so the root layout cannot
 * be relied on to hydrate tokens before a location upload.
 */
export async function hydrateSessionForTask(): Promise<void> {
  await useSession.getState().hydrate();
}

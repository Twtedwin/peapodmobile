/**
 * MODULE: apps/mobile/app/_layout.tsx
 *
 * PURPOSE
 *   Root navigator. Wraps the tree in the providers every screen needs
 *   (gestures, React Query, safe area), hydrates the session from
 *   expo-secure-store, and refreshes /auth/me so a stale cached user cannot
 *   skip the permissions screen.
 *
 * INPUTS  : SecureStore tokens, GET /auth/me
 * OUTPUTS : the Stack
 * CONSUMED BY : Expo Router as the app entry layout
 */

import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { authGet, authPost, normaliseAuth, type AuthUser } from '@/services/apiClient';
import { Spinner } from '@/components/Spinner';
import { useSession } from '@/store/session';
import { themeColors } from '@/theme';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 10_000,
    },
  },
});

export default function RootLayout() {
  const hydrated = useSession((s) => s.hydrated);
  const hydrate = useSession((s) => s.hydrate);
  const accessToken = useSession((s) => s.accessToken);
  const refreshToken = useSession((s) => s.refreshToken);
  const setUser = useSession((s) => s.setUser);
  const applyTokens = useSession((s) => s.applyTokens);
  const signOut = useSession((s) => s.signOut);
  const darkMode = useSession((s) => s.darkMode);
  const colors = themeColors(darkMode);
  const [bootstrapped, setBootstrapped] = useState(false);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;

    (async () => {
      if (!accessToken) {
        if (!cancelled) setBootstrapped(true);
        return;
      }
      try {
        const me = await authGet<unknown>('/auth/me');
        const user = normaliseAuth({ user: me }).user;
        if (!cancelled && user.id) await setUser(user);
      } catch {
        // Access token expired: try one refresh before giving up. The fetch
        // wrapper also refreshes on 401, but /auth/me is anonymous-false and
        // may 401 before the wrapper's retry if the service is down.
        if (refreshToken) {
          try {
            const raw = await authPost<unknown>('/auth/refresh', { refresh_token: refreshToken }, true);
            const pair = normaliseAuth(raw);
            if (pair.access_token) {
              await applyTokens(pair.access_token, pair.refresh_token || refreshToken, pair.user.id ? pair.user : undefined);
              const me = await authGet<unknown>('/auth/me');
              const user = normaliseAuth({ user: me }).user as AuthUser;
              if (!cancelled && user.id) await setUser(user);
            } else if (!cancelled) {
              await signOut();
            }
          } catch {
            if (!cancelled) await signOut();
          }
        }
      } finally {
        if (!cancelled) setBootstrapped(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [hydrated, accessToken, refreshToken, applyTokens, setUser, signOut]);

  if (!hydrated || !bootstrapped) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
        <Spinner color={colors.accent} size={28} />
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.bg }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <StatusBar style={darkMode ? 'light' : 'dark'} />
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: colors.bg },
              animation: 'fade',
            }}
          />
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

/**
 * MODULE: apps/mobile/app/index.tsx
 *
 * PURPOSE
 *   Gatekeeper route. No token → login; token but permissions not granted →
 *   the location/notification screen; otherwise the tab shell.
 *
 * INPUTS  : session store
 * OUTPUTS : a Redirect
 * CONSUMED BY : Expo Router as the `/` route
 */

import { Redirect } from 'expo-router';
import { View } from 'react-native';

import { Spinner } from '@/components/Spinner';
import { useSession } from '@/store/session';
import { themeColors } from '@/theme';

export default function Index() {
  const hydrated = useSession((s) => s.hydrated);
  const accessToken = useSession((s) => s.accessToken);
  const user = useSession((s) => s.user);
  const dark = useSession((s) => s.darkMode);
  const colors = themeColors(dark);

  if (!hydrated) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
        <Spinner color={colors.accent} size={28} />
      </View>
    );
  }

  if (!accessToken) return <Redirect href="/login" />;
  if (!user?.permissions_granted) return <Redirect href="/permissions" />;
  return <Redirect href="/(tabs)" />;
}

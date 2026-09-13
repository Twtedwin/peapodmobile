/**
 * MODULE: apps/mobile/app/permissions.tsx
 *
 * PURPOSE
 *   Onboarding grant for foreground location and notifications. Marks
 *   `permissions_granted` on the user via PATCH /auth/me so `/` stops
 *   redirecting here. Skip is allowed: the flag is still set, because the
 *   product should not trap someone who declined the OS dialog.
 *
 * INPUTS  : expo-location, optional notification permission, PATCH /auth/me
 * OUTPUTS : updated user in session, redirect to tabs
 */

import { useState } from 'react';
import { Text, View } from 'react-native';
import { router } from 'expo-router';
import * as Location from 'expo-location';

import { authPatch, normaliseAuth } from '@/services/apiClient';
import { requestNotificationPermission } from '@/notifications';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { Screen } from '@/components/Screen';
import { useSession } from '@/store/session';
import { spacing, themeColors, type as typeScale } from '@/theme';

export default function PermissionsScreen() {
  const dark = useSession((s) => s.darkMode);
  const colors = themeColors(dark);
  const user = useSession((s) => s.user);
  const setUser = useSession((s) => s.setUser);
  const [busy, setBusy] = useState(false);

  async function markGranted() {
    try {
      const raw = await authPatch<unknown>('/auth/me', { permissions_granted: true });
      const next = normaliseAuth({ user: raw }).user;
      await setUser({
        ...(user ?? next),
        ...next,
        permissions_granted: true,
        id: next.id || user?.id || '',
        email: next.email || user?.email || '',
        display_name: next.display_name || user?.display_name || 'Pea',
      });
    } catch {
      if (user) {
        await setUser({ ...user, permissions_granted: true });
      }
    }
    router.replace('/(tabs)');
  }

  async function enable() {
    setBusy(true);
    try {
      await Location.requestForegroundPermissionsAsync();
    } catch {
      // Declined is fine; we still continue.
    }
    try {
      await requestNotificationPermission();
    } catch {
      // Declined, or Expo Go (no remote-push native module from SDK 53).
    }
    await markGranted();
    setBusy(false);
  }

  return (
    <Screen scroll>
      <Text style={{ fontSize: 48, marginTop: spacing.xxl }}>🛡️</Text>
      <Text style={[typeScale.hero, { color: colors.text, marginTop: spacing.md }]}>Stay in sync</Text>
      <Text style={[typeScale.body, { color: colors.textMuted, marginTop: spacing.sm }]}>
        Turn these on so you and your pod can see where each other are, and so plans still reach you.
      </Text>

      <View style={{ marginTop: spacing.xl, gap: spacing.md }}>
        <Card>
          <Text style={{ fontSize: 22 }}>📍</Text>
          <Text style={[typeScale.subtitle, { color: colors.text, marginTop: spacing.sm }]}>Location</Text>
          <Text style={[typeScale.body, { color: colors.textMuted, marginTop: spacing.xs }]}>
            Share your live location with your pod and get alerts at saved places.
          </Text>
        </Card>
        <Card>
          <Text style={{ fontSize: 22 }}>🔔</Text>
          <Text style={[typeScale.subtitle, { color: colors.text, marginTop: spacing.sm }]}>Notifications</Text>
          <Text style={[typeScale.body, { color: colors.textMuted, marginTop: spacing.xs }]}>
            Arrivals, plans, and important dates.
          </Text>
        </Card>
      </View>

      <View style={{ marginTop: spacing.xxl, gap: spacing.md }}>
        <Button label={busy ? 'Setting up…' : 'Enable & continue'} onPress={enable} loading={busy} />
        <Button label="Skip for now" variant="ghost" onPress={() => void markGranted()} disabled={busy} />
      </View>
    </Screen>
  );
}

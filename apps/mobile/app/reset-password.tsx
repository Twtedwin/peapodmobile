/**
 * MODULE: apps/mobile/app/reset-password.tsx
 *
 * PURPOSE
 *   Completes a password reset from the emailed link (`?token=`).
 *
 * INPUTS  : token query param, POST /auth/reset-password
 * OUTPUTS : redirect to login
 */

import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Link, router, useLocalSearchParams } from 'expo-router';

import { authPost } from '@/services/apiClient';
import { Button } from '@/components/Button';
import { Field } from '@/components/Field';
import { Screen } from '@/components/Screen';
import { useSession } from '@/store/session';
import { spacing, themeColors, type as typeScale } from '@/theme';

export default function ResetPasswordScreen() {
  const dark = useSession((s) => s.darkMode);
  const colors = themeColors(dark);
  const params = useLocalSearchParams<{ token?: string }>();
  const resetToken = typeof params.token === 'string' ? params.token : '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit() {
    setError('');
    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    setLoading(true);
    try {
      await authPost('/auth/reset-password', {
        token: resetToken,
        password,
      });
      router.replace('/login');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to reset password');
    } finally {
      setLoading(false);
    }
  }

  if (!resetToken) {
    return (
      <Screen>
        <Text style={{ fontSize: 48, marginTop: spacing.xxl }}>⚠️</Text>
        <Text style={[typeScale.hero, { color: colors.text, marginTop: spacing.md }]}>Invalid reset link</Text>
        <Text style={[typeScale.body, { color: colors.textMuted, marginTop: spacing.sm }]}>
          This password reset link is missing or invalid. Request a new one.
        </Text>
        <Link href="/forgot-password" asChild>
          <Pressable style={{ marginTop: spacing.xl }}>
            <Text style={{ color: colors.accent, fontWeight: '700' }}>Request a new link</Text>
          </Pressable>
        </Link>
      </Screen>
    );
  }

  return (
    <Screen scroll>
      <Text style={{ fontSize: 48, marginTop: spacing.xxl }}>🔒</Text>
      <Text style={[typeScale.hero, { color: colors.text, marginTop: spacing.md }]}>New password</Text>
      {error ? <Text style={{ color: colors.danger, marginTop: spacing.lg }}>{error}</Text> : null}
      <View style={{ marginTop: spacing.xl, gap: spacing.md }}>
        <Field label="New password" value={password} onChangeText={setPassword} secure autoFocus />
        <Field label="Confirm password" value={confirm} onChangeText={setConfirm} secure />
        <Button label="Save password" onPress={submit} loading={loading} disabled={!password} />
      </View>
    </Screen>
  );
}

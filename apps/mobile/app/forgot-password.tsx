/**
 * MODULE: apps/mobile/app/forgot-password.tsx
 *
 * PURPOSE
 *   Request a password-reset email. Success copy is the same for known and
 *   unknown addresses so the screen cannot mine the user table. Network and
 *   5xx failures are shown so a down API is not mistaken for a sent mail.
 *
 * INPUTS  : POST /auth/forgot-password
 * OUTPUTS : a confirmation message, or an error
 */

import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Link } from 'expo-router';

import { ApiError, authPost } from '@/services/apiClient';
import { Button } from '@/components/Button';
import { Field } from '@/components/Field';
import { Screen } from '@/components/Screen';
import { useSession } from '@/store/session';
import { spacing, themeColors, type as typeScale } from '@/theme';

export default function ForgotPasswordScreen() {
  const dark = useSession((s) => s.darkMode);
  const colors = themeColors(dark);
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    if (loading) return;
    const normalised = email.trim().toLowerCase();
    if (!normalised.includes('@')) {
      setError('Enter a valid email address');
      return;
    }
    setError('');
    setLoading(true);
    try {
      await authPost('/auth/forgot-password', { email: normalised });
      setSent(true);
    } catch (cause) {
      if (cause instanceof ApiError && (cause.status === 0 || cause.status >= 500)) {
        setError(cause.message);
      } else if (cause instanceof ApiError && cause.status === 400) {
        setError(cause.message);
      } else {
        // 2xx already succeeded. Other 4xx still look like success so this
        // screen cannot enumerate accounts.
        setSent(true);
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <Screen scroll>
      <Text style={{ fontSize: 48, marginTop: spacing.xxl }}>🔑</Text>
      <Text style={[typeScale.hero, { color: colors.text, marginTop: spacing.md }]}>Reset password</Text>
      <Text style={[typeScale.body, { color: colors.textMuted, marginTop: spacing.sm }]}>
        We will email a link if that address has an account.
      </Text>

      {error ? <Text style={{ color: colors.danger, marginTop: spacing.lg }}>{error}</Text> : null}

      {sent ? (
        <Text style={[typeScale.body, { color: colors.text, marginTop: spacing.xl }]}>
          If an account exists with that email, you will receive a password reset link shortly.
          Open it on this phone so Peapod can read the token.
        </Text>
      ) : (
        <View style={{ marginTop: spacing.xl, gap: spacing.md }}>
          <Field
            label="Email address"
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            keyboardType="email-address"
            autoCapitalize="none"
            autoFocus
          />
          <Button label="Send reset link" onPress={submit} loading={loading} disabled={!email.trim()} />
        </View>
      )}

      <Link href="/login" asChild>
        <Pressable style={{ marginTop: spacing.xxl }}>
          <Text style={{ color: colors.accent, fontWeight: '700' }}>Back to log in</Text>
        </Pressable>
      </Link>
    </Screen>
  );
}

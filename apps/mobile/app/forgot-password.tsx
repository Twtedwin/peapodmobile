/**
 * MODULE: apps/mobile/app/forgot-password.tsx
 *
 * PURPOSE
 *   Request a password-reset email. Always shows success so the endpoint
 *   cannot be used to mine which addresses exist.
 *
 * INPUTS  : POST /auth/forgot-password
 * OUTPUTS : a confirmation message
 */

import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Link } from 'expo-router';

import { authPost } from '@/services/apiClient';
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

  async function submit() {
    setLoading(true);
    try {
      await authPost('/auth/forgot-password', { email: email.trim().toLowerCase() });
    } catch {
      // Swallow: the copy below is the same either way, on purpose.
    } finally {
      setLoading(false);
      setSent(true);
    }
  }

  return (
    <Screen scroll>
      <Text style={{ fontSize: 48, marginTop: spacing.xxl }}>🔑</Text>
      <Text style={[typeScale.hero, { color: colors.text, marginTop: spacing.md }]}>Reset password</Text>
      <Text style={[typeScale.body, { color: colors.textMuted, marginTop: spacing.sm }]}>
        We will email a link if that address has an account.
      </Text>

      {sent ? (
        <Text style={[typeScale.body, { color: colors.text, marginTop: spacing.xl }]}>
          If an account exists with that email, you will receive a password reset link shortly.
        </Text>
      ) : (
        <View style={{ marginTop: spacing.xl, gap: spacing.md }}>
          <Field
            label="Email address"
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            keyboardType="email-address"
            autoFocus
          />
          <Button label="Send reset link" onPress={submit} loading={loading} disabled={!email} />
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

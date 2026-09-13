/**
 * MODULE: apps/mobile/app/register.tsx
 *
 * PURPOSE
 *   Create an account, then verify the emailed OTP on the same screen
 *   (inline, matching the original flow). Successful verify stores tokens
 *   and sends the user to the permissions screen.
 *
 * INPUTS  : POST /auth/register, POST /auth/verify-otp, POST /auth/resend-otp
 * OUTPUTS : tokens in session
 */

import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Link, router } from 'expo-router';

import { authPost, normaliseAuth } from '@/services/apiClient';
import { Button } from '@/components/Button';
import { Field } from '@/components/Field';
import { Screen } from '@/components/Screen';
import { useSession } from '@/store/session';
import { spacing, themeColors, type as typeScale } from '@/theme';

export default function RegisterScreen() {
  const dark = useSession((s) => s.darkMode);
  const colors = themeColors(dark);
  const applyTokens = useSession((s) => s.applyTokens);

  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [otp, setOtp] = useState('');
  const [showOtp, setShowOtp] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [info, setInfo] = useState('');

  async function register() {
    setError('');
    if (password.length < 10) {
      setError('Password must be at least 10 characters');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    setLoading(true);
    try {
      await authPost('/auth/register', {
        email: email.trim().toLowerCase(),
        password,
        display_name: displayName.trim() || email.split('@')[0],
      });
      setShowOtp(true);
      setInfo('We sent a 6-digit code. In development it is also printed in the security service logs.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Registration failed');
    } finally {
      setLoading(false);
    }
  }

  async function verify() {
    setError('');
    setLoading(true);
    try {
      const raw = await authPost<unknown>('/auth/verify-otp', {
        email: email.trim().toLowerCase(),
        code: otp.trim(),
        purpose: 'register',
      });
      const pair = normaliseAuth(raw);
      if (pair.access_token) {
        await applyTokens(pair.access_token, pair.refresh_token, pair.user.id ? pair.user : undefined);
      }
      router.replace('/permissions');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Invalid verification code');
    } finally {
      setLoading(false);
    }
  }

  async function resend() {
    setError('');
    try {
      await authPost('/auth/resend-otp', { email: email.trim().toLowerCase(), purpose: 'register' });
      setInfo('A new code is on its way.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not resend the code');
    }
  }

  return (
    <Screen scroll>
      <Text style={{ fontSize: 48, marginTop: spacing.xxl }}>{showOtp ? '✉️' : '🌱'}</Text>
      <Text style={[typeScale.hero, { color: colors.text, marginTop: spacing.md }]}>
        {showOtp ? 'Verify your email' : 'Join Peapod'}
      </Text>
      <Text style={[typeScale.body, { color: colors.textMuted, marginTop: spacing.sm }]}>
        {showOtp
          ? `We sent a code to ${email}`
          : 'Create an account, then create or join a pod.'}
      </Text>

      {error ? <Text style={{ color: colors.danger, marginTop: spacing.lg }}>{error}</Text> : null}
      {info ? <Text style={{ color: colors.accent, marginTop: spacing.md }}>{info}</Text> : null}

      {showOtp ? (
        <View style={{ marginTop: spacing.xl, gap: spacing.md }}>
          <Field
            label="6-digit code"
            value={otp}
            onChangeText={setOtp}
            placeholder="123456"
            keyboardType="number-pad"
            autoFocus
          />
          <Button label="Verify" onPress={verify} loading={loading} disabled={otp.trim().length < 4} />
          <Button label="Resend code" variant="ghost" onPress={resend} />
        </View>
      ) : (
        <View style={{ marginTop: spacing.xl, gap: spacing.md }}>
          <Field label="Display name" value={displayName} onChangeText={setDisplayName} placeholder="Alex" autoCapitalize="words" />
          <Field
            label="Email"
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            keyboardType="email-address"
          />
          <Field label="Password (at least 10 characters)" value={password} onChangeText={setPassword} placeholder="••••••••" secure />
          <Field label="Confirm password" value={confirm} onChangeText={setConfirm} placeholder="••••••••" secure />
          <Button
            label="Create account"
            onPress={register}
            loading={loading}
            disabled={!email || password.length < 10}
          />
        </View>
      )}

      <View style={{ marginTop: spacing.xxl, flexDirection: 'row', gap: 6 }}>
        <Text style={{ color: colors.textMuted }}>Already have an account?</Text>
        <Link href="/login" asChild>
          <Pressable>
            <Text style={{ color: colors.accent, fontWeight: '700' }}>Log in</Text>
          </Pressable>
        </Link>
      </View>
    </Screen>
  );
}

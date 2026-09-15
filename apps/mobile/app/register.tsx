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

import { ApiError, authPost, normaliseAuth } from '@/services/apiClient';
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
    if (loading) return;
    setError('');
    const normalisedEmail = email.trim().toLowerCase();
    if (!normalisedEmail.includes('@')) {
      setError('Enter a valid email address');
      return;
    }
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
      const created = await authPost<{ email_sent?: boolean }>('/auth/register', {
        email: normalisedEmail,
        password,
        display_name: displayName.trim() || normalisedEmail.split('@')[0],
      });
      setShowOtp(true);
      setInfo(
        created?.email_sent === false
          ? 'Account created, but the verification email was not accepted by the mail provider. Tap Resend, and check the security service logs for `email provider status=`.'
          : 'We sent a 6-digit code to your inbox. Locally it is also printed in the security service logs.',
      );
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        setError('An account with this email already exists. Log in instead.');
      } else {
        setError(cause instanceof Error ? cause.message : 'Registration failed');
      }
    } finally {
      setLoading(false);
    }
  }

  async function verify() {
    if (loading) return;
    setError('');
    setLoading(true);
    try {
      const raw = await authPost<unknown>('/auth/verify-otp', {
        email: email.trim().toLowerCase(),
        code: otp.trim(),
        purpose: 'register',
      });
      const pair = normaliseAuth(raw);
      if (!pair.access_token) throw new Error('Verification succeeded but no access token came back.');
      await applyTokens(pair.access_token, pair.refresh_token, pair.user.id ? pair.user : undefined);
      router.replace('/permissions');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Invalid verification code');
    } finally {
      setLoading(false);
    }
  }

  async function resend() {
    if (loading) return;
    setError('');
    setLoading(true);
    try {
      await authPost('/auth/resend-otp', { email: email.trim().toLowerCase(), purpose: 'register' });
      setInfo('A new code is on its way.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not resend the code');
    } finally {
      setLoading(false);
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
            autoCapitalize="none"
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

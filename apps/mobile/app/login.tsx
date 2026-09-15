/**
 * MODULE: apps/mobile/app/login.tsx
 *
 * PURPOSE
 *   Email + password login. Stores the access and refresh tokens in
 *   SecureStore via the session store, then lets `/` decide the next screen.
 *   Unverified accounts stay on this screen and enter the emailed OTP
 *   (register would 409 if they tried to sign up again).
 *
 * INPUTS  : POST /auth/login, POST /auth/verify-otp, POST /auth/resend-otp
 * OUTPUTS : tokens + user in session
 *
 * HELPER TEXT
 *   After `npm run db:seed` and `npm run seed:security`, log in as
 *   alex@peapod.local / peapod-demo-12. New users can still register.
 */

import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Link, router } from 'expo-router';

import { authPost, normaliseAuth, ApiError } from '@/services/apiClient';
import { Button } from '@/components/Button';
import { Field } from '@/components/Field';
import { Screen } from '@/components/Screen';
import { useSession } from '@/store/session';
import { spacing, themeColors, type as typeScale } from '@/theme';

export default function LoginScreen() {
  const dark = useSession((s) => s.darkMode);
  const colors = themeColors(dark);
  const applyTokens = useSession((s) => s.applyTokens);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [showOtp, setShowOtp] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit() {
    if (loading) return;
    setError('');
    setLoading(true);
    try {
      const raw = await authPost<unknown>('/auth/login', {
        email: email.trim().toLowerCase(),
        password,
      });
      const pair = normaliseAuth(raw);
      if (!pair.access_token) throw new Error('Login succeeded but no access token came back.');
      await applyTokens(pair.access_token, pair.refresh_token, pair.user.id ? pair.user : undefined);
      router.replace('/');
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 403) {
        setShowOtp(true);
        setInfo('Verify your email with the 6-digit code we just sent.');
        setError('');
      } else {
        setError(cause instanceof Error ? cause.message : 'Invalid email or password');
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
      router.replace('/');
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
      <Text style={{ fontSize: 48, marginTop: spacing.xxl }}>{showOtp ? '✉️' : '🫛'}</Text>
      <Text style={[typeScale.hero, { color: colors.text, marginTop: spacing.md }]}>
        {showOtp ? 'Verify your email' : 'Welcome back'}
      </Text>
      <Text style={[typeScale.body, { color: colors.textMuted, marginTop: spacing.sm }]}>
        {showOtp
          ? `We sent a code to ${email}`
          : 'Create an account, then create or join a pod.'}
      </Text>
      {showOtp ? null : (
        <Text style={[typeScale.caption, { color: colors.textMuted, marginTop: spacing.md }]}>
          Demo login: alex@peapod.local / peapod-demo-12
        </Text>
      )}

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
          <Field
            label="Email"
            value={email}
            onChangeText={setEmail}
            placeholder="alex@peapod.local"
            keyboardType="email-address"
            autoCapitalize="none"
          />
          <Field label="Password" value={password} onChangeText={setPassword} placeholder="••••••••" secure />
          <Button label="Log in" onPress={submit} loading={loading} disabled={!email || !password} />
        </View>
      )}

      <Link href="/forgot-password" asChild>
        <Pressable style={{ marginTop: spacing.lg }}>
          <Text style={{ color: colors.accent, fontWeight: '600' }}>Forgot password?</Text>
        </Pressable>
      </Link>

      <View style={{ marginTop: spacing.xxl, flexDirection: 'row', gap: 6 }}>
        <Text style={{ color: colors.textMuted }}>No account?</Text>
        <Link href="/register" asChild>
          <Pressable>
            <Text style={{ color: colors.accent, fontWeight: '700' }}>Create one</Text>
          </Pressable>
        </Link>
      </View>
    </Screen>
  );
}

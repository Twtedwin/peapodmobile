/**
 * MODULE: apps/mobile/src/components/NoPodScreen.tsx
 *
 * PURPOSE
 *   Shown when the signed-in user belongs to zero pods. The two ways in:
 *   create a pod, or join with a six-character invite code. Without this
 *   screen the tabs would fetch `/pods/:id/...` with a null id and 400.
 *
 * INPUTS  : none (reads/writes the session store)
 * OUTPUTS : a form
 * CONSUMED BY : PodGate, and the You tab as a fallback
 */

import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';

import { Button } from '@/components/Button';
import { Field } from '@/components/Field';
import { Screen } from '@/components/Screen';
import { useSession } from '@/store/session';
import { apiClient, unwrap } from '@/services/apiClient';
import { spacing, themeColors, type as typeScale } from '@/theme';

interface CreatedPod {
  id: string;
  name?: string;
}

const INVITE_CODE = /^[A-Z0-9]{6}$/;

export function NoPodScreen() {
  const dark = useSession((s) => s.darkMode);
  const colors = themeColors(dark);
  const setCurrentPodId = useSession((s) => s.setCurrentPodId);
  const queryClient = useQueryClient();

  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'create' | 'join' | null>(null);
  const [error, setError] = useState('');

  async function afterJoin(podId: string) {
    await setCurrentPodId(podId);
    await queryClient.invalidateQueries();
  }

  async function createPod() {
    setError('');
    setBusy('create');
    try {
      const raw = await apiClient.pods.create({
        name: name.trim() || 'Our pod',
        emoji: '🫛',
        group_type: 'friends',
      });
      const pod = unwrap<CreatedPod>(raw, ['pod', 'data']);
      if (!pod?.id) throw new Error('The API did not return a pod id.');
      await afterJoin(pod.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create a pod.');
    } finally {
      setBusy(null);
    }
  }

  async function joinPod() {
    setError('');
    const normalisedCode = code.trim().toUpperCase();
    if (!INVITE_CODE.test(normalisedCode)) {
      setError('Invite codes contain exactly 6 letters or numbers.');
      return;
    }
    setBusy('join');
    try {
      const raw = await apiClient.pods.join(normalisedCode);
      const pod = unwrap<CreatedPod>(raw, ['pod', 'data']);
      if (!pod?.id) throw new Error('Join succeeded but no pod id came back.');
      await afterJoin(pod.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not join with that code.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Screen scroll>
      <Text style={{ fontSize: 48, marginTop: spacing.xl }}>🫛</Text>
      <Text style={[typeScale.hero, { color: colors.text, marginTop: spacing.md }]}>No pod yet</Text>
      <Text style={[typeScale.body, { color: colors.textMuted, marginTop: spacing.sm }]}>
        A pod is the small group that shares location, plans, money, and a world. Create one, or
        join with a six-character invite code.
      </Text>

      {error ? (
        <Text style={{ color: colors.danger, marginTop: spacing.lg }}>{error}</Text>
      ) : null}

      <View style={{ marginTop: spacing.xxl, gap: spacing.md }}>
        <Text style={[typeScale.overline, { color: colors.textMuted }]}>Create</Text>
        <Field label="Pod name" value={name} onChangeText={setName} placeholder="The Pod" autoCapitalize="words" />
        <Button label="Create pod" onPress={createPod} loading={busy === 'create'} disabled={busy !== null} />
      </View>

      <View style={[styles.or, { borderColor: colors.cardBorder }]}>
        <Text style={{ color: colors.textMuted }}>or</Text>
      </View>

      <View style={{ gap: spacing.md }}>
        <Text style={[typeScale.overline, { color: colors.textMuted }]}>Join</Text>
        <Field
          label="Invite code"
          value={code}
          onChangeText={setCode}
          placeholder="ABC123"
          autoCapitalize="characters"
        />
        <Button
          label="Join with code"
          variant="secondary"
          onPress={joinPod}
          loading={busy === 'join'}
          disabled={busy !== null || !INVITE_CODE.test(code.trim().toUpperCase())}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  or: {
    alignItems: 'center',
    marginVertical: spacing.xl,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing.lg,
  },
});

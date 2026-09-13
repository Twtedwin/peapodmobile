/**
 * Pod switcher and membership entry points.
 *
 * GET /pods is already membership-scoped by the API, so every row displayed
 * here is a pod the signed-in user created or joined.
 */

import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';

import { Button } from '@/components/Button';
import { Field } from '@/components/Field';
import { Sheet } from '@/components/Sheet';
import type { PodRow } from '@/hooks/usePodData';
import { useSession } from '@/store/session';
import { apiClient, unwrap } from '@/services/apiClient';
import { radius, spacing, themeColors } from '@/theme';
import { INVITE_CODE_PATTERN } from './model';

interface Props {
  visible: boolean;
  pods: PodRow[];
  activePodId: string | null;
  onClose: () => void;
}

export function PodSelector({ visible, pods, activePodId, onClose }: Props) {
  const colors = themeColors(useSession((state) => state.darkMode));
  const setCurrentPodId = useSession((state) => state.setCurrentPodId);
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'create' | 'join' | null>(null);
  const [error, setError] = useState('');

  async function choose(id: string) {
    await setCurrentPodId(id);
    onClose();
  }

  async function finishMutation(id: string) {
    await queryClient.invalidateQueries({ queryKey: ['pods'] });
    await setCurrentPodId(id);
    setName('');
    setCode('');
    onClose();
  }

  async function createPod() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Enter a name for the new pod.');
      return;
    }
    setBusy('create');
    setError('');
    try {
      const raw = await apiClient.pods.create({
        name: trimmed,
        emoji: '🫛',
        group_type: 'friends',
      });
      const pod = unwrap<PodRow>(raw, ['pod', 'data']);
      if (!pod?.id) throw new Error('The API did not return the new pod.');
      await finishMutation(pod.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create the pod.');
    } finally {
      setBusy(null);
    }
  }

  async function joinPod() {
    const normalized = code.trim().toUpperCase();
    if (!INVITE_CODE_PATTERN.test(normalized)) {
      setError('Invite codes contain exactly 6 letters or numbers.');
      return;
    }
    setBusy('join');
    setError('');
    try {
      const raw = await apiClient.pods.join(normalized);
      const pod = unwrap<PodRow>(raw, ['pod', 'data']);
      if (!pod?.id) throw new Error('The API did not return the joined pod.');
      await finishMutation(pod.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not join that pod.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Sheet visible={visible} title="Your pods" onClose={onClose} tall>
      <ScrollView keyboardShouldPersistTaps="handled">
        <View style={{ gap: spacing.sm }}>
          {pods.map((pod) => {
            const active = pod.id === activePodId;
            return (
              <Pressable
                key={pod.id}
                onPress={() => void choose(pod.id)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                style={{
                  padding: spacing.md,
                  borderRadius: radius.md,
                  backgroundColor: active ? colors.accentDim : colors.card,
                  borderWidth: 1,
                  borderColor: active ? colors.accent : colors.cardBorder,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: spacing.md,
                }}
              >
                <Text style={{ fontSize: 22 }}>{pod.emoji ?? '🫛'}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.text, fontWeight: '700' }}>{pod.name}</Text>
                  <Text style={{ color: colors.textMuted, fontSize: 12 }}>
                    {pod.my_role === 'admin' ? 'Created by you / Seed' : 'Joined pod'}
                  </Text>
                </View>
                {active ? <Text style={{ color: colors.accent }}>Current</Text> : null}
              </Pressable>
            );
          })}
        </View>

        {error ? <Text style={{ color: colors.danger, marginTop: spacing.md }}>{error}</Text> : null}

        <View style={{ marginTop: spacing.xl, gap: spacing.md }}>
          <Text style={{ color: colors.text, fontWeight: '700' }}>Create a new group (pod)</Text>
          <Field label="Pod name" value={name} onChangeText={setName} placeholder="Weekend crew" />
          <Button
            label="Create pod"
            onPress={createPod}
            loading={busy === 'create'}
            disabled={busy !== null}
          />
        </View>

        <View style={{ marginTop: spacing.xl, paddingBottom: spacing.xl, gap: spacing.md }}>
          <Text style={{ color: colors.text, fontWeight: '700' }}>Join a group (pod) with a code</Text>
          <Field
            label="6-character invite code"
            value={code}
            onChangeText={(value) => setCode(value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
            placeholder="ABC123"
            autoCapitalize="characters"
          />
          <Button
            label="Join pod"
            variant="secondary"
            onPress={joinPod}
            loading={busy === 'join'}
            disabled={busy !== null || !INVITE_CODE_PATTERN.test(code)}
          />
        </View>
      </ScrollView>
    </Sheet>
  );
}

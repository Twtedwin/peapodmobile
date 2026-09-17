/**
 * Pod switcher: a dropdown under the floating pod pill, plus center modals
 * for creating a pod or joining with a six-character invite.
 *
 * GET /pods is already membership-scoped by the API, so every row displayed
 * here is a pod the signed-in user created or joined.
 */

import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';

import { Button } from '@/components/Button';
import { Field } from '@/components/Field';
import type { PodRow } from '@/hooks/usePodData';
import { useSession } from '@/store/session';
import { apiClient, unwrap } from '@/services/apiClient';
import { radius, spacing, themeColors } from '@/theme';
import { CenterModal } from './CenterModal';
import { INVITE_CODE_PATTERN, POD_CREATE_EMOJIS } from './model';
import type { PodHeaderAnchor } from './PodHeader';

interface Props {
  visible: boolean;
  pods: PodRow[];
  activePodId: string | null;
  anchor: PodHeaderAnchor | null;
  onClose: () => void;
}

export function PodSelector({ visible, pods, activePodId, anchor, onClose }: Props) {
  const colors = themeColors(useSession((state) => state.darkMode));
  const setCurrentPodId = useSession((state) => state.setCurrentPodId);
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState<string>('🐾');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'create' | 'join' | null>(null);
  const [error, setError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);

  async function choose(id: string) {
    await setCurrentPodId(id);
    onClose();
  }

  async function finishMutation(id: string) {
    await queryClient.invalidateQueries({ queryKey: ['pods'] });
    await setCurrentPodId(id);
    setName('');
    setCode('');
    setEmoji('🐾');
    setCreateOpen(false);
    setJoinOpen(false);
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
        emoji: emoji || '🐾',
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

  function openCreate() {
    setError('');
    onClose();
    setCreateOpen(true);
  }

  function openJoin() {
    setError('');
    onClose();
    setJoinOpen(true);
  }

  const menuTop = anchor ? anchor.y + anchor.height + spacing.sm : 72;
  const menuLeft = anchor?.x ?? spacing.md;
  const menuWidth = Math.max(anchor?.width ?? 0, 248);

  return (
    <>
      <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
        <View style={styles.dropdownRoot}>
          <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close pod menu" />
          <View
            style={[
              styles.menu,
              {
                top: menuTop,
                left: menuLeft,
                width: menuWidth,
                backgroundColor: colors.bgElevated,
                borderColor: colors.cardBorder,
              },
            ]}
          >
            <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 280 }}>
              {pods.map((pod) => {
                const active = pod.id === activePodId;
                return (
                  <Pressable
                    key={pod.id}
                    onPress={() => void choose(pod.id)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    style={[
                      styles.row,
                      { backgroundColor: active ? colors.accentDim : 'transparent' },
                    ]}
                  >
                    <Text style={{ fontSize: 20 }}>{pod.emoji ?? '🫛'}</Text>
                    <Text style={{ color: colors.text, fontWeight: '700', flex: 1 }} numberOfLines={1}>
                      {pod.name}
                    </Text>
                    {active ? <Ionicons name="checkmark" size={18} color={colors.accent} /> : null}
                  </Pressable>
                );
              })}
            </ScrollView>
            <View style={[styles.footer, { borderTopColor: colors.cardBorder }]}>
              <Pressable onPress={openCreate} style={styles.row} accessibilityRole="button">
                <Text style={{ color: colors.accent, fontWeight: '800', fontSize: 18 }}>+</Text>
                <Text style={{ color: colors.text, fontWeight: '700' }}>Create new pod</Text>
              </Pressable>
              <Pressable onPress={openJoin} style={styles.row} accessibilityRole="button">
                <Text style={{ fontSize: 16 }}>🔑</Text>
                <Text style={{ color: colors.text, fontWeight: '700' }}>Join with a code</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <CenterModal
        visible={createOpen}
        title="Create a pod"
        onClose={() => {
          setCreateOpen(false);
          setError('');
        }}
      >
        {error ? <Text style={{ color: colors.danger }}>{error}</Text> : null}
        <Field label="Pod name" value={name} onChangeText={setName} placeholder="Weekend crew" autoFocus />
        <Text style={{ color: colors.textMuted, fontWeight: '700', fontSize: 12 }}>Emoji</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.emojiRow}>
          {POD_CREATE_EMOJIS.map((item) => {
            const selected = item === emoji;
            return (
              <Pressable
                key={item}
                onPress={() => setEmoji(item)}
                style={[
                  styles.emojiChoice,
                  {
                    backgroundColor: selected ? colors.accentDim : colors.card,
                    borderColor: selected ? colors.accent : colors.cardBorder,
                  },
                ]}
              >
                <Text style={{ fontSize: 22 }}>{item}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
        <Button label="Create pod" onPress={createPod} loading={busy === 'create'} disabled={busy !== null} />
      </CenterModal>

      <CenterModal
        visible={joinOpen}
        title="Join a pod"
        onClose={() => {
          setJoinOpen(false);
          setError('');
        }}
      >
        <Text style={{ color: colors.textMuted }}>
          Enter the 6-character invite from a Seed. Codes expire after 10 minutes.
        </Text>
        {error ? <Text style={{ color: colors.danger }}>{error}</Text> : null}
        <TextInput
          value={code}
          onChangeText={(value) => setCode(value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
          placeholder="ABC123"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="characters"
          autoCorrect={false}
          autoFocus
          maxLength={6}
          style={[
            styles.codeInput,
            { color: colors.text, borderColor: colors.cardBorder, backgroundColor: colors.card },
          ]}
        />
        <Button
          label="Join pod"
          onPress={joinPod}
          loading={busy === 'join'}
          disabled={busy !== null || !INVITE_CODE_PATTERN.test(code)}
        />
      </CenterModal>
    </>
  );
}

const styles = StyleSheet.create({
  dropdownRoot: { flex: 1, backgroundColor: 'rgba(8, 12, 10, 0.35)' },
  menu: {
    position: 'absolute',
    borderRadius: radius.lg,
    borderWidth: 1,
    overflow: 'hidden',
    maxWidth: 320,
  },
  row: {
    minHeight: 48,
    paddingHorizontal: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  footer: { borderTopWidth: StyleSheet.hairlineWidth },
  emojiRow: { gap: spacing.sm, paddingVertical: spacing.xs },
  emojiChoice: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  codeInput: {
    minHeight: 56,
    borderWidth: 1,
    borderRadius: radius.md,
    textAlign: 'center',
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: 10,
  },
});

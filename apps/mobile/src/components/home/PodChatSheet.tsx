/**
 * Animated pod-wide text chat.
 *
 * Messages use recipient_id null, which is the API contract for broadcasting
 * to every member of the active pod.
 */

import { useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';

import type { PodRow } from '@/hooks/usePodData';
import { useMessages } from '@/hooks/usePodData';
import { apiClient } from '@/services/apiClient';
import { useSession } from '@/store/session';
import { radius, spacing, themeColors } from '@/theme';

interface Props {
  podId: string | null;
  pod?: PodRow;
  visible: boolean;
  onClose: () => void;
}

export function PodChatSheet({ podId, pod, visible, onClose }: Props) {
  const colors = themeColors(useSession((state) => state.darkMode));
  const me = useSession((state) => state.user);
  const insets = useSafeAreaInsets();
  const messagesQ = useMessages(visible ? podId : null);
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const valid = text.trim().length > 0;
  const messages = messagesQ.data ?? [];

  async function send() {
    if (!podId || !valid || sending) return;
    setSending(true);
    setError('');
    try {
      await apiClient.pods.sendMessage(podId, text.trim());
      setText('');
      await queryClient.invalidateQueries({ queryKey: ['pod', podId, 'messages'] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not send the message.');
    } finally {
      setSending(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close chat" />
        <View
          style={[
            styles.sheet,
            {
              backgroundColor: colors.bgElevated,
              borderColor: colors.cardBorder,
              paddingBottom: Math.max(insets.bottom, spacing.md),
            },
          ]}
        >
          <View style={styles.handleArea}>
            <View style={[styles.handle, { backgroundColor: colors.textMuted }]} />
          </View>
          <View style={styles.header}>
            <Text style={{ color: colors.text, fontWeight: '800', fontSize: 20, flex: 1 }}>
              {pod?.emoji ?? '🫛'} {pod?.name ?? 'Pod chat'}
            </Text>
            <Pressable
              onPress={onClose}
              accessibilityLabel="Close pod chat"
              style={[styles.closeButton, { backgroundColor: colors.card }]}
            >
              <Ionicons name="close" size={22} color={colors.text} />
            </Pressable>
          </View>

          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={messages.length === 0 ? styles.emptyContent : styles.messageContent}
            keyboardShouldPersistTaps="handled"
          >
            {messages.length === 0 ? (
              <View style={styles.empty}>
                <Ionicons name="chatbubbles-outline" size={42} color={colors.textMuted} />
                <Text style={{ color: colors.textMuted, fontSize: 16 }}>Say hi to your pod...</Text>
              </View>
            ) : (
              messages.map((message) => {
                const row = message as { id: string; text?: string; created_by_id?: string };
                const mine = row.created_by_id === me?.id;
                return (
                  <View
                    key={row.id}
                    style={[
                      styles.message,
                      {
                        alignSelf: mine ? 'flex-end' : 'flex-start',
                        backgroundColor: mine ? colors.accent : colors.card,
                      },
                    ]}
                  >
                    <Text style={{ color: mine ? colors.accentText : colors.text }}>{row.text}</Text>
                  </View>
                );
              })
            )}
          </ScrollView>

          {error ? <Text style={{ color: colors.danger, marginBottom: spacing.sm }}>{error}</Text> : null}
          <View style={styles.composer}>
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder="Message the pod..."
              placeholderTextColor={colors.textMuted}
              multiline
              maxLength={2000}
              style={[
                styles.input,
                {
                  color: colors.text,
                  backgroundColor: colors.card,
                  borderColor: colors.cardBorder,
                },
              ]}
            />
            <Pressable
              onPress={() => void send()}
              disabled={!valid || sending}
              accessibilityLabel="Send pod message"
              accessibilityState={{ disabled: !valid || sending }}
              style={[
                styles.sendButton,
                { backgroundColor: valid && !sending ? colors.accent : colors.cardBorder },
              ]}
            >
              <Ionicons
                name="send"
                size={20}
                color={valid && !sending ? colors.accentText : colors.textMuted}
              />
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(8,12,10,0.55)' },
  sheet: {
    height: '78%',
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderWidth: 1,
    paddingHorizontal: spacing.lg,
  },
  handleArea: { height: 28, alignItems: 'center', justifyContent: 'center' },
  handle: { width: 44, height: 4, borderRadius: 2 },
  header: { flexDirection: 'row', alignItems: 'center', paddingBottom: spacing.md },
  closeButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyContent: { flexGrow: 1, justifyContent: 'center' },
  messageContent: { paddingVertical: spacing.md },
  empty: { alignItems: 'center', gap: spacing.md },
  message: {
    padding: spacing.md,
    borderRadius: radius.md,
    marginBottom: spacing.sm,
    maxWidth: '82%',
  },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
  input: {
    flex: 1,
    minHeight: 48,
    maxHeight: 112,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  sendButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

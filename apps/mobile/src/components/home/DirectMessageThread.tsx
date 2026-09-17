/**
 * Shared private-chat body used by the Home DM modal and the full-screen route.
 *
 * INPUTS  : target MapPea (or fallback identity), onClose
 * OUTPUTS : header, status, 4-column stats, message list, composer
 */

import { useMemo, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { format, isToday } from 'date-fns';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { classifyActivity } from '@peapod/shared';

import { useDirectMessages } from '@/hooks/usePodData';
import { useSession } from '@/store/session';
import { apiClient } from '@/services/apiClient';
import { radius, spacing, themeColors } from '@/theme';
import type { MapPea } from './model';
import { StatusMetrics } from './StatusMetrics';

interface Props {
  pea: MapPea;
  onClose: () => void;
  onRefreshHistory?: () => void;
}

function dayLabel(value: string): string {
  const date = new Date(value);
  return isToday(date) ? 'TODAY' : format(date, 'd MMMM yyyy').toUpperCase();
}

export function DirectMessageThread({ pea, onClose, onRefreshHistory }: Props) {
  const colors = themeColors(useSession((state) => state.darkMode));
  const me = useSession((state) => state.user);
  const userId = pea.member.id;
  const messagesQ = useDirectMessages(userId || null);
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const valid = text.trim().length > 0;
  const activity = classifyActivity(pea.speed);
  const messages = useMemo(() => messagesQ.data ?? [], [messagesQ.data]);
  const name = pea.member.display_name;

  async function send() {
    if (!valid || !userId || sending) return;
    setSending(true);
    setError('');
    try {
      await apiClient.directMessages.send(userId, text.trim());
      setText('');
      await queryClient.invalidateQueries({ queryKey: ['direct-messages', userId] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not send the message.');
    } finally {
      setSending(false);
    }
  }

  async function refreshHistory() {
    await messagesQ.refetch();
    onRefreshHistory?.();
  }

  return (
    <KeyboardAvoidingView
      style={styles.wrap}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.header}>
        <Text style={{ color: colors.text, fontWeight: '800', fontSize: 20, flex: 1 }} numberOfLines={1}>
          {name}
        </Text>
        <Pressable
          onPress={() => void refreshHistory()}
          accessibilityLabel="Refresh message history"
          style={[styles.headerButton, { backgroundColor: colors.card }]}
        >
          <Ionicons name="time-outline" size={20} color={colors.text} />
        </Pressable>
        <Pressable
          onPress={onClose}
          accessibilityLabel="Close direct message"
          style={[styles.headerButton, { backgroundColor: colors.card }]}
        >
          <Ionicons name="close" size={22} color={colors.text} />
        </Pressable>
      </View>

      <View style={[styles.statusBanner, { backgroundColor: colors.accentDim }]}>
        <Ionicons
          name={
            activity.label === 'Walking'
              ? 'walk'
              : activity.label === 'Cycling'
                ? 'bicycle'
                : activity.label === 'Driving'
                  ? 'car'
                  : 'pause-circle'
          }
          size={18}
          color={colors.accent}
        />
        <Text style={{ color: colors.text, fontWeight: '700', flex: 1 }} numberOfLines={2}>
          {activity.label} · at {pea.locationLabel} since {pea.lastSeenLabel}
        </Text>
      </View>

      <View style={[styles.metricsCard, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}>
        <StatusMetrics pea={pea} />
      </View>

      <ScrollView
        style={{ flex: 1, minHeight: 120 }}
        contentContainerStyle={styles.feed}
        keyboardShouldPersistTaps="handled"
      >
        {messages.length === 0 ? (
          <Text style={{ color: colors.textMuted, textAlign: 'center', marginTop: spacing.xl }}>
            Say hi to {name}…
          </Text>
        ) : null}
        {messages.map((message, index) => {
          const id = String(message.id);
          const createdAt = String(message.created_at ?? new Date().toISOString());
          const label = dayLabel(createdAt);
          const previousCreatedAt = index > 0 ? String(messages[index - 1]?.created_at ?? '') : '';
          const showDay = index === 0 || !previousCreatedAt || label !== dayLabel(previousCreatedAt);
          const mine = message.created_by_id === me?.id;
          return (
            <View key={id}>
              {showDay ? (
                <View style={styles.dayRow}>
                  <View style={[styles.dayLine, { backgroundColor: colors.cardBorder }]} />
                  <Text style={{ color: colors.textMuted, fontSize: 10, fontWeight: '700' }}>{label}</Text>
                  <View style={[styles.dayLine, { backgroundColor: colors.cardBorder }]} />
                </View>
              ) : null}
              <View style={[styles.messageRow, { justifyContent: mine ? 'flex-end' : 'flex-start' }]}>
                <View
                  style={[
                    styles.bubble,
                    { backgroundColor: mine ? colors.accent : colors.card },
                  ]}
                >
                  <Text style={{ color: mine ? colors.accentText : colors.text }}>
                    {String(message.text ?? '')}
                  </Text>
                </View>
                <Text style={{ color: colors.textMuted, fontSize: 10 }}>
                  {format(new Date(createdAt), 'h:mm a')}
                </Text>
              </View>
            </View>
          );
        })}
      </ScrollView>

      {error ? <Text style={{ color: colors.danger, paddingHorizontal: spacing.sm }}>{error}</Text> : null}
      <View style={styles.composer}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Message"
          placeholderTextColor={colors.textMuted}
          multiline
          maxLength={2000}
          style={[
            styles.input,
            { backgroundColor: colors.card, borderColor: colors.cardBorder, color: colors.text },
          ]}
        />
        <Pressable
          onPress={() => void send()}
          disabled={!valid || sending}
          accessibilityLabel="Send private message"
          accessibilityState={{ disabled: !valid || sending }}
          style={[
            styles.send,
            { backgroundColor: valid && !sending ? colors.accent : colors.cardBorder },
          ]}
        >
          <Ionicons
            name="send"
            size={22}
            color={valid && !sending ? colors.accentText : colors.textMuted}
          />
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, minHeight: 420 },
  header: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingBottom: spacing.sm,
  },
  headerButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusBanner: {
    padding: spacing.md,
    borderRadius: radius.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  metricsCard: {
    marginTop: spacing.sm,
    paddingVertical: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
  },
  feed: { paddingTop: spacing.md, paddingBottom: spacing.md },
  dayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginVertical: spacing.md,
  },
  dayLine: { height: StyleSheet.hairlineWidth, flex: 1 },
  messageRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm, marginBottom: spacing.sm },
  bubble: { maxWidth: '76%', borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    paddingTop: spacing.sm,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 100,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  send: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

/**
 * MODULE: apps/mobile/app/direct-message/[userId]
 *
 * PURPOSE
 *   Pod-independent private conversation between the signed-in user and one
 *   other account. Pod presence enriches the pinned status card when the two
 *   users currently share a pod, but message persistence never uses pod_id.
 */

import { useMemo, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { format, isToday } from 'date-fns';
import { router, useLocalSearchParams } from 'expo-router';
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';
import { classifyActivity } from '@peapod/shared';

import { Avatar } from '@/components/Avatar';
import { buildMapPeas } from '@/components/home/model';
import {
  useCurrentPodId,
  useDirectMessages,
  useMembers,
  usePlaces,
  usePresence,
  type MemberRow,
} from '@/hooks/usePodData';
import { useSession } from '@/store/session';
import { apiClient } from '@/services/apiClient';
import { radius, spacing, themeColors } from '@/theme';

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function dayLabel(value: string): string {
  const date = new Date(value);
  return isToday(date) ? 'TODAY' : format(date, 'd MMMM yyyy').toUpperCase();
}

function networkLabel(value?: string): string {
  if (!value || value === 'unknown') return 'Unknown';
  if (value === 'cellular') return 'Data';
  return value === 'wifi' ? 'Wi-Fi' : value.charAt(0).toUpperCase() + value.slice(1);
}

function batteryIcon(percentage: number | undefined, charging: boolean): keyof typeof Ionicons.glyphMap {
  if (charging) return 'battery-charging';
  if (percentage == null || percentage <= 15) return 'battery-dead';
  if (percentage >= 75) return 'battery-full';
  return 'battery-half';
}

export default function DirectMessageScreen() {
  const params = useLocalSearchParams<{ userId: string; name?: string; avatar?: string }>();
  const userId = first(params.userId);
  const fallbackName = first(params.name) || 'Pea';
  const fallbackAvatar = first(params.avatar) || null;
  const colors = themeColors(useSession((state) => state.darkMode));
  const me = useSession((state) => state.user);
  const insets = useSafeAreaInsets();
  const podId = useCurrentPodId();
  const membersQ = useMembers(podId);
  const presenceQ = usePresence(podId);
  const placesQ = usePlaces(podId);
  const messagesQ = useDirectMessages(userId || null);
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const valid = text.trim().length > 0;

  const targetMember = (membersQ.data ?? []).find((member) => member.id === userId);
  const displayMember: MemberRow =
    targetMember ?? {
      id: userId,
      user_id: userId,
      membership_id: '',
      display_name: fallbackName,
      avatar_url: fallbackAvatar,
    };
  const mePresence = (presenceQ.data ?? []).find((row) => row.user_id === me?.id);
  const myLastFix =
    mePresence?.latitude != null && mePresence.longitude != null
      ? {
          latitude: mePresence.latitude,
          longitude: mePresence.longitude,
          speed: mePresence.speed ?? 0,
          accuracy: mePresence.accuracy ?? 0,
          heading: mePresence.heading ?? 0,
        }
      : null;
  const target = buildMapPeas(
    [displayMember],
    presenceQ.data ?? [],
    placesQ.data ?? [],
    me?.id,
    myLastFix,
  )[0]!;
  const activity = classifyActivity(target.speed);
  const messages = useMemo(() => messagesQ.data ?? [], [messagesQ.data]);

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

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { backgroundColor: colors.bg, paddingTop: insets.top }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={[styles.header, { borderBottomColor: colors.cardBorder }]}>
        <Avatar
          name={displayMember.display_name}
          id={displayMember.id}
          uri={displayMember.avatar_url}
          size={38}
        />
        <Text style={{ color: colors.text, fontWeight: '800', fontSize: 19, flex: 1 }} numberOfLines={1}>
          {displayMember.display_name}
        </Text>
        <Pressable
          onPress={() => void messagesQ.refetch()}
          accessibilityLabel="Refresh message history"
          style={[styles.headerButton, { backgroundColor: colors.card }]}
        >
          <Ionicons name="time-outline" size={21} color={colors.text} />
        </Pressable>
        <Pressable
          onPress={() => router.back()}
          accessibilityLabel="Close direct message"
          style={[styles.headerButton, { backgroundColor: colors.card }]}
        >
          <Ionicons name="close" size={22} color={colors.text} />
        </Pressable>
      </View>

      <View style={[styles.statusBanner, { backgroundColor: colors.accentDim }]}>
        <View style={[styles.statusDot, { backgroundColor: target.online ? colors.accent : colors.textMuted }]} />
        <Text style={{ color: colors.text, fontWeight: '700' }} numberOfLines={1}>
          {activity.label} · {target.locationLabel} · {target.lastSeenLabel}
        </Text>
      </View>

      <View style={[styles.metricsCard, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}>
        <Metric
          icon={batteryIcon(target.battery, target.charging)}
          label="Battery"
          value={target.battery == null ? 'N/A' : `${target.battery}%`}
          healthy={target.battery != null && target.battery > 20}
        />
        <Metric icon="cellular" label="Network" value={networkLabel(target.connection)} />
        <Metric icon="navigate" label="Apart" value={target.distanceLabel} />
        <Metric
          icon="speedometer"
          label="Speed"
          value={`${Math.max(0, target.speed * 3.6).toFixed(1)} km/h`}
        />
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.feed}
        keyboardShouldPersistTaps="handled"
      >
        {messages.length === 0 ? (
          <Text style={{ color: colors.textMuted, textAlign: 'center', marginTop: spacing.xxl }}>
            No messages yet. Say hello.
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

      {error ? <Text style={{ color: colors.danger, paddingHorizontal: spacing.lg }}>{error}</Text> : null}
      <View
        style={[
          styles.composer,
          {
            borderTopColor: colors.cardBorder,
            paddingBottom: Math.max(insets.bottom, spacing.md),
          },
        ]}
      >
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
            name="arrow-up"
            size={23}
            color={valid && !sending ? colors.accentText : colors.textMuted}
          />
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function Metric({
  icon,
  label,
  value,
  healthy = false,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
  healthy?: boolean;
}) {
  const colors = themeColors(useSession((state) => state.darkMode));
  const valueColor = healthy ? colors.accent : colors.text;
  return (
    <View style={styles.metric}>
      <Ionicons name={icon} size={17} color={valueColor} />
      <Text style={{ color: colors.textMuted, fontSize: 9, textTransform: 'uppercase' }}>{label}</Text>
      <Text style={{ color: valueColor, fontWeight: '800', fontSize: 11 }} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    minHeight: 62,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  headerButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusBanner: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  metricsCard: {
    margin: spacing.lg,
    marginTop: spacing.sm,
    paddingVertical: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    flexDirection: 'row',
  },
  metric: { flex: 1, minWidth: 0, alignItems: 'center', gap: 3 },
  feed: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl },
  dayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginVertical: spacing.lg,
  },
  dayLine: { height: StyleSheet.hairlineWidth, flex: 1 },
  messageRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm, marginBottom: spacing.sm },
  bubble: { maxWidth: '76%', borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  composer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    padding: spacing.md,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
  },
  input: {
    flex: 1,
    minHeight: 46,
    maxHeight: 110,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  send: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

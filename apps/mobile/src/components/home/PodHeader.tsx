/**
 * Safe-area-aware chrome above the live map.
 */

import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import type { AuthUser } from '@/services/apiClient';
import type { PodRow } from '@/hooks/usePodData';
import { radius, spacing, themeColors } from '@/theme';
import { useSession } from '@/store/session';

interface Props {
  pod?: PodRow;
  user: AuthUser | null;
  topInset: number;
  unread: number;
  onOpenPods: () => void;
  onOpenNotifications: () => void;
  onOpenProfile: () => void;
}

export function PodHeader({
  pod,
  user,
  topInset,
  unread,
  onOpenPods,
  onOpenNotifications,
  onOpenProfile,
}: Props) {
  const colors = themeColors(useSession((state) => state.darkMode));
  return (
    <View style={[styles.header, { top: topInset + spacing.sm, backgroundColor: colors.overlay }]}>
      <Pressable
        onPress={onOpenPods}
        style={styles.podButton}
        accessibilityRole="button"
        accessibilityLabel="Switch pod"
      >
        <Text style={{ fontSize: 20 }}>{pod?.emoji ?? '🫛'}</Text>
        <View style={{ flexShrink: 1 }}>
          <Text style={{ color: colors.textMuted, fontSize: 10, textTransform: 'uppercase' }}>Pod</Text>
          <Text style={{ color: colors.cream, fontWeight: '800' }} numberOfLines={1}>
            {pod?.name ?? 'Peapod'}
          </Text>
        </View>
        <Ionicons name="chevron-down" size={17} color={colors.cream} />
      </Pressable>

      <View style={styles.actions}>
        <Pressable
          onPress={onOpenNotifications}
          style={[styles.iconButton, { backgroundColor: colors.card }]}
          accessibilityLabel="Notifications"
        >
          <Ionicons name="notifications-outline" size={20} color={colors.text} />
          {unread > 0 ? (
            <View style={[styles.badge, { backgroundColor: colors.danger }]}>
              <Text style={{ color: colors.accentText, fontSize: 9, fontWeight: '800' }}>
                {Math.min(unread, 9)}
              </Text>
            </View>
          ) : null}
        </Pressable>
        <Pressable onPress={onOpenProfile} accessibilityLabel="Open profile">
          <Avatar name={user?.display_name ?? 'You'} id={user?.id} uri={user?.avatar_url} size={38} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    position: 'absolute',
    zIndex: 20,
    left: spacing.md,
    right: spacing.md,
    minHeight: 56,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  podButton: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  iconButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: -3,
    right: -3,
    width: 16,
    height: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

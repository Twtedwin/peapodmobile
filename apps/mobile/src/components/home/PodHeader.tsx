/**
 * Floating Home chrome: pod pill on the left, circular actions on the right.
 *
 * The pod pill reports its window coordinates so the membership dropdown can
 * sit directly beneath it instead of sliding up from the bottom.
 */

import { useRef } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View, type View as RNView } from 'react-native';

import { Avatar } from '@/components/Avatar';
import type { AuthUser } from '@/services/apiClient';
import type { PodRow } from '@/hooks/usePodData';
import { radius, spacing, themeColors } from '@/theme';
import { useSession } from '@/store/session';

export interface PodHeaderAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Props {
  pod?: PodRow;
  user: AuthUser | null;
  topInset: number;
  unread: number;
  onOpenPods: () => void;
  onOpenNotifications: () => void;
  onOpenProfile: () => void;
  onAnchorChange: (anchor: PodHeaderAnchor) => void;
}

export function PodHeader({
  pod,
  user,
  topInset,
  unread,
  onOpenPods,
  onOpenNotifications,
  onOpenProfile,
  onAnchorChange,
}: Props) {
  const colors = themeColors(useSession((state) => state.darkMode));
  const pillRef = useRef<RNView>(null);

  function reportAnchor() {
    pillRef.current?.measureInWindow((x, y, width, height) => {
      if (width <= 0 || height <= 0) return;
      onAnchorChange({ x, y, width, height });
    });
  }

  return (
    <View style={[styles.row, { top: topInset + spacing.sm }]} pointerEvents="box-none">
      <Pressable
        ref={pillRef}
        onPress={() => {
          reportAnchor();
          onOpenPods();
        }}
        onLayout={reportAnchor}
        style={[styles.podPill, { backgroundColor: colors.overlay }]}
        accessibilityRole="button"
        accessibilityLabel="Switch pod"
      >
        <Text style={{ fontSize: 18 }}>{pod?.emoji ?? '🫛'}</Text>
        <Text style={{ color: colors.cream, fontWeight: '800', maxWidth: 140 }} numberOfLines={1}>
          {pod?.name ?? 'Peapod'}
        </Text>
        <Ionicons name="chevron-down" size={16} color={colors.cream} />
      </Pressable>

      <View style={styles.actions}>
        <Pressable
          onPress={onOpenNotifications}
          style={[styles.circle, { backgroundColor: colors.overlay }]}
          accessibilityLabel="Notifications"
        >
          <Ionicons name="notifications-outline" size={20} color={colors.cream} />
          {unread > 0 ? (
            <View style={[styles.badge, { backgroundColor: colors.danger }]}>
              <Text style={{ color: colors.accentText, fontSize: 9, fontWeight: '800' }}>
                {Math.min(unread, 9)}
              </Text>
            </View>
          ) : null}
        </Pressable>
        <Pressable
          onPress={onOpenProfile}
          accessibilityLabel="Open profile"
          style={[styles.circle, { backgroundColor: colors.overlay, overflow: 'hidden' }]}
        >
          <Avatar name={user?.display_name ?? 'You'} id={user?.id} uri={user?.avatar_url} size={40} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    position: 'absolute',
    zIndex: 20,
    left: spacing.md,
    right: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  podPill: {
    minHeight: 44,
    maxWidth: '62%',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  circle: {
    width: 40,
    height: 40,
    borderRadius: 20,
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

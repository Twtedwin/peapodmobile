/**
 * Floating Home chrome: pod pill + sharing count on the left, circular
 * actions on the right. The two sides are separate overlays, not one bar.
 */

import { useRef } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View, type View as RNView } from 'react-native';

import { Avatar } from '@/components/Avatar';
import type { AuthUser } from '@/services/apiClient';
import type { PodRow } from '@/hooks/usePodData';
import { radius, spacing, themeColors, type as typeScale } from '@/theme';
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
  sharingCount: number;
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
  sharingCount,
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
      <View style={styles.left}>
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
          <View style={{ flexShrink: 1 }}>
            <Text style={[typeScale.overline, { color: colors.textMuted, fontSize: 9 }]}>Peapod</Text>
            <View style={styles.nameRow}>
              <Text style={{ fontSize: 16 }}>{pod?.emoji ?? '🫛'}</Text>
              <Text style={{ color: colors.cream, fontWeight: '800', flexShrink: 1 }} numberOfLines={1}>
                {pod?.name ?? 'Peapod'}
              </Text>
              <Ionicons name="chevron-down" size={16} color={colors.cream} />
            </View>
          </View>
        </Pressable>
        <Text style={{ color: colors.accent, fontWeight: '700', fontSize: 12, marginLeft: spacing.sm }}>
          {sharingCount} peas sharing
        </Text>
      </View>

      <View style={styles.actions}>
        <Pressable
          onPress={onOpenNotifications}
          style={[styles.circle, { backgroundColor: colors.overlay }]}
          accessibilityLabel="Notifications"
        >
          <Ionicons name="notifications-outline" size={20} color={colors.cream} />
          {unread > 0 ? (
            <View style={[styles.badge, { backgroundColor: colors.accent }]}>
              <Text style={{ color: colors.accentText, fontSize: 9, fontWeight: '800' }}>
                {unread > 9 ? '9+' : unread}
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
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  left: { flexShrink: 1, maxWidth: '62%', gap: spacing.xs },
  podPill: {
    minHeight: 48,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    flexDirection: 'row',
    alignItems: 'center',
  },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: 1 },
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
    minWidth: 16,
    height: 16,
    paddingHorizontal: 3,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

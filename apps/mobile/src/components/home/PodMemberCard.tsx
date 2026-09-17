/**
 * One pea card in the Home carousel.
 *
 * Identity is a horizontal row (avatar + name/place/time). Stats are always
 * a four-column row: Battery, Net, Apart, Speed — never stacked vertically.
 * Width is set by the parent so 2.5 cards are visible.
 */

import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { radius, spacing, themeColors } from '@/theme';
import { useSession } from '@/store/session';
import type { MapPea } from './model';
import { StatusMetrics } from './StatusMetrics';

interface Props {
  pea: MapPea;
  width: number;
  detailed: boolean;
  onCenter: () => void;
  onNudge: () => void;
  onOpenDirect: () => void;
  nudging?: boolean;
}

export function PodMemberCard({
  pea,
  width,
  detailed,
  onCenter,
  onNudge,
  onOpenDirect,
  nudging = false,
}: Props) {
  const colors = themeColors(useSession((state) => state.darkMode));
  const hasLocation = pea.latitude != null && pea.longitude != null;

  return (
    <Pressable
      onPress={onOpenDirect}
      disabled={pea.isMe}
      accessibilityLabel={pea.isMe ? pea.member.display_name : `Message ${pea.member.display_name}`}
      style={[styles.card, { width, backgroundColor: colors.card, borderColor: colors.cardBorder }]}
    >
      <View style={styles.identity}>
        <Avatar
          name={pea.member.display_name}
          id={pea.member.id}
          uri={pea.member.avatar_url}
          size={40}
        />
        <View style={styles.identityText}>
          <Text style={{ color: colors.text, fontWeight: '800', fontSize: 14 }} numberOfLines={1}>
            {pea.isMe ? 'You' : pea.member.display_name}
          </Text>
          <Text style={{ color: colors.textMuted, fontSize: 11 }} numberOfLines={1}>
            {pea.locationLabel}
          </Text>
          <Text style={{ color: colors.textMuted, fontSize: 11 }} numberOfLines={1}>
            {pea.lastSeenLabel}
          </Text>
        </View>
      </View>

      <StatusMetrics pea={pea} compact />

      {detailed ? (
        <View style={styles.actions}>
          <Pressable
            onPress={onNudge}
            disabled={pea.isMe || nudging}
            accessibilityLabel={`Nudge ${pea.member.display_name}`}
            style={[
              styles.actionButton,
              { backgroundColor: colors.cardBorder, opacity: pea.isMe || nudging ? 0.35 : 1 },
            ]}
          >
            <Text style={{ fontSize: 16 }}>{nudging ? '…' : '🎉'}</Text>
          </Pressable>
          <Pressable
            onPress={onCenter}
            disabled={!hasLocation}
            accessibilityLabel={`Locate ${pea.member.display_name}`}
            style={[
              styles.actionButton,
              { backgroundColor: colors.accentDim, opacity: hasLocation ? 1 : 0.35 },
            ]}
          >
            <Ionicons name="locate" size={18} color={colors.accent} />
          </Pressable>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: spacing.sm,
    gap: spacing.sm,
  },
  identity: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  identityText: { flex: 1, minWidth: 0, gap: 1 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.xs },
  actionButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

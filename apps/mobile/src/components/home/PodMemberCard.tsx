/**
 * Member cards for the Home sheet.
 *
 * Compact: short wide row — avatar, ellipsized name + location, battery at
 * the right. Expanded: full-width vertical card with identity row, actions,
 * and a 4-column stats grid (labels above values).
 */

import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { radius, spacing, themeColors } from '@/theme';
import { useSession } from '@/store/session';
import { COMPACT_CARD_HEIGHT, type MapPea } from './model';
import { StatusMetrics, batteryIcon, batteryTint } from './StatusMetrics';

interface Props {
  pea: MapPea;
  width?: number;
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
  const chargeColor = batteryTint(pea.battery, pea.charging, colors);

  if (!detailed) {
    return (
      <Pressable
        onPress={onOpenDirect}
        disabled={pea.isMe}
        accessibilityLabel={pea.isMe ? pea.member.display_name : `Message ${pea.member.display_name}`}
        style={[
          styles.compact,
          { width, backgroundColor: colors.card, borderColor: colors.cardBorder },
        ]}
      >
        <View style={styles.compactAvatar}>
          <Avatar
            name={pea.member.display_name}
            id={pea.member.id}
            uri={pea.member.avatar_url}
            size={40}
          />
        </View>
        <View style={styles.compactBody}>
          <Text
            style={{ color: colors.text, fontWeight: '800', fontSize: 14 }}
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {pea.isMe ? 'You' : pea.member.display_name}
          </Text>
          <Text
            style={{ color: colors.textMuted, fontSize: 11 }}
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {pea.locationLabel} · {pea.lastSeenLabel}
          </Text>
        </View>
        <View style={styles.compactBattery}>
          <Ionicons name={batteryIcon(pea.battery, pea.charging)} size={14} color={chargeColor} />
          <Text style={{ color: chargeColor, fontWeight: '800', fontSize: 11 }}>
            {pea.battery == null ? 'N/A' : `${pea.battery}%`}
          </Text>
        </View>
      </Pressable>
    );
  }

  return (
    <Pressable
      onPress={onOpenDirect}
      disabled={pea.isMe}
      accessibilityLabel={pea.isMe ? pea.member.display_name : `Message ${pea.member.display_name}`}
      style={[styles.expanded, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}
    >
      <View style={styles.topRow}>
        <Avatar
          name={pea.member.display_name}
          id={pea.member.id}
          uri={pea.member.avatar_url}
          size={44}
        />
        <View style={styles.compactText}>
          <Text style={{ color: colors.text, fontWeight: '800', fontSize: 16 }} numberOfLines={1}>
            {pea.isMe ? `${pea.member.display_name} (You)` : pea.member.display_name}
          </Text>
          <Text style={{ color: colors.textMuted, fontSize: 12 }} numberOfLines={1}>
            {pea.locationLabel} · {pea.lastSeenLabel}
          </Text>
        </View>
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
        <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
      </View>
      <StatusMetrics pea={pea} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  compact: {
    height: COMPACT_CARD_HEIGHT,
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    overflow: 'hidden',
  },
  compactAvatar: { width: 40, height: 40, flexShrink: 0 },
  compactBody: {
    flex: 1,
    minWidth: 0,
    marginLeft: spacing.md,
    marginRight: spacing.sm,
    flexDirection: 'column',
    justifyContent: 'center',
  },
  compactText: { flex: 1, minWidth: 0, gap: 2 },
  compactBattery: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    alignSelf: 'flex-start',
    flexShrink: 0,
  },
  expanded: {
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: spacing.md,
    gap: spacing.md,
  },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  actionButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

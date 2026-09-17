/**
 * Live-status card for one member. Compact (sheet collapsed) shows identity,
 * place, last ping, and battery. Detailed (sheet expanded) adds distance
 * from the current user, network, and speed.
 *
 * Distance comes from MapPea.distanceLabel (haversine + formatDistance).
 */

import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { radius, spacing, themeColors } from '@/theme';
import { useSession } from '@/store/session';
import type { MapPea } from './model';

interface Props {
  pea: MapPea;
  width: number;
  detailed: boolean;
  onCenter: () => void;
  onNudge: () => void;
  onOpenDirect: () => void;
  nudging?: boolean;
}

function networkLabel(value?: string): string {
  if (!value || value === 'unknown') return 'Unknown';
  if (value === 'wifi') return 'Wi-Fi';
  if (value === 'cellular') return 'Data';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function batteryIcon(percentage: number | undefined, charging: boolean): keyof typeof Ionicons.glyphMap {
  if (charging) return 'battery-charging';
  if (percentage == null || percentage <= 15) return 'battery-dead';
  if (percentage >= 75) return 'battery-full';
  return 'battery-half';
}

function batteryColor(
  percentage: number | undefined,
  charging: boolean,
  colors: ReturnType<typeof themeColors>,
): string {
  if (charging) return colors.accent;
  if (percentage == null) return colors.textMuted;
  if (percentage <= 15) return colors.danger;
  if (percentage <= 30) return colors.danger;
  return colors.accent;
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
  const speedKmh = Math.max(0, pea.speed * 3.6);
  const hasLocation = pea.latitude != null && pea.longitude != null;
  const chargeColor = batteryColor(pea.battery, pea.charging, colors);

  return (
    <View style={[styles.card, { width, backgroundColor: colors.card, borderColor: colors.cardBorder }]}>
      <Pressable
        onPress={() => onOpenDirect()}
        disabled={pea.isMe}
        accessibilityLabel={`Message ${pea.member.display_name}`}
        style={styles.identity}
      >
        <Avatar
          name={pea.member.display_name}
          id={pea.member.id}
          uri={pea.member.avatar_url}
          size={40}
        />
        <Text style={{ color: colors.text, fontWeight: '800', fontSize: 14 }} numberOfLines={1}>
          {pea.isMe ? 'You' : pea.member.display_name}
        </Text>
        <Text style={{ color: colors.textMuted, fontSize: 11 }} numberOfLines={1}>
          {pea.locationLabel}
        </Text>
        <Text style={{ color: colors.textMuted, fontSize: 11 }} numberOfLines={1}>
          {pea.lastSeenLabel}
        </Text>
      </Pressable>

      <View style={styles.batteryRow}>
        <Ionicons name={batteryIcon(pea.battery, pea.charging)} size={16} color={chargeColor} />
        <Text style={{ color: chargeColor, fontWeight: '700', fontSize: 12 }}>
          {pea.battery == null ? 'N/A' : `${pea.battery}%`}
        </Text>
      </View>

      {detailed ? (
        <>
          <View style={[styles.metrics, { borderTopColor: colors.cardBorder }]}>
            <Metric icon="navigate" label="Apart" value={pea.distanceLabel} />
            <Metric icon="cellular" label="Network" value={networkLabel(pea.connection)} />
            <Metric icon="speedometer" label="Speed" value={`${speedKmh.toFixed(speedKmh >= 10 ? 0 : 1)} km/h`} />
          </View>
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
        </>
      ) : null}
    </View>
  );
}

function Metric({
  icon,
  label,
  value,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
}) {
  const colors = themeColors(useSession((state) => state.darkMode));
  return (
    <View style={styles.metric}>
      <Ionicons name={icon} size={13} color={colors.accent} />
      <Text style={{ color: colors.textMuted, fontSize: 8, textTransform: 'uppercase' }}>{label}</Text>
      <Text style={{ color: colors.text, fontWeight: '700', fontSize: 10 }} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: spacing.sm,
    gap: spacing.xs,
  },
  identity: { alignItems: 'flex-start', gap: 2 },
  batteryRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: spacing.xs },
  metrics: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing.sm,
    flexDirection: 'row',
  },
  metric: { flex: 1, alignItems: 'center', gap: 2, minWidth: 0 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.xs, marginTop: spacing.xs },
  actionButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

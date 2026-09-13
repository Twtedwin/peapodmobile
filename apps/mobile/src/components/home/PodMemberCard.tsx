/**
 * Detailed live-status card for one member of the active pod.
 */

import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { radius, spacing, themeColors } from '@/theme';
import { useSession } from '@/store/session';
import type { MapPea } from './model';

interface Props {
  pea: MapPea;
  onCenter: () => void;
  onNudge: () => void;
  onOpenDirect: () => void;
  nudging?: boolean;
}

function networkLabel(value?: string): string {
  if (!value || value === 'unknown') return 'Unknown';
  if (value === 'cellular') return 'Data';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function batteryIcon(percentage: number | undefined, charging: boolean): keyof typeof Ionicons.glyphMap {
  if (charging) return 'battery-charging';
  if (percentage == null || percentage <= 15) return 'battery-dead';
  if (percentage >= 75) return 'battery-full';
  return 'battery-half';
}

export function PodMemberCard({ pea, onCenter, onNudge, onOpenDirect, nudging = false }: Props) {
  const colors = themeColors(useSession((state) => state.darkMode));
  const speedKmh = Math.max(0, pea.speed * 3.6);
  const hasLocation = pea.latitude != null && pea.longitude != null;

  return (
    <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}>
      <View style={styles.identity}>
        <Pressable
          onPress={onOpenDirect}
          disabled={pea.isMe}
          accessibilityLabel={`Message ${pea.member.display_name}`}
          style={styles.identityTap}
        >
          <Avatar
            name={pea.member.display_name}
            id={pea.member.id}
            uri={pea.member.avatar_url}
            size={48}
          />
          <View style={{ flex: 1 }}>
            <View style={styles.nameRow}>
              <Text style={{ color: colors.text, fontWeight: '800', fontSize: 16 }} numberOfLines={1}>
                {pea.isMe ? `${pea.member.display_name} (You)` : pea.member.display_name}
              </Text>
              <View style={[styles.onlineDot, { backgroundColor: pea.online ? colors.accent : colors.textMuted }]} />
            </View>
            <Text style={{ color: colors.textMuted, marginTop: 3 }} numberOfLines={1}>
              {pea.locationLabel}
            </Text>
          </View>
        </Pressable>
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
            <Text style={{ fontSize: 18 }}>{nudging ? '…' : '🎉'}</Text>
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
            <Ionicons name="locate" size={21} color={colors.accent} />
          </Pressable>
        </View>
      </View>

      <View style={[styles.metrics, { borderTopColor: colors.cardBorder }]}>
        <Metric
          icon={batteryIcon(pea.battery, pea.charging)}
          label="Battery"
          value={pea.battery == null ? 'N/A' : `${pea.battery}%`}
        />
        <Metric icon="cellular" label="Network" value={networkLabel(pea.connection)} />
        <Metric icon="navigate" label="Apart" value={pea.distanceLabel} />
        <Metric icon="speedometer" label="Speed" value={`${speedKmh.toFixed(speedKmh >= 10 ? 0 : 1)} km/h`} />
      </View>
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
      <Ionicons name={icon} size={15} color={colors.accent} />
      <Text style={{ color: colors.textMuted, fontSize: 9, textTransform: 'uppercase' }}>{label}</Text>
      <Text style={{ color: colors.text, fontWeight: '700', fontSize: 11 }} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: spacing.md,
    gap: spacing.md,
  },
  identity: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  identityTap: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  onlineDot: { width: 8, height: 8, borderRadius: 4 },
  actions: { flexDirection: 'row', gap: spacing.xs },
  actionButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  metrics: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing.md,
    flexDirection: 'row',
  },
  metric: { flex: 1, alignItems: 'center', gap: 3, minWidth: 0 },
});

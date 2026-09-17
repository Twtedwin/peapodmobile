/**
 * Four-column live stats: Battery, Network, Apart (haversine), Speed.
 *
 * Each column is flex:1. The uppercase label sits above the value so
 * "BATTERY" cannot wrap into "BATTER Y" on a narrow card.
 */

import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';

import { themeColors } from '@/theme';
import { useSession } from '@/store/session';
import type { MapPea } from './model';

export function networkLabel(value?: string): string {
  if (!value || value === 'unknown') return 'Unknown';
  if (value === 'wifi') return 'Wi-Fi';
  if (value === 'cellular') return 'Data';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function networkIcon(value?: string): keyof typeof Ionicons.glyphMap {
  if (value === 'wifi') return 'wifi';
  return 'cellular';
}

export function batteryIcon(
  percentage: number | undefined,
  charging: boolean,
): keyof typeof Ionicons.glyphMap {
  if (charging) return 'battery-charging';
  if (percentage == null || percentage <= 15) return 'battery-dead';
  if (percentage >= 75) return 'battery-full';
  return 'battery-half';
}

export function batteryTint(
  percentage: number | undefined,
  charging: boolean,
  colors: ReturnType<typeof themeColors>,
): string {
  if (charging) return colors.accent;
  if (percentage == null) return colors.textMuted;
  if (percentage <= 15) return colors.danger;
  if (percentage <= 30) return '#E0B04A';
  return colors.accent;
}

interface Props {
  pea: MapPea;
}

export function StatusMetrics({ pea }: Props) {
  const colors = themeColors(useSession((state) => state.darkMode));
  const speedKmh = Math.max(0, pea.speed * 3.6);
  const chargeColor = batteryTint(pea.battery, pea.charging, colors);

  return (
    <View style={styles.row}>
      <Metric
        icon={batteryIcon(pea.battery, pea.charging)}
        iconColor={chargeColor}
        label="Battery"
        value={pea.battery == null ? 'N/A' : `${pea.battery}%`}
        valueColor={chargeColor}
      />
      <Metric
        icon={networkIcon(pea.connection)}
        iconColor={colors.accent}
        label="Net"
        value={networkLabel(pea.connection)}
        valueColor={colors.text}
      />
      <Metric
        icon="navigate"
        iconColor={colors.accent}
        label="Apart"
        value={pea.distanceLabel}
        valueColor={colors.text}
      />
      <Metric
        icon="speedometer"
        iconColor={colors.accent}
        label="Speed"
        value={`${speedKmh.toFixed(0)}`}
        valueColor={colors.text}
      />
    </View>
  );
}

function Metric({
  icon,
  iconColor,
  label,
  value,
  valueColor,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  iconColor: string;
  label: string;
  value: string;
  valueColor: string;
}) {
  const colors = themeColors(useSession((state) => state.darkMode));
  return (
    <View style={styles.metric}>
      <Text
        numberOfLines={1}
        style={{
          color: colors.textMuted,
          fontSize: 9,
          fontWeight: '700',
          letterSpacing: 0.6,
          textTransform: 'uppercase',
        }}
      >
        {label}
      </Text>
      <View style={styles.valueRow}>
        <Ionicons name={icon} size={15} color={iconColor} />
        <Text numberOfLines={1} style={{ color: valueColor, fontWeight: '800', fontSize: 12, flexShrink: 1 }}>
          {value}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', width: '100%' },
  metric: { flex: 1, minWidth: 0, alignItems: 'center', gap: 4, paddingHorizontal: 2 },
  valueRow: { flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: '100%' },
});

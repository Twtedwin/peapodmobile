/**
 * Four-column live stats: Battery, Network, Apart (haversine), Speed.
 *
 * Always laid out in one horizontal row so member cards and the DM modal
 * match the Home mockups. Speed is metres/second on the pea, shown as km/h.
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
  if (percentage <= 30) return colors.danger;
  return colors.accent;
}

interface Props {
  pea: MapPea;
  compact?: boolean;
}

export function StatusMetrics({ pea, compact = false }: Props) {
  const colors = themeColors(useSession((state) => state.darkMode));
  const speedKmh = Math.max(0, pea.speed * 3.6);
  const chargeColor = batteryTint(pea.battery, pea.charging, colors);
  const iconSize = compact ? 14 : 17;
  const labelSize = compact ? 8 : 9;
  const valueSize = compact ? 10 : 11;

  return (
    <View style={styles.row}>
      <Metric
        icon={batteryIcon(pea.battery, pea.charging)}
        iconColor={chargeColor}
        label="Battery"
        value={pea.battery == null ? 'N/A' : `${pea.battery}%`}
        valueColor={chargeColor}
        iconSize={iconSize}
        labelSize={labelSize}
        valueSize={valueSize}
      />
      <Metric
        icon="cellular"
        iconColor={colors.accent}
        label="Net"
        value={networkLabel(pea.connection)}
        valueColor={colors.text}
        iconSize={iconSize}
        labelSize={labelSize}
        valueSize={valueSize}
      />
      <Metric
        icon="navigate"
        iconColor={colors.accent}
        label="Apart"
        value={pea.distanceLabel}
        valueColor={colors.text}
        iconSize={iconSize}
        labelSize={labelSize}
        valueSize={valueSize}
      />
      <Metric
        icon="speedometer"
        iconColor={colors.accent}
        label="Speed"
        value={`${speedKmh.toFixed(speedKmh >= 10 ? 0 : 1)} km/h`}
        valueColor={colors.text}
        iconSize={iconSize}
        labelSize={labelSize}
        valueSize={valueSize}
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
  iconSize,
  labelSize,
  valueSize,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  iconColor: string;
  label: string;
  value: string;
  valueColor: string;
  iconSize: number;
  labelSize: number;
  valueSize: number;
}) {
  const colors = themeColors(useSession((state) => state.darkMode));
  return (
    <View style={styles.metric}>
      <Ionicons name={icon} size={iconSize} color={iconColor} />
      <Text style={{ color: colors.textMuted, fontSize: labelSize, textTransform: 'uppercase' }}>
        {label}
      </Text>
      <Text style={{ color: valueColor, fontWeight: '800', fontSize: valueSize }} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', width: '100%' },
  metric: { flex: 1, minWidth: 0, alignItems: 'center', gap: 2 },
});

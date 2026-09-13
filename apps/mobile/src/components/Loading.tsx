/**
 * MODULE: apps/mobile/src/components/Loading.tsx
 *
 * PURPOSE
 *   Centered spinner used while the first fetch of a screen is in flight.
 *
 * INPUTS  : optional label
 * OUTPUTS : a View
 * CONSUMED BY : every data screen
 */

import { StyleSheet, Text, View } from 'react-native';

import { Spinner } from '@/components/Spinner';
import { useSession } from '@/store/session';
import { spacing, themeColors } from '@/theme';

export function Loading({ label = 'Loading…' }: { label?: string }) {
  const dark = useSession((s) => s.darkMode);
  const colors = themeColors(dark);
  return (
    <View style={styles.wrap}>
      <Spinner color={colors.accent} size={28} />
      <Text style={{ color: colors.textMuted, marginTop: spacing.md }}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

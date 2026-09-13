/**
 * MODULE: apps/mobile/src/components/SimulatedBanner.tsx
 *
 * PURPOSE
 *   The large "Simulated money" warning. The wallet ledger is real (integer
 *   minor units, append-only) but no payment provider is wired, so every
 *   money screen must say so in a way nobody can miss.
 *
 * INPUTS  : optional override copy
 * OUTPUTS : a View
 * CONSUMED BY : Wallet, Trip book flow
 */

import { StyleSheet, Text, View } from 'react-native';

import { useSession } from '@/store/session';
import { radius, spacing, themeColors, type as typeScale } from '@/theme';

interface Props {
  title?: string;
  body?: string;
}

export function SimulatedBanner({
  title = 'Simulated money',
  body = 'Nothing here moves real funds. Add, request, split and pay update the pod ledger only.',
}: Props) {
  const dark = useSession((s) => s.darkMode);
  const colors = themeColors(dark);

  return (
    <View style={[styles.banner, { backgroundColor: colors.accentDim, borderColor: colors.accent }]}>
      <Text style={[typeScale.overline, { color: colors.accent }]}>{title}</Text>
      <Text style={[typeScale.body, { color: colors.text, marginTop: spacing.xs }]}>{body}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: spacing.lg,
  },
});

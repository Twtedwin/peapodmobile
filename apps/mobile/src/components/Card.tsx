/**
 * MODULE: apps/mobile/src/components/Card.tsx
 *
 * PURPOSE
 *   Raised surface used for lists (plans, bills, garden plots, members).
 *
 * INPUTS  : children, optional onPress
 * OUTPUTS : a View or Pressable
 * CONSUMED BY : Plans, Wallet, World, You
 */

import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';

import { useSession } from '@/store/session';
import { radius, spacing, themeColors } from '@/theme';

interface Props {
  children: ReactNode;
  onPress?: () => void;
  style?: ViewStyle;
}

export function Card({ children, onPress, style }: Props) {
  const dark = useSession((s) => s.darkMode);
  const colors = themeColors(dark);
  const body = (
    <View
      style={[
        styles.card,
        { backgroundColor: colors.card, borderColor: colors.cardBorder },
        style,
      ]}
    >
      {children}
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}>
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: spacing.lg,
  },
});

/**
 * MODULE: apps/mobile/src/components/Pill.tsx
 *
 * PURPOSE
 *   Compact labelled chip for filters, trip status, and selected countries.
 *
 * INPUTS  : label, selected, onPress, emoji
 * OUTPUTS : a Pressable
 * CONSUMED BY : World, Date planner, Trip wizard, Plans
 */

import { Pressable, StyleSheet, Text } from 'react-native';

import { useSession } from '@/store/session';
import { radius, spacing, themeColors } from '@/theme';

interface Props {
  label: string;
  emoji?: string;
  selected?: boolean;
  onPress?: () => void;
}

export function Pill({ label, emoji, selected = false, onPress }: Props) {
  const dark = useSession((s) => s.darkMode);
  const colors = themeColors(dark);

  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={[
        styles.pill,
        {
          backgroundColor: selected ? colors.accent : colors.card,
          borderColor: selected ? colors.accent : colors.cardBorder,
        },
      ]}
    >
      <Text style={{ color: selected ? colors.accentText : colors.text, fontWeight: '600', fontSize: 13 }}>
        {emoji ? `${emoji}  ${label}` : label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
});

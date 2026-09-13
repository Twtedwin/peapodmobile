/**
 * MODULE: apps/mobile/src/components/Button.tsx
 *
 * PURPOSE
 *   Primary / secondary / ghost / danger pressable used on every screen so
 *   padding, radius, and disabled opacity cannot drift.
 *
 * INPUTS  : label, variant, loading, onPress, disabled
 * OUTPUTS : a Pressable
 * CONSUMED BY : auth screens, FABs' sheets, wallet actions, trip wizard
 */

import { Pressable, StyleSheet, Text } from 'react-native';

import { Spinner } from '@/components/Spinner';
import { useSession } from '@/store/session';
import { radius, spacing, themeColors } from '@/theme';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface Props {
  label: string;
  onPress: () => void;
  variant?: Variant;
  loading?: boolean;
  disabled?: boolean;
  compact?: boolean;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  loading = false,
  disabled = false,
  compact = false,
}: Props) {
  const dark = useSession((s) => s.darkMode);
  const colors = themeColors(dark);
  const idle = disabled || loading;

  const background =
    variant === 'primary'
      ? colors.accent
      : variant === 'danger'
        ? colors.danger
        : variant === 'secondary'
          ? colors.card
          : 'transparent';
  const foreground =
    variant === 'primary' || variant === 'danger' ? colors.accentText : colors.text;
  const borderColor = variant === 'secondary' ? colors.cardBorder : 'transparent';

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={idle}
      style={({ pressed }) => [
        styles.base,
        compact ? styles.compact : styles.full,
        {
          backgroundColor: background,
          borderColor,
          opacity: idle ? 0.55 : pressed ? 0.88 : 1,
        },
      ]}
    >
      {loading ? (
        <Spinner color={foreground} size={18} />
      ) : (
        <Text style={[styles.label, { color: foreground }]}>{label}</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  full: {
    minHeight: 52,
    paddingHorizontal: spacing.xl,
  },
  compact: {
    minHeight: 40,
    paddingHorizontal: spacing.lg,
  },
  label: {
    fontSize: 16,
    fontWeight: '700',
  },
});

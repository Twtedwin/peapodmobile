/**
 * MODULE: apps/mobile/src/components/Screen.tsx
 *
 * PURPOSE
 *   Safe-area-aware page wrapper that paints the theme background. Auth
 *   screens pass `scroll`; tab screens usually pass `edges` to skip the
 *   bottom inset (the tab bar already owns it).
 *
 * INPUTS  : children, scroll, padded
 * OUTPUTS : SafeAreaView, optionally wrapping a ScrollView
 * CONSUMED BY : every route
 */

import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useSession } from '@/store/session';
import { spacing, themeColors } from '@/theme';

interface Props {
  children: ReactNode;
  scroll?: boolean;
  padded?: boolean;
  edges?: ('top' | 'right' | 'bottom' | 'left')[];
}

export function Screen({ children, scroll = false, padded = true, edges }: Props) {
  const dark = useSession((s) => s.darkMode);
  const colors = themeColors(dark);
  const inner = padded ? <View style={styles.pad}>{children}</View> : children;

  return (
    <SafeAreaView style={[styles.flex, { backgroundColor: colors.bg }]} edges={edges ?? ['top', 'left', 'right']}>
      {scroll ? (
        <ScrollView
          contentContainerStyle={padded ? styles.scrollPad : undefined}
          keyboardShouldPersistTaps="handled"
        >
          {children}
        </ScrollView>
      ) : (
        inner
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  pad: { flex: 1, paddingHorizontal: spacing.lg },
  scrollPad: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxxl },
});

/**
 * MODULE: apps/mobile/src/components/Sheet.tsx
 *
 * PURPOSE
 *   Bottom sheet overlay used for chat, member stats, create-plan, and the
 *   notifications list. A simple Modal + View rather than a native module,
 *   so Expo Go can render it.
 *
 * INPUTS  : visible, title, onClose, children
 * OUTPUTS : a Modal
 * CONSUMED BY : Home, Plans, Wallet, You
 */

import type { ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useSession } from '@/store/session';
import { radius, spacing, themeColors, type as typeScale } from '@/theme';

interface Props {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** When true the sheet fills most of the screen (chat, itinerary extras). */
  tall?: boolean;
}

export function Sheet({ visible, title, onClose, children, tall = false }: Props) {
  const dark = useSession((s) => s.darkMode);
  const colors = themeColors(dark);
  const insets = useSafeAreaInsets();

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close sheet" />
        <View
          style={[
            styles.sheet,
            {
              backgroundColor: colors.bgElevated,
              paddingBottom: Math.max(insets.bottom, spacing.lg),
              maxHeight: tall ? '92%' : '78%',
            },
          ]}
        >
          <View style={styles.handleWrap}>
            <View style={[styles.handle, { backgroundColor: colors.cardBorder }]} />
          </View>
          <View style={styles.header}>
            <Text style={[typeScale.title, { color: colors.text, flex: 1 }]}>{title}</Text>
            <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button">
              <Text style={{ color: colors.textMuted, fontSize: 16 }}>Close</Text>
            </Pressable>
          </View>
          {children}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(8, 12, 10, 0.55)',
  },
  sheet: {
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingHorizontal: spacing.lg,
    minHeight: 220,
  },
  handleWrap: { alignItems: 'center', paddingTop: spacing.sm },
  handle: { width: 40, height: 4, borderRadius: 2 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    gap: spacing.md,
  },
});

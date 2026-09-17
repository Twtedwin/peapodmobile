/**
 * Centered overlay card used for Create pod and Join with a code.
 *
 * INPUTS  : visible, title, onClose, children
 * OUTPUTS : a fade Modal with a dimmed full-screen overlay
 *
 * Why a dedicated component: the membership Sheet slides from the bottom;
 * the mockups put these forms in the middle of the map.
 */

import type { ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { useSession } from '@/store/session';
import { radius, spacing, themeColors, type as typeScale } from '@/theme';

interface Props {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}

export function CenterModal({ visible, title, onClose, children }: Props) {
  const colors = themeColors(useSession((state) => state.darkMode));

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Dismiss" />
        <View style={[styles.card, { backgroundColor: colors.bgElevated, borderColor: colors.cardBorder }]}>
          <View style={styles.header}>
            <Text style={[typeScale.subtitle, { color: colors.text, flex: 1 }]}>{title}</Text>
            <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
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
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    backgroundColor: 'rgba(8, 12, 10, 0.72)',
  },
  card: {
    borderRadius: radius.xl,
    borderWidth: 1,
    padding: spacing.lg,
    gap: spacing.md,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
});

/**
 * Centered Direct Message popup over the Home map.
 *
 * INPUTS  : visible, target MapPea, onClose
 * OUTPUTS : a fade Modal with a dim overlay — not a full-screen route
 */

import { Modal, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';

import { useSession } from '@/store/session';
import { radius, spacing, themeColors } from '@/theme';
import { DirectMessageThread } from './DirectMessageThread';
import type { MapPea } from './model';

interface Props {
  visible: boolean;
  pea: MapPea | null;
  onClose: () => void;
}

export function DirectMessageModal({ visible, pea, onClose }: Props) {
  const colors = themeColors(useSession((state) => state.darkMode));
  const { height } = useWindowDimensions();

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Dismiss messages" />
        {pea ? (
          <View
            style={[
              styles.card,
              {
                backgroundColor: colors.bgElevated,
                borderColor: colors.cardBorder,
                maxHeight: height * 0.82,
              },
            ]}
          >
            <DirectMessageThread pea={pea} onClose={onClose} />
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    backgroundColor: 'rgba(8, 12, 10, 0.72)',
  },
  card: {
    borderRadius: radius.xl,
    borderWidth: 1,
    padding: spacing.lg,
    minHeight: 480,
  },
});

/**
 * MODULE: apps/mobile/src/components/Avatar.tsx
 *
 * PURPOSE
 *   Circular pea avatar. Images are optional; the fallback is the first
 *   letter of the display name on a colour hashed from the user id, or an
 *   emoji when one is supplied. No PNG assets are required.
 *
 * INPUTS  : name, uri, emoji, size, id
 * OUTPUTS : a View
 * CONSUMED BY : Home member list, You tab, chat
 */

import { Image, StyleSheet, Text, View } from 'react-native';

import { colorForId, themeColors } from '@/theme';
import { useSession } from '@/store/session';

interface Props {
  name: string;
  id?: string;
  uri?: string | null;
  emoji?: string | null;
  size?: number;
}

export function Avatar({ name, id, uri, emoji, size = 40 }: Props) {
  const dark = useSession((s) => s.darkMode);
  const colors = themeColors(dark);
  const letter = (name || '?').trim().charAt(0).toUpperCase();
  const bg = colorForId(id || name);

  if (uri) {
    return (
      <Image
        source={{ uri }}
        style={[styles.circle, { width: size, height: size, borderRadius: size / 2 }]}
        accessibilityLabel={name}
      />
    );
  }

  return (
    <View
      style={[
        styles.circle,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: bg,
        },
      ]}
    >
      <Text style={[styles.glyph, { fontSize: emoji ? size * 0.5 : size * 0.42, color: colors.accentText }]}>
        {emoji || letter}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  circle: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  glyph: {
    fontWeight: '700',
  },
});

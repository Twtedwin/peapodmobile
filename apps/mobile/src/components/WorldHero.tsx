/**
 * MODULE: apps/mobile/src/components/WorldHero.tsx
 *
 * PURPOSE
 *   Hero art for the World tab: a pea-green globe. Drawn with views that
 *   ship in Expo Go — no expo-three, no extra native modules.
 *
 * WHY NOT expo-three
 *   expo-three@8 does `import '@expo/browser-polyfill'`. That package is
 *   nested under expo-three/node_modules and is not hoisted. Metro is
 *   configured with disableHierarchicalLookup so React/RN stay a single
 *   copy, which also means nested deps are invisible. Bundle then 500s.
 *   A View globe is enough for this screen and cannot fail to bundle.
 *
 * INPUTS  : size (dp)
 * OUTPUTS : a View
 * CONSUMED BY : the World tab
 */

import { StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

import { useSession } from '@/store/session';
import { themeColors } from '@/theme';

interface Props {
  size?: number;
}

export function WorldHero({ size = 220 }: Props) {
  const dark = useSession((s) => s.darkMode);
  const colors = themeColors(dark);

  return (
    <View
      style={[
        styles.wrap,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: colors.accentDim,
        },
      ]}
    >
      <LinearGradient
        colors={['#9EE88A', '#4CAF50', '#1B5E20']}
        start={{ x: 0.2, y: 0 }}
        end={{ x: 0.9, y: 1 }}
        style={[StyleSheet.absoluteFill, { borderRadius: size / 2 }]}
      />
      <Text style={{ fontSize: size * 0.42 }}>🌍</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
});

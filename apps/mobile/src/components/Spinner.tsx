/**
 * MODULE: apps/mobile/src/components/Spinner.tsx
 *
 * PURPOSE
 *   A loading glyph that does not use React Native's ActivityIndicator
 *   and does not start a native-driver animation.
 *
 * WHY NOT ActivityIndicator
 *   On Android, ActivityIndicator renders native `AndroidProgressBar`.
 *   This app is a monorepo: npm had two react-native copies (0.81.4 at
 *   the repo root, 0.81.5 under apps/mobile). Expo Go's Fabric renderer
 *   loaded from one copy while ProgressBarAndroid loaded from the other,
 *   so the view-config registry had no getter for `AndroidProgressBar`
 *   → "must be a function (received undefined)".
 *
 * WHY NOT Animated + useNativeDriver
 *   That path also talks to a native module on the mismatched copy.
 *   A plain View is registered in every RN binary.
 *
 * INPUTS  : color, optional size (dp)
 * OUTPUTS : a View
 * CONSUMED BY : Loading, Button, root layout, index gate
 */

import { View } from 'react-native';

export function Spinner({ color, size = 22 }: { color: string; size?: number }) {
  const border = Math.max(2, Math.round(size / 8));
  return (
    <View
      accessibilityRole="progressbar"
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: border,
        borderColor: color,
        borderTopColor: 'transparent',
      }}
    />
  );
}

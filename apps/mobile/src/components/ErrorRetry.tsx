/**
 * MODULE: apps/mobile/src/components/ErrorRetry.tsx
 *
 * PURPOSE
 *   The empty/error state every screen shows when the network is down. The
 *   brief requires every screen to be reachable and not crash without a
 *   network: this is how.
 *
 * INPUTS  : message, onRetry
 * OUTPUTS : a View with a retry button
 * CONSUMED BY : every data screen
 */

import { StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { useSession } from '@/store/session';
import { spacing, themeColors, type as typeScale } from '@/theme';

interface Props {
  message?: string;
  onRetry?: () => void;
}

export function ErrorRetry({
  message = 'Could not reach Peapod. Check your connection and try again.',
  onRetry,
}: Props) {
  const dark = useSession((s) => s.darkMode);
  const colors = themeColors(dark);

  return (
    <View style={styles.wrap}>
      <Text style={{ fontSize: 40, marginBottom: spacing.md }}>🫛</Text>
      <Text style={[typeScale.subtitle, { color: colors.text, textAlign: 'center' }]}>
        Something went quiet
      </Text>
      <Text style={[typeScale.body, { color: colors.textMuted, textAlign: 'center', marginTop: spacing.sm }]}>
        {message}
      </Text>
      {onRetry ? (
        <View style={{ marginTop: spacing.xl, alignSelf: 'stretch' }}>
          <Button label="Try again" onPress={onRetry} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
});

/**
 * Floating identity chip for the signed-in pea, parked above the member sheet.
 */

import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import type { LocalFix } from '@/hooks/useLocationPings';
import { radius, spacing, themeColors } from '@/theme';
import { useSession } from '@/store/session';
import type { MapPea } from './model';

interface Props {
  pea: MapPea | undefined;
  myFix: LocalFix | null;
  bottom: number;
  onCenterMe: () => void;
  onOpenProfile: () => void;
}

export function CurrentUserPill({ pea, myFix, bottom, onCenterMe, onOpenProfile }: Props) {
  const colors = themeColors(useSession((state) => state.darkMode));

  return (
    <View style={[styles.wrap, { bottom, backgroundColor: colors.overlay }]}>
      <Avatar
        name={pea?.member.display_name ?? 'You'}
        id={pea?.member.id}
        uri={pea?.member.avatar_url}
        size={36}
      />
      <View style={styles.text}>
        <Text style={{ color: colors.cream, fontWeight: '800' }} numberOfLines={1}>
          {pea?.member.display_name ?? 'You'}
        </Text>
        <Text style={{ color: colors.textMuted, fontSize: 10 }} numberOfLines={1}>
          {pea
            ? `${pea.locationLabel} · ${pea.lastSeenLabel}`
            : 'Waiting for your location…'}
        </Text>
      </View>
      <Pressable
        onPress={onCenterMe}
        disabled={!myFix}
        accessibilityLabel="Center on me"
        style={[styles.locate, { backgroundColor: colors.accentDim, opacity: myFix ? 1 : 0.4 }]}
      >
        <Ionicons name="locate" size={18} color={colors.accent} />
      </Pressable>
      <Pressable onPress={onOpenProfile} hitSlop={8} accessibilityLabel="Open profile">
        <Ionicons name="chevron-forward" size={18} color={colors.cream} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    zIndex: 18,
    left: spacing.md,
    maxWidth: '70%',
    minHeight: 56,
    padding: spacing.sm,
    borderRadius: radius.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  text: { flexShrink: 1, minWidth: 76 },
  locate: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

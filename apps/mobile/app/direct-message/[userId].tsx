/**
 * MODULE: apps/mobile/app/direct-message/[userId]
 *
 * PURPOSE
 *   Full-screen private conversation (deep link / stack). Home opens the same
 *   thread as a centered modal; this route keeps the panel for a dedicated page.
 */

import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DirectMessageThread } from '@/components/home/DirectMessageThread';
import { buildMapPeas } from '@/components/home/model';
import {
  useCurrentPodId,
  useMembers,
  usePlaces,
  usePresence,
  type MemberRow,
} from '@/hooks/usePodData';
import { useSession } from '@/store/session';
import { spacing, themeColors } from '@/theme';

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

export default function DirectMessageScreen() {
  const params = useLocalSearchParams<{ userId: string; name?: string; avatar?: string }>();
  const userId = first(params.userId);
  const fallbackName = first(params.name) || 'Pea';
  const fallbackAvatar = first(params.avatar) || null;
  const colors = themeColors(useSession((state) => state.darkMode));
  const me = useSession((state) => state.user);
  const insets = useSafeAreaInsets();
  const podId = useCurrentPodId();
  const membersQ = useMembers(podId);
  const presenceQ = usePresence(podId);
  const placesQ = usePlaces(podId);

  const targetMember = (membersQ.data ?? []).find((member) => member.id === userId);
  const displayMember: MemberRow =
    targetMember ?? {
      id: userId,
      user_id: userId,
      membership_id: '',
      display_name: fallbackName,
      avatar_url: fallbackAvatar,
    };
  const mePresence = (presenceQ.data ?? []).find((row) => row.user_id === me?.id);
  const myLastFix =
    mePresence?.latitude != null && mePresence.longitude != null
      ? {
          latitude: mePresence.latitude,
          longitude: mePresence.longitude,
          speed: mePresence.speed ?? 0,
          accuracy: mePresence.accuracy ?? 0,
          heading: mePresence.heading ?? 0,
        }
      : null;
  const pea = buildMapPeas(
    [displayMember],
    presenceQ.data ?? [],
    placesQ.data ?? [],
    me?.id,
    myLastFix,
  )[0]!;

  return (
    <View
      style={[
        styles.screen,
        {
          backgroundColor: colors.bg,
          paddingTop: insets.top + spacing.sm,
          paddingBottom: Math.max(insets.bottom, spacing.md),
          paddingHorizontal: spacing.lg,
        },
      ]}
    >
      <DirectMessageThread pea={pea} onClose={() => router.back()} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
});

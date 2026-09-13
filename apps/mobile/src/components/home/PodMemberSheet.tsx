/**
 * Draggable, two-snap member sheet linked to the map viewport.
 *
 * The drag handle owns the pan responder so vertical member-list scrolling
 * remains natural. No custom native bottom-sheet module is required.
 */

/* eslint-disable react-hooks/immutability -- Reanimated SharedValue.value writes are the library's worklet API. */

import { useCallback, useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { Avatar } from '@/components/Avatar';
import { radius, spacing, themeColors } from '@/theme';
import { useSession } from '@/store/session';
import type { MapPea } from './model';
import { PodMemberCard } from './PodMemberCard';

export const COMPACT_SHEET_HEIGHT = 154;

interface Props {
  peas: MapPea[];
  onChat: () => void;
  onCenter: (pea: MapPea) => void;
  onNudge: (pea: MapPea) => Promise<void>;
  onOpenDirect: (pea: MapPea) => void;
  onExpandedChange: (expanded: boolean, height: number) => void;
}

export function PodMemberSheet({
  peas,
  onChat,
  onCenter,
  onNudge,
  onOpenDirect,
  onExpandedChange,
}: Props) {
  const colors = themeColors(useSession((state) => state.darkMode));
  const { height: windowHeight } = useWindowDimensions();
  const expandedHeight = Math.min(560, Math.max(360, windowHeight * 0.58));
  const sheetHeight = useSharedValue(COMPACT_SHEET_HEIGHT);
  const dragStartHeight = useSharedValue(COMPACT_SHEET_HEIGHT);
  const [expanded, setExpanded] = useState(false);
  const [nudgingId, setNudgingId] = useState<string | null>(null);
  const online = peas.filter((pea) => pea.online).length;

  async function nudge(pea: MapPea) {
    setNudgingId(pea.member.id);
    try {
      await onNudge(pea);
    } finally {
      setNudgingId(null);
    }
  }

  const snap = useCallback((nextExpanded: boolean) => {
    const target = nextExpanded ? expandedHeight : COMPACT_SHEET_HEIGHT;
    setExpanded(nextExpanded);
    onExpandedChange(nextExpanded, target);
    sheetHeight.value = withSpring(target, {
      damping: 22,
      stiffness: 190,
      mass: 0.8,
    });
  }, [expandedHeight, onExpandedChange, sheetHeight]);

  const finishDrag = useCallback((nextExpanded: boolean, target: number) => {
    setExpanded(nextExpanded);
    onExpandedChange(nextExpanded, target);
  }, [onExpandedChange]);

  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY([-4, 4])
        .onStart(() => {
          dragStartHeight.value = sheetHeight.value;
        })
        .onUpdate((event) => {
          sheetHeight.value = Math.max(
            COMPACT_SHEET_HEIGHT,
            Math.min(expandedHeight, dragStartHeight.value - event.translationY),
          );
        })
        .onEnd((event) => {
          const midpoint = (COMPACT_SHEET_HEIGHT + expandedHeight) / 2;
          const nextExpanded =
            event.velocityY < -350 ||
            (event.velocityY <= 350 && sheetHeight.value > midpoint);
          const target = nextExpanded ? expandedHeight : COMPACT_SHEET_HEIGHT;
          sheetHeight.value = withSpring(target, {
            damping: 22,
            stiffness: 190,
            mass: 0.8,
          });
          runOnJS(finishDrag)(nextExpanded, target);
        }),
    [dragStartHeight, expandedHeight, finishDrag, sheetHeight],
  );

  const animatedSheetStyle = useAnimatedStyle(() => ({ height: sheetHeight.value }));

  return (
    <Animated.View
      style={[
        styles.sheet,
        animatedSheetStyle,
        {
          backgroundColor: colors.bgElevated,
          borderColor: colors.cardBorder,
        },
      ]}
    >
      <GestureDetector gesture={panGesture}>
        <View>
          <Pressable
            onPress={() => snap(!expanded)}
            style={styles.handleArea}
            accessibilityRole="button"
            accessibilityLabel={expanded ? 'Collapse member sheet' : 'Expand member sheet'}
          >
            <View style={[styles.handle, { backgroundColor: colors.textMuted }]} />
          </Pressable>

          <View style={styles.header}>
            <View>
              <Text style={{ color: colors.text, fontWeight: '800', fontSize: 18 }}>Your peas</Text>
              <Text style={{ color: colors.accent, marginTop: 2 }}>{online} online</Text>
            </View>
            <Pressable
              onPress={onChat}
              style={[styles.chatButton, { backgroundColor: colors.accent }]}
              accessibilityRole="button"
            >
              <Ionicons name="chatbubble-ellipses" size={17} color={colors.accentText} />
              <Text style={{ color: colors.accentText, fontWeight: '800' }}>Chat</Text>
            </Pressable>
          </View>
        </View>
      </GestureDetector>

      {expanded ? (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ gap: spacing.md, paddingBottom: spacing.xl }}
          showsVerticalScrollIndicator={false}
        >
          {peas.map((pea) => (
            <PodMemberCard
              key={pea.member.id}
              pea={pea}
              onCenter={() => onCenter(pea)}
              onNudge={() => void nudge(pea)}
              onOpenDirect={() => onOpenDirect(pea)}
              nudging={nudgingId === pea.member.id}
            />
          ))}
        </ScrollView>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: spacing.sm, paddingBottom: spacing.md }}
        >
          {peas.map((pea) => (
            <Pressable
              key={pea.member.id}
              onPress={() => onOpenDirect(pea)}
              disabled={pea.isMe}
              accessibilityLabel={`Message ${pea.member.display_name}`}
              style={[styles.summary, { backgroundColor: colors.card }]}
            >
              <Avatar
                name={pea.member.display_name}
                id={pea.member.id}
                uri={pea.member.avatar_url}
                size={32}
              />
              <View style={{ maxWidth: 90 }}>
                <Text style={{ color: colors.text, fontWeight: '700' }} numberOfLines={1}>
                  {pea.isMe ? 'You' : pea.member.display_name}
                </Text>
                <Text style={{ color: pea.online ? colors.accent : colors.textMuted, fontSize: 11 }}>
                  {pea.online ? 'Online' : pea.distanceLabel}
                </Text>
              </View>
            </Pressable>
          ))}
        </ScrollView>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: 'absolute',
    zIndex: 15,
    bottom: 0,
    left: 0,
    right: 0,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderWidth: 1,
    paddingHorizontal: spacing.lg,
    overflow: 'hidden',
  },
  handleArea: { height: 28, alignItems: 'center', justifyContent: 'center' },
  handle: { width: 44, height: 4, borderRadius: 2 },
  header: {
    minHeight: 55,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: spacing.sm,
  },
  chatButton: {
    minHeight: 40,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  summary: {
    height: 52,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
});

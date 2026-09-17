/**
 * Two-snap member sheet.
 *
 * Collapsed: green online pill + Chat, then a wide horizontal card carousel.
 * Expanded: full-width vertical member cards with the 4-column stats grid.
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

import { radius, spacing, themeColors } from '@/theme';
import { useSession } from '@/store/session';
import {
  COMPACT_CARD_HEIGHT,
  MEMBER_CAROUSEL_GAP,
  MEMBER_CAROUSEL_PADDING,
  memberCarouselCardWidth,
  type MapPea,
} from './model';
import { PodMemberCard } from './PodMemberCard';

/** Compact snap height: handle + header + one 80px row + bottom padding. */
export const COMPACT_SHEET_HEIGHT = 24 + 52 + COMPACT_CARD_HEIGHT + spacing.md;

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
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const expandedHeight = Math.min(560, Math.max(380, windowHeight * 0.58));
  const sheetHeight = useSharedValue(COMPACT_SHEET_HEIGHT);
  const dragStartHeight = useSharedValue(COMPACT_SHEET_HEIGHT);
  const [expanded, setExpanded] = useState(false);
  const [nudgingId, setNudgingId] = useState<string | null>(null);
  const online = peas.filter((pea) => pea.online).length;
  const cardWidth = memberCarouselCardWidth(windowWidth);

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
            <View style={[styles.onlinePill, { backgroundColor: colors.accentDim }]}>
              <View style={[styles.onlineDot, { backgroundColor: colors.accent }]} />
              <Text style={{ color: colors.accent, fontWeight: '800' }}>{online} online</Text>
            </View>
            <Pressable
              onPress={onChat}
              style={[styles.chatButton, { backgroundColor: colors.accent }]}
              accessibilityRole="button"
            >
              <Ionicons name="chatbubble-ellipses" size={16} color={colors.accentText} />
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
              detailed
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
          contentContainerStyle={{
            alignItems: 'flex-start',
            gap: MEMBER_CAROUSEL_GAP,
            paddingBottom: spacing.md,
            paddingRight: MEMBER_CAROUSEL_PADDING,
          }}
        >
          {peas.map((pea) => (
            <PodMemberCard
              key={pea.member.id}
              pea={pea}
              width={cardWidth}
              detailed={false}
              onCenter={() => onCenter(pea)}
              onNudge={() => void nudge(pea)}
              onOpenDirect={() => onOpenDirect(pea)}
              nudging={nudgingId === pea.member.id}
            />
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
    paddingHorizontal: MEMBER_CAROUSEL_PADDING,
    overflow: 'hidden',
  },
  handleArea: { height: 24, alignItems: 'center', justifyContent: 'center' },
  handle: { width: 44, height: 4, borderRadius: 2 },
  header: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: spacing.sm,
  },
  onlinePill: {
    minHeight: 32,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  onlineDot: { width: 8, height: 8, borderRadius: 4 },
  chatButton: {
    minHeight: 32,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
});

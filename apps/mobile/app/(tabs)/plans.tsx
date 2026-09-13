/**
 * MODULE: apps/mobile/app/(tabs)/plans.tsx
 *
 * PURPOSE
 *   Plans + trips list, the Decide Together swipe queue (right want, left no,
 *   up maybe), a Work it out section, and a FAB to create a plan / date / trip.
 *
 * FAIRNESS RULE
 *   Vote counts are NEVER shown until the idea is past `deciding`. The API is
 *   supposed to strip them; this screen still refuses to render a tally.
 *
 * INPUTS  : GET /pods/:id/plans, /trips, /ideas; POST votes; POST /pods/:id/plans
 * OUTPUTS : the Plans tab
 */

import { useMemo, useState } from 'react';
import {
  Animated,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import type { Idea, Plan, Trip } from '@peapod/shared';
import { useQueryClient } from '@tanstack/react-query';

import { apiPost } from '@/services/apiClient';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { ErrorRetry } from '@/components/ErrorRetry';
import { Field } from '@/components/Field';
import { Loading } from '@/components/Loading';
import { PodGate } from '@/components/PodGate';
import { Screen } from '@/components/Screen';
import { Sheet } from '@/components/Sheet';
import { useCurrentPodId, useIdeas, usePlans, useTrips } from '@/hooks/usePodData';
import { useSession } from '@/store/session';
import { spacing, themeColors, type as typeScale } from '@/theme';

function asPlan(row: unknown): Plan {
  return row as Plan;
}
function asTrip(row: unknown): Trip {
  return row as Trip;
}
function asIdea(row: unknown): Idea & { my_stance?: string | null; all_voted?: boolean; stage?: string } {
  return row as Idea & { my_stance?: string | null; all_voted?: boolean; stage?: string };
}

function PlansInner() {
  const dark = useSession((s) => s.darkMode);
  const colors = themeColors(dark);
  const me = useSession((s) => s.user);
  const podId = useCurrentPodId();
  const plansQ = usePlans(podId);
  const tripsQ = useTrips(podId);
  const ideasQ = useIdeas(podId);
  const queryClient = useQueryClient();

  const [fabOpen, setFabOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);

  const plans = (plansQ.data ?? []).map(asPlan);
  const trips = (tripsQ.data ?? []).map(asTrip);
  const ideas = (ideasQ.data ?? []).map(asIdea);

  const queue = useMemo(
    () =>
      ideas.filter((idea) => {
        const stage = idea.stage ?? idea.stage_override ?? 'deciding';
        if (stage !== 'deciding') return false;
        if (idea.my_stance) return false;
        if (idea.created_by_id === me?.id && idea.creator_stance) return false;
        return true;
      }),
    [ideas, me?.id],
  );

  const workItOut = ideas.filter((idea) => {
    const stage = idea.stage ?? idea.stage_override;
    return stage === 'considering';
  });

  const loading = plansQ.isLoading || tripsQ.isLoading || ideasQ.isLoading;
  const errored = plansQ.isError || tripsQ.isError || ideasQ.isError;
  const refetch = () => {
    void plansQ.refetch();
    void tripsQ.refetch();
    void ideasQ.refetch();
  };

  async function vote(ideaId: string, stance: 'want' | 'no' | 'maybe') {
    if (!podId) return;
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {
      // Haptics are best-effort (no Taptic Engine in some emulators).
    }
    try {
      await apiPost(`/pods/${podId}/ideas/${ideaId}/votes`, { stance });
    } catch {
      // Queue advances locally anyway so a dead API does not trap the swipe.
    }
    await queryClient.invalidateQueries({ queryKey: ['pod', podId, 'ideas'] });
  }

  async function createPlan() {
    if (!podId || !title.trim()) return;
    setSaving(true);
    try {
      await apiPost(`/pods/${podId}/plans`, {
        title: title.trim(),
        description: null,
        start_time: new Date().toISOString(),
        end_time: null,
        location_name: null,
        for_whom: 'pod',
        participant_ids: [],
        repeat_frequency: 'none',
        pod_id: podId,
      });
      setTitle('');
      setPlanOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['pod', podId, 'plans'] });
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Loading label="Loading plans…" />;
  if (errored) {
    const err = plansQ.error || tripsQ.error || ideasQ.error;
    return (
      <ErrorRetry
        message={err instanceof Error ? err.message : undefined}
        onRetry={refetch}
      />
    );
  }

  return (
    <Screen scroll>
      <Text style={[typeScale.overline, { color: colors.textMuted, marginTop: spacing.md }]}>PEAPOD</Text>
      <Text style={[typeScale.hero, { color: colors.text }]}>Plans</Text>

      <Text style={[typeScale.overline, { color: colors.textMuted, marginTop: spacing.xl }]}>Trips</Text>
      {trips.length === 0 ? (
        <Text style={{ color: colors.textMuted, marginTop: spacing.sm }}>No trips yet. Tap + to plan one.</Text>
      ) : (
        trips.map((trip) => (
          <Card key={trip.id} onPress={() => router.push(`/trip/${trip.id}`)} style={{ marginTop: spacing.sm }}>
            <Text style={{ fontSize: 22 }}>{trip.emoji || '✈️'}</Text>
            <Text style={[typeScale.subtitle, { color: colors.text, marginTop: 4 }]}>{trip.title}</Text>
            <Text style={{ color: colors.textMuted, marginTop: 2 }}>
              {trip.destination} · {trip.status}
            </Text>
          </Card>
        ))
      )}

      <Text style={[typeScale.overline, { color: colors.textMuted, marginTop: spacing.xl }]}>Reminders</Text>
      {plans.length === 0 ? (
        <Text style={{ color: colors.textMuted, marginTop: spacing.sm }}>No plans on the calendar.</Text>
      ) : (
        plans.map((plan) => (
          <Card key={plan.id} style={{ marginTop: spacing.sm }}>
            <Text style={[typeScale.subtitle, { color: colors.text }]}>{plan.title}</Text>
            <Text style={{ color: colors.textMuted, marginTop: 2 }}>
              {new Date(plan.start_time).toLocaleString()}
            </Text>
          </Card>
        ))
      )}

      <Text style={[typeScale.overline, { color: colors.textMuted, marginTop: spacing.xl }]}>Decide Together</Text>
      <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 4, marginBottom: spacing.md }}>
        Right = want · Left = no · Up = maybe. Nobody sees counts until everyone has voted.
      </Text>
      <SwipeQueue queue={queue} onVote={vote} />

      <Text style={[typeScale.overline, { color: colors.textMuted, marginTop: spacing.xl }]}>Work it out</Text>
      {workItOut.length === 0 ? (
        <Text style={{ color: colors.textMuted, marginTop: spacing.sm }}>Nothing in compromise right now.</Text>
      ) : (
        workItOut.map((idea) => (
          <Card key={idea.id} style={{ marginTop: spacing.sm }}>
            <Text style={{ fontSize: 22 }}>{idea.emoji}</Text>
            <Text style={[typeScale.subtitle, { color: colors.text }]}>{idea.title}</Text>
            <Text style={{ color: colors.textMuted }}>{idea.description}</Text>
          </Card>
        ))
      )}

      <Pressable
        onPress={() => setFabOpen(true)}
        style={[styles.fab, { backgroundColor: colors.accent }]}
        accessibilityLabel="New plan"
      >
        <Text style={{ fontSize: 28, color: colors.accentText, fontWeight: '700' }}>+</Text>
      </Pressable>

      <Sheet visible={fabOpen} title="What are you planning?" onClose={() => setFabOpen(false)}>
        <View style={{ gap: spacing.md, paddingBottom: spacing.lg }}>
          <Button
            label="Plan / reminder"
            variant="secondary"
            onPress={() => {
              setFabOpen(false);
              setPlanOpen(true);
            }}
          />
          <Button
            label="Date / activity"
            variant="secondary"
            onPress={() => {
              setFabOpen(false);
              router.push('/date');
            }}
          />
          <Button
            label="Trip / adventure"
            onPress={() => {
              setFabOpen(false);
              router.push('/trip');
            }}
          />
        </View>
      </Sheet>

      <Sheet visible={planOpen} title="New plan" onClose={() => setPlanOpen(false)}>
        <View style={{ gap: spacing.md, paddingBottom: spacing.lg }}>
          <Field label="Title" value={title} onChangeText={setTitle} placeholder="Dinner at home" autoCapitalize="sentences" />
          <Button label="Save plan" onPress={createPlan} loading={saving} disabled={!title.trim()} />
        </View>
      </Sheet>
    </Screen>
  );
}

function SwipeQueue({
  queue,
  onVote,
}: {
  queue: ReturnType<typeof asIdea>[];
  onVote: (id: string, stance: 'want' | 'no' | 'maybe') => void;
}) {
  const colors = themeColors(useSession((s) => s.darkMode));
  const [pan] = useState(() => new Animated.ValueXY());
  const [voted, setVoted] = useState<Record<string, true>>({});
  const card = queue.find((idea) => !voted[idea.id]);

  const responder = useMemo(
    () =>
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 8 || Math.abs(g.dy) > 8,
      onPanResponderMove: Animated.event([null, { dx: pan.x, dy: pan.y }], { useNativeDriver: false }),
      onPanResponderRelease: (_, g) => {
        const ax = Math.abs(g.dx);
        const ay = Math.abs(g.dy);
        const finish = (stance: 'want' | 'no' | 'maybe') => {
          pan.setValue({ x: 0, y: 0 });
          if (!card) return;
          setVoted((prev) => ({ ...prev, [card.id]: true }));
          onVote(card.id, stance);
        };
        if (ay > ax && g.dy < -110) finish('maybe');
        else if (g.dx > 110) finish('want');
        else if (g.dx < -110) finish('no');
        else Animated.spring(pan, { toValue: { x: 0, y: 0 }, useNativeDriver: false }).start();
      },
    }),
    [card, onVote, pan],
  );

  if (!card) {
    return (
      <View style={[styles.empty, { borderColor: colors.cardBorder }]}>
        <Text style={{ fontSize: 28 }}>🌸</Text>
        <Text style={{ color: colors.text, fontWeight: '700', marginTop: 8 }}>You are all caught up.</Text>
        <Text style={{ color: colors.textMuted, marginTop: 4 }}>Nothing waiting for your vote.</Text>
      </View>
    );
  }

  return (
    <Animated.View
      {...responder.panHandlers}
      style={[
        styles.card,
        {
          backgroundColor: colors.card,
          borderColor: colors.cardBorder,
          transform: [{ translateX: pan.x }, { translateY: pan.y }, { rotate: pan.x.interpolate({
            inputRange: [-200, 200],
            outputRange: ['-8deg', '8deg'],
          }) }],
        },
      ]}
    >
      <Text style={{ fontSize: 36 }}>{card.emoji || '✨'}</Text>
      <Text style={[typeScale.title, { color: colors.text, marginTop: spacing.sm }]}>{card.title}</Text>
      {card.description ? (
        <Text style={{ color: colors.textMuted, marginTop: spacing.sm }}>{card.description}</Text>
      ) : null}
      <Text style={{ color: colors.textMuted, marginTop: spacing.md, fontSize: 12 }}>
        Your vote stays hidden until everyone has answered.
      </Text>
    </Animated.View>
  );
}

export default function PlansTab() {
  return (
    <PodGate>
      <PlansInner />
    </PodGate>
  );
}

const styles = StyleSheet.create({
  fab: {
    position: 'absolute',
    right: 8,
    bottom: 16,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
  },
  card: {
    minHeight: 180,
    borderRadius: 24,
    borderWidth: 1,
    padding: spacing.lg,
  },
  empty: {
    borderWidth: 2,
    borderStyle: 'dashed',
    borderRadius: 24,
    padding: spacing.xl,
    alignItems: 'center',
  },
});

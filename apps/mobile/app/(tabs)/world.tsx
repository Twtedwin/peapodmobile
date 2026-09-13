/**
 * MODULE: apps/mobile/app/(tabs)/world.tsx
 *
 * PURPOSE
 *   The pod's shared world: XP/level (via levelInfo), Peanuts, a 2D garden
 *   grid with plantGrowth bars, a scratch/visited list, and a simulated
 *   reward store. The hero is a pea-green globe (no WebGL).
 *
 * INPUTS  : GET /pods/:id/world, /garden, /bucket-list; POST redeem
 * OUTPUTS : the World tab
 */

import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  findSeed,
  levelInfo,
  plantGrowth,
  REWARDS,
  type GardenEntry,
  type BucketListItem,
} from '@peapod/shared';

import { apiPost, unwrap } from '@/services/apiClient';
import { Card } from '@/components/Card';
import { ErrorRetry } from '@/components/ErrorRetry';
import { Loading } from '@/components/Loading';
import { Pill } from '@/components/Pill';
import { PodGate } from '@/components/PodGate';
import { Screen } from '@/components/Screen';
import { Sheet } from '@/components/Sheet';
import { WorldHero } from '@/components/WorldHero';
import { useBucketList, useCurrentPodId, useGarden, useWorld } from '@/hooks/usePodData';
import { useSession } from '@/store/session';
import { radius, spacing, themeColors, type as typeScale } from '@/theme';

function WorldInner() {
  const dark = useSession((s) => s.darkMode);
  const colors = themeColors(dark);
  const podId = useCurrentPodId();
  const worldQ = useWorld(podId);
  const gardenQ = useGarden(podId);
  const bucketQ = useBucketList(podId);
  const [storeOpen, setStoreOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [storeMsg, setStoreMsg] = useState('');

  const world = useMemo(() => {
    const raw = unwrap<Record<string, unknown>>(worldQ.data, ['world', 'data']) ?? {};
    const xp = Number(raw.xp ?? (worldQ.data as { xp?: number } | undefined)?.xp ?? 0);
    const peanuts = Number(raw.peanuts ?? (worldQ.data as { peanuts?: number } | undefined)?.peanuts ?? 0);
    return { xp, peanuts, info: levelInfo(xp) };
  }, [worldQ.data]);

  const plants = (gardenQ.data ?? []) as GardenEntry[];
  const [now] = useState(() => Date.now());
  const bucket = (bucketQ.data ?? []) as BucketListItem[];
  const visited = bucket.filter((item) => item.state === 'visited');
  const dreams = bucket.filter((item) => item.state !== 'visited');

  const loading = worldQ.isLoading;
  if (loading) return <Loading label="Growing the world…" />;
  if (worldQ.isError) {
    return (
      <ErrorRetry
        message={worldQ.error instanceof Error ? worldQ.error.message : undefined}
        onRetry={() => void worldQ.refetch()}
      />
    );
  }

  async function redeem(id: string, cost: number) {
    if (!podId) return;
    setBusyId(id);
    setStoreMsg('');
    try {
      await apiPost(`/pods/${podId}/rewards/redeem`, { catalog_id: id, peanut_cost: cost });
      setStoreMsg('Redeemed (simulated). Peanuts will update on the next refresh.');
      void worldQ.refetch();
    } catch (cause) {
      setStoreMsg(cause instanceof Error ? cause.message : 'Could not redeem.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Screen scroll>
      <Text style={[typeScale.overline, { color: colors.textMuted, marginTop: spacing.md }]}>OUR WORLD</Text>
      <Text style={[typeScale.hero, { color: colors.text }]}>{world.info.name}</Text>
      <View style={{ alignItems: 'center', marginVertical: spacing.lg }}>
        <WorldHero size={200} />
      </View>
      <Text style={{ color: colors.textMuted, textAlign: 'center' }}>{world.info.description}</Text>

      <View style={{ marginTop: spacing.lg }}>
        <View style={[styles.barTrack, { backgroundColor: colors.card }]}>
          <View
            style={[
              styles.barFill,
              { width: `${Math.round(world.info.progress * 100)}%`, backgroundColor: colors.accent },
            ]}
          />
        </View>
        <Text style={{ color: colors.textMuted, marginTop: 6, fontSize: 12 }}>
          Level {world.info.level} · {world.xp} XP
          {world.info.next_level_xp ? ` · next at ${world.info.next_level_xp}` : ' · max'}
        </Text>
      </View>

      <Card style={{ marginTop: spacing.lg }}>
        <Text style={[typeScale.overline, { color: colors.textMuted }]}>Peanuts</Text>
        <Text style={[typeScale.hero, { color: colors.accent }]}>🥜 {world.peanuts}</Text>
        <Pressable onPress={() => setStoreOpen(true)} style={{ marginTop: spacing.sm }}>
          <Text style={{ color: colors.accent, fontWeight: '700' }}>Open reward store</Text>
        </Pressable>
      </Card>

      <Text style={[typeScale.overline, { color: colors.textMuted, marginTop: spacing.xl }]}>Garden</Text>
      <View style={styles.grid}>
        {Array.from({ length: Math.max(world.info.plot_capacity, plants.length, 4) }).map((_, slot) => {
          const entry = plants.find((p) => p.slot === slot);
          const growth = entry
            ? plantGrowth(
                {
                  id: entry.id,
                  kind: entry.kind,
                  planted_at_ms: entry.planted_at ? Date.parse(entry.planted_at) : null,
                  grows_seconds: entry.grows_seconds,
                  water_boost: entry.water_boost,
                },
                now,
              )
            : 0;
          const seed = entry ? findSeed(entry.catalog_id) : undefined;
          return (
            <View
              key={slot}
              style={[styles.plot, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}
            >
              <Text style={{ fontSize: 28 }}>{entry?.emoji || seed?.emoji || '🪴'}</Text>
              <Text style={{ color: colors.text, fontSize: 11, marginTop: 4 }} numberOfLines={1}>
                {entry?.name || seed?.name || 'Empty'}
              </Text>
              <View style={[styles.barTrack, { marginTop: 6, height: 6 }]}>
                <View style={[styles.barFill, { width: `${Math.round(growth * 100)}%`, backgroundColor: colors.accent }]} />
              </View>
            </View>
          );
        })}
      </View>

      <Text style={[typeScale.overline, { color: colors.textMuted, marginTop: spacing.xl }]}>Visited</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm }}>
        {visited.length === 0 ? (
          <Text style={{ color: colors.textMuted }}>Complete a trip to scratch a country.</Text>
        ) : (
          visited.map((item) => <Pill key={item.id} label={item.title} emoji={item.emoji} />)
        )}
      </View>

      <Text style={[typeScale.overline, { color: colors.textMuted, marginTop: spacing.xl }]}>Dreams</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm }}>
        {dreams.map((item) => (
          <Pill key={item.id} label={item.title} emoji={item.emoji} />
        ))}
      </View>

      <Sheet visible={storeOpen} title="Reward store (simulated)" onClose={() => setStoreOpen(false)} tall>
        {storeMsg ? <Text style={{ color: colors.accent, marginBottom: spacing.md }}>{storeMsg}</Text> : null}
        {REWARDS.map((item) => (
          <Card key={item.id} style={{ marginBottom: spacing.sm }}>
            <Text style={{ fontSize: 22 }}>{item.emoji}</Text>
            <Text style={[typeScale.subtitle, { color: colors.text }]}>{item.title}</Text>
            <Text style={{ color: colors.textMuted }}>{item.description}</Text>
            <Text style={{ color: colors.accent, marginTop: 6 }}>🥜 {item.peanutCost}</Text>
            <Pressable
              onPress={() => void redeem(item.id, item.peanutCost)}
              disabled={busyId === item.id || world.peanuts < item.peanutCost}
              style={{ marginTop: spacing.sm, opacity: world.peanuts < item.peanutCost ? 0.4 : 1 }}
            >
              <Text style={{ color: colors.accent, fontWeight: '700' }}>
                {busyId === item.id ? 'Redeeming…' : 'Redeem'}
              </Text>
            </Pressable>
          </Card>
        ))}
      </Sheet>
    </Screen>
  );
}

export default function WorldTab() {
  return (
    <PodGate>
      <WorldInner />
    </PodGate>
  );
}

const styles = StyleSheet.create({
  barTrack: { height: 10, borderRadius: radius.pill, overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: radius.pill },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md },
  plot: {
    width: '47%',
    borderRadius: 18,
    borderWidth: 1,
    padding: spacing.md,
    alignItems: 'center',
  },
});

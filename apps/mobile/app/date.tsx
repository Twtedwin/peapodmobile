/**
 * MODULE: apps/mobile/app/date.tsx
 *
 * PURPOSE
 *   Date / activity discovery. Filters the local catalog and schedules an
 *   activity onto the pod calendar via POST /pods/:id/date-activities.
 *
 * INPUTS  : catalog/activities.ts, current pod
 * OUTPUTS : scheduled DateActivity rows
 */

import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';

import { apiPost } from '@/services/apiClient';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { ErrorRetry } from '@/components/ErrorRetry';
import { Loading } from '@/components/Loading';
import { Pill } from '@/components/Pill';
import { PodGate } from '@/components/PodGate';
import { Screen } from '@/components/Screen';
import { ACTIVITY_CATEGORIES, DATE_ACTIVITIES } from '@/catalog/activities';
import { useCurrentPodId, useDateActivities } from '@/hooks/usePodData';
import { useSession } from '@/store/session';
import { spacing, themeColors, type as typeScale } from '@/theme';

function DateInner() {
  const dark = useSession((s) => s.darkMode);
  const colors = themeColors(dark);
  const me = useSession((s) => s.user);
  const podId = useCurrentPodId();
  const scheduledQ = useDateActivities(podId);
  const queryClient = useQueryClient();
  const [format, setFormat] = useState<'all' | 'online' | 'offline'>('all');
  const [category, setCategory] = useState('all');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState('');

  const filtered = useMemo(
    () =>
      DATE_ACTIVITIES.filter((item) => {
        if (format !== 'all' && item.format !== format) return false;
        if (category !== 'all' && item.category !== category) return false;
        return true;
      }),
    [format, category],
  );

  async function schedule(id: string) {
    if (!podId) return;
    const item = DATE_ACTIVITIES.find((row) => row.id === id);
    if (!item) return;
    setBusyId(id);
    setMsg('');
    try {
      await apiPost(`/pods/${podId}/date-activities`, {
        catalog_id: item.id,
        title: item.title,
        emoji: item.emoji,
        is_online: item.format === 'online',
        scheduled_at: new Date().toISOString(),
        participant_ids: me?.id ? [me.id] : [],
        status: 'scheduled',
      });
      setMsg(`Scheduled: ${item.title}`);
      await queryClient.invalidateQueries({ queryKey: ['pod', podId, 'date-activities'] });
    } catch (cause) {
      setMsg(cause instanceof Error ? cause.message : 'Could not schedule that.');
    } finally {
      setBusyId(null);
    }
  }

  if (scheduledQ.isLoading) return <Loading />;
  if (scheduledQ.isError) {
    return (
      <ErrorRetry
        message={scheduledQ.error instanceof Error ? scheduledQ.error.message : undefined}
        onRetry={() => void scheduledQ.refetch()}
      />
    );
  }

  return (
    <Screen scroll>
      <Pressable onPress={() => router.back()} style={{ marginTop: spacing.md }}>
        <Text style={{ color: colors.accent, fontWeight: '700' }}>Back</Text>
      </Pressable>
      <Text style={[typeScale.hero, { color: colors.text, marginTop: spacing.md }]}>Date / Activity</Text>
      <Text style={{ color: colors.textMuted, marginTop: spacing.sm }}>
        Whether you are side by side or far apart — pick something to share.
      </Text>
      {msg ? <Text style={{ color: colors.accent, marginTop: spacing.md }}>{msg}</Text> : null}

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.lg }}>
        <Pill label="All" selected={format === 'all'} onPress={() => setFormat('all')} />
        <Pill label="Online" selected={format === 'online'} onPress={() => setFormat('online')} />
        <Pill label="Offline" selected={format === 'offline'} onPress={() => setFormat('offline')} />
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm }}>
        <Pill label="Any" selected={category === 'all'} onPress={() => setCategory('all')} />
        {ACTIVITY_CATEGORIES.map((cat) => (
          <Pill key={cat} label={cat} selected={category === cat} onPress={() => setCategory(cat)} />
        ))}
      </View>

      {filtered.map((item) => (
        <Card key={item.id} style={{ marginTop: spacing.md }}>
          <Text style={{ fontSize: 24 }}>{item.emoji}</Text>
          <Text style={[typeScale.subtitle, { color: colors.text }]}>{item.title}</Text>
          <Text style={{ color: colors.textMuted, marginTop: 4 }}>{item.description}</Text>
          <Text style={{ color: colors.textMuted, marginTop: 4, fontSize: 12 }}>
            {item.duration} · {item.format}
          </Text>
          <View style={{ marginTop: spacing.md }}>
            <Button
              label={busyId === item.id ? 'Scheduling…' : 'Schedule'}
              onPress={() => void schedule(item.id)}
              loading={busyId === item.id}
              compact
            />
          </View>
        </Card>
      ))}

      <Text style={[typeScale.overline, { color: colors.textMuted, marginTop: spacing.xl }]}>Scheduled</Text>
      {(scheduledQ.data ?? []).length === 0 ? (
        <Text style={{ color: colors.textMuted, marginTop: spacing.sm }}>Nothing on the date calendar yet.</Text>
      ) : (
        (scheduledQ.data ?? []).map((row) => {
          const item = row as { id: string; title?: string; emoji?: string; scheduled_at?: string };
          return (
            <Card key={item.id} style={{ marginTop: spacing.sm }}>
              <Text>
                {item.emoji} {item.title}
              </Text>
              <Text style={{ color: colors.textMuted, fontSize: 12 }}>
                {item.scheduled_at ? new Date(item.scheduled_at).toLocaleString() : ''}
              </Text>
            </Card>
          );
        })
      )}
    </Screen>
  );
}

export default function DateScreen() {
  return (
    <PodGate>
      <DateInner />
    </PodGate>
  );
}

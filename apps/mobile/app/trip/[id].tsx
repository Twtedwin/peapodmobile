/**
 * MODULE: apps/mobile/app/trip/[id].tsx
 *
 * PURPOSE
 *   Itinerary view for one trip. Book and complete are simulated PATCH
 *   calls that only change `status`. Completing is what feeds the world
 *   and the scratch map — that rule lives on the API, this screen just
 *   sends the status.
 *
 * INPUTS  : GET /pods/:podId/trips, PATCH /pods/:podId/trips/:id
 * OUTPUTS : itinerary UI
 */

import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatMinor, mergeCostLines, type ItineraryDay, type Trip } from '@peapod/shared';

import { apiGet, apiPatch, asArray, unwrap } from '@/services/apiClient';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { ErrorRetry } from '@/components/ErrorRetry';
import { Loading } from '@/components/Loading';
import { Screen } from '@/components/Screen';
import { SimulatedBanner } from '@/components/SimulatedBanner';
import { Sheet } from '@/components/Sheet';
import { useCurrentPodId } from '@/hooks/usePodData';
import { useSession } from '@/store/session';
import { spacing, themeColors, type as typeScale } from '@/theme';

export default function TripDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const dark = useSession((s) => s.darkMode);
  const colors = themeColors(dark);
  const podId = useCurrentPodId();
  const queryClient = useQueryClient();
  const [bookOpen, setBookOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState('');

  const query = useQuery({
    queryKey: ['trip', id],
    enabled: Boolean(id && podId),
    queryFn: async () => {
      if (!podId) throw new Error('Trip not found.');
      const raw = await apiGet<unknown>(`/pods/${podId}/trips`);
      const list = asArray<Trip>(unwrap(raw, ['trips', 'items', 'data']));
      const found = list.find((trip) => trip.id === id);
      if (!found) throw new Error('Trip not found.');
      return found;
    },
  });

  async function setStatus(status: Trip['status']) {
    if (!id || !podId) return;
    setBusy(status);
    setMsg('');
    try {
      await apiPatch(`/pods/${podId}/trips/${id}`, { status });
      await queryClient.invalidateQueries({ queryKey: ['trip', id] });
      if (podId) await queryClient.invalidateQueries({ queryKey: ['pod', podId, 'trips'] });
      setBookOpen(false);
      setMsg(status === 'booked' ? 'Marked booked (simulated).' : 'Trip completed.');
    } catch (cause) {
      setMsg(cause instanceof Error ? cause.message : 'Could not update the trip.');
    } finally {
      setBusy(null);
    }
  }

  if (query.isLoading) return <Loading label="Opening itinerary…" />;
  if (query.isError || !query.data) {
    return (
      <Screen>
        <ErrorRetry
          message={query.error instanceof Error ? query.error.message : 'Trip not found.'}
          onRetry={() => void query.refetch()}
        />
        <Button label="Back to plans" variant="ghost" onPress={() => router.back()} />
      </Screen>
    );
  }

  const trip = query.data;
  const days: ItineraryDay[] = trip.itinerary ?? [];
  const costs = mergeCostLines(trip.cost_breakdown ?? []);

  return (
    <Screen scroll>
      <Pressable onPress={() => router.back()} style={{ marginTop: spacing.md }}>
        <Text style={{ color: colors.accent, fontWeight: '700' }}>Back</Text>
      </Pressable>
      <Text style={{ fontSize: 42, marginTop: spacing.md }}>{trip.emoji || '✈️'}</Text>
      <Text style={[typeScale.hero, { color: colors.text }]}>{trip.title}</Text>
      <Text style={{ color: colors.textMuted, marginTop: 4 }}>
        {trip.destination} · {trip.status}
      </Text>
      {msg ? <Text style={{ color: colors.accent, marginTop: spacing.md }}>{msg}</Text> : null}

      {days.map((day) => (
        <Card key={day.day} style={{ marginTop: spacing.md }}>
          <Text style={[typeScale.overline, { color: colors.textMuted }]}>Day {day.day}</Text>
          <Text style={[typeScale.subtitle, { color: colors.text }]}>{day.city}</Text>
          <Text style={{ color: colors.textMuted, marginBottom: spacing.sm }}>{day.summary}</Text>
          {day.activities.map((activity) => (
            <View key={activity.id} style={{ flexDirection: 'row', gap: spacing.sm, paddingVertical: 6 }}>
              <Text>{activity.emoji}</Text>
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.text, fontWeight: '600' }}>
                  {activity.start_time} · {activity.title}
                </Text>
                <Text style={{ color: colors.textMuted, fontSize: 12 }}>
                  {activity.kind}
                  {activity.locked ? ' · locked' : ''}
                </Text>
              </View>
            </View>
          ))}
        </Card>
      ))}

      {costs.length > 0 ? (
        <Card style={{ marginTop: spacing.lg }}>
          <Text style={[typeScale.overline, { color: colors.textMuted }]}>Costs</Text>
          {costs.map((line) => (
            <View key={line.label} style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}>
              <Text style={{ color: colors.text }}>{line.label}</Text>
              <Text style={{ color: colors.text }}>{formatMinor(line.amount_minor, trip.currency)}</Text>
            </View>
          ))}
        </Card>
      ) : null}

      <View style={{ marginTop: spacing.xl, gap: spacing.md, paddingBottom: spacing.xxxl }}>
        {trip.status !== 'booked' && trip.status !== 'completed' ? (
          <Button label="Book (simulated)" onPress={() => setBookOpen(true)} />
        ) : null}
        {trip.status !== 'completed' ? (
          <Button label="Mark completed" variant="secondary" onPress={() => void setStatus('completed')} loading={busy === 'completed'} />
        ) : null}
      </View>

      <Sheet visible={bookOpen} title="Book this trip" onClose={() => setBookOpen(false)}>
        <View style={{ gap: spacing.md, paddingBottom: spacing.lg }}>
          <SimulatedBanner
            title="Simulated booking"
            body="No flights, hotels, or cards are charged. This only flips the trip to booked."
          />
          <Button label="Confirm booking" onPress={() => void setStatus('booked')} loading={busy === 'booked'} />
        </View>
      </Sheet>
    </Screen>
  );
}

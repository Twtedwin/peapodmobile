/**
 * MODULE: apps/mobile/app/trip/index.tsx
 *
 * PURPOSE
 *   Seven-step trip wizard: where, regions, when, who, style, budget, extras.
 *   Submits POST /compute/itinerary then POST /pods/:id/trips, then opens it.
 *
 * INPUTS  : travel catalog, current pod members, compute itinerary endpoint
 * OUTPUTS : a created trip id
 */

import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { BudgetTier, ItineraryResponse, TripPace } from '@peapod/shared';

import { apiPost, unwrap } from '@/services/apiClient';
import { Button } from '@/components/Button';
import { ErrorRetry } from '@/components/ErrorRetry';
import { Field } from '@/components/Field';
import { Loading } from '@/components/Loading';
import { Pill } from '@/components/Pill';
import { PodGate } from '@/components/PodGate';
import { Screen } from '@/components/Screen';
import { TRAVEL_COUNTRIES, TRAVEL_PERSONALITIES } from '@/catalog/travel';
import { useCurrentPodId, useMembers } from '@/hooks/usePodData';
import { useSession } from '@/store/session';
import { spacing, themeColors, type as typeScale } from '@/theme';

const STEPS = ['Where', 'Regions', 'When', 'Who', 'Style', 'Budget', 'Extras'];

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

function WizardInner() {
  const dark = useSession((s) => s.darkMode);
  const colors = themeColors(dark);
  const me = useSession((s) => s.user);
  const podId = useCurrentPodId();
  const membersQ = useMembers(podId);

  const [step, setStep] = useState(0);
  const [countries, setCountries] = useState<string[]>([]);
  const [regions, setRegions] = useState<string[]>([]);
  const [start, setStart] = useState('2026-12-12');
  const [days, setDays] = useState('7');
  const [who, setWho] = useState<string[]>(me?.id ? [me.id] : []);
  const [style, setStyle] = useState<string[]>(['food', 'nature']);
  const [budget, setBudget] = useState<BudgetTier>('mid');
  const [pace, setPace] = useState<TripPace>('balanced');
  const [mustSee, setMustSee] = useState('');
  const [avoid, setAvoid] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const selectedCountries = useMemo(
    () => TRAVEL_COUNTRIES.filter((c) => countries.includes(c.id)),
    [countries],
  );
  const regionOptions = selectedCountries.flatMap((c) => c.regions);

  const canNext =
    (step === 0 && countries.length > 0) ||
    step === 1 ||
    (step === 2 && Number(days) > 0) ||
    (step === 3 && who.length > 0) ||
    step === 4 ||
    step === 5 ||
    step === 6;

  async function finish() {
    if (!podId) return;
    setBusy(true);
    setError('');
    try {
      const itinerary = await apiPost<ItineraryResponse>('/compute/itinerary', {
        countries: selectedCountries.map((c) => c.name),
        regions,
        days: Math.max(1, Number(days) || 7),
        travellers: who.length,
        personalities: style,
        pace,
        budget_tier: budget,
        start_date: start || null,
        must_see: mustSee ? mustSee.split(',').map((s) => s.trim()).filter(Boolean) : [],
        avoid: avoid ? avoid.split(',').map((s) => s.trim()).filter(Boolean) : [],
        currency: selectedCountries[0]?.currency ?? 'SGD',
        seed: null,
      });
      const created = await apiPost<unknown>(`/pods/${podId}/trips`, {
        pod_id: podId,
        title: selectedCountries.map((c) => c.name).join(' & ') || 'Trip',
        destination: selectedCountries.map((c) => c.name).join(', '),
        country: selectedCountries[0]?.name ?? null,
        emoji: selectedCountries[0]?.emoji ?? '✈️',
        status: 'planned',
        origin: 'manual',
        start_date: start || null,
        end_date: null,
        flexible_dates: false,
        participant_ids: who,
        cities: itinerary.cities ?? [],
        budget_minor: itinerary.total_minor ?? null,
        currency: selectedCountries[0]?.currency ?? 'SGD',
        itinerary: itinerary.days ?? [],
        cost_breakdown: itinerary.cost_breakdown ?? [],
      });
      const trip = unwrap<{ id?: string }>(created, ['trip', 'data']);
      const id = trip.id || (created as { id?: string }).id;
      if (!id) throw new Error('Trip created but no id came back.');
      router.replace(`/trip/${id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not build this trip.');
    } finally {
      setBusy(false);
    }
  }

  if (membersQ.isLoading) return <Loading />;
  if (membersQ.isError) {
    return (
      <ErrorRetry
        message={membersQ.error instanceof Error ? membersQ.error.message : undefined}
        onRetry={() => void membersQ.refetch()}
      />
    );
  }

  return (
    <Screen scroll>
      <Pressable onPress={() => (step === 0 ? router.back() : setStep(step - 1))} style={{ marginTop: spacing.md }}>
        <Text style={{ color: colors.accent, fontWeight: '700' }}>{step === 0 ? 'Close' : 'Back'}</Text>
      </Pressable>
      <Text style={[typeScale.overline, { color: colors.textMuted, marginTop: spacing.md }]}>
        STEP {step + 1} OF {STEPS.length}
      </Text>
      <Text style={[typeScale.hero, { color: colors.text }]}>{STEPS[step]}</Text>
      {error ? <Text style={{ color: colors.danger, marginTop: spacing.md }}>{error}</Text> : null}

      {step === 0 ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.lg }}>
          {TRAVEL_COUNTRIES.map((country) => (
            <Pill
              key={country.id}
              label={country.name}
              emoji={country.emoji}
              selected={countries.includes(country.id)}
              onPress={() => setCountries((prev) => toggle(prev, country.id))}
            />
          ))}
        </View>
      ) : null}

      {step === 1 ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.lg }}>
          {regionOptions.length === 0 ? (
            <Text style={{ color: colors.textMuted }}>No regions listed — skip this step.</Text>
          ) : (
            regionOptions.map((region) => (
              <Pill
                key={region.id}
                label={region.name}
                selected={regions.includes(region.name)}
                onPress={() => setRegions((prev) => toggle(prev, region.name))}
              />
            ))
          )}
        </View>
      ) : null}

      {step === 2 ? (
        <View style={{ marginTop: spacing.lg, gap: spacing.md }}>
          <Field label="Start date (YYYY-MM-DD)" value={start} onChangeText={setStart} />
          <Field label="Days" value={days} onChangeText={setDays} keyboardType="number-pad" />
        </View>
      ) : null}

      {step === 3 ? (
        <View style={{ marginTop: spacing.lg, gap: spacing.sm }}>
          {(membersQ.data ?? []).map((member) => (
            <Pill
              key={member.id}
              label={member.display_name}
              selected={who.includes(member.id)}
              onPress={() => setWho((prev) => toggle(prev, member.id))}
            />
          ))}
        </View>
      ) : null}

      {step === 4 ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.lg }}>
          {TRAVEL_PERSONALITIES.map((item) => (
            <Pill
              key={item.id}
              label={item.label}
              emoji={item.emoji}
              selected={style.includes(item.id)}
              onPress={() => setStyle((prev) => toggle(prev, item.id))}
            />
          ))}
        </View>
      ) : null}

      {step === 5 ? (
        <View style={{ marginTop: spacing.lg, gap: spacing.sm }}>
          {(['budget', 'mid', 'luxury'] as BudgetTier[]).map((tier) => (
            <Pill key={tier} label={tier} selected={budget === tier} onPress={() => setBudget(tier)} />
          ))}
        </View>
      ) : null}

      {step === 6 ? (
        <View style={{ marginTop: spacing.lg, gap: spacing.md }}>
          <Text style={{ color: colors.textMuted }}>Pace</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
            {(['relaxed', 'balanced', 'packed'] as TripPace[]).map((item) => (
              <Pill key={item} label={item} selected={pace === item} onPress={() => setPace(item)} />
            ))}
          </View>
          <Field label="Must see (comma separated)" value={mustSee} onChangeText={setMustSee} autoCapitalize="sentences" />
          <Field label="Avoid (comma separated)" value={avoid} onChangeText={setAvoid} autoCapitalize="sentences" />
        </View>
      ) : null}

      <View style={{ marginTop: spacing.xxl, paddingBottom: spacing.xxxl }}>
        {step < STEPS.length - 1 ? (
          <Button label="Next" onPress={() => setStep(step + 1)} disabled={!canNext} />
        ) : (
          <Button label={busy ? 'Building itinerary…' : 'Build trip'} onPress={finish} loading={busy} disabled={!canNext} />
        )}
      </View>
    </Screen>
  );
}

export default function TripWizard() {
  return (
    <PodGate>
      <WizardInner />
    </PodGate>
  );
}

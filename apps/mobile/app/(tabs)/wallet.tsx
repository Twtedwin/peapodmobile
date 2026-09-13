/**
 * MODULE: apps/mobile/app/(tabs)/wallet.tsx
 *
 * PURPOSE
 *   Shared pod wallet. Every action appends a simulated transaction to the
 *   ledger; no real money moves. The SimulatedBanner is large on purpose.
 *
 * INPUTS  : GET /pods/:id/wallet; POST /pods/:id/wallet/transactions
 * OUTPUTS : the Wallet tab
 *
 * MONEY
 *   Display goes through formatMinor. Amounts typed by the user are parsed
 *   with parseMajorToMinor so we never send a float.
 */

import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { formatMinor, parseMajorToMinor, daysUntilDue, goalProgress } from '@peapod/shared';
import type { WalletBill, WalletGoal, WalletTransaction } from '@peapod/shared';
import { useQueryClient } from '@tanstack/react-query';

import { apiPost, unwrap } from '@/services/apiClient';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { ErrorRetry } from '@/components/ErrorRetry';
import { Field } from '@/components/Field';
import { Loading } from '@/components/Loading';
import { PodGate } from '@/components/PodGate';
import { Screen } from '@/components/Screen';
import { Sheet } from '@/components/Sheet';
import { SimulatedBanner } from '@/components/SimulatedBanner';
import { useCurrentPodId, useWallet } from '@/hooks/usePodData';
import { useSession } from '@/store/session';
import { spacing, themeColors, type as typeScale } from '@/theme';

type Action = 'add' | 'request' | 'split' | 'pay' | null;

function WalletInner() {
  const dark = useSession((s) => s.darkMode);
  const colors = themeColors(dark);
  const podId = useCurrentPodId();
  const walletQ = useWallet(podId);
  const queryClient = useQueryClient();
  const [action, setAction] = useState<Action>(null);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const parsed = useMemo(() => {
    const raw = unwrap<Record<string, unknown>>(walletQ.data, ['wallet', 'data']) ?? {};
    const wallet = (raw.wallet as Record<string, unknown> | undefined) ?? raw;
    const currency = String(wallet.currency ?? 'SGD');
    const balance = Number(wallet.balance_minor ?? wallet.balanceMinor ?? 0);
    const bills = ((raw.bills ?? wallet.bills ?? []) as WalletBill[]) || [];
    const goals = ((raw.goals ?? wallet.goals ?? []) as WalletGoal[]) || [];
    const txns = ((raw.transactions ?? wallet.transactions ?? []) as WalletTransaction[]) || [];
    return { currency, balance, bills, goals, txns };
  }, [walletQ.data]);

  if (walletQ.isLoading) return <Loading label="Opening the wallet…" />;
  if (walletQ.isError) {
    return (
      <ErrorRetry
        message={walletQ.error instanceof Error ? walletQ.error.message : undefined}
        onRetry={() => void walletQ.refetch()}
      />
    );
  }

  async function submit() {
    if (!podId) return;
    const minor = parseMajorToMinor(amount, parsed.currency);
    if (minor == null || minor <= 0) {
      setError('Enter an amount.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const kind = action === 'add' ? 'deposit' : action === 'pay' ? 'withdrawal' : 'request';
      const body = {
        kind,
        // Outgoing payments reduce the cached balance; add/request are
        // incoming ledger entries.
        amount_minor: action === 'pay' ? -minor : minor,
        description: note || action,
      };
      await apiPost(`/pods/${podId}/wallet/transactions`, body);
      setAction(null);
      setAmount('');
      setNote('');
      await queryClient.invalidateQueries({ queryKey: ['pod', podId, 'wallet'] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That action could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen scroll>
      <Text style={[typeScale.overline, { color: colors.textMuted, marginTop: spacing.md }]}>WALLET</Text>
      <Text style={[typeScale.hero, { color: colors.text }]}>Shared money</Text>
      <View style={{ marginTop: spacing.lg }}>
        <SimulatedBanner />
      </View>

      <View style={[styles.balance, { backgroundColor: colors.accent }]}>
        <Text style={[typeScale.overline, { color: colors.accentText, opacity: 0.75 }]}>Balance</Text>
        <Text style={[typeScale.hero, { color: colors.accentText }]}>
          {formatMinor(parsed.balance, parsed.currency)}
        </Text>
      </View>

      <View style={styles.actions}>
        {(['add', 'request', 'split', 'pay'] as const).map((key) => (
          <Pressable
            key={key}
            onPress={() => {
              setAction(key);
              setError('');
            }}
            style={[styles.action, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}
          >
            <Text style={{ fontSize: 18 }}>
              {key === 'add' ? '➕' : key === 'request' ? '📥' : key === 'split' ? '✂️' : '💸'}
            </Text>
            <Text style={{ color: colors.text, fontWeight: '700', marginTop: 4, textTransform: 'capitalize' }}>
              {key}
            </Text>
          </Pressable>
        ))}
      </View>

      <Text style={[typeScale.overline, { color: colors.textMuted, marginTop: spacing.xl }]}>Bills</Text>
      {parsed.bills.length === 0 ? (
        <Text style={{ color: colors.textMuted, marginTop: spacing.sm }}>No bills yet.</Text>
      ) : (
        parsed.bills.map((bill) => (
          <Card key={bill.id} style={{ marginTop: spacing.sm }}>
            <Text style={{ fontSize: 20 }}>{bill.emoji}</Text>
            <Text style={[typeScale.subtitle, { color: colors.text }]}>{bill.name}</Text>
            <Text style={{ color: colors.textMuted }}>
              {formatMinor(bill.amount_minor, parsed.currency)} · due in {daysUntilDue(bill.due_date)}d
            </Text>
          </Card>
        ))
      )}

      <Text style={[typeScale.overline, { color: colors.textMuted, marginTop: spacing.xl }]}>Travel funds</Text>
      {parsed.goals.length === 0 ? (
        <Text style={{ color: colors.textMuted, marginTop: spacing.sm }}>No savings goals yet.</Text>
      ) : (
        parsed.goals.map((goal) => {
          const pct = goalProgress(goal.saved_minor, goal.target_minor);
          return (
            <Card key={goal.id} style={{ marginTop: spacing.sm }}>
              <Text style={{ fontSize: 20 }}>{goal.emoji}</Text>
              <Text style={[typeScale.subtitle, { color: colors.text }]}>{goal.name}</Text>
              <Text style={{ color: colors.textMuted }}>
                {formatMinor(goal.saved_minor, parsed.currency)} of {formatMinor(goal.target_minor, parsed.currency)}
              </Text>
              <View style={{ height: 8, borderRadius: 8, backgroundColor: colors.bg, marginTop: 8, overflow: 'hidden' }}>
                <View style={{ width: `${Math.round(pct * 100)}%`, height: '100%', backgroundColor: colors.accent }} />
              </View>
            </Card>
          );
        })
      )}

      <Text style={[typeScale.overline, { color: colors.textMuted, marginTop: spacing.xl }]}>Transactions</Text>
      {parsed.txns.slice(0, 12).map((txn) => (
        <View
          key={txn.id}
          style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: spacing.md }}
        >
          <Text style={{ color: colors.text, flex: 1 }}>{txn.description}</Text>
          <Text style={{ color: txn.amount_minor >= 0 ? colors.accent : colors.danger, fontWeight: '700' }}>
            {formatMinor(txn.amount_minor, parsed.currency, { alwaysSigned: true })}
          </Text>
        </View>
      ))}

      <Sheet visible={action !== null} title={`Simulated ${action ?? ''}`} onClose={() => setAction(null)}>
        <View style={{ gap: spacing.md, paddingBottom: spacing.lg }}>
          <SimulatedBanner title="Still simulated" body="This writes a ledger row. No bank, no card, no real money." />
          {error ? <Text style={{ color: colors.danger }}>{error}</Text> : null}
          <Field label="Amount" value={amount} onChangeText={setAmount} placeholder="12.50" keyboardType="decimal-pad" />
          <Field label="Note" value={note} onChangeText={setNote} placeholder="Optional" autoCapitalize="sentences" />
          <Button label="Confirm" onPress={submit} loading={busy} />
        </View>
      </Sheet>
    </Screen>
  );
}

export default function WalletTab() {
  return (
    <PodGate>
      <WalletInner />
    </PodGate>
  );
}

const styles = StyleSheet.create({
  balance: { borderRadius: 28, padding: spacing.xl, marginTop: spacing.lg },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  action: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.md,
    borderRadius: 18,
    borderWidth: 1,
  },
});

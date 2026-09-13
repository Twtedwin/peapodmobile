/**
 * MODULE: @peapod/shared/algorithms/wallet
 *
 * PURPOSE
 *   Exact integer money splitting, and the arithmetic behind the shared wallet.
 *
 * INPUTS  : integer minor units and percentage shares
 * OUTPUTS : integer minor units that always sum back to the input
 *
 * CONSUMED BY
 *   - services/api  : the TypeScript fallback for POST /wallet/split, and every
 *                     bill payment and goal contribution that writes the ledger
 *   - apps/mobile   : previewing a split live as a member drags the percentage
 *                     sliders, which must not round-trip on every pixel
 *   (services/compute has the Rust twin in src/wallet.rs)
 *
 * ============================================================================
 * WHY SPLITTING IS HARDER THAN IT LOOKS
 * ============================================================================
 *   Split S$10.00 (1000 minor units) three ways at 33.33% / 33.33% / 33.34%.
 *
 *   The naive approach rounds each share independently:
 *     round(1000 * 0.3333) = 333
 *     round(1000 * 0.3333) = 333
 *     round(1000 * 0.3334) = 333
 *     total = 999, and one cent has vanished.
 *
 *   Rounding up instead invents a cent. Either way the ledger no longer balances,
 *   and in a wallet two people are both watching, a missing cent is not a
 *   rounding artefact -- it is the app being visibly wrong about money.
 *
 *   The fix is the LARGEST REMAINDER METHOD (also called Hare-Niemeyer, from
 *   apportioning legislative seats):
 *     1. Give everyone the FLOOR of their exact share. This can never overshoot.
 *     2. Count the leftover units: total - sum(floors). Always 0 <= leftover < n.
 *     3. Hand the leftover out one unit at a time, to whoever has the largest
 *        fractional part they were denied.
 *
 *   The result sums exactly, and each party is within one minor unit of their
 *   exact share -- the best any integer allocation can do.
 */

import type { SplitRequest, SplitResponse } from '../compute.js';

/**
 * Splits an integer amount across parties by percentage, exactly.
 *
 * @param request.amount_minor Total to split, in integer minor units (cents).
 *                             Must be non-negative.
 * @param request.shares       One entry per party with a percentage. The
 *                             percentages are expected to sum to 100, but the
 *                             function normalises them if they do not, so a
 *                             half-configured bill still produces a sane split
 *                             instead of silently under-allocating.
 * @returns One allocation per party in input order, plus the total. The total is
 *          GUARANTEED to equal `amount_minor` exactly.
 *
 * DETERMINISM
 *   Ties in the fractional remainder are broken by `party_id` string order, not
 *   by input order. That means the same bill split on two devices produces
 *   byte-identical results, and matches the Rust implementation, which sorts the
 *   same way.
 *
 * EDGE CASES
 *   - No shares: returns an empty allocation list with a total of 0. The caller
 *     is responsible for not writing a ledger entry in that case.
 *   - All percentages zero: falls back to an equal split, because "split this
 *     bill between nobody" is never what the member meant.
 *   - A zero amount: every party gets 0, which is correct and harmless.
 */
export function splitAmount(request: SplitRequest): SplitResponse {
  const { amount_minor, shares } = request;

  if (shares.length === 0) {
    return { allocations: [], total_minor: 0 };
  }

  const total = Math.max(0, Math.round(amount_minor));

  // Normalise the percentages. If they do not sum to 100 (a half-edited bill),
  // scale them so they do rather than losing or inventing money.
  let percentSum = 0;
  for (const share of shares) percentSum += Math.max(0, share.percent);

  // All-zero percentages mean the split was never configured. An equal split is
  // the only defensible interpretation.
  const useEqualSplit = percentSum <= 0;

  // --- Step 1: floor of each exact share ---
  interface Working {
    party_id: string;
    /** Whole minor units definitely owed. */
    base: number;
    /** The fractional minor unit that flooring took away, 0 <= remainder < 1. */
    remainder: number;
  }

  const working: Working[] = shares.map((share, index) => {
    const weight = useEqualSplit ? 1 / shares.length : Math.max(0, share.percent) / percentSum;
    const exact = total * weight;
    const base = Math.floor(exact);

    return {
      // Fall back to the index if a party somehow has no id, so the tie-break
      // below still has a stable key to sort on.
      party_id: share.party_id || `party_${index}`,
      base,
      remainder: exact - base,
    };
  });

  // --- Step 2: how many units flooring left unallocated ---
  let allocated = 0;
  for (const entry of working) allocated += entry.base;
  let leftover = total - allocated;

  // --- Step 3: distribute the leftover by largest remainder ---
  // Sorting a copy so the caller's input order is preserved in the output.
  const byRemainder = [...working].sort((a, b) => {
    if (b.remainder !== a.remainder) return b.remainder - a.remainder;
    // Deterministic tie-break, matching the Rust implementation.
    return a.party_id < b.party_id ? -1 : a.party_id > b.party_id ? 1 : 0;
  });

  // `leftover` is strictly less than the number of parties, so this loop always
  // terminates having handed out every unit. The modulo guards the theoretical
  // case of a rounding surprise rather than indexing past the end.
  for (let i = 0; i < leftover; i++) {
    const target = byRemainder[i % byRemainder.length]!;
    target.base += 1;
  }
  leftover = 0;

  const allocations = working.map((entry) => ({
    party_id: entry.party_id,
    amount_minor: entry.base,
  }));

  let finalTotal = 0;
  for (const allocation of allocations) finalTotal += allocation.amount_minor;

  return { allocations, total_minor: finalTotal };
}

/**
 * Splits an amount into equal shares.
 *
 * A convenience wrapper over `splitAmount`, since an even split is what most
 * bills use and expressing it as percentages at every call site is noise.
 *
 * @param amount_minor Total in integer minor units.
 * @param partyIds     Who to split between.
 * @returns Allocations summing exactly to the input.
 */
export function splitEqually(amount_minor: number, partyIds: readonly string[]): SplitResponse {
  if (partyIds.length === 0) return { allocations: [], total_minor: 0 };

  const percent = 100 / partyIds.length;
  return splitAmount({
    amount_minor,
    shares: partyIds.map((party_id) => ({ party_id, percent })),
  });
}

/**
 * Whether a set of percentage shares is a valid split.
 *
 * @param shares      The configured shares.
 * @param tolerance   Allowed deviation from 100, in percentage points. Defaults
 *                    to 0.01 so a UI that stores one decimal place is accepted.
 * @returns True when the percentages sum to 100 within tolerance and none is negative.
 */
export function isValidSplit(
  shares: readonly { percent: number }[],
  tolerance = 0.01,
): boolean {
  if (shares.length === 0) return false;
  if (shares.some((share) => share.percent < 0)) return false;

  let sum = 0;
  for (const share of shares) sum += share.percent;

  return Math.abs(sum - 100) <= tolerance;
}

/**
 * Progress toward a savings goal.
 *
 * @param saved_minor  Amount saved so far, integer minor units.
 * @param target_minor The goal, integer minor units.
 * @returns A fraction 0..1, clamped. A non-positive target returns 1 (complete)
 *          rather than dividing by zero -- a goal of nothing is already met.
 */
export function goalProgress(saved_minor: number, target_minor: number): number {
  if (target_minor <= 0) return 1;
  return Math.min(1, Math.max(0, saved_minor / target_minor));
}

/**
 * Rebuilds a wallet balance from its ledger.
 *
 * The balance stored on the wallet row is a cached sum; this is the
 * authoritative computation. Having it means the balance is auditable rather
 * than merely believable, and it is what the reconciliation check in
 * `services/api` compares the cached value against.
 *
 * @param transactions Ledger entries. Amounts are signed: positive credits the
 *                     wallet, negative debits it.
 * @returns The balance in integer minor units. May legitimately be negative if
 *          the ledger says so; clamping here would hide a real bug.
 */
export function balanceFromLedger(transactions: readonly { amount_minor: number }[]): number {
  let balance = 0;
  for (const transaction of transactions) balance += transaction.amount_minor;
  return balance;
}

/**
 * How many whole days until a due date.
 *
 * Compares CALENDAR DAYS in UTC, not elapsed milliseconds. A bill due tomorrow
 * at 09:00 is "due in 1 day" whether it is now 08:00 or 23:00 today, which is
 * how a person reads a due date. Subtracting timestamps would give 0 in one case
 * and 1 in the other.
 *
 * @param due_date ISO calendar date, `YYYY-MM-DD`.
 * @param now      Reference instant. Defaults to now.
 * @returns Whole days: 0 for today, negative when overdue.
 */
export function daysUntilDue(due_date: string, now: Date = new Date()): number {
  // Parsing as UTC midnight on both sides is what keeps this stable regardless
  // of the device's time zone. Parsing 'YYYY-MM-DD' in local time shifts the day
  // for anyone east or west of UTC.
  const due = new Date(`${due_date}T00:00:00.000Z`);
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  );

  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.round((due.getTime() - today.getTime()) / MS_PER_DAY);
}

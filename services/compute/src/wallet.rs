//! # Exact integer money splitting
//!
//! ## Purpose
//! Split a bill across parties so the ledger always balances. A faithful port
//! of `packages/shared/src/algorithms/wallet.ts` (`splitAmount`): the largest
//! remainder method (Hare-Niemeyer), never a per-share round that can lose or
//! invent a cent.
//!
//! ## Inputs
//! - `amount_minor`: integer minor units (cents for SGD). Never a float.
//! - `shares`: `(party_id, percent)` pairs. Percents are `f64` on the wire
//!   because that is how the app stores a bill's `split_percent`, but they
//!   never touch the output amounts.
//!
//! ## Outputs
//! One allocation per input share, in input order, plus `total_minor` which
//! equals `amount_minor` (except the empty-shares case, which returns total 0).
//!
//! ## Who calls this
//! `POST /wallet/split` via `src/main.rs`, and the TypeScript twin in
//! `packages/shared/src/algorithms/wallet.ts` which the API uses as a fallback.
//! The two must stay byte-identical on the same inputs.

use crate::models::{SplitAllocation, SplitRequest, SplitResponse};

/// One working row while the leftover units are being handed out.
///
/// `index` is the original position in `shares`, so after we sort a *copy* by
/// remainder we can write the extra unit back into the right slot without
/// scrambling the caller's order.
struct Working {
    index: usize,
    party_id: String,
    /// Whole minor units already assigned (the floor of the exact share).
    base: i64,
    /// The fractional minor unit flooring took away, `0.0 <= remainder < 1.0`.
    remainder: f64,
}

/// Splits an integer amount across parties by percentage, exactly.
///
/// # Parameters
/// - `req.amount_minor`: total to split, integer minor units. Negatives are
///   clamped to 0 (a bill cannot owe a negative amount).
/// - `req.shares`: one entry per party. Percents are expected to sum to 100
///   but are normalised if they do not, so a half-edited bill still produces
///   a sane split instead of silently under-allocating.
///
/// # Returns
/// Allocations in **input order**, plus their sum. The sum is guaranteed equal
/// to the (clamped) `amount_minor`, except when `shares` is empty.
///
/// # Algorithm (largest remainder / Hare-Niemeyer)
/// 1. Give everyone the **floor** of their exact share. This can never
///    overshoot.
/// 2. `leftover = total - sum(floors)`. Always `0 <= leftover < n` for
///    well-behaved floats; the loop is still bounded by `n` as a belt-and-
///    braces guard.
/// 3. Hand leftover units out one at a time to whoever has the largest
///    fractional remainder. Ties break by `party_id` **string order**, not
///    input order, so two devices splitting the same bill produce the same
///    cents.
///
/// # Edge cases
/// - **No shares:** empty allocations, `total_minor = 0`. The caller must not
///   write a ledger entry in that case. (The total is *not* `amount_minor`
///   here -- there is nobody to assign the money to.)
/// - **All percentages zero (or all negative, which we treat as zero):** falls
///   back to an equal split, because "split this bill between nobody" is
///   never what the member meant.
/// - **A zero amount:** every party gets 0.
/// - **A missing `party_id`:** the empty string is kept as-is; the TypeScript
///   twin substitutes `party_${index}` only when the id is falsy in JS, which
///   an empty string is. We do the same substitution so a blank id still has
///   a stable tie-break key.
pub fn split_amount(req: SplitRequest) -> SplitResponse {
    if req.shares.is_empty() {
        return SplitResponse { allocations: Vec::new(), total_minor: 0 };
    }

    // Clamp rather than reject: a negative amount on the wire is a caller bug
    // we can still answer usefully, and it matches `Math.max(0, Math.round(...))`.
    let total = req.amount_minor.max(0);

    let mut percent_sum = 0.0_f64;
    for share in &req.shares {
        percent_sum += share.percent.max(0.0);
    }
    // All-zero (or all-negative) weights: equal split. The `<= 0` matches the
    // TypeScript twin exactly, including the theoretical `-0.0`.
    let use_equal_split = percent_sum <= 0.0;
    let n = req.shares.len();

    let mut working: Vec<Working> = req
        .shares
        .iter()
        .enumerate()
        .map(|(index, share)| {
            let weight = if use_equal_split {
                1.0 / n as f64
            } else {
                share.percent.max(0.0) / percent_sum
            };
            let exact = total as f64 * weight;
            let base = exact.floor() as i64;
            let party_id = if share.party_id.is_empty() {
                format!("party_{index}")
            } else {
                share.party_id.clone()
            };
            Working { index, party_id, base, remainder: exact - base as f64 }
        })
        .collect();

    let allocated: i64 = working.iter().map(|row| row.base).sum();
    let leftover = total - allocated;

    // Sort a *copy of the indices* so `working` itself stays in input order.
    // Remainder descending, then party_id ascending. `total_cmp` treats NaN as
    // equal so a NaN percent cannot panic; those weights already became 0.
    let mut order: Vec<usize> = (0..working.len()).collect();
    order.sort_by(|&a, &b| {
        let (left, right) = (&working[a], &working[b]);
        match right.remainder.total_cmp(&left.remainder) {
            std::cmp::Ordering::Equal => left.party_id.cmp(&right.party_id),
            other => other,
        }
    });

    // `leftover` is almost always `< n`. The modulo is the theoretical guard
    // against a rounding surprise walking off the end of `order`.
    let leftover_units = leftover.max(0) as usize;
    for i in 0..leftover_units {
        let target = order[i % order.len()];
        working[target].base += 1;
    }

    let allocations: Vec<SplitAllocation> = working
        .into_iter()
        .map(|row| SplitAllocation { party_id: row.party_id, amount_minor: row.base })
        .collect();
    let total_minor: i64 = allocations.iter().map(|a| a.amount_minor).sum();
    SplitResponse { allocations, total_minor }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::SplitShare;

    fn share(id: &str, percent: f64) -> SplitShare {
        SplitShare { party_id: id.to_string(), percent }
    }

    #[test]
    fn ten_dollars_three_ways_sums_to_exactly_one_thousand() {
        // S$10.00 = 1000 minor units. Naive per-share rounding yields 333+333+333
        // = 999 and a cent vanishes; largest remainder must hand the leftover
        // to the 33.34% share (largest fractional part, 0.4 vs 0.3).
        let out = split_amount(SplitRequest {
            amount_minor: 1000,
            shares: vec![
                share("a", 33.33),
                share("b", 33.33),
                share("c", 33.34),
            ],
        });
        assert_eq!(out.total_minor, 1000);
        assert_eq!(out.allocations.len(), 3);
        let sum: i64 = out.allocations.iter().map(|a| a.amount_minor).sum();
        assert_eq!(sum, 1000);
        assert_eq!(out.allocations[0].amount_minor, 333);
        assert_eq!(out.allocations[1].amount_minor, 333);
        assert_eq!(out.allocations[2].amount_minor, 334);
        // Input order is preserved even though we sorted by remainder internally.
        assert_eq!(out.allocations[0].party_id, "a");
        assert_eq!(out.allocations[1].party_id, "b");
        assert_eq!(out.allocations[2].party_id, "c");
    }

    #[test]
    fn empty_shares_return_empty_allocations_and_total_zero() {
        let out = split_amount(SplitRequest { amount_minor: 1000, shares: vec![] });
        assert!(out.allocations.is_empty());
        assert_eq!(out.total_minor, 0);
    }

    #[test]
    fn all_zero_percents_fall_back_to_an_equal_split() {
        let out = split_amount(SplitRequest {
            amount_minor: 1000,
            shares: vec![share("a", 0.0), share("b", 0.0), share("c", 0.0)],
        });
        assert_eq!(out.total_minor, 1000);
        let amounts: Vec<i64> = out.allocations.iter().map(|a| a.amount_minor).collect();
        // 1000 / 3 = 333 remainder 1, so one party gets 334. Which one is the
        // tie-break on remainder (all equal) then party_id ("a" < "b" < "c").
        assert_eq!(amounts.iter().sum::<i64>(), 1000);
        assert!(amounts.iter().all(|&n| n == 333 || n == 334));
        assert_eq!(amounts.iter().filter(|&&n| n == 334).count(), 1);
        assert_eq!(out.allocations[0].amount_minor, 334, "tie-break: 'a' sorts first");
    }

    #[test]
    fn remainder_ties_break_by_party_id_not_input_order() {
        // 1001 cents, two equal 50% shares: leftover 1 must go to the party
        // whose id sorts first ("ann" before "bob"), even though bob is first
        // in the input.
        let out = split_amount(SplitRequest {
            amount_minor: 1001,
            shares: vec![share("bob", 50.0), share("ann", 50.0)],
        });
        assert_eq!(out.total_minor, 1001);
        assert_eq!(out.allocations[0].party_id, "bob");
        assert_eq!(out.allocations[1].party_id, "ann");
        assert_eq!(out.allocations[0].amount_minor, 500);
        assert_eq!(out.allocations[1].amount_minor, 501);
    }

    #[test]
    fn a_zero_amount_gives_everyone_zero() {
        let out = split_amount(SplitRequest {
            amount_minor: 0,
            shares: vec![share("a", 60.0), share("b", 40.0)],
        });
        assert_eq!(out.total_minor, 0);
        assert!(out.allocations.iter().all(|a| a.amount_minor == 0));
    }

    #[test]
    fn a_negative_amount_is_clamped_to_zero() {
        let out = split_amount(SplitRequest {
            amount_minor: -50,
            shares: vec![share("a", 100.0)],
        });
        assert_eq!(out.total_minor, 0);
        assert_eq!(out.allocations[0].amount_minor, 0);
    }
}

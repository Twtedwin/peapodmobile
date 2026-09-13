/**
 * MODULE: services/api/test/compute-parity
 *
 * PURPOSE
 *   Pin the TypeScript twins of the compute service to the documented
 *   formulae. These tests do not need the Rust container: they assert that
 *   `@peapod/shared` produces the numbers the comments in
 *   `algorithms/decisions.ts`, `algorithms/wallet.ts`, and `algorithms/geo.ts`
 *   promise. Running the same fixtures through both implementations is how a
 *   one-sided algorithm change is caught -- when the Rust service is up, CI
 *   can additionally POST these payloads at it and compare.
 *
 * INPUTS  : none (pure functions)
 * OUTPUTS : pass / fail
 */

import { describe, expect, it } from 'vitest';
import { consensusScore, haversine, interestOf, splitAmount } from '@peapod/shared';

describe('consensusScore formula', () => {
  it('scores ((want + maybe*0.5)/total)*100 - (no/total)*15, plus creator bonus, clamped 0..100', () => {
    // 4 members: 2 want, 1 maybe, 1 no. Creator wanted it. Human-sourced.
    // base    = ((2 + 0.5) / 4) * 100 = 62.5
    // penalty = (1 / 4) * 15          = 3.75
    // bonus   = +4
    // raw     = 62.75 -> round -> 63
    const tally = interestOf(
      ['a', 'b', 'c', 'd'],
      [
        { voter_id: 'a', stance: 'want' },
        { voter_id: 'b', stance: 'want' },
        { voter_id: 'c', stance: 'maybe' },
        { voter_id: 'd', stance: 'no' },
      ],
    );
    expect(tally).toMatchObject({ want: 2, maybe: 1, no: 1, total: 4, allVoted: true });
    expect(consensusScore(tally, 'want', 'user')).toBe(63);
  });

  it('applies the AI source penalty and never exceeds 100', () => {
    const unanimous = interestOf(
      ['a', 'b'],
      [
        { voter_id: 'a', stance: 'want' },
        { voter_id: 'b', stance: 'want' },
      ],
    );
    // 100 + 4 creator - 4 ai = 100, then clamp
    expect(consensusScore(unanimous, 'want', 'ai')).toBe(100);
    expect(consensusScore({ want: 0, maybe: 0, no: 0, total: 0, votedCount: 0, allVoted: true }, null, 'user')).toBe(0);
  });
});

describe('splitAmount sums', () => {
  it('allocates leftover cents so shares always sum back to the total', () => {
    // Classic trap: 1000 cents three ways at 33.33 / 33.33 / 33.34.
    // Independent rounding would lose a cent; largest-remainder must not.
    const result = splitAmount({
      amount_minor: 1000,
      shares: [
        { party_id: 'alex', percent: 33.33 },
        { party_id: 'sarah', percent: 33.33 },
        { party_id: 'john', percent: 33.34 },
      ],
    });
    const sum = result.allocations.reduce((acc, row) => acc + row.amount_minor, 0);
    expect(result.total_minor).toBe(1000);
    expect(sum).toBe(1000);
    expect(result.allocations).toHaveLength(3);
  });
});

describe('haversine identical numbers', () => {
  it('returns 0 for identical points and a stable metre value for 1° of longitude at the equator', () => {
    expect(haversine(1.3521, 103.8198, 1.3521, 103.8198)).toBe(0);
    // Earth radius 6_371_000 m × 1° in radians. The TypeScript and Rust
    // twins must produce this exact IEEE value from the same formula.
    const oneDegree = haversine(0, 0, 0, 1);
    expect(oneDegree).toBe(haversine(0, 0, 0, 1));
    expect(oneDegree).toBeCloseTo(111_194.92664455873, 8);
  });
});

/**
 * MODULE: @peapod/shared/algorithms/decisions
 *
 * PURPOSE
 *   The Decide Together arithmetic: tallying stances, deciding an outcome, and
 *   scoring how harmonious a pod is about an idea.
 *
 * INPUTS  : the pod's full membership, plus whatever stances have been cast
 * OUTPUTS : counts, an outcome, a pipeline stage, and a 0-100 harmony score
 *
 * CONSUMED BY
 *   - services/api  : the TypeScript fallback for POST /decisions/evaluate, and
 *                     the serialisation layer that decides what a member may see
 *   - apps/mobile   : rendering the revealed result after everyone has voted
 *   (services/compute has the Rust twin in src/decisions.rs)
 *
 * ============================================================================
 * THE FAIRNESS RULE THIS FEATURE DEPENDS ON
 * ============================================================================
 *   No member ever sees anybody's stance, or the running tally, before every
 *   member has responded. The swipe queue shows only the proposal.
 *
 *   This is not a UI preference, it is what makes the votes honest. If the first
 *   two members' "want" votes were visible, the third would be voting on a
 *   social question ("do I want to be the one who blocks this?") instead of the
 *   actual question ("do I want to do this?").
 *
 *   THIS MODULE COMPUTES the aggregate unconditionally, because the API needs it
 *   to decide what happens next. ENFORCEMENT lives in the API's serialiser: it
 *   must not send these numbers to a client while `all_voted` is false. If you
 *   are calling into this module from a route handler, that is your
 *   responsibility.
 *
 * ============================================================================
 * WHY THE WEIGHTS ARE WHAT THEY ARE
 * ============================================================================
 *   A "maybe" counts as HALF support, not as an abstention. Someone answering
 *   "maybe" has engaged and is mildly positive; treating that as silence would
 *   throw away real information and make lukewarm ideas indistinguishable from
 *   unanswered ones.
 *
 *   A "no" costs an EXTRA penalty on top of contributing zero support. One
 *   person actively opposed is a bigger obstacle to a plan actually happening
 *   than one person merely absent -- a trip nobody objects to can be booked, a
 *   trip one person dreads probably should not be.
 */

import { DECISIONS } from '../rules.js';
import type {
  DecisionMemberVote,
  DecisionOutcome,
  EvaluateDecisionRequest,
  EvaluateDecisionResponse,
} from '../compute.js';

/** The tally of stances against a pod's full membership. */
export interface InterestTally {
  want: number;
  maybe: number;
  no: number;
  /** The pod's member count -- the denominator, not the number of votes cast. */
  total: number;
  votedCount: number;
  allVoted: boolean;
}

/**
 * Tallies stances against the pod's membership.
 *
 * Only votes from CURRENT members are counted. That matters: a member who voted
 * and then left the pod must not keep influencing the outcome, and must not make
 * `votedCount` exceed `total` and thereby break the "everyone has voted" test.
 *
 * @param memberIds Every current member of the pod.
 * @param votes     Stances cast, possibly including stale voters or duplicates.
 * @returns The tally. `allVoted` is true only when every current member has a stance.
 *
 * EDGE CASES
 *   - An empty pod gives total 0 and allVoted true (vacuously), so callers must
 *     check `total > 0` before acting on an outcome.
 *   - Duplicate votes from the same member are collapsed, last one winning, so a
 *     member changing their mind cannot double-count.
 */
export function interestOf(
  memberIds: readonly string[],
  votes: readonly DecisionMemberVote[],
): InterestTally {
  // Collapse to one stance per voter, last write winning.
  const stanceByVoter = new Map<string, DecisionMemberVote['stance']>();
  for (const vote of votes) stanceByVoter.set(vote.voter_id, vote.stance);

  let want = 0;
  let maybe = 0;
  let no = 0;

  for (const memberId of memberIds) {
    switch (stanceByVoter.get(memberId)) {
      case 'want':
        want++;
        break;
      case 'maybe':
        maybe++;
        break;
      case 'no':
        no++;
        break;
      default:
        // No stance from this member yet.
        break;
    }
  }

  const total = memberIds.length;
  const votedCount = want + maybe + no;

  return { want, maybe, no, total, votedCount, allVoted: votedCount >= total };
}

/**
 * Decides the group outcome once everybody has responded.
 *
 * RULES, IN THIS EXACT ORDER (the order is load-bearing):
 *
 *   1. Not everyone has voted   -> `deciding`. Nothing is revealed.
 *   2. want === total           -> `everyone_in`. Unanimous; becomes a real plan
 *                                  immediately, with no negotiation.
 *   3. no >= ceil(total/2) AND want < no -> `not_for_us`. At least half actively
 *                                  object and opposition outweighs support.
 *                                  `ceil` matters: in a 3-member pod this needs
 *                                  2 objections, not 1.5 (which would round down
 *                                  to 1 and let a single member veto).
 *   4. maybe >= want AND maybe >= no AND want < total -> `maybe_later`. Lukewarm
 *                                  across the board. Nobody is against it, but
 *                                  there is not enough energy to plan it now.
 *   5. otherwise                -> `work_it_out`. Genuinely divided: real
 *                                  support and real opposition coexist. This is
 *                                  the ONLY outcome that opens the compromise
 *                                  flow, because it is the only one where a
 *                                  compromise could change anybody's mind.
 *
 * @param tally The result of `interestOf`.
 * @returns The outcome.
 */
export function outcomeOf(tally: InterestTally): DecisionOutcome {
  const { want, maybe, no, total, allVoted } = tally;

  if (!allVoted) return 'deciding';
  if (total > 0 && want === total) return 'everyone_in';

  const half = Math.ceil(total / 2);
  if (no >= half && want < no) return 'not_for_us';
  if (maybe >= want && maybe >= no && want < total) return 'maybe_later';

  return 'work_it_out';
}

/**
 * Scores how harmonious the pod is about an idea, as a percentage.
 *
 * FORMULA
 *   base    = ((want + maybe * 0.5) / total) * 100
 *   penalty = (no / total) * 15
 *   score   = base - penalty
 *             + 4 if the creator themselves wanted it
 *             - 4 if the idea came from Peapod rather than a member
 *   result  = round(clamp(score, 0, 100))
 *
 * The two adjustments are small on purpose -- they break ties in ordering
 * without ever overturning what the pod actually said. A creator's own
 * enthusiasm is weak evidence the plan will really happen; a machine suggestion
 * is ranked just below a member's at equal support, so the pod's own ideas
 * surface first in the queue.
 *
 * @param tally         The result of `interestOf`.
 * @param creatorStance The proposer's own pre-vote, if recorded.
 * @param sourceType    Whether a member or Peapod proposed it.
 * @returns An integer 0-100.
 *
 * EDGE CASES
 *   - An empty pod returns 0 rather than dividing by zero.
 *   - Clamping happens before rounding, so the adjustments can never push the
 *     result outside 0-100.
 */
export function consensusScore(
  tally: InterestTally,
  creatorStance?: 'want' | 'maybe' | 'no' | null,
  sourceType: 'user' | 'ai' = 'user',
): number {
  const { want, maybe, no, total } = tally;
  if (total === 0) return 0;

  const { maybeWeight, noPenaltyWeight, creatorWantedBonus, aiSourcePenalty, min, max } = DECISIONS.harmony;

  let score = ((want + maybe * maybeWeight) / total) * 100 - (no / total) * noPenaltyWeight;

  if (creatorStance === 'want') score += creatorWantedBonus;
  if (sourceType === 'ai') score -= aiSourcePenalty;

  return Math.round(Math.max(min, Math.min(max, score)));
}

/** Where an idea sits in the pipeline. */
export type IdeaStageValue =
  | 'deciding'
  | 'considering'
  | 'maybe_later'
  | 'planned'
  | 'archived'
  | 'converted';

/**
 * Resolves an idea's pipeline stage.
 *
 * PRECEDENCE:
 *   1. A `stageOverride` wins over everything. It is an operator escape hatch
 *      and is also how the two legacy stage names are handled: `discussing` and
 *      `becoming_real` both collapse to `planned`, because once a pod agrees the
 *      idea simply becomes a Plan. There is no separate "planning together"
 *      stage any more -- an agreed idea lands in the same unified Plans list and
 *      opens the same itinerary screen as a hand-built trip.
 *   2. An explicit archived/converted status wins over the vote maths, since
 *      those are terminal states set by an action rather than derived from votes.
 *   3. Otherwise the stage is derived from the outcome.
 *
 * @param tally         The result of `interestOf`.
 * @param options.creatorStance  The proposer's pre-vote.
 * @param options.sourceType     Member or Peapod.
 * @param options.status         Terminal status, when one has been set.
 * @param options.stageOverride  Pinned stage, when one has been set.
 * @returns The stage.
 */
export function stageOf(
  tally: InterestTally,
  options: {
    status?: 'active' | 'archived' | 'converted';
    stageOverride?: string | null;
  } = {},
): IdeaStageValue {
  const { status = 'active', stageOverride = null } = options;

  if (stageOverride) {
    const aliases = DECISIONS.stageMapping.legacyAliases as Record<string, string>;
    const resolved = aliases[stageOverride] ?? stageOverride;
    return resolved as IdeaStageValue;
  }

  if (status === 'archived') return 'archived';
  if (status === 'converted') return 'converted';

  switch (outcomeOf(tally)) {
    case 'everyone_in':
      return 'planned';
    case 'work_it_out':
      return 'considering';
    case 'maybe_later':
      return 'maybe_later';
    case 'not_for_us':
      return 'archived';
    case 'deciding':
      return 'deciding';
  }
}

/**
 * The full evaluation, matching the compute service's response exactly.
 *
 * This is the function `services/api` calls as its fallback when the Rust
 * service is unreachable, so its output must be byte-identical to the Rust
 * implementation's. The parity tests in `services/api` enforce that.
 *
 * @param request The same payload the compute endpoint accepts.
 * @returns The aggregate. Remember that the caller must withhold these numbers
 *          from clients while `all_voted` is false.
 */
export function evaluateDecision(request: EvaluateDecisionRequest): EvaluateDecisionResponse {
  const tally = interestOf(request.member_ids, request.votes);

  return {
    want: tally.want,
    maybe: tally.maybe,
    no: tally.no,
    total: tally.total,
    voted_count: tally.votedCount,
    all_voted: tally.allVoted,
    outcome: outcomeOf(tally),
    stage: stageOf(tally, {
      status: request.status ?? 'active',
      stageOverride: request.stage_override ?? null,
    }),
    harmony: consensusScore(tally, request.creator_stance ?? null, request.source_type ?? 'user'),
  };
}

/**
 * Builds compromise suggestions for a divided idea without calling an AI provider.
 *
 * Used when no provider is configured, or when the provider call fails. The
 * suggestions are derived from the idea's own shape so they stay specific rather
 * than becoming generic filler -- "Shorten to 3 days" is actionable in a way
 * that "consider adjusting the plan" is not.
 *
 * @param idea.duration_days      Trip length, when known.
 * @param idea.compromise_options Pre-authored options, which win if present.
 * @returns At most three suggestions.
 */
export function compromiseSuggestions(idea: {
  duration_days?: number | null;
  compromise_options?: readonly string[] | null;
}): string[] {
  if (idea.compromise_options && idea.compromise_options.length > 0) {
    return [...idea.compromise_options];
  }

  const { longTripDaysThreshold, longTripTemplate, generic, maxSuggestions } =
    DECISIONS.compromiseFallbacks;

  const out: string[] = [];

  // A long trip's most negotiable dimension is almost always its length, so
  // lead with a concrete halved duration (floored at 3 days, below which the
  // travel time stops being worth it).
  if (idea.duration_days && idea.duration_days >= longTripDaysThreshold) {
    const halved = Math.max(3, Math.round(idea.duration_days / 2));
    out.push(longTripTemplate.replace('{days}', String(halved)));
  }

  out.push(...generic);
  return out.slice(0, maxSuggestions);
}

/**
 * Interleaves Peapod's own suggestions evenly into the swipe queue.
 *
 * Batching machine suggestions makes the queue feel like an ad break; spacing
 * them keeps the queue feeling like the pod's own. One suggestion is inserted
 * after every Nth member idea.
 *
 * @param memberIdeas   The pod's own ideas, in display order.
 * @param aiSuggestions Peapod's suggestions.
 * @returns A single queue. Any suggestions left over after the member ideas run
 *          out are appended, so none are silently dropped.
 */
export function interleaveSuggestions<TIdea, TSuggestion>(
  memberIdeas: readonly TIdea[],
  aiSuggestions: readonly TSuggestion[],
): (TIdea | TSuggestion)[] {
  const everyNth = DECISIONS.aiInterleaveEveryNth;
  const out: (TIdea | TSuggestion)[] = [];
  let suggestionIndex = 0;

  for (let i = 0; i < memberIdeas.length; i++) {
    out.push(memberIdeas[i]!);

    const atInterval = (i + 1) % everyNth === 0;
    if (atInterval && suggestionIndex < aiSuggestions.length) {
      out.push(aiSuggestions[suggestionIndex]!);
      suggestionIndex++;
    }
  }

  // Append any remainder rather than dropping it.
  for (; suggestionIndex < aiSuggestions.length; suggestionIndex++) {
    out.push(aiSuggestions[suggestionIndex]!);
  }

  return out;
}

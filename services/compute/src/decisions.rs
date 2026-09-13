//! # Decide Together aggregation
//!
//! ## Purpose
//! Turns one idea's votes into the pod's group result: the vote counts, the
//! outcome, the pipeline stage and the harmony score. A faithful port of
//! `interestOf`, `outcomeOf`, `consensusScore` and `stageOf` from
//! `src/lib/decisionSystem.js`, with every weight and mapping read from
//! `packages/shared/data/rules/decisions.json`.
//!
//! ## Inputs
//! The full pod membership (`member_ids`), the votes cast so far, the creator's
//! pre-vote, whether the idea came from a person or from Peapod's own
//! suggestions, the idea's record status, and an optional pinned stage.
//!
//! ## Outputs
//! Counts (`want`/`maybe`/`no`/`total`/`voted_count`), `all_voted`, one of five
//! outcomes, one of six stages, and `harmony` as an integer 0..100.
//!
//! ## Who calls this
//! `services/api` on behalf of `POST /decisions/evaluate`.
//!
//! ## THE NON-NEGOTIABLE FAIRNESS RULE
//! No member may see anybody's stance, or the aggregate, before every member has
//! responded. This service computes the aggregate unconditionally because the
//! API needs `all_voted` to decide what to expose; **`services/api` must strip
//! the counts, outcome and harmony from any response while `all_voted` is
//! false.** That is what prevents bandwagoning and is why members are willing to
//! vote honestly. Nothing in this module should ever be wired straight to a
//! client.

use std::collections::HashMap;

use crate::models::{
    DecisionStatus, EvaluateDecisionRequest, EvaluateDecisionResponse, Outcome, SourceType, Stage,
    Stance,
};
use crate::rules::DECISIONS;

/// Vote tallies over the pod's membership.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Interest {
    /// Members who voted `want`.
    pub want: i64,
    /// Members who voted `maybe`. A genuine partial yes, not an abstention.
    pub maybe: i64,
    /// Members who voted `no`.
    pub no: i64,
    /// Pod size. Note this is the membership count, NOT the number of votes.
    pub total: i64,
    /// How many members have voted (`want + maybe + no`).
    pub voted_count: i64,
    /// True once every member has responded.
    pub all_voted: bool,
}

/// Tallies votes over the pod's membership.
///
/// # Parameters
/// - `member_ids`: the full membership. Counting over members (rather than over
///   votes) is what makes "everyone has voted" decidable.
/// - `votes`: `(voter_id, stance)` pairs.
///
/// # Returns
/// An [`Interest`] with the four counts plus `all_voted`.
///
/// # Edge cases
/// - **A vote from a non-member is ignored.** The original looked votes up by
///   member (`votes[m.name]`), so a stale vote from someone who has left the pod
///   cannot inflate the tallies.
/// - **A duplicate vote from the same voter**: the last one wins, matching the
///   JavaScript object literal it was built from.
/// - **A duplicate id in `member_ids`** is counted twice, exactly as the
///   original's `members.filter(...)` did. The caller passes a de-duplicated
///   membership list.
/// - An empty pod gives `total = 0` and `all_voted = true` (`0 >= 0`), which is
///   the original's behaviour; `outcome_of` and `consensus_score` both special
///   case `total == 0` so this cannot produce a nonsensical result.
pub fn interest_of(member_ids: &[String], votes: &[(String, Stance)]) -> Interest {
    // Last write wins, like the JS object this replaces.
    let mut by_voter: HashMap<&str, Stance> = HashMap::with_capacity(votes.len());
    for (voter_id, stance) in votes {
        by_voter.insert(voter_id.as_str(), *stance);
    }

    let mut want = 0_i64;
    let mut maybe = 0_i64;
    let mut no = 0_i64;
    for member_id in member_ids {
        match by_voter.get(member_id.as_str()) {
            Some(Stance::Want) => want += 1,
            Some(Stance::Maybe) => maybe += 1,
            Some(Stance::No) => no += 1,
            None => {}
        }
    }

    let total = member_ids.len() as i64;
    let voted_count = want + maybe + no;
    Interest { want, maybe, no, total, voted_count, all_voted: voted_count >= total }
}

/// Decides the group outcome.
///
/// # Parameters
/// - `interest`: the tallies from [`interest_of`].
///
/// # Returns
/// One of the five outcomes.
///
/// # Rules, in this EXACT order (`decisions.json -> outcomeRules.order`)
/// The order is load-bearing -- `everyone_in` must be checked before the `no`
/// majority rule, and the `maybe` rule before the fallback:
///
/// 0. **Not everyone has voted -> `deciding`.** Nothing is revealed yet.
/// 1. **`want == total` -> `everyone_in`.** "Unanimous enthusiasm. Becomes a
///    real plan with no further negotiation." (Guarded by `total != 0`, as in
///    the original's `if (total && want === total)`, so an empty pod is not
///    unanimously in favour of everything.)
/// 2. **`no >= ceil(total/2)` AND `want < no` -> `not_for_us`.** "At least half
///    actively oppose it and opposition outweighs support. Archived. Uses ceil
///    so a 3-member pod needs 2 objections, not 1.5." `ceil(total/2)` is
///    computed as `(total + 1) / 2` in integer arithmetic -- no floats, so no
///    rounding surprises.
/// 3. **`maybe >= want` AND `maybe >= no` AND `want < total` -> `maybe_later`.**
///    "Lukewarm across the board. Nobody is against it, but there is not enough
///    energy to plan it now."
/// 4. **Otherwise -> `work_it_out`.** "Genuinely divided -- real support and
///    real opposition coexist. This is the only outcome that opens the
///    compromise flow."
pub fn outcome_of(interest: &Interest) -> Outcome {
    if !interest.all_voted {
        return Outcome::Deciding;
    }
    if interest.total != 0 && interest.want == interest.total {
        return Outcome::EveryoneIn;
    }
    // Integer ceil(total / 2).
    let half = (interest.total + 1) / 2;
    if interest.no >= half && interest.want < interest.no {
        return Outcome::NotForUs;
    }
    if interest.maybe >= interest.want
        && interest.maybe >= interest.no
        && interest.want < interest.total
    {
        return Outcome::MaybeLater;
    }
    Outcome::WorkItOut
}

/// Scores how harmonious the pod's response is, 0..100.
///
/// # Parameters
/// - `interest`: the tallies.
/// - `creator_stance`: the creator's pre-vote, if recorded.
/// - `source_type`: whether a person or Peapod proposed the idea.
///
/// # Returns
/// An integer percentage in 0..=100.
///
/// # Formula (`decisions.json -> harmony`)
/// ```text
/// harmony = ((want + maybe * maybeWeight) / total) * 100
///         - (no / total) * noPenaltyWeight
///         + creatorWantedBonus   (only when the creator voted "want")
///         - aiSourcePenalty      (only for AI-sourced ideas)
/// ```
/// then clamped to `[clamp.min, clamp.max]` = `[0, 100]` and rounded.
///
/// With the shipped weights (`maybeWeight = 0.5`, `noPenaltyWeight = 15`,
/// bonus = penalty = 4):
/// - A `maybe` counts as **half support** because it is genuine partial
///   interest, not an abstention.
/// - A `no` costs an extra 15-point-weighted penalty **on top of** contributing
///   nothing, because one person actively opposed is worth more than one person
///   merely absent when deciding whether a plan is worth pushing.
/// - The creator being enthusiastic is "a small positive signal about how likely
///   the plan is to actually happen".
/// - An AI suggestion "is ranked slightly below a human's at equal support, so
///   the pod's own ideas surface first".
///
/// # Edge cases
/// - `total == 0` returns 0 without touching the formula (no division by zero).
/// - Rounding is applied *after* clamping, exactly as in the original
///   (`Math.round(Math.max(0, Math.min(100, s)))`). Because the clamped value is
///   never negative, Rust's round-half-away-from-zero and JavaScript's
///   round-half-up agree on every possible input.
pub fn consensus_score(
    interest: &Interest,
    creator_stance: Option<Stance>,
    source_type: SourceType,
) -> i64 {
    if interest.total == 0 {
        return 0;
    }
    let h = &DECISIONS.harmony;
    let total = interest.total as f64;
    let mut score = ((interest.want as f64 + interest.maybe as f64 * h.maybe_weight) / total)
        * 100.0
        - (interest.no as f64 / total) * h.no_penalty_weight;
    if creator_stance == Some(Stance::Want) {
        score += h.creator_wanted_bonus.value;
    }
    if source_type == SourceType::Ai {
        score -= h.ai_source_penalty.value;
    }
    score.clamp(h.clamp.min, h.clamp.max).round() as i64
}

/// Maps an idea to its pipeline stage.
///
/// # Parameters
/// - `stage_override`: an operator-pinned stage. Wins over everything else.
/// - `status`: the idea record's own lifecycle status.
/// - `outcome`: the computed group outcome.
///
/// # Returns
/// One of the six stages.
///
/// # Rules, in order (matching the original `stageOf`)
/// 1. **A legacy override collapses.** `discussing` and `becoming_real` are old
///    labels for "the pod agreed"; both now mean the idea has BECOME a Plan, so
///    both map to `planned`. There is no separate planning-together stage any
///    more -- agreed ideas converge into the one itinerary system. The aliases
///    come from `decisions.json -> stageMapping.legacyAliases` rather than being
///    hardcoded here.
/// 2. **Any other recognised override wins verbatim.**
/// 3. `status = archived` -> `archived`; `status = converted` -> `converted`.
/// 4. Otherwise the outcome is mapped through
///    `decisions.json -> stageMapping`: `everyone_in -> planned`,
///    `work_it_out -> considering`, `maybe_later -> maybe_later`,
///    `not_for_us -> archived`, `deciding -> deciding`.
///
/// # Deliberate deviation from the original JavaScript
/// The original returned `item.stage` verbatim for *any* truthy value, so a
/// typo'd override would flow straight into the UI. `stage` is constrained by
/// `compute.schema.json` to six values, so an **unrecognised override is ignored
/// here** and the computed stage is used instead. Keeping the contract
/// enforceable is worth more than reproducing a bug that only a malformed
/// database row could trigger.
pub fn stage_of(stage_override: Option<&str>, status: DecisionStatus, outcome: Outcome) -> Stage {
    let mapping = &DECISIONS.stage_mapping;

    if let Some(raw) = stage_override {
        // 1. Legacy aliases first: "discussing"/"becoming_real" -> "planned".
        if let Some(alias_target) = mapping.legacy_aliases.get(raw) {
            if let Some(stage) = Stage::from_contract_str(alias_target) {
                return stage;
            }
        }
        // 2. A recognised modern stage name wins verbatim.
        if let Some(stage) = Stage::from_contract_str(raw) {
            return stage;
        }
        // Anything else falls through to the computed stage (see above).
    }

    // 3. The record's own status short-circuits the vote outcome.
    match status {
        DecisionStatus::Archived => return Stage::Archived,
        DecisionStatus::Converted => return Stage::Converted,
        DecisionStatus::Active => {}
    }

    // 4. Outcome -> stage, via the rule file.
    let mapped = match outcome {
        Outcome::Deciding => mapping.deciding.as_str(),
        Outcome::EveryoneIn => mapping.everyone_in.as_str(),
        Outcome::WorkItOut => mapping.work_it_out.as_str(),
        Outcome::MaybeLater => mapping.maybe_later.as_str(),
        Outcome::NotForUs => mapping.not_for_us.as_str(),
    };
    // The rule file is validated by `rules::warm_up()` at start-up and its
    // values are all valid stage names; `maybe_later` mirrors the original's
    // final fallback if one ever were not.
    Stage::from_contract_str(mapped).unwrap_or(Stage::MaybeLater)
}

/// Composes the four primitives into the wire response for
/// `POST /decisions/evaluate`.
///
/// # Parameters
/// - `req`: membership, votes, and the optional creator/source/status/override
///   fields. `member_ids` is the denominator for every count.
///
/// # Returns
/// An [`EvaluateDecisionResponse`] whose `outcome`, `stage` and `harmony` are
/// derived from [`interest_of`], [`outcome_of`], [`stage_of`] and
/// [`consensus_score`] in that order. Harmony is an integer 0..=100.
///
/// # Edge cases
/// - An empty pod still produces a well-formed response (`total = 0`,
///   `all_voted = true`, `outcome = work_it_out` after the `deciding` and
///   `everyone_in` guards fail, `harmony = 0`). Callers must check `total`.
/// - `stage_override` is forwarded as `as_deref()` so a missing override is
///   indistinguishable from "not pinned", matching the schema's `null`.
pub fn evaluate(req: &EvaluateDecisionRequest) -> EvaluateDecisionResponse {
    let votes: Vec<(String, Stance)> = req
        .votes
        .iter()
        .map(|vote| (vote.voter_id.clone(), vote.stance))
        .collect();
    let interest = interest_of(&req.member_ids, &votes);
    let outcome = outcome_of(&interest);
    let stage = stage_of(req.stage_override.as_deref(), req.status, outcome);
    let harmony = consensus_score(&interest, req.creator_stance, req.source_type);
    EvaluateDecisionResponse {
        want: interest.want,
        maybe: interest.maybe,
        no: interest.no,
        total: interest.total,
        voted_count: interest.voted_count,
        all_voted: interest.all_voted,
        outcome,
        stage,
        harmony,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds `member_ids` as `["m0", "m1", ...]`.
    fn members(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("m{i}")).collect()
    }

    /// Builds votes for the first members, in order.
    fn votes(stances: &[Stance]) -> Vec<(String, Stance)> {
        stances
            .iter()
            .enumerate()
            .map(|(i, s)| (format!("m{i}"), *s))
            .collect()
    }

    #[test]
    fn counts_are_taken_over_members_not_votes() {
        let m = members(3);
        // One vote from a non-member and one duplicate for m0.
        let v = vec![
            ("m0".to_string(), Stance::Maybe),
            ("m0".to_string(), Stance::Want), // last write wins
            ("ghost".to_string(), Stance::Want), // ignored: not a member
        ];
        let i = interest_of(&m, &v);
        assert_eq!(i.want, 1);
        assert_eq!(i.maybe, 0);
        assert_eq!(i.no, 0);
        assert_eq!(i.total, 3);
        assert_eq!(i.voted_count, 1);
        assert!(!i.all_voted);
    }

    #[test]
    fn outcome_deciding_until_everyone_has_answered() {
        let i = interest_of(&members(3), &votes(&[Stance::Want, Stance::Want]));
        assert_eq!(outcome_of(&i), Outcome::Deciding);
    }

    #[test]
    fn outcome_everyone_in_on_unanimous_want() {
        let i = interest_of(
            &members(3),
            &votes(&[Stance::Want, Stance::Want, Stance::Want]),
        );
        assert_eq!(outcome_of(&i), Outcome::EveryoneIn);
    }

    #[test]
    fn outcome_not_for_us_uses_ceil_of_half() {
        // 3 members, 2 objections: ceil(3/2) = 2, and want (1) < no (2).
        let i = interest_of(&members(3), &votes(&[Stance::No, Stance::No, Stance::Want]));
        assert_eq!(outcome_of(&i), Outcome::NotForUs);

        // The same pod with ONE objection must not archive the idea: 1 < 2.
        let i = interest_of(&members(3), &votes(&[Stance::No, Stance::Want, Stance::Want]));
        assert_ne!(outcome_of(&i), Outcome::NotForUs);
    }

    #[test]
    fn outcome_maybe_later_when_lukewarm() {
        // maybe (2) >= want (1), maybe >= no (0), and want < total.
        let i = interest_of(
            &members(3),
            &votes(&[Stance::Maybe, Stance::Maybe, Stance::Want]),
        );
        assert_eq!(outcome_of(&i), Outcome::MaybeLater);

        // Everyone shrugging is also "maybe later", not "work it out".
        let i = interest_of(
            &members(3),
            &votes(&[Stance::Maybe, Stance::Maybe, Stance::Maybe]),
        );
        assert_eq!(outcome_of(&i), Outcome::MaybeLater);
    }

    #[test]
    fn outcome_work_it_out_when_genuinely_divided() {
        // 4 members, 2 want / 2 no. The not_for_us rule needs want < no, and
        // 2 < 2 is false, so this is a real division -> the compromise flow.
        let i = interest_of(
            &members(4),
            &votes(&[Stance::Want, Stance::Want, Stance::No, Stance::No]),
        );
        assert_eq!(outcome_of(&i), Outcome::WorkItOut);
    }

    #[test]
    fn outcome_rule_order_is_load_bearing() {
        // A 2-member pod where both want it: `no >= ceil(2/2) = 1` is false, but
        // more importantly `everyone_in` is checked FIRST. If the order were
        // reversed a unanimous 1-member pod (no = 0, want = 1) would still be
        // fine, so use the case that actually distinguishes them: everyone in a
        // 1-member pod.
        let i = interest_of(&members(1), &votes(&[Stance::Want]));
        assert_eq!(outcome_of(&i), Outcome::EveryoneIn);

        // A single member who says no: ceil(1/2) = 1, no (1) >= 1, want (0) < 1.
        let i = interest_of(&members(1), &votes(&[Stance::No]));
        assert_eq!(outcome_of(&i), Outcome::NotForUs);
    }

    #[test]
    fn harmony_matches_hand_computed_values() {
        // 4 members: 2 want, 1 maybe, 1 no.
        //   ((2 + 1*0.5) / 4) * 100 = 62.5
        //   - (1 / 4) * 15          =  3.75
        //   => 58.75 -> rounds to 59
        let i = interest_of(
            &members(4),
            &votes(&[Stance::Want, Stance::Want, Stance::Maybe, Stance::No]),
        );
        assert_eq!(consensus_score(&i, None, SourceType::User), 59);

        // Same votes, creator was enthusiastic: 58.75 + 4 = 62.75 -> 63.
        assert_eq!(
            consensus_score(&i, Some(Stance::Want), SourceType::User),
            63
        );

        // Same votes, Peapod proposed it: 58.75 - 4 = 54.75 -> 55.
        assert_eq!(consensus_score(&i, None, SourceType::Ai), 55);

        // Both adjustments cancel out: 58.75 + 4 - 4 = 58.75 -> 59.
        assert_eq!(consensus_score(&i, Some(Stance::Want), SourceType::Ai), 59);
    }

    #[test]
    fn harmony_is_clamped_to_0_and_100() {
        // Unanimous want, creator enthusiastic: 100 + 4 = 104 -> clamped to 100.
        let i = interest_of(&members(2), &votes(&[Stance::Want, Stance::Want]));
        assert_eq!(consensus_score(&i, Some(Stance::Want), SourceType::User), 100);

        // Unanimous no: 0 - 15 = -15 -> clamped to 0.
        let i = interest_of(&members(2), &votes(&[Stance::No, Stance::No]));
        assert_eq!(consensus_score(&i, None, SourceType::User), 0);

        // A maybe from everyone: ((0 + 2*0.5)/2)*100 = 50, no penalty.
        let i = interest_of(&members(2), &votes(&[Stance::Maybe, Stance::Maybe]));
        assert_eq!(consensus_score(&i, None, SourceType::User), 50);
    }

    #[test]
    fn harmony_of_an_empty_pod_is_zero() {
        let i = interest_of(&[], &[]);
        assert_eq!(i.total, 0);
        assert_eq!(consensus_score(&i, Some(Stance::Want), SourceType::User), 0);
    }

    #[test]
    fn stage_follows_the_outcome_mapping() {
        assert_eq!(
            stage_of(None, DecisionStatus::Active, Outcome::EveryoneIn),
            Stage::Planned
        );
        assert_eq!(
            stage_of(None, DecisionStatus::Active, Outcome::WorkItOut),
            Stage::Considering
        );
        assert_eq!(
            stage_of(None, DecisionStatus::Active, Outcome::MaybeLater),
            Stage::MaybeLater
        );
        assert_eq!(
            stage_of(None, DecisionStatus::Active, Outcome::NotForUs),
            Stage::Archived
        );
        assert_eq!(
            stage_of(None, DecisionStatus::Active, Outcome::Deciding),
            Stage::Deciding
        );
    }

    #[test]
    fn legacy_stage_aliases_collapse_to_planned() {
        assert_eq!(
            stage_of(Some("discussing"), DecisionStatus::Active, Outcome::Deciding),
            Stage::Planned
        );
        assert_eq!(
            stage_of(
                Some("becoming_real"),
                DecisionStatus::Active,
                Outcome::Deciding
            ),
            Stage::Planned
        );
    }

    #[test]
    fn an_override_beats_the_status_and_the_outcome() {
        assert_eq!(
            stage_of(
                Some("maybe_later"),
                DecisionStatus::Archived,
                Outcome::EveryoneIn
            ),
            Stage::MaybeLater
        );
    }

    #[test]
    fn an_unknown_override_is_ignored_rather_than_echoed() {
        // Deliberate deviation from the original: the response's `stage` is a
        // closed enum in the schema, so junk cannot pass through.
        assert_eq!(
            stage_of(Some("planning_together"), DecisionStatus::Active, Outcome::EveryoneIn),
            Stage::Planned
        );
    }

    #[test]
    fn record_status_short_circuits_the_outcome() {
        assert_eq!(
            stage_of(None, DecisionStatus::Archived, Outcome::EveryoneIn),
            Stage::Archived
        );
        assert_eq!(
            stage_of(None, DecisionStatus::Converted, Outcome::EveryoneIn),
            Stage::Converted
        );
    }

    #[test]
    fn evaluate_composes_the_four_primitives() {
        use crate::models::{DecisionMemberVote, EvaluateDecisionRequest};

        let req = EvaluateDecisionRequest {
            member_ids: members(3),
            votes: vec![
                DecisionMemberVote { voter_id: "m0".into(), stance: Stance::Want },
                DecisionMemberVote { voter_id: "m1".into(), stance: Stance::Want },
                DecisionMemberVote { voter_id: "m2".into(), stance: Stance::Want },
            ],
            creator_stance: Some(Stance::Want),
            source_type: SourceType::User,
            status: DecisionStatus::Active,
            stage_override: None,
        };
        let out = evaluate(&req);
        assert_eq!(out.want, 3);
        assert_eq!(out.total, 3);
        assert!(out.all_voted);
        assert_eq!(out.outcome, Outcome::EveryoneIn);
        assert_eq!(out.stage, Stage::Planned);
        assert_eq!(out.harmony, 100);
    }
}

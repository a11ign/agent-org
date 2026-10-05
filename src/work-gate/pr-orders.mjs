// @ts-check
// module: the pull-request orders -- what `work-gate.mjs` says to a session about a PR's own state (#2542)
//
// MOVED OUT OF `work-gate.mjs`, NOT REWRITTEN (#2542, the first split of #928's lever 2a): `draftOrder`,
// `failingChecksOrder`, `settledVerdictOrder`, `requiredWhenNeeded`, `redOnlyFromAHold` and the order builders
// for `pr-green-unarmed`, `pr-review-blocked`, `pr-merge-conflict` and `awaiting-evidence-stale`, with the
// helpers only they use. Sixty-two of 417 merges edited that one file and B4 serialised them; a fix to one
// of these orders now names THIS file in its Region.
//
// THE BOUNDARY: an ORDER BUILDER lives here, and so does a helper whose only callers are in here. A function
// that reads `gh` (`requiredCheckNames`, `readUnarmed`, `readCommitChain`), a helper a family that stayed behind
// also uses (`labelsOf`, `sessionOf`, `checksSettledGreen`, `awaitingEvidence`), and the registries (`CAUSES`,
// `decide`) stay in `work-gate.mjs` and are IMPORTED from it, never copied. That import is a cycle with the
// entry point; it is safe only while NOTHING in this file reads an imported binding at load time, so a
// top-level `const` here must never be computed from one (`AWAITING_EVIDENCE_QUIET_MS` stayed behind for
// exactly that reason: it multiplies `HOUR_MS`).
//
// `work-gate.mjs` re-exports every name this file exports that it exported before, so a caller of the gate
// is unchanged. Imports below are relative and leaf-shaped, the property the gate's own header states.
import { newestPerName } from "../newest-check-run.mjs";
import { reviewerSeat, subjectMention, subjectRef } from "../review-attribution.mjs";
import { NO_VERDICT } from "../merge-guard/checks-rule.mjs";
import { armabilityOf } from "../pr-hold-state.mjs";
import { isHeldRed } from "../red-pr.mjs";
import { sharedFileOrders } from "./shared-file-orders.mjs";
import { REPO } from "../project-identity.mjs";
import { VERIFY_STATE } from "../verify-stamp.mjs";
import { equivalentHeads } from "../review-verdict.mjs";
// #2619 (child 3d of #69): the `session:` prefix and the `blocked` label, moved to the project's
// declared vocabulary. (The `"ready"` action `kind` a few lines below is `gh pr ready`'s draft-status
// flip -- a built-in GitHub PR field, not this project's `ready` row label -- so it stays a literal.)
import { SESSION_PREFIX, BLOCKED_LABEL } from "../project-vocabulary.mjs";
import { labelsOf, sessionOf, conflictStateOf, CONFLICT_STATE, reviewStateOf, BLOCKING_REVIEW_STATES, checksSettledGreen, conclusionOf, stillRunning, anyChecksRed, requiredCheckNames,
  blockingChecks, reviewableHead, reviewWait, verdictAmong, awaitingEvidence, AWAITING_EVIDENCE_LABEL,
  AWAITING_EVIDENCE_QUIET_HOURS, AWAITING_EVIDENCE_QUIET_MS, HOUR_MS, REVIEW_STATE } from "../work-gate.mjs";

/**
 * The verdict door as an order must spell it (#3316): `~/reviewer/bin` is on no PATH, so the bare name was `command not found`. Not
 * imported from `wake.mjs`, a far heavier module for one string; `reviewer-door-install.test.ts` pins both to the installer's default.
 */
const REVIEWER_DOOR = "$HOME/reviewer/bin/pr-review-verdict";

/**
 * PURE. Is every red among these blocking checks a CANCELLED one, while something else on the head still runs?
 *
 * #1916, #1007's shape a second time. `checks-rule.mjs` ruled in #1007 that a cancelled run is NO VERDICT -- the
 * replacement is already going -- and this file kept its own copy of the predicate without that ruling. Measured
 * on #1914 at `63b11ecc` and #1924 at `c0864658`, 2026-09-22: two `ci` runs fired on one head a second apart,
 * `cancel-in-progress` killed the first, and the required `gate` existed ONLY in the cancelled run while the live
 * run's `ts / run` was still going. `newestPerName` had nothing newer to choose, so the gate sent
 * `pr-checks-failing` to an author whose PR went `CLEAN` minutes later.
 *
 * ONLY WHILE SOMETHING ELSE STILL RUNS. A cancelled check that is genuinely the last word held #1605 BLOCKED;
 * with nothing in flight on the head it is still settled red and still reaches its author, never silence.
 * `NO_VERDICT` is IMPORTED: the rollup spells it in upper case, the REST read in lower (#1100), and the concept is one ruling either way.
 *
 * @param {any[]} blocking the blocking checks, narrowed @param {any[]} head every check on the head, narrowed
 */
export function redOnlyBySupersededRun(blocking, head) {
  const red = blocking.filter((c) => checksSettledGreen([c]) === false);
  return red.length > 0 && red.every((c) => conclusionOf(c) === NO_VERDICT.toUpperCase()) && head.some(stillRunning);
}

/**
 * PAID BY A RED TICK, OR BY ONE HOLDING A GREEN DRAFT (#3448). A healthy queue of ready pull requests never asks what is required, so
 * the UNCONDITIONAL read count is unchanged -- see `GH_READS` for what that count actually is, and for the correction that had to be
 * made to this very comment. A green DRAFT is the other asker: it is the pull request the ready-flip reaches, and the flip over a red
 * verify stamp is allowed only on a list of required checks that was actually read (`stampWithholdsReady`).
 *
 * (Extracted from `main`, which reached `complexity` 17 with the ternary inline -- the same seam the
 * dead man's switch took, and for the same reason: `main` is about delivering what the gate found.)
 *
 * @param {any[]} prs @param {() => string[] | null} [read] the required-checks read, a seam so a test can count the calls
 */
export function requiredWhenNeeded(prs, read = requiredCheckNames) {
  return anyChecksRed(prs) || anyGreenDraft(prs) ? read() : null;
}

/** @param {any[]} prs */
function anyGreenDraft(prs) {
  return prs.some((pr) => pr?.isDraft === true && checksSettledGreen(newestPerName(pr?.statusCheckRollup ?? [])) === true);
}

/**
 * #2209: ONE ORDER PER CONFLICTED PULL REQUEST, ADDRESSED TO ITS AUTHOR -- and never to `product-manager`
 * when the pull request names one.
 *
 * THE FIX FOR THIS BLIND SPOT IS NOT AN EXCLUSION. Removing a `DIRTY` pull request from
 * `shouldBeMerging` and reporting it nowhere is strictly worse than the state the row found, where
 * `pr-green-unarmed` at least reached somebody, wrongly. A conflict is CODE WORK -- a rebase, with
 * judgment about which side of each hunk wins -- so it belongs to the session on the PR's `session:`
 * label, exactly as `failingChecksOrder` and `notConvincedOrder` route theirs. With no label it falls back
 * to `product-manager`, the queue's first reader, who can find out whose it is.
 *
 * PER PULL REQUEST AND NOT ONE ORDER FOR THE SET, unlike `greenUnarmedOrders`: a credential outage strands
 * every open PR at once and one order shows the shape, but a conflict is one author's one branch, and a set
 * order would wake somebody about work that is not theirs. The `causeKey` carries the head, so a push that
 * did not clear the conflict is a new question and a push that did leaves the set.
 *
 * `arm-pr.mjs` IS NOT OFFERED and the prompt says so: `auto-arm-sweep.mjs` records that `gh pr merge
 * --auto` "exits non-zero for a merged PR, an unmergeable one and a network fault alike", so the remedy
 * `pr-green-unarmed` hands over cannot succeed on this state.
 *
 * @param {any[]} conflicted from `conflictedPrs`
 * @returns {{session: string, cause: string, subject: string, discriminator: string,
 *            prompt: string, causeKey: string}[]}
 */
export function mergeConflictOrders(conflicted) {
  return conflicted.map((pr) => {
    const owner = sessionOf(pr);
    return conflictOrder(pr, {
      session: owner ?? "product-manager",
      standing: "is green on every required check and NOT held",
      ownership: owner ? "It carries your session label, so the rebase is yours." : "It names no session, so find whose it is.",
    });
  });
}

/**
 * One `pr-merge-conflict` order. THE WORDS THAT DIFFER BETWEEN THE TWO CALLERS ARE ARGUMENTS and the rest is one
 * text, so the rebase advice and the `arm-pr.mjs` warning cannot drift between the green-only order and the
 * total one (#2968).
 *
 * @param {any} pr
 * @param {{session: string, standing: string, ownership: string}} says `standing`: what the pull request IS besides conflicting
 */
function conflictOrder(pr, { session, standing, ownership }) {
  const head8 = String(pr.headRefOid ?? "").slice(0, 8) || "no-head";
  const ref = `pr-${subjectRef(pr.repoKey, pr.number)}`;
  return {
    session,
    cause: "pr-merge-conflict",
    subject: ref,
    discriminator: head8,
    prompt: `${subjectMention(pr)} at \`${head8}\` ${standing}, and it `
      + "CONFLICTS with `main`: GitHub reports it cannot merge as it stands, whatever its review "
      + "decision or arming.\n"
      + `${ownership} `
      + "Merge or rebase `main` into the branch, resolve the conflicts, re-run the gate and push.\n"
      + "DO NOT ARM IT: `gh pr merge --auto` exits non-zero for an unmergeable pull request, so "
      + "`arm-pr.mjs` cannot succeed here. Until this is resolved it is also holding every Ready row "
      + "that shares a file with it (B4) -- #2203 held six.",
    causeKey: `${session}/pr-merge-conflict/${ref}/${head8}`,
  };
}

/**
 * #2968: THE REASON A PULL REQUEST IS NOT MERGING, as a TOTAL classifier -- every open pull request gets exactly one
 * of eight answers, and there is no "other".
 *
 * WHY IT EXISTS. #2950 sat a DRAFT, `DIRTY`, with an EMPTY `statusCheckRollup` for 7.5 hours and no order of any kind
 * reached its owner: the conflict order was fed by `greenUnheldPrs` ("not a draft, settled GREEN"), and a branch that
 * conflicts gets no `pull_request` run, so the one state a conflict produces was the one state that population could
 * not see. The red order needs red, the review order needs green, `pr-green-unarmed` needs green. THE CLASS is a
 * pull request that cannot merge for any reason but red having no owner signal, so the question is asked of EVERY
 * pull request and a new state falls into a named answer rather than between four populations.
 *
 * THE ORDER OF THE QUESTIONS IS THE DESIGN:
 *   1. `held-on-purpose`   a `hold:*` label (`armabilityOf`, the predicate arming itself reads) or `awaiting-evidence`:
 *                          somebody said not yet, so nobody is told it is stalled.
 *   2. `red`               blocking checks SETTLED red (not a superseded run: `failingChecksOrder`'s own test). BEFORE
 *                          `conflicted`, because a red pull request already reaches its owner under `pr-checks-failing`
 *                          and `work-gate.test.ts` pins that a conflicted red one is that cause's subject alone (#2209).
 *   3. `conflicted`        BEFORE the green/pending/none question, which is the point: a conflict is code work whether
 *                          or not CI ran, and a conflicted head has stale or absent checks, so requiring green first is
 *                          how #2950 was missed.
 *   4. `hung-check`        a blocking check STARTED more than `CHECK_RUNNING_TOO_LONG_MINUTES` ago and is still running,
 *                          on a pull request that is not a draft (#3120). BEFORE `progressing`, because a running check
 *                          is `progressing` for as long as it runs and a hung one never stops: a11ign/agent-org#83 sat
 *                          4 h in `gate`, held for review that could not start, and nobody was told.
 *   5. `progressing`       no settled-green check yet -- none, or still running -- so the next tick asks again.
 *                          A pull request whose CI never STARTS also reads here: there is no `startedAt` to age, and
 *                          the health signal that wakes `ceo` (#2936's sibling) is the reader of that.
 *   6. `awaiting-author-draft`  green, but still a draft: the author owes "ready", or the rework a verdict named.
 *   7. `awaiting-review`   green, ready, and GitHub's own `reviewDecision` blocks (`reviewStateOf`; an ABSENT field
 *                          is not accused, which is that function's rule).
 *   8. `ejected`           green, ready, review not blocking, and the merge queue REMOVED it for `failed_checks` with its
 *                          head unmoved since (#3019): `pr.ejection` is stamped by the caller from the timeline
 *                          (`queueEjectionOf`). BEFORE `unarmed`, because an ejected PR reads `armed === false` too and
 *                          "arm it by hand" re-enters the queue and fails the same red run again.
 *   9. `unarmed`           green, ready, review not blocking, and `pr.armed === false`. `armed` is stamped by the
 *                          caller from a queue read; ABSENT IS NOT `false`, so an unread arming is never an accusation.
 *
 * A reason is not an order: `STALL_REASONS_WITHOUT_A_CAUSE` says which ones `decide` sends, and why only that one.
 *
 * `nowMs` is an argument so the classifier stays pure under test; the default is the one clock read, the way
 * `awaitingEvidenceStaleOrders` takes its own, so a caller that has no tick time to hand over needs no change.
 *
 * @param {any} pr @param {string[] | null} [required] @param {number} [nowMs]
 * @returns {string} a `STALL_REASON` value
 */
export function stallReasonOf(pr, required = null, nowMs = Date.now()) {
  if (!armabilityOf({ labels: labelsOf(pr) }).arm || awaitingEvidence(pr)) return STALL_REASON.HELD_ON_PURPOSE;
  const settled = settledChecksOf(pr, required);
  if (settled === false) return STALL_REASON.RED;
  if (conflictStateOf(pr) === CONFLICT_STATE.CONFLICTING) return STALL_REASON.CONFLICTED;
  if (settled !== true) return hungCheckOf(pr, required, nowMs) ? STALL_REASON.HUNG_CHECK : STALL_REASON.PROGRESSING;
  if (pr?.isDraft === true) return STALL_REASON.AWAITING_AUTHOR_DRAFT;
  if (BLOCKING_REVIEW_STATES.includes(reviewStateOf(pr).code)) return STALL_REASON.AWAITING_REVIEW;
  if (pr?.ejection) return STALL_REASON.EJECTED;
  return pr?.armed === false ? STALL_REASON.UNARMED : STALL_REASON.PROGRESSING;
}

/** The nine answers of `stallReasonOf`. Only `PROGRESSING` and `HELD_ON_PURPOSE` produce no order. */
export const STALL_REASON = Object.freeze({
  PROGRESSING: "progressing",
  HUNG_CHECK: "hung-check",
  RED: "red",
  CONFLICTED: "conflicted",
  AWAITING_REVIEW: "awaiting-review",
  AWAITING_AUTHOR_DRAFT: "awaiting-author-draft",
  EJECTED: "ejected",
  UNARMED: "unarmed",
  HELD_ON_PURPOSE: "held-on-purpose",
});

/**
 * `true` settled green, `false` settled red, `null` nothing settled (none, or still running) -- on the checks that can
 * hold the pull request. A red that exists only because a superseded run is cancelled while another still runs is
 * NOT red, exactly as in `failingChecksOrder`: the two must agree or `red` would name a pull request that order skips.
 *
 * @param {any} pr @param {string[] | null} required
 * @returns {boolean | null}
 */
function settledChecksOf(pr, required) {
  const onHead = newestPerName(pr?.statusCheckRollup ?? []);
  const blocking = blockingChecks(onHead, required);
  const settled = checksSettledGreen(blocking);
  return settled === false && redOnlyBySupersededRun(blocking, onHead) ? null : settled;
}

/**
 * #3120: how long a blocking check may run before it is not `progressing`. MEASURED 2026-10-03 from `gh run list --workflow ci
 * --status completed --limit 300` on the project's own repository: of 193 success-or-failure runs the median was 7 min, p95 8, MAX 12; agent-org's
 * 67 were 2 min median, 3 max. 60 is five times the longest `ci` run in either repository, and is `ceo`'s own figure (#3120).
 */
export const CHECK_RUNNING_TOO_LONG_MINUTES = 60;
const RUNNING_STATUSES = Object.freeze(["IN_PROGRESS", "QUEUED"]);

/**
 * #3120: THE NEWEST RUN OF A BLOCKING CHECK THAT HAS BEEN RUNNING TOO LONG, or `null`. Read from the `statusCheckRollup` the gate
 * already holds -- each check carries `startedAt` -- so it costs no call and no timer.
 *
 * `newestPerName` FIRST, so an older run of the same name still `in_progress` beside a newer settled one does not count. A DRAFT is
 * never asked: a hung check on one is its author's work in progress. A check with NO readable `startedAt` is never accused --
 * absent is not an age, and a run that cannot be aged stays `progressing` as it always did. Of several hung checks the one that
 * started FIRST is named, so the order's key moves only when that check does.
 *
 * @param {any} pr @param {string[] | null} required @param {number} nowMs
 * @returns {{ name: string, startedAt: string, runningMinutes: number, detailsUrl: string | null } | null}
 */
export function hungCheckOf(pr, required, nowMs) {
  if (pr?.isDraft === true) return null;
  const running = blockingChecks(newestPerName(pr?.statusCheckRollup ?? []), required)
    .filter((check) => RUNNING_STATUSES.includes(String(check?.status ?? "").toUpperCase()))
    .map((check) => ({ check, startedMs: Date.parse(check.startedAt ?? "") }))
    .filter(({ startedMs }) => Number.isFinite(startedMs) && nowMs - startedMs > CHECK_RUNNING_TOO_LONG_MINUTES * MS_PER_MINUTE)
    .sort((a, b) => a.startedMs - b.startedMs);
  if (running.length === 0) return null;
  const { check, startedMs } = running[0];
  return { name: String(check.name), startedAt: String(check.startedAt), runningMinutes: Math.floor((nowMs - startedMs) / MS_PER_MINUTE),
    detailsUrl: typeof check.detailsUrl === "string" && check.detailsUrl ? check.detailsUrl : null };
}

/**
 * The `stallReasonOf` answers that have NO dedicated cause already reaching the owner, and so the only ones `decide`
 * sends. `red` has `pr-checks-failing` (to `ownerOfPr`), `awaiting-review` has `pr-review-blocked`, `unarmed` has
 * `pr-green-unarmed` (deliberately to `product-manager`, #1969) and a green draft has `draft-awaiting-verdict`; a second
 * order for each would wake one session twice about one fact. `conflicted` had a cause and no way to reach a draft or a
 * pull request with no checks, which is what #2968 closes. `ejected` (#3019) is a red the PR's own checks never showed --
 * the `merge_group` run failed -- so `pr-checks-failing`'s population (settled red ON THE HEAD) cannot contain it, and
 * the only other order about it was `pr-green-unarmed`'s wrong one, which it now leaves. `hung-check` (#3120) is a check that is
 * neither red nor green, so `pr-checks-failing`'s population (settled red) cannot contain it either.
 */
export const STALL_REASONS_WITHOUT_A_CAUSE = Object.freeze([STALL_REASON.CONFLICTED, STALL_REASON.EJECTED, STALL_REASON.HUNG_CHECK]);

/**
 * The cause a stalled pull request's order is filed under. NO NEW CAUSE, on purpose: a cause is declared in
 * `cause-declaration.mjs` and pinned by name in several guards, so a `pr-stalled` cause is a separate change. Each
 * reason is filed under the cause that already owns that state, and wiring one into `decide` means checking that
 * cause's liveness reader (`wake.mjs`) still agrees the order is live.
 */
const CAUSE_OF_STALL = Object.freeze({
  [STALL_REASON.RED]: "pr-checks-failing",
  [STALL_REASON.EJECTED]: "pr-checks-failing", // #3019: a red build, one the queue found rather than the PR's own run
  [STALL_REASON.HUNG_CHECK]: "pr-checks-failing", // #3120: a build that has not finished is the owner's to cancel or fix, as a red one is
  [STALL_REASON.CONFLICTED]: "pr-merge-conflict",
  [STALL_REASON.AWAITING_REVIEW]: "pr-review-blocked",
  [STALL_REASON.AWAITING_AUTHOR_DRAFT]: "draft-awaiting-verdict",
  [STALL_REASON.UNARMED]: "pr-green-unarmed",
});

/**
 * PURE. #2968: ONE ORDER FOR A STALLED PULL REQUEST, ADDRESSED TO `ownerOfPr(pr).session` -- never `product-manager`, and
 * `null` for `progressing` and `held-on-purpose`, which are not stalls.
 *
 * `conflicted` KEEPS #2209's text and its key (`<owner>/pr-merge-conflict/pr-<n>/<head8>`), so an order already
 * delivered is not sent twice; what changes is the POPULATION (a draft, and a pull request with no checks, now reach
 * their owner) and the unlabelled fallback (`ownerOfPr`'s `ceo`, not `product-manager`, #2941). The other reasons are
 * keyed on the reason and never the head: a push that did not clear a stall must not re-wake the owner.
 *
 * `hung-check` (#3120) is keyed on the check's `startedAt`, like an ejection on `removedAt`: a re-run keeps the head and is a new start,
 * so the same head hanging twice is two orders, and the same hang on a later tick is one.
 *
 * @param {any} pr @param {string[] | null} [required] @param {number} [nowMs]
 * @returns {{session: string, cause: string, subject: string, discriminator: string, prompt: string, causeKey: string} | null}
 */
export function stallOrderOf(pr, required = null, nowMs = Date.now()) {
  const reason = stallReasonOf(pr, required, nowMs);
  const cause = /** @type {Record<string, string>} */ (CAUSE_OF_STALL)[reason];
  if (!cause) return null;
  const owner = ownerOfPr(pr);
  if (reason === STALL_REASON.CONFLICTED) {
    return conflictOrder(pr, { session: owner.session, standing: standingOf(pr, required), ownership: ownershipOf(pr, owner.source, "rebase") });
  }
  const ref = `pr-${subjectRef(pr.repoKey, pr.number)}`;
  const hung = reason === STALL_REASON.HUNG_CHECK ? hungCheckOf(pr, required, nowMs) : null;
  const sentence = hung ? hungSentence(hung) : reason === STALL_REASON.EJECTED ? ejectedSentence(pr.ejection) : /** @type {Record<string, string>} */ (REASON_SENTENCE)[reason];
  return {
    session: owner.session,
    cause,
    subject: ref,
    discriminator: reason,
    prompt: `${subjectMention(pr)} is STALLED: ${sentence} ${ownershipOf(pr, owner.source, "fix")}`,
    // An ejection is KEYED ON WHEN IT HAPPENED: a push that fails the queue again is a new fact and must wake the owner
    // again, while the same unanswered ejection stays one order. A hung check is keyed on when IT STARTED, for the same reason.
    // The other reasons are keyed on the reason alone.
    causeKey: `${owner.session}/${cause}/${ref}/${reason}${reason === STALL_REASON.EJECTED ? `/${pr.ejection?.removedAt ?? ""}` : ""}${hung ? `/${hung.startedAt}` : ""}`,
  };
}

/**
 * #3120: THE WORDS OF A `hung-check` ORDER. It names the check, how long it has run and which run it is, so the engineer it wakes can
 * open the run without reading anything else. A run the rollup carried no link for is SAID to be unfound, never guessed.
 * @param {{ name: string, startedAt: string, runningMinutes: number, detailsUrl: string | null }} hung
 */
function hungSentence({ name, startedAt, runningMinutes, detailsUrl }) {
  const run = detailsUrl ? `the run is ${detailsUrl}` : "the run link was NOT in the check rollup, so find it under the pull request's Checks tab";
  return `its required check \`${name}\` has been running for ${runningMinutes} minutes (started ${startedAt}) and has not finished, `
    + `so the pull request is neither green nor red and nothing will say so; ${run}. Open it, find the step that does not return, and `
    + "CANCEL AND RE-RUN it if it is stuck, or fix what hangs it. A re-run is a new start: if it hangs again you are told again.";
}

/**
 * #3019: THE WORDS OF AN `ejected` ORDER. It says what the queue did, names the run and the subtests it failed, and says
 * in words that re-arming without a push fails the same way -- because the order it replaces told `product-manager` to
 * do exactly that. A run or a subtest list the read could not get is SAID to be unread, never left out and never guessed.
 * @param {{ removedAt?: string | null, runId?: number | null, failingTests?: string[] | null } | undefined} ejection
 */
function ejectedSentence(ejection) {
  const run = ejection?.runId ? `run ${ejection.runId}` : "its `merge_group` run (the run id could NOT be read)";
  const tests = ejection?.failingTests?.length
    ? ` Failing subtests: ${ejection.failingTests.join("; ")}.` : " The failing subtests could NOT be read from the log.";
  return `it was ARMED (auto-arm worked) and the merge queue then EJECTED it${ejection?.removedAt ? ` at ${ejection.removedAt}` : ""} with `
    + `reason \`failed_checks\`: the \`merge_group\` run of \`gate\` was red -- ${run}.${tests} It was green on its own head, so the `
    + "red is the queue's merge with `main`, not your last push. RE-ARMING IT WITHOUT A PUSH WILL FAIL THE SAME WAY, and a failing entry "
    + "makes the entries behind it rebuild: fix what that run names, push, and auto-arm re-enters it.";
}

/** What each non-conflict stall means, in the one sentence an owner needs. */
const REASON_SENTENCE = Object.freeze({
  [STALL_REASON.RED]: "a required check has settled RED on its head and nothing is fixing it.",
  [STALL_REASON.AWAITING_REVIEW]: "it is green and ready, and GitHub's `reviewDecision` is holding it for a review nobody has posted or a refusal nothing has answered.",
  [STALL_REASON.AWAITING_AUTHOR_DRAFT]: "it is green and still a DRAFT, so it can merge only after its author marks it ready.",
  [STALL_REASON.UNARMED]: "it is green, ready and NOT held, and nothing has armed it.",
});

/**
 * The clause after "and it" in a `conflicted` order: what the pull request is besides conflicting, from the facts that
 * DISTINGUISH the states #2950 fell between. Never claims a check state the payload did not carry.
 * @param {any} pr @param {string[] | null} required
 */
function standingOf(pr, required) {
  const settled = settledChecksOf(pr, required);
  const checks = settled === true ? "green on every required check"
    : settled === false ? "red on a required check"
      : newestPerName(pr?.statusCheckRollup ?? []).length === 0
        ? "carrying NO CHECKS (a branch that conflicts with `main` gets no `pull_request` run, so none will start until it is rebased)"
        : "still running its checks";
  return `is ${pr?.isDraft === true ? "a DRAFT, " : ""}${checks} and NOT held`;
}

/**
 * Who `task` belongs to, and on whose authority -- `ownerOfPr`'s rungs in words. The `ceo` rung says nobody could
 * be named, because an owner order that does not say so reads as the owner's own work and gets done by the wrong hands.
 * @param {any} pr @param {string} source one of `ownerOfPr`'s sources @param {string} task "rebase" or "fix"
 */
function ownershipOf(pr, source, task) {
  if (source === "ceo") {
    return `NOBODY COULD BE NAMED as its owner (${nobodyBasis(pr, "no session label, no live session holding a row it closes or its branch names, and none stamped its worktree")}). You are the last answer: re-lane it to the session that should ${task} it (\`${SESSION_PREFIX}<name>\` on the PR), or close it if it was abandoned.`;
  }
  if (source === "label") return `It carries your session label, so the ${task} is yours.`;
  return `The ${task} is yours: ${notConvincedBasis(pr, source)}.`;
}

/**
 * PURE. #2968: the orders for every stalled pull request among `prs`, ascending by number. `reasons` narrows which
 * stall reasons are SENT (`STALL_REASONS_WITHOUT_A_CAUSE` is what `decide` passes); the default is all of them.
 *
 * @param {any[]} prs @param {{required?: string[] | null, reasons?: readonly string[] | null, nowMs?: number}} [asked]
 */
export function stalledPrOrders(prs, { required = null, reasons = null, nowMs = Date.now() } = {}) {
  return (prs ?? [])
    .filter((pr) => pr && Number.isFinite(Number(pr.number)))
    .filter((pr) => reasons === null || reasons.includes(stallReasonOf(pr, required, nowMs)))
    .sort((a, b) => Number(a.number) - Number(b.number))
    .map((pr) => stallOrderOf(pr, required, nowMs))
    .filter((order) => order !== null);
}

/**
 * ONE ORDER NAMING EVERY GREEN, UNHELD, UNARMED PULL REQUEST -- #1969, and the report that did not exist.
 *
 * WHAT IT IS FOR. `queue-stalled.mjs` names every ARMED, green PR that cannot merge. Nothing named a
 * green, unheld, UNARMED one, and that is the exact state a refused arming credential produces: measured
 * 2026-09-22, #1958 and #1949 were approved, convinced, green on every job and `MERGEABLE` for 28
 * minutes with nothing in the repository able to arm either, because BOTH things that arm -- `arm` and
 * `sweep` -- read the one refused credential. They were found because a session was woken about an
 * unrelated red check and read the log.
 *
 * THE WATCHER MUST NOT SHARE THE CREDENTIAL IT WATCHES, which is `ceo`'s first constraint and the reason
 * this lands here rather than in `auto-arm.yml`. `stalled` is the standing proof of the failure: it ran
 * green throughout the outage, on the same six runs, because it asks a question the dead credential was
 * not needed for. This gate runs on the agent host under the host's own `gh` identity -- measured
 * 2026-09-23 as `a11ign-ai-workers`, while the arming PAT belongs to `DanBeckDev` (user ID 46429371, the
 * account the outage named) -- so a pool that kills arming leaves this reader alive. It never reads
 * `A11IGN_BOT_TOKEN`; that secret exists only inside Actions.
 *
 * DATA AND NOT A RED CHECK, which is `ceo`'s second constraint. A repo-wide fact charged to whichever
 * PR's event fired is #1970's defect one file over; here it is an order with a named audience.
 *
 * ONE ORDER FOR THE SET, NOT ONE PER PULL REQUEST, and this is the case where `rowOrders`'s lesson
 * inverts. A credential outage strands EVERY open PR at once, so per-PR orders would wake every session
 * in the org to hand-arm one pull request each, and none of them would see the shape. The set is also
 * what makes the cause self-clearing: keyed on the SET (`fleetBatchOrders`'s rule), it fires when the
 * membership changes and stays quiet while it does not -- a count would collide two different pairs.
 *
 * `product-manager` BECAUSE THE ROUTING RULE SAYS SO: first reader for "the queue and process ... merge
 * close-outs". Arming by hand under another account's token is `auto-arm.yml`'s own documented exception
 * for a PR auto-arm never armed, and it is a queue act rather than the author's code work.
 *
 * @param {number[] | null} unarmed `null` when the queue read was refused -- no order, never a false all-clear
 * @param {{ key: string, repo: string }} [scope] the repository these pull requests are in; the primary project's when omitted
 * @returns {{session: string, cause: string, subject: string, discriminator: string,
 *            prompt: string, causeKey: string}[]}
 */
export function greenUnarmedOrders(unarmed, scope = { key: "", repo: REPO }) {
  if (unarmed === null || unarmed.length === 0) return [];
  const refs = unarmed.map((n) => subjectRef(scope.key, n));
  const key = refs.join(".");
  return [{
    session: "product-manager",
    cause: "pr-green-unarmed",
    subject: "pr-green-unarmed",
    discriminator: key,
    prompt: `${unarmed.length} pull request(s) are green on every required check, NOT held, and NOTHING `
      + `HAS ARMED THEM: ${unarmed.map((n) => subjectMention({ repoKey: scope.key, number: n })).join(", ")}.\n`
      + "This is the state a refused arming credential produces, and it is invisible everywhere else: "
      + "`queue-stalled.mjs` names armed PRs that cannot merge, and a green unarmed one is the mirror "
      + "nothing reported until #1969. It is read here with the HOST's identity, never the arming PAT, "
      + "so this order survives the outage it reports.\n"
      + "FIRST ASK WHETHER THE CREDENTIAL IS REFUSING, because one PR unarmed and all of them unarmed "
      + "want different acts: read the newest `arm` job log in `auto-arm.yml` -- since #1969 it prints a "
      + "`SCOPE` line saying whether the refusal is about that one PR or repository-wide, and names the "
      + "minute the pool returns.\n"
      + "REPOSITORY-WIDE: nothing will arm anything until that minute. Arm these by hand with "
      + "`node packages/agent-org/src/arm-pr.mjs --pr=<n> --repo=" + scope.repo + "` under an identity whose "
      + "pool is alive -- the workflow's own documented exception for a PR auto-arm never armed -- and "
      + "say on #1969 that it recurred, with the window.\n"
      + "ONE PR ONLY: it is likelier that PR never got an arming event (opened while conflicting, or "
      + "reopened). Arming it is the same command.\n"
      + `IF A PR HERE SHOULD NOT MERGE, the answer is a \`hold:\` label or a \`${SESSION_PREFIX}\` label on the PR `
      + "itself -- both are read by the same predicate this order used, so it leaves this set at once. A "
      + "PR you merely skip stays in the set and this order returns unchanged.",
    causeKey: `product-manager/pr-green-unarmed/${key}`,
  }];
}

/**
 * #2084: ONE ORDER NAMING EVERY GREEN, UNHELD PULL REQUEST THAT GITHUB'S REVIEW REQUIREMENT IS HOLDING.
 *
 * THE BLIND SPOT, AND IT IS THE LAST ONE IN THIS FAMILY. `pr-checks-failing` names a red PR,
 * `pr-green-unarmed` names a green one nothing armed, and `queue-stalled.mjs` names an armed one that
 * cannot merge -- and NONE of them can see a pull request that is green, unheld, armed, and refused by
 * GitHub's own `reviewDecision`. Measured 2026-09-23: #2049 sat in exactly that state for over seven hours
 * on a stale `CHANGES_REQUESTED` posted at a head the author had already fixed, and every org read
 * returned green-and-armed. Measured again at `468a74f1b` while this was being built: #2198, opened ready
 * at 17:39:37Z with ZERO reviews, `mergeStateStatus: BLOCKED`, `reviewDecision: REVIEW_REQUIRED`, armed --
 * and `decide` returned no order of any kind for it.
 *
 * THAT SECOND READING IS THE MEASUREMENT THE ROW ASKED FOR, AND IT SETTLES A QUESTION IT LEFT OPEN.
 * #2084 says of this done-when that "done-when 1 removes most of the need for it". It does not. #2198 has
 * NO REVIEW TO DISMISS -- it is a docs-and-tests PR, which `agent-practices.md` says opens READY rather
 * than as a draft, so the reviewer lane never sees it: until #2176 `draftOrder` returned `null` on its first
 * line for anything that is not a draft. Dismissing stale reviews cannot reach a pull request that has none. The
 * two halves of this row are therefore NOT the same fact stated twice, and the evidence is one PR that
 * neither half alone would have found.
 *
 * `product-manager`, AND ONE ORDER FOR THE SET -- `greenUnarmedOrders`' shape, for its reasons and one
 * more. The routing rule makes `product-manager` first reader for "the queue and process", and
 * `agent-practices.md` already gives it this exact act: "a draft with no verdict 30 minutes after the
 * author's prompt is reported to `product-manager`, who re-prompts once and then tells `ceo`". So this
 * cause needs no new reviewer-prompting machinery -- it hands an existing owner a state they could not
 * previously see. #2084 warned against building the reviewer half without measuring the remainder, and
 * routing to the reader whose brief already covers re-prompting is how that warning is honoured rather
 * than argued with.
 *
 * KEYED ON THE SET WITH EACH DECISION IN IT, AND DELIBERATELY NOT ON THE HEAD. A head in the key would
 * re-fire on every push, which during a rework is every few minutes; the STATE is what has to change
 * before the question is a new one. This also makes the key the row's own diagnosis in one string: with
 * `dismiss_stale_reviews: false` a push leaves `CHANGES_REQUESTED` standing, so the key does not move and
 * `product-manager` is not re-woken about an unchanged refusal -- and once it is `true`, that same push
 * dismisses the review, the decision becomes `REVIEW_REQUIRED`, the key moves, and the order fires with
 * the state that now needs a reviewer.
 *
 * #2283, THE #2001 PRINCIPLE APPLIED TO THIS CAUSE: A PULL REQUEST THAT CARRIES A `session:` LABEL IS THAT
 * SESSION'S ORDER, and only an unlabelled one stays in the set order below. `ceo`'s rule is that an order whose
 * subject carries a machine-readable owner goes to that owner, and `failingChecksOrder` and `notConvincedOrder`
 * already do it. It holds here because the reader has the label (`reviewBlocked` reads it off the same list) and
 * the one state it routes to a session is the author's to act on: a REFUSED pull request, whose rework the author owes.
 * (#3592: AWAITING_REVIEW is not routed here at all -- `draftOrder` starts its reviewer.)
 *
 * `UNRECOGNISED` STAYS AT `product-manager` WHOEVER OWNS THE PR (`ownedBy`). It is a value of GitHub's this gate
 * has never seen -- a fact about the gate's vocabulary, which the author can neither read nor fix.
 *
 * KEYED ON THE STATE AND NEVER THE HEAD, for the set order and the per-PR ones alike (#2084): the per-PR key is
 * `<session>/pr-review-blocked/pr-<n>/<CODE>`, so a push during a rework does not re-fire it. The head
 * is in the PROMPT of a refusal instead, as its first fact, where it informs without re-waking.
 *
 * @param {{number: number, code: string, why: string, session?: string | null, head?: string,
 *          refusedAt?: string | null}[]} blocked
 * @returns {{session: string, cause: string, subject: string, discriminator: string,
 *            prompt: string, causeKey: string}[]}
 */
export function reviewBlockedOrders(blocked) {
  const owned = blocked.filter(ownedBy);
  const unowned = blocked.filter((b) => !ownedBy(b));
  return [...reviewBlockedSetOrder(unowned), ...owned.map(ownedReviewBlockedOrder)];
}

/** A pull request whose blocked state is its own session's to act on: labelled and REFUSED (#3592: AWAITING_REVIEW is its reviewer's, never reported here). */
function ownedBy(/** @type {{code: string, session?: string | null}} */ b) {
  return Boolean(b.session) && b.code === REVIEW_STATE.REFUSED;
}

/**
 * a11ign#3199: THE SENTENCE A LIFTED REFUSAL ADDS TO ITS LINE. Nobody owes rework for it (it was posted for a check that has since cleared at an equal
 * patch, a defect that was in the base), so the set order must not read as one more refusal to chase: its reviewer seat is asked by `draft-awaiting-verdict`.
 * @param {{refusalLifted?: boolean}} b
 */
function liftedNote(b) {
  return b.refusalLifted === true
    ? " [LIFTED: posted while a check failed, and none fails at this head with the same patch; no rework is owed -- a fresh review from its reviewer seat is the remedy]"
    : "";
}

/**
 * The unlabelled set, and every UNRECOGNISED one: ONE order for `product-manager`, exactly as #2084 built it.
 * @param {{number: number, repoKey?: string, code: string, why: string, refusalLifted?: boolean}[]} blocked
 */
function reviewBlockedSetOrder(blocked) {
  if (blocked.length === 0) return [];
  const key = blocked.map((b) => `${subjectRef(b.repoKey, b.number)}:${b.code}`).join(".");
  return [{
    session: "product-manager",
    cause: "pr-review-blocked",
    subject: "pr-review-blocked",
    discriminator: key,
    prompt: `${blocked.length} pull request(s) are green on every required check and NOT held, and `
      + "GitHub's own `reviewDecision` is holding them:\n"
      + blocked.map((b) => `  ${subjectMention(b)}  ${b.code} -- ${b.why}${liftedNote(b)}`).join("\n") + "\n"
      + "NO QUEUE READ IN THIS REPOSITORY TOUCHED THIS FIELD BEFORE #2084 -- only `row-claim`'s own "
      + "claim refusal -- which is why a pull request in this state read as healthy everywhere: #2049 "
      + "was green and armed and unmergeable for over seven hours, and no org read could say why.\n"
      + "REFUSED is a reviewer's `CHANGES_REQUESTED`, and it does NOT clear by being pushed past. Decide "
      + `whether it stands: rework belongs to the session on the PR's \`${SESSION_PREFIX}\` label, and a newer `
      + "review is the only thing that lifts it.\n"
      + "A REFUSAL AT A HEAD THE AUTHOR HAS ALREADY FIXED IS THE #2084 SHAPE -- compare the review's "
      + "commit against `headRefOid` before routing rework nobody owes.\n"
      + "IF A PR HERE SHOULD NOT MERGE, a `hold:` label removes it from this set at once, read by the "
      + "same predicate this order used. One you merely skip stays in the set.",
    causeKey: `product-manager/pr-review-blocked/${key}`,
  }];
}

/**
 * One labelled pull request's order, to the session on its label. PER PULL REQUEST, where the set order is one
 * for the set: this is one author's one branch, and a set order would wake them about work that is not theirs.
 * @param {{number: number, repoKey?: string, code: string, session?: string | null, head?: string, refusedAt?: string | null, patchUnchanged?: boolean | null}} b
 */
function ownedReviewBlockedOrder(b) {
  const session = String(b.session);
  return {
    session,
    cause: "pr-review-blocked",
    subject: `pr-${subjectRef(b.repoKey, b.number)}`,
    discriminator: b.code,
    prompt: refusedPrompt(b),
    causeKey: `${session}/pr-review-blocked/pr-${subjectRef(b.repoKey, b.number)}/${b.code}`,
  };
}

/**
 * THE FIRST FACT IS THE COMPARISON, and it decides what the rest means (#2084: #2049 sat seven hours on a
 * refusal posted at a head the author had already fixed). Three readings, and the third is not the first:
 * the refusal is at the current head, at an OLDER head, or the payload named no commit at all.
 * @param {{number: number, repo?: string, repoKey?: string, head?: string, refusedAt?: string | null, patchUnchanged?: boolean | null,
 *          refusalLifted?: boolean}} b
 */
function refusedPrompt(b) {
  const head = b.head ?? "";
  const short = (/** @type {string} */ oid) => oid.slice(0, 8);
  let fact;
  if (!b.refusedAt || !head) {
    fact = "The payload names no commit for the refusing review, or no head: read it with "
      + `\`gh api repos/${b.repo ?? REPO}/pulls/${b.number}/reviews\` and compare its \`commit_id\` against \`headRefOid\` `
      + "before doing anything.";
  } else if (b.refusedAt === head) {
    fact = `The refusal was posted AT the current head \`${short(head)}\`: it is live and the rework is yours.`;
  } else if (b.refusalLifted === true) {
    // a11ign#3199: A VERDICT IS VALID FOR A PATCH ON A BASE. The refusal was posted while a check failed, and none fails at this head, so what it
    // refused was not in the patch (a11ign#3154: a defect on `main`). There is no rework to do and nobody to do it: a fresh look is the only thing that lifts it.
    fact = `The refusal was posted at \`${short(b.refusedAt)}\` while a check was failing, and the head is now \`${short(head)}\` with none failing: `
      + "what it refused was not in this patch, so there is no rework to do. Only a newer review lifts it, so "
      + `ask \`${reviewerSeat(b)}\` for a fresh look at the head (\`pnpm run prompt:session ${reviewerSeat(b)} "${subjectMention(b)} ..."\`; `
      + "a QUEUED exit 2 is delivery, do not retry).";
  } else if (b.patchUnchanged === true) {
    // #3045: A HEAD WITH THE SAME PATCH IS THE SAME WORK. The refusal stands at it exactly as at the head it was posted at, so there is no
    // new work for `reviewer-<n>` to look at and nothing to ask for: the rework is the author's.
    fact = `The refusal was posted at \`${short(b.refusedAt)}\` and the head is now \`${short(head)}\`, but the PATCH is unchanged since: `
      + "what the review refused is still what this pull request does, so the refusal stands at the same work, the rework is yours, "
      + `and a re-ask of \`${reviewerSeat(b)}\` is not owed. Only a changed patch earns a fresh look.`;
  } else {
    fact = `The refusal was posted at \`${short(b.refusedAt)}\` and the head is now \`${short(head)}\`: `
      + "you pushed after it, and the refusal STILL STANDS. A push does not clear it; only a newer review "
      + `does, so ask \`${reviewerSeat(b)}\` for a fresh look at the head (\`pnpm run prompt:session `
      + `${reviewerSeat(b)} "${subjectMention(b)} ..."\`; a QUEUED exit 2 is delivery, do not retry).`;
  }
  const ownership = b.refusalLifted === true && b.refusedAt !== head
    ? "It carries your session label, so asking is yours."
    : "It carries your session label, so the rework is yours. Read what the review names and fix that. "
      + "If you believe the refusal is wrong, that is an escalation to `product-manager`, not a call you make here.";
  return `${subjectMention(b)} is green on every required check and NOT held, and a reviewer's `
    + "`CHANGES_REQUESTED` is holding it.\n"
    + `${fact}\n${ownership}`;
}

/**
 * The two jobs a `hold:` label turns red, and nothing else does: `deliberateRefusals` refuses a held pull
 * request on purpose (`merge-guard.mjs --ci-gate`, "IS HELD by ..."), and `gate` is red only because it
 * `needs` it. Named here rather than read off the job so the gate stays a script that runs before any build.
 */
export const HOLD_RED_JOBS = ["deliberateRefusals", "gate"];

/**
 * PURE. Is this pull request red ONLY because somebody holds it? A HOLD IS AN ANSWER (#2400), and it was read as an unanswered question.
 * #2376 carried `hold:product-manager` on purpose; the hold made `deliberateRefusals` red and `gate` with it, and the order asking
 * `product-manager` to fix the cause went to the very session that had placed the hold 35 times, each answered "nothing to fix".
 * `MAX_DELIVERIES` then labelled the PR `needs:chairman`, and clearing the label did not hold: the order was still emitted, so the count
 * stayed at the cap and the breaker re-added it (`escalateStuck` reads only what `deliver` sees, so an order never emitted can never
 * escalate -- which is why the fix is here and not in `wake.mjs`).
 *
 * WHO PLACED THE HOLD DOES NOT MATTER (#2993). #2400's clause 1 ("a hold by anyone else is not an answer from the session being asked") was
 * written for a hold the ADDRESSEE placed. For a hold the addressee is the SUBJECT of it was wrong: the order asks "fix your build", nothing in
 * the build is broken, and #2990's owner was asked five times at one head, each answered "no fix needed". So the question is `red-pr.mjs`'s
 * `isHeldRed`, the decider `org-health` already asks (#2956): at least one red check, every one of them the hold's own two jobs, and the PR
 * carries ANY `hold:*`. THE EXEMPTION ENDS WITH EITHER KEY: remove the hold or let a third job go red (a real `ts / run` failure under a
 * foreign hold still reaches its owner) and the order is emitted again, and the run of deliveries it earned while suppressed starts from
 * nothing (`endedRuns` writes `RESET` for the key that stopped being emitted).
 *
 * WHAT IT CANNOT SEE: `deliberateRefusals` also carries #549's `Closes` comparison, and a rollup names the JOB, not the step. A held PR whose
 * body ALSO declares the wrong `Closes` is red for two reasons and silent about one of them until the hold is released, when the refusal
 * reappears with nothing else red.
 *
 * @param {any} pr
 */
function redOnlyFromAHold(pr) {
  return isHeldRed(pr);
}

const MS_PER_MINUTE = 60_000;

/**
 * THE SESSION OF LAST RESORT FOR A RED PULL REQUEST (#2941). It can act: it holds the publish order, the rulings
 * and the freeze, and it is the one reader that may re-lane a PR to somebody. `product-manager` could not -- it
 * does not fix code, so every order that fell back to it was a turn spent finding out whose the PR was.
 */
export const UNOWNED_PR_SESSION = "ceo";

/**
 * WHERE A RED PULL REQUEST GOES WHEN ITS OWNER'S SESSION NO LONGER EXISTS (#3078). `ownerOfPr`'s `label` rung never outranks, so a
 * label naming a released session kept addressing the order to a workspace that was not there: `route` refused it on every tick
 * (30 ticks, 63 minutes, three PRs) and the PR it blocked held other rows out of the pool. `product-manager`, because the way out
 * is process -- put the label of a session that can on the PR -- and its brief already covers that. It is NOT `UNOWNED_PR_SESSION`:
 * that rung answers a PR nobody could name, and `ceo` is told so; here the order names the dead owner.
 */
export const DEAD_OWNER_FALLBACK = "product-manager";

/**
 * WHO A PULL REQUEST BELONGS TO, BY A TOTAL FUNCTION (#2941): every pull request has exactly one answer, and the
 * last rung is a session that can act. A NEW NAME on purpose -- `work-gate.mjs`'s `ownerOf(row)` answers a
 * different question (who a ROW is routed to).
 *
 * THE ORDER, and each rung reads a fact somebody else put on the PR object (`withPrOwners`), so this is pure:
 *   1. `label`        its own `session:` label. Never outranked -- except by the label itself being DEAD (#3093): a PR whose
 *                     `session:` label names a session recorded as ENDED (`withEndedLabels` puts `labelEnded` on it) is read
 *                     as unlabelled, because an order to a seat that is gone is refused on every tick, for ever.
 *   2. `closing-row`  the live session holding the one row it closes (#2882).
 *   3. `branch-row`   the live session holding the row its branch suffix `agent/<slug>-<n>` names (#2928).
 *   4. `branch-name`  a live session the head ref itself names: `agent/<session>` or a `worker-<n>` token.
 *   5. `stamp`        the live session that stamped the worktree the branch is checked out in (`.a11y-owner`).
 *   6. `ceo`          nobody could be named. Never `product-manager`.
 * "Live" in rungs 2-5 is the same test #2912 made: the session still HOLDS A CLAIM on an open row. `isLiveSession`
 * is not asked, so a live session holding NO claim is answered by `ceo`, which can act.
 *
 * @param {any} pr
 * @returns {{ session: string, source: "label" | "closing-row" | "branch-row" | "branch-name" | "stamp" | "ceo" }}
 */
export function ownerOfPr(pr) {
  const label = sessionOf(pr);
  if (label && !pr?.labelEnded) return { session: label, source: "label" };
  if (pr?.rowOwner) return { session: pr.rowOwner.session, source: pr.rowOwner.source === "branch" ? "branch-row" : "closing-row" };
  if (pr?.branchOwner) return { session: pr.branchOwner.session, source: "branch-name" };
  if (pr?.stampOwner) return { session: pr.stampOwner.session, source: "stamp" };
  return { session: UNOWNED_PR_SESSION, source: "ceo" };
}

/**
 * WHY NOBODY COULD BE NAMED, in the words of the `ceo` rung (#3093). A label that names an ENDED session is not "no session
 * label": saying so would send `ceo` looking for a label that is on the PR, and hide that the fix is to replace it.
 * @param {any} pr @param {string} unlabelled the clause for a PR that carries no label at all
 */
function nobodyBasis(pr, unlabelled) {
  if (!pr?.labelEnded) return unlabelled;
  return `its \`${SESSION_PREFIX}\` label names \`${sessionOf(pr)}\`, which has ENDED (absent from herdr, and a teardown recorded its ending), `
    + "and no live session holds a row it closes, its branch names or stamped its worktree";
}

/**
 * The sentence of `failingChecksPrompt` that says whose the fix is, and on whose authority.
 * @param {any} pr @param {{ blocking: any[], nowMs: number }} red
 */
function ownershipSentence(pr, { blocking, nowMs }) {
  const { source } = ownerOfPr(pr);
  const branch = `\`${pr.headRefName}\``;
  const sentences = {
    label: "It carries your session label, so it is yours to fix.",
    "closing-row": `It carries no session label, but the row it closes (#${pr?.rowOwner?.row}) is held by you, so it is yours to fix.`,
    "branch-row": `It carries no session label and closes no row you hold, but its branch ${branch} was claimed for row #${pr?.rowOwner?.row}, which is held by you, so it is yours to fix.`,
    "branch-name": `It carries no session label and closes no row you hold, but its branch ${branch} names you, so it is yours to fix.`,
    stamp: `It carries no session label and closes no row you hold, but the worktree its branch ${branch} is checked out in was stamped by you, so it is yours to fix.`,
    ceo: unownedSentence(pr, { blocking, nowMs }),
  };
  return sentences[source];
}

/**
 * THE LAST RUNG'S WORDS: the PR number, the red checks and how long they have been red, because nothing else
 * names the PR to a session that was handed it with no history.
 * @param {any} pr @param {{ blocking: any[], nowMs: number }} red
 */
function unownedSentence(pr, { blocking, nowMs }) {
  const names = blocking.filter((c) => checksSettledGreen([c]) === false).map((c) => String(c?.name ?? c?.context)).join(", ");
  const started = failingRunStartedAt(blocking);
  const age = started === null ? "for an UNKNOWN time (no check carried a start time)"
    : `since ${started} (${Math.max(0, Math.round((nowMs - Date.parse(started)) / MS_PER_MINUTE))} min ago)`;
  const basis = nobodyBasis(pr, `no session label, no live session holding a row it closes or its branch \`${pr.headRefName}\` names, and no live session stamped its worktree`);
  return `NOBODY COULD BE NAMED as its owner: ${basis}. You are the last answer, so it is yours to route. ${subjectMention(pr)} is red on ${names || "an unnamed check"} ${age}. `
    + `Re-lane it to the session that should fix it (\`${SESSION_PREFIX}<name>\` on the PR), or close it if it is abandoned.`;
}

/**
 * A pull request whose checks have SETTLED RED, and nobody is fixing it.
 *
 * THE THIRD BLIND SPOT, and the one where work actually dies. Found 2026-09-17 by the chairman looking at
 * a queue the gate called quiet: #1650 sat `mergeStateStatus: BLOCKED` on a failing `changeset` check --
 * a trivial, entirely fixable process failure -- while `worker-capture`, the session named on its own
 * label, sat idle. The gate asked whether a draft needed a verdict and whether a row needed claiming, and
 * both were honestly no. A red build is neither, so nothing asked about it and nothing ever would have.
 *
 * `checksSettledGreen` already answered this: `false` means SETTLED AND RED, distinct from `null` for
 * still-running. Reading only `=== true` and discarding `false` threw the answer away, the same shape as
 * the verdict bug one function below.
 *
 * DRAFTS COUNT TOO. A red draft is not "not ready yet" -- it is a branch whose author stopped, and it
 * will never earn a verdict because the reviewer lane requires green.
 *
 * THE PROMPT CARRIES A FACT AND MAKES NO JUDGMENT (#2117). `baseTip` changes only the words -- never
 * whether the order is sent, to whom, or under which key -- so it can excuse no genuine red. See
 * `failingChecksPrompt`.
 *
 * A RED PULL REQUEST THAT ALSO CONFLICTS IS A NEW CAUSE, THOUGH THE HEAD HAS NOT MOVED (#3005). `stallReasonOf` puts `red`
 * before `conflicted`, so such a PR is ordered here alone; and a branch that conflicts gets no `pull_request` run, so
 * the red stays on the head while the real work turns from "fix the check" into "rebase". #2990 sat 63 minutes at
 * one key, delivered six times, with its owner never told. `/conflicting` is therefore part of the key: a
 * conflict-free red PR keeps its key byte for byte, and red-to-conflicted restarts the count.
 *
 * @param {any} pr @param {string[] | null} [required] @param {{sha: string, date: string} | null} [baseTip]
 */
function failingChecksOrder(pr, required = null, baseTip = null) {
  // ONLY A CHECK THAT CAN HOLD THE PULL REQUEST COUNTS AS RED. A settled-red job outside the required
  // set is a real failure and somebody's problem -- it is not THIS pull request being blocked, and
  // waking its session to "fix the cause on that branch" is a prompt spent on a PR that merges anyway.
  const onHead = newestPerName(pr.statusCheckRollup ?? []);
  const blocking = blockingChecks(onHead, required);
  if (checksSettledGreen(blocking) !== false) return null;
  if (redOnlyBySupersededRun(blocking, onHead)) return null;
  const head = String(pr.headRefOid ?? "");
  if (!head) return null;
  const head8 = head.slice(0, 8);
  // `ownerOfPr` IS TOTAL (#2941): an unlabelled red PR is still a stalled PR, and its last answer is a session that can act.
  const { session } = ownerOfPr(pr);
  if (redOnlyFromAHold(pr)) return null;
  const conflicting = conflictStateOf(pr) === CONFLICT_STATE.CONFLICTING;
  return {
    session,
    ...(session === DEAD_OWNER_FALLBACK ? {}
      : { fallback: DEAD_OWNER_FALLBACK, fallbackOnlyIfAbsent: true, fallbackPrompt: deadOwnerPrompt({ pr, head8, session, conflicting }) }),
    cause: "pr-checks-failing",
    subject: `pr-${subjectRef(pr.repoKey, pr.number)}`,
    discriminator: head8,
    prompt: failingChecksPrompt({ pr, head8, blocking, baseTip, conflicting, nowMs: Date.now() }),
    causeKey: `${session}/pr-checks-failing/pr-${subjectRef(pr.repoKey, pr.number)}/${head8}${conflicting ? "/conflicting" : ""}`,
  };
}

/**
 * The words the FALLBACK is typed instead of the owner's (#3078): `wake.mjs` swaps this in for `prompt` only when the order is
 * delivered to {@link DEAD_OWNER_FALLBACK}. The owner's `prompt` reads as though its addressee were alive and says "yours to fix",
 * which would send the fallback to fix code it does not own; so this one says the session is gone and what the receiver does.
 * @param {{pr: any, head8: string, session: string, conflicting: boolean}} facts
 */
function deadOwnerPrompt({ pr, head8, session, conflicting }) {
  return `${subjectMention(pr)} at \`${head8}\` has FAILING checks${conflicting ? " and also CONFLICTS with `main`" : ""}, and the session that owns it, `
    + `\`${session}\`, NO LONGER EXISTS (no workspace carries that label), so nobody is fixing it and this order reached you instead. The fix is NOT yours. `
    + `Read why it is red (\`gh pr checks\` on it) and re-lane it by putting the label of a session that can fix it (\`${SESSION_PREFIX}<name>\`) on the pull request, `
    + "or close it if it is abandoned. A red pull request whose owner is gone keeps other rows out of the pool until someone does.";
}

/**
 * FIRST THING TO DO for a red pull request that also conflicts: a conflicting branch gets no `pull_request` run, so
 * the red on its head is the last run's and nothing will re-test it until the branch is rebased (#3005).
 */
const CONFLICTING_RED_SENTENCE = "IT ALSO CONFLICTS with `main` (GitHub reports it cannot merge), and a branch that conflicts gets no "
  + "`pull_request` run, so the red below is stale and will not clear by itself: FIRST merge or rebase `main` into the branch, "
  + "resolve the conflicts and push, then read what is red on the new run. ";

/**
 * The words of a `pr-checks-failing` order: when the failing run started, whether `main` has moved since,
 * and the question that decides the fix (#2117).
 *
 * TWO REGIMES WITH OPPOSITE REMEDIES, and this prompt names both and picks neither. A run that tested a
 * `main` since fixed (its merge ref computed against the old one) needs a PUSH or `update-branch` --
 * `gh run rerun` reuses the same merge ref and cannot clear it. A run that could not ASK (the rate-limit
 * `arm` regime) needs `gh run rerun`, and there is nothing to push. Same red; what tells them apart is
 * whether the failing assertion names a defect or a refusal. #2087 (2026-09-23) cost two sessions a cycle
 * each, and they reached opposite readings of one PR.
 *
 * @param {{pr: any, head8: string, blocking: any[], baseTip: {sha: string, date: string} | null, conflicting: boolean, nowMs: number}} facts
 */
function failingChecksPrompt({ pr, head8, blocking, baseTip, conflicting, nowMs }) {
  return `${subjectMention(pr)} at \`${head8}\` has FAILING checks and is blocked. `
    + (conflicting ? CONFLICTING_RED_SENTENCE : "")
    + `${ownershipSentence(pr, { blocking, nowMs })} `
    + `${baseMovedSentence(failingRunStartedAt(blocking), baseTip)} `
    + "WHICH FIX is decided by what the failing assertion names, and this order does not choose: "
    + "(a) a real defect on your branch -- fix it and push; "
    + "(b) a run that tested a `main` since fixed (a stale merge ref) -- a PUSH or `update-branch`, because "
    + "`gh run rerun` reuses the same merge ref and cannot clear it; "
    + "(c) a check that could not ASK (a rate-limit or other refusal, no defect at all) -- `gh run rerun`, "
    + "there is nothing to push. Read the failing job to see which.";
}

/**
 * When the newest failing blocking check started, or `null`. THE LATEST, not the earliest: "main moved
 * since" is then true of EVERY red check, so the sentence never overstates. `checksSettledGreen([c])`
 * is `false` for exactly the settled-red ones.
 *
 * @param {any[]} blocking
 * @returns {string | null}
 */
function failingRunStartedAt(blocking) {
  const started = blocking.filter((c) => checksSettledGreen([c]) === false)
    .map((c) => String(c?.startedAt ?? "")).filter((t) => Number.isFinite(Date.parse(t)));
  return started.sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? null;
}

/**
 * The one sentence of fact. Three unknowns stay UNKNOWN rather than collapsing to "has not moved": absence
 * of a start time or of a tip is not evidence that `main` stood still.
 *
 * @param {string | null} startedAt @param {{sha: string, date: string} | null} baseTip
 */
function baseMovedSentence(startedAt, baseTip) {
  if (startedAt === null) {
    return "The failing check carried no start time, so whether `main` has moved since it ran is UNKNOWN.";
  }
  if (baseTip === null) {
    return `The failing run started at ${startedAt}. Whether \`main\` has moved since was NOT READ this tick, `
      + "so it is UNKNOWN, not \"no\".";
  }
  const tip = `\`main\`'s tip \`${baseTip.sha.slice(0, 8)}\` is dated ${baseTip.date}`;
  return Date.parse(baseTip.date) > Date.parse(startedAt)
    ? `The failing run started at ${startedAt}; \`main\` has MOVED since (${tip}, after that start), so the `
      + "run may have tested a `main` that no longer exists."
    : `The failing run started at ${startedAt}; \`main\` has NOT moved since (${tip}, no later than that start).`;
}

/**
 * The rework a REFUSED verdict deserves, addressed to whoever holds the pull request.
 *
 * THE GATE ALREADY HOLDS THE LABEL IT WAS ASKING SOMEBODY ELSE TO GO AND READ. This order used to name
 * `product-manager` unconditionally and then tell it to "route the rework to the session holding that
 * row" -- a lookup `sessionOf` performs here, for free, at the moment the order is built, with the whole
 * latency of a second session's turn spent on it. `failingChecksOrder` forty lines up has always done it
 * the other way, and for the same reason. Measured 2026-09-22: 108 UNDELIVERED `product-manager` orders
 * in 90 minutes, and the refusal on #1957 named a surviving mutant at a `file:line` -- there was nothing
 * in it to adjudicate (#2001).
 *
 * THE CAUSEKEY MOVES WITH THE SESSION, and that is the half of this worth a test. `causeKey` is the wake
 * ledger's dedupe key; a hard-coded `product-manager/` prefix in front of a session that now varies keys
 * two different sessions' orders to the same string, so the second one is swallowed as a repeat.
 *
 * THE DECISION SEAM IS KEPT RATHER THAN REMOVED, which is why the prompt branches instead of only the
 * address. Asking an author to "decide whether it stands" is asking them to adjudicate a refusal of their
 * own work; so with an owner, REWORK is the default and a DISPUTE is the escalation, and the escalation
 * goes back to `product-manager` exactly as before. With no `session:` label both the lookup and the
 * decision are genuinely `product-manager`'s, and that prompt is unchanged.
 *
 * @param {any} pr @param {{verdict: string | null, by: string | null,
 *        byIsAuthor: boolean | null}} found @param {ReviewHeads} heads
 */
function notConvincedOrder(pr, found, { head8, key }) {
  const { session, source } = ownerOfPr(pr);
  const from = found.by ? ` from ${found.by}` : "";
  const verdict = `${subjectMention(pr)} at \`${head8}\` carries a NOT CONVINCED verdict${from}`;
  const prompt = source === "ceo"
    ? `${verdict} and NOBODY COULD BE NAMED as its owner (${nobodyBasis(pr, "no session label, no live session holding a row it closes, its branch names or stamped its worktree")}). You are the last answer: read the verdict, route the rework to the `
      + `session that should do it (\`${SESSION_PREFIX}<name>\` on the PR), or close the PR if the work was abandoned.`
    : `${verdict} and ${notConvincedBasis(pr, source)}, `
      + "so the rework is yours. Read the verdict, fix what it names on that branch and push. If "
      + "you believe the verdict is wrong, that is a DISPUTE rather than rework: say so on the PR and "
      + "product-manager decides.";
  return {
    session,
    cause: "verdict-not-convinced",
    subject: `pr-${subjectRef(pr.repoKey, pr.number)}`,
    discriminator: key,
    prompt,
    causeKey: `${session}/verdict-not-convinced/pr-${subjectRef(pr.repoKey, pr.number)}/${key}`,
  };
}

/**
 * Why the NOT CONVINCED rework is this session's, in the clause `notConvincedOrder` splices in.
 * @param {any} pr @param {string} source one of `ownerOfPr`'s sources but `ceo`
 */
function notConvincedBasis(pr, source) {
  if (source === "label") return "it carries your session label";
  if (source === "closing-row") return `the row it closes (#${pr?.rowOwner?.row}) is held by you`;
  if (source === "branch-row") return `its branch \`${pr.headRefName}\` was claimed for row #${pr?.rowOwner?.row}, which is held by you`;
  if (source === "branch-name") return `its branch \`${pr.headRefName}\` names you`;
  return `the worktree its branch \`${pr.headRefName}\` is checked out in was stamped by you`;
}

/**
 * Whether a review APPROVED this pull request at the head a verdict may sit at: `true`, `false`, or `null`
 * when the payload never carried `reviews` -- unread, which is NOT "no review" (`readPrs`'s rule, #1286: a
 * missing field never becomes an order). `reviewDecision` IS NOT READ HERE, deliberately (reviewer-2 on #2388):
 * it is PULL-REQUEST-WIDE, and `main` keeps an approval posted at an older head, so it can say APPROVED while
 * nothing approves THIS one -- `reviewStateOf` documents that it is no statement about the head. Reading it
 * as an answer would silence the order for exactly a stale approval, so the answer comes from the reviews'
 * own commit oids. (`pr-review-blocked` keeps reading the field; the two ask different questions.)
 *
 * ANY head with the same patch counts, not only the current one: an approval at an earlier head is the same
 * work as the head after an update-branch or a rebase, exactly as `verdictAmong` treats a verdict (#3045).
 * @param {any} pr @param {string[]} heads @returns {boolean | null}
 */
function approvedAtHead(pr, heads) {
  if (!Array.isArray(pr.reviews)) return null;
  return pr.reviews.some((/** @type {any} */ r) =>
    r?.state === "APPROVED" && heads.includes(String(r?.commit?.oid ?? "")));
}

/**
 * #2365: A CONVINCED VERDICT THAT IS ONLY A COMMENT, on a pull request that is not a draft.
 *
 * THE QUESTION `settledVerdictOrder` NEVER ASKED. It answered "is a draft convinced" and returned `null` for
 * a ready pull request, correctly for "flip it ready" -- so a verdict posted as a COMMENT with no review at
 * that head was invisible, and GitHub's `reviewDecision` stayed `REVIEW_REQUIRED` with nothing to say why.
 * Measured 2026-09-24 on #2337: `reviewer-2`'s *convinced (provisional)* at 14:02Z, `/reviews` empty, held
 * until somebody read it by hand. `ceo`'s ruling on #928: the reviewer's typo is not the remedy, the STATE is
 * a gate question. (The comment existed because `pr-review-verdict.sh` refused a malformed first line AFTER
 * `gh pr comment` had posted.)
 *
 * TO THE PARITY REVIEWER, NOT `product-manager`, and that is the difference from `pr-review-blocked`: that
 * order says "nobody has approved" for a SET; this one names a single comment and a remedy that is not a new
 * review round -- re-post it through `pr-review-verdict`.
 *
 * WHICH CAUSE WINS WHEN BOTH APPLY: a DRAFT is `draft-convinced-not-ready`'s, whose next act (flip it ready)
 * comes first, and this function returns `null` for one. Once flipped, the next tick asks this question.
 *
 * NOT HELD, and green (`draftOrder` has already required green): a held pull request is not merging BY
 * DECISION, so an approval nobody wants yet is no defect. Keyed on the AUTHORED head, so update-branch does
 * not re-fire it.
 *
 * @param {any} pr @param {{verdict: string | null, by: string | null, byIsAuthor: boolean | null}} found
 * @param {ReviewHeads} heads
 */
function unreviewedConvincedOrder(pr, found, heads) {
  if (pr.isDraft) return null;
  if (!armabilityOf({ labels: labelsOf(pr) }).arm) return null;
  if (approvedAtHead(pr, heads.all ?? []) !== false) return null;
  const { head8, key } = heads;
  const session = reviewerSeat(pr);
  const authored = found.byIsAuthor === true
    ? " That comment is signed by the pull request's own author, so it is not a review of anything: "
      + "review the change first, and post the approval only if it stands."
    : "";
  return {
    session,
    cause: "verdict-comment-unreviewed",
    subject: `pr-${subjectRef(pr.repoKey, pr.number)}`,
    discriminator: key,
    prompt: `Ready ${subjectMention(pr)} at \`${head8}\` is green and carries a CONVINCED verdict`
      + `${found.by ? ` from ${found.by}` : ""} as a COMMENT, and no APPROVED review at that head -- `
      + "so GitHub's `reviewDecision` is not APPROVED and it cannot merge. The comment did not become a "
      + `review. Post the approving review with \`${REVIEWER_DOOR}\` at the CURRENT head; its first line `
      + `must begin "**Review of #${pr.number} at " or the script refuses (after any comment was posted). `
      + "This is not a new review round: if your verdict stands, re-post it; do not re-read the diff."
      + authored,
    causeKey: `${session}/verdict-comment-unreviewed/pr-${subjectRef(pr.repoKey, pr.number)}/${key}`,
  };
}

/**
 * #3215: THE READY-FLIP THE GATE WITHHOLDS, TOLD TO THE AUTHOR AND NOT TO `product-manager`. A pull request is marked ready only on a
 * green verify stamp for its head and body (`verify-stamp.mjs`), and this is the draft that has everything else: settled green and a
 * convinced verdict at this head from somebody who is not its author. It carries NO `action`, so `performActions` has no `gh pr ready`
 * to run, and it is addressed to `ownerOfPr` because the fix -- `pnpm run verify` in their own worktree -- is theirs, and
 * `product-manager` holds no worktree to run it in.
 *
 * THE KEY NAMES THE PATCH AND NOT THE REASONS, so a tick that finds the same missing stamp builds a byte-identical order and the waker's
 * ledger delivers it ONCE, and a reason that changes between ticks (stale, then a failed step) does not wake the author again. A new
 * patch is new work and is told again. When the author verifies, the next tick's order is `settledVerdictOrder`'s own, with its action.
 *
 * `pr.verifyStamp` is stamped by the caller; ABSENT IS NOT RED, so a pull request nobody read, and a project with no verify script
 * (`no-verify`, stamped by name), keep the action they always had.
 * @param {any} pr @param {{by: string | null}} found @param {ReviewHeads} heads
 */
function unverifiedReadyOrder(pr, found, { head8, key }) {
  const owner = ownerOfPr(pr);
  const reasons = pr.verifyStamp.reasons.join("; ");
  return {
    session: owner.session,
    cause: "draft-convinced-not-ready",
    subject: `pr-${subjectRef(pr.repoKey, pr.number)}`,
    discriminator: key,
    prompt: `Draft ${subjectMention(pr)} at \`${head8}\` is green and carries a CONVINCED verdict${found.by ? ` from ${found.by}` : ""}, and the gate `
      + `WILL NOT mark it ready: verify is not green for this head and body -- ${reasons}. Run \`pnpm run verify -- --draft-body=<the body file>\` in your `
      + "worktree, which stamps this head and this body; the next tick then marks it ready. A push or an edit of the body after the stamp makes it stale, "
      + `so the thing marked ready is the thing that was verified. ${ownershipOf(pr, owner.source, "verify")}`,
    causeKey: `${owner.session}/draft-convinced-not-ready/pr-${subjectRef(pr.repoKey, pr.number)}/${key}/no-green-stamp`,
  };
}

/**
 * #3448: DOES THE VERIFY STAMP STILL WITHHOLD THE READY-FLIP? Only a RED stamp withholds it, and not when the project's own CI has already
 * said what verify would: every REQUIRED check settled green at the head this verdict stands for. A stamp is a worktree's reading, and the
 * gate reads it on the host that holds the author's worktree; a draft whose author works elsewhere is stamped RED ("no worktree ... is at
 * head") for ever, so the order to the author was an order nobody could obey. Measured 2026-10-04: #3406 sat green, approved and a draft
 * for hours behind `orchestrator`, whose seat was busy.
 *
 * THE LIST MUST HAVE BEEN READ (`required !== null`). `null` is "could not read", and `blockingChecks` then counts EVERY check, which is the
 * fail-open reading of a question this one answers the other way: green on checks nobody said were required is not green on the ones that
 * are. So an unread list leaves the stamp the rule, exactly as before. `settledChecksOf` is `null` for no required check on the head, or one
 * still running, and `false` for a red one, so each of those withholds. The rollup is the CURRENT head's by construction, so checks green
 * only at an older head never reach it.
 *
 * `pr-open` is unchanged: a pull request is still never OPENED ready without a green stamp.
 * @param {any} pr @param {string[] | null} required
 */
function stampWithholdsReady(pr, required) {
  if (pr.verifyStamp?.state !== VERIFY_STATE.RED) return false;
  return required === null || settledChecksOf(pr, required) !== true;
}

/**
 * The follow-up a SETTLED verdict deserves, or `null` when it deserves none.
 *
 * A VERDICT IS NOT THE END OF THE WORK, AND READING IT AS ONE LEFT PULL REQUESTS ABANDONED. The gate used
 * to say `if (found.verdict !== null) continue;` -- a verdict existed, so it moved on WITHOUT EVER ASKING
 * WHAT IT SAID. Measured 2026-09-17, hours after the tick went live: #1640 and #1634 had been green,
 * reviewed and CONVINCED AT HEAD since 2026-09-14 and were still drafts, and the gate called that a quiet
 * org for three days. `agent-practices.md` says a product PR "is marked ready only when the reviewer
 * writes convinced"; nothing asked whether that had been ACTED ON.
 *
 * `draft-convinced-not-ready` GOES TO `product-manager`, whose brief names exactly this work: first
 * reader for "the queue and process ... promotions, claim reports, merge close-outs". The PR's author
 * cannot be read off the author field -- every PR here is opened by the shared `a11ign-ai-workers`
 * account -- and the gate performs that flip itself anyway, so its order is a fallback and a fallback
 * landing on the queue's first reader is defensible (#2001 deliberately left this one alone).
 * `verdict-not-convinced` no longer does: see `notConvincedOrder`.
 *
 * `draft-convinced-not-ready` IS THE ONE REVIEW CAUSE THAT STAYS DRAFT-ONLY (#2176): it is about flipping a
 * draft ready. A convinced verdict on a pull request that is already ready asks nothing of anybody -- UNLESS
 * it is only a comment (#2365), which `unreviewedConvincedOrder` asks about. `not-convinced` applies to both,
 * because rework is owed whatever state the pull request is in.
 *
 * @param {any} pr @param {{verdict: string | null, by: string | null,
 *        byIsAuthor: boolean | null}} found @param {ReviewHeads} heads @param {string[] | null} [required]
 */
function settledVerdictOrder(pr, found, heads, required = null) {
  const { head8, key } = heads;
  if (found.verdict === "convinced" && pr.isDraft) {
    if (found.byIsAuthor === false && stampWithholdsReady(pr, required)) return unverifiedReadyOrder(pr, found, heads);
    return {
      session: "product-manager",
      cause: "draft-convinced-not-ready",
      subject: `pr-${subjectRef(pr.repoKey, pr.number)}`,
      discriminator: key,
      prompt: `Draft ${subjectMention(pr)} at \`${head8}\` is green and carries a CONVINCED verdict`
        + `${found.by ? ` from ${found.by}` : ""}, and is still a draft. Per agent-practices a product `
        + "PR is marked ready once the reviewer is convinced. Mark it ready for review, or say on the PR "
        + "why it must stay a draft -- an unexplained convinced draft is work nobody is finishing.",
      causeKey: `product-manager/draft-convinced-not-ready/pr-${subjectRef(pr.repoKey, pr.number)}/${key}`,
      // THE GATE ALREADY KNOWS THE ANSWER, SO IT DOES THIS ONE ITSELF (see `performActions`). Every
      // condition for a safe ready-flip has been checked by the time we are here: not red, still a
      // draft, checks SETTLED green, and a convinced verdict AT THIS HEAD. The order stays attached as
      // the FALLBACK -- if `gh pr ready` fails, `product-manager` is woken exactly as before.
      //
      // `byIsAuthor === false` AND NOT `!== true`, deliberately. `verdictAtHead` returns `null` when the
      // opener named nobody (#1244) and refuses to guess, and a self-signed or unattributed verdict is
      // the one case where a human should look. Automating the attributed case and waking on the rest
      // keeps `ceo`'s one-in-five spot-check pointed at the verdicts that can actually be wrong.
      ...(found.byIsAuthor === false ? { action: { kind: "ready", pr: Number(pr.number), ...(pr.repo === undefined ? {} : { repo: pr.repo }) } } : {}),
      // #3465: THE SAME CONDITION DECLARES THE ORDER RE-LANEABLE, and for the same reason: an attributed verdict by someone who is not the author is a
      // finishing act ANY session can carry out, so a `product-manager` busy past the bound (#3448) does not hold it. A self-signed or unattributed
      // verdict is the one a human should look at (above), and re-laning it to whichever engineer is idle would hand that look to the wrong reader.
      ...(found.byIsAuthor === false ? { mayRelane: true } : {}),
    };
  }
  if (found.verdict === "convinced") return unreviewedConvincedOrder(pr, found, heads);
  if (found.verdict === "not-convinced") return notConvincedOrder(pr, found, heads);
  // Any other settled verdict -- `unrecognised`, or one the opener did not attribute -- is left alone:
  // re-prompting a reviewer who has already answered costs more than waiting for a human to look.
  return null;
}

/**
 * @typedef {{head8: string, key: string, all: string[], wait: "settled" | "running"}} ReviewHeads
 * `head8` is the head a reviewer would be reading; `key` is what the ORDER is keyed on -- the first eight characters of the PATCH id
 * (#3045), so an update-branch, a rebase or an amend, which make a new head with the same work, keep the key. It is `head8` only when
 * the patch could not be read. `all` is every full head whose patch equals the current head's, current first (`equivalentHeads`). `wait` is
 * `reviewWait`'s: `running` is a head whose checks an update-branch restarted, kept in the question because it adds no work.
 */

/**
 * The key a pull request's review orders carry, and the heads a verdict may sit at (#3045). A VERDICT IS VALID FOR A PATCH, NOT A SHA:
 * `key` is the patch id when `withPatchIds` read it and the head otherwise, which is this gate's behaviour before #2176.
 * @param {any} pr @param {string} head @param {"settled" | "running"} wait
 * @returns {ReviewHeads}
 */
function reviewHeadsOf(pr, head, wait) {
  const patch = pr?.patchIds?.[head];
  return { head8: head.slice(0, 8), key: typeof patch === "string" ? patch.slice(0, 8) : head.slice(0, 8), all: equivalentHeads(pr), wait };
}

/**
 * The wording of the re-review order, TRUE OF WHICHEVER STATE THE PULL REQUEST IS IN (#2176). It used to
 * say "Draft" unconditionally, which is a false statement to a reviewer about the ready pull request this
 * cause now reaches.
 * @param {any} pr @param {ReviewHeads} heads
 */
function awaitingVerdictPrompt(pr, { head8, key, all, wait }) {
  const state = pr.isDraft ? "Draft" : "Ready (not a draft)";
  const checks = wait === "settled" ? "has settled green checks and no verdict at that head"
    : "has no verdict at that head, and its checks are re-running on a head that adds no work to the one before it";
  const same = all.length > 1
    ? ` Its patch (\`${key}\`) is the same at ${all.length} heads: a verdict at any of them stands, `
      + "so write yours at the head you actually read and do not re-review work you have already answered."
    : "";
  return `${state} ${subjectMention(pr)} at \`${head8}\` ${checks}.${same} `
    + "Review it per .agent-org/roles/reviewer.md and leave one comment carrying your verdict.";
}

/**
 * The head of a pull request whose checks are RUNNING when it adds no work to its predecessor, else `null` (#3045). Both patch ids must
 * have been read (`withPatchIds` reads them for a running head only): an unread patch is not an equal one, so a refused read falls back to
 * asking nothing until the checks settle, which is what this gate did before.
 * @param {any} pr @param {"settled" | "running" | null} wait @returns {string | null}
 */
function unchangedRunningHead(pr, wait) {
  return wait === "running" && equivalentHeads(pr).length > 1 ? String(pr.headRefOid) : null;
}

/**
 * The one order this pull request deserves right now, or `null`.
 *
 * SPLIT OUT OF `decide` when the two stalled-work causes took it past `complexity` 15 and
 * `local/max-physical-lines-per-function` 90 and the pre-push gate refused it. The split is the honest
 * one rather than a line-count trick: this asks "what does THIS pull request need" and `decide` asks
 * "what does the whole queue need". AT MOST ONE order, because a pull request in two states at once
 * would be a contradiction rather than two jobs.
 *
 * THE REVIEW QUESTION IS ASKED OF EVERY GREEN PULL REQUEST, DRAFT OR NOT (#2176). It used to sit below
 * `if (!pr?.isDraft) return null`, so a pull request that opened READY -- which `agent-practices.md` says
 * docs-and-tests PRs do -- was invisible to review routing: #2104 sat `CHANGES_REQUESTED` and green for
 * 5h47m while 171 other pull requests were ordered about. The draft-only test now lives where it belongs,
 * on `draft-convinced-not-ready` in `settledVerdictOrder`.
 *
 * KEYED ON THE PATCH, NOT THE HEAD (#3045), because `causeKey` moves with the head and an update-branch, a rebase and an amend are each a
 * new head with no new work: extending the read alone would have turned #2104 into a reviewer order every ten minutes. The heads are
 * the same work when `git patch-id`-equivalent diffs say so (`withPatchIds` reads them, `equivalentHeads` compares them) -- not when a
 * headline says "Merge branch 'main'", which could not see a conflict resolved by hand and could not see a rebase.
 *
 * A HEAD WHOSE CHECKS ARE RE-RUNNING STAYS IN THE QUESTION WHEN IT ADDS NO WORK, and is asked of nobody else: dropping the order for
 * the minutes CI takes is what wrote a `RESET` and re-armed it after each of #3033's four merges. Only `draft-awaiting-verdict` is
 * emitted from that state -- a settled verdict's follow-ups, `draft-convinced-not-ready`'s ready-flip above all, wait for settled checks.
 *
 * @param {any} pr @param {string[] | null} [required] @param {{sha: string, date: string} | null} [baseTip]
 */
function draftOrder(pr, required = null, baseTip = null) {
  // RED FIRST, and before the green check: a red PR is work whether or not it is a draft, and it can
  // never reach the reviewer lane below, which requires green.
  const red = failingChecksOrder(pr, required, baseTip);
  if (red) return red;
  const wait = reviewWait(pr, required);
  const head = wait === "settled" ? reviewableHead(pr, required) : unchangedRunningHead(pr, wait);
  if (!head || !wait) return null;
  const heads = reviewHeadsOf(pr, head, wait);
  const found = verdictAmong(pr, heads.all);
  // A VERDICT THE OPENER DID NOT ATTRIBUTE COUNTS AS SETTLED, and that is the wake side's default rather
  // than a reading of the comment: `verdictAtHead` returns `byIsAuthor: null` for it and refuses to guess
  // (#1244). Waking anyway would re-prompt a reviewer who has already answered; the cost of being wrong
  // the other way is one author-written verdict going unchallenged, which `ceo`'s spot-check of one
  // verdict in five is the control for.
  if (found.verdict !== null) return wait === "settled" ? settledVerdictOrder(pr, found, heads, required) : null;
  // #2416: A PULL REQUEST WAITING FOR AN EXTERNAL RUN IS NOT ASKED FOR A VERDICT, and this is the gate's half of
  // the two routes into a review (the author's is a sentence in `org-routing-and-timers.md`). It sits AFTER
  // the settled-verdict read on purpose: a verdict somebody prompted by hand is still read and acted on, so
  // the label removes the MACHINERY's order and never the reviewer's ability to answer, and it sits after the
  // red-checks order because a red build is the author's work whether or not evidence is pending.
  if (awaitingEvidence(pr)) return null;
  // #3476: A PULL REQUEST THAT CONFLICTS WITH ITS BASE IS NOT ASKED FOR A FIRST LOOK. Its next move is the rebase, which
  // `pr-merge-conflict` orders the owner to make and which changes the head, so a verdict now is paid for and then outlived:
  // #148 was approved 7m42s after #145 made it DIRTY, at a head the rebase replaced. It sits AFTER the settled-verdict read on
  // purpose, as `awaitingEvidence` does: a verdict already given (rework owed, a convinced draft not yet ready) is still acted on,
  // and only the REQUEST is withheld. After the rebase the head is new, `reviewHeadsOf` keys a new discriminator, and the review is
  // asked once, at the head that can merge. `UNREAD` is not `CONFLICTING`: an unknown state is never an accusation.
  if (conflictStateOf(pr) === CONFLICT_STATE.CONFLICTING) return null;

  // PULL REQUEST n IS `reviewer-<n>`'S (#2401; the odd/even split it replaced is retired). The name is
  // herdr's, and `wake.mjs` starts the instance when none is live. The arithmetic lives in
  // `review-attribution.mjs`, beside the reader that checks whether a posted review obeyed it -- a
  // detector with its own copy would agree with a router that had drifted.
  const session = reviewerSeat(pr);
  return {
    session,
    cause: "draft-awaiting-verdict",
    subject: `pr-${subjectRef(pr.repoKey, pr.number)}`,
    discriminator: heads.key,
    prompt: awaitingVerdictPrompt(pr, heads),
    causeKey: `${session}/draft-awaiting-verdict/pr-${subjectRef(pr.repoKey, pr.number)}/${heads.key}`,
  };
}

/**
 * Every order the open pull requests earn: each one's own (`draftOrder`), the checkless ones (#3092), the later one of each pair that
 * changes one file (#3480), then the set-wide one for labelled pull requests nobody has explained (#2416).
 * @param {any[]} prs @param {string[] | null} required @param {any} [baseTip] @param {number} [nowMs] omitted is `Date.now()`
 */
export function perPullRequestOrders(prs, required, baseTip, nowMs) {
  const own = prs.map((pr) => draftOrder(pr, required, baseTip)).filter((o) => o !== null);
  return [...own, ...checklessPrOrders(prs, nowMs), ...sharedFileOrders(prs), ...awaitingEvidenceStaleOrders(prs)];
}

/**
 * #3092: HOW LONG A PULL REQUEST MAY SIT WITH NO CHECKS AT ALL before its owner is told. A real run appears within a minute of a
 * push, so this is not a race with CI; it is long enough that a quiet PR is a PR no workflow is coming for.
 */
export const CHECKLESS_QUIET_MINUTES = 30;

/**
 * PURE. #3092: THE PULL REQUESTS WHOSE ROLLUP IS EMPTY, QUIET FOR `CHECKLESS_QUIET_MINUTES`, AND NOT CONFLICTING -- the ones no other
 * order can ever reach. `reviewableHead` asks for a SETTLED GREEN head and reads an empty rollup as `null` ("not knowable yet"), so
 * `draftOrder` emitted nothing, `failingChecksOrder` needs red, and `stallReasonOf` files it `progressing`: nobody was ever told.
 * Measured on a11ign/agent-org#58 (2026-10-02/03): opened on #56's branch, so `ci.yml` (`pull_request` on `branches: [main]`) never ran;
 * #56 merged, GitHub retargeted it to `main` -- an `edited` event, not a default trigger -- and it sat REVIEW_REQUIRED with 0 checks.
 *
 * A CONFLICTING PULL REQUEST IS LEFT TO `pr-merge-conflict`, whose order says the same thing in better words (a conflicting branch gets no
 * `pull_request` run, so the rebase it asks for is also what starts CI). ABSENT IS NOT EMPTY: an unread rollup, a missing head or an
 * unparseable `updatedAt` is never an accusation. `updatedAt` IS THE AGE, because the list read has no push time and a push, a retarget
 * and a label all move it: the failure it can have is DELAY (a chatty PR is asked only once it falls quiet), never an order sent to an
 * author whose push CI has not picked up yet.
 *
 * FILED UNDER `pr-checks-failing`, no new cause, as `ejected` is (`CAUSE_OF_STALL`): same audience, same remedy-by-the-owner, and a cause is
 * pinned by name in several guards. The key says `checkless`, so it never collides with a red head's.
 *
 * @param {any[]} prs @param {number} [nowMs]
 */
export function checklessPrOrders(prs, nowMs = Date.now()) {
  return (prs ?? [])
    .filter((pr) => pr && Number.isFinite(Number(pr.number)) && isCheckless(pr, nowMs))
    .sort((a, b) => Number(a.number) - Number(b.number))
    .map(checklessOrder);
}

/** @param {any} pr @param {number} nowMs */
function isCheckless(pr, nowMs) {
  if (!pr.headRefOid || !Array.isArray(pr.statusCheckRollup) || pr.statusCheckRollup.length > 0) return false;
  if (conflictStateOf(pr) === CONFLICT_STATE.CONFLICTING) return false;
  const quietSince = Date.parse(String(pr.updatedAt ?? ""));
  return !Number.isNaN(quietSince) && nowMs - quietSince >= CHECKLESS_QUIET_MINUTES * MS_PER_MINUTE;
}

/** @param {any} pr */
function checklessOrder(pr) {
  const head8 = String(pr.headRefOid).slice(0, 8);
  const { session, source } = ownerOfPr(pr);
  const ref = `pr-${subjectRef(pr.repoKey, pr.number)}`;
  const repoFlag = pr.repo ? ` --repo ${pr.repo}` : "";
  const remedy = `\`gh pr close ${pr.number}${repoFlag} && gh pr reopen ${pr.number}${repoFlag}\` (\`reopened\` is a trigger \`edited\` is not), or push a commit`;
  const what = `${subjectMention(pr)} at \`${head8}\` has NO CHECKS AT ALL, and has had none for ${CHECKLESS_QUIET_MINUTES} minutes of quiet: no workflow ran for this head, `
    + "so it is neither red nor green and the gate will NEVER offer it to a reviewer, which asks only of a settled green head. THE USUAL CAUSE is a RETARGET: "
    + "a pull request opened on another branch gets no `pull_request` run for `main`, and when that branch merges GitHub retargets it, "
    + "an `edited` event that does not start CI. ";
  return {
    session,
    ...(session === DEAD_OWNER_FALLBACK ? {}
      : { fallback: DEAD_OWNER_FALLBACK, fallbackOnlyIfAbsent: true,
        fallbackPrompt: `${what}Its owner, \`${session}\`, NO LONGER EXISTS (no workspace carries that label), so this order reached you. The remedy needs no code, so apply it: ${remedy}.` }),
    cause: "pr-checks-failing",
    subject: ref,
    discriminator: `checkless-${head8}`,
    prompt: `${what}REMEDY, and it fires CI without a code change: ${remedy}. ${ownershipOf(pr, source, "remedy")}`,
    causeKey: `${session}/pr-checks-failing/${ref}/checkless/${head8}`,
  };
}

/**
 * #2416: ONE ORDER FOR THE SET OF LABELLED PULL REQUESTS THAT HAVE SAID NOTHING FOR 48 HOURS, or none.
 *
 * THE LABEL IS VALID ONLY WITH A STATED EVIDENCE SOURCE, and the statement is a COMMENT after the label was
 * applied -- so "no comment after it was applied" is the reading of "nobody said what this waits on". A
 * comment ANYWHERE after the application counts, and that is deliberate: this asks whether the wait was
 * EXPLAINED, and a stale-but-explained wait is `product-manager`'s to audit through the row, not this cause's
 * to re-ask (a judgment cause is keyed on state, so it is not repeated while the set is unchanged).
 *
 * `awaitingSince` UNREAD, `comments` UNREAD, or a comment whose time cannot be parsed is NEVER an order:
 * absence of a reading is not a reading of absence. Keyed on the SET of numbers and not on the ages, which
 * move every tick and would re-ask a question whose answer has not changed. Ordered to `product-manager`,
 * whose brief names holds and waits, in `greenUnarmedOrders`' one-order-for-the-set shape.
 *
 * @param {any[]} prs @param {number} [now]
 */
export function awaitingEvidenceStaleOrders(prs, now = Date.now()) {
  const stale = prs.filter((pr) => awaitingEvidence(pr) && evidenceWaitUnexplained(pr, now))
    .sort((a, b) => Number(a.number) - Number(b.number));
  if (stale.length === 0) return [];
  const key = stale.map((pr) => subjectRef(pr.repoKey, pr.number)).join(".");
  const lines = stale.map((pr) => `  ${subjectMention(pr)}  carried \`${AWAITING_EVIDENCE_LABEL}\` for `
    + `${Math.floor((now - Date.parse(pr.awaitingSince)) / HOUR_MS)}h with no comment after it was applied`);
  return [{
    session: "product-manager",
    cause: "awaiting-evidence-stale",
    subject: "awaiting-evidence-stale",
    discriminator: key,
    prompt: `${stale.length} pull request(s) carry \`${AWAITING_EVIDENCE_LABEL}\` and nobody has said what they wait `
      + `on for more than ${AWAITING_EVIDENCE_QUIET_HOURS}h:\n${lines.join("\n")}\n`
      + "The label means the done-when needs an external run whose evidence is not posted yet, and it is valid "
      + "only with that source STATED. WHAT WOULD CLEAR IT: the evidence is posted and the label is removed "
      + "(`gh pr edit <n> --remove-label awaiting-evidence`) -- removing it IS posting the evidence -- or the "
      + "author says on the PR what it waits on and who owns that run. If nobody owns it, the label is hiding a "
      + "stalled PR: route it to the row's owner, or to `orchestrator` when the run is a fleet or lab one. "
      + `It is NOT \`${BLOCKED_LABEL}\`, which has no referent.`,
    causeKey: `product-manager/awaiting-evidence-stale/${key}`,
  }];
}

/**
 * Whether a labelled pull request has been quiet since the label went on for longer than the bound.
 * @param {any} pr @param {number} now
 */
function evidenceWaitUnexplained(pr, now) {
  const since = Date.parse(String(pr.awaitingSince ?? ""));
  if (Number.isNaN(since) || !Array.isArray(pr.comments)) return false;
  if (now - since <= AWAITING_EVIDENCE_QUIET_MS) return false;
  return !pr.comments.some((/** @type {any} */ c) => {
    const at = Date.parse(String(c?.createdAt ?? ""));
    return Number.isNaN(at) || at > since;
  });
}
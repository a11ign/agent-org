import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { READY_LABEL, CLAIM_LABEL } from "../claim-labels.ts";
import { todayIso, ANSWER_PREFIX } from "../waiting-condition.ts";
import { subjectMention, subjectRef } from "../review-attribution.ts";
import { REPEAT_TICKS, normaliseLine, type RepeatingGroup } from "../repeating-lines.ts";
import { machineryFlagOn, redSinceOf, type CanaryState } from "../org-health.ts";
import { RECHECK_FLAG } from "./shared-file-orders.ts";
import { ghQueueTick } from "../gh-ledger.ts";
import { isBrokenRed } from "../red-pr.ts";
import { holdersOf } from "../pr-hold-state.ts";
import { REPO } from "../project-identity.ts";
import { homeProjectDeclaration } from "../project-config.ts";
import { verifyCheckoutOf, withVerifyStamps } from "../verify-stamp.ts";
import { START_CAUSES } from "../cause-declaration.ts";
import { BACKLOG_LABEL, OUT_OF_RELEASE_LABEL } from "../project-vocabulary.ts";
import { PROJECT_NUMBER, PROJECT_OWNER } from "../board-snapshot-scope.ts";
import { withBoardSnapshot } from "../board-snapshot.ts";
import type { ChangeRef, TicketPort, TicketState } from "../ticket-port/port.ts";
import { githubTicketAdapter, TRACKER } from "../ticket-port/github-adapter.ts";
import { readTrunkRed, trunkOfCodeRepository, trunkRedOrders } from "../trunk-red.ts";
import { recordIgnoredChairmanLabels, recordTickFailures as recordFailuresOf } from "../failure-recorders.ts";
import { readJsonObject, writeJsonObject } from "../claim-stall.ts";
import { requiredWhenNeeded, perPullRequestOrders, greenUnarmedOrders, type UnarmedFacts, reviewBlockedOrders, stalledPrOrders,
  STALL_REASONS_WITHOUT_A_CAUSE, ownerOfPr, ROW_REVIEW_SKILL_FLAG, PR_OWNER_ROUTING_FLAG, withholdOutsideFollowUps, routeDeadOwnerRefusals, reviewOnlyRefs, SAME_HEAD_REFAIL_FLAG, acceptanceGateOf, firstRefusalOf, treeWideGuardVerdict } from "./pr-orders.ts";
import { treeWideGuardFilesIn, runTreeWideGuards } from "../lib/tree-wide-guard-org-side.ts"; // agent-org#1503
import { checkoutPullRequestMerge, orgSideAcceptanceEligibility, orgSideAcceptanceVerdict, installPullRequestCheckout, releasePullRequestCheckout, type OrgSideVerdict } from "../acceptance-commands.ts"; // agent-org#1502
import { labJobFinishedOrders, readLabJobRecords, readDispatchedLabJobs } from "./lab-job-orders.ts";
import { classAndKeyOf as orgHealthClassAndKey } from "./org-health-suppression.ts";
import { TABLE_ROW as STANDING_ROW } from "../board-truth-audit.ts";
import { declaresReadyWhenUnblocked, githubReadyIo, promoteReadyWhenUnblocked, reportReadyWhenUnblocked } from "./ready-when-unblocked.ts";
import { withWaitingEdges } from "./pr-waits.ts";
import { withScopedPrOwners, resolverDefectsOf } from "./pr-owners.ts";
import type { ResolverDefect } from "./pr-owners.ts";
import { rowCallCountOrders } from "./row-call-count-orders.ts";
import { stallOrdersOrNone, claimStallsNow, closedClaimsNow } from "./claim-stall-tick.ts";
import { armedAlready, EXIT as ARM_EXIT, familyMember, undeclaredFamilyKey, runArmPr } from "../arm-pr.ts";
import { primaryStaleOrders } from "./causes/org-health-host-drift.ts";
import { baseTipWhenRed, shouldBeMerging } from "./causes/pr-checks.ts";
import { readEjections, readReenqueueState, requeueEjected } from "./causes/pr-ejected.ts";
import { patchUnchangedSince, pipelineCodeownerReviewMissing, pipelineCodeownerReviewOrders, refusalCommitOf, reviewBlocked, withEvidenceLabelAges,
  withPatchIds, withCheckMarkers } from "./causes/pr-reviews.ts";
import { REVIEW_STATE, reviewStateOf } from "./pr-state.ts";
import { EXIT, branchesToReplace, conditionalFor, defaultRun, holdTickBudget, inRepo, isGhRun, readArming, readClaimedRowComments, readElsewherePrs, readOpenRows,
  readPromotableRows, readPrs, readReadyRows, readWithFirstWaveTogether, repoNow, restReadsOfTick, runBatch, standingFor, isGateProcess } from "./reads.ts";
import { type Budget, budgetLine, restConditionalOn, tickBudget } from "../gh-conditional.ts";
import { INSIDE, declaredIdentities, reviewTrustOf, type DeclaredIdentities } from "../review-trust.ts";
import { claimedRowAmendedOrders } from "./causes/rows-amended.ts";
import { answerGivenOrders, answerGivenOrdersOrNone, answerOrders, bareAnswerLabelOrders, bareAnswerOrdersOrNone, blockedReferentOrders,
  endedSessionLabels, liveWorkspaceLabels, rowsOwingAnswers } from "./causes/rows-answers.ts";
import { agedBacklogOrders, chairmanOrders, emptyShelfOrder, laneBacklogOrders } from "./causes/rows-backlog.ts";
import { type BlockerClearedDrop, clearingAskWindow, holderWaitingOn, staleClearing, unclaimedBlockerClearedOrders, unclaimedClearings } from "./causes/rows-blocker-cleared.ts";
import { chairmanAnsweredOrders, readChairmanBlocked } from "./causes/rows-chairman.ts";
import { closesUnresolvedOrders, incompleteRowOrders, partitionUnclaimed, rowBranchOrders, unclaimableRowOrders } from "./causes/rows-claims.ts";
import { type KeyedClosedClaimedRow, readClosedClaimedRows } from "./causes/rows-claims-closed.ts";
import { EPIC_LABEL, epicOrders, finishedEpicOrders } from "./causes/rows-epics.ts";
import { fleetBatchOrders } from "./causes/rows-fleet-batch.ts";
import { type BoardFacts, readRowsOffBoard, rowOffBoardOrders, rowsOffBoard } from "./causes/rows-off-board.ts";
import { type EmergencyPriorityOption, type OfferHierarchy, CHAIRMAN_REFUSAL_FLAG, chairmanRowAnsweredByCeo, chairmanRowsOf, emergencyHierarchyNow, hierarchyOrders, offeredByShare, productRegionsOf,
  readChairmanPriority, readEmergencyPriorityOption, rowOrders } from "./causes/rows-offer.ts";
import { blockerClearedOrders, hostDriftOrders, hostUnitsEntry, readOtherScopes, rowsWithOpenPr, trackerReadings } from "../work-gate.ts";
import { type ArmingPort, MAX_ROW_ORDERS_PER_TICK, NOT_STARTABLE, REVIEWER_STATE_DIR, type Scope, type ScopeRepository, aimOf, comparablePrFiles,
  declaredBlockers, labelsOf, ownerOf, sessionOf, tagged } from "./vocabulary.ts";

/**
 * THE GATE COULD SEE A ROW BECOME RUNNABLE AND HAD NOBODY TO TELL -- #2027.
 *
 * MEASURED 2026-09-22. PR #1957 merged at 21:26:01Z and closed #1948 one second later, leaving #1908 --
 * `in-progress`, `session:worker-capture` -- with every blocker closed and six rows queued behind it. The
 * `work:gate` run 31 minutes later emitted NO CAUSE FOR `worker-capture` AT ALL. `ready-row-unclaimed`
 * skips it (claimed, and not `ready`), and every other cause addresses a session that does NOT hold the
 * row: the whole causal vocabulary was written for the unclaimed pool.
 *
 * `prompt:session` IS NOT THE FALLBACK. It refused with `NOT PROMPTED: "worker-capture" is working`, and
 * at the time a refused prompt was dropped rather than queued. What actually delivered the news was
 * `answer:worker-capture` applied to #1908 BY HAND -- a label meaning "someone owes you an answer"
 * pressed into service as "your work is unblocked", two meanings in one namespace, which is the exact
 * collision `row-file.ts`'s own header records for `session:`.
 *
 * ONCE PER ROW PER CLEARING, AND THE KEY IS THE SET THAT CLEARED. `fleetBatchOrders` learned this from
 * #1799: a key that names the state re-fires when the state moves and stays quiet while it does not. So
 * the closed blockers' numbers are IN the key -- the same row blocked again on a new row and cleared
 * again is a NEW question and reaches its holder, while an unchanged clearing is one order, not one every
 * tick.
 *
 * A ROW WITH NO BLOCKER AT ALL IS NOT A CLEARING. `blockedBy.nodes` empty means nothing ever blocked it,
 * and every claimed row in the tracker would otherwise be announced as freshly unblocked on the first
 * tick after this shipped -- a cause that fires on every member of its population the day it lands is
 * noise, and noise is how a real signal gets filtered out.
 *
 * AND NEITHER IS A ROW STILL WAITING ON SOMETHING ELSE. `waitingOn` is asked in full, so a row whose
 * `blockedBy` cleared while its `Not-before:` is still in the future, or which owes an answer, is not
 * announced as runnable. The rule this file already applies to the offer path applies here: a declared
 * wait shelves the row, and the LAST of a row's conditions to clear is the one that frees it.
 *
 * AND NOT A ROW THE FLEET HOLDS (#2186). This asks `fleetWaitingOn`, not `waitingOn`, because the split
 * between them was drawn for the OFFER path -- whether a row is reachable by the engineer pool -- and this
 * cause is not that: it addresses the session that already holds the row and says "PICK IT BACK UP". For
 * that caller a live `Fleet-hold-until:` is as disqualifying as an open `blockedBy` edge. Measured
 * 2026-09-23: #2114's holder was woken at 15:37Z for a row the fleet held until 22:00Z, while the same
 * tick's shelf line said so. The hold clears itself, so the order goes out the tick after it passes.
 *
 * AND NOT A HOLDER WHO HAS ALREADY RESUMED (#2161). An open pull request whose `Closes:` names the row is
 * the holder's own answer to this cause: they picked the row back up, built it and opened the PR, and
 * "PICK IT BACK UP" is then a question with a known answer. Measured 2026-09-23 on three rows: 6m56s past a
 * green draft (#2031), 1m47s (#2145), and 2m24s after APPROVED and in the merge queue (#2170) -- and
 * because this is an ACTION cause `wake`'s twenty-minute expiry re-offers it for as long as the key still
 * matches, so the bound is `MAX_DELIVERIES` and reaching it labels a built, green row `needs:chairman`.
 * THE PR IS THE DISCRIMINATOR, on `worker-judge`'s argument on the row: an open PR means ACTED ON. `prs` is the read
 * `draftOrder` already made, so the narrowing spends no call and does not touch `GH_READS`. #3451 OVERTURNED THE SECOND HALF of that
 * argument, "a claim timestamp is not one": a claim is REFUSED while a `blockedBy` edge is open, so a holder that claimed after
 * the last blocker closed was told by the claim itself, and "abandoned after claiming" is `claim-stalled`'s to find, not this
 * cause's (#3390: claimed 101 s after the clearing, woken 91 minutes later, 1 min 46 s after its PR opened). `claimFacts` carries
 * what the claim-stall tick already read, and a drop is returned with its reason beside the orders -- see `staleClearing`.
 *
 * #2741: A CLEARING THAT DOES NOT RECUR BACKS OFF THE SAME WAY `unclaimedBlockerClearedOrders` DOES.
 * `closings` says when each blocker closed, and the causeKey then carries `promotionAskWindow`'s suffix
 * exactly as that function's does -- one ask at once, again at 6h and 24h, then every 72h for ever. A
 * `Not-before:`/`answer:`/`blockedBy` cycle that changes nothing about the row does not reopen the first
 * window: #1756 escalated twice in one day because the pre-#2741 key never changed and this is an ACTION
 * cause, so answering `answer:ceo` correctly reset the counter and the twenty-minute expiry rebuilt the
 * same six deliveries from zero. WITHOUT `closings` (`null`, or an old caller) every ask is the unstaged
 * first one, which is the behaviour before this backoff existed and what a refused read must fall back to.
 *
 * INCIDENT BEHIND THE ORDER'S TEXT (moved out of it, #3444: the agent reading the order cannot use it):
 * no other cause addresses a session that already holds a row. On 2026-09-22 #1908's last blocker closed at 21:26:02Z, the next tick said
 * nothing to `worker-capture`, and six rows sat behind it until a label meant for something else was applied by hand.
 *
 * @param rows every open row
 *
 * @param [nowMs] the clock a timestamped hold is read against, injected so a test moves time
 *
 *   the reads this cause takes BEYOND `rows` itself, bundled so a 5th positional parameter does not join `nowMs` (`max-params`).
 *   `openPrs` is `readPrs`'s open pull requests. OMITTED MEANS "NOT ASKED", and the cause then behaves
 *   exactly as before #2161: it fails toward telling the holder, never toward silence.
 *   `closings` is `readRecentlyClosed`'s map, or `null` for "not asked or refused" -- see this function's
 *   own header for what that falls back to.
 *   `claimFacts` (#3451) is the claim-stall tick's reading of every claimed row (`onFacts`). OMITTED MEANS NOT ASKED (no drop, no line); `null` is a tick that
 *   read no claim, which keeps every order and says so.
 * @returns `drops` are the orders NOT emitted and why; `log` is every line the tick prints about them
 */
export function blockerClearedReading(rows: any[], today: string = todayIso(), nowMs: number = Date.now(), { openPrs = [], closings = null, claimFacts }: { openPrs?: any[]; closings?: Map<number, number> | null; claimFacts?: import("../work-gate/claim-stall-tick.ts").ClaimFactsOfTick | null; } = {}): {
    orders: { session: string; cause: string; subject: string; discriminator: string; prompt: string; causeKey: string; }[];
    drops: BlockerClearedDrop[]; log: string[];
} {
  const reading: ReturnType<typeof blockerClearedReading> = { orders: [], drops: [], log: [] };
  const resumed = rowsWithOpenPr(openPrs);
  for (const row of rows ?? []) {
    const session = sessionOf(row);
    const cleared = declaredBlockers(row);
    if (!session || !labelsOf(row).includes(CLAIM_LABEL) || cleared === null) continue;
    if (resumed(row)) continue;
    // THE LINE THAT MAKES `cleared` MEAN CLEARED. `waitingOn` reports an OPEN `blockedBy` node before
    // anything else, so passing here is what proves every number above is closed -- and it covers the
    // other conditions in the same breath, which is why `declaredBlockers` does not re-ask.
    if (holderWaitingOn(row, today, nowMs)) continue;
    const window = clearingAskWindow(cleared, nowMs, closings);
    if (!window) continue;
    const key = cleared.join(".");
    const causeKey = `${session}/blocker-cleared/row-${subjectRef(row.repoKey, row.number)}/${key}${window.suffix}`;
    const verdict = staleClearing({ row, cleared, causeKey, closings, claimFacts, nowMs });
    reading.log.push(...verdict.log);
    if (verdict.drop !== null) {
      reading.drops.push(verdict.drop);
      continue;
    }
    reading.orders.push({
      session,
      cause: "blocker-cleared",
      subject: `row-${subjectRef(row.repoKey, row.number)}`,
      discriminator: key,
      prompt: `${subjectMention(row)} IS YOURS AND IS NO LONGER BLOCKED. Every row it declared a dependency on `
        + `is now closed: ${cleared.map((n) => `#${n}`).join(", ")}.\n`
        + "PICK IT BACK UP; you already hold the claim, so nothing else will offer it.\n"
        + "IF IT IS STILL NOT RUNNABLE, say so in a FIELD, not a comment: "
        + `\`gh issue edit ${row.number} --add-blocked-by <n>\`, a \`Not-before: YYYY-MM-DD\` line, or `
        + `\`${ANSWER_PREFIX}<session>\` if you wait on a decision. Each clears itself.`,
      causeKey,
    });
    if (reading.orders.length >= MAX_ROW_ORDERS_PER_TICK) break;
  }
  return reading;
}

/**
 * PURE. The orders the state implies.
 *
 * Every order carries a `causeKey` derivable from GitHub state alone, so re-running this gate produces a
 * BYTE-IDENTICAL order and the waker's ledger can deduplicate it. That is what lets the gate be stateless
 * and run as often as it likes.
 *
 * THE PROMPT CARRIES THE ANSWER, NOT THE QUESTION. "Draft #N at `abc12345` has green checks and no verdict
 * at that head" rather than "check whether there is work" -- a woken turn that has to survey the queue is
 * a tick with extra steps, which is the cost this file exists to remove.
 *
 *
 *        `engineerStarts` and `projectDeclaration` (#3820) are the last engineer starts and the declaration that says which rows are product; the engineer pool is
 *        offered product rows only while fewer than 6 of the last 10 starts were one (`offeredByShare`). OMITTED MEANS NOT ASKED: the offer is unrestricted.
 *        `offerHierarchy` (#4524) is `readChairmanPriority`'s verified rows and the declared milestone ranking: the order rows are offered in, the chairman's exempt
 *        from the product-share floor and from B4 against a holder that is not itself a chairman row. OMITTED MEANS NOT ASKED: `priority` first, then the lowest row number.
 *        `claimStalls` is `claimStallTick`'s orders (#2470): a nudge to a holder whose claim has not moved, or a release
 *        `wake.ts` performs. OMITTED MEANS NONE.
 *        `required` is the checks that can block a merge (`requiredCheckNames`), or `null` for
 *        "could not be read", which counts EVERY check as before this existed.
 *        `epics` are the open `epic` rows with their `subIssuesSummary` (`epicRowsOf`, out of the all-open list), `[]` when
 *        that list was refused. `epicOrders` still fires only on an empty shelf; `finishedEpicOrders` fires whatever is Ready (#4042).
 *        `promotableRows` are the backlog rows carrying no unpickable label; `chairmanBlocked` are
 *        the rows waiting on the chairman, oldest first. `[]` for either when refused or empty.
 *        `prFiles` is `comparablePrFiles(prs)` -- the open PRs B4 may be asked about. It DEFAULTS TO
 *        `[]`, which means "no overlap is knowable", so every row is offered: the same behaviour as
 *        before B4 shelving existed, and the reason a caller that cannot read files is never worse off.
 *        `claimedComments` is `readClaimedRowComments()` -- the comments on the claimed rows only. It
 *        DEFAULTS TO `[]`, which is "not asked or refused": the comment marker is not evaluated and the
 *        body/`blockedBy` markers still are, so a caller that cannot make that read is never worse off
 *        than before this cause existed and never invents a constraint it did not see.
 *        `rowBranches` is `readRowBranches()` -- every branch on `origin` whose name ends `-<digits>`.
 *        OMITTED AND `null` MEAN THE SAME THING -- "not asked or refused": no row is shelved for it and
 *        no order is emitted, so a caller that cannot reach `origin` behaves exactly as it did before
 *        #2031. It carries no `= null` default deliberately: a default parameter is a branch `complexity`
 *        counts, and `decide` sits exactly on its limit of 15. Both readers below already treat a missing
 *        listing and a `null` one identically (`Array.isArray`, `?? []`), so the default would buy
 *        nothing but the sixteenth branch.
 *        Spending no API pool is the POINT rather than a saving -- see `readRowBranches`.
 *        `hostDrift` is `readHostDrift()` -- `host-units.ts --json`'s findings, or `null`. OMITTED
 *        AND `null` MEAN THE SAME THING, "not asked or refused": no order is emitted, so a caller
 *        that cannot reach the host behaves exactly as it did before #2174. It carries no `= null`
 *        default for `rowBranches`'s reason -- a default parameter is a branch `complexity` counts,
 *        and `decide` sits exactly on its limit of 15.
 *        It spends NO API pool: see `readHostDrift`.
 *        `primaryDrift` is `readPrimaryDriftNow()` (#2781): where the primary stands against `origin/main`, or `null` for
 *        "not asked". OMITTED AND `null` MEAN THE SAME, and it carries no default for the same `complexity` reason.
 *        `trunkRed` is `readTrunkRed()` -- the facts about a red `main`, or `null` when it is green or the
 *        read was refused. OMITTED AND `null` MEAN THE SAME THING and it carries no `= null` default, for
 *        `rowBranches`'s reason: `decide` sits exactly on its limit of 15.
 *        `branchPrs` is `readBranchPrsOfUnclaimed()` (#3892): the pull requests on those branches, so a row whose branches were all closed unmerged is
 *        offered rather than shelved. OMITTED AND `null` MEAN THE SAME, "not asked or refused": the row stays shelved. No `= null` default, for `rowBranches`'s reason.
 *        `baseTip` is `readBaseTip()` -- `main`'s tip commit, read only on a red tick (#2117). It carries no
 *        `= null` default for `rowBranches`'s reason, and OMITTED AND `null` MEAN THE SAME THING: the
 *        `pr-checks-failing` prompt says whether `main` moved is UNKNOWN. IT CHANGES ONLY THOSE WORDS.
 *        `unarmed` is `readUnarmed(shouldBeMerging(prs, required))` -- the green, unheld pull requests
 *        the API says nothing has armed, or (agent-org#488) `UnarmedFacts` from `settleUnarmedPrs`: the ones the gate did not arm, with the count it held. It DEFAULTS TO `null`, which is "not asked or refused" and
 *        emits no order: a caller that cannot make that read must never produce a false all-clear, and
 *        must never produce a false alarm either.
 *        `offBoard` is `readRowsOffBoard()` -- every open row's Project 1 membership, or `null` (#2075). OMITTED AND `null` MEAN
 *        THE SAME THING, "not asked or refused": no order is emitted. It carries no `= null` default for `rowBranches`'s
 *        reason: `decide` sits exactly on its limit of 15.
 *        `callCountSignals` is `rowCallCountSignals(openRows, turns, claimedComments)` (#2691, windowed
 *        per row's own claim record since #2710) -- split candidates past the threshold on calls made
 *        while holding their row. OMITTED MEANS NONE, and `rowCallCountOrders` carries its own `= []`
 *        default rather than this signature carrying one, for `rowBranches`'s reason.
 *        `labJobs` is `labJobRecordsOrSay()` (#2729) -- the lab jobs that ended for a row, or `null` for a read that was
 *        refused. OMITTED AND `null` MEAN THE SAME THING and it carries no `= []` default for `rowBranches`'s reason.
 *        `bareAnswerLabels` is `bareAnswerLabelOrders(...)` (#2711) -- already-built orders, because
 *        building them means a per-row timeline call `decide` itself must not make. OMITTED MEANS NONE,
 *        and it carries no `= []` default for `rowBranches`'s reason: `decide` sits exactly on its limit
 *        of 15, and `bareAnswerOrdersOrNone` carries the `?? []` instead.
 *        `answerGiven` is `answerGivenOrders(...)` (#3632), built outside for `bareAnswerLabels`'s reason and absent-safe the same way (`answerGivenOrdersOrNone`).
 *        `claimRefusals` is `claimRefusalStreaksNow(offerable)` (#2845) -- each offered row's consecutive-refusal streak. OMITTED MEANS
 *        NOT ASKED, so no `ready-row-unclaimable` order, and `unclaimableRowOrders` carries the absence handling for `rowBranches`'s reason.
 *        `nowMs` is the clock `chairmanOrders` windows on (#2989); omitted is `Date.now()`, so only a test passes it.
 *        `recheck` is `RECHECK_FLAG`'s reading (agent-org#1187): OMITTED READS THE FLAG (`recheckFlagOn`), and a test or a replay passes it so the answer does not depend on the host's state directory.
 *        It carries no `= ...` default for `rowBranches`'s reason.
 *        `rowReviewSkill` is `ROW_REVIEW_SKILL_FLAG`'s reading (agent-org#1268), read the same way (`rowReviewSkillFlagOn`): OMITTED READS THE FLAG, and a test passes it.
 *        `prOwnerRouting` is `PR_OWNER_ROUTING_FLAG`'s reading (agent-org#1325), read the same way (`prOwnerRoutingFlagOn`): OMITTED READS THE FLAG, and a test passes it.
 *        `sameHeadRefail` is `SAME_HEAD_REFAIL_FLAG`'s reading (agent-org#1185), read the same way (`sameHeadRefailFlagOn`).
 *        `claimFacts` is the claim-stall tick's reading of every claimed row (#3451) -- what `blockerClearedOrders` drops an order on. OMITTED MEANS NOT ASKED, so no drop;
 *        `null` is a tick that read no claim. It carries no `= undefined` default for `rowBranches`'s reason.
 */
export function decide({ prs, readyRows, promotableRows = [], chairmanBlocked = [], prFiles = [],
  drain = false, required = null, epics = [], answerOwed = [], openRows = [], unarmed = null,
  claimedComments = [], rowBranches, branchPrs, hostDrift, primaryDrift, closings, claimFacts, trunkRed, baseTip, claimStalls, offBoard, key, repo, callCountSignals, bareAnswerLabels, labJobs, claimRefusals, nowMs, recheck, rowReviewSkill, prOwnerRouting, sameHeadRefail, answerGiven, engineerStarts, projectDeclaration, shareLog, shareMemory, offerHierarchy, waitFacts, identities, primaryPaced = false }: {
        prs: any[]; readyRows: any[]; promotableRows?: any[]; chairmanBlocked?: any[]; nowMs?: number; recheck?: boolean; rowReviewSkill?: boolean; prOwnerRouting?: boolean; sameHeadRefail?: boolean;
        /** agent-org#1401: the primary's tracker lanes were skipped by pacing this tick (`work-gate.ts`), so the open rows are not a read the shelf can be stocked from. */
        primaryPaced?: boolean;
        prFiles?: { number: number; files: string[]; changedFiles: number; }[];
        drain?: boolean; required?: string[] | null; epics?: any[]; answerOwed?: any[];
        key?: string; repo?: string; openRows?: any[]; unarmed?: number[] | UnarmedFacts | null;
        claimedComments?: { number?: number; comments?: { body?: string; id?: string; }[]; }[];
        rowBranches?: { branch: string; head: string; row: number; }[] | null;
        branchPrs?: { branch: string; number: number; state: string; }[] | null;
        hostDrift?: { unit: string; problem: string; detail: string; }[] | null;
        primaryDrift?: import("../update-primary.ts").PrimaryDrift | null;
        closings?: Map<number, number> | null; claimFacts?: import("../work-gate/claim-stall-tick.ts").ClaimFactsOfTick | null; trunkRed?: ReturnType<typeof readTrunkRed>;
        baseTip?: { sha: string; date: string; } | null;
        claimStalls?: import("../claim-stall.ts").StallOrder[]; offBoard?: BoardFacts[] | null;
        callCountSignals?: { row: number; session: string; calls: number; }[];
        bareAnswerLabels?: ReturnType<typeof bareAnswerLabelOrders>; answerGiven?: ReturnType<typeof answerGivenOrders>;
        labJobs?: NonNullable<ReturnType<typeof import("../work-gate/lab-job-orders.ts").recordOf>>[] | null;
        claimRefusals?: Record<string, { reason: string; ticks: number; }>;
        engineerStarts?: { at: number; kind: string; }[]; projectDeclaration?: Parameters<typeof productRegionsOf>[0]; shareLog?: (line: string) => void; shareMemory?: { stateDir: string; now?: number; };
        offerHierarchy?: OfferHierarchy;
        waitFacts?: import("../wait-condition.ts").WaitFacts | null; // #1075: the facts a ready row's body `Waiting-for:` is read against
        identities?: DeclaredIdentities; // #1311: who the org declares. OMITTED READS THE HOST (`declaredIdentities()`); a test passes its own so it does not depend on the machine
    }): {
    session: string; cause: string; subject: string; discriminator: string;
    prompt: string; causeKey: string;
}[] {
  const ownerRouting = prOwnerRoutingFlagOn(prOwnerRouting); // #1325: read ONCE, for the review-blocked set below and the last step
  // FIRST, BEFORE EVERY OTHER CAUSE (#2356): a red `main` outranks even `answer-owed` -- see `trunkRedOrders`.
  // `answer-owed` says another session is ALREADY STOPPED waiting on them, which outranks any standing question.
  const orders = [...trunkRedOrders(trunkRed), ...primaryStaleOrders(primaryDrift), ...answerOrders(answerOwed)]; // #2781: a stale primary next, every order below is given from its code
  // SECOND, AND AHEAD OF `blocker-cleared` DELIBERATELY (#2110). Both address a session that already
  // holds a row, so both outrank every cause that offers new work -- but between the two, a constraint
  // the holder has not read is worse than a row they have not resumed. `blocker-cleared` says work can
  // START again and loses nothing by waiting a tick; an unread constraint means work already in progress
  // is being done against a rule nobody applied, and every minute of it is a minute that may have to be
  // thrown away. #2099's ruling arrived 6 minutes after the build was finished.
  orders.push(...claimedRowAmendedOrders(openRows, claimedComments));
  // SECOND, AND FOR THE SAME REASON ONE LEVEL IN (#2027). A session holding a row whose last blocker just
  // closed is not waiting on a decision -- it is stopped on work it can resume this minute, with whatever
  // is queued behind that row stopped with it. Ahead of every cause that offers NEW work: a row already
  // claimed and now runnable beats a row nobody has picked up.
  orders.push(...blockerClearedOrders(openRows, todayIso(), Date.now(), { openPrs: prs, closings, claimFacts })); // #2741 backoff; #3451 the drops
  // #2470/#2711/#2729: A CLAIM THAT DOES NOT MOVE, A BARE `answer:` LABEL ON IT, OR A LAB JOB IT DISPATCHED THAT HAS ENDED -- all address the row's own holder, so all outrank every cause offering NEW work.
  orders.push(...stallOrdersOrNone(claimStalls), ...bareAnswerOrdersOrNone(bareAnswerLabels), ...answerGivenOrdersOrNone(answerGiven), ...labJobFinishedOrders(openRows, labJobs, Date.now()));

  orders.push(...perPullRequestOrders(prs, required, baseTip, { nowMs, recheck: recheckFlagOn(recheck), rowReviewSkill: rowReviewSkillFlagOn(rowReviewSkill), sameHeadRefail: sameHeadRefailFlagOn(sameHeadRefail), identities }), ...closesUnresolvedOrders(prs)); // #2823 beside them; #3092 the checkless
  // #2031: AHEAD OF THE OFFER, AND IT IS THE SAME READING THAT WITHHELD IT. `partitionUnclaimed` shelves
  // the row on `rowBranches` and this emits the cause that names the branch -- one condition, one read,
  // said once as a withholding and once as a question. Ahead of `rowOrders` for the ordering reason the
  // causes above use: work that already EXISTS outranks work nobody has started.
  const { offerable, blocked, yielding } = partitionUnclaimed(readyRows, prFiles, { rowBranches, branchPrs, openRows, chairmanRows: chairmanRowsOf(offerHierarchy), waitFacts });
  orders.push(...rowBranchOrders(readyRows, rowBranches, prs, branchPrs), ...incompleteRowOrders(readyRows)); // #2791, #3010, #3892
  orders.push(...rowOrders(offeredByShare(offerable, { starts: engineerStarts, declaration: projectDeclaration, shareLog, shareMemory, chairmanRows: chairmanRowsOf(offerHierarchy), emergencyRows: offerHierarchy?.emergencyRows, paced: primaryPaced }), branchesToReplace(rowBranches, branchPrs), offerHierarchy), ...unclaimableRowOrders(offerable, claimRefusals)); // #2845: the offer, and its refusal
  orders.push(...hierarchyOrders(offerHierarchy, { blocked, yielding, openRows, prs })); // #4524: what the hierarchy says to the chairman's reader and to the holders it was offered over

  // #2139: AHEAD OF BOTH BACKLOG SURVEYS AND BEHIND EVERY OFFER, because it is neither. It names ONE row
  // and the exact set that cleared, which outranks `ready-queue-empty` and `lane-backlog-unpromoted`
  // asking somebody to go and LOOK at a backlog -- and it is deliberately not gated on the shelf being
  // empty, which is what kept both of those silent while six rows sat runnable for up to 16h09m behind a
  // four-row Ready queue. It sits behind `rowOrders` for the ordering the causes above use: a row already
  // on the shelf can be claimed this minute, while this one still needs promoting first.
  // #2286: `closings` LETS IT BACK OFF. Absent, it asks at the unstaged key on every TTL, as before.
  // #1129: `primaryDrift.originSha` IS THE `origin/main` HEAD THIS TICK READ; the class guards `promote` on a `Head:` line, so without it the class always holds.
  orders.push(...unclaimedBlockerClearedOrders(openRows, undefined, { closings, head: primaryDrift?.originSha ?? null }));

  // The backlog is counted the same way, or the order would report rows the pool equally cannot take.
  // `ownerOf`, not `laneOwnerOf`: routed rows reach `decide` now, and the POOL's count must be exactly
  // what it was -- an engineer offered a `fleet-gated` row would be queueing for a worker box.
  const poolPromotable = promotableRows.filter((r) => ownerOf(r) === null);
  const shelf = emptyShelfOrder({ offerable, blocked, promotable: poolPromotable.length, key });
  if (shelf) orders.push(shelf);

  orders.push(...laneBacklogOrders(promotableRows, readyRows), ...agedBacklogOrders(promotableRows)); // #2848: the same stock, aged


  // AFTER the lane orders and BEFORE the chairman's: an unfiled epic is a supply problem, which only
  // matters once the queue and the lanes have nothing left to offer.
  orders.push(...epicOrders(epics, readyRows));
  // AFTER the unfiled epics. An epic with NO children is work nobody has filed at all; one whose children
  // are all closed may only need closing. The more likely supply of real work goes first.
  orders.push(...finishedEpicOrders(epics)); // whatever is Ready (#4042): the board is read when the queue is NOT dry
  orders.push(...blockedReferentOrders(openRows, readyRows), ...rowCallCountOrders(callCountSignals)); // #2691 beside it: also a JUDGMENT over a row already claimed
  // THE BATCH THAT USED TO BE A 01:00 TIMER. Placed here rather than first: a named row to fix
  // outranks a standing sweep, and `orchestrator` gets one order per tick either way.
  orders.push(...fleetBatchOrders(openRows));

  // #1969: AFTER the per-PR and per-row causes and BEFORE the chairman's. A green unarmed PR is finished
  // work that cannot land -- more urgent than a supply question, less urgent than a named red build,
  // and never withheld by a drain: a window stops the org TAKING ON work, not finishing what is in flight.
  orders.push(...greenUnarmedOrders(unarmed, { key: key ?? "", repo: repo ?? REPO }));

  // #2084: BESIDE `pr-green-unarmed` AND FOR ITS REASON, ONE SURFACE OVER. Both name finished work that
  // cannot land; that one is about the ARMING not having happened and this one about GitHub refusing to
  // complete it. Same population (`mergeCandidates`), same audience, same placement -- more urgent than a
  // supply question, less urgent than a named red build, and never withheld by a drain, because a drain
  // stops the org TAKING ON work rather than finishing what is in flight.
  // #1325: with the flag on, an outside or chairman pull request leaves the set BEFORE its one order is built (see `reviewOnlyRefs`). Off, nothing is read.
  const reviewOnly = ownerRouting ? reviewOnlyRefs(prs, identities ?? declaredIdentities()) : null;
  orders.push(...reviewBlockedOrders(reviewBlocked(prs, required).filter((b: any) => reviewOnly === null || !reviewOnly.has(subjectRef(b.repoKey, b.number)))));
  // #2209: a conflicting PR is in no other cause's population, so it is told to its author here; a drain keeps it.
  // #2968: FED BY THE TOTAL CLASSIFIER, NOT BY "GREEN AND UNHELD": #2950, a conflicted draft, sat 7.5 h unheard.
  orders.push(...stalledPrOrders(prs, { required, reasons: STALL_REASONS_WITHOUT_A_CAUSE, nowMs }));
  orders.push(...pipelineCodeownerReviewOrders(pipelineCodeownerReviewMissing(prs, prFiles))); // #1959: beside the two above

  // #2174: AFTER the per-PR and per-row causes and BEFORE the chairman's, for `pr-green-unarmed`'s
  // reason applied to the machine rather than to a pull request. A stale host is finished work that has
  // not taken effect -- more urgent than a supply question, less urgent than a named red build. It is
  // deliberately NOT withheld by a drain: see `START_CAUSES`.
  orders.push(...hostDriftOrders(hostDrift), ...rowOffBoardOrders(offBoard)); // #2075: beside it; see `rowOffBoardOrders`

  orders.push(...chairmanOrders(chairmanBlocked, nowMs), ...chairmanAnsweredOrders(chairmanBlocked)); // #3390: beside it, and a row the reminder names may be named here too


  // DRAIN WITHHOLDS, IT DOES NOT STOP. Filtering here rather than at each producer keeps the partition
  // in ONE place -- `START_CAUSES` is the whole statement of what "new work" means, and a cause added
  // without classifying it is caught by `work-gate.test.ts` rather than silently surviving a window.
  // #1325: LAST, over EVERY cause, because the PR causes come from six producers. With the flag on, an outside or chairman-authored pull request keeps its review.
  // #1370: the rejected review on a dead owner's pull request goes to a fresh worker, after the withholding (which never touches a worker's pull request).
  const routed = ownerRouting ? routeDeadOwnerRefusals(withholdOutsideFollowUps(orders, prs, identities ?? declaredIdentities()), prs) : orders;
  return drain ? routed.filter((o) => !START_CAUSES.includes(o.cause)) : routed;
}

/**
 * The agent host's drift, or `null` when the read could not be made -- #2174.
 *
 * SPAWNED, NOT IMPORTED, AND THE CHOICE IS MEASURED RATHER THAN STYLISTIC. The row offered three routes:
 * import `hostUnitDrift`, split it into a leaf module, or spawn `host:check`. A direct import is free at
 * LOAD -- `host-units.ts` adds one file to a closure of 21, and 39.3ms against the gate's own 39.4ms,
 * five runs each -- so the row's constraint 1, which feared the import WEIGHT, is satisfied by it and
 * would have ended the question.
 *
 * WHAT THE WEIGHT MEASUREMENT MISSES IS THE CAPABILITY CLOSURE, and that is what decided this.
 * `host-units.ts` calls `git log --all` (`addedOnSomeRef`), so importing it here puts a `history`
 * requirement into `work-gate.ts` -- and this file is reached by `row-claim/runner-rule.ts`, which most
 * of the packaging suite imports. MEASURED with `deriveClosureRequirements` over
 * `packages/lab/src/packaging/*.test.ts`, at `518de0e32` and again with the import added: **4 files
 * derive a `history` requirement, and 28 do with it.** Twenty-four test files that will never call this
 * code would owe a `History: full` declaration, paid by whoever next opens a PR whose Acceptance happens
 * to name one of them. A process boundary costs one node startup per tick and leaves the closure at 4.
 *
 * AND IT BUYS A PROPERTY THE IMPORT CANNOT. The session this cause wakes is told to run
 * `pnpm run host:check`; this spawns THE SAME FILE IN THE SAME TREE, so the gate and the human can never
 * disagree about what drifted. Two readers of one question is the defect this repository keeps
 * re-finding one level up, and here there is exactly one.
 *
 * `null` FOR EVERY UNREADABLE CASE AND NEVER `[]`, which is `readPrs`'s rule for its reason: a spawn
 * that failed, a non-zero exit, unparseable output and `asked: false` are all "not asked", while `[]` is
 * a host that was looked at and is correct. Both produce silence here and they are NOT the same claim --
 * `hostDriftOrders` keeps them apart, and `driftReport` keeps them apart for the CLI's reader.
 */
/**
 * agent-org#1187: `RECHECK_FLAG` (`holds.recheck`), READ WHERE THE ORDERS ARE DECIDED. It is a machinery flag, so its switch is `machinery:flag`, which writes the canary state and not a
 * declaration, and `perPullRequestOrders` passed nothing to `sharedFileOrders`: the re-check shipped OFF with nothing able to turn it on (#1165). Read HERE, in `decide`, because the
 * primary tick and every other scope's tick (`scopeTick`) both end in `decide`, so one read covers both and neither call site can be the one that forgot.
 * @param [asked] the reading a caller already has; a test or a replay passes it so the answer does not move with the host's state directory
 * @param [read] the flag's state; absent, unreadable or malformed is OFF (`readReenqueueState`). Its line about an unreadable file names `queue.reenqueueEjected`, which the
 *   gate's own read of the same file already said once this tick, so it is dropped here rather than repeated per scope under another flag's name.
 */
export function recheckFlagOn(asked?: boolean, read: () => CanaryState = () => readReenqueueState(REVIEWER_STATE_DIR, () => undefined)): boolean {
  return asked ?? machineryFlagOn(read(), RECHECK_FLAG);
}

/**
 * agent-org#1325: `PR_OWNER_ROUTING_FLAG` (`prs.ownerRouting`), READ WHERE THE ORDERS ARE DECIDED, for `recheckFlagOn`'s reason. Absent, unreadable or malformed is OFF: every order as it was.
 * @param [asked] the reading a caller already has; a test passes it so the answer does not move with the host's state directory
 * @param [read] the flag's state, as `recheckFlagOn` reads it
 */
export function prOwnerRoutingFlagOn(asked?: boolean, read: () => CanaryState = () => readReenqueueState(REVIEWER_STATE_DIR, () => undefined)): boolean {
  return asked ?? machineryFlagOn(read(), PR_OWNER_ROUTING_FLAG);
}

/**
 * agent-org#1268: `ROW_REVIEW_SKILL_FLAG` (`review.rowReviewSkill`), READ WHERE THE ORDERS ARE DECIDED, for `recheckFlagOn`'s reason: `decide` ends every scope's tick, so one read covers
 * the primary and the other scopes. Absent, unreadable or malformed is OFF, which is the reviewer's order as it was.
 * @param [asked] the reading a caller already has; a test or a replay passes it so the answer does not move with the host's state directory
 * @param [read] the flag's state, as `recheckFlagOn` reads it
 */
export function rowReviewSkillFlagOn(asked?: boolean, read: () => CanaryState = () => readReenqueueState(REVIEWER_STATE_DIR, () => undefined)): boolean {
  return asked ?? machineryFlagOn(read(), ROW_REVIEW_SKILL_FLAG);
}

/**
 * agent-org#1185: `SAME_HEAD_REFAIL_FLAG` (`checks.sameHeadRefail`), READ WHERE THE ORDERS ARE DECIDED, for `recheckFlagOn`'s reason. Absent, unreadable or malformed is OFF, which
 * is the key a red head has always had.
 * @param [asked] the reading a caller already has; a test or a replay passes it so the answer does not move with the host's state directory
 * @param [read] the flag's state, as `recheckFlagOn` reads it
 */
export function sameHeadRefailFlagOn(asked?: boolean, read: () => CanaryState = () => readReenqueueState(REVIEWER_STATE_DIR, () => undefined)): boolean {
  return asked ?? machineryFlagOn(read(), SAME_HEAD_REFAIL_FLAG);
}

export function readHostDrift(): { unit: string; problem: string; detail: string; }[] | null {
  const run = spawnSync(process.execPath, [hostUnitsEntry(), "--json"], { encoding: "utf8" });
  if (run.status !== 0 || typeof run.stdout !== "string") return null;
  try {
    const parsed = JSON.parse(run.stdout);
    return parsed?.asked === true && Array.isArray(parsed.findings) ? parsed.findings : null;
  } catch {
    // UNPARSEABLE IS NOT CLEAN. A future `host:check` that prints a warning before its JSON lands here,
    // and the only safe reading of output this function does not understand is that it did not ask.
    return null;
  }
}

/**
 * The lab jobs that ended for a row (#2729), or `null` when the directory exists and cannot be read -- SAID on stderr, and
 * emitting nothing, since "could not look" is not "nothing ended". A local disk read: it adds nothing to `GH_READS`.
 */
export function labJobRecordsOrSay(read: typeof readLabJobRecords = readLabJobRecords) {
  try {
    return read({ skipped: (file) => process.stderr.write(`SKIPPED lab job record ${file}: unreadable or not schema 1\n`) });
  } catch (err) {
    process.stderr.write(`COULD NOT READ lab job records: ${String((err as any)?.message ?? err).split("\n")[0]}\n`);
    return null;
  }
}

/**
 * The lab jobs dispatched and not yet ended (#3007), or `null` when the read was refused -- SAID on stderr, and `null`, never `[]`: an
 * empty list reads as "nothing waits". A local `ps`: it adds nothing to `GH_READS`.
 */
export function dispatchedLabJobsOrSay(read: typeof readDispatchedLabJobs = readDispatchedLabJobs) {
  try {
    return read();
  } catch (err) {
    process.stderr.write(`COULD NOT READ dispatched lab jobs: ${String((err as any)?.message ?? err).split("\n")[0]}\n`);
    return null;
  }
}

/**
 * `readRowsOffBoard`, saying on stderr when it could not ask (split out of `main`, which sits on `complexity`'s limit).
 * A refused read emits no order and MUST NOT read as a clean board, so the difference is written where the tick log reads.
 *  @param [pools] where the read leaves the GraphQL pool it saw (#3448)
 *  @param [run] the `gh` call, the real one unless a test hands it another
 */
export function rowsOffBoardOrSay(log: (line: string) => void = (line) => process.stderr.write(line), pools: import("../org-health.ts").PoolReading[] = [],
  run: typeof defaultRun = defaultRun) {
  const facts = readRowsOffBoard(run, pools);
  if (facts === null) {
    log("CANNOT ASK which open rows are off Project 1: the read was refused. row-off-board was NOT evaluated "
      + "this tick, and that silence is not a clean board.\n");
  }
  return facts;
}

/**
 * A CLAIMED row `blockerClearedOrders` would ask about -- the same conditions that function screens
 * with EXCEPT `resumed`, which needs `openPrs` that this gate site does not carry (`main`/`trackerReadings`
 * read `closings` before `code.prs` exists in a split-repo scope, #2618). Ignoring it makes this a
 * SUPERSET of `blockerClearedOrders`' own population, never a narrower one: an already-resumed row pays
 * for a `closings` read it turns out not to need, exactly as `unstaged first ask` already tolerates for a
 * refused one.
 */
export function anyBlockerClearingCandidate(rows: any[], today: string = todayIso(), nowMs: number = Date.now()): boolean {
  return (rows ?? []).some((row) => sessionOf(row) && labelsOf(row).includes(CLAIM_LABEL)
    && declaredBlockers(row) !== null && !holderWaitingOn(row, today, nowMs));
}

/**
 * a11ign#5169 (the wiring of #5128): THE TICK HOLDS THE GRAPHQL BUDGET AND SAYS WHAT IT SPENT. `gate.restConditional` is the marker file
 * (`restConditionalOn`); off, nothing here runs and the gate's reads are the ones it has always made.
 *
 * A CAUSE OVER ITS SHARE IS CUT BACK FIRST. The cap is one number for the whole tick, so without more one cause's runaway (a `pr list` per repository, say)
 * would spend what the others needed and the refusals would land on whoever asked last. A cause that already holds more than `CAUSE_SHARE` of the cap is
 * refused once the tick has spent `CUT_BACK_FROM` of it, so the last quarter is for causes still under their share; below that line nobody is refused for
 * the share, and at the cap everybody is (`budgetOf`).
 */
export const CAUSE_SHARE = 0.5;
export const CUT_BACK_FROM = 0.75;

export function cutBackFirst(budget: Budget): Budget {
  return {
    ...budget,
    spend(cause: string, points: number): boolean {
      const { total, cap, byCause } = budget.summary();
      const overShare = (byCause[cause] ?? 0) > cap * CAUSE_SHARE;
      if (overShare && total + points > cap * CUT_BACK_FROM) return false;
      return budget.spend(cause, points);
    },
  };
}

/** The two lines the tick leaves for the live hour (#5169): the GraphQL spend by cause, and how many of the REST reads came back `304`. */
export function tickReadingLines(budget: Budget, rest: { asked: number; notModified: number; }): string[] {
  return [budgetLine(budget.summary()), `gate-rest: ${rest.notModified} of ${rest.asked} conditional reads answered 304`];
}

/**
 * EACH TICK IS ITS OWN PROCESS, so import time is the start of the tick and `exit` is its end (`process.exit` paths included). Held at import and not in
 * `main`, which lives in `work-gate.ts`; the flag is read once here, so a change lands on the next tick and never mid-tick.
 */
function holdBudgetForThisTick(): void {
  if (!restConditionalOn() || !isGateProcess()) return;
  holdTickBudget(cutBackFirst(tickBudget));
  process.on("exit", () => process.stderr.write(`${tickReadingLines(tickBudget, restReadsOfTick()).join("\n")}\n`));
}
holdBudgetForThisTick();

/**
 * THE ENUMERATION: what one scope's two lanes answered. `readPrs` and `readOpenRows` (and the Ready, backlog and chairman
 * reads beside them) were the reads that assumed one repository; here each is asked of the scope's own, through `run`, which
 * is handed the repository as a second argument. EACH LANE IS `null` WHEN ITS READ WAS REFUSED and `[]` when the scope has no
 * such repository, so "could not ask" and "nothing there" never share a value (#1286), and a refusal in one scope
 * is visible beside another scope's answer instead of taking it down.
 */
export function readLanes(scope: Scope, run: (args: string[], repo?: string) => string = defaultRun) {
  const codeRepo = aimOf(scope, scope.code);
  const trackerRepo = aimOf(scope, scope.tracker);
  const aimed = (repo: string | undefined): (args: string[]) => string => standingFor(run, (args: string[]) => run(args, repo));
  // #5169: a `run` that is not the gate's own stands for `gh` (a test's), and is never given a REST read it did not make.
  const conditional = (repo: string | undefined) => (isGhRun(run) ? conditionalFor(repo) : null);
  const lane = (part: ScopeRepository | null, read: (run: (args: string[]) => string) => any[] | null) => (part === null ? [] : tagged(read(aimed(aimOf(scope, part))), scope.key, aimOf(scope, part)));
  return {
    prs: lane(scope.code, (aim) => readPrs(aim, conditional(codeRepo))),
    readyRows: lane(scope.tracker, (aim) => readReadyRows(aim)),
    promotableRows: lane(scope.tracker, (aim) => readPromotableRows(aim)),
    chairmanBlocked: lane(scope.tracker, (aim) => readChairmanBlocked(aim)),
    openRows: lane(scope.tracker, (aim) => readOpenRows(aim, conditional(trackerRepo))),
    codeRepo, trackerRepo,
  };
}

/**
 * The words that tell an agent WHICH repository a keyed order is about, appended to its prompt. A prompt names `gh` commands with
 * a bare number (`gh issue edit 7 ...`), and the session that runs one in the primary's checkout would edit the PRIMARY's row 7.
 */
function repositoryNote(scope: Scope) {
  const repos = [scope.code && `code \`${scope.code.repo}\``, scope.tracker && `rows \`${scope.tracker.repo}\``].filter(Boolean).join(", ");
  return `\n\nREPOSITORY \`${scope.key}\` (${repos}). A number in this order belongs to THAT repository, not the primary's: put `
    + "`--repo <owner/name>` on every `gh` command that names one, and read its name as `<key>#<n>`.";
}

/**
 * The orders and readings of ONE NON-PRIMARY SCOPE, made from its own lanes. The primary project's tick is `main`'s own, and
 * stays where it is, so one declared project makes the calls it made before and the orders it made before.
 *
 * WHAT IT DOES NOT ASK, and why (each is the primary project's, or a later row's): the local git reads (`rowBranches`, claim
 * stalls) look at THIS checkout and its worktrees; `hostDrift`, the disk and the reviewer's credentials are
 * facts about the host; the scope's OWN `main` is asked (`codeReadings`' `trunkRed`, #3079) and the primary's is not; and Project-1 membership names a board, which 3d and 3f make a
 * declaration's. Each is passed as `undefined`, which `decide` reads as "not asked", so nothing here invents a reading.
 *
 * @param [read] the lanes, when the caller has already asked. #3095: `siblingPrs` are the
 *   open pull requests of the OTHER declared code repositories (already read, so the comparison costs no call), which B4 compares a row with too
 * @param [readings] the per-tick reads beyond the lanes; a test hands stubs, so no `gh` is spawned
 * #4386: `home` is the PRIMARY tracker's open rows and repository, which a scope with NO tracker of its own (agent-org's) takes its pull requests' owners from.
 * @returns `defects`: the pull requests the ladder could not own though they name a live claimant; `trunkRed`: the scope's `main` as read, for the failure ledger (#4475), and `repo`: the code repository it is the `main` of (agent-org#674: a green reading carries no repository of its own, and the ledger ends a standing red by it)
 */
export function scopeTick(scope: Scope, drain: boolean, read: ReturnType<typeof readLanes> & { siblingPrs?: any[]; home?: HomeRows; } = readLanes(scope), readings: { code: typeof codeReadings; tracker: (lists: { allOpen: any[]; rows: any[]; }) => Omit<ReturnType<typeof trackerReadings>, "chairmanRows"> & { chairmanRows?: Set<number>; }; } = { code: codeReadings, tracker: trackerReadings }, identities?: DeclaredIdentities): { orders: any[]; blocked: any[]; refused: string[]; defects: ResolverDefect[]; trunkRed: ReturnType<typeof readScopeTrunkRed>; repo: string | undefined; } {
  const { prs, readyRows, promotableRows, chairmanBlocked, openRows } = read;
  const refused = [
    ...(prs === null ? [`the pull-request list of ${scope.code?.repo}`] : []),
    ...(readyRows === null ? [`the Ready rows of ${scope.tracker?.repo}`] : []),
  ];
  const openPrs = prs ?? [];
  const rows = readyRows ?? [];
  const allOpen = openRows ?? [];
  const code = inRepo(read.codeRepo, () => readings.code(openPrs, scope));
  const tracker = scope.tracker === null ? NO_TRACKER_READINGS : inRepo(read.trackerRepo, () => readings.tracker({ allOpen, rows }));
  const prFiles = comparablePrFiles([...openPrs, ...(read.siblingPrs ?? [])], { trackerRepo: scope.tracker?.repo });
  // WHAT THE TRACKER READINGS RETURN IS TAGGED HERE, not inside them: an epic or a closed row that carried no key would make `epic-7` and
  // `answer-owed/row-7` the primary's, whatever the reading that produced it.
  const mark = (list: any[] | null) => tagged(list, scope.key, read.trackerRepo) ?? [];
  const owned = ownedPrsOf(scope, code.prs, { own: allOpen, home: read.home });
  const orders = decide({ prs: owned.prs, readyRows: rows, promotableRows: promotableRows ?? [],
    chairmanBlocked: chairmanBlocked ?? [], prFiles, drain, required: code.required, baseTip: code.baseTip,
    epics: mark(tracker.epics), answerOwed: rowsOwingAnswers({ openRows: allOpen, openPrs, closedRows: mark(tracker.closedRows) }),
    openRows: allOpen, claimedComments: tracker.claimedComments, unarmed: code.unarmed, closings: tracker.closings, trunkRed: code.trunkRed,
    // #1085: a keyed tracker's chairman rows are offered first, as a home row's are (#4524); a scope with no tracker has none to ask about
    offerHierarchy: tracker.chairmanRows === undefined ? undefined : { chairmanRows: tracker.chairmanRows },
    key: scope.key, repo: scope.code?.repo ?? scope.tracker?.repo, identities });
  return { orders: orders.map((order) => ({ ...order, prompt: `${order.prompt}${repositoryNote(scope)}` })),
    blocked: partitionUnclaimed(rows, prFiles, { rowBranches: null, openRows: allOpen }).blocked, refused, defects: owned.defects, trunkRed: code.trunkRed, repo: scope.code?.repo };
}

/** The rows a scope without a tracker finds its pull requests' owners in: the primary tracker's, with the repository they live in and where the session labels' ending is read. */
export type HomeRows = { rows: any[]; repo: string; io?: Parameters<typeof withScopedPrOwners>[2]["io"]; };

/**
 * #4386: THE OWNER OF EACH PULL REQUEST OF A NON-PRIMARY SCOPE, by the ladder the primary's use -- the scope's own label, the row it names
 * (GitHub's resolution or a `Closes`/`Row:` line written `<owner/repo>#<n>`), then the row its branch number names. Before this `codeReadings`
 * never ran it, so every agent-org pull request ended at `ceo` ("NOBODY COULD BE NAMED") however plainly its branch named a live worker.
 *
 * THE ROWS ARE THE SCOPE'S OWN TRACKER'S when it declares one, else the primary's (`home`). With neither, the pull requests are returned as they were:
 * nothing is invented from rows nobody read. `defects` are the pull requests that still ended at `ceo` while naming a live claimant.
 */
function ownedPrsOf(scope: Scope, prs: any[], { own, home }: { own: any[]; home?: HomeRows }): { prs: any[]; defects: ResolverDefect[] } {
  const rows = scope.tracker === null ? home : { rows: own, repo: scope.tracker.repo, io: home?.io };
  if (rows === undefined) return { prs, defects: [] };
  const owned = withWaitingEdges(withScopedPrOwners(prs, rows.rows, { rowsRepo: rows.repo, io: rows.io }), rows.rows, { rowsRepo: rows.repo, dir: REVIEWER_STATE_DIR }); // #4606: a wait on an open edge, at the head it began at
  return { prs: owned, defects: resolverDefectsOf(owned, rows.rows, rows.repo) };
}

/** The primary tracker's open rows, handed to the scopes that have none of their own; `undefined` when the declaration names no primary tracker. */
export function homeRowsOf(rows: any[]): HomeRows | undefined {
  const repo = homeProjectDeclaration().tracker.find((entry) => entry.key === "")?.repo;
  return repo === undefined ? undefined : { rows, repo, io: { agents: liveWorkspaceLabels, ended: endedSessionLabels } };
}

/**
 * #4450 (move 1a of #4437): the tick's failure events go to `failure-ledger` (`failure-recorders.ts`). #4475: a keyed scope's `main` is recorded too, from the reading `scopeTick` already holds
 * (`keyedTrunkReds`, one per scope, each with the repository it is of: `red` is `undefined` for a scope with no code repository or a `main` that could not be read, `null` for a green one) -- no second ask of GitHub.
 */
export function recordTickFailures({ trunkRed, prs, keyedTrunkReds = [], stateDir = REVIEWER_STATE_DIR, now = Date.now() }: { trunkRed: ReturnType<typeof readTrunkRed>; prs: any[]; keyedTrunkReds?: { repo: string | undefined; red: ReturnType<typeof readScopeTrunkRed>; }[]; stateDir?: string; now?: number; }): void {
  recordFailuresOf({ trunkRed, keyedTrunkReds, prs, stateDir, now, ownerOf: ownerOfPr, homeRepo: REPO });
}

/**
 * The reads about a scope's PULL REQUESTS that are made per tick beyond the list itself, and about its `main` (#3079). Run inside `inRepo` for the code repository.
 * `trunkRed` is `undefined` for a scope with no code repository or a `main` that could not be read, and `null` for a green one: neither emits an order, but only a `null` ends a standing red in the failure ledger (agent-org#674).
 *   @param [trunkRed] the scope's `main`, when the caller has already asked
 */
function codeReadings(openPrs: any[], scope: Scope, trunkRed: ReturnType<typeof readScopeTrunkRed> = readScopeTrunkRed(scope)) {
  const required = requiredWhenNeeded(openPrs);
  const split = readArmingOf(openPrs, required);
  return { prs: withStaleRefusals(withVerifyStamps(withEjections(withEvidenceLabelAges(withPatchIds(withCheckMarkers(openPrs, defaultRun, required), defaultRun, required)), split?.ejections), { checkout: verifyCheckoutOf(scope.key) }), required), required, baseTip: baseTipWhenRed(openPrs),
    unarmed: split === null ? null : split.unarmed,
    trunkRed };
}

/**
 * Whether a scope's own `main` is red, as `readTrunkRed` says it -- `undefined` for a scope with no code repository, which has no `main` to ask.
 */
export function readScopeTrunkRed(scope: Scope, run?: (args: string[]) => string) {
  return scope.code === null ? undefined : readTrunkRed(run, trunkOfCodeRepository(scope.key, scope.code.repo));
}

/**
 * #3019: STAMP `ejection` ON THE PULL REQUESTS THE QUEUE EJECTED, so `stallReasonOf` -- which reads only the pull request --
 * can classify them. Absent is not `null`: a pull request nobody read stays unstamped and is never accused.
 */
export function withEjections(prs: any[], ejections: Map<number, unknown> | undefined) {
  if (!ejections || ejections.size === 0) return prs;
  return prs.map((pr) => (ejections.has(Number(pr?.number)) ? { ...pr, ejection: ejections.get(Number(pr.number)) } : pr));
}

/**
 * What a scope with NO tracker of its own reads from a tracker: nothing, in the shapes an empty tracker returns. `inRepo(undefined)` means the
 * AMBIENT repository, which is the primary's, so asking would hand the primary's closed rows to a scope that has no such rows, and each would
 * come back as an `answer-owed` order naming a repository where the row does not exist (#3493).
 */
const NO_TRACKER_READINGS = { claimedComments: [], epics: [], closedRows: [], closings: null, chairmanRows: undefined };

/**
 * #3095: THE OPEN PULL REQUESTS OF EVERY DECLARED CODE REPOSITORY BUT ONE -- the one `skip` names (the primary's own, `undefined`, or a
 * scope's key) -- each tagged with the repository it came from. B4 at the claim compares a row with ALL of them (`lookupOpenPrFiles`, #2617),
 * so a gate that compares with fewer offers every tick what the claim refuses every tick. A lane that could not be read contributes nothing:
 * THE GATE FAILS OPEN and the claim stays the authority, and `scopeTick`'s `refused` names the repository (`unreadLanes`).
 *  @param [skip] the key of the scope whose own list is not a sibling
 */
export function pullRequestsOfOthers(others: { scope: Scope; read: ReturnType<typeof readLanes>; }[], skip?: string): any[] {
  return others.filter(({ scope }) => scope.key !== skip).flatMap(({ read }) => read.prs ?? []);
}

/**
 * Every NON-PRIMARY scope, ticked from lanes already read. Each is told the pull requests of every OTHER declared code repository -- the
 * primary's (`primaryPrs`) and its peers' -- for B4 (#3095).
 *
 * @param [home] #4386: the primary tracker's rows, which a scope without a tracker names its pull requests' owners from
 */
export function otherScopeTicks(drain: boolean, others: { scope: Scope; read: ReturnType<typeof readLanes>; }[], primaryPrs: any[], home?: HomeRows) {
  // (#3566, slice 2) Each repository's `main` is asked ONCE here, together, and handed to its tick: seven `ci.yml` reads were 3.5 s of waiting in a row.
  const trunkReds = readWithFirstWaveTogether((through) => others.map(({ scope }) => readScopeTrunkRed(scope, through)));
  return others.map(({ scope, read }, at) => scopeTick(scope, drain, { ...read, siblingPrs: [...primaryPrs, ...pullRequestsOfOthers(others, scope.key)], home },
    { code: (openPrs, ticked) => codeReadings(openPrs, ticked, trunkReds[at]), tracker: trackerReadings }));
}

/**
 * Every lane this tick could not read, named -- the primary's own two and each other scope's. A refusal in one repository is
 * REPORTED beside the orders the others produced and never drops them (#2618).
 */
export function unreadLanes({ prs, readyRows, others }: { prs: any[] | null; readyRows: any[] | null; others: { refused: string[]; }[]; }): string[] {
  return [...(prs === null ? ["the pull-request list"] : []), ...(readyRows === null ? ["the Ready rows"] : []),
    ...others.flatMap((tick) => tick.refused)];
}

/**
 * How many of THIS TICK's OWN reads GitHub refused. `readPrs`, `readReadyRows`, `readPromotableRows`,
 * `readChairmanBlocked`, `readOpenRows`, the claimed-row comments and the board read each make their OWN
 * call, sharing no socket and no endpoint with the others -- so one going quiet is that endpoint's own
 * trouble, needing no shared story. Counted here rather than asked per read, because the question this
 * answers is not "was THIS read refused" (every read already fails open at its own site: `promotableRows
 * ?? []`, `offBoard`'s "emits nothing") but "how many were, in the SAME tick" (#2685).
 */
export function refusedReadCount(reads: (any[] | null)[]): number {
  return reads.filter((read) => read === null).length;
}

/**
 * TWO, chosen and not measured, and deliberately no higher. `deliver`'s own shared-resource shape
 * (#2256) put ELEVEN causes at the cap over ONE session's unavailability -- the session was the only
 * thing all eleven had in common, and nothing waited for a third before treating it as one outage. A bar
 * set any higher here would miss the same shape for this shared resource.
 */
export const SHARED_OUTAGE_READS = 2;

/**
 * Did GitHub itself refuse THIS TICK's reads -- as opposed to one lane's own trouble? Neither `outageOf`
 * (a causeKey's own addressed SESSION being unavailable, #2256) nor #2031's pool-exhaustion guard asks
 * this: both ask about a SESSION or a POOL, never about the reads a tick itself just made.
 */
export function sharedReadOutage(refusedCount: number): boolean {
  return refusedCount >= SHARED_OUTAGE_READS;
}

/**
 * Mark every order this tick emits with `outageNow` when this tick's own reads carry the shared-outage
 * shape (`sharedReadOutage`) -- ONE fact, attached beside every order, so `wake.ts`'s `deliver` can tell
 * several causes reaching `MAX_DELIVERIES` in the SAME run for ONE shared reason apart from N causes each
 * independently and truly stuck (#2685). Untouched when there is no outage, so an ordinary order stays
 * byte-identical to what it always was.
 */
export function markOutageReads(orders: any[], outage: boolean): any[] {
  return outage ? orders.map((order) => ({ ...order, outageNow: true })) : orders;
}

/**
 * THIS TICK'S OWN SHARED-OUTAGE READING (#2685): every read whose refusal is distinguishable from "found
 * nothing", from the primary scope and every other declared one (`others`' own `refused` already counts
 * each of ITS unread lanes by name, the same way `unreadLanes` reports them).
 */
export function outageThisTick({ prs, readyRows, promotableRows, chairmanBlocked, openRows, claimedComments, offBoard, others, primaryRead = true }: {
        prs: any[] | null; readyRows: any[] | null; promotableRows: any[] | null; chairmanBlocked: any[] | null;
        openRows: any[] | null; claimedComments: any[] | null; offBoard: any[] | null; others: { refused: string[]; }[]; primaryRead?: boolean;
    }): boolean {
  // agent-org#1401: a primary the pacing SKIPPED has `null` tracker lanes BY DESIGN (`primaryLanes`), which is not a refusal and is not counted as one
  const primaryLanes = primaryRead ? [promotableRows, chairmanBlocked, openRows] : [];
  return sharedReadOutage(refusedReadCount([prs, readyRows, ...primaryLanes, claimedComments, offBoard])
    + others.reduce((n, tick) => n + tick.refused.length, 0));
}

/**
 * SAY WHICH LANES WENT UNREAD AND END THE TICK `PARTIAL` -- the orders already printed stay real, and none is dropped.
 *
 * `refused` and `paced` are the split `tickLanes` holds (agent-org#1414). A tick whose every unread lane was SKIPPED BY DESIGN (`paced`) says so and exits `PACED`,
 * because "could not read" about a lane nobody asked is a fault that never clears; one refused lane keeps the `PARTIAL` wording and code, whatever else was paced.
 */
export function exitPartial({ refused, paced }: { refused: string[]; paced: string[]; }, delivered: number): never {
  const unread = [...refused, ...paced];
  const lanes = `${unread.length === 1 ? "that lane was" : "those lanes were"} NOT examined and may hold work.`;
  if (refused.length === 0) {
    process.stderr.write(`PARTIAL: ${paced.length} lane(s) skipped by pacing, none refused: ${paced.join(" and ")}. The ${delivered} order(s) above are real; ${lanes}\n`);
    process.exit(EXIT.PACED);
  }
  process.stderr.write(`PARTIAL: could not read ${unread.join(" and ")}. The ${delivered} order(s) above are real; ${lanes}\n`);
  process.exit(EXIT.PARTIAL);
}

/**
 * #4064: PROMOTE THE CLEARED ROWS THEIR FILERS DECLARED `Ready-when-unblocked: yes`, in place, and hand the same list back. `unclaimedClearings` is the population the `unclaimed-blocker-cleared`
 * order asks about, so the two cannot disagree on "cleared"; a promoted row leaves it because its tick object now carries `ready`. Writes nothing for a row without the line.
 */
export function promotedWhenUnblocked(rows: any[]): any[] {
  const now = Date.now();
  const clearings = unclaimedClearings(rows, todayIso(), now).filter(({ row }) => declaresReadyWhenUnblocked(row.body));
  if (clearings.length > 0) reportReadyWhenUnblocked(promoteReadyWhenUnblocked({ clearings, notStartable: NOT_STARTABLE, now }, githubReadyIo(defaultRun)), (line) => process.stderr.write(line));
  return rows;
}

/**
 * #3451: what `decide`'s `blocker-cleared` cause did NOT order, said on the tick's log the way `SHELVED row #n:` says a shelved row, so a row that stopped being asked is
 * findable. A second pure reading of the same arguments (no read, no write) rather than a side channel out of `decide`, which returns orders and nothing else.
 */
export function reportClearingDrops({ openRows, prs, closings, claimFacts }: Parameters<typeof decide>[0]) {
  process.stderr.write(blockerClearedReading((openRows as any[]), todayIso(), Date.now(), { openPrs: prs, closings, claimFacts }).log.join(""));
}

/**
 * `claimStallsNow`'s orders beside the facts it built them from, as the two arguments `decide` takes: the facts reach `blockerClearedOrders` and the orders reach
 * `claim-stalled`. `claimFacts` stays `undefined` when the tick never reported one, which `blockerClearedReading` reads as "not asked".
 *
 * @param otherScopes the other repositories' lanes, already read this tick (#3566): their open lists are not asked again
 */
export function claimStallsWithFacts(rows: Parameters<typeof claimStallsNow>[0], claimedComments: Parameters<typeof claimStallsNow>[1], prs: Parameters<typeof claimStallsNow>[2], otherScopes: ReturnType<typeof readOtherScopes>,
  seams: Pick<NonNullable<Parameters<typeof claimStallsNow>[3]>, "tick" | "merged" | "elsewhere" | "log"> & { run?: (args: string[], repo?: string) => string; openRowsPaced?: boolean; } = {},
  // #1183: the wait facts this tick read, so a holder's body `Waiting-for:` is read against the same facts the ready rows are
  waitFacts: import("../wait-condition.ts").WaitFacts | null = null): { claimStalls: ReturnType<typeof claimStallsNow>; claimFacts: import("../work-gate/claim-stall-tick.ts").ClaimFactsOfTick | null | undefined; } {
  let claimFacts: import("../work-gate/claim-stall-tick.ts").ClaimFactsOfTick | null | undefined;
  const { run, openRowsPaced = false, ...stubs } = seams;
  // agent-org#747: `trackers` is every OTHER declared tracker's claimed rows, from the lanes already read, so the stall pass evaluates their holders too
  const claimStalls = claimStallsNow(rows, claimedComments, prs, { onFacts: (facts) => { claimFacts = facts; }, openRowsPaced,
    elsewhere: () => readElsewherePrs(undefined, undefined, otherScopes), trackers: () => otherTrackerClaims(otherScopes, run), waitFacts, ...stubs });
  return { claimStalls, claimFacts };
}

/**
 * agent-org#747: THE CLAIMED ROWS OF EVERY OTHER DECLARED TRACKER, which the stall pass evaluates beside the home tracker's. `rows` are the lanes' own open rows
 * (already read this tick, and `null` for a refusal, which the pass says as unread); the comments of the claimed ones are one `issue list` of THAT tracker's
 * repository, asked only for a tracker that holds a claimed row, so a quiet tracker costs nothing. A scope with no tracker of its own has no rows to claim.
 *
 * @param otherScopes the other repositories' lanes, already read this tick (#3566)
 * @param [run] the `gh` seam, handed the repository to aim at as its second argument (a test stubs it)
 */
export function otherTrackerClaims(otherScopes: ReturnType<typeof readOtherScopes>, run: (args: string[], repo?: string) => string = defaultRun): import("../work-gate/claim-stall-tick.ts").TrackerClaims[] {
  return otherScopes.flatMap(({ scope, read }) => {
    if (scope.tracker === null) return [];
    const { repo } = scope.tracker;
    const claimed = read.openRows !== null && read.openRows.some((row) => labelsOf(row).includes(CLAIM_LABEL));
    return [{ key: scope.key, repo, rows: read.openRows, claimedComments: claimed ? readClaimedRowComments((args) => run(args, repo), repo) : null }];
  });
}

/**
 * #3535: A CLOSED ROW'S CLAIM RIDES THE SAME ORDERS as the open claims': the release (and the interrupt) is one more `claim-stalled` order. The read was made with the
 * follow-ups (`closedClaimsWhenWorkerListed`), so this costs no call; `claimFacts` is untouched, because it describes the OPEN claims the blocker-cleared reading is about.
 */
export function withClosedClaims(stalls: ReturnType<typeof claimStallsWithFacts>, read: ReturnType<typeof closedClaimsWhenWorkerListed>): ReturnType<typeof claimStallsWithFacts> {
  const { home: closedClaims, keyed } = splitClosedClaimsByTracker(read);
  return { ...stalls, claimStalls: [...stalls.claimStalls, ...closedClaimsNow(closedClaims, { trackerRepo: repoNow(), stateDir: REVIEWER_STATE_DIR }), ...keyedClosedClaimOrders(keyed)] };
}

/**
 * agent-org#757: THE CLOSED CLAIMS OF THE HOME TRACKER, and those of each OTHER tracker by key. The home part keeps `rows: null` (an unread list, said by `closedClaimOrders`) and
 * the listing it was decided from; a keyed row is never decided as the home tracker's of the same number.
 */
function splitClosedClaimsByTracker(read: ReturnType<typeof closedClaimsWhenWorkerListed>): { home: ReturnType<typeof closedClaimsWhenWorkerListed>; keyed: Map<string, { repo: string; rows: KeyedClosedClaimedRow[]; agents: { label: string; status: string; }[] | null; }>; } {
  const keyed = new Map<string, { repo: string; rows: KeyedClosedClaimedRow[]; agents: { label: string; status: string; }[] | null; }>();
  if (read === null || read.rows === null) return { home: read, keyed };
  for (const row of read.rows) {
    if (row.tracker === undefined) continue;
    const entry = keyed.get(row.tracker.key) ?? { repo: row.tracker.repo, rows: [], agents: read.agents };
    entry.rows.push(row);
    keyed.set(row.tracker.key, entry);
  }
  return { home: { ...read, rows: read.rows.filter((row) => row.tracker === undefined) }, keyed };
}

/**
 * agent-org#757: A KEYED INSTANCE'S CLOSED ROW ENDS ITS CLAIM IN THE SAME PASS as a bare-number one's. The decision is `closedClaimsNow`'s own, asked of that tracker's repository
 * (the `ownsPr` rungs name a pull request by it) with a keyed label counted as the per-row instance it is (`familyMember`, so a `working` one is interrupted). The release carries the
 * tracker's key (agent-org#834), which is how `performRelease` reads, comments on and declines the row in THAT tracker; its subject and delivery key are spelled as the stall
 * pass spells another tracker's row (`agent-org#730`), so the two passes' orders for one row are one entry in the ledger.
 */
function keyedClosedClaimOrders(keyed: ReturnType<typeof splitClosedClaimsByTracker>["keyed"]): import("../claim-stall.ts").StallOrder[] {
  return [...keyed].flatMap(([key, { repo, rows, agents }]) => closedClaimsNow({ rows, agents }, { trackerRepo: repo, stateDir: REVIEWER_STATE_DIR, isInstance: (session) => familyMember(session) !== null })
    .map((order) => {
      const row = /^row-(\d+)$/.exec(order.subject)?.[1];
      const ref = row === undefined ? null : subjectRef(key, Number(row));
      return { ...order, ...(ref === null ? {} : { subject: `row-${ref}`, causeKey: order.causeKey.replace(/\/row-(\d+)\//, `/row-${ref}/`),
        prompt: `${order.prompt}\n\nTHIS ROW IS \`${ref}\` OF \`${repo}\`, NOT THE PRIMARY'S #${row}: put \`--repo ${repo}\` on every \`gh\` command that names it, and read its number as \`${ref}\`.` }),
      ...(order.release === undefined ? {} : { release: { ...order.release, tracker: key } }) };
    }));
}

/**
 * The open pull requests whose required check has settled red AND which `pr-checks-failing` is already ordering this tick, as
 * `org-health.ts` reads them. THE ORDERS ARE CONSUMED RATHER THAN THE PREDICATE REPEATED: `failingChecksOrder` also excuses a
 * red made only of a superseded run, and a second copy of those exclusions is how a PR is called red by one cause and healthy by
 * another (`mergeCandidates`' argument). BUT THE HOLD'S EXCUSE IS THE ORDER'S AND IS ADDRESSEE-RELATIVE (#2400), so a PR a worker owns
 * and `ceo` holds is still ordered; WHETHER IT IS RED AT ALL is `red-pr.ts`'s `isBrokenRed`, asked here too (#2956), and `redSince`
 * is the EARLIEST BROKEN check's finish (`redSinceOf`), which is when its breakage began.
 *
 * #2996: `holdStands` IS WHETHER A HOLD STILL EXCUSES (`holdExcused`), so a PR whose hold has outlived its reason is red for ITS
 * OWN jobs and is read here even though `failingChecksOrder` excused it: the order excuses the addressee's own hold, which is the
 * label trusted, and a freeze that ended is the case this exists for. A PR with a hold and no order is read only when the hold lapsed.
 */
export function redPrFacts(prs: any[], decided: { cause: string; subject: string; }[], options: { holdStands?: (pr: any) => boolean; } = {}) {
  const ordered = new Set(decided.filter((order) => order.cause === "pr-checks-failing").map((order) => order.subject));
  const asked = (pr: any) => ordered.has(`pr-${subjectRef(pr.repoKey, pr.number)}`) || holdersOf(labelsOf(pr)).length > 0;
  return prs.filter((pr) => asked(pr) && isBrokenRed(pr, options)).map((pr) => {
    const owner = ownerOfPr(pr);
    const login = pr.author?.login;
    return { number: pr.number, owner: owner.source === "ceo" ? null : owner.session,
      redSince: redSinceOf(pr, options),
      // The shared account opens every PR, so "its owner's comment" is a comment by the account that opened it.
      ownerCommentAts: (pr.comments ?? []).filter((c: any) => login && c?.author?.login === login).map((c: any) => Date.parse(c?.createdAt)).filter(Number.isFinite) };
  });
}

/**
 * (#3566, slice 5) THE TRACKER LANES `main` READS AFTER ITS OUTAGE CHECK, ASKED TOGETHER. The backlog, `needs:chairman` and open lists were three
 * synchronous `gh issue list` calls, 3.2 s summed in one gate run; through `readWithFirstWaveTogether` they cost the slowest of the three. The
 * readers, their commands and their parsing are unchanged, so only WHEN the waiting happens moves. They are asked AFTER the check that both
 * `readPrs` and `readReadyRows` were refused, not with it: folding them in would make an outage tick ask three more refused questions. What the batch
 * cannot foresee (a chairman row's events, read once the list is in hand) still runs one at a time, as before.
 */
export function readTrackerLanes(run: (args: string[], repo?: string) => string = defaultRun, batch: typeof runBatch | undefined = run === defaultRun ? runBatch : undefined) {
  return readWithFirstWaveTogether((read) => ({
    promotableRows: readPromotableRows(read),
    chairmanBlocked: readChairmanBlocked(read),
    openRowsRead: readOpenRows(read),
  }), run, batch);
}

/**
 * #3535: A CLOSED ROW'S CLAIM, ASKED ONLY WHEN HERDR LISTS A PER-ROW INSTANCE, FOR THOSE INSTANCES' ROWS. The row that closed is in none of the open lists, and the thing
 * to stop is a `worker-<n>` that only herdr can see. So herdr is read FIRST (a local spawn, once) and the `gh` call is made only when it lists one: a tick of an org
 * running no instance pays no call, and the others pay one, asked inside the follow-ups' wave so its wall time overlaps theirs (`GH_READS.conditionalOnListedWorker`).
 *
 * THREE ANSWERS, NEVER TWO: `null` is NOT ASKED (herdr listed no instance), `{ rows: null }` is ASKED OR NEEDED AND UNREAD (the call was refused, or herdr could not
 * be read, so whether an instance exists is unknown), and `{ rows }` is the closed rows read. The listing rides along because the interrupt is decided from it.
 * @param agents herdr's own listing, or `null` when herdr could not be asked
 */
export function closedClaimsWhenWorkerListed(agents: { label: string; status: string; }[] | null, run: (args: string[], repo?: string) => string = defaultRun,
  log: (line: string) => void = (line) => process.stderr.write(line)): { rows: KeyedClosedClaimedRow[] | null; agents: { label: string; status: string; }[] | null; } | null {
  if (agents === null) return { rows: null, agents };
  // agent-org#757: ONE READ PER TRACKER a listed instance is of. `familyMember` names a keyed label's row and tracker (`worker-agent-org-730` is row 730 of `agent-org`), where
  // `familyNumber` is `null` for it BY DESIGN (730 alone would name the home tracker's row 730) and so asked about no row at all.
  const asked = new Map<string, number[]>();
  for (const { label } of agents) {
    const member = familyMember(label);
    if (member !== null) {
      asked.set(member.key, [...(asked.get(member.key) ?? []), member.number]);
      continue;
    }
    const undeclared = undeclaredFamilyKey(label);
    if (undeclared !== null) log(`closed-claim: ${label} names tracker \`${undeclared}\`, which the project does not declare -- its row was NOT read (nothing says whose row it holds).\n`);
  }
  if (asked.size === 0) return null;
  const rows: KeyedClosedClaimedRow[] = [];
  let answered = 0;
  for (const [key, numbers] of asked) {
    const tracker = key === "" ? undefined : homeProjectDeclaration().tracker.find((t) => t.key === key);
    const read = tracker === undefined && key !== "" ? null : readClosedClaimedRows(numbers, run, tracker, log);
    if (read === null) {
      // #948: a refused read printed its own `closed-claim: the read of <repo> was refused:` line, and this one names the same repository so the pair reads together
      const named = key === "" ? repoNow() : tracker?.repo;
      if (asked.size > 1) log(`closed-claim: the closed rows of ${key === "" ? "the home tracker" : `tracker \`${key}\``} were NOT read this tick (UNREAD, which is not "no closed claim"${named === undefined ? "" : `; the cause is the \`closed-claim: the read of ${named}\` line`}).\n`);
      continue;
    }
    answered++;
    rows.push(...read);
  }
  // `null` ONLY WHEN EVERY READ WAS REFUSED: one tracker's refusal must not hold another's closed rows, and is said above.
  return { rows: answered === 0 ? null : rows, agents };
}

/**
 * #4800: THE ROWS WHOSE `priority:chairman` IS VERIFIED -- the Ready rows AND the claimed ones. A claimed row has left `ready`, so verifying only the Ready rows
 * left a claimed chairman HOLDER out of `chairmanRows`, and `overlapVerdict` walked past it: two chairman rows over one file were both offered and the claim
 * refused the second (#4793). A claimed holder is read exactly as a Ready row is -- the newest labeller decides, and an unreadable history fails closed. The offer
 * tier and the share floor read candidate rows only, so a claimed row in the set changes nothing but what a holder is. @param {any[]} rows the Ready rows
 * @param {any[]} openRows every open row the gate read @param {(args: string[]) => string} [run]
 */
export function readChairmanPriorityOfOffer(rows: any[], openRows: any[] = [], run?: (args: string[]) => string) {
  const readyNumbers = new Set(rows.map((row) => Number(row.number)));
  const claimedRows = openRows.filter((row) => labelsOf(row).includes(CLAIM_LABEL) && !readyNumbers.has(Number(row.number)));
  return run === undefined ? readChairmanPriority([...rows, ...claimedRows]) : readChairmanPriority([...rows, ...claimedRows], run);
}

/** #4524: `main`'s one call for the hierarchy -- the verified chairman rows (a read per labelled row, none when no row is) and the project's declared ranking. @param {any[]} rows @param {any[]} openRows #4800: the claimed rows are read too */
export function offerHierarchyNow(rows: any[], openRows: any[], { run, stateDir = REVIEWER_STATE_DIR, now = Date.now(), emergency = readEmergencyPriorityOption(), refusedOnce }: { run?: (args: string[]) => string; stateDir?: string; now?: number; emergency?: EmergencyPriorityOption; refusedOnce?: boolean; } = {}): OfferHierarchy {
  const { chairmanRows, ignored } = readChairmanPriorityOfOffer(rows, openRows, run);
  // #1456: `CHAIRMAN_REFUSAL_FLAG` is a machinery flag: off, `hierarchyOrders` gets no ledger and tells each refusal as it did; `refusedOnce` is a caller's reading (a test passes it)
  const refusalsOn = refusedOnce ?? machineryFlagOn(readReenqueueState(stateDir, () => undefined), CHAIRMAN_REFUSAL_FLAG);
  // #730: a label the chairman did not add is a ledger incident, written HERE, where the tick builds `ignored`, and not in `readChairmanPriority`, which the claim reads too
  return { chairmanRows, ignored: recordIgnoredChairmanLabels({ ignored, repo: REPO, stateDir, now }), milestoneRanking: homeProjectDeclaration().offerMilestones, ...emergencyHierarchyNow(rows, openRows, { emergency, run, stateDir, now }),
    refusals: refusalsOn ? { stateDir, now, answeredAt: (row, since) => chairmanRowAnsweredByCeo(row, since, run) } : undefined }; // #1456: read only for a row the gate refuses, by `hierarchyOrders`
}

/**
 * agent-org#492 (Phase 1 of a11ign/a11ign#4505): A REPEATING LOG LINE THAT AN OPEN ROW ALREADY CITES DOES NOT WAKE `orchestrator` AGAIN.
 *
 * The detector (`repeating-lines.ts`) offers a line to `orchestrator` to fix, file `ready` or allowlist; once it is FILED, the same line kept waking
 * the seat each time its key window expired, with nothing left to decide. MEASURED 2026-10-10 on the trace store's `repeating-log-line` wakes of the 7
 * days before (the delivered order's first quoted line, normalised as below, against the bodies of the rows open at the wake): 10 of the 56 wakes whose
 * order could be read named a line a row open at that moment cited, 4 of them in this tracker and 6 in `a11ign/agent-org`'s.
 *
 * WHAT "CITES" MEANS: the first `CITE_PREFIX_CHARS` of the line, normalised by `normaliseLine` (numbers, shas and times are one line), occurs in the
 * row's normalised title and body. The prompt cuts a line at 300 characters and a row rarely quotes it whole, so a prefix is the match; a line whose
 * normalised prefix is under `CITE_MIN_CHARS` is never matched, because a short needle cites anything and the failure to avoid is a fault nobody is told
 * about. Every doubt is a wake, as today: an unreadable row, a closed one and a body that no longer carries the line are all "not cited".
 *
 * THE ROWS IN HAND ARE THE CANDIDATES AND THE PORT IS THE ASK. `openRows` were read this tick for the other causes (bodies included), so narrowing
 * costs no call; each candidate is then re-read through the ticket port (`readItem`, level-triggered: act only if it still holds) and a cite counts only
 * when THAT answer is open and still carries the line. One read per cited line per tick, at most `CITE_VERIFY_MAX` for a line. NO ROW IS ASKED PER OPEN
 * ROW: `readOpenItems` carries no body, and `readItem` for each of about 100 rows would be a call apiece on every tick a fault lasts. THE ROWS IN HAND
 * ARE THE PRIMARY'S AND EVERY SCOPE'S THAT DECLARES A TRACKER; `a11ign/agent-org` declares none here, so its rows (6 of the 10 above) are not seen
 * and that line still wakes the seat.
 *
 * THE ROW WRITE is one `postDecision` carrying the count, at the ticks where the run is 30, 60, 120, 240 ... long (`isCountMilestone`): the count moves
 * by one a tick, so the doubling is a schedule that needs no state file, and a day-long fault is five comments and not seven hundred.
 *
 * THE SWITCH: `A11IGN_REPEATING_LINE_SUPPRESSION=off` in the tick's environment restores every order, as `A11IGN_ORG_HEALTH_SUPPRESSION=off` does for its
 * detector. The one-line revert in code is the call site in `main`: `repeatingLinesTick({ settle: ... })` back to `repeatingLinesTick()`.
 */
export const REPEATING_LINE_SWITCH_ENV = "A11IGN_REPEATING_LINE_SUPPRESSION";

/** How much of a normalised line is the needle: 80 of the 300 the prompt quotes, which found the same ten wakes as the whole line over the measured week. */
export const CITE_PREFIX_CHARS = 80;

/** A needle shorter than this matches nothing (see above); `github-status: operational (call N ms).`, 39, is the shortest line the week cited. */
export const CITE_MIN_CHARS = 30;

/** The candidates one line may cost a read for: a line cited by four rows needs one that holds, not all four. */
export const CITE_VERIFY_MAX = 3;

/** Where the count is written: a run whose length is the threshold times a power of two, so it is written once as it grows. */
export const isCountMilestone = (count: number): boolean => count >= REPEAT_TICKS && Number.isInteger(Math.log2(count / REPEAT_TICKS));

/** The text a line is searched for in, normalised the way the line is. */
const citeText = (item: { title?: string; body?: string; }): string => normaliseLine(`${item.title ?? ""}\n${item.body ?? ""}`);

/** The needle a headline is searched for by, or `null` when it is too short to cite anything. */
export function citeNeedle(headline: string): string | null {
  const needle = normaliseLine(headline).trim().slice(0, CITE_PREFIX_CHARS).trim();
  return needle.length >= CITE_MIN_CHARS ? needle : null;
}

/**
 * The groups that STILL need `orchestrator`: those no open row cites. A cited group is said on stderr (`repeating-lines:` is the detector's own prefix, which it
 * does not count) and, at a milestone, written to the row. A port that cannot answer is "not cited", and a write that fails is said and the suppression
 * stands: the cite was verified, and a failed comment is not a reason to wake a seat for a line a row already holds.
 *
 * @param portFor the ticket port of one tracker, by `owner/name`: the only way this function reaches a tracker
 */
export function settleCitedRepeatingLines(groups: RepeatingGroup[], { openRows, portFor, env = process.env, log = (line) => process.stderr.write(line), now = Date.now() }: {
  openRows: { number: number; title?: string; body?: string; repo?: string; }[]; portFor: (scope: string) => TicketPort;
  env?: Record<string, string | undefined>; log?: (line: string) => void; now?: number;
}): RepeatingGroup[] {
  if (env[REPEATING_LINE_SWITCH_ENV] === "off") return groups;
  const searchable = openRows.map((row) => ({ row, text: citeText(row) }));
  return groups.filter((group) => {
    const headline = group.lines[0];
    const needle = citeNeedle(headline);
    if (needle === null) return true;
    const candidates = searchable.filter(({ text }) => text.includes(needle)).map(({ row }) => row).sort((a, b) => a.number - b.number).slice(0, CITE_VERIFY_MAX);
    for (const row of candidates) {
      const ref = { tracker: TRACKER, scope: row.repo ?? repoNow(), id: row.number };
      const port = portFor(ref.scope);
      const item = port.readItem(ref);
      if (item === null || item.state === "done" || !citeText(item).includes(needle)) continue;
      let wrote = "";
      if (isCountMilestone(group.count)) {
        try {
          const quoted = headline.slice(0, 300).replaceAll("```", "'''");
          port.postDecision(ref, { role: "work-gate", runId: `tick-${now}`, kind: "repeating-line-count", text:
            `**work-gate, repeating-log-line:** a line this row cites has repeated ${group.atLeast ? "at least " : ""}${group.count} consecutive ticks, first seen ${group.since}:\n\n`
            + "```\n" + quoted + "\n```\n\n"
            + "Because this row is open and cites it, the gate does not wake `orchestrator` for it again (agent-org#492). This is the count at this tick; the next "
            + "comment is at twice it. If the fault is fixed the line stops repeating; if this row closes first, the line is offered again." });
          wrote = ", count written to the row";
        } catch (err) {
          wrote = `, COULD NOT WRITE THE COUNT (${String((err as any)?.message ?? err).split("\n")[0].slice(0, 120)})`;
        }
      }
      log(`repeating-lines: ${group.count} ticks, cited by open row ${ref.scope}#${ref.id} -- no order${wrote}: ${headline.slice(0, 100)}\n`);
      return false;
    }
    return true;
  });
}

/** The ticket port of the repository `scope` names, through the gate's own `gh`. */
export const portOf = (scope: string): TicketPort => githubTicketAdapter({ run: defaultRun, scope });

/**
 * agent-org#491 (Phase 1 of a11ign/a11ign#4505): THE `overdue` LIST IS RECORDED AS DATA, AND A MANAGER IS WOKEN ONLY FOR A STUCK-LINK NUMBER.
 *
 * `org-health` hands `ceo` three numbers that say something is not happening (`no-merge-while-work-exists`, `red-pr-unattended`, `ready-row-refused`) and the work is
 * diagnosis. The `overdue` signal is not one of them: it is a LIST the gate has already built (each item named, its kind, its reason, how long it has been open), and
 * #4065 already classes it a digest, so `ceo` is woken for it only on a churn storm or as a digest riding another order. The list is what it is whether or not a seat reads it.
 *
 * THE LIST IS WRITTEN, ONCE PER CHANGE, ON THE STANDING ROW (`STANDING_ROW`, #928: the row every `org-health` prompt already says to write on) as one `postDecision` through the
 * ticket port, and the order is dropped. WHAT "A CHANGE" IS is the key the order already carries (`overdue@<kind#n:reason,...>`, sorted: `normalisedKey`), so a merge, a close or a
 * new item moves it and a clock that only ticks does not. THE LAST KEY WRITTEN is the whole state (`OVERDUE_LAST_WRITTEN_FILE`); a list that clears and returns unchanged is the
 * same list and is not written again.
 *
 * EVERY DOUBT IS A WAKE, AS TODAY: a write that fails keeps the order and records nothing, so the next tick tries again and the list is never lost between the two. An order whose
 * key cannot be read is left alone. The three stuck-link orders, and every other `org-health` class, are not touched here: their text and their route are what they were.
 *
 * WHERE: AFTER `deadMansSwitch` and BEFORE `quietOrgHealth`, so a stuck org that found an overdue item is still not a quiet org to the dead man's switch (#4065's own reason).
 *
 * THE SWITCH: `A11IGN_OVERDUE_LIST_AS_DATA=off` in the tick's environment restores the order, with no write. The one-line revert in code is the call site in `main`:
 * `quietOrgHealth(settleOverdueLists(orders, ...), ...)` back to `quietOrgHealth(orders, ...)`.
 */
export const OVERDUE_LIST_SWITCH_ENV = "A11IGN_OVERDUE_LIST_AS_DATA";

/** Where the last key written is kept, beside the other state entries. */
export const OVERDUE_LAST_WRITTEN_FILE = "org-health-overdue-written.json";

/** How many of the list's members one comment names; the key of a long list is the whole set and a comment is read by a person. */
const OVERDUE_MEMBERS_SHOWN = 60;

/** @returns the key of an `org-health` order of class `overdue`, or `null` for any other order */
const overdueKeyOf = (order: any): string | null => {
  if (order?.cause !== "org-health") return null;
  const id = orgHealthClassAndKey(String(order.causeKey ?? ""));
  return id !== null && id.class === "overdue" ? id.key : null;
};

/**
 * @param orders the tick's orders, as `quietOrgHealth` would be given them
 * @param portFor the ticket port of one tracker, by `owner/name`: the only way this function reaches a tracker
 * @returns the orders to deliver: every one that is not an `overdue` list, and an `overdue` one only when its list could not be written
 */
export function settleOverdueLists(orders: any[], { portFor, dir = REVIEWER_STATE_DIR, env = process.env, log = (line) => process.stderr.write(line), now = Date.now(), scope = repoNow() }: {
  portFor: (scope: string) => TicketPort; dir?: string; env?: Record<string, string | undefined>; log?: (line: string) => void; now?: number; scope?: string;
}): any[] {
  if (env[OVERDUE_LIST_SWITCH_ENV] === "off") return orders;
  const lists = orders.filter((order) => overdueKeyOf(order) !== null);
  if (lists.length === 0) return orders;
  const path = join(dir, OVERDUE_LAST_WRITTEN_FILE);
  const kept = new Set<any>();
  let last: unknown = readJsonObject(path).key;
  for (const order of lists) {
    const key = overdueKeyOf(order) as string;
    if (key === last) continue; // NOT SAID: a line written every tick for a standing list is offered by `repeatingLinesTick` as a fault of its own
    try {
      const members = key.split(",").filter((member) => member !== "");
      const shown = members.slice(0, OVERDUE_MEMBERS_SHOWN).join(", ") + (members.length > OVERDUE_MEMBERS_SHOWN ? `, and ${members.length - OVERDUE_MEMBERS_SHOWN} more` : "");
      const detail = String(order.prompt ?? "").split("\n")[0].replace(/^ORG HEALTH: `overdue` HAS TRIPPED\. /, "");
      // THE COMMENT FIRST, THE KEY AFTER: a key kept for a comment that did not land would swallow the list.
      portFor(scope).postDecision({ tracker: TRACKER, scope, id: Number(STANDING_ROW) }, { role: "work-gate", runId: `tick-${now}`, kind: "overdue-list", text:
        `**work-gate, org-health \`overdue\`:** the list changed at ${new Date(now).toISOString()}. It is recorded here and woke nobody (agent-org#491); the stuck-link numbers still do.\n\n`
        + `${detail}\n\nAll ${members.length}: ${shown}` });
      writeJsonObject(path, { key });
      last = key;
      log(`org-health: overdue list changed (${members.length} item(s)) -- written to #${STANDING_ROW}, no order.\n`);
    } catch (err) {
      kept.add(order);
      log(`org-health: COULD NOT WRITE the overdue list to #${STANDING_ROW} (${String((err as any)?.message ?? err).split("\n")[0].slice(0, 120)}) -- the order stands this tick.\n`);
    }
  }
  return orders.filter((order) => overdueKeyOf(order) === null || kept.has(order));
}

/** agent-org#490: where the switch for `settleOffBoardRows` is read; `off` restores the order as it was. */
export const ROW_OFF_BOARD_SWITCH_ENV = "A11IGN_ROW_OFF_BOARD_BY_GATE";

/** The state each Status-naming label stands for, and the Status the board shows for it (`ticket-port/github-adapter.ts`'s `STATUS_OF`, which this must agree with). */
type BoardedState = { state: TicketState; status: string; };

// The port's state IS the label's name for these three (`ticket-port/github-adapter.ts` writes each state as the label of that name), so the state is read from the
// vocabulary and not spelled again here (#2619's ratchet).
const BOARDED_STATE_OF_LABEL: Readonly<Record<string, BoardedState>> = Object.freeze({
  [READY_LABEL]: { state: READY_LABEL as TicketState, status: "Ready" },
  [BACKLOG_LABEL]: { state: BACKLOG_LABEL as TicketState, status: "Backlog" },
  [CLAIM_LABEL]: { state: CLAIM_LABEL as TicketState, status: "In progress" },
});

/** The port's own state labels (`ready`, `backlog`, `in-progress`, `parked`): a row carrying two of them is one the port would strip a label from. */
const PORT_STATE_LABELS: readonly string[] = [READY_LABEL, BACKLOG_LABEL, CLAIM_LABEL, "parked"];

/** @returns the state and Status a row's labels name, or `null` for a row that is not a lookup: none, two, `parked` beside one, or an `epic` */
function statusNamedBy(row: any): BoardedState | null {
  const labels = labelsOf(row);
  if (labels.includes(EPIC_LABEL)) return null;
  const states = PORT_STATE_LABELS.filter((label) => labels.includes(label));
  return states.length === 1 ? BOARDED_STATE_OF_LABEL[states[0]] ?? null : null;
}

/** A row's release declaration, by `row-file`'s rule: a milestone, or the `out-of-release` label. */
const declaresRelease = (row: any): boolean => Boolean(row?.milestone) || labelsOf(row).includes(OUT_OF_RELEASE_LABEL);

/**
 * agent-org#490 (Phase 1 of a11ign/a11ign#4505): A ROW OFF PROJECT 1 WHOSE LABEL NAMES A STATUS IS BOARDED BY THE GATE, AND A MANAGER IS WOKEN ONLY FOR THE REST.
 *
 * The cause's own declaration says the gate has already read each row's Project membership and named the absent ones; what was left for `product-manager` was boarding
 * each at the Status its label says (`ready` -> Ready, `backlog` -> Backlog, `in-progress` -> In progress). That is a lookup, so the gate does it, through the ticket
 * port's `changeState` -- the one call that sets the state and the board Status -- and says so on the row with one `postDecision`, so who boarded it is on its timeline.
 *
 * WHAT IS BOARDED, AND WHAT IS NOT. A row is boarded only when it is provably off the board and past the grace (`rowsOffBoard`), was read in this tick's open rows, and
 * carries EXACTLY ONE of the port's state labels, which is one of those three. Everything else is left in the facts and so in the order, as today: a row with no label
 * that names a Status, one with two (the port would remove one of them: that is a decision about the row and not a lookup), an `epic` (boarded by `row-file --board`,
 * at Backlog, #4456), and one whose write failed. EVERY DOUBT IS A WAKE, as #491 did it.
 *
 * NO RELEASE IS DECLARED BY THE GATE. Which release a row belongs to is the filer's choice between a milestone and `out-of-release`, and the port has no milestone write,
 * so no rule here is mechanical. A row the gate boarded that still declares none comes back marked `boardedAs`: it is on the board now, and the order asks for the
 * declaration only, once (next tick the row is not off the board, so the set has changed and nothing returns).
 *
 * THE SWITCH: `A11IGN_ROW_OFF_BOARD_BY_GATE=off` in the tick's environment returns the facts untouched, with no write and no port asked, and the order is today's.
 * The one-line revert in code is the call site in `main`: `offBoard: settleOffBoardRows(offBoard, ...)` back to `offBoard,` in `decideArgs`. Live cutover, no shadow phase.
 *
 * @param facts `readRowsOffBoard`'s result; `null` (could not ask) is returned as it is
 * @param portFor the ticket port of one tracker, by `owner/name`, whose `changeState` ADDS a row that is not on the board: the only way this function reaches a tracker
 * @returns the facts the order is made from: every one not boarded, and each boarded row that declares no release
 */
export function settleOffBoardRows(facts: BoardFacts[] | null, { openRows, portFor, env = process.env, log = (line) => process.stderr.write(line), now = Date.now(), scope = repoNow() }: {
  openRows: any[]; portFor: (scope: string) => TicketPort; env?: Record<string, string | undefined>; log?: (line: string) => void; now?: number; scope?: string;
}): BoardFacts[] | null {
  if (facts === null || env[ROW_OFF_BOARD_SWITCH_ENV] === "off") return facts;
  const absent = new Set(rowsOffBoard(facts, now).map((row) => row.number));
  if (absent.size === 0) return facts;
  const rows = new Map(openRows.map((row) => [Number(row.number), row]));
  const left: BoardFacts[] = [];
  for (const fact of facts) {
    const row = absent.has(fact.number) ? rows.get(fact.number) : undefined;
    const named = row === undefined ? null : statusNamedBy(row);
    if (row === undefined || named === null) { left.push(fact); continue; }
    const ref = { tracker: TRACKER, scope, id: fact.number };
    try {
      // THE WRITE FIRST, THE RECORD AFTER: a comment for a row that was not boarded would say what is not so.
      portFor(scope).changeState(ref, { state: named.state });
    } catch (err) {
      left.push(fact);
      log(`row-off-board: COULD NOT BOARD #${fact.number} at ${named.status} (${String((err as any)?.message ?? err).split("\n")[0].slice(0, 160)}) -- it stays in the order.\n`);
      continue;
    }
    let recorded = "";
    try {
      portFor(scope).postDecision(ref, { role: "work-gate", runId: `tick-${now}`, kind: "row-off-board", text:
        `**work-gate, row-off-board:** this row had no item on Project ${PROJECT_NUMBER}. It was added at **${named.status}**, the Status its state label says (agent-org#490). `
        + "The gate declares no release: " + (declaresRelease(row) ? "this row already declares one." : "this row declares none, and `product-manager` is asked for it.") });
    } catch (err) {
      recorded = `, COULD NOT RECORD IT ON THE ROW (${String((err as any)?.message ?? err).split("\n")[0].slice(0, 120)})`;
    }
    if (!declaresRelease(row)) left.push({ ...fact, boardedAs: named.status });
    log(`row-off-board: boarded #${fact.number} at ${named.status}${recorded}${declaresRelease(row) ? " -- no order" : " -- no release declared, the order asks for it"}.\n`);
  }
  return left;
}

/**
 * The ticket port of the repository `scope` names, for a write that BOARDS: the adapter's own `changeState` sets the Status with `project item-edit`, which refuses a row that
 * is not an item of the project, so this one adds the item first (`row-file`'s order: `item-add`, then the Status). The Status move keeps the board snapshot guard
 * (#399, #1275) scoped to the one row, as `moveProjectStatus` does for a claim, so a refused snapshot refuses the move and the add before it.
 */
export const boardingPortOf = (scope: string): TicketPort => githubTicketAdapter({ run: defaultRun, scope, moveStatus: (id, statusName) => {
  const url = `https://github.com/${scope}/issues/${id}`;
  withBoardSnapshot(() => {
    defaultRun(["project", "item-add", String(PROJECT_NUMBER), "--owner", PROJECT_OWNER, "--url", url]);
    try {
      defaultRun(["project", "item-edit", String(PROJECT_NUMBER), "--owner", PROJECT_OWNER, "--url", url, "--field", "Status", "--value", statusName]);
    } catch (err) {
      throw new Error(`the row was ADDED to Project ${PROJECT_NUMBER} but its Status could not be set (${String((err as any)?.message ?? err).split("\n")[0].slice(0, 120)}); it is on the board with no Status`, { cause: err });
    }
  }, { run: (_cmd, args) => defaultRun(args), log: (line) => process.stderr.write(`${line}\n`), excludeIssueNumber: id, touches: id });
} });

/** agent-org#488: where the switch for `settleUnarmedPrs` is read; `off` restores the order as it was. */
export const GREEN_UNARMED_SWITCH_ENV = "A11IGN_PR_GREEN_UNARMED_BY_GATE";

/**
 * agent-org#488 (Phase 1 of a11ign/a11ign#4505): A LONE UNARMED PULL REQUEST IS ARMED BY THE GATE, AND A MANAGER IS WOKEN ONLY WHEN EVERY CANDIDATE IS UNARMED.
 *
 * The cause's own declaration says the act is one command and the judgment is the fork between "this pull request missed its arming event" and "the arming
 * credential is refusing, so nothing in the repository can arm anything" (#1969). The fork is a count the gate already holds, and this reads it:
 *
 *  - ONE candidate unarmed, or several unarmed beside at least one that IS armed: the credential works, so the gate arms each unarmed one through the code-host
 *    port (`arm-pr`'s own command, with its hold, authorship, ejection and blocker checks) and records it with one `postDecision` on the pull request. No order.
 *  - SEVERAL candidates unarmed and none armed: the signature of the outage. The gate arms NOTHING and the order goes to the manager with the count in it,
 *    because getting that fork wrong is the failure this cause exists to end.
 *
 * EVERY DOUBT IS A WAKE, as #490 did it. A pull request the gate did not arm (the command refused, held it, found an open blocker, or the read-back says it is not
 * armed) stays in the order, with what the gate saw. The count is of POSITIVELY armed candidates: one the read did not cover is not evidence the credential works.
 *
 * THE SWITCH: `A11IGN_PR_GREEN_UNARMED_BY_GATE=off` in the tick's environment returns the list as it is, with no write and no port asked, and the order is today's.
 * The one-line revert in code is the call site in `readArmingOf`: `unarmed: settleUnarmedPrs(...)` back to `unarmed: split.unarmed`. Live cutover, no shadow phase.
 *
 * @param unarmed the candidates still unarmed once the ejected ones were split out (`readEjections`)
 * @param armed how many candidates the read says ARE armed now; `of` is how many candidates there were
 * @param portFor the arming port of one repository, by `owner/name`: the only way this function reaches the code host or a tracker
 * @returns the facts the order is made from: `unarmed` itself when the switch is off or nothing is unarmed, else the ones the gate did not arm
 */
export function settleUnarmedPrs(unarmed: number[], { armed, of, portFor, env = process.env, log = (line) => process.stderr.write(line), now = Date.now(), scope = repoNow() }: {
  armed: number; of: number; portFor: (scope: string) => ArmingPort; env?: Record<string, string | undefined>; log?: (line: string) => void; now?: number; scope?: string;
}): number[] | UnarmedFacts {
  if (env[GREEN_UNARMED_SWITCH_ENV] === "off" || unarmed.length === 0) return unarmed;
  if (unarmed.length > 1 && armed === 0) return { numbers: unarmed, of, armed };
  const left: number[] = [];
  const tried: { number: number; why: string; }[] = [];
  for (const number of unarmed) {
    const why = armOne(number, scope, portFor, now, log);
    if (why !== null) { left.push(number); tried.push({ number, why }); }
  }
  return left.length === 0 ? [] : { numbers: left, of, armed, tried };
}

/** Arms one pull request through the port and records it; `null` when it is armed, else why it is not (said once, short). */
function armOne(number: number, scope: string, portFor: (scope: string) => ArmingPort, now: number, log: (line: string) => void): string | null {
  const port = portFor(scope);
  try {
    // THE ARM FIRST, THE RECORD AFTER: a comment for a pull request that was not armed would say what is not so.
    if (!port.armMerge({ host: TRACKER, id: `${scope}#${number}` })) {
      log(`pr-green-unarmed: ran the arming command on #${number} and it is NOT armed -- it stays in the order.\n`);
      return "the arming command ran and the pull request is still not armed (held, blocked on an open row, or refused: its own lines say which)";
    }
  } catch (err) {
    const why = String((err as any)?.message ?? err).split("\n")[0].slice(0, 200);
    log(`pr-green-unarmed: COULD NOT ARM #${number} (${why}) -- it stays in the order.\n`);
    return why;
  }
  let recorded = "";
  try {
    port.postDecision({ tracker: TRACKER, scope, id: number }, { role: "work-gate", runId: `tick-${now}`, kind: "pr-green-unarmed", text:
      "**work-gate, pr-green-unarmed:** this pull request was green on every required check, not held and not armed, while another candidate in the queue was armed or it was the only "
      + "one unarmed, so the arming credential is working. The gate ran `arm-pr` on it and it is armed (agent-org#488). No manager was woken." });
  } catch (err) {
    recorded = `, COULD NOT RECORD IT ON THE PULL REQUEST (${String((err as any)?.message ?? err).split("\n")[0].slice(0, 120)})`;
  }
  log(`pr-green-unarmed: armed #${number}${recorded} -- no order.\n`);
  return null;
}

/**
 * The arming port of the repository `scope` names. `armMerge` runs `arm-pr`'s own command (`runArmPr`, which is what the order has always told a manager to run:
 * the hold, authorship, ejection and blocker checks and the session label are all its) with the gate's `defaultRun`, so the identity and the call census are the
 * gate's. `runArmPr` reports an exit code, and an exit code is not "armed" (#1022), so a zero is READ BACK from the pull request's own state. Anything but a zero throws
 * with the command's own last line. `postDecision` is the ticket adapter's: a pull request is an item of the tracker whose comment endpoint is the issue's.
 */
const armingPortOf = (scope: string): ArmingPort => {
  const tickets = githubTicketAdapter({ run: defaultRun, scope });
  const ghRun = (_cmd: string, args: string[]) => defaultRun(args);
  return {
    postDecision: (ref, decision) => tickets.postDecision(ref, decision),
    armMerge(ref: ChangeRef) {
      const [repo, number] = ref.id.split("#");
      const said: string[] = [];
      const code = runArmPr({ argv: [`--pr=${number}`, `--repo=${repo}`], env: {}, run: ghRun, sleep: () => "ok", log: (line) => said.push(line), error: (line) => said.push(line) });
      if (code !== ARM_EXIT.DONE) throw new Error(`arm-pr exited ${code}: ${said.filter((line) => line.trim() !== "").at(-1) ?? "it said nothing"}`);
      return armedAlready({ number, repo, run: ghRun, error: () => {} }) !== null;
    },
  };
};

/** agent-org#1502: the unarmed list `settleUnarmedPrs` returned, with the ones acceptance withheld added back as `withheld` so the order names them. */
function withWithheld(settled: number[] | UnarmedFacts, withheld: { number: number; why: string; }[], counts: { armed: number; of: number; }): UnarmedFacts {
  const facts: UnarmedFacts = Array.isArray(settled) ? { numbers: settled, ...counts } : settled;
  const numbers = [...facts.numbers, ...withheld.map((w) => w.number)].sort((a, b) => a - b);
  return { ...facts, numbers, withheld };
}

/**
 * agent-org#488: THE ARMING READ OF ONE TICK, ITS EJECTIONS AND WHAT THE GATE DID ABOUT THE UNARMED ONES -- `readEjections(readUnarmed(...))` as it was, with
 * `settleUnarmedPrs` between that and the order. `null` is a refused read, as before. The revert is the `unarmed:` line below.
 */
export function readArmingOf(openPrs: any[], required: string[] | null, { scope = repoNow(), run = defaultRun, portFor = armingPortOf, env = process.env, log, state, now = Date.now() }: {
  scope?: string; run?: (args: string[]) => string; portFor?: (scope: string) => ArmingPort; env?: Record<string, string | undefined>; log?: (line: string) => void; state?: CanaryState; now?: number;
} = {}) {
  const candidates = shouldBeMerging(openPrs, required);
  const reading = readArming(candidates, run);
  const split = readEjections(reading === null ? null : reading.unarmed, run);
  if (reading === null || split === null) return null;
  const say = log ?? ((line: string) => process.stderr.write(line));
  // a11ign#5125: BEFORE the orders -- an ejection that was not the PR's own is armed here and leaves `ejections`, so no owner is woken for it; the rest are today's `ejected` orders.
  const requeued = requeueEjected(split.ejections, { prs: openPrs, scope, run, portFor, state: state ?? readReenqueueState(), now, log: say, evidence: split.evidence });
  // agent-org#1502: the org-side acceptance verdict decides WHICH of the unarmed the gate may arm; the ones it withholds are named in the order, never armed.
  const gated = gateUnarmedOnAcceptance(split.unarmed, { openPrs, scope, env, ...(log === undefined ? {} : { log }) });
  const settled = settleUnarmedPrs(gated.armable, { armed: reading.armed.length, of: candidates.length, portFor, scope, env, ...(log === undefined ? {} : { log }) });
  const unarmed = gated.withheld.length === 0 ? settled : withWithheld(settled, gated.withheld, { armed: reading.armed.length, of: candidates.length });
  return { unarmed, ejections: requeued.remaining, stranded: requeued.stranded };
}

/** agent-org#1502: where the org-side acceptance gate is switched ON. OPT-IN, unlike `GREEN_UNARMED_SWITCH_ENV`: it runs a command the pull request names, on the host. */
export const ACCEPTANCE_GATE_SWITCH_ENV = "A11IGN_PR_ACCEPTANCE_BY_GATE";
/** agent-org#1503: where the org-side TREE-WIDE GUARDS are switched ON. A second, independent switch: it runs the pull request's own test files, on the host. */
export const TREE_WIDE_GUARDS_SWITCH_ENV = "A11IGN_PR_TREE_WIDE_GUARDS_BY_GATE";
/** How many org-side runs (acceptance commands and guard runs together) one tick may RUN; the rest are withheld "deferred" and run on a later tick, so one tick is never the length of a suite times a queue. */
export const MAX_ACCEPTANCE_RUNS_PER_TICK = 2;

/**
 * agent-org#1502 (ADR 0045 cut c): THE ORG-SIDE VERDICTS GATE ARMING. Of the unarmed candidates, the same-repository `agent/*` ones by a declared
 * identity (`orgSideAcceptanceEligibility`, and ONLY those) get each switched-on family run on the host, in a checkout of the pull request's merge ref, and
 * are armed only on a `pass` of every one AT THEIR CURRENT HEAD; the rest of the unarmed are returned untouched. A verdict is remembered by head (`pass` and
 * `fail`, never `not-run`), so a failing pull request is not re-run every tick and a push is. Two families: the pull request's acceptance command
 * (#1502) and its tree-wide guards (#1503), which are a11ign's `guardSweep` read on the org side.
 *
 * SWITCHES: `A11IGN_PR_ACCEPTANCE_BY_GATE=on` and `A11IGN_PR_TREE_WIDE_GUARDS_BY_GATE=on`, each alone. Both off (the default), `armable` is `unarmed` and
 * nothing is read, checked out or run. The one-line revert in code is the call site in `readArmingOf`.
 *
 * @returns `armable` for `settleUnarmedPrs`, `withheld` for the order
 */
export function gateUnarmedOnAcceptance(unarmed: number[], { openPrs, scope, env = process.env, declared = declaredIdentities(), verdictOf, guardsOf, stateDir = REVIEWER_STATE_DIR, log = (line: string) => process.stderr.write(line) }: {
  openPrs: any[]; scope: string; env?: Record<string, string | undefined>; declared?: DeclaredIdentities; verdictOf?: (pr: any) => OrgSideVerdict;
  guardsOf?: (pr: any) => OrgSideVerdict; stateDir?: string; log?: (line: string) => void;
}): { armable: number[]; withheld: { number: number; why: string; }[]; } {
  const acceptanceOn = env[ACCEPTANCE_GATE_SWITCH_ENV] === "on";
  const guardsOn = env[TREE_WIDE_GUARDS_SWITCH_ENV] === "on";
  if ((!acceptanceOn && !guardsOn) || unarmed.length === 0) return { armable: unarmed, withheld: [] };
  const byDeclaredIdentity = (pr: any) => reviewTrustOf(pr, declared) === INSIDE;
  const file = join(stateDir, "acceptance-verdicts.json");
  const remembered: Record<string, OrgSideVerdict> = readJsonObject(file);
  let ran = 0;
  const repoRoot = env.A11IGN_ACCEPTANCE_REPO_ROOT ?? process.cwd();
  const checkout = () => checkoutPullRequestMerge({ repoRoot, scratch: join(stateDir, "acceptance-checkouts") });
  /** One family's verdict for one pull request: remembered by head, deferred past the per-tick limit, and remembered only when it is a `pass` or a `fail`. */
  const familyOf = (family: string, deferredWhy: string, produce: (pr: any) => OrgSideVerdict) => (pr: any): OrgSideVerdict => {
    const key = `${scope}#${pr.number}@${pr.headRefOid}${family === "" ? "" : `:${family}`}`;
    const known = remembered[key];
    if (known !== undefined && (known.kind === "pass" || known.kind === "fail")) return known;
    if (ran >= MAX_ACCEPTANCE_RUNS_PER_TICK) return { kind: "not-run", head: String(pr.headRefOid), lines: [], why: deferredWhy };
    ran++;
    const verdict = produce(pr);
    if (verdict.kind !== "not-run") {
      remembered[key] = verdict;
      try { writeJsonObject(file, remembered); } catch (err) { log(`acceptance-gate: COULD NOT REMEMBER the verdict of #${pr.number} (${String((err as any)?.message ?? err).split("\n")[0].slice(0, 120)}) -- it is run again.\n`); }
    }
    return verdict;
  };
  const acceptance = verdictOf ?? familyOf("", "acceptance is deferred to a later tick (the per-tick run limit)", (pr) =>
    orgSideAcceptanceVerdict(pr, { byDeclaredIdentity, baseRepo: scope, checkout: checkout(), prepare: installPullRequestCheckout(), release: releasePullRequestCheckout({ repoRoot }) }));
  const guards = guardsOf ?? familyOf("tree-wide-guards", "tree-wide guards are deferred to a later tick (the per-tick run limit)", (pr) =>
    treeWideGuardVerdict(pr, { eligible: (p) => orgSideAcceptanceEligibility(p, { byDeclaredIdentity, baseRepo: scope }), checkout: checkout(), prepare: installPullRequestCheckout(),
      discover: (cwd) => treeWideGuardFilesIn(cwd), run: (files, cwd) => runTreeWideGuards(files, cwd), release: releasePullRequestCheckout({ repoRoot }) }));
  const gated = acceptanceGateOf(unarmed, {
    prOf: (number) => openPrs.find((pr) => Number(pr.number) === number),
    gateOf: (pr) => (orgSideAcceptanceEligibility(pr, { byDeclaredIdentity, baseRepo: scope }).eligible
      ? firstRefusalOf([...(acceptanceOn ? [acceptance(pr)] : []), ...(guardsOn ? [guards(pr)] : [])])
      : null),
  });
  for (const { number, why } of gated.withheld) log(`acceptance-gate: #${number} is NOT armed -- ${why}.\n`);
  return gated;
}

/** agent-org#489: where the switch for `withStaleRefusals` is read; `off` restores the order as it was. */
export const REVIEW_BLOCKED_SWITCH_ENV = "A11IGN_PR_REVIEW_BLOCKED_BY_GATE";

/** What `withStaleRefusals` is given for one repository: the ticket port's one write, the record on the pull request. */
export type StaleRefusalPort = Pick<TicketPort, "postDecision">;

/** The token a record carries, so the next tick's read of the pull request's own comments finds it and says nothing twice. */
const staleRefusalMarker = (oid: string) => `stale-refusal: ${oid}`;

/**
 * PURE. agent-org#489: THE COMMIT A PULL REQUEST'S REFUSAL WAS POSTED AT WHEN NO REFUSAL ON IT STANDS AT THE HEAD IT HAS NOW, or `null` when that cannot be said.
 *
 * STALE ONLY WHEN EVERY `CHANGES_REQUESTED` ON IT IS POSITIVELY OLDER, which is the row's "only blocking review". Each one that fails the test below keeps the
 * pull request in the order, as today (EVERY DOUBT IS A WAKE, as #488 and #490 did it):
 *  - a refusal at the current head is live, whoever else refused earlier;
 *  - a refusal whose commit the payload does not name is not a comparison anybody made;
 *  - a refusal whose PATCH is the head's (#3045: a rebase, an update-branch) is the same work refused, so the rework is still owed. Only a patch KNOWN to be
 *    equal keeps it: a patch that could not be read (`patchUnchangedSince`'s `null`, a refused `withPatchIds` read) leaves the comparison to the commits, which is
 *    the row's own, and the reviewer seat is asked either way (`draftOrder` finds no verdict at a head it has not been written at).
 * `reviewStateOf` must say REFUSED too: GitHub's `reviewDecision` is what holds the pull request, and a list of reviews alone is not a decision.
 */
export function staleRefusalOf(pr: any): string | null {
  if (reviewStateOf(pr).code !== REVIEW_STATE.REFUSED) return null;
  const head = String(pr?.headRefOid ?? "");
  if (head === "" || !Array.isArray(pr?.reviews)) return null;
  const refusals = pr.reviews.filter((r: any) => r?.state === "CHANGES_REQUESTED").map((r: any) => String(r?.commit?.oid ?? ""));
  if (refusals.length === 0 || refusals.some((oid: string) => oid === "" || oid === head || patchUnchangedSince(pr, oid) === true)) return null;
  return refusalCommitOf(pr);
}

/** Whether the pull request's own comments already carry the record for this refusal. */
const staleRefusalRecorded = (pr: any, oid: string): boolean =>
  Array.isArray(pr?.comments) && pr.comments.some((c: any) => String(c?.body ?? "").includes(staleRefusalMarker(oid)));

/**
 * agent-org#489 (Phase 1 of a11ign/a11ign#4505): A REFUSAL POSTED AT AN OLDER HEAD THAN THE PULL REQUEST HAS NOW ORDERS NO ONE, AND THE GATE SAYS SO ON THE PULL REQUEST.
 *
 * The cause's own declaration names this arm as the one only reading settles: `dismiss_stale_reviews` does not clear a `CHANGES_REQUESTED`, so one may stand at a
 * head the author has since replaced (#2049 sat seven hours on one). The reading is a comparison of the review's `commit.oid` with `headRefOid`, data the gate
 * already holds, so the gate does it. What the order asked of the author or the manager (compare, then route) has nothing left to decide:
 *  - the rework is not owed for a head the review never saw (`staleRefusalOf`; an equal patch is the one case it keeps), so the author is not asked for it;
 *  - the fresh look IS owed, and it is the reviewer seat's, which `draft-awaiting-verdict` asks for any green head that carries no verdict at its patch -- the
 *    same cause that already starts `reviewer-<n>` for an AWAITING_REVIEW pull request (#3592). `pr-review-blocked` asking a manager too was a second order for one fact.
 *
 * A REFUSAL AT THE CURRENT HEAD IS UNCHANGED, and is ordered to its labelled owner session directly (`reviewBlockedOrders`'s `ownedBy`) with the manager's set
 * order only for the unowned ones. That routing was already the cause's code; this row adds the comparison in front of it and does not move it.
 *
 * ONE RECORD PER REFUSAL, FOUND IN THE PULL REQUEST'S OWN COMMENTS (the list this tick already read), so a standing stale refusal is said once and not once a tick,
 * and a pull request whose record cannot be posted stays in the order: THE RECORD FIRST, THE STAMP AFTER, so a refusal nobody was told of is never one nobody is
 * ordered about. The stamp (`staleRefusal`) names the commit it was made for.
 *
 * THE SWITCH: `A11IGN_PR_REVIEW_BLOCKED_BY_GATE=off` in the tick's environment returns the pull requests untouched, with no write and no port asked, and the
 * order is today's. The one-line revert in code is the `withStaleRefusals(...)` wrapper in `codeReadings` and in `main`'s `decideArgs`. Live cutover, no shadow phase.
 *
 * @param prs the pull requests as the rest of the tick will read them (`withPatchIds` first: the patch comparison is read off them)
 * @param required the required checks, which `reviewBlocked`'s population is derived from
 * @param portFor the ticket port of one repository, by `owner/name`: the only way this function reaches a tracker
 * @returns `prs` itself when the switch is off or none is stale, else the same list with `staleRefusal` stamped on the ones whose record is on the pull request
 */
export function withStaleRefusals(prs: any[], required: string[] | null, { portFor = (scope: string): StaleRefusalPort => githubTicketAdapter({ run: defaultRun, scope }),
    env = process.env, log = (line: string) => { process.stderr.write(line); }, now = Date.now(), scope = repoNow() }: {
  portFor?: (scope: string) => StaleRefusalPort; env?: Record<string, string | undefined>; log?: (line: string) => void; now?: number; scope?: string;
} = {}): any[] {
  if (env[REVIEW_BLOCKED_SWITCH_ENV] === "off") return prs;
  const byNumber = new Map(prs.map((pr) => [Number(pr?.number), pr]));
  const stamped = new Map<number, string>();
  for (const { number } of reviewBlocked(prs, required)) {
    const pr = byNumber.get(number);
    const oid = staleRefusalOf(pr);
    if (oid === null) continue;
    if (!staleRefusalRecorded(pr, oid)) {
      const head = String(pr.headRefOid);
      try {
        portFor(scope).postDecision({ tracker: TRACKER, scope, id: number }, { role: "work-gate", runId: `tick-${now}`, kind: "pr-review-blocked", text:
          `**work-gate, pr-review-blocked:** the review holding this pull request (\`CHANGES_REQUESTED\`) was posted at \`${oid.slice(0, 8)}\`, and the head is now \`${head.slice(0, 8)}\`, `
          + "pushed after it. The review is not about this head, so neither its author nor a manager was ordered about it (agent-org#489). Only a newer review lifts it, and "
          + "the reviewer seat is asked for one by `draft-awaiting-verdict`, as for any head with no review at its patch.\n\n"
          + `<!-- ${staleRefusalMarker(oid)} -->` });
        log(`pr-review-blocked: #${number} was refused at ${oid.slice(0, 8)}, the head is ${head.slice(0, 8)} -- recorded on it, no order.\n`);
      } catch (err) {
        log(`pr-review-blocked: COULD NOT RECORD the stale refusal on #${number} (${String((err as any)?.message ?? err).split("\n")[0].slice(0, 120)}) -- it stays in the order.\n`);
        continue;
      }
    }
    stamped.set(number, oid);
  }
  return stamped.size === 0 ? prs : prs.map((pr) => (stamped.has(Number(pr?.number)) ? { ...pr, staleRefusal: stamped.get(Number(pr.number)) } : pr));
}

/**
 * (#4898) THE REFUSED-CALL QUEUE'S TICK, said on stderr where the tick log reads it. A write GitHub refused for a rate limit was held by `host/gh`; the
 * gate makes it once the reset has passed and writes the 70% incident for a pool nearly spent. NEVER FAILS THE TICK: a queue that cannot be read is a line,
 * and the orders this tick would have sent are not held behind it.
 */
export function ghQueueTickOrSay(tick: () => string[] = ghQueueTick, log: (line: string) => void = (line) => process.stderr.write(line)) {
  try {
    for (const line of tick()) log(`${line}\n`);
  } catch (error) {
    log(`gh-queue: the tick could not run (${String((error as Error)?.message ?? error).split("\n")[0]}); queued calls stay queued\n`);
  }
}

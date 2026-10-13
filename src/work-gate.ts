// command: work-gate -- is there work for any session? One cheap read; a wake order per line when yes.
//
// #912's remaining half. `org-watch.ts:713-717` states it in its own comment: "READS 2-4 ARE NOT WIRED
// INTO THIS PATH YET ... the `gh` readers that feed them are the remaining half of #912". This is that
// half, and `utilisation`/`queueReport` get their first caller here.
//
// WHY THIS FILE EXISTS AT ALL. Six sessions each held a standing cron and woke every 10-30 minutes to ask
// a question `node` answers in one API call: 672 model turns a day, most of them finding nothing. That
// exhausted a weekly allowance in three days, and the two Codex reviewers hit their own quota the same
// way. THE CLOCK WAS NEVER THE DEFECT -- a tick that costs no tokens can run all day. The defect was that
// the tick WAS a model turn. So this script is the tick, and a model is woken only with the answer
// already in its prompt.
//
// IT COSTS TWO `gh` CALLS. `gh pr list --json ...,comments,files,changedFiles` answers the whole reviewer
// lane in one (comments included -- that is what makes the verdict question free), and one
// `gh issue list --label ready --json ...,body` answers the engineers'. At two calls it can run every two
// minutes all day inside the rate limit, which is the property the whole design rests on.
//
// `files`/`changedFiles` and `body` were added 2026-09-18 and added NO call: they are extra fields on the
// two reads already being made, and together they let the gate answer B4 -- does this row's declared
// Region overlap a file an open PR already touches -- before it offers the row to anyone. See
// `partitionUnclaimed` for what that was costing.
//
// THIS SCRIPT DECIDES NOTHING ABOUT WHO IS FREE. It answers "is there work", never "who should take it":
// that needs `herdr agent list`'s `agent_status`, and putting it here would make the gate untestable
// without a running org and unrunnable from CI. `wake.ts` owns that half; `row-claim.ts` remains the
// authority on whether a row is actually yours.
import { spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { readFileSync, realpathSync } from "node:fs";
// RELATIVE, not the package specifier -- this must run before any `pnpm install`/build, the same constraint
// `org-watch.ts` and `build-packages.mjs` state at their own imports.
import { refuseUnknownFlags } from "./lib/cli-flags.ts";
import { CLAIM_LABEL } from "./claim-labels.ts";
import { verdictAmong } from "./review-verdict.ts";
// `verdictAmong` lives in review-verdict.ts (#3030), so a test of the verdict reader need not import this file and its token.
export { verdictAmong };
import { ANSWER_PREFIX } from "./waiting-condition.ts";
import { declaredClosedRows } from "./row-claim/file-overlap-rule.ts";
import { declaredGhAccount } from "./gh-identity.ts";
import { repeatingLinesTick } from "./repeating-lines.ts";
import { readToolAgreement, fileReleaseIncidents, type ReleaseRuns, type CanaryState } from "./org-health.ts";
import { stateEntryPath } from "./host-config.ts";
import { TICK_COST_FILE, TICK_RECORD_FILE, readTickRecordState, tickHealthOf, type TickHealth } from "./work-tick-health.ts"; // agent-org#1208: the tick's own record, read by the gate for its `org-health` lines
import { readFlagSwitchesFor } from "./flag-switch-ledger.ts"; // agent-org#1135: the gate is the one caller that reads the project's declarations; `orgHealthNow` otherwise does not ask
import { readNodeStrips } from "./node-strips-types.ts";
import { liveClassRepeatIo, readClassRepeat } from "./class-repeat.ts";
// #2938: THE DAILY RETROSPECTIVE, in its own leaf for the same reason: it reads the journal, the ledger and a day of PRs once, and says what it found.
import { retrospectiveTick } from "./org-retro.ts";
import { tapShadowReads } from "./shadow-reads.ts"; // #2849
import { holdersOf } from "./pr-hold-state.ts";
import { homeProjectDeclaration } from "./project-config.ts";
import { verifyCheckoutOf, withVerifyStamps } from "./verify-stamp.ts"; // #3215
import { CAUSES, JUDGMENT_CAUSES, START_CAUSES } from "./cause-declaration.ts";
import { NEEDS_CHAIRMAN_LABEL as CHAIRMAN_LABEL } from "./project-vocabulary.ts";
import { readTrunkRed } from "./trunk-red.ts";
import { requiredWhenNeeded } from "./work-gate/pr-orders.ts";

export { redOnlyBySupersededRun, mergeConflictOrders, greenUnarmedOrders, reviewBlockedOrders, HOLD_RED_JOBS,
  stallReasonOf, stallOrderOf, stalledPrOrders, STALL_REASON, STALL_REASONS_WITHOUT_A_CAUSE, ownerOfPr,
  awaitingEvidenceStaleOrders } from "./work-gate/pr-orders.ts";

import { orgHealthTogether, rulingOrdersNow, waitTickFacts } from "./work-gate/org-health.ts";
import { approvedUnqueuedNow } from "./approved-unqueued.ts";
import { recordRouteOutcomesOnHost } from "./work-gate/route-outcome-pass.ts";
import { quietOrgHealth } from "./work-gate/org-health-suppression.ts";
import { unparkOtherTrackers, unparkingWaits, withTrackerRows } from "./unpark-satisfied.ts"; // #4050: a parked row whose every condition is true is un-parked where the tick reads the waits; agent-org#5177: and in every other tracker, behind `rows.autoUnpark`
// #2898: WHO OWNS A PULL REQUEST lives in `work-gate/pr-owners.ts`, which imports the shared session reads BACK from this file (the cycle `pr-orders.ts` above describes);
// every name it exported is re-exported here, so no caller of `work-gate.ts` changes.
import { withWaitingEdges } from "./work-gate/pr-waits.ts";
import { withPrOwners, resolverDefectsOf } from "./work-gate/pr-owners.ts";
import { rowCallCountSignals, liveClaudeTurns, readWaitClearedAt } from "./work-gate/row-call-count-orders.ts";
import { readAgents } from "./herdr-agents.ts";
// #3883: THE STRIP A CLOSED ROW'S CLAIM LABELS TAKE, from the leaf both it and `close-rows-for-merged-pr.ts` import -- never a second copy of the label list.
import { stripClaimLabelsVia } from "./claim-label-strip.ts";

export { claimStallTick, claimStallsNow, closedClaimsNow } from "./work-gate/claim-stall-tick.ts";

export { ROW_CALL_COUNT_SPLIT_THRESHOLD, claimedRowSession, rowCallCountSignals, ROW_CALL_COUNT_ASSESSED_MARKER,
  rowCallCountAssessedCalls, formatRowCallCountAssessment, rowCallCountOrders } from "./work-gate/row-call-count-orders.ts";

export { withClosingRowOwners, withNamedOwners, withPrOwners, withScopedPrOwners, withEndedLabels, resolverDefectOf, resolverDefectsOf } from "./work-gate/pr-owners.ts";

export { FLEET_CAPTURES_LEDGER, readFleetCaptures, fleetWaitingFacts, stalledPrFacts,
  MAX_WAIT_READS, refFactOf, readWaitRef, readWaitFacts, readRefFacts, waitTickFacts, staleWaitOrders,
  rulingOrdersNow, orgHealthNow } from "./work-gate/org-health.ts";

// #2621 (child 3e of #69): CAUSES, JUDGMENT_CAUSES AND START_CAUSES ARE COMPUTED, NOT SPELLED HERE. A
// cause used to be added to these three arrays AND to `worker-profile.ts`'s `PROFILES` separately --
// four lists in two files a cause had to be added to together, and a cause added to one and not the
// others is a recorded trap. `cause-declaration.ts` is now the one place a cause is declared
// (`{cause, group, profile}`), and these three names -- unchanged from here on -- are its computation.
// See that file's own header for the general "action vs judgment" and "start vs finish" reasoning, and
// its `TOOL_CAUSE_DECLARATIONS` for each cause's own.
export { CAUSES, JUDGMENT_CAUSES, START_CAUSES };

/**
 * The label a session applies when a row can only move by the CHAIRMAN'S OWN HANDS.
 *
 * NO EXISTING LABEL MEANT THIS. `blocked`, `publish-blocker` and `decision` all say WHAT blocks a row and
 * none says WHO must act, so a row waiting on org admin looked exactly like a row waiting on a capture.
 *
 * IMPORTED, NOT REDECLARED (#2619, child 3d of #69): `project-vocabulary.ts`'s field, aliased to this
 * file's own established name.
 */
export { CHAIRMAN_LABEL };

// The cause modules (a11ign/a11ign#5152): each holds one family of causes as it was written here, and imports the base modules, never another cause.
import { performActions, reportWithheld } from "./work-gate/orders.ts";
import { chainWaitOrders } from "./work-gate/causes/org-health-chain-wait.ts";
import { holdForIncidentNow, machineryCanaryNow, startGithubStatus } from "./work-gate/causes/org-health-github-incident.ts";
import { cannotAskReport, deadMansSwitch, diskHeadroomTick } from "./work-gate/causes/org-health-host.ts";
import { HOST_DRIFT_SESSION, withStalePrimaryNotice } from "./work-gate/causes/org-health-host-drift.ts";
import { blockingImpactOrders, fileResolverDefects } from "./work-gate/causes/org-health-resolver-defects.ts";
import { reviewerAuthTick } from "./work-gate/causes/org-health-reviewer-auth.ts";
import { baseTipWhenRed } from "./work-gate/causes/pr-checks.ts";
import { readReenqueueState } from "./work-gate/causes/pr-ejected.ts";
import { holdHolderOrdersNow } from "./work-gate/causes/pr-holds.ts";
import { stampLookup, withEvidenceLabelAges, withPatchIds } from "./work-gate/causes/pr-reviews.ts";
import { EXIT, claimedCommentsForClock, defaultRun, draining, readBranchPrsOfUnclaimed, readClaimedRowComments, readPrs, readReadyRows,
  readRowBranches, readWithFirstWaveTogether, releaseBehindNow, repoNow, runBatch, otherScopesToRead, rememberOtherScopesRead, isAmbientRun, primaryDue, primaryLanes, unreadScopes } from "./work-gate/reads.ts";
import { type Pacing, orgHealthSkipped, pacedUnread, pacingNow, pacingOn, primaryUnread } from "./work-gate/pacing.ts";
import { answerGivenOrders, bareAnswerLabelOrders, closedAnswerRows, endedSessionLabels, liveWorkspaceLabels, readClosedAnswerRows, rowsOwingAnswers,
  withAnswerLabel } from "./work-gate/causes/rows-answers.ts";
import { readRecentlyClosed, unclaimedClearings } from "./work-gate/causes/rows-blocker-cleared.ts";
import { chairmanAsksNow, chairmanReadsRefused } from "./work-gate/causes/rows-chairman.ts";
import { offeredRefusalStreaks, partitionUnclaimed } from "./work-gate/causes/rows-claims.ts";
import { closedClaimDebris, closedClaimLabelsWhenListed } from "./work-gate/causes/rows-claims-closed.ts";
import { closedUnderHalfOrders } from "./work-gate/causes/rows-closed-under-half.ts";
import { queueEntryNoRunOrders } from "./work-gate/causes/queue-entry-no-run.ts";
import { epicRowsOf } from "./work-gate/causes/rows-epics.ts";
import { partitionFleetBatch } from "./work-gate/causes/rows-fleet-batch.ts";
import { engineerShareReads } from "./work-gate/causes/rows-offer.ts";
import { anyBlockerClearingCandidate, blockerClearedReading, boardingPortOf, claimStallsWithFacts, closedClaimsWhenWorkerListed, decide, exitPartial,
  ghQueueTickOrSay, homeRowsOf, labJobRecordsOrSay, markOutageReads, offerHierarchyNow, otherScopeTicks, outageThisTick, portOf,
  promotedWhenUnblocked, pullRequestsOfOthers, readArmingOf, readChairmanPriorityOfOffer, readHostDrift, readLanes, readTrackerLanes, recordTickFailures, reportClearingDrops,
  rowsOffBoardOrSay, settleCitedRepeatingLines, settleOffBoardRows, settleOverdueLists, unreadLanes, withClosedClaims, withEjections,
  withStaleRefusals } from "./work-gate/tick.ts";
import { REVIEWER_STATE_DIR, type Scope, comparablePrFiles, labelsOf, scopesOf } from "./work-gate/vocabulary.ts";
import { endGateSpan } from "./lib/spawn-census.ts";
import { repeatedOrdersTick } from "./order-verify.ts";
export { openRowState, workingClaims, waitingBreakdown, stalledOrder, performActions } from "./work-gate/orders.ts";
export { CHAIN_WAIT_FLAG, CHAIN_WAIT_FILE, CHAIN_WAIT_MINUTES, CHAIN_WAIT_ESCALATION_SESSION, blockedReasonOf, chainWaitsOf, advanceChainWaits,
  chainWaitWakeText, chainWaitEscalationText, chainWaitOrder, chainWaitOrders } from "./work-gate/causes/org-health-chain-wait.ts";
export type { ChainWait, ChainEpisode, ChainMove } from "./work-gate/causes/org-health-chain-wait.ts";
export { GITHUB_STATUS_URL, GITHUB_STATUS_TIMEOUT_MS, githubIncidentOf, startGithubStatus, holdForGithubIncident, githubIncidentOrder,
  sharedFailuresNow, incidentSuppressions, deferredWakeCount, machineryCanaryNow } from "./work-gate/causes/org-health-github-incident.ts";
export type { GithubIncident } from "./work-gate/causes/org-health-github-incident.ts";
export { diskHeadroomOrders, diskHeadroomTick, deadMansSwitch, cannotAskReport } from "./work-gate/causes/org-health-host.ts";
export { primaryStaleOrders, withStalePrimaryNotice } from "./work-gate/causes/org-health-host-drift.ts";
export { fileResolverDefects } from "./work-gate/causes/org-health-resolver-defects.ts";
export { REVIEWER_REFRESH_LEDGER_FILE, CODEX_AUTH_FILE, CODEX_AUTH_FAILURE_TEXT, CODEX_LOGGED_OUT_SCREEN, REVIEWER_SILENCE_MS, readLastRefresh,
  readReviewerRegistry, authFailureShownIn, sessionsOwingVerdict, reviewerAuthFailures, reviewerAuthOrders, refreshLedgerLines, herdrPaneReader,
  reviewerAuthTick } from "./work-gate/causes/org-health-reviewer-auth.ts";
export { baseTipWhenRed, readRequiredContexts, requiredCheckNames, readBaseTip, shouldBeMerging } from "./work-gate/causes/pr-checks.ts";
export type { RequiredContexts } from "./work-gate/causes/pr-checks.ts";
export { readEjections, REENQUEUE_EJECTED_FLAG, failedEntriesSincePush, mergeGroupGreenSince, jobFailuresOf, ownershipOfFailure, readReenqueueState,
  requeueEjected } from "./work-gate/causes/pr-ejected.ts";
export type { EjectionFacts, MergeGroupRun, JobFailure, Ownership, EjectionEvidence, RequeueContext, RequeueOutcome } from "./work-gate/causes/pr-ejected.ts";
export { HOLD_HOLDERS_FILE, holdHolderOrdersNow } from "./work-gate/causes/pr-holds.ts";
export { reviewBlocked, pipelineCodeownerReviewMissing, CODEOWNER_REVIEW_APPROVED_ONLY_ENV, reviewableHead, noteRefusedRead, readPatchId,
  readCommitShas, reviewWait, withPatchIds, readFailingChecks, AWAITING_EVIDENCE_LABEL, AWAITING_EVIDENCE_QUIET_HOURS, AWAITING_EVIDENCE_QUIET_MS,
  awaitingEvidence, readEvidenceLabelledAt, withEvidenceLabelAges, readWorktreeStamps, stampLookup } from "./work-gate/causes/pr-reviews.ts";
export { checksSettledGreen, conclusionOf, stillRunning, anyChecksRed, blockingChecks, CONFLICT_STATE, conflictStateOf, conflictedPrs, reviewStateOf,
  REVIEW_STATE, BLOCKING_REVIEW_STATES } from "./work-gate/pr-state.ts";
export { EXIT, DRAIN_MARKER, draining, inRepo, repoNow, GH_READ_TIMEOUT_MS, ghWithin, defaultRun, releaseBehindNow, BATCH_MAX_CALLS,
  BATCH_OUTER_GRACE_MS, runBatch, OPEN_ROWS_LIMIT, readWithFirstWaveTogether, OPEN_PRS_FIRST_PAGE, OPEN_PRS_LIMIT, readPrs, withPagedFiles, GH_READS,
  GIT_READS, readRowBranches, readBranchPrs, branchesToReplace, readBranchPrsOfUnclaimed, readPromotableRows, readReadyRows, readOpenRows,
  readClaimedRowComments, ISSUE_LIST_COMMENT_CAP, readMergedPrs, withChecksPending, readElsewherePrs, systemctlRun, REPO_CHECKOUT, readUnarmed,
  readArming } from "./work-gate/reads.ts";
export { CONSTRAINT_COMMENT_MARKER, CONSTRAINT_BODY_PREFIX, constraintsAfterClaim, amendmentsOn, openBlockers, claimedRowAmendedOrders } from "./work-gate/causes/rows-amended.ts";
export { readClosedAnswerRows, closedAnswerRows, withoutEndedAnswerSessions, liveWorkspaceLabels, endedSessionLabels, withAnswerLabel,
  rowsOwingAnswers, blockedWithoutReferent, blockedReferentOrders, answersOwed, answerOrders, readRowTimeline, bareAnswerLabelOrders,
  answerGivenOrders } from "./work-gate/causes/rows-answers.ts";
export { AGED_BACKLOG_MS, agedBacklogOrders, CHAIRMAN_REMINDER_PERIOD_MS, chairmanReminderWindow } from "./work-gate/causes/rows-backlog.ts";
export { holderWaitingOn, BLOCKER_CLEARED_DROP_REASONS, PROMOTION_ASK_OFFSETS_MS, PROMOTION_ASK_PERIOD_MS, promotionAskWindow, readRecentlyClosed,
  unclaimedBlockerClearedOrders, unclaimedClearings } from "./work-gate/causes/rows-blocker-cleared.ts";
export type { BlockerClearedDropReason, BlockerClearedDrop, Closings } from "./work-gate/causes/rows-blocker-cleared.ts";
export { readChairmanBlocked, withChairmanEventTimes, chairmanReadsRefused, chairmanAnsweredOrders, daysSince, chairmanAsksNow } from "./work-gate/causes/rows-chairman.ts";
export { blockedOnOpenPr, blockedOnClaimedRow, blockersFromRows, partitionUnclaimed, UNCLAIMABLE_AFTER_TICKS, CLAIM_REFUSALS_FILE, claimRefusalOf,
  nextRefusalStreaks, claimRefusalStreaksNow, unclaimableRowOrders, rowBranchOrders, incompleteRowOrders, closesUnresolvedPrs, closesUnresolvedOrders } from "./work-gate/causes/rows-claims.ts";
export { readClosedClaimedRows, readClosedClaimLabelRows, declaredTrackerRepos, closedClaimLabelsWhenListed, closedClaimDebris } from "./work-gate/causes/rows-claims-closed.ts";
export { CLOSED_UNDER_HALF_FLAG, CLOSED_UNDER_HALF_FILE, CLOSED_UNDER_HALF_SESSION, rowsClosedUnderOpenHalf, closedUnderHalfOrders } from "./work-gate/causes/rows-closed-under-half.ts";
export type { ClosedUnderHalf, TrackerRows } from "./work-gate/causes/rows-closed-under-half.ts";
export { unfiledEpics, epicOrders, finishedEpics, finishedEpicOrders, epicRowsOf, doneWhenLines } from "./work-gate/causes/rows-epics.ts";
export { FLEET_GATED_SELECTOR, partitionFleetBatch, fleetBatchRows, fleetBatchOrders } from "./work-gate/causes/rows-fleet-batch.ts";
export { ROW_OFF_BOARD_GRACE_MS, readRowsOffBoard, rowsOffBoard, rowOffBoardOrders } from "./work-gate/causes/rows-off-board.ts";
export type { BoardFacts } from "./work-gate/causes/rows-off-board.ts";
export { milestoneRank, readChairmanPriority, EMERGENCY_PRIORITY_LABEL, EMERGENCY_SETTER_LOGINS, ORG_BLOCKING_INCIDENT_KEYS, EMERGENCY_PRIORITY_OFF,
  parseEmergencyPriorityOption, readEmergencyPriorityOption, readEmergencyPriority, PRODUCT_SHARE_WINDOW, PRODUCT_SHARE_FLOOR, ENGINEER_STARTS_FILE,
  SHARE_LINE_FILE, SHARE_LINE_REMINDER_MS, productRegionsOf, rowKind, productShare, offeredByShare, recordEngineerStarts, hierarchyOrders } from "./work-gate/causes/rows-offer.ts";
export type { OfferHierarchy, EmergencyPriorityOption, EmergencyIgnored, EmergencyHonoured, EmergencyReading } from "./work-gate/causes/rows-offer.ts";
export { blockerClearedReading, decide, labJobRecordsOrSay, dispatchedLabJobsOrSay, rowsOffBoardOrSay, anyBlockerClearingCandidate, readLanes,
  scopeTick, recordTickFailures, readScopeTrunkRed, pullRequestsOfOthers, unreadLanes, refusedReadCount, SHARED_OUTAGE_READS, sharedReadOutage,
  markOutageReads, claimStallsWithFacts, otherTrackerClaims, withClosedClaims, redPrFacts, readTrackerLanes, closedClaimsWhenWorkerListed,
  readChairmanPriorityOfOffer, offerHierarchyNow, REPEATING_LINE_SWITCH_ENV, CITE_PREFIX_CHARS, CITE_MIN_CHARS, CITE_VERIFY_MAX, isCountMilestone,
  citeNeedle, settleCitedRepeatingLines, OVERDUE_LIST_SWITCH_ENV, OVERDUE_LAST_WRITTEN_FILE, settleOverdueLists, ROW_OFF_BOARD_SWITCH_ENV,
  settleOffBoardRows, GREEN_UNARMED_SWITCH_ENV, settleUnarmedPrs, readArmingOf, REVIEW_BLOCKED_SWITCH_ENV, staleRefusalOf, withStaleRefusals,
  ghQueueTickOrSay } from "./work-gate/tick.ts";
export type { HomeRows, StaleRefusalPort } from "./work-gate/tick.ts";
export { NOT_PICKABLE, ROUTED_TO, NOT_STARTABLE, LANE_OWNER, laneOwnerOf, ownerOf, PARKED_LABEL, LAUNCH_PLACEHOLDER, labelledRows, CHAIRMAN_LOGINS,
  MAX_ROW_ORDERS_PER_TICK, PRIORITY_LABEL, labelsOf, comparablePrFiles, sessionOf, HOUR_MS, PROMOTION_ASK_WINDOW_MS, CHAIRMAN_PRIORITY_LABEL,
  REVIEWER_STATE_DIR, REVIEWER_REGISTRY_FILE, MS_PER_MINUTE, scopesOf } from "./work-gate/vocabulary.ts";
export type { Yielding, ScopeRepository, Scope, ArmingPort } from "./work-gate/vocabulary.ts";
export { hostUnitsEntry, rowsWithOpenPr, trackerReadings };

/**
 * PAID ONLY BY A TICK THAT CAN SEE A CLAIM. The `requiredWhenNeeded` shape: the
 * condition is derived from rows already in hand, so an org holding nothing makes no call.
 *
 * Extracted rather than written inline in `main` for the reason the two above it were -- `main`'s job is
 * to deliver what the gate found, and `complexity` counts every inline ternary there.
 *
 *
 * @returns `null` when not asked or refused -- `decide` treats both the same way
 */
function claimedRowCommentsWhenHeld(openRows: any[], run: (args: string[]) => string = defaultRun): any[] | null {
  const held = openRows.some((r) => labelsOf(r).includes(CLAIM_LABEL));
  return held ? readClaimedRowComments(run) : null;
}

// #4505 / agent-org#484: THE QUERY, THE PAGING AND THE MEMBERSHIP TEST MOVED TO THE TICKET PORT'S GITHUB ADAPTER (ADR 0046 decision 4). The
// name is kept: `graphql-pool-health.test.ts` pins that the query asks for `rateLimit` and `viewer`.
export { OPEN_ITEMS_QUERY as ROW_OFF_BOARD_QUERY } from "./ticket-port/github-adapter.ts";

/**
 * THE HOST WENT STALE ON A MERGE AND NOTHING IN THIS ORG FOUND OUT -- #2174.
 *
 * The shipped units are COPIES, not symlinks (`host-units.ts` says so in its own header and explains
 * why), so every merge touching `packages/agent-org/host/` makes the agent host stale the instant it
 * lands and changes nothing on the host. The only instrument that can see it is `pnpm run host:check`,
 * and until this cause NOTHING CALLED IT -- one file in `packages/agent-org/src` and the whole of
 * `.github/workflows` mentioned the drift reader, and that file was the one defining it.
 *
 * THREE INSTANCES IN 24 HOURS, and the third had a consequence. #2003's comment-only diff to
 * `a11ign-work-tick.service` left the host stale overnight, found only because somebody ran `host:check`
 * by hand. #2144 (#1998) merged 2026-09-23T14:04:06Z changing the board unit's `ExecStart`; eight hours
 * later the service manager still loaded the pre-#1998 program, and it would have dispatched the 06:10Z
 * board edition from 31 lines of untracked bash whose entire deliverable was that it stop being that
 * (#2173). A merge that changes nothing on the host is, from inside this org, indistinguishable from a
 * merge that worked.
 *
 * THE GATE IS ALREADY STANDING IN THE RIGHT PLACE, which is the whole reason this is cheap.
 * `a11ign-work-tick.service` runs on the agent host every two minutes with `pnpm run primary:update` as
 * its `ExecStartPre`, so the tick reads a checkout at most one tick behind `main` FROM the one machine
 * that can also read `~/.config/systemd/user`. Both sides of the comparison are already under its hand.
 * It spends NO API pool -- a `readdir`, some `readFileSync` and one `systemctl` spawn per shipped timer,
 * never a `gh` call -- so it does not touch the two-call budget the gate's whole design rests on.
 * MEASURED on this host, `hostUnitDrift({})` five runs: 78.0, 77.5, 83.3, 85.1, 81.5 ms, mean 81.1 ms.
 * At 720 ticks a day that is 58 seconds of CPU a day, against the 2.07s the same unit's `primary:update`
 * already costs per tick when there is nothing to do -- about 4% of a step the tick already pays for.
 * Not material, so nothing is short-circuited; measured first, which is what constraint 5 asked.
 *
 * DETECT AND WAKE, NEVER AUTO-INSTALL -- ruled on the row so review does not re-litigate it, and the
 * shipped code holds it: this function returns ORDERS and calls nothing. The tick COULD run
 * `host:install` itself and must not, because `hostUnitsInstall`'s removal loop deletes every installed
 * `a11ign-*` unit the tree does not ship, and this org has twice been one command away from losing a live
 * one -- the board dispatch pair (#1993) and the `worktrees:prune` pair (#2002), both hand-installed,
 * both offered for deletion by the remedy, both caught by a PERSON reading the output. A unit the tree
 * has not shipped YET is a normal state, not an error, and no automatic actor can tell it from a
 * retirement.
 *
 * KEYED ON THE DRIFT SET, NOT A COUNT AND NOT A CLOCK -- `fleetBatchOrders`'s rule, for its reason. The
 * key names every drifting unit AND its problem, sorted, so a second unit joining is a new question that
 * reaches the owner, a unit whose problem CHANGES (`NOT INSTALLED` becoming `STALE`) is a new question
 * too, and a host stale in exactly the same way on the next tick mints the identical key and the ledger
 * drops it. A count would collide two different drift sets of the same size, which is #1799's finding.
 *
 * AN ACTION CAUSE, so it is deliberately OUT of `JUDGMENT_CAUSES` and keeps `wake.ts`'s twenty-minute
 * expiry. It names a thing to DO -- read these findings, then run the remedy -- and if the wake does not
 * stick, nothing happens and nobody notices, which is the defect the expiry exists for (#1433, #1435 sat
 * Ready overnight behind a spent causeKey).
 *
 * A SET OF ONLY `manualFix` FINDINGS EMITS NOTHING, AND IS NOT DELIVERED TO ANYONE ELSE INSTEAD (#3703). The order's whole
 * remedy is `host:install`, and a `manualFix` finding is one `host:install` writes no line of (a person's `gh` login, #3643; a
 * dotfile; a Codex trust grant). Offered anyway, it is declined by `orchestrator` on every tick -- correctly -- and the same
 * `unit:problem` key is re-offered (the row measured 6 deliveries), then 30 consecutive ticks of a STUCK line
 * that cannot be escalated, because its subject is `host-units` and not a row. THREE WAYS OUT WERE WEIGHED. A wait on the file
 * it reads needs a new cause and a new ledger rule for one population. Routing it to `ceo` re-offers it to a session that also
 * cannot run anything, under the same expiry. Dropping it from THIS order deletes code and loses nothing the detector holds:
 * `host:check` still reports every `manualFix` finding, which is the detector this row does not touch. WHAT IS LOST, STATED
 * RATHER THAN HIDDEN: a NEW manual-only finding no longer wakes anybody on its own; org-health does not read host drift, so
 * `host:check` is its only reader. A set holding even ONE finding `host:install` can clear is unchanged -- same key, same
 * prompt, the manual findings still listed with their "NOT fixed by the remedy" line -- and once the remedy has run and only the
 * manual ones remain, the order ends by itself.
 *
 * `[]` AND `null` BOTH EMIT NOTHING, AND THEY ARE NOT THE SAME CLAIM. `hostUnitDrift` returns `[]` for a
 * clean host AND for a machine with no user systemd manager -- CI, a reviewer's laptop, a container --
 * and `null` here is a read that THREW. All three are silence, because none of them is a stale host; but
 * reading "not asked" as "all correct" is this repository's most-repeated defect, so `driftReport` keeps
 * the two apart in the CLI's output and the tests below assert the three separately rather than once.
 *
 *
 *        `host:check --json`'s findings.
 *        `null`/omitted is "not asked or refused" and emits nothing -- a caller that cannot read the
 *        host must never produce a false all-clear and must never invent a false alarm either.
 */
export function hostDriftOrders(drift: { unit: string; problem: string; detail: string; manualFix?: boolean; }[] | null | undefined): {
    session: string; cause: string; subject: string; discriminator: string;
    prompt: string; causeKey: string;
}[] {
  const findings = Array.isArray(drift) ? drift : [];
  if (findings.length === 0) return [];
  if (findings.every((f) => f.manualFix)) return []; // #3703: nothing the order's remedy can clear; see the header
  const key = findings.map((f) => `${f.unit}:${f.problem}`).sort().join(".");
  return [{
    session: HOST_DRIFT_SESSION,
    cause: "host-units-stale",
    subject: "host-units",
    discriminator: key,
    prompt: `The agent host has drifted from the tree: ${findings.length} finding(s).\n`
      + `${findings.map((f) => `  ${f.unit}: ${f.problem}\n    ${f.detail}`).join("\n")}\n`
      + "THIS IS A DETECTOR, NOT AN INSTALLER. The tick deliberately does not run the remedy: "
      + "`host:install` DELETES every installed `a11ign-*` unit the tree does not ship, and a unit the "
      + "tree has not shipped yet is a normal state no automatic actor can tell from a retirement. "
      + "Twice this org was one command away from deleting a live timer (#1993, #2002) and a person "
      + "reading the output is what stopped it both times.\n"
      + "SO READ BEFORE YOU RUN. Confirm no finding above is a live orphan -- a second reading that does "
      + "NOT go through the same reader, such as a diff of the installed `a11ign-*` set against "
      + "`packages/agent-org/host/` -- and say on the row what it said, whichever way it went. If that "
      + "reading disagrees with this one, STOP and report rather than running the remedy.\n"
      + "Then `pnpm run host:install`, and post whether any `REMOVED` line appeared: not one is expected, "
      + "and a `REMOVED` line is a finding rather than a step. `pnpm run host:check` answers it in the "
      + "same minute -- `hostUnitsInstall` runs `daemon-reload` itself, so nothing waits for the next "
      + "firing.\n"
      + "A STALE UNIT IS NOT A COSMETIC DIFF. The unit files are copies, so a merged edit reaches this "
      + "host only when somebody reinstalls -- and until then every property this repository can read "
      + "about that unit is a property of a file that is not the one running.",
    causeKey: `${HOST_DRIFT_SESSION}/host-units-stale/${key}`,
  }];
}

/**
 * `update-primary.ts --drift` -- SPAWNED, like `readHostDrift`, so the gate and `primary:update` read one question with one
 * reader and the gate's import closure does not grow. `null` for every unreadable case (a spawn that failed, a non-zero exit,
 * unparseable output, `asked: false`), which is silence and never a clean primary.
 */
function readPrimaryDriftNow(): import("./update-primary.ts").PrimaryDrift | null {
  const run = spawnSync(process.execPath, [fileURLToPath(new URL("./update-primary.ts", import.meta.url)), "--drift"], { encoding: "utf8" });
  if (run.status !== 0 || typeof run.stdout !== "string") return null;
  try {
    const parsed = JSON.parse(run.stdout);
    return parsed?.asked === true && parsed.drift ? parsed.drift : null;
  } catch {
    return null;
  }
}

/**
 * A QUESTION ONE SESSION OWES ANOTHER, SAID IN A FIELD RATHER THAN A SENTENCE.
 *
 * MEASURED OVERNIGHT 2026-09-20. `orchestrator` needed a ruling from `product-manager` and wrote the
 * question as a COMMENT on #914. Nothing in this org reads comments, so it went unseen -- it asked FIVE
 * TIMES over 6.5 hours, and `product-manager`'s own reply says it plainly:
 *
 *     "I should have confirmed sooner rather than let five asks go unanswered since 01:55Z."
 *
 * Both sessions behaved correctly. The escalation path is the one `agent-practices.md` prescribes. It
 * simply had no mechanism behind it, so it ran at the speed of someone happening to look.
 *
 * THE FOURTH INSTANCE OF ONE DEFECT, and the last of the set: `fleet-gated` (#1770), `blocked` (#1780),
 * `epic` (#1784), and now a question owed. Each time a session knew something that changed what should
 * happen next, and could only say it in prose.
 *
 * A LABEL AND NOT AN ASSIGNEE, and the data decided that rather than taste. Assignee was the obvious
 * choice -- GitHub's own field, unused on every open row -- until `repos/:o/:r/assignees` answered with
 * FOUR accounts (`a11ign-ai-workers`, `a11ign-bot`, `Cemmaw`, `DanBeckDev`) which the EIGHT sessions
 * share. An assignee structurally cannot say WHICH session owes the answer, which is the only thing this
 * needs to express. `answer:<session>` joins `session:*` and `hold:*`, an established and BOUNDED family
 * -- one label per session, not one per instance, so it cannot rot the vocabulary the way
 * `branch:agent/...` and `worktree:/private/tmp/...` already have.
 *
 * IT CLEARS ITSELF BY BEING ANSWERED: removing the label IS the act of answering, so there is no second
 * state to maintain and nothing to remember. Same property as `blockedBy` and `Not-before:`.
 *
 * THE NAME MOVED TO `waiting-condition.ts` AND IS RE-EXPORTED HERE (#2005), unchanged. It is a WAITING
 * CONDITION, and that module is the one reader of those -- declaring it here is what let every reader of
 * waiting conditions answer "is this row free?" as `yes` for three days while this same file was waking
 * a session to answer the question holding it. Re-exported rather than moved outright so no importer,
 * test or role brief has to change to say a thing that has not changed.
 */
export { ANSWER_PREFIX };

/**
 * #2161: the rows an open pull request DECLARES it closes -- the holders who have demonstrably acted.
 * `declaredClosedRows` is the parser B4 and B7 already share, so "this PR is the row's own work" means
 * one thing in all three places, and `Closes: none` and a malformed body both read as `[]` and so screen
 * nothing. It reads `prs` and not `comparablePrFiles`: that filter drops a PR whose file list is
 * truncated, which is right for an overlap comparison and would here silently withdraw the screen for
 * the largest pull requests -- the ones most likely to be a row's whole build.
 * #2493: a pull request carrying a `hold:` label does not count -- see the body.
 */
function rowsWithOpenPr(openPrs: any[] | null | undefined): (row: any) => boolean {
  // #2493: A HELD PR IS NOT AN ACT, IT IS A DECLARED WAIT. `hold:` is the owner saying "do not merge me yet", and the
  // wait behind it is a `blockedBy` edge (#2400 section 2) -- so the holder of a held PR is exactly who must hear
  // that the last edge closed. Counting it as "resumed" silenced the one wake the ruling relies on: #2376's owner
  // had an open PR naming #2359 and would never have been told #2399 merged.
  // agent-org#1162: a reference is read against the tracker the ROW is in, not the primary one. `Closes a11ign/agent-org#806` closes
  // another tracker's row #806, and a bare `#806` is that row only when the pull request is in the same repository.
  const open = (openPrs ?? []).filter((pr) => holdersOf(labelsOf(pr)).length === 0);
  return (row) => open.some((pr) => declaredClosedRows(pr?.body, { prRepo: pr?.repo, trackerRepo: row.repoKey ? row.repo : undefined })
    .includes(Number(row.number)));
}

/**
 * `blockerClearedReading`'s orders alone, for every caller that has no use for what was dropped (`decide`: the drops are said by `main`, once).
 */
export function blockerClearedOrders(...args: Parameters<typeof blockerClearedReading>) {
  return blockerClearedReading(...args).orders;
}

/**
 * #3883: THE ACT, and the only place the gate takes a label off a CLOSED row. The close path strips only a close it drives itself (`close-rows-for-merged-pr.ts`, and its sweep over
 * MERGED pull requests), so a row closed by hand, as not planned, or by a `Closes` GitHub resolved with another actor kept `in-progress` for ever and the pile refilled (#3866 stripped
 * 244 of 270 once). The decision a hand close cannot make -- is the holder listed -- is made here, where herdr's listing is already in hand, and the strip is the close path's own
 * (`stripClaimLabelsVia`), so the two cannot disagree on which labels go.
 *
 * SAID ON STDERR, NEVER STDOUT: stdout is the orders, one JSON line each. A row KEPT because its holder is listed is NAMED (it stays until that seat releases it), and an unread
 * read or an unasked one is said as such and never as "no debris". A refused edit is said and the tick goes on: the next tick asks again.
 *
 *
 * @returns how many rows had their labels taken off
 */
export function stripClosedClaims(asked: ReturnType<typeof closedClaimLabelsWhenListed>, { gh = defaultRun, say = (line) => process.stderr.write(`${line}\n`), repo = repoNow(), nowMs = Date.now() }: { gh?: (args: string[]) => unknown; say?: (line: string) => void; repo?: string; nowMs?: number; } = {}): number {
  if (asked === null) { say("GATE: closed rows' claim labels were NOT read this tick: herdr's listing was missing or incomplete, so no holder can be called unlisted."); return 0; }
  for (const unread of asked.unread) say(`GATE: the closed rows of ${unread} still carrying a claim label were NOT read this tick (the read was refused) -- none of its was stripped.`);
  if (asked.rows === null) return 0;
  const { strip, kept } = closedClaimDebris(asked.rows, asked.agents, nowMs);
  for (const { number, holders, repo: at } of kept) say(`GATE: closed ${at === undefined ? "" : `${at}`}#${number} keeps its claim labels: ${holders.join(", ")} is listed by herdr, and releases it.`);
  const results = strip.map(({ number, labels, repo: at }) => stripClaimLabelsVia(number, labels, at ?? repo, { gh, say, logPrefix: "GATE" }));
  return results.filter((result) => result === "stripped").length;
}

/** `host-units.ts` beside this file -- RESOLVED, never imported. See `readHostDrift` for why. */
function hostUnitsEntry() {
  return fileURLToPath(new URL("./host-units.ts", import.meta.url));
}

/**
 * The closing times `blockerClearedOrders` and `unclaimedBlockerClearedOrders` back off on, read ONLY when
 * some row -- claimed or not -- has a cleared blocker to ask about (#2286, widened by #2741). `openRows`
 * is already in hand, so the condition costs no call, and a quiet tracker pays nothing
 * (`GH_READS.conditionalOnClearedRows`). `null` when there is nothing to ask about OR the read was
 * refused -- in both cases the caller's fallback is the unstaged first ask.
 */
function closingsWhenRowsCleared(openRows: any[], run: (args: string[]) => string = defaultRun) {
  return (unclaimedClearings(openRows).length > 0 || anyBlockerClearingCandidate(openRows))
    ? readRecentlyClosed(run) : null;
}

/**
 * The reads about a scope's ROWS that are made per tick beyond the lists themselves. Run inside `inRepo` for the tracker repository.
 * #1085: `chairmanRows` is the tracker's own verified chairman rows, so a keyed scope offers its chairman's row first as `main` does (the labeller still decides).
 */
function trackerReadings({ allOpen, rows }: { allOpen: any[]; rows: any[]; }) {
  return { claimedComments: claimedRowCommentsWhenHeld(allOpen) ?? [], epics: epicRowsOf(allOpen),
    closedRows: closedAnswerRows(readClosedAnswerRows()), closings: closingsWhenRowsCleared(allOpen),
    chairmanRows: readChairmanPriorityOfOffer(rows, allOpen).chairmanRows };
}

/**
 * (agent-org#1240) THE POOL THIS TICK LEFT, read ONCE PER PROCESS: `readOtherScopes` (inside the first wave, which asks it twice) and `main` both
 * ask it, so the probe is one call. Flag off, it reads nothing and paces nothing.
 */
let tickPool: Pacing | undefined;
export function tickPacing(): Pacing {
  tickPool ??= pacingNow(defaultRun, pacingOn());
  return tickPool;
}

/**
 * Every NON-PRIMARY scope the declaration lists, with its lanes read ONCE. Empty for one project, which is what keeps one project's orders
 * identical to what they were. #3095: read BEFORE the primary's own B4 comparison, because that comparison needs these pull requests too,
 * and handed on to `otherScopeTicks` so it is not a second read.
 * (#3566) THEIR FIRST READS GO OUT TOGETHER (`readWithFirstWaveTogether`), one wait for the repositories instead of one per repository.
 *  @param [batch] the default is `runBatch` for `gh` itself and none for a `run` handed in
 */
export function readOtherScopes(run: (args: string[], repo?: string) => string = defaultRun, batch: typeof runBatch | undefined = run === defaultRun ? runBatch : undefined): { scope: Scope; read: ReturnType<typeof readLanes>; }[] {
  const scopes = scopesOf([homeProjectDeclaration()]).filter((scope) => scope.key !== "");
  // agent-org#1240: BELOW THE RESERVE none are read (and `main` reports them unread); on a webhook tick (flag on) only the repositories the events named, and those due a sweep; every one otherwise
  const wanted = isAmbientRun(run) && tickPacing().paced ? [] : otherScopesToRead(run, scopes);
  return readWithFirstWaveTogether((aimed) => wanted.map((scope) => ({ scope, read: readLanes(scope, aimed) })), run, batch);
}

/**
 * #1075: THE WAIT READ, ONCE, AHEAD OF THE DECISION -- so `partitionUnclaimed` can shelve a ready row whose body names a condition not yet true. `orgHealthNow`
 * takes this SAME read as its `readWaits` (below), so the gate makes the wait reads it always made, only earlier. A refused list is `null`, and the offer fails open.
 */
function waitReadsBeforeDecide(prs: any[] | null, otherScopes: Parameters<typeof pullRequestsOfOthers>[0], openRowsRead: any[] | null, state: CanaryState) {
  return waitTickFacts({ prsRead: prs === null ? null : [...prs, ...pullRequestsOfOthers(otherScopes)], openRowsRead: withTrackerRows(openRowsRead, otherScopes, state), now: Date.now() });
}

/**
 * #2849: `decide`, with the call RECORDED for the shadow-window runner (#2846): the arguments it was given and its RAW return, before
 * `withStalePrimaryNotice`. A helper rather than three lines in `main`, which is at its physical-line limit. DORMANT unless
 * `<stateDir>/shadow-window-open` exists, and a failed write is a stderr line, never a different tick (`shadow-reads.ts`).
 */
function decideAndTap(args: Parameters<typeof decide>[0]): ReturnType<typeof decide> {
  const orders = decide(args);
  tapShadowReads({ args, orders, stateDir: REVIEWER_STATE_DIR });
  reportClearingDrops(args);
  return orders;
}

/**
 * (#3566, slice 6) THE TRACKER LANES AND THE OTHER REPOSITORIES' LISTS, ONE WAVE. `readTrackerLanes` and `readOtherScopes` each made their first reads
 * together, but one after the other: a gate run with its spawns traced showed the tracker's three calls as one batch (1.7 s) and the other repositories'
 * seven as the next (1.3 s), neither needing the other's answer. Asked here, the calls of both go out as one batch and cost the slowest. The readers
 * are called with the rehearsal's own `run`, so they make no batch of their own, and only WHEN the waiting happens moves. It is asked AFTER the outage
 * check, as slice 5 asks the tracker lanes (an outage tick must not ask more refused questions), and so `readPrs` and `readReadyRows`, which that check
 * reads, stay outside it.
 */
export function readLanesAfterOutageCheck(run: (args: string[], repo?: string) => string = defaultRun, batch: typeof runBatch | undefined = run === defaultRun ? runBatch : undefined) {
  // agent-org#1240: on an event-gated tick the primary's tracker lanes are read only when an event named the home repository (or its sweep is due); otherwise they are the refused nulls
  return readWithFirstWaveTogether((read) => ({ ...primaryLanes(read, homeScopeOf(), () => readTrackerLanes(read), { promotableRows: null, chairmanBlocked: null, openRowsRead: null }), otherScopes: readOtherScopes(read) }), run, batch);
}

/** The primary's own scope: the declaration's key `""`, which `scopesOf` gives first. `undefined` if the declaration names none, and the primary is then always read. */
function homeScopeOf(): Scope | undefined {
  return scopesOf([homeProjectDeclaration()]).find((scope) => scope.key === "");
}

/**
 * (#3566, slice 5) THE READS THAT NEED THE OPEN ROWS IN HAND, ASKED TOGETHER: the claimed rows' comments, the label list that opens the closed-answer
 * read, the recently-closed rows, and (#3535) the closed rows still carrying a claim. Each stays CONDITIONAL on the rows exactly as before (`claimedRowCommentsWhenHeld`, `closingsWhenRowsCleared`
 * decide from `allOpen`, so a quiet tracker asks for nothing extra: the rehearsal asks only what the rows in hand ask for). The closed-answer
 * read's two searches are built from its label list's answer, so only the label list joins the batch and the searches follow one at a time.
 * `null` is each read's own refusal (#1286), and `closedRows` is raw, for `closedAnswerRows` to say.
 *
 * `listWorkspaces` is herdr's listing, read ONCE and before the rehearsal (which runs `read` twice, so a spawn inside it would be two). It defaults to the live
 * listing only for the live `gh`, as `batch` does: a test's `run` stands for `gh` alone and must not spawn `herdr`.
 */
export function readOpenRowFollowUps(allOpen: any[], run: (args: string[], repo?: string) => string = defaultRun, batch: typeof runBatch | undefined = run === defaultRun ? runBatch : undefined,
  listWorkspaces: typeof readAgents | undefined = run === defaultRun ? readAgents : undefined) {
  const agents = listWorkspaces === undefined ? [] : listWorkspaces();
  return readWithFirstWaveTogether((read) => ({
    claimedComments: claimedRowCommentsWhenHeld(allOpen, read),
    closedRows: readClosedAnswerRows(read),
    closings: closingsWhenRowsCleared(allOpen, read),
    closedClaims: closedClaimsWhenWorkerListed(agents, read),
    closedClaimLabels: closedClaimLabelsWhenListed(listWorkspaces === undefined ? null : agents, read), // #3883: the SAME listing, never a second read of herdr
    agents: listWorkspaces === undefined ? null : agents, // #4205: and the dead man's switch reads the same listing; `null` is "not asked", which counts every claim
  }), run, batch);
}

/**
 * agent-org#1208: THE TICK WALL'S p50/p95 AND THE `tick-overran` WAKES OF THE LAST 24 h, from the cost file and the wake ledger the tick keeps beside each other. `null` is a cost
 * file that could not be read (a stated unknown, never a clean window); an unreadable ledger leaves the wakes "not read", never 0.
 */
function tickHealthNow(): TickHealth | null {
  const text = (path: string): string | null => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  };
  const costText = text(stateEntryPath(TICK_COST_FILE));
  if (costText === null) return null;
  return tickHealthOf({ costText, ledgerText: text(stateEntryPath("wake-ledger")), now: Date.now() });
}

function main() {
  refuseUnknownFlags([], { entry: import.meta.url, command: "node packages/agent-org/src/work-gate.ts" });
  const githubStatus = endGateSpan("startup", startGithubStatus()); // #3723: FIRST, so its wall overlaps the reads below and never adds to them
  // READ BEFORE ANY GITHUB CALL (#2163), because it is the one reading a `CANNOT_ASK` exit must not hide: a tick
  // that cannot reach GitHub delivers nothing, so on that path the stderr line is the only thing that says the
  // disk is full. Its ORDER is put in front of the others further down.
  const diskOrders = endGateSpan("diskHeadroom", diskHeadroomTick()); endGateSpan("ghQueue", ghQueueTickOrSay()); // #4898: BEFORE any read, which it does not wait on; `main` is at its line limit
  const prs = endGateSpan("readPrs", readPrs());
  const readyRows = endGateSpan("readReadyRows", readReadyRows());

  // BOTH LANES REFUSED IS `CANNOT_ASK`; ONE IS `PARTIAL`. Nothing here may report a refused read as quiet.
  if (prs === null && readyRows === null) {
    process.stderr.write(cannotAskReport({ run: defaultRun, identity: declaredGhAccount() }));
    process.exit(EXIT.CANNOT_ASK);
  }

  // The third read is only needed to size the refill, and a refused one must not read as an empty shelf.
  // #3566: this one, `needs:chairman` and the open rows (`openRowsRead`) are asked TOGETHER, and with the other repositories' lists (slice 6).
  // agent-org#1240: BELOW THE POOL'S RESERVE (flag on), `orgHealth` and the other repositories are skipped and REPORTED unread (`pacedSkips`)
  const pacing = endGateSpan("pacing", tickPacing());
  // agent-org#1240: ON AN EVENT-GATED TICK the primary's tracker lanes are read only when an event named it (or its sweep is due), and `orgHealth` with them; the other repositories the events did not name are dropped. Each is REPORTED unread
  const declaredOthers = scopesOf([homeProjectDeclaration()]).filter((scope) => scope.key !== "");
  const primaryRead = primaryDue(defaultRun, homeScopeOf());
  const { promotableRows, chairmanBlocked, openRowsRead, otherScopes } = readLanesAfterOutageCheck(); endGateSpan("readLanes");
  const eventUnread = pacing.paced ? [] : unreadScopes(defaultRun, declaredOthers); // read BEFORE the memory is stamped: a repository just read would otherwise look dropped
  rememberOtherScopesRead(otherScopes, primaryRead && promotableRows !== null && chairmanBlocked !== null && openRowsRead !== null ? (homeScopeOf()?.key ?? null) : null);
  const pacedSkips = [{ refused: pacedUnread(pacing, declaredOthers.length > 0) }, { refused: primaryUnread(pacing, primaryRead) }, { refused: eventUnread }]; const reenqueueState = readReenqueueState(); const waitReads = endGateSpan("waitReads", waitReadsBeforeDecide(prs, otherScopes, openRowsRead, reenqueueState)); // #3095: `otherScopes` is read here, once -- B4 below compares with their pull requests, and `otherScopeTicks` ticks them
  // agent-org#5177: the other trackers' parked rows, which `otherScopeTicks` ticks but the home seam never reads; flag `rows.autoUnpark` in `machinery-canary.json` (not project.json), default OFF.
  unparkOtherTrackers({ state: reenqueueState, scopes: otherScopes.flatMap(({ scope, read }) => (scope.tracker === null ? [] : [{ repo: scope.tracker.repo, rows: read.openRows }])), facts: waitReads?.facts ?? null, now: Date.now(), run: defaultRun, log: (line) => process.stderr.write(line) });
  const unreadChairmanRows = endGateSpan("chairmanReads", chairmanReadsRefused(chairmanBlocked ?? [])); // #3390: said, not skipped -- an unread row is not an unanswered one
  if (unreadChairmanRows.length > 0) process.stderr.write(`chairman-answered: could not read the timeline of ${unreadChairmanRows.map((n) => `#${n}`).join(", ")}; those rows are NOT checked this tick\n`);
  // ONE COALESCE PER REFUSED LANE, NAMED. `prs ?? []` was written three times and `readyRows ?? []` twice;
  // each repetition is a branch `complexity` counts, and the names say what an empty list MEANS here --
  // a lane that could not be read, already reported as PARTIAL below, never a lane that is empty.
  const openPrs = prs ?? [];
  const rows = readyRows ?? [];
  const prFiles = endGateSpan("prFiles", comparablePrFiles([...openPrs, ...pullRequestsOfOthers(otherScopes)]));
  const drain = draining();
  // ONE READ, THREE CAUSES -- and the refusal is kept BESIDE the coalesced list rather than instead of
  // it. `decide`'s label-derived causes want a list to filter, and an empty one is the right degradation
  // there; the dead man's switch needs to tell "refused" from "empty", so it is handed the raw result.
  // Both names exist so neither reader has to infer which of the two it was given (#1938).
  const allOpen = endGateSpan("promoted", promotedWhenUnblocked(openRowsRead ?? [])); // #4064: BEFORE any cause reads the rows, so a row promoted here is not offered to `product-manager` as unpromoted
  const { claimedComments, closedRows, closings, closedClaims, closedClaimLabels, agents: herdrListing } = readOpenRowFollowUps(allOpen); endGateSpan("followUps"); // #3566: asked together, each still conditional on the rows in hand
  const strippedClosedClaims = stripClosedClaims(closedClaimLabels); endGateSpan("stripClosedClaims"); // #3883: the closed rows whose holder herdr does not list lose their claim labels, in the tick that read them
  recordRouteOutcomesOnHost(closedClaimLabels !== null, { gh: defaultRun }); endGateSpan("routeOutcomes"); // agent-org#752: the outcome of each closed routed row, written here because the log is on this host and the close script runs on a runner
  // #2031: A LOCAL git CALL, NOT AN API ONE -- it adds nothing to `GH_READS` and cannot be refused by an
  // exhausted pool, which is the whole reason the detection can exist. `GIT_READS` counts it.
  const offerHierarchy = endGateSpan("offerHierarchy", offerHierarchyNow(rows, allOpen)); // #4524: who the chairman's rows are, from the tracker's history, and the declared milestone ranking
  const rowBranches = endGateSpan("rowBranches", readRowBranches()), branchPrs = endGateSpan("branchPrs", readBranchPrsOfUnclaimed(rows, rowBranches)); // #3892: one `pr list` per branch of an unclaimed row, none when there is none
  const pools: import("./org-health.ts").PoolReading[] = []; // #3448: the GraphQL budget the off-board read names, handed to the org-health tick
  const offBoard = rowsOffBoardOrSay(undefined, pools), primaryDrift = readPrimaryDriftNow(); endGateSpan("offBoard+primaryDrift"); // #2781: local git, once; it feeds `decide` and banners its orders
  // #1969: NAMED RATHER THAN CALLED TWICE. `shouldBeMerging` needs the same answer `decide` does, and
  // `requiredWhenNeeded` makes a `gh` call when anything is red -- calling it inline in both places would
  // pay for it twice on exactly the red tick this row is about.
  const required = endGateSpan("required", requiredWhenNeeded(openPrs));
  const baseTip = endGateSpan("baseTip", baseTipWhenRed(openPrs)), armingSplit = endGateSpan("arming", readArmingOf(openPrs, required)); // #3019: BEFORE the arguments -- ejected PRs are stamped onto `prs` and leave `unarmed`; agent-org#488: the gate arms a lone unarmed one here
  const decideArgs = { primaryDrift, prs: endGateSpan("withStaleRefusals", withStaleRefusals(endGateSpan("withVerifyStamps", withVerifyStamps(endGateSpan("withEjections", withEjections(endGateSpan("withWaitingEdges", withWaitingEdges(endGateSpan("withPrOwners", withPrOwners(endGateSpan("withEvidenceLabelAges", withEvidenceLabelAges(endGateSpan("withPatchIds", withPatchIds(openPrs, defaultRun, required)))), allOpen, stampLookup(), { agents: liveWorkspaceLabels, ended: endedSessionLabels })), allOpen, { dir: REVIEWER_STATE_DIR })), armingSplit?.ejections)), { checkout: verifyCheckoutOf("") })), required)), readyRows: rows, promotableRows: promotableRows ?? [],
    chairmanBlocked: chairmanBlocked ?? [], prFiles, drain, required, baseTip, waitFacts: waitReads?.facts ?? null,
    epics: epicRowsOf(allOpen),
    answerOwed: rowsOwingAnswers({ openRows: allOpen, openPrs, closedRows: closedAnswerRows(closedRows) }),
    openRows: allOpen,
    // #2110: CONDITIONAL, and the condition is answered for free from the list already in hand --
    // `readOpenRows` fetched the labels, so "is anything claimed at all" costs no call. A quiet org with
    // nothing in progress pays nothing; a busy one pays exactly one, whatever the size of the queue.
    claimedComments: claimedComments ?? [],
    // #2470: the SAME comments, read once, and the raw `null` kept for the reader that must tell "refused" from "none".
    ...endGateSpan("claimStalls", withClosedClaims(claimStallsWithFacts(openRowsRead, claimedComments, prs, otherScopes, {}, waitReads?.facts ?? null), closedClaims)), // #3451: the orders AND the facts they were built from
    // #1969: CONDITIONAL, and the condition is answered for free from the list already in hand.
    // `shouldBeMerging` reads `openPrs`; only if it finds a green, unheld, non-draft PR is the
    // merge-queue call made at all.
    unarmed: armingSplit === null ? null : armingSplit.unarmed, rowBranches, branchPrs, claimRefusals: endGateSpan("claimRefusals", offeredRefusalStreaks(rows, prFiles, { rowBranches, branchPrs, openRows: allOpen, chairmanRows: offerHierarchy.chairmanRows })), offerHierarchy,
    // #2174: A LOCAL READ, NOT AN API ONE -- a `readdir`, some `readFileSync` and one `systemctl` spawn
    // per shipped timer. It adds nothing to `GH_READS` and cannot be refused by an exhausted pool, which
    // is what lets the detection exist at all.
    hostDrift: endGateSpan("hostDrift", readHostDrift()),
    // #2286: CONDITIONAL, and the condition is answered for free from the list already in hand.
    closings,
    // #2356: `null` for a refused read or a green `main`, and the two need no telling apart HERE -- both
    // emit nothing, and a refused read is not reported as health because nothing else reads "trunk is fine".
    trunkRed: endGateSpan("trunkRed", readTrunkRed()),
    // #2075: ONE GRAPHQL CALL, READ PER ISSUE. `null` (refused) emits nothing and is said on stderr below. agent-org#490: `settleOffBoardRows` boards the rows whose label names a Status first.
    // #2691's `callCountSignals` is beside it, costing no `GH_READS`; `claimedComments` (#2710's window anchor) is the SAME read made above.
    offBoard: endGateSpan("settleOffBoard", settleOffBoardRows(offBoard, { openRows: allOpen, portFor: boardingPortOf })), callCountSignals: endGateSpan("callCountSignals", rowCallCountSignals(allOpen, liveClaudeTurns(), claimedComments, { waitClearedAt: readWaitClearedAt })), bareAnswerLabels: endGateSpan("bareAnswerLabels", bareAnswerLabelOrders(withAnswerLabel([...allOpen, ...openPrs]), defaultRun, Date.now())), answerGiven: endGateSpan("answerGiven", answerGivenOrders(allOpen)), labJobs: endGateSpan("labJobs", labJobRecordsOrSay()), ...endGateSpan("engineerShare", engineerShareReads(allOpen)) }; const decided = endGateSpan("decide", withStalePrimaryNotice(decideAndTap(decideArgs), primaryDrift)); // #2711, #2729, #3632; `main` is at its 90-line limit
  const others = endGateSpan("otherScopes", otherScopeTicks(drain, otherScopes, openPrs, homeRowsOf(allOpen))); // #4386: `homeRowsOf` -- so an agent-org pull request is owned by the worker its branch names. #2618: the OTHER declared repositories -- none for one project, whose orders are what they were
  endGateSpan("tickFailures", recordTickFailures({ trunkRed: decideArgs.trunkRed, keyedTrunkReds: others.map((tick) => ({ repo: tick.repo, red: tick.trunkRed })), prs: decideArgs.prs }));
  endGateSpan("resolverDefects", fileResolverDefects([...resolverDefectsOf(decideArgs.prs, allOpen), ...others.flatMap((tick) => tick.defects)])); // #4386: a fallback order for a PR that named a live claimant files its own defect, once per PR
  const outageNow = outageThisTick({ prs, readyRows, promotableRows, chairmanBlocked, openRows: openRowsRead, claimedComments, offBoard, others });
  const incident = endGateSpan("incident", holdForIncidentNow(githubStatus, [...decided, ...others.flatMap((tick) => tick.orders)], { prs: [...openPrs, ...pullRequestsOfOthers(otherScopes)], required }));
  const { delivered: orders, performed: performedOnPrs } = endGateSpan("performActions", performActions(markOutageReads(incident.orders, outageNow)));
  const performed = performedOnPrs + strippedClosedClaims; // #3883: a tick that took labels off a closed row did something, and must not read as an idle org
  orders.push(...incident.signal);
  // #4602: THE SAME `blocked` THE TICK REPORTS AS WITHHELD (below), counted per holder and over time -- computed once, so the count and the report cannot disagree.
  const shelvedHere = partitionUnclaimed(rows, prFiles, { rowBranches, branchPrs, openRows: allOpen, chairmanRows: offerHierarchy.chairmanRows, waitFacts: waitReads?.facts ?? null }).blocked;
  const keyedTrackers = otherScopes.flatMap(({ scope, read }) => (scope.tracker === null ? [] : [[scope.tracker.repo, read.openRows ?? []] as const])); // agent-org#695: each keyed tracker's rows by repository, which its shelvings' bare numbers are among
  const shelvedElsewhere = others.flatMap((tick, at) => tick.blocked.map((row) => ({ ...row, repo: otherScopes[at].scope.tracker?.repo })));
  orders.push(...endGateSpan("blockingImpact", blockingImpactOrders({ shelved: [...shelvedHere, ...shelvedElsewhere], openRows: allOpen, trackers: Object.fromEntries(keyedTrackers), prs: [...openPrs, ...pullRequestsOfOthers(otherScopes)], stateDir: REVIEWER_STATE_DIR })));
  orders.push(...endGateSpan("chainWait", chainWaitOrders({ prs: [...openPrs, ...pullRequestsOfOthers(otherScopes)], rows: allOpen, stateDir: REVIEWER_STATE_DIR, state: readReenqueueState(), now: Date.now(), log: (line) => process.stderr.write(line) }))); // a11ign#5126: flag `queue.chainWaitWake`, OFF by default
  orders.push(...endGateSpan("closedUnderHalf", closedUnderHalfOrders({ prs: [...openPrs, ...pullRequestsOfOthers(otherScopes)], homeRepo: repoNow(), stateDir: REVIEWER_STATE_DIR, state: readReenqueueState(), log: (line) => process.stderr.write(line),
    trackers: [{ repo: repoNow(), rows: openRowsRead }, ...otherScopes.flatMap(({ scope, read }) => (scope.tracker === null ? [] : [{ repo: scope.tracker.repo, rows: read.openRows }]))] }))); // a11ign#5125: a row closed under an open half is said once; `null` rows are a refused read and say nothing
  orders.push(...endGateSpan("queueEntryNoRun", queueEntryNoRunOrders({ prs: [...openPrs, ...pullRequestsOfOthers(otherScopes)], scope: repoNow(), run: defaultRun, state: readReenqueueState(), stateDir: REVIEWER_STATE_DIR, now: Date.now(), log: (line) => process.stderr.write(line) }))); // agent-org#1195: flag `queue.queueEntryNoRun`, OFF by default; reads and writes nothing while it is
  const releaseSeen: { runs?: ReleaseRuns | null } = {}; // a11ign#5100: the release read `orgHealthNow` makes, kept for the canary, so it costs no second call
  orders.push(...endGateSpan("reviewerAuth", reviewerAuthTick({ orders })), ...endGateSpan("repeatingLines", repeatingLinesTick({ settle: (groups) => settleCitedRepeatingLines(groups, { openRows: [...(openRowsRead ?? []), ...otherScopes.flatMap(({ read }) => read.openRows ?? [])], portFor: portOf }) })), ...endGateSpan("orgHealth", orgHealthSkipped(pacing, primaryRead) ? [] : orgHealthTogether({ prsRead: prs, keyedPrsRead: pullRequestsOfOthers(otherScopes), readyRead: readyRows, openRowsRead, claimedComments: claimedCommentsForClock(allOpen, claimedComments), decideArgs, decided, held: incident.held, pools }, { readToolAgreement, readNodeStrips,
    raiseReleaseIncidents: (reads) => { fileReleaseIncidents(reads, { run: defaultRun, tracker: repoNow() }); }, // agent-org#887: every repository the org releases; the project's runs are read in the wave below
    readClassRepeat: () => readClassRepeat(defaultRun, repoNow(), liveClassRepeatIo()), readReleaseBehind: releaseBehindNow, readFlagSwitches: readFlagSwitchesFor(openRowsRead), readTickRecord: () => readTickRecordState(stateEntryPath(TICK_RECORD_FILE)), readTickHealth: tickHealthNow, readWaits: unparkingWaits(() => waitReads, { run: defaultRun }) },
    // agent-org#1225: the org's gh reads asked together (the wave), then the effects above, in their order, on the data the wave read
    { repo: repoNow(), openRowsRead, claimedComments: claimedCommentsForClock(allOpen, claimedComments), now: Date.now(), onReleaseRuns: (runs) => { releaseSeen.runs = runs; } })),
    ...endGateSpan("rulingOrders", rulingOrdersNow({ prsRead: prs, openRowsRead, now: Date.now() })), ...chairmanAsksNow(openRowsRead),
    ...holdHolderOrdersNow({ prs: prs === null ? null : [...prs, ...pullRequestsOfOthers(otherScopes)] })); // #2848, #2936, #2997, #4020, #4970: before the dead man's switch -- a repeating line, a stuck org: something found
  endGateSpan("chairmanAsks+holdHolders");
  // #1329: THE CANARY COUNTS REFUSED LANES ONLY. A repository the gate skipped BY DESIGN (paced, or no event named it) is not blind, so it
  // stays out of `blind-ticks`; it is still named on the PARTIAL line below, which is where a skipped lane is reported.
  orders.push(...machineryCanaryNow({ unread: unreadLanes({ prs, readyRows, others }), unarmed: armingSplit === null ? null : armingSplit.unarmed, releaseRuns: releaseSeen.runs ?? null, suppressions: incident.suppressions, stranded: armingSplit?.stranded ?? [] })); endGateSpan("machineryCanary"); // a11ign#5100, a11ign#5125
  endGateSpan("approvedUnqueued", approvedUnqueuedNow({ prs: prs === null ? null : [...prs, ...pullRequestsOfOthers(otherScopes)], repos: homeProjectDeclaration().tracker.map((t) => t.repo), repo: repoNow(), stateDir: REVIEWER_STATE_DIR, run: defaultRun })); // agent-org#893: the daily reading on #928; never throws, adds no order
  // FIRST OF ALL, AND ON PURPOSE (#2163): `wake` delivers in this order and records each delivery with a write, so
  // on a full disk the tick can end partway. The order that says the disk is full must not be the one behind it.
  orders.unshift(...diskOrders);
  orders.push(...endGateSpan("repeatedOrders", repeatedOrdersTick())); // #5147: flag-gated (`orders-verifiable`); a repeat the holder ignored is an incident, filed once
  orders.push(...deadMansSwitch({ orders, drain, performed, openRows: openRowsRead, agents: herdrListing }), ...retrospectiveTick()); endGateSpan("deadMansSwitch+retrospective"); // #2938: AFTER the switch, which reads `orders` -- a once-a-day offer must not mask a stall
  // #4065: LAST, and AFTER the switch above: a stuck org that found something is not a quiet org, even when `ceo` is not woken for it. Only the `org-health` orders to `ceo` are held, and the digest rides the first order `ceo` still gets.
  const emitted = quietOrgHealth(settleOverdueLists(orders, { portFor: portOf }), { dir: REVIEWER_STATE_DIR }); endGateSpan("settleOrders"); // agent-org#491: the `overdue` list is a row write, not an order
  for (const order of emitted) process.stdout.write(`${JSON.stringify(order)}\n`);

  // BOTH SHELVES ON ONE LINE-SHAPE. The engineer pool's B4/declared-wait shelvings and the fleet batch's
  // (#2027) are the same fact -- work the gate can see and is deliberately not offering -- and a row that
  // leaves a set silently is the defect both filters exist to fix.
  endGateSpan("reportWithheld", reportWithheld({ drain, blocked: [...shelvedHere, ...partitionFleetBatch(allOpen).waiting, ...others.flatMap((tick) => tick.blocked)] }));

  const unread = unreadLanes({ prs, readyRows, others: [...others, ...pacedSkips] });
  if (unread.length > 0) exitPartial(unread, emitted.length);
  // PERFORMED COUNTS AS WORK. A tick that marked a draft ready did something, and exiting QUIET would
  // report it as an idle org to every reader of this exit code.
  process.exit(emitted.length > 0 || performed > 0 ? EXIT.WORK : EXIT.QUIET);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();

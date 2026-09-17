#!/usr/bin/env node
// @ts-check
// command: ask whether a PR's checks actually ran and passed, never trusting mergeStateStatus alone
// IS THIS PR ACTUALLY TESTED? -- asked of the check RUNS, never of `mergeStateStatus`.
//
// `mergeStateStatus` cannot tell "every required check passed" from "no check ever ran", and on
// 2026-09-07 the second one presented as the greenest PR on the board. #148's base was another open PR's
// branch rather than `main`:
//
//     #148  lead/gate-ages-what-it-scored -> lead/real-page-outcome-is-stated
//     CLEAN/MERGEABLE   check-runs: []   182 insertions into check-real-page-findings.ts
//
// `ci.yml` is `on: pull_request: branches: [main]`, so a PR into a non-`main` base triggers no workflow
// at all and branch protection -- which covers `main` -- applies to nothing. **`CLEAN/MERGEABLE` is the
// CORRECT answer to the question GitHub was asked**, which is exactly what makes it dangerous: a required
// context that never ran is not a failing check, it is NO check, and the field cannot express the
// difference. That is this repository's most-recorded defect -- a check reporting cleanly having examined
// nothing -- arriving in the merge flow itself. It was caught by a human noticing the check-run list was
// EMPTY rather than green.
//
// THIS TOOL THEREFORE NEVER READS `mergeStateStatus`, and `merge-guard.test.ts` asserts that it does not.
// A verification that shares a failure mode with the action verifies nothing -- the same rule as checking
// `/health` over HTTP rather than through the deploy channel that just failed.
//
//   node packages/agent-org/src/merge-guard.mjs <pr-number> [--session=<name>] [--allow-claimed-close=<name>]
//
// Exit codes are the contract:
//   0  READY      -- based on main, every required context present and concluded, tested against this main
//   1  REFUSED    -- and it NAMES which of the reasons, because they need different fixes
//   2  CANNOT ASK -- a lookup failed. INCONCLUSIVE, never "fine": reporting an unaskable question as
//                    clean is how "verified" comes to mean "unexamined"
//
// #455 (A4 of the merge-conflict-prevention plan): ONE MODULE PER RULE, THIS FILE KEEPS THE ENTRY POINT.
//
// Three changes to this one file in one night produced two conflicts and a deadlock between rules nobody
// read together (#442, the armed-race rule and the ancestry rule interacting under strict protection --
// see `packages/agent-org/src/merge-guard/armed-race-rule.mjs` for the full account). Each check now lives in its own
// file under `packages/agent-org/src/merge-guard/`, with its own test, so a rule can be read, changed and
// mutation-checked without touching the seven others:
//
//   packages/agent-org/src/merge-guard/base-rule.mjs          is the PR based on `main`?               (#148)
//   packages/agent-org/src/merge-guard/head-tip-rule.mjs       does GitHub's recorded head match the tip? (#294/#195)
//   packages/agent-org/src/merge-guard/checks-rule.mjs         did every required context run and conclude? (#148)
//   packages/agent-org/src/merge-guard/staleness-rule.mjs      did every run finish after main's CURRENT tip? (#100/#135)
//   packages/agent-org/src/merge-guard/ancestry-rule.mjs       does this head CONTAIN main's tip?        (#182/#165)
//   packages/agent-org/src/merge-guard/claimed-row-rule.mjs    would arming close a row someone else holds? (#249)
//   packages/agent-org/src/merge-guard/pr-hold-rule.mjs        is somebody else actively working this PR?  (#266/#258)
//   packages/agent-org/src/merge-guard/armed-race-rule.mjs     would a push race an already-armed merge?    (#386/#442)
//
// Two more modules hold shared machinery that is not itself a refusal rule, so splitting it per-rule
// would recreate the fact-stated-twice shape rather than fix it:
//
//   packages/agent-org/src/merge-guard/reason-kind.mjs         classifies a reason string -- read by every rule's own
//                                                test AND by the reconciliation log below
//   packages/agent-org/src/merge-guard/lookups.mjs             the network/process calls every rule's facts come from
//   packages/agent-org/src/merge-guard/reconciliation.mjs      #188's verdict log and its `--reconcile` comparison
//
// This file composes them (`mergeReadiness`, the full composition; `mergeSafetyVerdict`, the narrower
// self-reference-safe one), re-exports every name a rule module owns (so the five existing importers --
// `merge-queue.mjs`, `trunk-revert.mjs`, `row-claim.mjs`, `workflow-run-liveness.mjs`, and
// `pre-push-armed-pr.test.ts` -- need no changes at all), and runs the CLI.
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
// RELATIVE, NOT the `@a11ign/worker-fleet/cli-flags` package specifier: that export map
// points at `dist/`, so it needs both `node_modules` AND a completed build. This file is reachable
// from a pre-install entry (see `pre-install-import-graph.test.ts`, which derives that population
// rather than naming it), and there it dies on startup with ERR_MODULE_NOT_FOUND.
import { refuseUnknownFlags, flagValue } from "../../worker-fleet/src/cli-flags.mjs";
import { REPO } from "../../../scripts/repo-identity.mjs";

import { reasonKind } from "./merge-guard/reason-kind.mjs";
import { gh, lookup, lookupRequiredContexts, lookupBranchTip, lookupCheckRuns, lookupClosingIssues }
  from "./merge-guard/lookups.mjs";
import { baseReason } from "./merge-guard/base-rule.mjs";
import { headTipMismatchReason } from "./merge-guard/head-tip-rule.mjs";
import { SATISFIED, checkReasons } from "./merge-guard/checks-rule.mjs";
import { stalenessReason } from "./merge-guard/staleness-rule.mjs";
import { ancestryReason } from "./merge-guard/ancestry-rule.mjs";
import {
  closingClaimReasons, claimedCloseCoveredBy, applyAllowClaimedClose,
} from "./merge-guard/claimed-row-rule.mjs";
import { prHoldReasons } from "./merge-guard/pr-hold-rule.mjs";
import { holdersOf, HOLD_PREFIX } from "./pr-hold-state.mjs";
import { racesAnArmedMerge, lookupArmedPrStatus } from "./merge-guard/armed-race-rule.mjs";
import {
  appendJsonl, gitCommonDir, verdictLogPath, agreementLogPath, recordVerdict, latestVerdictFor,
  realOutcomeFor, reconcile,
} from "./merge-guard/reconciliation.mjs";

// RE-EXPORTED so every existing importer keeps working unchanged -- see the header above for who reads
// which. Each name is now DEFINED in its own rule/shared module; this is the one place all of them are
// visible together, which is what an entry point is for.
export {
  reasonKind,
  gh, lookup, lookupRequiredContexts, lookupBranchTip, lookupCheckRuns, lookupClosingIssues,
  baseReason, headTipMismatchReason, SATISFIED, checkReasons, stalenessReason, ancestryReason,
  closingClaimReasons, claimedCloseCoveredBy, prHoldReasons,
  racesAnArmedMerge, lookupArmedPrStatus,
  appendJsonl, gitCommonDir, verdictLogPath, agreementLogPath, recordVerdict, latestVerdictFor,
  realOutcomeFor, reconcile,
};

const EXIT = { READY: 0, REFUSED: 1, CANNOT_ASK: 2 };

/**
 * THE SUBSET OF `mergeReadiness` THAT NEVER ASKS ABOUT THIS RUN'S OWN SIBLING CHECKS — #298 (unit 1).
 *
 * `mergeReadiness`'s `checkReasons`/`stalenessReason` inspect check-run CONCLUSIONS, which is exactly
 * what makes it unsafe to run as a REQUIRED job inside the very workflow run whose own sibling jobs are
 * still in flight: a job asking "did every required context conclude" about a commit it is itself
 * currently testing reads STILL_RUNNING on every ordinary push, forever, and would block every merge
 * permanently rather than only the unsafe ones. `gate` already answers "did CI pass" by construction
 * (branch protection requires it, and it is `if: always()` over every sibling's `result`) — this answers
 * the one question `strict=false` (#277) left nobody answering that does not depend on whether CI has
 * finished: does this head match what the platform thinks it is (`head-tip-rule.mjs`, #294).
 *
 * TWO RULES ARE DELIBERATELY NOT COMPOSED HERE, and both cost a live near-miss to find before they
 * shipped — `dispatcher` drove this function against the real, moving queue and measured both refusing
 * the NORMAL case. See `ancestry-rule.mjs` and `claimed-row-rule.mjs` for the full account of each; in
 * short, ancestry refuses almost every open PR under `strict=false`'s normal throughput, and the claimed-
 * row rule needs a `session` identity a CI job does not have and would otherwise refuse its own PR's
 * merge as "closing a stranger's row".
 *
 * **What must NOT happen is a required job refusing the normal case** — `dispatcher`'s own words — because
 * the response to an unmergeable-by-default queue is to bypass the gate, and this repository's record on
 * that is `A11Y_SKIP_VERIFY` used six times in one evening.
 *
 * A HOLD IS NOW ENFORCED HERE, AND UNTIL 2026-09-09 IT WAS ENFORCED NOWHERE THAT COULD STOP A MERGE.
 *
 * `pr-hold` disarms auto-merge when it takes a hold, and `armabilityOf` stops anything re-arming — so the
 * hold worked, at ARM time. A hold placed on a PR that was ALREADY ARMED stopped nothing: GitHub's
 * auto-merge consults no label, and `gate` — the only required context — read head-vs-tip and nothing
 * else. Measured: eleven of the twelve PRs one session labelled on 2026-09-09 merged, labelled, armed.
 * #645 called that "a label that stops nothing"; it was the observed behaviour rather than a hypothesis.
 *
 * This is deliberately NOT the two rules below it. Ancestry and the claimed-row rule were both measured
 * refusing the NORMAL case from CI. A hold cannot: the normal case is a PR with no `hold:` label, and the
 * refusal is only ever the state somebody asked for by hand.
 *
 * @param {{pr: {headRefOid: string, number?: number, state?: string}, branchTip: string | null,
 *   prLabels?: string[] | null}} facts
 * @returns {{code: number, reasons: string[]}}
 */
export function mergeSafetyVerdict({ pr, branchTip, prLabels = [] }) {
  if (branchTip === null) {
    return { code: EXIT.CANNOT_ASK, reasons: [
      `CANNOT SAY whether #${pr.headRefOid.slice(0, 10)} is safe to auto-arm: could not read the branch's `
      + "real tip (`git ls-remote`, #294).\n  This is INCONCLUSIVE, not clear.",
    ] };
  }
  // UNREADABLE REFUSES, AND SAYS SO IN ITS OWN WORDS. "Could not read the labels" and "this PR is held"
  // are different facts needing different actions -- one sends a reader to the API, the other to the
  // holder -- and printing the same sentence for both is how a reader learns to ignore it.
  if (prLabels === null) {
    return { code: EXIT.CANNOT_ASK, reasons: [
      `CANNOT SAY whether #${pr.number ?? "?"} is held: its labels could not be read.\n`
      + "  This is INCONCLUSIVE, not unheld. Nobody looked, and a merge that happens when nothing looked "
      + "is what this tool exists to prevent.",
    ] };
  }
  // ONLY WHILE THE PR IS OPEN, and this is #690's rule reaching one field further. `labeled`/`unlabeled`
  // fire on a CLOSED PR too -- anything that strips a label after a merge re-triggers this workflow --
  // and `gate` is deliberately ungated (`if: always()`), so without this a merged PR that still carries
  // its `hold:` label would go permanently red on its own head. That red blocks nothing, lands in the
  // report of non-success checks on merged heads, and trains people to skip the section: exactly the
  // failure #690 was written to stop, and exactly how one real red sat on seven merged PRs for ninety
  // minutes. A closed PR cannot merge, so refusing it protects nothing.
  const holders = pr.state === "closed"
    ? []
    : holdersOf(prLabels).map((label) => label.slice(HOLD_PREFIX.length));
  if (holders.length > 0) {
    return { code: EXIT.REFUSED, reasons: [
      `#${pr.number ?? "?"} IS HELD by ${holders.join(", ")}, so it must not merge.\n`
      + "  A hold is a decision somebody made by hand; releasing it is `npm run pr:release -- <n> "
      + `--session=<name>\`, which puts auto-merge back.\n  The label is \`${HOLD_PREFIX}<session>\`; a `
      + "`session:<name>` label is OWNERSHIP and is deliberately not read here.",
    ] };
  }
  const reasons = headTipMismatchReason(pr, branchTip);
  return { code: reasons.length > 0 ? EXIT.REFUSED : EXIT.READY, reasons };
}

/**
 * THE VERDICT, PURE — composes all eight rules so every state can be exercised without a network,
 * including the one no fixture gives you for free (a real run against a base that has since moved).
 *
 * Each input is a FACT somebody looked up; `null` means the lookup failed and is never treated as an
 * empty answer. `[]` and `null` are the difference between "nothing ran" and "I could not ask", and this
 * whole tool exists because two states that need opposite responses were being reported as one.
 *
 * @param {{pr: {number: number, state: string, baseRefName: string, headRefOid: string},
 *          required: string[] | null,
 *          runs: {name: string, status: string, conclusion: string | null, completedAt: string | null}[] | null,
 *          mainTipIso: string | null,
 *          behindBy: number | null,
 *          branchTip: string | null,
 *          closes?: {number: number, title?: string, labels: string[]}[] | null,
 *          prLabels?: string[] | null,
 *          session?: string | null}} facts
 * @returns {{code: number, reasons: string[], notes: string[]}}
 */
export function mergeReadiness({ pr, required, runs, mainTipIso, behindBy, branchTip, closes = [],
  prLabels = [],
  session = null }) {
  const missingLookups = [
    required === null && "the required status checks for `main` (branch protection)",
    runs === null && `the check runs for head ${pr.headRefOid.slice(0, 10)}`,
    mainTipIso === null && "the current tip of `main`",
    behindBy === null && "whether this head contains `main`'s tip (the compare API)",
    // A FAILED tip lookup is CANNOT_ASK, never READY -- `null` and "equal to headRefOid" are different
    // answers, the same distinction every other lookup here already draws (#294).
    branchTip === null && "the branch's real tip (`git ls-remote`)",
    closes === null && "which rows this PR would close (the closingIssuesReferences lookup)",
    prLabels === null && "this PR's own labels (which say whether somebody is holding it)",
  ].filter(Boolean);
  if (missingLookups.length > 0) {
    return { code: EXIT.CANNOT_ASK, notes: [], reasons: [
      `CANNOT SAY whether #${pr.number} is tested: could not read ${missingLookups.join("; ")}.\n`
      + "  This is INCONCLUSIVE, not clear. Re-run with a network and a `gh` credential.",
    ] };
  }

  const notes = pr.state === "OPEN" ? []
    : [`note: #${pr.number} is ${pr.state}, so this is a post-mortem rather than a merge decision.`];
  // Already proven non-null by `missingLookups` above -- TS's narrowing does not follow a null check
  // performed inside an array-literal expression, so the casts restate what the guard clause established.
  const knownRequired = /** @type {string[]} */ (required);
  const knownRuns = /** @type {{name: string, status: string, conclusion: string | null,
    completedAt: string | null}[]} */ (runs);
  const knownMainTipIso = /** @type {string} */ (mainTipIso);
  const knownBranchTip = /** @type {string} */ (branchTip);
  const knownCloses = /** @type {{number: number, title?: string, labels: string[]}[]} */ (closes);
  const knownPrLabels = /** @type {string[]} */ (prLabels);
  const reasons = [...baseReason(pr), ...headTipMismatchReason(pr, knownBranchTip),
    ...checkReasons(pr, knownRequired, knownRuns),
    ...ancestryReason(behindBy), ...stalenessReason(knownRuns, knownMainTipIso),
    ...closingClaimReasons(knownCloses, session), ...prHoldReasons(pr, knownPrLabels, session)];
  return { code: reasons.length > 0 ? EXIT.REFUSED : EXIT.READY, reasons, notes };
}

/**
 * `mergeSafetyVerdict`'s inputs, none of which ask about this run's own sibling check-runs -- see that
 * function's own comment for why that omission is deliberate rather than an oversight. Cheaper than
 * `facts()` too: no required-contexts or check-runs lookup at all.
 * @param {number} number
 */
/**
 * REST, NOT `gh pr view`, AND THAT IS A PROPERTY OF THE REQUIRED GATE RATHER THAN A PREFERENCE.
 *
 * `gh pr view` spends GRAPHQL. On 2026-09-09 the shared GraphQL pool reached 5000 of 5000 at 14:41Z and
 * every `gh pr list`/`view`/`checks` in every session failed for twenty-two minutes. `gate` is the ONLY
 * required context on this repository, so a GraphQL outage would make the one check that must answer
 * unable to answer -- and an unanswerable required check is a queue that stops. `gh api repos/.../pulls/N`
 * is core, a separate pool, and returns the labels on the same payload, so the hold read below costs
 * nothing extra.
 *
 * `prLabels` is `null` when the read failed, NEVER `[]`. The two need opposite responses: an empty list
 * means nobody holds this PR and it may proceed; a failed lookup means nobody LOOKED, and this whole tool
 * exists because a merge happened when nothing looked (#294's "Unreadable is not unheld").
 *
 * @param {number} number
 */
function ciGateFacts(number) {
  const raw = JSON.parse(gh(["api", `repos/${REPO}/pulls/${number}`]));
  const pr = {
    number: raw.number,
    state: raw.state,
    baseRefName: raw.base?.ref,
    headRefOid: raw.head?.sha,
    headRefName: raw.head?.ref,
  };
  const names = Array.isArray(raw.labels)
    ? raw.labels.map((/** @type {{name?: unknown}} */ l) => l?.name)
    : null;
  const prLabels = names && names.every((/** @type {unknown} */ n) => typeof n === "string")
    ? /** @type {string[]} */ (names)
    : null;
  const branchTip = lookupBranchTip(pr.headRefName);
  return { pr, branchTip, prLabels };
}

/**
 * `--ci-gate <n>`: the check a required CI job runs FOR ITSELF, mid-workflow -- #298 (unit 1). Checks
 * head-vs-tip (#294) ONLY -- see `mergeSafetyVerdict`'s own comment for why ancestry (#182) and
 * closing-claim (#262) are deliberately not asked here: both refuse the NORMAL case when CI asks them,
 * measured live on this PR's own queue.
 * @param {number} number
 */
function ciGateCommand(number) {
  const verdict = mergeSafetyVerdict(ciGateFacts(number));
  if (verdict.code === EXIT.READY) {
    console.log(`#${number} is safe to auto-arm: this head matches what GitHub recorded (#294).`);
  } else {
    console.error(`REFUSING to auto-arm #${number}:\n${verdict.reasons.map((r) => `- ${r}`).join("\n")}`);
  }
  process.exit(verdict.code);
}

/** @param {number} number */
function facts(number) {
  // DELIBERATELY NOT REQUESTING `mergeStateStatus`. Asking for it at all would invite the next reader to
  // use it, and this tool's entire reason for existing is that its answer cannot be trusted here.
  const pr = JSON.parse(gh(["pr", "view", String(number), "--repo", REPO,
    "--json", "number,state,baseRefName,headRefOid,headRefName,labels"]));
  // `null` WHEN THE SHAPE IS NOT THE ONE EXPECTED, never `[]` -- an empty array reads as "nobody holds
  // this PR", which is the safest-LOOKING answer and the wrong one when the truth is "I could not ask".
  // Same rule as every other lookup here, and the reason this file exists.
  const prLabels = Array.isArray(pr.labels)
    ? pr.labels.map((/** @type {{name?: unknown}} */ l) => l?.name).filter(
      (/** @type {unknown} */ name) => typeof name === "string")
    : null;
  const required = lookupRequiredContexts();
  const runs = lookupCheckRuns(pr.headRefOid);
  const mainTipIso = lookup(() => gh(["api", `repos/${REPO}/commits/main`,
    "--jq", ".commit.committer.date"]).trim() || null);
  // `behind_by` is how many commits `main` has that this head does not -- the ancestry fact, not a
  // mergeability opinion. `lookup` keeps a failed call NULL so it lands as INCONCLUSIVE rather than 0,
  // which would read as "contains main's tip" and reintroduce the false pass this replaced.
  const behindBy = lookup(() => {
    const value = JSON.parse(gh(["api",
      `repos/${REPO}/compare/main...${pr.headRefOid}`])).behind_by;
    return typeof value === "number" ? value : null;
  });
  const branchTip = lookupBranchTip(pr.headRefName);
  const closes = lookupClosingIssues(number);
  return { pr, required, runs, mainTipIso, behindBy, branchTip, closes, prLabels };
}

/**
 * `--reconcile <n>`: compare the LAST recorded verdict for #n against its real, terminal outcome (#188).
 * @param {number} number
 */
function reconcileCommand(number) {
  const recordedVerdict = latestVerdictFor(verdictLogPath(), number);
  const pr = JSON.parse(gh(["pr", "view", String(number), "--repo", REPO,
    "--json", "state,mergedAt,closedAt"]));
  const realOutcome = realOutcomeFor(pr.state);
  const resolvedAt = pr.mergedAt ?? pr.closedAt ?? null;
  const result = reconcile({ prNumber: number, recordedVerdict, realOutcome, resolvedAt });
  // NARROWED ON `record`, NEVER ON `code` -- `code` is typed as plain `number` in both branches of
  // `reconcile`'s return union, so comparing it to `EXIT.READY` (also a plain number) cannot narrow
  // which branch this is. `record` is the actual discriminant: null in one branch, an object in the
  // other. Checking the wrong field type-checked as fine before #234 added `@ts-check` to this file.
  if (result.record === null) {
    console.error(`CANNOT RECONCILE #${number}: ${result.reason}`);
    process.exit(result.code);
  }
  appendJsonl(agreementLogPath(), result.record);
  console.log(`#${number}: guard said ${result.record.guardVerdict} `
    + `(${result.record.guardReasonKinds.join(", ") || "no reasons"}), the platform's real outcome was `
    + `${result.record.realOutcome} — ${result.record.agreement}.`);
  process.exit(EXIT.READY);
}

/**
 * `--armed-check=<branch>`: is THIS branch's own open PR armed with auto-merge AND already green?
 * #386's pre-push wiring calls this on the pushing branch itself -- never a PR number, since the hook
 * only ever knows its own branch, not whether a PR exists for it yet.
 * @param {string} branch
 */
function armedCheckCommand(branch) {
  const status = lookupArmedPrStatus(branch);
  if (racesAnArmedMerge(status)) {
    // `status` is non-null here (racesAnArmedMerge(null) is false), so `.number` is safe.
    console.error(`REFUSING: #${/** @type {{number: number}} */ (status).number} is armed and its gate `
      + "is already green -- pushing now risks racing a merge that can complete before this push "
      + "finishes (#386), stranding the commit on a branch nothing can find afterward. Wait a moment "
      + "and push again once the merge has landed, or if this is deliberate:\n"
      + '  A11Y_ALLOW_ARMED_PUSH="<why>" git push ...');
    process.exit(EXIT.REFUSED);
  }
  if (status === null) {
    console.log("could not ask GitHub about this branch's PR -- allowing (a race guard fails open).");
  }
  process.exit(EXIT.READY);
}

/**
 * `--allow-claimed-close=<name>`'s value, refusing (never silently) a bare boolean -- #249's follow-up,
 * 2026-09-07: it must be a CHECKABLE claim naming who was confirmed with, not an honor system.
 *
 * KEPT HERE, not in `claimed-row-rule.mjs`, deliberately -- #455: this is the one place in that rule's
 * whole surface that touches `process.argv` directly, and this file already reads argv and already calls
 * `refuseUnknownFlags` for the entire command. Moving it into the rule module would make that module a
 * second, untracked CLI entry point -- `cli-flags.test.ts`'s argv-reading census discovers exactly this
 * shape and failed on it the first time this was tried, correctly.
 * @returns {string | null}
 */
function readAllowClaimedClose() {
  if (process.argv.includes("--allow-claimed-close") && flagValue(process.argv, "allow-claimed-close") === undefined) {
    console.error("--allow-claimed-close requires a value naming who you confirmed with:\n"
      + "  --allow-claimed-close=<session>\n"
      + "A bare boolean was refused on purpose: it must be a CHECKABLE claim, not an honor system.");
    process.exit(EXIT.CANNOT_ASK);
  }
  return flagValue(process.argv, "allow-claimed-close") ?? null;
}

function main() {
  refuseUnknownFlags(["--reconcile", "--session", "--allow-claimed-close", "--ci-gate", "--armed-check"],
    { entry: import.meta.url, command: "node packages/agent-org/src/merge-guard.mjs" });

  if (flagValue(process.argv, "armed-check") !== undefined) {
    armedCheckCommand(/** @type {string} */ (flagValue(process.argv, "armed-check")));
    return;
  }

  const number = process.argv.slice(2).find((arg) => /^\d+$/.test(arg));
  if (!number) {
    console.error("Usage: node packages/agent-org/src/merge-guard.mjs <pr-number> [--session=<name>] [--allow-claimed-close=<name>]\n"
      + "       node packages/agent-org/src/merge-guard.mjs --reconcile <pr-number>\n"
      + "       node packages/agent-org/src/merge-guard.mjs --ci-gate <pr-number>\n"
      + "       node packages/agent-org/src/merge-guard.mjs --armed-check=<branch>\n"
      + "Answers whether that PR has actually been tested, by reading its check RUNS rather than\n"
      + "`mergeStateStatus` -- which reports CLEAN for a PR that has never run a check. `--reconcile`\n"
      + "compares the last recorded verdict against the PR's real, terminal outcome (#188). `--ci-gate` is\n"
      + "the narrower, self-reference-safe check a required CI job runs against its own commit (#298).\n"
      + "`--armed-check` asks whether pushing to this branch right now would race an already-green,\n"
      + "already-armed merge (#386).");
    process.exit(EXIT.CANNOT_ASK);
  }

  if (process.argv.includes("--reconcile")) {
    reconcileCommand(Number(number));
    return;
  }

  if (process.argv.includes("--ci-gate")) {
    ciGateCommand(Number(number));
    return;
  }

  const session = flagValue(process.argv, "session") ?? null;
  const allowClaimedClose = readAllowClaimedClose();

  const factsResult = facts(Number(number));
  const verdict = mergeReadiness({ ...factsResult, session });
  recordVerdict(verdictLogPath(), Number(number), verdict);
  for (const note of verdict.notes) console.error(note);

  const { overridden, remaining } = applyAllowClaimedClose(verdict, factsResult.closes ?? [], allowClaimedClose);
  for (const reason of overridden) {
    console.error(`OVERRIDDEN by --allow-claimed-close=${allowClaimedClose}: ${reason}`);
  }
  const code = verdict.code === EXIT.CANNOT_ASK ? EXIT.CANNOT_ASK
    : (remaining.length > 0 ? EXIT.REFUSED : EXIT.READY);

  if (code === EXIT.READY) {
    console.log(`#${number} is tested: based on main, every required context present and concluded, and `
      + "this head CONTAINS main's tip -- so what ran, ran against the code it is about to join.");
  } else if (code === EXIT.REFUSED) {
    console.error(`REFUSING #${number}:\n${remaining.map((r) => `- ${r}`).join("\n")}`);
  }
  process.exit(code);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();

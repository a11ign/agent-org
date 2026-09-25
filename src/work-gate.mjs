#!/usr/bin/env node
// @ts-check
// command: work-gate -- is there work for any session? One cheap read; a wake order per line when yes.
//
// #912's remaining half. `org-watch.mjs:713-717` states it in its own comment: "READS 2-4 ARE NOT WIRED
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
// without a running org and unrunnable from CI. `wake.mjs` owns that half; `row-claim.mjs` remains the
// authority on whether a row is actually yours.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import { realpathSync, existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
// RELATIVE, not the package specifier -- this must run before any `npm ci`/build, the same constraint
// `org-watch.mjs` and `build-packages.mjs` state at their own imports.
import { refuseUnknownFlags } from "../../worker-fleet/src/cli-flags.mjs";
import { READY_LABEL, CLAIM_LABEL, CLAIM_RECORD_MARKER } from "./claim-labels.mjs";
import { verdictAtHead } from "./review-verdict.mjs";
import { waitingOn, fleetWaitingOn, todayIso, describeWaiting, ANSWER_PREFIX } from "./waiting-condition.mjs";
import { newestPerName } from "./newest-check-run.mjs";
import { reviewerInstanceNumber } from "./review-attribution.mjs";
// B4, ASKED EARLY. These are the SAME two functions `row-claim.mjs` runs at claim time, imported
// rather than reimplemented: `region-paths.mjs`'s own header records why a second copy of "what
// counts as a path" is not allowed to exist. Both are leaf-shaped and relative, so the gate keeps the
// property its own header states -- it runs before any `npm ci` or build.
import { declaredRegionFiles } from "./region-paths.mjs";
import { declaredClosedRows, fileOverlapReason } from "./row-claim/file-overlap-rule.mjs";
// #2031, AND IMPORTED FOR THE SAME REASON THE TWO LINES ABOVE ARE. The trailing-`-<n>` rule is #2014's,
// already exercised through `row-claim.mjs`'s own refusal; a second copy here is the drift that row's
// filing named in so many words. `row-branch-rule.mjs` imports NOTHING, and `git-env.mjs` imports nothing
// either, so the gate keeps the property its own header states -- it runs before any `npm ci` or build.
import { LS_REMOTE_ARGS, rowBranchesInListing } from "./row-claim/row-branch-rule.mjs";
// EVERY `git` SPAWN IN THIS REPO STRIPS `GIT_*` THROUGH ONE FUNCTION (`git-env.mjs`'s own header records
// the 2026-09-06 incident where an inherited `GIT_DIR` landed fifteen commits in the wrong checkout).
// This tick runs under systemd, where the environment is not the one a person typed.
import { sandboxGitEnv } from "../../guards/src/git-env.mjs";
// THE REFUSAL PATH ONLY, and a LEAF import so this file keeps the property its own header states. The
// reader lived in `queue-table.mjs` until #2003; importing THAT would have pulled five modules into the
// graph of a script that runs 720 times a day, to use a function it calls only when already refusing.
import { poolDiagnosis, refusalPoolLine } from "./api-pool.mjs";
// #1969, AND THE PREDICATE IS IMPORTED RATHER THAN RE-DECIDED. `armedFromApi` knows THREE armed states --
// merged, a pending auto-merge, and SITTING IN THE MERGE QUEUE, where `autoMergeRequest` reads `null` on a
// correctly armed pull request (#1729/#1727, and #2004 for the read that fed it). `ceo`'s ruling names
// that reuse as a constraint: "the predicate is NOT `autoMergeRequest == null` -- a queued PR reads null".
// `openPullRequestsQueryArgs` is the same file's read, split out so this asks the identical question.
// Both are leaf-shaped: `auto-arm-sweep.mjs` imports only `node:*`, `cli-flags.mjs` (already here) and
// `pr-hold-state.mjs` (no imports at all), so the gate keeps the property its own header states.
import { armedFromApi, openPullRequestsQueryArgs } from "./auto-arm-sweep.mjs";
import { armabilityOf, holdersOf } from "./pr-hold-state.mjs";
import { REPO } from "../../../scripts/repo-identity.mjs";
// #2356: A RED `main` WAKES A FIXER. Imports only `node:*`, `parent-recheck-summary.mjs` and the repo identity,
// so the gate keeps the property its own header states -- it runs before any `npm ci` or build.
import { readTrunkRed, trunkRedOrders } from "./trunk-red.mjs";
// #2163: FREE BYTES AND FREE INODES. Imports only `node:*`, so the gate keeps the property its own header states.
import { diskHeadroom, MIN_FREE_FRACTION } from "./disk-headroom.mjs";
// #2470: A CLAIM THAT DOES NOT MOVE. A leaf, like every import above, so the gate keeps the property its own header states.
import { STALL_STATE_FILE, claimFactsFrom, readClaim, claimStalledOrders, nextStallState, readStallState,
  writeStallState, readHerdrRestart, gitRun, pathExists, statMtime, nudgeKey, nudgeDeliveredAt } from "./claim-stall.mjs";
// #2542: THE PULL-REQUEST ORDERS -- the orders that ask a session to act on a pull request's state -- live in
// `work-gate/pr-orders.mjs`, which imports the shared PR facts BACK from this file. The cycle is safe because
// nothing there reads an import at load time (only inside a function), and this file stays the entry point:
// every name that module exported is re-exported here, so no caller of `work-gate.mjs` changes.
import { requiredWhenRed, perPullRequestOrders, mergeConflictOrders, greenUnarmedOrders, reviewBlockedOrders }
  from "./work-gate/pr-orders.mjs";
export { redOnlyBySupersededRun, mergeConflictOrders, greenUnarmedOrders, reviewBlockedOrders, HOLD_RED_JOBS,
  awaitingEvidenceStaleOrders } from "./work-gate/pr-orders.mjs";

/**
 * FOUR STATES, AND THE POLARITY IS DELIBERATE.
 *
 * `0` is QUIET, matching `org-watch`, `stranded-branches` and `merge-guard`. The reason is not symmetry.
 * Under this polarity the predictable misuse -- `if work-gate.mjs; then wake; fi` -- wakes EVERY session
 * on EVERY quiet tick, which is impossible to miss for more than one tick. Under the opposite polarity
 * the same mistake sleeps silently through a rate limit and nobody finds out for ten hours, which is the
 * 2026-09-08 outage this whole design exists to prevent. Choose the polarity whose misuse announces itself.
 *
 * `3` PARTIAL exists because this asks about several lanes at once (ADR 0037). One unreadable lane must
 * not void the other's orders and must not be reported as quiet either: the orders on stdout are real and
 * the lane that could not be read is NAMED on stderr.
 */
export const EXIT = { QUIET: 0, WORK: 1, CANNOT_ASK: 2, PARTIAL: 3 };

/** The causes this gate can emit. `wake.mjs` and the matrix validate against this list, never a copy. */
export const CAUSES = ["draft-awaiting-verdict", "ready-row-unclaimed", "draft-convinced-not-ready",
  "verdict-not-convinced", "pr-checks-failing", "ready-queue-empty", "lane-backlog-unpromoted",
  "chairman-blocked", "org-stalled", "epic-unfiled", "epic-finished", "answer-owed",
  "blocked-unexaminable", "fleet-batch-due", "blocker-cleared", "pr-green-unarmed",
  "claimed-row-amended", "row-branch-unshipped", "host-units-stale", "pr-review-blocked",
  "unclaimed-blocker-cleared", "pr-merge-conflict", "trunk-red", "verdict-comment-unreviewed",
  "reviewer-auth-failed", "awaiting-evidence-stale", "disk-headroom-low", "claim-stalled"];

/**
 * Causes whose answer is a JUDGMENT about the current state, not an action on a named thing.
 *
 * THE DISTINCTION EXISTS BECAUSE ONE OF THEM MUST NOT BE RE-ASKED AND THE OTHER MUST.
 *
 * An ACTION cause names a thing to do -- claim row #1320, fix #1650's red build. If the wake does not
 * stick, nothing happens and nobody notices, so `wake`'s twenty-minute expiry re-offers it. That is the
 * defect the expiry was built for: rows #1433 and #1435 sat Ready overnight because a spent causeKey
 * silenced them for ever.
 *
 * A JUDGMENT cause asks somebody to LOOK and decide -- is anything here promotable? Its answer is
 * durable: if the state has not changed, the answer has not changed either, and asking again buys a full
 * model turn to reach the same conclusion. Measured 2026-09-18: `orchestrator` was woken for
 * `lane-backlog-unpromoted`, spent four shell commands establishing that #1564 is a research row with no
 * Acceptance waiting on a `ceo` ruling, answered "staying put" -- and the twenty-minute expiry would have
 * asked it again, and again, until the six-delivery STUCK cap stopped it two hours later.
 *
 * SO THESE ARE KEYED ON STATE AND NOT RE-ASKED UNTIL THE STATE MOVES. `wake` reads this and skips the
 * expiry for them; the causeKey already carries the state (a count, an age), so any real change is a new
 * question and reaches the owner immediately.
 *
 * `unclaimed-blocker-cleared` IS A JUDGMENT, AND IT IS THE SAME QUESTION `lane-backlog-unpromoted` ASKS
 * (#2139) -- "should this row be promoted?" -- narrowed to one row and one clearing. Its answer is
 * durable in the way that matters here: "it stays in backlog" does not stop being true twenty minutes
 * later, and an ACTION expiry would re-ask it every twenty minutes for ever, which is precisely the
 * treadmill measured on `lane-backlog-unpromoted` and #1564. The causeKey carries the cleared SET, so a
 * row blocked again and cleared again is a new question and reaches `product-manager` immediately.
 *
 * THE RISK, STATED: a judgment wake that never lands is never retried. That is a real cost and a smaller
 * one than the alternative -- the STUCK counter still catches a cause that keeps being emitted, and any
 * change to the underlying state produces a new key. An unasked question is cheaper than a question
 * asked forty times.
 *
 * `claimed-row-amended` JOINED ON 2026-09-23 (#2182), FOR `row-branch-unshipped`'S REASON EXACTLY.
 * Its answer is durable in this docblock's own sense: reading an amendment and accepting it changes
 * neither the row nor the marker, so a holder who has decided to wait reaches the same conclusion every
 * time it is asked. And it is safe to key on state because `amendedOrder` already keys on the WHOLE
 * marker set -- a second or replaced constraint is a different key and still reaches the holder on the
 * next tick, which is the half a careless fix would break.
 *
 * MEASURED ON #1955, whose only marker was an open `blockedBy` edge that was correct, acknowledged three
 * times and self-clearing: four offers in 71 minutes (intervals 31.0, 20.2, 20.2), each a full model turn
 * that produced a comment saying the wait was still right. `amendedOrder`'s own docblock already claimed
 * the property this membership gives it -- *"an unchanged row mints the identical key on every subsequent
 * tick and the ledger drops it"* -- which held for twenty minutes, not for the length of the wait.
 *
 * WHAT THIS DOES NOT FIX, STATED SO NOBODY READS IT AS MORE: a judgment cause is re-offered every two
 * hours rather than never, so a STANDING one still reaches `MAX_DELIVERIES` and escalates to the
 * chairman -- later, not never, about ten hours after its first delivery. That used to turn on
 * `JUDGMENT_TTL_MS` and `RUN_IDLE_RESET_MS` being the same two hours (a regular tick grid escalated, a
 * drifting one never did); #2227 made the reset twice the TTL, so it now escalates on any grid.
 */
export const JUDGMENT_CAUSES = Object.freeze(["ready-queue-empty", "lane-backlog-unpromoted",
  "chairman-blocked", "org-stalled", "epic-unfiled", "epic-finished", "answer-owed",
  "blocked-unexaminable", "fleet-batch-due", "row-branch-unshipped", "claimed-row-amended",
  "unclaimed-blocker-cleared", "reviewer-auth-failed", "awaiting-evidence-stale", "disk-headroom-low"]);

/**
 * The causes that START new work, as opposed to finishing work already begun.
 *
 * WHY THE ORG NEEDS TO BE ABLE TO DRAIN, measured 2026-09-18. `ceo` announced a capture-free window
 * for #63's history purge on two readings -- the fleet idle, and no open pull requests -- and told
 * `orchestrator` to hold the fleet. Thirty minutes later two fresh agent branches had been pushed,
 * because NOBODY HELD THE ORG: the fleet has a hold and the work tick does not. Step 2 of that runbook
 * force-pushes a rewritten history, so every branch created after the rewrite is stranded.
 *
 * STOPPING THE TIMER IS NOT THE ANSWER, and that is the whole reason this is a partition rather than
 * an off switch. The two drafts already open still needed a reviewer verdict and a ready-marking to
 * land; a stopped tick strands them exactly as surely as the force-push would. What a window needs is
 * to stop TAKING ON work while continuing to finish what is in flight -- so the causes split by which
 * of those two things they do, and drain withholds only the first kind.
 *
 * `chairman-blocked` is deliberately NOT here. It is the only cause whose subject is the window
 * itself: during a transfer the chairman is the one doing the work, and silencing their brief would
 * silence the thing the drain exists to serve.
 *
 * `blocker-cleared` is deliberately NOT here either, and for the partition's own definition rather than
 * a preference: its subject is a row the session ALREADY HOLDS. A drain finishes work in flight and
 * starts none, and a claimed row is the plainest case of work in flight there is -- withholding it would
 * strand exactly the rows a transfer window needs landed, which is the failure `START_CAUSES` was split
 * out to prevent for the two open drafts.
 *
 * `unclaimed-blocker-cleared` IS here, and it is `blocker-cleared`'s own argument read the other way
 * (#2139). The partition turns on whether a row is work in flight, and the ONLY difference between those
 * two causes is the claim -- which is exactly the line the partition draws. Nobody holds this row, so
 * promoting it is the org TAKING ON work, which is the thing a transfer window exists to stop. A drain
 * that withheld `blocker-cleared` would strand a build half-done; one that withholds this withholds a
 * promotion, and the row is waiting either way.
 *
 * `claimed-row-amended` is out for the same reason and one sharper one (#2110). Its subject is also a row
 * the session already holds, so the sentence above applies unchanged -- but a drain is precisely the
 * window in which withholding it costs most. A drain exists to LAND what is in flight; a constraint that
 * arrives unread during one is a build finished against a rule nobody applied, which is the single thing
 * a landing window cannot afford. Measured on #2099: the ruling reached the row 6 minutes after the work
 * was done, and only a human reading the thread caused it to be honoured.
 *
 * `row-branch-unshipped` is deliberately NOT here either (#2031), and a drain is the window where it
 * matters MOST rather than least. Step 2 of #63's history-purge runbook force-pushes a rewritten history,
 * and every branch on `origin` at that moment that nobody has landed is stranded by it -- a drain exists
 * precisely so the org can find out what is still in flight before that happens. Withholding this cause
 * during one would hide, from the only person who can act on it, the exact population the window is for.
 * It also starts no work: its subject is work that ALREADY EXISTS on origin.
 *
 * `claim-stalled` is deliberately NOT here either (#2470), and it is an ACTION cause, not a judgment: the answer is a
 * nudge or a release, never a question, so it is in neither `JUDGMENT_CAUSES` nor this list. Its subject is a row a
 * session ALREADY HOLDS, which is the plainest case of work in flight there is; and the window where a stalled claim
 * costs most is a drain, which exists to LAND what is in flight. A release also returns the row to the pool and starts
 * nothing itself -- taking it on again is `ready-row-unclaimed`'s, and THAT is withheld by a drain.
 */
export const START_CAUSES = Object.freeze(["ready-row-unclaimed", "ready-queue-empty",
  "lane-backlog-unpromoted", "org-stalled", "epic-unfiled", "epic-finished",
  "blocked-unexaminable", "fleet-batch-due", "unclaimed-blocker-cleared"]);

/** Where the drain marker lives. `touch` it to open a window; `rm` it to close one. */
export const DRAIN_MARKER = `${process.env.HOME}/.cache/a11ign/drain`;

/**
 * Is the org draining -- finishing what is in flight and taking on nothing new?
 *
 * A MARKER FILE, NOT A FLAG OR AN ENV VAR, because of who has to operate it. Turning a window on and
 * off is `touch` and `rm` over ssh; a systemd `Environment=` line is an edit plus a `daemon-reload`,
 * and a CLI flag would have to be threaded through the unit file to reach the tick at all. It also
 * survives a restart and can be READ by anyone wondering why the queue went quiet, which an env var
 * inside a transient unit cannot.
 *
 * It sits beside the wake ledger deliberately: one directory holds the org's runtime state.
 * @param {string} [path] @param {(p: string) => boolean} [exists]
 */
export function draining(path = DRAIN_MARKER, exists = existsSync) {
  return exists(path);
}

/** @param {string[]} args */
const defaultRun = (args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });

/**
 * Open PRs with everything the draft lane needs, in ONE call.
 *
 * `null` MEANS REFUSED, NEVER EMPTY -- `queueReport`'s rule (#1286), and for its reason: a refused `gh`
 * exits non-zero with empty stdout, so a reader that returns `[]` for it reports "nothing is queued" and
 * the org acts on it. Every caller below must keep the two apart.
 * @param {(args: string[]) => string} run
 * @returns {any[] | null}
 */
export function readPrs(run = defaultRun) {
  try {
    const out = run(["pr", "list", "--state", "open", "--limit", "100", "--json",
      "number,isDraft,headRefOid,statusCheckRollup,author,comments,labels,files,changedFiles,body,"
      // #2084: `reviewDecision` IS WHAT GITHUB ITSELF MERGES ON, AND NO QUEUE READ HERE TOUCHED IT.
      // Measured at `468a74f1b`: `git grep -l reviewDecision -- '*.mjs'` returns exactly ONE file, and it
      // is not a queue read -- `row-claim/own-pr-health-rule.mjs` (#2126, merged the same day #2084 was
      // filed) reads it to answer "may this session claim ANOTHER ROW". That refusal emits no order, wakes
      // nobody, fires only on `CHANGES_REQUESTED`, and only for the session holding that row. Nothing that
      // reads the QUEUE touched the field: not this file, not `queue-table.mjs`, not `merge-guard.mjs`,
      // not `auto-arm-sweep.mjs` -- so #2049 sat green, armed and unmergeable for over seven hours with
      // every org read calling it healthy. (#2084's own body says the grep returned zero; that was true
      // when it was filed at 08:5xZ and #2126 landed the same day. The list of readers it names is right.)
      // It arrives on the `pr list` call this function already makes -- one more name in the `--json`
      // list, no extra request and no extra pool -- which is the whole reason the blind spot is worth
      // closing HERE rather than in `queue-table.mjs`, whose own header records dropping
      // `mergeStateStatus` precisely because a GraphQL-only field meant a second, refusable call.
      + "reviewDecision,"
      // #2470: `headRefName` -- WHICH BRANCH a pull request is on, so a claimed row can be asked "does it have an open
      // one". One more name on the call already made, like the two above; it is what keeps a row whose author is in
      // review out of `claim-stalled`, whose subject is the build and not the wait for a verdict.
      + "headRefName,"
      // #2209: `mergeStateStatus` AND `mergeable`, BOTH ON THE SAME CALL, because nothing here read whether
      // a pull request CONFLICTS with `main`. #2203 went DIRTY when #2205 merged, was green and approved,
      // and was reported as a credential outage while six Ready rows sat behind it. `gh pr list --json`
      // offers both names (checked 2026-09-24), so this is two more names on a request already made --
      // not the second, refusable call `queue-table.mjs`'s header records avoiding. GitHub computes them
      // lazily and may answer `UNKNOWN`; `conflictStateOf` reads that as unread, never as clean.
      + "mergeStateStatus,mergeable,"
      // #2365: `reviews` AND NOT `latestReviews`, MEASURED 2026-09-24 against `gh` on this host. Both ride on
      // the `--limit 100` call without tripping GraphQL's node limit (which `commits` does), but
      // `latestReviews[].commit.oid` comes back the EMPTY STRING and `reviews[].commit.oid` carries the sha the
      // review was posted at -- and "was this convinced verdict converted into a review AT THIS HEAD" is a
      // question about exactly that sha. `gh api .../pulls/N/reviews` `commit_id` agrees with it. No second call.
      + "reviews"]);
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * WHAT A TICK ACTUALLY COSTS, COUNTED RATHER THAN REMEMBERED.
 *
 * "Two `gh` calls, no model" is this org's shorthand for the gate -- it is in `agent-practices.md`, it was
 * in two comments in this file, and IT WAS WRONG. `main` has made four unconditional reads since long
 * before the recent causes: the pull-request list, the Ready rows, the promotable backlog and the
 * chairman-blocked rows. The number was true when the file was written and nobody re-counted it while
 * three readers were added.
 *
 * FOUND BY A REVIEWER, ON A CHANGE THAT REPEATED IT. #1769's own comment claimed "the two-call steady
 * state is unchanged"; `reviewer` measured the call sites and reported it as a should-fix. The claim that
 * mattered -- that the new read is CONDITIONAL and a healthy tick does not pay it -- was true. The number
 * it was attached to was inherited, and this constant exists so the next person inherits a count that is
 * checked instead.
 *
 * The conditional reads are deliberately NOT in this number: `readEpics` is paid only by a tick that
 * found an empty Ready shelf, and `requiredCheckNames` only by one that saw a settled-red check.
 *
 * THERE IS NO LONGER A SILENCE-CONDITIONAL READ, and its removal is #1938. `readOpenRowState` used to
 * ask for `number,body,blockedBy` over the same 500 open rows the UNCONDITIONAL `readOpenRows` had
 * already fetched in the same process, one tick earlier -- a strict subset of a list the gate held in
 * hand. `openRowState` now derives the same answer from those rows without asking again. The key that
 * named it is gone rather than emptied, so nothing reads a stale name; `readEpics` takes its place here
 * because it was the third conditional read all along and this constant had never said so.
 */
export const GH_READS = Object.freeze({
  unconditional: ["pr list", "issue list --label ready", "issue list --label backlog",
    "issue list --label chairman-blocked", "issue list (all open: answer/blocked labels)",
    // #2202: TWO SMALL CALLS, because a closed row still owing an answer is invisible to the open read above
    // and `gh` cannot filter a label PREFIX. The first lists the repo's `answer:` label names, the second
    // asks for the closed rows carrying any of them -- exact, so no window a row can fall out of silently.
    "label list --search answer: (readClosedAnswerRows)",
    "issue list --state closed --search label:<answer labels> (readClosedAnswerRows -- answer-owed on a closed row)",
    // #2356: ONE REST CALL on the core pool -- the newest runs of `trunk.yml` on `main` (readTrunkRed).
    "api actions/workflows/trunk.yml/runs (readTrunkRed -- trunk-red)"],
  conditionalOnEmptyShelf: "issue list --label epic (readEpics)",
  // ONE call, and it needs no admin (#2331). It used to be two -- the admin-only protection endpoint, then
  // `branches/main` as the discriminator for its 404 (#2106, #2022) -- and the discriminator's only job
  // was to explain the admin-only 404, which `branches/main` does not give a non-admin credential. Conditional on a settled-red check.
  conditionalOnRed: "api branches/main (requiredCheckNames)",
  // #2117: ONE MORE CORE READ ON THE SAME RED TICK -- `main`'s tip commit, so the `pr-checks-failing` prompt can
  // say whether `main` moved after the failing run started. `branches/main` already carries that commit, but
  // `requiredCheckNames` returns a bare list and four tests pin its shape; a second read costs one call on a tick
  // that is already paying one, and never touches a healthy tick.
  conditionalOnRedBase: "api commits/main (readBaseTip -- pr-checks-failing's `has main moved`)",
  // #1969, AND IT IS COUNTED HERE BECAUSE THE LAST ONE WAS NOT. This constant exists because "two `gh`
  // calls" was repeated for weeks while three readers were added, and a reviewer had to measure the call
  // sites to find it. The condition is `shouldBeMerging` finding a green, unheld, non-draft PR -- which
  // on a healthy queue is the COMMON case, so unlike the two above this one is usually paid. It is still
  // conditional rather than unconditional: a tick with nothing green and unheld makes no call at all.
  // #2176: ONE REST CALL PER GREEN PULL REQUEST WITH NO VERDICT AT ITS HEAD -- the ones the review question
  // is genuinely asked of -- on the CORE pool. `commits` cannot ride on `pr list`: GraphQL refuses it.
  conditionalOnUnreviewedGreenPr: "api repos/{repo}/pulls/{n}/commits (withCommitChains -- the last authored head)",
  // #2416: ONE REST CALL PER OPEN PULL REQUEST CARRYING `awaiting-evidence`, and NONE when no open pull
  // request carries it -- the label's age is not on `pr list`, so the labelled ones are asked and only those.
  conditionalOnAwaitingEvidenceLabel: "api repos/{repo}/issues/{n}/events (readEvidenceLabelledAt -- awaiting-evidence-stale)",
  conditionalOnGreenUnheldPr: "api graphql (open PRs' mergeQueueEntry -- readUnarmed)",
  // #2110, AND IT IS ONE CALL FOR THE WHOLE CLAIMED POPULATION RATHER THAN ONE PER ROW. `--label
  // in-progress` filters server-side, so the page is the claimed rows and nothing else -- 8 of them on
  // 2026-09-23 against 500 open rows -- and asking every one of them for its comments in a single
  // `issue list` is what keeps this a bounded read as the org grows. A per-row `issue view` would have
  // been N calls and would have made the tick's cost a function of how busy the org is, which is the one
  // property `work:tick` cannot trade away.
  //
  // CONDITIONAL, AND HONESTLY SO: the condition is that ANY row is claimed, which a busy org always
  // satisfies. It is counted as conditional rather than unconditional because a quiet org genuinely pays
  // nothing, and because the answer is already in hand -- `readOpenRows` has fetched the labels, so
  // asking costs no call of its own. The comment bodies are NOT added to the unconditional 500-row read:
  // that would carry every comment on every open row through a 32MB buffer on every tick.
  conditionalOnClaimedRows: "issue list --label in-progress --json number,comments"
    + " (readClaimedRowComments -- claimed-row-amended)",
  // #2470: ONE MORE READ, PAID BY THE SAME CONDITION (some row is claimed) and for the same reason it is one call and not
  // one per row: the newest merged pull requests, of which the claimed branches' are found by name. It bounds what a
  // release for a MERGED row can see to the newest 100 -- at this org's rate about a day -- and a merge older than that,
  // seen only after the gate was down for longer, is missed, not guessed.
  conditionalOnClaimedBranches: "pr list --state merged --limit 100 --json number,headRefName,mergedAt"
    + " (readMergedPrs -- claim-stalled's merged release)",
  // #2286: ONE CALL FOR EVERY BLOCKER, paid only when some unclaimed row has a cleared blocker to ask
  // about. `gh`'s `blockedBy` nodes carry no closing time, and a per-blocker read would make the tick's
  // cost a function of how many rows are waiting.
  conditionalOnClearedRows: "issue list --state closed --limit 100 --json number,closedAt"
    + " (readRecentlyClosed -- unclaimed-blocker-cleared's backoff)",
  // #2356: FOUR MORE REST CALLS, paid ONLY by a tick that found `main` red -- the run's jobs, the recheck
  // job's annotations, `run view --log-failed` for the failing test names, and the merged PR's session.
  // A healthy `main` pays none of them; a red one is rare and short-lived by the ruling this cause serves.
  conditionalOnRedTrunk: "api runs/{id}/jobs, check-runs/{id}/annotations, run view --log-failed,"
    + " commits/{sha}/pulls (readTrunkRed -- trunk-red)",
});

/**
 * THE READS THAT SPEND NO API POOL AT ALL, counted separately BECAUSE they are free rather than left out
 * because they are.
 *
 * `GH_READS` above exists because "two `gh` calls" was repeated for weeks while three readers were added,
 * and a reviewer had to measure the call sites to find it. A read that costs no pool is even easier to
 * add uncounted, and this one is load-bearing in a way that makes its cost worth writing down: #2031's
 * detection MUST NOT spend GraphQL, because the board goes stale precisely when the pool is exhausted
 * and a detector that spent it would be blind in the same outage that produces the defect. That is a
 * property of the implementation, so it is stated where the next person adding a read will read it, and
 * pinned behaviourally in `work-gate.test.ts` (the seam is handed a spy and the binary it spawns is
 * asserted to be `git`, never `gh`).
 */
export const GIT_READS = Object.freeze({
  unconditional: ["git ls-remote --heads origin (readRowBranches -- row-branch-unshipped)"],
  // #2470: LOCAL, AND SPENDS NO POOL. Per claimed row: `git rev-parse` and `git log` for the newest commit on its branch and
  // on `origin/<branch>`; `git status`, `git rev-list` only for a row that is quiet or blocked or merged. Plus one
  // `systemctl --user show herdr.service` for the restart the no-progress clock may not start before.
  conditionalOnClaimedRows: "git rev-parse/log per claimed branch; git status/rev-list per QUIET claimed worktree;"
    + " systemctl --user show herdr.service (claim-stalled)",
});

/**
 * Every `git` spawn in this file, stripped of the `GIT_*` redirects git exports into a hook environment.
 * `git-env.mjs`'s header records the incident: fifteen commits landed in the wrong checkout because an
 * inherited `GIT_DIR` beat `cwd`. This tick runs under systemd, where the environment is not one a
 * person typed and is therefore not one anybody has looked at.
 * @param {string} cmd @param {string[]} args
 */
const defaultSpawn = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", env: sandboxGitEnv() });

/**
 * WHAT ORIGIN ACTUALLY HOLDS -- every branch whose name ends `-<digits>`, with that row number.
 *
 * #2031: THE GATE HAD NO WAY TO SEE PUSHED WORK, and `ready` with no `session:` label was the entire
 * question it asked before offering a row as a fresh start. Measured 2026-09-22 on #2000: the branch
 * `agent/worktree-prune-unit-2000` was pushed at 21:02:36Z and the row read `ready` and unclaimed until
 * 21:22Z, with `gh pr list --head <branch> --state all` returning `[]` for that whole window. The gate
 * offered it throughout and routed a second session into the same three Region paths at 21:06Z; what
 * stopped that session was a worktree-PATH collision, which is not a guard aimed at this.
 *
 * `ls-remote` RATHER THAN A `gh` CALL, AND THAT IS THE DESIGN RATHER THAN A SAVING. Opening the pull
 * request is the act that makes a row look claimed, and that act spends GraphQL -- #1996's PR was never
 * opened because the shared 5,000-point pool was exhausted until 21:20:11Z. So the board goes stale
 * exactly when the pool is gone, and a detector that spent the pool would be blind in the one outage it
 * exists for. This is a LOCAL git call: it fits inside the tick's budget without widening `GH_READS`.
 *
 * `null` FOR A REFUSAL, NEVER `[]` -- #1286's rule, and here it means the cause is not evaluated this
 * tick and NOTHING is shelved. "Could not ask origin" is not "no row has a branch", and it is not
 * "every row has one" either: a tick that cannot reach the remote must go on offering rows exactly as it
 * did before this existed. `row-claim.mjs` THROWS on the same failure and that difference is deliberate
 * -- a claim is about to write and must refuse on a guess; a tick is about to say nothing new.
 *
 * @param {(cmd: string, args: string[]) => string} [run]
 * @returns {{ branch: string, head: string, row: number }[] | null} `null` when refused, never `[]`
 */
export function readRowBranches(run = defaultSpawn) {
  try {
    return rowBranchesInListing(run("git", [...LS_REMOTE_ARGS]));
  } catch {
    return null;
  }
}

/**
 * Labels that already mean NOT PICKABLE, so a row carrying one is not promotable however it is counted.
 *
 * `fleet-gated` is the load-bearing one for parallelism: that work serialises behind physical hardware,
 * so counting it as available capacity would report a queue five engineers could share when one of them
 * would be waiting on a worker box. The rest come from `ready:audit`'s own list of labels that mean a row
 * cannot be started.
 *
 * `meta` joined 2026-09-20 (#1804): a `backlog`+`meta` row ("Not work: a container or process row") has
 * no Region/Acceptance/done-when shape to promote and, unlike `fleet-gated`, is not routed to anyone
 * either -- so it belongs in the POOL's list, not just the owner's subtraction. #20 (the daily board
 * report thread) carried `backlog`+`meta` with no other `NOT_STARTABLE` label and kept re-triggering
 * `ready-queue-empty` on a judgment already settled five times that day.
 */
export const NOT_PICKABLE = Object.freeze(["blocked", "fleet-gated", "epic", "disputed", "decision",
  "awaiting-merge", "review-only", "meta", CLAIM_LABEL]);

/**
 * LABELS THAT ROUTE WORK RATHER THAN STOPPING IT -- the distinction this file did not draw.
 *
 * `fleet-gated`'s own definition on GitHub is "Acceptance needs the fleet or the lab; ORCHESTRATOR RUNS
 * IT". It is a routing label. `NOT_PICKABLE` above is right that it is not available capacity FOR THE
 * ENGINEER POOL -- that work serialises behind physical hardware -- but the list was read as a property
 * of the ROW, so the label also hid the row from the one session it routes the row TO.
 *
 * MEASURED 2026-09-19, with the fleet 10/10 ready, consistent, zero recoveries: `orchestrator` idle,
 * seven `lane:orchestrator` rows open, and ZERO of them visible to `lane-backlog-unpromoted` because
 * every one carried a label in `NOT_PICKABLE`. Twelve `fleet-gated` rows in total, waiting on a fleet
 * that was fully available, and no cause in this file could say so.
 *
 * THE DEADLOCK THAT MAKES IT SELF-SUSTAINING: #914 -- "a nightly fleet capture batch for every
 * fleet-gated row on the milestone" -- is ITSELF `fleet-gated`. The row that would automate draining the
 * pile is hidden by the same rule that hides the pile.
 *
 * A VALUE IS NOW A POOL, NOT A NAME -- #1828, ceo's ruling on #1817 (2026-09-21): "`fleet-gated` routes
 * to a pool of two for now: `orchestrator` and `worker-capture`. Not wider." Every reader of this map
 * (`ownerOf`, `laneBacklogOrders`, `decide`'s pool-count math) must treat the value as a list of names,
 * never assume it is exactly one -- that assumption is what would have silently dropped the second name
 * or thrown reading past index 0.
 *
 * THE POOL IS ONE NAME AGAIN -- #2506, the pool half of the standing-engineer retirement (`ceo`'s ruling on
 * #2470, "The pool, decided"). `worker-capture` is retired, so no generic engineer may claim a `fleet-gated`
 * `lane:orchestrator` row (`laneReason` refuses it) and fleet-gated throughput is `orchestrator`'s own turn
 * rate until `orchestrator` shows a generic engineer's `lab:job` dispatch cannot collide with another capture;
 * the exception then attaches to a ROW, not to a name. The value stays a LIST on purpose: every reader above
 * still treats it as one.
 */
export const ROUTED_TO = Object.freeze({ "fleet-gated": Object.freeze(["orchestrator"]) });

/**
 * Labels meaning the row is not startable work FOR ANYONE -- `NOT_PICKABLE` minus what is merely routed.
 *
 * DERIVED, never retyped, so the pool's view and this one cannot drift: `NOT_PICKABLE` stays exactly
 * what it was (every existing pool behaviour is byte-identical) and this is the strictly smaller set an
 * OWNER is asked about. `blocked`, `epic` and a claim still hide a row from everybody, including the
 * session it is routed to -- routing says whose work it is, not that the work can start.
 */
export const NOT_STARTABLE = Object.freeze(
  NOT_PICKABLE.filter((n) => !(n in ROUTED_TO) && n !== "decision"));

/**
 * LANE OWNERS. A lane says who may act on a row, and these two are people rather than a pool.
 *
 * `lane:any` and no lane are the engineer pool, which is why they are absent here: the pool already has a
 * router (`wake.mjs` picks whoever is idle) and these do not -- a `lane:ceo` row belongs to `ceo` whether
 * or not `ceo` is free, because nobody else may take it.
 */
export const LANE_OWNER = Object.freeze({ "lane:ceo": "ceo", "lane:orchestrator": "orchestrator" });

/**
 * The session a row's lane assigns it to, or `null` for the engineer pool.
 * @param {any} row
 */
export function laneOwnerOf(row) {
  const lane = labelsOf(row).find((/** @type {string} */ n) => n in LANE_OWNER);
  return lane ? /** @type {Record<string,string>} */ (LANE_OWNER)[lane] : null;
}

/**
 * The session (or, for a routed row, the POOL of sessions) a row belongs to -- BY LANE FIRST, THEN BY
 * ROUTING -- or `null` for the engineer pool.
 *
 * LANE WINS, and the precedence is not arbitrary: a `lane:` label REFUSES every other session
 * unconditionally at claim time (`row-claim/runner-rule.mjs`), so it is access control. A routing label
 * only says whose hands the acceptance needs. A `fleet-gated` row carrying `lane:ceo` is `ceo`'s, and
 * telling `orchestrator` about it would be telling them about a row they cannot take.
 *
 * A ROUTED ROW CAN NOW RETURN AN ARRAY -- #1828. `ROUTED_TO`'s value is a pool, not a name, and this
 * function hands that value straight back rather than picking one: every caller (`laneBacklogOrders`,
 * `decide`'s pool-count math) must read a two-name owner as "reaches both", not "reaches the first".
 *
 * @param {any} row
 * @returns {string | readonly string[] | null}
 */
export function ownerOf(row) {
  const byLane = laneOwnerOf(row);
  if (byLane) return byLane;
  // A `decision` ROW WITH NO LANE IS AN UNOWNED DECISION, AND THAT IS A FILING GAP.
  //
  // `decision` is in `NOT_PICKABLE` and rightly -- an engineer cannot decide a thing the org has not
  // assigned. But it was read as "not work" again, so a `decision` row reached NOBODY: measured
  // 2026-09-21, FOUR were open and not one was visible to any cause. #1734 -- "the gate can only see
  // GitHub objects" -- had sat unreachable for days while being cited repeatedly as awaiting a ruling,
  // and #1817 was filed BY THIS SESSION for `ceo` with a label that guaranteed `ceo` would never see it.
  //
  // A laned decision reaches its lane owner by the line above. An UNLANED one reaches
  // `product-manager`, whose brief names "lane labels" and filing: assigning an owner to an unowned
  // decision is that job, not a decision in itself.
  if (labelsOf(row).includes("decision")) return "product-manager";
  const routed = labelsOf(row).find((/** @type {string} */ n) => n in ROUTED_TO);
  return routed ? /** @type {Record<string, string | readonly string[]>} */ (ROUTED_TO)[routed] : null;
}

/**
 * The label a session applies when a row can only move by the CHAIRMAN'S OWN HANDS.
 *
 * NO EXISTING LABEL MEANT THIS. `blocked`, `publish-blocker` and `decision` all say WHAT blocks a row and
 * none says WHO must act, so a row waiting on org admin looked exactly like a row waiting on a capture.
 */
export const CHAIRMAN_LABEL = "needs:chairman";

/**
 * Where a `ready-row-unclaimed` order says which directory to launch the claim from -- FILLED IN BY `wake.mjs` (#2405),
 * because the answer is a fact about the RECIPIENT (does `role-<you>` exist?) and the gate routes a pool order before
 * anyone has taken it. Exported from here so the two files cannot spell it differently; `wake.mjs` already imports this one.
 */
export const LAUNCH_PLACEHOLDER = "<launch-directory>";

/**
 * Rows waiting on the chairman, oldest first.
 *
 * WHY THIS EXISTS, MEASURED: #63 (the org transfer) sat four days with its last comment from the chairman
 * on 2026-09-14, blocking eight publish-gated rows. `ceo` escalated correctly and `product-manager`
 * reported it correctly in every sweep. THE ESCALATION PATH SIMPLY ENDS AT `ceo`, whose onward route is a
 * sentence in a brief rather than a mechanism -- so it surfaced only because the chairman happened to read
 * a sweep in a terminal. That is the same shape as the standing crons #912 retired: a rule written down
 * with nothing behind it.
 *
 * THE GATE CANNOT WAKE A HUMAN, and this does not pretend to. It wakes `ceo`, which is the session whose
 * brief says it briefs the chairman, and it makes the count and the staleness loud enough to be read.
 *
 * `updatedAt` IS LAST ACTIVITY, NOT TIME SPENT WAITING, and the difference matters enough to say in the
 * prompt. Any edit bumps it -- a comment, a label, a milestone -- so a row genuinely stalled for four days
 * reads as fresh the moment somebody labels it, which is exactly what happened to #63 the first time this
 * ran. Measuring true waiting time would need the timeline API per row; last activity is what one cheap
 * list call honestly supports, and it answers the question that matters here: has ANYTHING happened.
 *
 * @param {(args: string[]) => string} [run]
 * @returns {any[] | null} `null` when refused -- never [], which would read as "nobody is waiting"
 */
export function readChairmanBlocked(run = defaultRun) {
  try {
    const out = run(["issue", "list", "--state", "open", "--label", CHAIRMAN_LABEL, "--limit", "100",
      "--json", "number,title,updatedAt"]);
    const parsed = JSON.parse(out);
    if (!Array.isArray(parsed)) return null;
    return parsed.sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
  } catch {
    return null;
  }
}

/**
 * Whole days between an ISO timestamp and `now`. Floor, so "today" reads 0 rather than a fraction.
 * @param {string} iso @param {number} [now]
 */
export function daysSince(iso, now = Date.now()) {
  const at = Date.parse(String(iso));
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, Math.floor((now - at) / 86_400_000));
}

/**
 * The open `backlog` rows carrying NO label that already means unpickable.
 *
 * RETURNS THE ROWS, NOT A COUNT, because the lane matters and re-reading to learn it would be a second
 * `gh` call for a fact the first one already fetched. Callers that only want a number take `.length`.
 *
 * A COUNT IS NOT A TARGET. `product-manager`'s brief says Ready holds at least three product rows, and
 * nothing here enforces that number: `ready:audit` was filed 2026-09-06 after `dispatcher` labelled two
 * rows `ready` TO HIT THE FLOOR -- one disputed, one with no Region or Acceptance -- and its finding is
 * the rule here, *"a floor met by a label I control is not a measurement"*.
 *
 * @param {(args: string[]) => string} [run]
 * @returns {any[] | null} `null` when the read was refused -- never [], which would read as "nothing there"
 */
export function readPromotableRows(run = defaultRun) {
  try {
    // `blockedBy` AND `body` RIDE THE CALL THAT WAS ALREADY BEING MADE. `blockedBy` is GitHub's own
    // dependency edge -- `gh issue create --blocked-by` writes it, the UI renders it, and this `--json`
    // returns it -- so reading a waiting condition costs nothing this tick did not already spend.
    const out = run(["issue", "list", "--state", "open", "--label", "backlog", "--limit", "200",
      "--json", "number,labels,body,blockedBy"]);
    const parsed = JSON.parse(out);
    if (!Array.isArray(parsed)) return null;
    // `NOT_STARTABLE`, NOT `NOT_PICKABLE`: a routed row is kept here and removed again by `ownerOf` for
    // the pool, so the one session it belongs to can still be told about it.
    const today = todayIso();
    // `answer:<session>` IS NOT IN `NOT_STARTABLE` AND NEVER CAN BE -- it is a PREFIX over one name per
    // session, not a literal in the frozen list. A row carrying it is routed to whoever owes the answer
    // and is already independently waking that session (`answerOrders`); it is neither unlaned nor
    // unpickable, so counting it as promotable stock is what made `ready-queue-empty` re-ask a judgment
    // already settled (#1899: #1889 and #1878, both correctly parked, both still counted).
    //
    // #1899 FIXED THAT HERE, WITH A SECOND READER OF THE PREFIX, AND ONLY HERE -- which is why #2005
    // happened one door down: this function was the only one that knew, so the identical question asked
    // by `partitionUnclaimed` ("may this be OFFERED?") still answered `yes`. The local `answered` set is
    // gone and `waitingOn` below now carries it, so the two questions cannot answer differently again.
    return parsed.filter((r) => !labelsOf(r).some((/** @type {string} */ n) => NOT_STARTABLE.includes(n)))
      .filter((r) => waitingOn(r, today) === null);
  } catch {
    return null;
  }
}

/**
 * Open rows carrying `ready`. FILTERED SERVER-SIDE by the label the API already indexes, so this stays
 * one call and this file never spells the literal -- `claim-labels.mjs` owns it (#804).
 * @param {(args: string[]) => string} run
 * @returns {any[] | null}
 */
export function readReadyRows(run = defaultRun) {
  try {
    const out = run(["issue", "list", "--state", "open", "--label", READY_LABEL, "--limit", "100",
      "--json", "number,title,labels,body,blockedBy"]);
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * How many row orders one tick may emit.
 *
 * A CAP, NOT A TARGET, and it is here because the alternative is noise rather than danger. `wake` already
 * refuses an order when nobody is free, so an uncapped gate with 52 Ready rows would print 50-odd
 * UNDELIVERED lines every two minutes and bury the ones that matter. Eight is comfortably more than the
 * org has engineers, so it never throttles real parallelism -- it bounds the REPORT.
 *
 * Raise it when there are more engineers than this, not before.
 */
export const MAX_ROW_ORDERS_PER_TICK = 8;

/** The label `ceo` created for "offer this row before others"; `offerOrder` reads it (#2296). */
export const PRIORITY_LABEL = "priority";

/** @param {any} x @returns {string[]} */
export const labelsOf = (x) => (x?.labels ?? []).map((/** @type {any} */ l) => String(l?.name ?? l));

/**
 * Every open PR the gate is ALLOWED TO COMPARE AGAINST, in `fileOverlapReason`'s shape.
 *
 * #1419's cap is why this FILTERS rather than passing everything through. `gh pr list --json files`
 * returns each PR's first 100 files and never says so, and `fileOverlapReason` answers a list shorter
 * than its own count with a REFUSAL rather than "no overlap". That refusal is right at claim time, where
 * the cost of guessing is two sessions editing one file. It is wrong HERE: the gate's B4 read is a
 * pre-filter, so one truncated list would shelve the entire queue over a pagination artefact.
 *
 * So a PR whose list does not match its count is dropped from the comparison. The gate then cannot see an
 * overlap against it, offers the row, and `row-claim.mjs` refuses at claim time exactly as it does today.
 * **THE GATE FAILS OPEN AND THE AUTHORITY DOES NOT MOVE** -- every shelving decision here can only ever
 * remove a wake that would have ended in a refusal.
 *
 * #2101: `closes` rides along -- the rows each PR's body DECLARES it closes, so `blockedOnOpenPr` can tell
 * a row's own pull request from a competitor for its files. `body` is one more field on `readPrs`'s
 * existing call and costs no extra one.
 *
 * @param {any[]} prs
 * #2493: `held` rides along too -- whether the PR carries a `hold:` label -- from `labels`, already on that call.
 *
 * @returns {{ number: number, files: string[], changedFiles: number, closes: number[], held: boolean }[]}
 */
export function comparablePrFiles(prs) {
  return prs
    .map((p) => ({
      number: Number(p?.number),
      changedFiles: Number(p?.changedFiles),
      files: (p?.files ?? []).map((/** @type {any} */ f) => String(f?.path ?? f)),
      closes: declaredClosedRows(p?.body),
      // #2493: the other half of the exclusion `fileOverlapReason` reads -- a `hold:` label on the PR.
      held: holdersOf(labelsOf(p)).length > 0,
    }))
    .filter((p) => Number.isInteger(p.changedFiles) && p.files.length === p.changedFiles);
}

/**
 * Why B4 would refuse this row RIGHT NOW, or `null` when it would not -- and `null` whenever the question
 * cannot be answered from what the gate has already read.
 *
 * NO REGION IS NOT NO OVERLAP, and this must agree with `row-claim.mjs` about that or the gate would
 * shelve rows the claim would grant. `declaredRegionFiles` returns `null` for a body with no Region
 * section at all; `sessionEligibilityReason` treats that as CANNOT ASK and skips B4 rather than refusing,
 * so this returns `null` too. A Region naming no path is `[]`, which `fileOverlapReason` itself answers
 * with "no overlap" -- a real comparison, and not this function's to second-guess.
 *
 * #2101: THE ROW'S OWN NUMBER GOES WITH ITS REGION. A pull request declaring `Closes #<this row>` is this
 * row's own work and cannot be a reason to withhold it -- the gate shelved #2076 behind #2077, the PR
 * that WAS #2076, and it and two rows behind the same file went nowhere for 1h41m. This must agree with
 * `row-claim.mjs` about that for the same reason the Region read does: a gate that shelves what the claim
 * would grant is a gate nobody can act on.
 *
 * #2493: AND SO DOES THE HELD-PR EXCLUSION, for the same reason: a PR carrying `hold:` whose every closed row is
 * `blockedBy` this row is waiting on it and cannot merge first, so it is no reason to withhold the row -- #2399 was
 * shelved behind #2376, which was waiting on #2399. `blockersOf` is how the gate answers "what blocks that row" from
 * the `blockedBy` it already holds for every open row (`blockersFromRows`), so it makes no call of its own.
 *
 * @param {any} row @param {{ number: number, files: string[], changedFiles: number, closes?: number[], held?: boolean }[]} prFiles
 * @param {{ rootFiles?: Set<string>, blockersOf?: (row: number) => number[] | null }} [options] `rootFiles` is
 *   passed to `declaredRegionFiles` so a test can name its own tree rather than needing this repository's
 * @returns {string | null}
 */
export function blockedOnOpenPr(row, prFiles, options) {
  // NOTHING TO OVERLAP. With no comparable open PR no refusal is possible, and reading the row's Region
  // to discover that would spawn `git ls-tree` for an answer already known.
  if (prFiles.length === 0) return null;
  const mine = declaredRegionFiles(String(row?.body ?? ""), options);
  if (mine === null) return null;
  return fileOverlapReason(mine, prFiles, { rowNumber: Number(row?.number), blockersOf: options?.blockersOf }).reason;
}

/**
 * #2493: what blocks a row, answered from the open rows the gate has ALREADY READ -- `blockedBy` rides
 * `readOpenRows`'s call -- so the exclusion costs the gate nothing. `null` for a row not among them (closed, or
 * beyond the read's limit), which the rule reads as "not excluded".
 *
 * @param {any[] | null | undefined} openRows
 * @returns {(row: number) => number[] | null}
 */
export function blockersFromRows(openRows) {
  const byNumber = new Map((openRows ?? []).map((r) => [Number(r?.number), r]));
  return (number) => {
    const found = byNumber.get(number);
    return found ? (found.blockedBy?.nodes ?? []).map((/** @type {any} */ n) => Number(n.number)) : null;
  };
}

/**
 * PURE. `readRowBranches`'s flat listing, indexed by row number.
 *
 * An ABSENT or `null` listing yields an EMPTY index, and every caller then behaves exactly as it did
 * before #2031 -- that is the degradation `readRowBranches`'s `null` is for, expressed once here rather
 * than as a branch at each of the two call sites.
 * @param {{ branch: string, head: string, row: number }[] | null | undefined} rowBranches
 * @returns {Map<number, { branch: string, head: string }[]>}
 */
function branchIndex(rowBranches) {
  /** @type {Map<number, { branch: string, head: string }[]>} */
  const byRow = new Map();
  for (const found of rowBranches ?? []) {
    const list = byRow.get(found.row) ?? [];
    list.push({ branch: found.branch, head: found.head });
    byRow.set(found.row, list);
  }
  return byRow;
}

/**
 * PURE. What the tick log says about a row whose branches `origin` already holds.
 *
 * IT STATES THE BRANCH AND ITS SHA AND CONCLUDES NOTHING, which is #2031's own "what this will NOT fix":
 * a branch on `origin` for a `ready` row means only that a branch exists. Whether it is finished work
 * awaiting a pull request, or abandoned work, is a reading of the branch -- so this must not assert the
 * row is done, and the wording is the guard against a reader inferring it from a cause that fired.
 * @param {{ branch: string, head: string }[] } pushed
 * @returns {string}
 */
function branchesText(pushed) {
  const named = pushed.map(({ branch, head }) => `\`${branch}\` at ${head.slice(0, 12)}`).join("; ");
  return `origin already holds ${pushed.length === 1 ? "a branch" : `${pushed.length} branches`} carrying `
    + `this row's number: ${named}. That is NOT a claim that the work is finished -- only that it EXISTS `
    + "and nothing on the board says so";
}

/**
 * The unclaimed Ready rows, split into what a session could actually claim right now and what B4 would
 * refuse, with the reason and the row's lane owner.
 *
 * WHY THE GATE ASKS B4 AT ALL, MEASURED 2026-09-18 -- and this is the whole of the change. ALL THREE
 * unclaimed Ready rows (#1452, #1397, #1320) declare `.github/workflows/release.yml`, which open draft
 * #1695 already touches. The gate offered all three every two minutes. `ceo` was woken for #1452, ran
 * sixteen shell commands, rediscovered the refusal, posted it on the row, messaged `product-manager` and
 * stopped -- having re-derived a hold a PRIOR `ceo` session had already recorded. Nothing was wrong with
 * that turn except that it was spent: the refusal is an intersection of two `--json` field lists the
 * gate's own two calls already pay for, knowable before the wake.
 *
 * IT ALSO CORRECTS THE DIAGNOSIS ABOVE. The lane comment in `decide` reads three idle engineers behind
 * laned rows as a LANE problem; re-laning those three rows to `lane:any` would have changed nothing,
 * because an engineer hits the identical B4 refusal. The queue's throughput was one draft's verdict.
 *
 * A BLOCKED ROW IS NOT A DROPPED ROW. The work that frees it is the blocking PR's, and the gate already
 * asks about that PR by its own causes -- so shelving here removes a wake without removing a question.
 * `main` reports every shelving on stderr, and `emptyShelfOrder` names the pool's blocked rows, because a
 * row that vanishes silently is the exact shape of the empty-shelf defect these orders exist to catch.
 *
 * @param {any[]} readyRows @param {{ number: number, files: string[], changedFiles: number, closes?: number[], held?: boolean }[]} prFiles
 * @param {{ rootFiles?: Set<string>,
 *           openRows?: any[] | null,
 *           rowBranches?: { branch: string, head: string, row: number }[] | null,
 *           clock?: {today?: string, nowMs?: number} }} [options]
 *        `rowBranches` is `readRowBranches()`. It DEFAULTS TO ABSENT, which is "not asked or refused":
 *        nothing is shelved for it and every row is offered exactly as it was before #2031, so a tick
 *        that cannot reach `origin` is never worse off than one from before this existed.
 *        `openRows` (#2493) is every open row the gate read, for the `blockedBy` edges that say whether a HELD PR is
 *        waiting on the row asked about. ABSENT, no held PR is excluded and B4 refuses exactly as before.
 *        `clock` is injected the way `partitionFleetBatch` already injects one, and #2113 is why this
 *        path needs one at all: a `Not-before:` may now name an HOUR, so whether a row is offerable can
 *        change within a single day and a test cannot pin that against the host clock.
 * @returns {{ offerable: any[], blocked: { number: number, owner: string | null, reason: string }[] }}
 */
export function partitionUnclaimed(readyRows, prFiles, options) {
  const offerable = [];
  const blocked = [];
  const { today = todayIso(), nowMs = Date.now() } = options?.clock ?? {};
  const onOrigin = branchIndex(options?.rowBranches);
  const blockersOf = blockersFromRows(options?.openRows);
  for (const row of readyRows) {
    // #2005's OPEN-CHECK, ANSWERED BY THIS LINE AND NOT BY A NEW RULE. The filer asked whether
    // `answer:<session>` should hold a row against its OWN HOLDER -- #1948 was `in-progress` +
    // `session:worker-tooling` + `answer:worker-tooling`, and a session is not blocked by its own
    // unanswered question the way a stranger is. It never arises here: a claimed row carries
    // `CLAIM_LABEL` and leaves on this line, before anything asks what it is waiting on. So "not offered
    // to a session other than the one already holding it" needed no expression -- a held row is not
    // offered to anybody, which is strictly stronger and was already true.
    if (labelsOf(row).includes(CLAIM_LABEL)) continue;
    // #2031, AND AHEAD OF EVERY OTHER SHELVING REASON. The others say this row cannot be STARTED yet;
    // this one says it may already be FINISHED, and offering it as a fresh start is the one outcome
    // measured to cost a whole session's turn -- #2000 was offered throughout the 20 minutes its branch
    // sat unshipped on `origin`, and a second session was routed into its three Region paths.
    // SHELVED RATHER THAN DROPPED, like every other reason here: the `SHELVED row #N:` line names the
    // branch and its sha, and `rowBranchOrders` sends somebody to read it. A row that vanishes silently
    // is the failure `blocked` already is.
    const pushed = onOrigin.get(Number(row.number)) ?? [];
    if (pushed.length > 0) {
      blocked.push({ number: Number(row.number), owner: laneOwnerOf(row), reason: branchesText(pushed) });
      continue;
    }
    // A DECLARED WAIT SHELVES THE ROW RATHER THAN HIDING IT. It goes to `blocked` with its reason, so
    // the tick log says why -- a row that vanishes silently is the failure `blocked` already is.
    //
    // SINCE #2005 THAT INCLUDES `answer:<session>`, and nothing here changed to make it so: `waitingOn`
    // gained the kind and this call site inherited it. That is the seam working -- the alternative, a
    // third prefix check written out here beside the one `readPromotableRows` already had, is exactly
    // how the offer path and the promotion path came to disagree in the first place.
    const waiting = waitingOn(row, today, nowMs);
    if (waiting) {
      blocked.push({ number: Number(row.number), owner: laneOwnerOf(row),
        reason: `${describeWaiting(waiting)} -- declared on the row, and it clears itself` });
      continue;
    }
    const reason = blockedOnOpenPr(row, prFiles, { ...options, blockersOf });
    if (reason) blocked.push({ number: Number(row.number), owner: laneOwnerOf(row), reason });
    else offerable.push(row);
  }
  return { offerable, blocked };
}

/**
 * Is this PR's CI green enough to be worth a reviewer's turn?
 *
 * A DRAFT WITH A RED CHECK IS THE AUTHOR'S WORK, NOT THE REVIEWER'S -- `reviewer.md`'s lane is a SETTLED
 * draft, and waking a reviewer for a PR whose own tests are failing spends the org's most expensive turn
 * (worktree, acceptance command, re-derived numbers, mutation) on something the author is still moving.
 *
 * PENDING IS NOT GREEN AND NOT RED. A check still running means the answer is not knowable yet; this
 * returns `null` and the caller emits no order, so the next tick asks again. Reading pending as green
 * would wake the reviewer onto a moving head.
 * CALLERS MUST NARROW FIRST with newestPerName: GitHub unions superseded runs into statusCheckRollup, so a
 * raw read answers about every attempt ever made and one cancelled first try reads as a failure --
 * merge-queue.mjs carried that defect until #634, and local/bounded-window-reads refuses it at the read.
 * @param {any[] | null | undefined} rollup the checks, ALREADY narrowed to the newest run per name
 * @returns {boolean | null}
 */
export function checksSettledGreen(rollup) {
  if (!Array.isArray(rollup) || rollup.length === 0) return null;
  if (rollup.some(stillRunning)) return null;
  const bad = ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"];
  return !rollup.some((c) => bad.includes(conclusionOf(c)));
}

export const conclusionOf = (/** @type {any} */ c) => String(c?.conclusion ?? c?.state ?? "").toUpperCase();

/** @param {any} c */
export function stillRunning(c) {
  const status = String(c?.status ?? "").toUpperCase();
  return status === "IN_PROGRESS" || status === "QUEUED" || status === "PENDING";
}

/**
 * The session a pull request belongs to, from its own `session:` label, or `null`.
 *
 * THE PR CARRIES THE LABEL, which is what makes a red build routable at all. The author field cannot do
 * it -- every PR here is opened by the shared `a11ign-ai-workers` account -- but `arm-pr` puts the
 * claiming session's label on the PR, so the one thing a broken build needs to know is already there.
 *
 * @param {any} pr
 */
export function sessionOf(pr) {
  const label = labelsOf(pr).find((/** @type {string} */ n) => n.startsWith("session:"));
  return label ? label.slice("session:".length) : null;
}

/**
 * PAID ONLY BY A RED TICK, and by the same condition as `requiredWhenRed`, so the two reads ride together
 * and a healthy queue pays neither (#2117). Extracted from `main` for `requiredWhenRed`'s reason, and
 * exported with a `run` seam so a test can assert a healthy tick makes NO call.
 *
 * @param {any[]} prs @param {(args: string[]) => string} [run]
 * @returns {{sha: string, date: string} | null}
 */
export function baseTipWhenRed(prs, run = defaultRun) {
  return anyChecksRed(prs) ? readBaseTip(run) : null;
}

/**
 * PAID ONLY BY A TICK THAT CAN SEE A CLAIM. The `requiredWhenRed`/`epicsWhenShelfEmpty` shape: the
 * condition is derived from rows already in hand, so an org holding nothing makes no call.
 *
 * Extracted rather than written inline in `main` for the reason the two above it were -- `main`'s job is
 * to deliver what the gate found, and `complexity` counts every inline ternary there.
 *
 * @param {any[]} openRows
 * @returns {any[] | null} `null` when not asked or refused -- `decide` treats both the same way
 */
function claimedRowCommentsWhenHeld(openRows) {
  const held = openRows.some((r) => labelsOf(r).includes(CLAIM_LABEL));
  return held ? readClaimedRowComments() : null;
}

/**
 * The open epics, with the one field that says whether anyone has filed them.
 *
 * PAID ONLY BY AN EMPTY SHELF. `main` asks this only when there are no Ready rows -- the single state in
 * which an unfiled epic is the org's most urgent fact. A busy org never pays it, the same bargain
 * `requiredCheckNames` already makes.
 *
 * `subIssuesSummary` AND NOT `blocking`: GitHub has both, and they mean different things. `blocking` is a
 * dependency edge; sub-issues are PARENTHOOD, which is what "has this epic been broken down" asks. Using
 * the wrong one would have read #68 -- which blocks nothing and parents nothing -- as filed.
 *
 * @param {(args: string[]) => string} [run]
 * @returns {any[] | null} `null` when refused, never `[]`
 */
export function readEpics(run = defaultRun) {
  try {
    // `body` AND `blockedBy` RIDE THE SAME CALL so `waitingOn` can be asked -- see `unfiledEpics`.
    const parsed = JSON.parse(run(["issue", "list", "--state", "open", "--label", "epic",
      "--limit", "200", "--json", "number,title,labels,subIssuesSummary,body,blockedBy"]));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Every open row that carries an `answer:` label, and nothing else.
 *
 * SERVER-SIDE IS NOT AVAILABLE HERE. `gh issue list --label` matches one exact label, and this is a
 * PREFIX over eight possible names, so the filter is local. The read is still one call and asks only for
 * `number,labels` -- no bodies, which is what keeps a 500-row page cheap.
 *
 * EVERY OPEN ROW, not just the promotable ones. A question can sit on a `blocked` or `epic` row -- #914,
 * the row that cost 6.5 hours, is `fleet-gated` and would have been outside a promotable-only read. A
 * cause that could not see the row it was written for would be the same defect one level up.
 *
 * @param {(args: string[]) => string} [run]
 * @returns {any[] | null} `null` when refused, never `[]`
 */
export function readOpenRows(run = defaultRun) {
  try {
    // ONE READ, TWO CAUSES. `answer-owed` needs the labels and `blocked-without-a-referent` needs
    // `body` and `blockedBy` as well; asking once and filtering twice keeps the unconditional call
    // count where `GH_READS` says it is.
    const parsed = JSON.parse(run(["issue", "list", "--state", "open", "--limit", "500",
      "--json", "number,title,labels,body,blockedBy,milestone"]));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * #2202: THE CLOSED ROWS THAT STILL OWE AN ANSWER -- the half of `answer-owed` that `readOpenRows` cannot see.
 *
 * `answer:<session>` is the org's only machine-readable "a named session still owes an answer here", and
 * `readOpenRows` is `--state open`, so a merge that closed the row ended the wake and nothing said it had
 * stopped. Measured 2026-09-22: #1936, #1970 and #2034, each labelled 5m23s to 14m45s before the merge that
 * closed it, none of the three questions ever answered. The close path now KEEPS the label
 * (`labelsToStrip`) and says so; this is what keeps acting on it.
 *
 * TWO CALLS, AND BOTH ARE EXACT. `gh` matches one whole label name, and this is a PREFIX over one name per
 * session, so the repo's own `answer:` labels are listed first and the closed rows carrying any of them
 * are asked for by name (`label:"a","b"` is GitHub's OR). A window over the newest closed rows would be
 * one call, but a question older than the window would fall out of it -- the silent-void defect again,
 * one level down -- so this pays the second call to have no such edge.
 *
 * @param {(args: string[]) => string} [run]
 * @returns {any[] | null} `null` when refused, never `[]` -- "could not ask" is not "nobody owes anything"
 */
export function readClosedAnswerRows(run = defaultRun) {
  try {
    const labels = JSON.parse(run(["label", "list", "--search", ANSWER_PREFIX, "--limit", "100",
      "--json", "name"]));
    if (!Array.isArray(labels)) return null;
    const names = labels.map((l) => l?.name).filter((n) => typeof n === "string" && n.startsWith(ANSWER_PREFIX));
    if (names.length === 0) return [];
    const parsed = JSON.parse(run(["issue", "list", "--state", "closed", "--limit", "100",
      "--search", `label:${names.map((n) => `"${n}"`).join(",")}`, "--json", "number,title,labels,state"]));
    return Array.isArray(parsed) ? withAnswerLabel(parsed) : null;
  } catch {
    return null;
  }
}

/**
 * WHICH ROWS ARE THE FLEET BATCH -- ONE SPELLING, IMPORTED BY BOTH FEEDERS (#2443).
 *
 * The batch used to be scoped by the version-one-path MILESTONE, and `fleet-gated-nightly.mjs` carried
 * its own copy of that constant. A `fleet-gated` label means "the acceptance needs a fleet run"; a
 * milestone means "on the version-one path". Those are different questions, so a `fleet-gated` row filed
 * off-path, or moved there by #2273's sort, was invisible to `orchestrator` and nothing said so (#2212 sat
 * on `Out of release` for hours on 2026-09-24 until `product-manager` moved it back by hand).
 *
 * THE LABEL, AND THE ROW'S OWN WAITING FIELDS, AND NOTHING ELSE. `listArgs` is the `gh issue list` half
 * for the feeder that queries; `matches` is the local half for the feeder that already holds every open
 * row. Two feeders reading one object cannot disagree about the population again.
 */
export const FLEET_GATED_SELECTOR = Object.freeze({
  label: "fleet-gated",
  listArgs: Object.freeze(["--label", "fleet-gated"]),
  /** @param {any} row */
  matches: (row) => labelsOf(row).includes("fleet-gated"),
});

/**
 * The open `fleet-gated` rows, SPLIT BY WHETHER ANYTHING IS STOPPING THEM -- #2027.
 *
 * THE ORDER PROMISED AN EXIT THIS FILTER DID NOT HONOUR. `fleetBatchOrders`'s own prompt has said since
 * #1941 that a row which cannot move yet is an answer -- *"say so on it with a machine-readable condition
 * (`Fleet-hold-until:`, `--add-blocked-by`, or `Not-before:`) and it leaves this set until the condition
 * clears"* -- and the set was the `fleet-gated` label and the milestone AND NOTHING ELSE. Writing the
 * condition changed nothing. The only ways out were closing the row or removing its label, which are both
 * lies about a row that is merely waiting.
 *
 * MEASURED IN ONE `work:gate` RUN, 2026-09-22T21:57Z. The same invocation printed
 * `SHELVED row #1976: blocked by #1918` and dispatched #1976 in the fleet batch. Both readings came from
 * this file; one of them was wrong. EIGHT of that batch's NINE rows carried a standing, correct
 * condition -- #31, #43, #149, #1865, #1918, #1926 and #1976 by `blockedBy`, #1042 by `Not-before:` --
 * and exactly one (#1908) was genuinely runnable. Every batch therefore re-reported eight answered rows
 * to find the one that was not: the treadmill the order's own last sentence exists to prevent.
 *
 * `fleetWaitingOn` AND NOT `waitingOn`, because this is the one population where the fourth condition
 * applies: `Fleet-hold-until:` is scoped to an open `fleet-gated` row by its own definition (#1839), and
 * a sequence holding the fleet until a named second is precisely a row this batch must not dispatch.
 *
 * FREE, STILL. `readOpenRows` already asks for `number,title,labels,body,blockedBy,milestone` over the
 * same 500 open rows for `answer-owed` and `blocked-unexaminable`, and every field this needs is in that
 * list. This is a local filter over an array already in hand, not a new call.
 *
 * WAITING IS REPORTED, NEVER SILENT. `partitionUnclaimed` already rules that "a row that vanishes
 * silently is the failure `blocked` already is", so the shelved half is returned with its reason and
 * `main` prints it on the same `SHELVED row #N:` line the engineer pool's shelvings use.
 *
 * @param {any[]} rows
 * @param {{today?: string, nowMs?: number}} [clock] injected so a test moves time without a global stub
 * @returns {{batch: any[], waiting: {number: number, reason: string}[]}}
 */
export function partitionFleetBatch(rows, clock = {}) {
  const { today = todayIso(), nowMs = Date.now() } = clock;
  const batch = [];
  const waiting = [];
  const gated = (rows ?? [])
    .filter(FLEET_GATED_SELECTOR.matches)
    .sort((a, b) => Number(a.number) - Number(b.number));
  for (const row of gated) {
    const held = fleetWaitingOn(row, today, nowMs);
    if (held) {
      waiting.push({ number: Number(row.number),
        reason: `${describeWaiting(held)} -- declared on the row, and it clears itself` });
    } else batch.push(row);
  }
  return { batch, waiting };
}

/**
 * The `fleet-gated` rows that ARE dispatchable -- the batch #914 describes.
 *
 * @param {any[]} rows @param {{today?: string, nowMs?: number}} [clock]
 */
export function fleetBatchRows(rows, clock = {}) {
  return partitionFleetBatch(rows, clock).batch;
}

/**
 * THE FLEET BATCH IS A STATE QUESTION, AND IT SPENT ITS LIFE ON A CLOCK.
 *
 * #1830 built `a11ign-fleet-gated-nightly.timer` to fire at 01:00 UTC, and the cadence was inherited
 * rather than chosen: #914 recorded what a PERSON used to do late at night ("batches starting once the
 * day's last capture job has cleared"), and automating the remembering automated the hour with it.
 *
 * MEASURED 2026-09-22, when the chairman asked why everything waited for 1am: the firing costs
 * **2.2s of CPU and 5s of wall clock**. Two `gh` calls, one comment, one prompt. It performs no capture.
 * There was never a resource argument for daily -- only the habit.
 *
 * AND `agent-practices.md` ALREADY FORBIDS IT, in this repository's own words:
 *
 *   "do not create a cron to check for work. If you think you need one, the gate is missing a question
 *    rather than you needing a timer ... A cron is still right for something that must happen at a
 *    WALL-CLOCK time regardless of state; it is never right for 'has anything changed yet'."
 *
 * "Are there fleet-gated rows to dispatch?" is the second kind. So it moves here, and the timer goes.
 *
 * KEYED ON THE SET, NOT A COUNT AND NOT A CLOCK. The causeKey names every row in the batch, so it fires
 * the moment the set CHANGES -- a row gated, a row cleared -- and stays quiet while it does not. A count
 * would collide two different batches of the same size (#1799's finding, which cost four re-litigations
 * of the same three epics in an hour); a clock fires when nothing has changed and stays silent for
 * twenty-three hours when everything has.
 *
 * A BATCH OF NOTHING IS NOT A BATCH (#2027). Every row waiting on a declared condition is gone before
 * this counts, so a set in which everything is answered emits NO ORDER rather than an order naming rows
 * whose answers are already recorded in a field.
 *
 * @param {any[]} rows every open row
 * @param {{today?: string, nowMs?: number}} [clock]
 * @returns {{session: string, cause: string, subject: string, discriminator: string,
 *            prompt: string, causeKey: string}[]}
 */
export function fleetBatchOrders(rows, clock = {}) {
  const batch = fleetBatchRows(rows, clock);
  if (batch.length === 0) return [];
  const numbers = batch.map((r) => `#${r.number}`).join(", ");
  const key = batch.map((r) => r.number).join(".");
  return [{
    session: "orchestrator",
    cause: "fleet-batch-due",
    subject: "fleet-batch",
    discriminator: key,
    prompt: `${batch.length} row(s) carry \`fleet-gated\` and are open: ${numbers}.\n`
      + "Run the by-row batch per #914's own bar: each row gets a comment naming the capture, the "
      + "reading, and whether it is now workable without the fleet -- or is named not covered and why.\n"
      + "THIS ARRIVES WHEN THE SET CHANGES, NOT ON A CLOCK. It replaced a 01:00 timer that cost 5 "
      + "seconds to run and made the fleet wait up to twenty-three hours for a question worth asking the "
      + "moment a row became gated. So a row that entered this set a minute ago is as real as one that "
      + "has been in it all week -- do not wait for tonight.\n"
      + "A ROW THAT CANNOT MOVE YET IS AN ANSWER: say so on it with a machine-readable condition "
      + "(`Fleet-hold-until:`, `--add-blocked-by`, or `Not-before:`) and it leaves this set until the "
      + "condition clears. A row you merely skip stays in the set and this order returns unchanged.",
    causeKey: `orchestrator/fleet-batch-due/${key}`,
  }];
}

/**
 * THE HOST WENT STALE ON A MERGE AND NOTHING IN THIS ORG FOUND OUT -- #2174.
 *
 * The shipped units are COPIES, not symlinks (`host-units.mjs` says so in its own header and explains
 * why), so every merge touching `packages/agent-org/host/` makes the agent host stale the instant it
 * lands and changes nothing on the host. The only instrument that can see it is `npm run host:check`,
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
 * `a11ign-work-tick.service` runs on the agent host every two minutes with `npm run primary:update` as
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
 * AN ACTION CAUSE, so it is deliberately OUT of `JUDGMENT_CAUSES` and keeps `wake.mjs`'s twenty-minute
 * expiry. It names a thing to DO -- read these findings, then run the remedy -- and if the wake does not
 * stick, nothing happens and nobody notices, which is the defect the expiry exists for (#1433, #1435 sat
 * Ready overnight behind a spent causeKey).
 *
 * `[]` AND `null` BOTH EMIT NOTHING, AND THEY ARE NOT THE SAME CLAIM. `hostUnitDrift` returns `[]` for a
 * clean host AND for a machine with no user systemd manager -- CI, a reviewer's laptop, a container --
 * and `null` here is a read that THREW. All three are silence, because none of them is a stale host; but
 * reading "not asked" as "all correct" is this repository's most-repeated defect, so `driftReport` keeps
 * the two apart in the CLI's output and the tests below assert the three separately rather than once.
 *
 * @param {{unit: string, problem: string, detail: string}[] | null | undefined} drift
 *        `host:check --json`'s findings.
 *        `null`/omitted is "not asked or refused" and emits nothing -- a caller that cannot read the
 *        host must never produce a false all-clear and must never invent a false alarm either.
 * @returns {{session: string, cause: string, subject: string, discriminator: string,
 *            prompt: string, causeKey: string}[]}
 */
export function hostDriftOrders(drift) {
  const findings = Array.isArray(drift) ? drift : [];
  if (findings.length === 0) return [];
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
      + "Then `npm run host:install`, and post whether any `REMOVED` line appeared: not one is expected, "
      + "and a `REMOVED` line is a finding rather than a step. `npm run host:check` answers it in the "
      + "same minute -- `hostUnitsInstall` runs `daemon-reload` itself, so nothing waits for the next "
      + "firing.\n"
      + "A STALE UNIT IS NOT A COSMETIC DIFF. The unit files are copies, so a merged edit reaches this "
      + "host only when somebody reinstalls -- and until then every property this repository can read "
      + "about that unit is a property of a file that is not the one running.",
    causeKey: `${HOST_DRIFT_SESSION}/host-units-stale/${key}`,
  }];
}

/**
 * WHO IS WOKEN, NAMED ON THE ROW RATHER THAN ASSUMED, because #2174 asked for exactly that.
 *
 * `orchestrator`, on #2002's own reasoning: host writes are its work, and `agent-practices.md` already
 * makes it the first reader for fleet and host questions. THE COUNTER-EVIDENCE, stated because it is
 * real: no entry in `docs/lane-ownership.json` covers host paths at all, and BOTH host writes this org
 * has actually made were `worker-capture`'s -- #2002 on 2026-09-23T07:15Z and #2173 at 15:54Z. So this
 * is a routing choice with a live exception, not a settled fact; it is one line to change if the
 * exception becomes the rule, and the wake ledger will show which session actually answers.
 */
const HOST_DRIFT_SESSION = "orchestrator";

/**
 * #2202: `readClosedAnswerRows` with its refusal SAID. Every other reader here degrades to `[]` silently, and
 * that is the one shape this row exists to end for this question -- an answer owed that stopped waking a
 * session with nothing saying it had -- so a refused read is a line, not an empty list.
 * @returns {any[]}
 */
function closedAnswerRows() {
  const rows = readClosedAnswerRows();
  if (rows === null) {
    process.stderr.write("NOTE: could not read the closed rows that still owe an answer -- a question on a row "
      + "a merge already closed is NOT being chased this tick (#2202).\n");
  }
  return rows ?? [];
}

/** The rows that owe someone an answer. @param {any[]} rows */
export function withAnswerLabel(rows) {
  return (rows ?? []).filter((r) => labelsOf(r).some((/** @type {string} */ n) => n.startsWith(ANSWER_PREFIX)));
}

/**
 * EVERY place an `answer:<session>` label can sit, as the one list `decide` takes (#2492). Three reads, one
 * input: the open rows, the open pull requests the gate already holds (`gh issue list` never returns a PR,
 * which is why a label on #2376 woke nobody), and the closed rows still owing (#2202). Kept as one named
 * function so a fourth place is one line here, and a test can call it rather than read `main`'s text.
 *
 * @param {{ openRows: any[], openPrs: any[], closedRows: any[] }} reads
 */
export function rowsOwingAnswers({ openRows, openPrs, closedRows }) {
  return [...withAnswerLabel(openRows), ...withAnswerLabel(openPrs), ...closedRows];
}

/**
 * `blocked` ROWS THAT NAME NOTHING A MACHINE CAN CHECK -- the root cause, not the pile.
 *
 * THE THREE WHYS, run 2026-09-20 when the chairman asked why nobody was working:
 *
 *   1. The engineer pool had ZERO claimable rows -- 1 of 38 was free and it was lane-owned.
 *   2. The whole remaining supply was ELEVEN rows labelled `blocked`, untouched since 19 Sep.
 *   3. Nothing re-examines them: `blocked` is in `NOT_STARTABLE` and filtered out AT READ TIME, so no
 *      cause can see one; and the nightly prose check caught 1 of the 11 (#72, whose body happens to
 *      say "Blocked on npmjs"). TEN WERE INVISIBLE TO EVERY CHECK IN THE SYSTEM.
 *
 * AND THE FOURTH WHY, which is where the fix belongs: #1780 added `blockedBy` and `Not-before:` as
 * PREFERRED alternatives and left `blocked` legal, unexaminable and unmigrated. So the pile both
 * persisted AND regenerated. A cause that drained today's eleven would fix the symptom; this one fires
 * on the PROPERTY -- a `blocked` label naming nothing -- so it also catches every new one.
 *
 * `blocked` IS NOT BANNED, and should not be: a wait neither mechanism can express is real (#1520 waits
 * on a hosted-runner behaviour, not a row or a date). What is refused is a `blocked` that says nothing
 * at all, because a claim nobody can evaluate is one only a human re-reading the row can ever lift --
 * which is exactly how these eleven got to be a day stale with the queue empty behind them.
 *
 * @param {any[]} rows @param {string} [today]
 */
export function blockedWithoutReferent(rows, today = todayIso()) {
  return (rows ?? []).filter((r) => labelsOf(r).includes("blocked")
    && waitingOn(r, today) === null
    // `needs:chairman` IS A REFERENT, AND OMITTING IT MADE THIS CAUSE LOOP.
    //
    // It names a person, it is machine-readable, `chairman-blocked` already routes it, and removing it
    // is the act of clearing -- every property `blockedBy` and `Not-before:` have. It existed before
    // this cause did, and the prompt's three options were therefore the wrong three.
    //
    // MEASURED 2026-09-20 on #72 ("configure npm trusted publishing, then revoke the token"), which
    // waits on an npm org-owner logging into npmjs.com -- a chairman action. `product-manager` read the
    // three options, correctly found that neither `--add-blocked-by` nor `Not-before:` fits, took the
    // third (name in one line what would clear it) and wrote a complete, accurate comment. The row then
    // still carried `blocked` and still named nothing checkable, SO THE CAUSE FIRED AGAIN -- and would
    // have forever. It cost one turn rather than one every two hours only because `product-manager`
    // recognised its own prior comment and declined to re-post.
    && !labelsOf(r).includes(CHAIRMAN_LABEL));
}

/**
 * One order per `blocked` row that names nothing, keyed on the row (#1799).
 *
 * TO `product-manager`: the label is process, and `agent-practices.md` names them first reader for
 * "filing and amendments ... holds, lane labels".
 *
 * ONLY WHEN THE SHELF IS EMPTY, like `epic-unfiled`: a stale `blocked` label while claimable work exists
 * is untidy; with the queue empty it is the only thing between the org and a full shelf.
 *
 * @param {any[]} rows @param {any[]} readyRows @param {string} [today]
 */
export function blockedReferentOrders(rows, readyRows, today = todayIso()) {
  if (readyRows.length > 0) return [];
  return blockedWithoutReferent(rows, today).slice(0, MAX_ROW_ORDERS_PER_TICK)
    .map((/** @type {any} */ r) => ({
      session: "product-manager",
      cause: "blocked-unexaminable",
      subject: `row-${r.number}`,
      discriminator: String(r.number),
      prompt: `#${r.number}${r.title ? ` (${r.title})` : ""} is labelled \`blocked\` and names NOTHING a `
        + "machine can check -- no `blockedBy` edge, no `Not-before:` line. NOTHING IN THIS ORG CAN SEE "
        + "IT: `blocked` is filtered out before any cause runs, so only a person re-reading the row can "
        + "ever lift it.\n"
        + "Read it and do ONE of four things: record the real blocker as data "
        + "(`gh issue edit " + `${r.number}` + " --add-blocked-by <n>`, or a `Not-before: YYYY-MM-DD` "
        + "line in the body); or REMOVE the `blocked` label if the condition has already become true; "
        + `or, IF IT WAITS ON A PERSON, label it \`${CHAIRMAN_LABEL}\` -- that names a referent, `
        + "`chairman-blocked` already routes it, and taking the label off is the act of clearing it; "
        + "or, if the wait is real and none of those three can express it, say on the row IN ONE LINE "
        + "what would clear it and who would notice, AND ADD A `Not-before:` FOR WHEN IT SHOULD NEXT BE "
        + "RE-CHECKED -- a week out is usually right.\n"
        + "THE `Not-before:` IS NOT OPTIONAL ON THAT LAST OPTION, and the reason is measured. Until "
        + "2026-09-21 this prompt said a comment alone was fine and that being re-asked was deliberate. "
        + "#1520 -- a measurement waiting for a run count to reach 20, which is neither a row, a date "
        + "nor a person -- was then correctly re-answered FOUR TIMES IN NINE HOURS (23:43, 01:44, 05:45, "
        + "08:21), each a full turn reaching the identical conclusion, because nothing could record that "
        + "the question had been answered. An explanation with no horizon is not a terminal state; it is "
        + "a loop the org has been instructed to run.\n"
        + "A HORIZON IS ALSO THE HONEST ANSWER TO ROT. An unexaminable wait is exactly the kind that "
        + "quietly becomes true -- so it should go quiet for a while and then be asked ONCE more, not go "
        + "quiet forever and not be asked every two hours. Pick the date by when you would want to know "
        + "if nothing had changed.\n"
        + "Before reaching for that option at all, ask whether the wait is really on a person -- most "
        + `are, and \`${CHAIRMAN_LABEL}\` is then the honest answer.\n`
        + "THE CONDITION HAS OFTEN ALREADY CLEARED. On 2026-09-20 eleven rows carried this label with the "
        + "queue empty behind them, one of them (#1731) about code that had been fixed the day before.",
      causeKey: `product-manager/blocked-unexaminable/row-${r.number}`,
    }));
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
 * THE NAME MOVED TO `waiting-condition.mjs` AND IS RE-EXPORTED HERE (#2005), unchanged. It is a WAITING
 * CONDITION, and that module is the one reader of those -- declaring it here is what let every reader of
 * waiting conditions answer "is this row free?" as `yes` for three days while this same file was waking
 * a session to answer the question holding it. Re-exported rather than moved outright so no importer,
 * test or role brief has to change to say a thing that has not changed.
 */
export { ANSWER_PREFIX };

/**
 * PURE. Who owes an answer on which rows -- `{ session: rows }`, oldest row first within each session.
 *
 * @param {any[]} rows
 * @returns {Map<string, any[]>}
 */
export function answersOwed(rows) {
  /** @type {Map<string, any[]>} */
  const owed = new Map();
  for (const row of rows ?? []) {
    for (const name of labelsOf(row)) {
      if (!name.startsWith(ANSWER_PREFIX)) continue;
      const session = name.slice(ANSWER_PREFIX.length).trim();
      // AN EMPTY SESSION NAME IS NOT A SESSION. A bare `answer:` would otherwise wake a session called
      // "", which herdr reports as unknown and `wake` then counts as an order with nowhere to go.
      if (!session) continue;
      owed.set(session, [...(owed.get(session) ?? []), row]);
    }
  }
  return owed;
}

/**
 * Whether `row` is a pull request as `readPrs` returns one. `gh issue list` never returns `isDraft` or
 * `headRefOid` and `gh pr list --json` always does, so the shape says which list it came from without a
 * tag every caller would have to remember to set. A PR from `readPrs` carries no `state` either -- it reads
 * as open, which is what `--state open` made it.
 *
 * @param {any} row
 */
function isPullRequest(row) {
  return typeof row?.isDraft === "boolean" || typeof row?.headRefOid === "string";
}

/**
 * One order PER ROW that owes an answer, keyed on the row.
 *
 * PER ROW FOR #1799's REASON, applied before it could bite: each row carries a DIFFERENT question, so a
 * count-keyed order would re-ask about every outstanding question each time any one of them was
 * answered. It also makes the prompt name ONE question rather than hand over a list.
 *
 * This cause had never fired when it was re-keyed -- zero ledger entries -- so unlike
 * `lane-backlog-unpromoted` there is no measured waste here, only the identical shape.
 *
 * NOT A JUDGMENT CAUSE, and the only one of the four that is not. The others ask "what should happen
 * next", a standing question deserving the 2h TTL. This names a question SOMEONE ELSE IS BLOCKED ON, so
 * it takes the 20-minute wake cadence -- 6.5 hours is what the absence of any cadence already cost.
 *
 * A PULL REQUEST IS ONE OF THE `rows` (#2492). `gh issue list` does not return pull requests, so a label
 * set on a PR was read by nothing (#2376 carried `answer:worker-tooling` and `answer:ceo` and the wake
 * ledger held no `answer-owed` entry for it). `main` now hands this `readPrs`'s open PRs beside the rows.
 * GitHub numbers issues and pull requests in ONE namespace, so `row-<n>` still names exactly one thing and
 * the key needs no second spelling; only the WORDS change, so the reader looks where the question is.
 *
 * @param {any[]} rows
 */
export function answerOrders(rows) {
  const orders = [];
  for (const [session, owed] of answersOwed(rows)) {
    for (const row of owed.slice(0, MAX_ROW_ORDERS_PER_TICK)) {
      const subject = isPullRequest(row) ? "pull request" : "row";
      orders.push({
        session,
        cause: "answer-owed",
        subject: `row-${row.number}`,
        discriminator: String(row.number),
        prompt: `#${row.number} ${isPullRequest(row) ? "IS A PULL REQUEST " : "IS "}WAITING ON AN ANSWER FROM YOU. `
          + `Another session asked you something there and cannot move until you reply -- read that ${subject}'s `
          + "most recent comments for the question.\n"
          + (row.state === "CLOSED" ? "THE ROW IS CLOSED: a merge closed it while your answer was still owed, "
            + "and closing did not answer it (#2202). A closed row takes a comment, so answer there.\n" : "")
          + `ANSWER ON THE ${subject.toUpperCase()}, then remove its \`${ANSWER_PREFIX}${session}\` label: taking the label `
          + "off IS the act of answering, and it is the only thing that stops this being asked again.\n"
          + "\"I cannot answer this\" is an answer -- say so, say who can, and re-label it to them. "
          + "What is not an answer is silence: on 2026-09-20 a question sat unread for 6.5 hours while "
          + "the session that asked it re-posted five times, because nothing in this org reads comments.",
        causeKey: `${session}/answer-owed/row-${row.number}`,
      });
    }
  }
  return orders;
}

/**
 * #2161: the rows an open pull request DECLARES it closes -- the holders who have demonstrably acted.
 * `declaredClosedRows` is the parser B4 and B7 already share, so "this PR is the row's own work" means
 * one thing in all three places, and `Closes: none` and a malformed body both read as `[]` and so screen
 * nothing. It reads `prs` and not `comparablePrFiles`: that filter drops a PR whose file list is
 * truncated, which is right for an overlap comparison and would here silently withdraw the screen for
 * the largest pull requests -- the ones most likely to be a row's whole build.
 * #2493: a pull request carrying a `hold:` label does not count -- see the body.
 * @param {any[] | null | undefined} openPrs
 * @returns {Set<number>}
 */
function rowsWithOpenPr(openPrs) {
  // #2493: A HELD PR IS NOT AN ACT, IT IS A DECLARED WAIT. `hold:` is the owner saying "do not merge me yet", and the
  // wait behind it is a `blockedBy` edge (#2400 section 2) -- so the holder of a held PR is exactly who must hear
  // that the last edge closed. Counting it as "resumed" silenced the one wake the ruling relies on: #2376's owner
  // had an open PR naming #2359 and would never have been told #2399 merged.
  return new Set((openPrs ?? []).filter((pr) => holdersOf(labelsOf(pr)).length === 0)
    .flatMap((pr) => declaredClosedRows(pr?.body)));
}

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
 * collision `row-file.mjs`'s own header records for `session:`.
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
 * THE PR IS THE DISCRIMINATOR AND A CLAIM TIMESTAMP IS NOT, on `worker-judge`'s argument on the row: a
 * claim that post-dates the clearing means STARTED, an open PR means ACTED ON, and a row claimed after its
 * clearing and then abandoned is exactly the holder this cause must still reach. `prs` is the read
 * `draftOrder` already made, so the narrowing spends no call and does not touch `GH_READS`.
 *
 * @param {any[]} rows every open row
 * @param {string} [today]
 * @param {number} [nowMs] the clock a timestamped hold is read against, injected so a test moves time
 * @param {any[]} [openPrs] `readPrs`'s open pull requests. OMITTED MEANS "NOT ASKED", and the cause then
 *   behaves exactly as before #2161: it fails toward telling the holder, never toward silence
 * @returns {{session: string, cause: string, subject: string, discriminator: string,
 *            prompt: string, causeKey: string}[]}
 */
export function blockerClearedOrders(rows, today = todayIso(), nowMs = Date.now(), openPrs = []) {
  const orders = [];
  const resumed = rowsWithOpenPr(openPrs);
  for (const row of rows ?? []) {
    const session = sessionOf(row);
    const cleared = declaredBlockers(row);
    if (!session || !labelsOf(row).includes(CLAIM_LABEL) || cleared === null) continue;
    if (resumed.has(Number(row.number))) continue;
    // THE LINE THAT MAKES `cleared` MEAN CLEARED. `waitingOn` reports an OPEN `blockedBy` node before
    // anything else, so passing here is what proves every number above is closed -- and it covers the
    // other conditions in the same breath, which is why `declaredBlockers` does not re-ask.
    if (fleetWaitingOn(row, today, nowMs)) continue;
    const key = cleared.join(".");
    orders.push({
      session,
      cause: "blocker-cleared",
      subject: `row-${row.number}`,
      discriminator: key,
      prompt: `#${row.number} IS YOURS AND IS NO LONGER BLOCKED. Every row it declared a dependency on `
        + `is now closed: ${cleared.map((n) => `#${n}`).join(", ")}.\n`
        + "PICK IT BACK UP -- you already hold the claim, so nothing else will offer it to anyone and no "
        + "other cause in this gate addresses a session that already holds a row. That is why this "
        + "exists: on 2026-09-22 #1908's last blocker closed at 21:26:02Z, the next tick said nothing to "
        + "`worker-capture`, and six rows sat behind it until a label meant for something else was "
        + "applied by hand.\n"
        + "IF IT IS STILL NOT RUNNABLE, that is an answer and it goes in a FIELD, not a comment: "
        + `\`gh issue edit ${row.number} --add-blocked-by <n>\`, a \`Not-before: YYYY-MM-DD\` line, or `
        + `\`${ANSWER_PREFIX}<session>\` if you are waiting on somebody to decide. Each clears itself, `
        + "and each stops this being asked again.",
      causeKey: `${session}/blocker-cleared/row-${row.number}/${key}`,
    });
    if (orders.length >= MAX_ROW_ORDERS_PER_TICK) break;
  }
  return orders;
}

export const HOUR_MS = 60 * 60 * 1000;

/**
 * WHEN AN UNANSWERED `unclaimed-blocker-cleared` ORDER MAY BE ASKED AGAIN -- #2286.
 *
 * MEASURED 2026-09-24 (a reading at a moment, from the host's wake ledger): 28 of `product-manager`'s 46
 * recent deliveries were this cause and 23 of them were four rows re-asked at an UNCHANGED key on the
 * two-hour `JUDGMENT_TTL_MS`, six times each over ten hours, with nothing changed between. #2280
 * re-measured the whole ledger and found the same thing at scale: 447 of 454 redundant deliveries were
 * this TTL re-ask working as designed, 7 were inside the window. So the defect is not a leak in the
 * dedupe; it is that the TTL is a FIXED interval, and a fixed interval is the right answer for a question
 * that may have been missed and the wrong one for a question that has been missed FIVE TIMES.
 *
 * A BACKOFF, DERIVED FROM WHEN THE ROW WAS CLEARED, so the gate stays stateless (see `decide`): the
 * order is emitted only during a WINDOW that opens at each offset after the last blocker closed.
 *
 *   0    the clearing itself, at once. #2139 exists because six rows sat runnable up to 16h09m; nothing
 *        here may delay the FIRST ask, and the key of this window is byte-identical to the pre-#2286 key.
 *   6h   a second ask, because an order that lands while `product-manager` is mid-turn is genuinely
 *        missed sometimes, and six hours is one working stretch. #2149 and #2092 were being worked ten
 *        hours after their first delivery, so the second ask is the one that earns its turn.
 *   24h  a third, a day on: the row is now the oldest thing in the queue and the ask is cheap next to
 *        the cost of a forgotten row.
 *   72h, AND EVERY 72h FOR EVER AFTER. THE TAIL NEVER ENDS, which is `ceo`'s first constraint: a row
 *        nobody answered must not go silent, or the treadmill is replaced by the forgotten row this
 *        cause was written to stop. Three days is a long weekend, so a row is never unasked longer.
 *
 * `ceo` DID NOT PICK THIS SCHEDULE AND NOTHING EVIDENCES IT; the four rows' cost under it is in #2286's
 * pull request, and a different ladder is a change to these two constants and nothing else.
 *
 * EACH WINDOW IS EXACTLY `JUDGMENT_TTL_MS` LONG, AND THAT COUPLING IS THE MECHANISM. `wake` dedupes a
 * judgment cause for two hours after a delivery, and a delivery can only happen inside the window, so a
 * key delivered at time `t >= start` is held until `t + 2h >= start + 2h`, the window's end: ONE delivery
 * per window with no state kept anywhere. A window shorter than the TTL would ask once per window too;
 * a longer one would let the TTL re-ask inside it, which is the treadmill. `work-gate.test.ts` pins the
 * two numbers equal, because `wake.mjs` imports this file and cannot be imported back.
 *
 * A window whose order was never delivered (the session was busy, the tick was refused) is RETRIED every
 * tick until the window closes, then not until the next one -- the cost of stopping the treadmill, stated.
 */
export const PROMOTION_ASK_OFFSETS_MS = Object.freeze([0, 6 * HOUR_MS, 24 * HOUR_MS]);

/** The interval of the tail: an ask at every multiple of this after the ladder, for ever. */
export const PROMOTION_ASK_PERIOD_MS = 72 * HOUR_MS;

/** How long each ask stays open -- `wake.mjs`'s `JUDGMENT_TTL_MS`, pinned equal by the test. */
export const PROMOTION_ASK_WINDOW_MS = 2 * HOUR_MS;

/**
 * PURE. The ask a row is in, `age` after its last blocker closed -- or `null` between asks.
 *
 * @param {number} age milliseconds since the clearing; a future stamp (clock skew) reads as zero
 * @returns {{suffix: string} | null} `suffix` is `""` for the first ask, else `@<hours>h`, and it is
 *          part of the causeKey so each window is a NEW question to `wake`'s ledger
 */
export function promotionAskWindow(age) {
  const at = Math.max(0, age);
  const tail = Math.floor(at / PROMOTION_ASK_PERIOD_MS) * PROMOTION_ASK_PERIOD_MS;
  const start = Math.max(tail, ...PROMOTION_ASK_OFFSETS_MS.filter((o) => o <= at));
  if (at - start >= PROMOTION_ASK_WINDOW_MS) return null;
  return { suffix: start === 0 ? "" : `@${start / HOUR_MS}h` };
}

/**
 * When the last of `cleared` closed, in epoch ms. A blocker missing from `closings` closed before the
 * window that read covers, so it counts as the epoch: the row lands on the wall-clock 72-hour grid
 * (`promotionAskWindow`'s tail) rather than being anchored to a moment nobody can name.
 *
 * @param {number[]} cleared @param {Map<number, number>} closings
 */
function clearedAt(cleared, closings) {
  return Math.max(...cleared.map((n) => closings.get(n) ?? 0));
}

/** How many of the most recently closed rows `readRecentlyClosed` asks for: about two days of merges. */
const RECENTLY_CLOSED_LIMIT = 100;

/**
 * When each of the most recently closed rows closed, or `null` when the read is refused.
 *
 * ONE CALL FOR EVERY BLOCKER, NOT ONE PER ROW: `gh`'s `blockedBy` nodes carry `number` and `state` and no
 * closing time, and a per-blocker `issue view` would make the tick's cost a function of how many rows are
 * waiting -- the property `GH_READS` exists to protect. A blocker older than this list is treated as old
 * (`clearedAt`), which is what it is.
 *
 * `null` IS "COULD NOT READ" AND `unclaimedBlockerClearedOrders` FAILS OPEN ON IT: with no closing time the
 * gate asks at the unstaged key, which is the pre-#2286 behaviour. The alternative -- reading a refused
 * call as "everything closed long ago" -- would silence a FRESH clearing behind the 72-hour grid, the
 * exact stranding #2139 was written to end.
 *
 * @param {(args: string[]) => string} [run]
 * @returns {Map<number, number> | null}
 */
export function readRecentlyClosed(run = defaultRun) {
  try {
    const parsed = JSON.parse(run(["issue", "list", "--state", "closed", "--limit",
      String(RECENTLY_CLOSED_LIMIT), "--json", "number,closedAt"]));
    if (!Array.isArray(parsed)) return null;
    /** @type {Map<number, number>} */
    const closings = new Map();
    for (const r of parsed) {
      const at = Date.parse(r?.closedAt);
      if (Number.isFinite(at)) closings.set(Number(r.number), at);
    }
    return closings;
  } catch {
    return null;
  }
}

/**
 * THE SAME CLEARING, ONE POPULATION OVER: an UNCLAIMED row whose last declared blocker closed -- #2139.
 *
 * `blockerClearedOrders` above scopes itself with `labelsOf(row).includes(CLAIM_LABEL)`, and that single
 * condition is the whole gap. A row NOBODY holds reaches no cause at all when its blockers clear:
 * `blocker-cleared` wants a claim, `lane-backlog-unpromoted` addresses only a lane OWNER, and
 * `ready-queue-empty` fires only when the unlaned Ready pool is EMPTY. So a `lane:any` backlog row that
 * has just become startable is visible to the gate and addressed by nothing in it.
 *
 * MEASURED 2026-09-23 ON THE LIVE TRACKER, and the shape is the point rather than the six rows. A sweep
 * for open rows whose every declared blocker is CLOSED returned SIX -- none claimed, none `ready`, all
 * `lane:any`, every one structurally startable -- stranded 57m, 4h30m, 13h43m, 13h51m, 14h09m and
 * **16h09m**, with three of five peer sessions idle the whole time. They were found because a queued
 * report about an unrelated row sent a human looking.
 *
 * AND THE READY QUEUE WAS NOT EMPTY -- FOUR ROWS. That is precisely why the one cause that would
 * eventually have looked stayed silent, and it is why this cause is NOT gated on an empty shelf the way
 * `epic-unfiled` and `blocked-unexaminable` are. The failure being named is a queue with DEPTH and no
 * THROUGHPUT: work the org already owns, already scoped, and merely unpromoted. A shelf-empty gate would
 * have withheld every one of those six for sixteen hours and then reported them as a supply problem.
 *
 * TO `product-manager`, because promotion is that session's call: `agent-practices.md` makes it first
 * reader for "filing and amendments ... holds, lane labels, promotions". This cause does not promote
 * anything itself -- it asks the one session that may.
 *
 * ONE ORDER PER ROW, KEYED ON THE SET THAT CLEARED -- `blockerClearedOrders`' key discipline from #1799,
 * unchanged. An unchanged clearing asks once; a row blocked again and cleared again is a new question.
 *
 * `READY_LABEL` IS EXCLUDED AND IT IS NOT A TIDINESS FILTER. A `ready` row is already offered by
 * `ready-row-unclaimed`, so asking `product-manager` to promote it would be asking for a promotion that
 * has already happened -- an order whose own subject line is false, which is worse than a duplicate.
 *
 * A ROW HIDDEN BY A `NOT_PICKABLE` LABEL IS NAMED, NOT DROPPED, and #1561 is why. Its `blockedBy` edge
 * cleared itself at 2026-09-23T08:28:00Z exactly as designed and it still sat 4h30m, because a hand-set
 * `blocked` LABEL outlived the referent it named: `blocked` is in `NOT_PICKABLE`, so a self-clearing edge
 * was overridden by a non-self-clearing label. Excluding that row would reproduce the very invisibility
 * that stranded it, and `blocked-unexaminable` -- the only other cause that could have reached it -- is
 * itself shelf-gated and was silent for the same four hours. So the order reports the row AND names what
 * still hides it, which is the one thing #2139 forbids doing silently: never reported as free.
 *
 * AN UNANSWERED ORDER BACKS OFF (#2286): see `PROMOTION_ASK_OFFSETS_MS`. `closings` says when each blocker
 * closed; without it (`null`, or an old caller) every order is the unstaged first ask, which is the
 * behaviour before the backoff existed and is what a refused read must fall back to.
 *
 * @param {any[]} rows every open row
 * @param {string} [today]
 * @param {{closings?: Map<number, number> | null, now?: number}} [when]
 * @returns {{session: string, cause: string, subject: string, discriminator: string,
 *            prompt: string, causeKey: string}[]}
 */
export function unclaimedBlockerClearedOrders(rows, today = todayIso(), { closings = null, now = Date.now() } = {}) {
  const orders = [];
  for (const { row, cleared } of unclaimedClearings(rows, today)) {
    const window = closings ? promotionAskWindow(now - clearedAt(cleared, closings)) : { suffix: "" };
    if (window) orders.push(promotionOrder(row, cleared, window.suffix));
    if (orders.length >= MAX_ROW_ORDERS_PER_TICK) break;
  }
  return orders;
}

/**
 * The unclaimed rows whose last declared blocker has closed, with the set that cleared -- the population
 * `unclaimedBlockerClearedOrders` asks about, and the one `main` reads BEFORE deciding whether to pay for
 * `readRecentlyClosed` at all. Split out so those two callers cannot drift into two spellings of "cleared".
 *
 * @param {any[]} rows @param {string} [today]
 * @returns {{row: any, cleared: number[]}[]}
 */
export function unclaimedClearings(rows, today = todayIso()) {
  const found = [];
  for (const row of rows ?? []) {
    const labels = labelsOf(row);
    const cleared = declaredBlockers(row);
    if (labels.includes(CLAIM_LABEL) || labels.includes(READY_LABEL) || cleared === null) continue;
    // THE LINE THAT MAKES `cleared` MEAN CLEARED, and `blockerClearedOrders`' own sentence applies here
    // unchanged: `waitingOn` reports an OPEN `blockedBy` node before anything else, so passing here is
    // what proves every number above is closed -- and it covers the `Not-before:` and `answer:` cases in
    // the same breath, which is why `declaredBlockers` does not re-ask.
    if (waitingOn(row, today)) continue;
    found.push({ row, cleared });
  }
  return found;
}

/**
 * The order `unclaimedBlockerClearedOrders` emits for one row.
 *
 * SPLIT OUT so the loop above reads as the four conditions it actually applies. The prompt carries the
 * ANSWER -- which row, what cleared, and what still hides it -- because a woken turn that has to survey
 * the tracker is a tick with extra steps.
 *
 * @param {any} row @param {number[]} cleared
 * @param {string} [suffix] which re-ask this is -- `""` for the first, `@6h` for the one due six hours on
 */
function promotionOrder(row, cleared, suffix = "") {
  // RE-DERIVED RATHER THAN PASSED IN: the caller's list is its own, and a helper that reads the row it
  // is describing cannot be handed labels belonging to a different one.
  const hiding = labelsOf(row).filter((n) => NOT_PICKABLE.includes(n));
  const key = cleared.join(".");
  return {
    session: "product-manager",
    cause: "unclaimed-blocker-cleared",
    subject: `row-${row.number}`,
    discriminator: key,
    prompt: `#${row.number}${row.title ? ` (${row.title})` : ""} IS UNCLAIMED AND NO LONGER BLOCKED. `
      + `Every row it declared a dependency on is now closed: ${cleared.map((n) => `#${n}`).join(", ")}.\n`
      + "NOTHING ELSE IN THIS ORG WILL SAY SO. `blocker-cleared` addresses the session HOLDING a row and "
      + "nobody holds this one; `lane-backlog-unpromoted` addresses a lane OWNER; `ready-queue-empty` "
      + "fires only when the Ready shelf is EMPTY, and a shelf with four rows on it is why six rows sat "
      + "runnable for up to 16h09m on 2026-09-23 with three engineers idle. Depth is not throughput.\n"
      + "PROMOTE IT, OR RECORD WHY NOT AS DATA. A `ready` label is the promotion; anything else goes in a "
      + `FIELD and not a comment -- \`gh issue edit ${row.number} --add-blocked-by <n>\`, a `
      + `\`Not-before: YYYY-MM-DDTHH:MM:SSZ\` line in the body, or \`${ANSWER_PREFIX}<session>\` if it `
      + "waits on a ruling. Each clears itself, each stops this being asked again, and nothing in this "
      + "org reads comments.\n"
      + (hiding.length > 0
        ? `IT STILL CARRIES ${hiding.map((n) => `\`${n}\``).join(", ")}, AND THAT IS WHAT NOW HIDES IT `
          + "-- the edge cleared itself and the label did not. #1561's `blockedBy` cleared at "
          + "2026-09-23T08:28:00Z exactly as designed and the row sat another 4h30m behind a hand-set "
          + "`blocked`. Take the label off if its condition has become true; if the wait is real, it is "
          + "one of the three fields above, which is the whole difference between a condition that "
          + "clears itself and one only a person re-reading the row can lift.\n"
        : "")
      + "THIS IS NOT A SURVEY OF THE BACKLOG. One row, one clearing, already named -- if the answer is "
      + "\"it stays in backlog\", say so in a field and this stops asking.",
    causeKey: `product-manager/unclaimed-blocker-cleared/row-${row.number}/${key}${suffix}`,
  };
}

/**
 * The blockers this row DECLARED, oldest first -- or `null` when it declared none.
 *
 * IT DOES NOT ASK WHETHER THEY ARE CLOSED, AND THAT IS DELIBERATE RATHER THAN AN OMISSION. `waitingOn`
 * already answers it: an open `blockedBy` node is the FIRST thing it reports, so by the time the caller
 * reaches this line every node here is closed. A second openness test was written here first and a
 * mutation proved it: deleting it left the whole suite green, because no input could reach it -- an
 * unreachable branch is not a guard, it is a second spelling of a rule that lives in
 * `waiting-condition.mjs`, and the two would drift the way this repository's most expensive shape always
 * does. The caller states the dependency in one line rather than restating the rule.
 *
 * SORTED, so the causeKey is stable: GitHub returns `blockedBy.nodes` in its own order, and an unsorted
 * key would mint a different question for the same clearing depending on what that order happened to be
 * -- `fleetBatchOrders` pays for this exact property one function up.
 *
 * @param {any} row
 * @returns {number[] | null}
 */
function declaredBlockers(row) {
  const nodes = row?.blockedBy?.nodes ?? [];
  if (nodes.length === 0) return null;
  return nodes.map((/** @type {any} */ n) => Number(n.number))
    .sort((/** @type {number} */ a, /** @type {number} */ b) => a - b);
}

/**
 * THE MARKERS A ROW USES TO SAY "THIS CHANGED UNDER YOU" -- #2110.
 *
 * DECLARED AND PARSED, NEVER INFERRED FROM PROSE, and that is the whole design rather than a nicety. A
 * cause that fired on ANY comment on a claimed row would wake the holder for their own claim record,
 * their own build report and every clarifying reply -- comment-noise arriving one door along from the
 * gap it was meant to close. So this reads the same shape the `Acceptance:`/`Closes:`/`Not-before:`
 * family already established: a literal a writer has to choose on purpose.
 *
 * TWO SPELLINGS BECAUSE THE TWO WRITERS ARE DIFFERENT. A ruling lands as a COMMENT (`## CONSTRAINT` is
 * the heading `product-manager` used on #2099 at 10:22:34Z, before this cause existed to read it); a
 * constraint the row is filed or amended with lands in the BODY, where `row-file`'s own sections live and
 * where a comment would be the wrong place. Both are append-only from a reader's point of view.
 */
export const CONSTRAINT_COMMENT_MARKER = "## CONSTRAINT";
export const CONSTRAINT_BODY_PREFIX = "Constraint:";

/**
 * Pure: the `## CONSTRAINT` comments a row gained AFTER its newest claim record, oldest first.
 *
 * THE CLAIM RECORD IS THE CLOCK, AND IT COSTS NOTHING. `row-claim` appends `CLAIM_RECORD_MARKER` to the
 * thread on every claim, and `gh issue list --json comments` returns comments OLDEST-FIRST -- so
 * "after the claim" is a position in a list this gate already has in hand, with no timestamp arithmetic
 * and no second read. A row claimed, released and claimed again anchors on the NEWEST record, which is
 * `claimRecordFrom`'s own rule for the same reason: the current holder is the one being told.
 *
 * A ROW WITH NO CLAIM RECORD ANCHORS AT THE START OF THE THREAD. Pre-#987 claims wrote labels and no
 * comment, and the rows carrying them are real; refusing to look would make this cause silently blind to
 * the oldest claims in the tracker, which is a worse failure than announcing a constraint that has been
 * sitting there. It is still one order, because the key names the marker.
 *
 * @param {{body?: string, id?: string}[]} comments oldest first, as `gh issue list --json comments` returns
 * @returns {{body?: string, id?: string}[]}
 */
export function constraintsAfterClaim(comments) {
  const list = comments ?? [];
  let claimedAt = -1;
  for (let i = 0; i < list.length; i += 1) {
    if ((list[i]?.body ?? "").includes(CLAIM_RECORD_MARKER)) claimedAt = i;
  }
  return list.slice(claimedAt + 1).filter((c) => hasConstraintHeading(c?.body ?? ""));
}

/**
 * Pure: does this comment body carry the `## CONSTRAINT` heading as a HEADING?
 *
 * ANCHORED TO A LINE START, so a comment that QUOTES the marker in a sentence -- or that quotes this very
 * rule while explaining it -- is not itself a constraint. That is the mention-versus-use trap
 * `acceptance-commands.mjs` names, and it is the one a plain `includes` would walk straight into: the
 * comment announcing this cause on the row would have fired it.
 * @param {string} body
 */
function hasConstraintHeading(body) {
  return new RegExp(`^${CONSTRAINT_COMMENT_MARKER}\\s*$`, "m").test(body);
}

/**
 * Pure: the amendments a CLAIMED row is currently carrying, in a form a causeKey can name.
 *
 * THREE MARKERS, AND EACH ONE ANSWERS "AFTER THE CLAIM" DIFFERENTLY. This is stated here rather than
 * discovered by the next reader, because one of the three cannot answer it at all:
 *
 *   `comment`    ANSWERED EXACTLY -- its position after the newest claim record, see above.
 *   `blocked-by` ANSWERED BY A RULE ELSEWHERE. `blocked-by-edge-rule.mjs` (#1886, closed 2026-09-22)
 *                REFUSES a claim on a row carrying an open `blockedBy`, so an open edge on a row that IS
 *                claimed can only have arrived after the claim. That is exactly #1918: claimed while
 *                clean, blocked by #2100 afterwards, where no claim-time rule can ever reach it.
 *   `body`       NOT ANSWERED, AND SAYING SO IS THE POINT. Nothing in `gh issue list --json` dates a body
 *                line, and dating one would cost a timeline call PER ROW -- the one thing this read may
 *                not become. So a row FILED with a `Constraint:` line and then claimed emits this cause
 *                once, on the first tick after the claim. That is one order telling a holder to read a
 *                constraint on a row they hold, which is not the failure this cause is about; it is
 *                keyed like the others, so it is once and never again.
 *
 * @param {any} row
 * @param {{body?: string, id?: string}[]} comments this row's comments, oldest first
 * @returns {{kind: string, id: string, says: string}[]}
 */
export function amendmentsOn(row, comments) {
  const markers = [];
  const newest = constraintsAfterClaim(comments).at(-1);
  if (newest) markers.push({ kind: "comment", id: String(newest.id ?? "unidentified"),
    says: `a \`${CONSTRAINT_COMMENT_MARKER}\` comment` });
  for (const line of constraintLines(row?.body ?? "")) {
    markers.push({ kind: "body", id: digestOf(line), says: `the row body's \`${line}\`` });
  }
  const open = openBlockers(row);
  if (open.length > 0) {
    markers.push({ kind: "blocked-by", id: `blocked.${open.join(".")}`,
      says: `an open \`blockedBy\` edge on ${open.map((n) => `#${n}`).join(", ")}` });
  }
  return markers;
}

/**
 * Pure: the row body's `Constraint:` lines, whole, in the order they appear.
 *
 * THE WHOLE LINE IS THE MARKER because the whole line is what changes. Keying on the mere PRESENCE of a
 * `Constraint:` line would make a row whose constraint was REPLACED look unchanged, and the replacement
 * is precisely the amendment a holder must be told about.
 * @param {string} body
 * @returns {string[]}
 */
function constraintLines(body) {
  return [...(body ?? "").matchAll(new RegExp(`^${CONSTRAINT_BODY_PREFIX}\\s*(?:.*\\S)`, "gm"))]
    .map((m) => m[0].trim());
}

/**
 * Pure: the row's STILL-OPEN `blockedBy` numbers, sorted, or `[]`.
 *
 * SORTED for `declaredBlockers`'s reason one function up: GitHub returns the nodes in its own order and an
 * unsorted key would mint a different question for the same set of blockers.
 * @param {any} row
 * @returns {number[]}
 */
function openBlockers(row) {
  return (row?.blockedBy?.nodes ?? [])
    .filter((/** @type {any} */ n) => String(n?.state ?? "").toUpperCase() === "OPEN")
    .map((/** @type {any} */ n) => Number(n.number))
    .sort((/** @type {number} */ a, /** @type {number} */ b) => a - b);
}

/**
 * A short, stable name for a marker GitHub gives no id to -- a body line. Content-derived, so it moves
 * when the line does, which is what makes a REPLACED constraint a new question.
 * @param {string} text
 */
function digestOf(text) {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

/**
 * A ROW MOVED UNDER THE SESSION HOLDING IT, AND NOTHING IN THIS ORG SAID SO -- #2110.
 *
 * MEASURED TWICE IN ONE MORNING, 2026-09-23. #2099 was claimed by `worker-capture` at 09:54:06Z and built
 * by 10:16:50Z; at 10:22:34Z `product-manager` recorded `ceo`'s ruling on it -- *"this row may NOT be
 * implemented by granting a token"* -- 28 minutes after the claim and 6 minutes after the work was
 * finished. It happened to be complied with, and nothing in this org CAUSED that: the gate emitted no
 * cause for `worker-capture` at all, because a claimed row is outside every population it walks.
 * `ready-row-unclaimed` had stopped matching at 09:54 and `blocker-cleared` is the only cause whose
 * subject is a row somebody already holds. The same hour, `orchestrator` was holding #1918 while it
 * acquired an open `blockedBy` on #2100 -- the same defect wearing the other marker.
 *
 * NOT A MESSAGING ROW, AND THAT WAS RULED RATHER THAN ASSUMED. The tempting fix is to make `SendMessage`
 * addresses discoverable; `ceo` steered away from it on 2026-09-23 because the ruling landed precisely
 * BECAUSE it was put on the row. This repo's own rule names the remedy in so many words: if you think you
 * need a cron, the gate is missing a question. This is that question, and it needs no address book at all
 * -- the row's own `session:` label names who owes the answer.
 *
 * ONE ORDER PER ROW, KEYED ON WHAT IS CURRENTLY THERE. The key names EVERY marker the row carries rather
 * than a count or a clock, which is `fleetBatchOrders`'s and `blocker-cleared`'s shape and buys the two
 * properties done-when 3 asks for: a second constraint changes the set, so it is a second question that
 * reaches the holder; an unchanged row mints the identical key on every subsequent tick and the ledger
 * drops it. It is deliberately not "the newest marker" -- the three kinds share no clock (a body line has
 * no timestamp at all), so "newest" would have to be invented, and a constraint REPLACED by a different
 * one would key the same under it and never be told.
 *
 * THE POSITIVE CONTROL LIVES IN `work-gate.test.ts`: an ordinary comment on a claimed row -- a claim
 * record, a build report -- must emit NOTHING. Without it this is a comment-noise generator and the tests
 * that assert silence would all pass against a function that returns `[]`.
 *
 * @param {any[]} rows every open row (`readOpenRows`)
 * @param {{number?: number, comments?: {body?: string, id?: string}[]}[]} [claimedComments]
 *        `readClaimedRowComments`'s answer. `[]` is "not asked or refused", which evaluates the body and
 *        edge markers and not the comment one -- a degradation that can go quiet, never one that invents.
 * @returns {{session: string, cause: string, subject: string, discriminator: string,
 *            prompt: string, causeKey: string}[]}
 */
export function claimedRowAmendedOrders(rows, claimedComments = []) {
  const byRow = new Map((claimedComments ?? []).map((r) => [Number(r?.number), r?.comments ?? []]));
  const orders = [];
  for (const row of rows ?? []) {
    const session = sessionOf(row);
    if (!session || !labelsOf(row).includes(CLAIM_LABEL)) continue;
    const markers = amendmentsOn(row, byRow.get(Number(row.number)) ?? []);
    if (markers.length === 0) continue;
    orders.push(amendedOrder({ row, session, markers }));
    if (orders.length >= MAX_ROW_ORDERS_PER_TICK) break;
  }
  return orders;
}

/**
 * The order itself, split out so `claimedRowAmendedOrders` stays a walk over rows (the Stepdown Rule, and
 * `max-lines-per-function`).
 * @param {{row: any, session: string, markers: {kind: string, id: string, says: string}[]}} found
 */
function amendedOrder({ row, session, markers }) {
  const key = markers.map((m) => m.id).join("+");
  return {
    session,
    cause: "claimed-row-amended",
    subject: `row-${row.number}`,
    discriminator: key,
    prompt: `#${row.number} IS YOURS AND IT HAS CHANGED UNDER YOU. It now carries `
      + `${markers.map((m) => m.says).join(" and ")}.\n`
      + "GO AND READ IT BEFORE YOU WRITE ANOTHER LINE, and if you have already built, check the diff "
      + "against it rather than your memory of the brief. On 2026-09-23 a ruling reached #2099 six "
      + "minutes AFTER the build was finished and 28 minutes after the claim; it was honoured only "
      + "because a human read the thread, and this gate said nothing to the session that held the row.\n"
      + "THEN SAY WHAT YOU DID ABOUT IT, on the row. If the constraint makes the row unbuildable as "
      + `written, that is an answer and it goes in a FIELD: \`${ANSWER_PREFIX}<session>\` for a ruling, `
      + `\`gh issue edit ${row.number} --add-blocked-by <n>\` for a row you must wait on, a `
      + "`Not-before: YYYY-MM-DD` line for a date. Each clears itself.\n"
      + "IF IT IS AN OPEN `blockedBy` EDGE: you were not refused at claim time because the edge did not "
      + "exist then (`blocked-by-edge-rule.mjs` would have refused you) -- it arrived while you held the "
      + "row, which is exactly what happened to #1918 on #2100.",
    causeKey: `${session}/claimed-row-amended/row-${row.number}/${key}`,
  };
}

/**
 * The comments on every CLAIMED row, in one call.
 *
 * `--label in-progress` IS THE WHOLE POINT. The claimed population is the only one this cause has a
 * question about, and filtering server-side is what makes this a bounded read rather than 500 rows of
 * comment bodies through a 32MB buffer. See `GH_READS.conditionalOnClaimedRows` for the arithmetic.
 *
 * `null` FOR A REFUSAL, NEVER `[]` -- #1286's rule, and here it means the comment half of
 * `claimed-row-amended` is not evaluated this tick. The body and edge halves still are, because they ride
 * the read that has already happened.
 *
 * @param {(args: string[]) => string} [run]
 * @returns {any[] | null} `null` when refused, never `[]`
 */
export function readClaimedRowComments(run = defaultRun) {
  try {
    const parsed = JSON.parse(run(["issue", "list", "--state", "open", "--label", CLAIM_LABEL,
      "--limit", "200", "--json", "number,comments"]));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// --- #2470: A CLAIM THAT DOES NOT MOVE ---------------------------------------------------------------------------------

/**
 * The newest merged pull requests, in ONE call, for the claimed branches whose work landed while the row stayed open.
 * `null` FOR A REFUSAL, NEVER `[]` (#1286): an unread list is not "nothing merged", and the merged release is simply not
 * evaluated this tick.
 * @param {(args: string[]) => string} [run]
 * @returns {{ number: number, headRefName: string, mergedAt: string }[] | null}
 */
export function readMergedPrs(run = defaultRun) {
  try {
    const parsed = JSON.parse(run(["pr", "list", "--state", "merged", "--limit", "100", "--json",
      "number,headRefName,mergedAt"]));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * What a row DECLARES it is waiting on, as a phrase, or `null`. Only the waits that are DATA the org already reads -- a
 * future `Not-before:`, an `answer:<session>` label, a `Fleet-hold-until:` and the chairman's label -- and NOT an open
 * `blockedBy` edge, which `claimReading` treats separately (a holder with nothing built is released from one).
 *
 * `answer:<the holder>` IS NOT A WAIT OF THE HOLDER'S. It says a session owes an answer, and when that session is the one holding the row it
 * is the row waiting on the HOLDER -- the opposite of a holder with a legitimate reason to be quiet. `ceo`'s ruling on the 2026-09-25 stalled
 * sweep (a comment on #2470, section B) has `product-manager` set `answer:<holder>` on each stalled claim to wake it; reading those as
 * declared waits would exempt exactly the rows this cause exists for. An `answer:` owed by ANOTHER session (`answer:product-manager` on a
 * row an orchestrator holds) is the holder waiting on a ruling, and is respected.
 * @param {any} row @param {string} holder @returns {string | null}
 */
function declaredWait(row, holder) {
  if (labelsOf(row).includes(CHAIRMAN_LABEL)) return `waiting on the chairman (${CHAIRMAN_LABEL})`;
  const waiting = waitingOn({ ...row, blockedBy: { nodes: [] } }) ?? fleetWaitingOn(row);
  if (waiting === null || (waiting.kind === "answer" && waiting.session === holder)) return null;
  return describeWaiting(waiting);
}

/**
 * THE WHOLE OF `claim-stalled` FOR ONE TICK: read every claimed row, decide, keep the nudge memory, and return the orders
 * (a nudge to a holder; a RELEASE that `wake.mjs` performs).
 *
 * A READ THAT WAS REFUSED EVALUATES NOTHING. `claimedComments === null` means the row comments -- one of the four signals --
 * were not read, and a row read without them looks stalled when it may have been commented on a minute ago. `mergedPrs`
 * null is milder: only the merged release loses its evidence. A row this cannot READ is skipped by name on stderr, because
 * a silence about a claim would look like a claim that was fine.
 *
 * THE CLOCK NEVER STARTS BEFORE THE LAST `herdr.service` START (`restartAt`, 11f), and the tick reads it only when some row
 * is claimed at all. NEVER THROWS: a broken detector must not stop the orders behind it, and it says so.
 *
 * THE SECOND READING IS FAIR ONLY TO A HOLDER THAT WAS TOLD: for a row with a remembered nudge the tick reads the WAKE LEDGER for that nudge's
 * key, and the grace runs from the delivery it finds (`claimReading`). `ledger` is the seam for that read; an unreadable ledger reads as "not
 * delivered", which only DELAYS a release.
 *
 * @param {{ rows: any[], claimedComments: any[] | null, openPrs: any[], mergedPrs: any[] | null,
 *   io?: import("./claim-stall.mjs").HostReads, repo?: string, now?: number, restartAt?: number | null,
 *   stateDir?: string, log?: (line: string) => void, ledger?: () => string,
 *   read?: typeof readStallState, write?: typeof writeStallState }} args
 * @returns {import("./claim-stall.mjs").StallOrder[]}
 */
export function claimStallTick({ io = { git: gitRun, exists: pathExists, mtime: statMtime }, repo = REPO_CHECKOUT, now = Date.now(),
  stateDir = REVIEWER_STATE_DIR, log = (line) => process.stderr.write(line), read = readStallState, write = writeStallState, ...inputs }) {
  try {
    return evaluateClaims({ ...inputs, io, repo, now, stateDir, log, read, write });
  } catch (/** @type {any} */ err) {
    log(`claim-stall: could not run (${String(err?.message ?? err).split("\n")[0]}) -- no claim-stalled order this tick.\n`);
    return [];
  }
}

/**
 * `claimStallTick`'s body, with every default resolved by its caller. NEVER CALLED WITHOUT THE CATCH ABOVE: a throw here is the tick's to report.
 * @param {{ rows: any[], claimedComments: any[] | null, openPrs: any[], mergedPrs: any[] | null, restartAt?: number | null,
 *   ledger?: () => string, io: import("./claim-stall.mjs").HostReads, repo: string, now: number, stateDir: string,
 *   log: (line: string) => void, read: typeof readStallState, write: typeof writeStallState }} args
 */
function evaluateClaims({ rows, claimedComments, openPrs, mergedPrs, restartAt, ledger, io, repo, now, stateDir, log, read, write }) {
  const held = rows.filter((r) => labelsOf(r).includes(CLAIM_LABEL));
  if (held.length > 0 && claimedComments === null) {
    log("claim-stall: the comments on the claimed rows could not be read -- NO claim was evaluated this tick.\n");
    return [];
  }
  const statePath = `${stateDir}/${STALL_STATE_FILE}`;
  const before = read(statePath);
  const byRow = new Map((claimedComments ?? []).map((r) => [Number(r?.number), r?.comments ?? []]));
  const readings = readClaims({ held, byRow, openPrs, mergedPrs, io, repo, now, before, log,
    ledger: ledger ?? (() => ledgerText(`${stateDir}/wake-ledger`)), restart: restartFor(held, restartAt) });
  const after = nextStallState(before, readings, now);
  if (after !== before) write(statePath, after);
  return claimStalledOrders(readings, now);
}

/**
 * The restart the no-progress clock may not precede: the caller's reading when it has one, else `systemctl`'s -- and only when
 * some row is claimed, so a quiet org spawns nothing.
 * @param {any[]} held @param {number | null | undefined} given @returns {number | null}
 */
function restartFor(held, given) {
  if (given !== undefined) return given;
  return held.length > 0 ? readHerdrRestart(systemctlRun) : null;
}

/**
 * @param {{ held: any[], byRow: Map<number, any[]>, openPrs: any[], mergedPrs: any[] | null,
 *   io: import("./claim-stall.mjs").HostReads, repo: string, now: number, restart: number | null,
 *   before: import("./claim-stall.mjs").StallState, log: (line: string) => void, ledger: () => string }} ctx
 */
function readClaims({ held, byRow, openPrs, mergedPrs, io, repo, now, restart, before, log, ledger }) {
  /** @type {{ facts: import("./claim-stall.mjs").ClaimFacts, reading: import("./claim-stall.mjs").Reading }[]} */
  const readings = [];
  for (const row of held) {
    const sessions = labelsOf(row).filter((/** @type {string} */ n) => n.startsWith("session:"));
    if (sessions.length !== 1) {
      log(`claim-stall: #${row.number} carries ${sessions.length} session labels -- not evaluated.\n`);
      continue;
    }
    const session = sessions[0].slice("session:".length);
    const facts = claimFactsFrom({ row: row.number, title: row.title, session, waiting: declaredWait(row, session),
      blockedBy: openBlockers(row), comments: byRow.get(Number(row.number)) ?? [], openPrs, mergedPrs, repo }, io);
    if ("skip" in facts) {
      log(`claim-stall: ${facts.skip} -- not evaluated.\n`);
      continue;
    }
    const remembered = before[facts.row];
    const nudge = remembered?.session === session ? { nudgedAt: remembered.nudgedAt,
      deliveredAt: nudgeDeliveredAt(ledger(), nudgeKey(session, facts.row, remembered.nudgedAt)) } : null;
    const reading = readClaim(facts, { now, restartAt: restart, nudge });
    // A HOLDER THAT HAS WORK AND A BLOCKER is the EXPECTED hold and is not said every tick; only a read that could not be made is.
    if (reading.kind === "holding" && reading.expected !== true) {
      log(`claim-stall: #${facts.row} (${session}) is HELD, not released: ${reading.why}.\n`);
    }
    readings.push({ facts, reading });
  }
  return readings;
}

/** @param {import("./claim-stall.mjs").StallOrder[] | undefined} orders */
const stallOrdersOrNone = (orders) => orders ?? [];

/** The wake ledger's text, `""` when it cannot be read. @param {string} path */
function ledgerText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * `claimStallTick` with its API-facing inputs read HERE, so `main` stays a list of reads: the merged-PR list is paid only when some row is
 * claimed (`GH_READS.conditionalOnClaimedBranches`). THE OPEN ROWS AND THE OPEN PULL REQUESTS ARE PASSED RAW, `null` for a refusal: with either
 * missing nothing is evaluated and nothing is written. A refused pull-request read coalesced to "none open" would read a holder whose PR is in
 * review as one with no PR at all (nudged, or, with a `blockedBy` edge, released), and a refused row read would empty the nudge memory.
 * @param {any[] | null} rows @param {any[] | null} claimedComments @param {any[] | null} prs
 * @param {{ tick?: typeof claimStallTick, merged?: typeof readMergedPrs, log?: (line: string) => void }} [deps]
 */
export function claimStallsNow(rows, claimedComments, prs, { tick = claimStallTick, merged = readMergedPrs,
  log = (line) => process.stderr.write(line) } = {}) {
  if (rows === null || prs === null) {
    log(`claim-stall: the ${rows === null ? "open rows" : "open pull requests"} could not be read -- NO claim was evaluated this tick.\n`);
    return [];
  }
  const anyClaimed = rows.some((r) => labelsOf(r).includes(CLAIM_LABEL));
  return tick({ rows, claimedComments, openPrs: prs, mergedPrs: anyClaimed ? merged() : null });
}

/** @param {string[]} args */
const systemctlRun = (args) => execFileSync("systemctl", args, { encoding: "utf8", timeout: 10_000 });

/** The checkout this file runs from: where `../wt-<row>` claim records are resolved against. */
const REPO_CHECKOUT = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * AN EPIC WITH NO CHILDREN IS NOT A CONTAINER -- IT IS WORK NOBODY HAS FILED.
 *
 * THE THIRD INSTANCE OF ONE DEFECT. `epic` is in `NOT_PICKABLE`, and rightly: an engineer cannot claim a
 * container. But a label that says "not the pool's work" was again read as "not work", and nothing asked
 * the one question that matters about an epic -- HAS ANYONE TURNED IT INTO ROWS?
 *
 *   `fleet-gated`  not the pool's | IS `orchestrator`'s        -- fixed, `ROUTED_TO`
 *   `blocked`      not startable  | a claim with no referent   -- fixed, `blockedBy`/`Not-before:`
 *   `epic`         not pickable   | NOBODY HAS FILED THIS YET  -- this
 *
 * MEASURED 2026-09-20, and it is why the chairman found six engineers idle on a healthy fleet: 40 open
 * rows, 0 ready, 0 open pull requests, ONE row an engineer could pick up -- and that one titled "Human:"
 * because it needs the chairman. Meanwhile SEVENTEEN open epics, SIXTEEN of them with zero sub-issues,
 * nine of those also `fleet-gated`. #34 is the plainest: "Sixteen built cases have never been captured."
 * That is capture work, ready to do, inside a container nobody had opened.
 *
 * THE ORG HAD NOT RUN OUT OF WORK. It had run out of FILED work, and no cause could tell the difference.
 *
 * `product-manager`, because filing is their lane: `agent-practices.md` names them first reader for
 * "filing and amendments, Region and done-when wording". Breaking an epic down IS filing.
 *
 * A JUDGMENT CAUSE, and the prompt says so: some epics genuinely should not be split yet -- one waiting
 * on a decision, or on a release, is correctly whole. "Split none and record why" is a valid answer, the
 * same contract `lane-backlog-unpromoted` already carries.
 *
 * A START CAUSE, so a drain withholds it: splitting an epic MANUFACTURES new work, which is exactly what
 * a drain window exists to stop.
 *
 * @param {{number?: number, title?: string, subIssuesSummary?: {total?: number},
 *          body?: string, blockedBy?: {nodes?: {number?: number, state?: string}[]}}[]} epics
 * @param {string} [today]
 */
export function unfiledEpics(epics, today = todayIso()) {
  return (epics ?? [])
    .filter((e) => (e?.subIssuesSummary?.total ?? 0) === 0)
    // AN EPIC THAT IS WAITING IS NOT UNFILED, IT IS WAITING -- and #1780 already built the mechanism
    // for saying so. This cause shipped without asking, so a correctly-recorded blocker was ignored.
    //
    // MEASURED 2026-09-20: `product-manager` was asked to split #57, judged it "still correctly blocked
    // on the open release milestone", RECORDED THAT AS A REAL `blockedBy` EDGE -- doing exactly what the
    // rule asks -- and was asked again anyway, because `unfiledEpics` only ever looked at sub-issues.
    // From outside, a session correctly declining and a session ignoring its orders look identical.
    .filter((e) => waitingOn(e, today) === null);
}

/**
 * One order per unfiled epic, oldest first, capped -- the orders an unfiled backlog deserves.
 *
 * ONE ORDER PER EPIC, NOT ONE ORDER NAMING EVERY EPIC, for the reason `rowOrders` already settled: a
 * causeKey built from the COUNT conflates two different questions -- did the epic I judged change, and
 * did an unrelated epic get filed by someone else. #1799 measured this against the live ledger: the same
 * three epics (#69, #57, #20) were re-litigated from scratch four times in under an hour, each time a
 * DIFFERENT epic elsewhere was filed and dropped the count by one, minting a causeKey `product-manager`
 * had never seen and so never protected by `JUDGMENT_TTL_MS` --
 *
 *   10:25:37Z  product-manager/epic-unfiled/epics/16
 *   10:41:54Z  product-manager/epic-unfiled/epics/9
 *   11:08:07Z  product-manager/epic-unfiled/epics/5
 *   11:20:30Z  product-manager/epic-unfiled/epics/3
 *
 * Every verdict was independently correct -- "reviewed, not split... blocked-by #5", three times over --
 * the defect was that the judgment had to be redone at all. Keying on the remaining SET instead of the
 * count has the same defect spelled differently: the population still changes on every delivery, because
 * a different epic drops out each time.
 *
 * PER-EPIC KEYING FIXES IT BECAUSE AN UNCHANGED EPIC IS AN UNCHANGED QUESTION. `causeKey` now names the
 * epic, not the shelf: filing #16 elsewhere removes #16's own order and leaves #69's, #57's and #20's
 * causeKeys byte-identical, so `JUDGMENT_TTL_MS` protects each one exactly as long as that epic's own
 * answer has not moved -- the same property `ready-row-unclaimed` already has over `ready-queue-empty`.
 *
 * @param {any[]} epics @param {any[]} readyRows
 * @returns {{session: string, cause: string, subject: string, discriminator: string,
 *            prompt: string, causeKey: string}[]}
 */
export function epicOrders(epics, readyRows) {
  // ONLY WHEN THE SHELF IS EMPTY. An epic left whole while there is claimable work is a priority call,
  // not a defect; it becomes the org's most urgent question only when there is nothing else to pick up.
  if (readyRows.length > 0) return [];
  const unfiled = unfiledEpics(epics);
  return unfiled.slice(0, MAX_ROW_ORDERS_PER_TICK).map((/** @type {any} */ e) => ({
    session: "product-manager",
    cause: "epic-unfiled",
    subject: `epic-${e.number}`,
    discriminator: String(e.number),
    prompt: `NOTHING IS READY AND #${e.number}${e.title ? ` (${e.title})` : ""} IS AN OPEN EPIC WITH NO `
      + "SUB-ISSUES. An epic with no children is not a container -- it is work nobody has filed, and it "
      + "is invisible to every other cause because `epic` means NOT PICKABLE.\n"
      + "Split it into rows an engineer can claim (a Region, an Acceptance, a done-when), using "
      + `\`gh issue edit <child> --parent ${e.number}\` so the link is DATA rather than prose. An epic `
      + "waiting on a decision or a release is correctly whole: say so on it and move on -- leaving it "
      + "whole and recording why is a valid answer, and READ ITS OWN RECENT COMMENTS FIRST -- a durable "
      + "reason recorded there stands until something about this epic itself changes, not just until the "
      + "next unrelated epic gets filed.\n"
      + "PREFER THE ONES THE FLEET CAN ALREADY SERVE. The fleet is the org's scarcest resource and it "
      + "sits idle when capture work is unfiled; a `fleet-gated` epic is where the idle capacity is.",
    causeKey: `product-manager/epic-unfiled/epic-${e.number}`,
  }));
}

/**
 * EPICS WHOSE EVERY CHILD IS CLOSED -- finished work still sitting in the backlog.
 *
 * `unfiledEpics` asks `total === 0`. NOTHING ASKED THE OPPOSITE QUESTION, and `subIssuesSummary` was
 * already on the read: the gate has been fetching `completed` since #1784 and discarding it.
 *
 * MEASURED 2026-09-21, when the chairman asked why nothing was running. 30 open rows, 0 Ready, and
 * exactly ONE row in the whole org an engineer could take. Of the 27 backlog rows, 13 were `epic` --
 * and NINE of those thirteen had every child closed:
 *
 *   #1317 10/10   #142 1/1   #65 1/1   #40 1/1   #37 1/1   #36 1/1   #35 2/2   #34 2/2   #31 1/1
 *
 * #1317 is "Adopt rstest as the test runner", ten children, all ten merged. It is not work. None of them
 * are. The backlog read as 27 rows deep when it held about four real ones, and THAT is why the org
 * running out of work went unnoticed -- every count that matters, `ready-queue-empty`'s own included, is
 * taken over a population padded with finished epics.
 *
 * THE ORDER ASKS, IT DOES NOT ASSERT. Every child closed does NOT prove the epic is done: it equally
 * means the next tranche has not been filed yet, which is the more valuable of the two answers and the
 * one a "close this" order would talk the reader out of. Both outcomes are recorded on the epic, so the
 * next reader inherits the judgment rather than re-deriving it.
 *
 * A WAITING EPIC IS WAITING, not finished -- the same filter `unfiledEpics` carries, for #1780's reason.
 *
 * @param {any[]} epics @param {string} [today]
 */
export function finishedEpics(epics, today = todayIso()) {
  return (epics ?? [])
    .filter((e) => {
      const total = e?.subIssuesSummary?.total ?? 0;
      return total > 0 && (e?.subIssuesSummary?.completed ?? 0) === total;
    })
    .filter((e) => waitingOn(e, today) === null);
}

/**
 * One order per finished epic, capped and keyed per epic -- #1799's ruling, for its reason: a causeKey
 * built from the COUNT is re-minted every time an unrelated epic closes, so a judgment already made gets
 * re-litigated on someone else's progress.
 *
 * SHELF-EMPTY, LIKE `epicOrders`, AND THAT IS A REAL BOUND RATHER THAN A CONVENIENCE. Epics are read at
 * all only when the shelf is empty (`epicsWhenShelfEmpty`), so firing this unconditionally would add an
 * unconditional `gh` read to every tick and `GH_READS` would have to grow. It costs nothing here because
 * the moment the padding actually does harm -- somebody asking why nothing is running -- is exactly the
 * moment the shelf is empty. A padded backlog misleads all the time; it only MISLEADS ABOUT ANYTHING
 * THAT MATTERS when the queue has run dry.
 *
 * @param {any[]} epics @param {any[]} readyRows
 * @returns {{session: string, cause: string, subject: string, discriminator: string,
 *            prompt: string, causeKey: string}[]}
 */
export function finishedEpicOrders(epics, readyRows) {
  if (readyRows.length > 0) return [];
  return finishedEpics(epics).slice(0, MAX_ROW_ORDERS_PER_TICK).map((/** @type {any} */ e) => ({
    session: "product-manager",
    cause: "epic-finished",
    subject: `epic-${e.number}`,
    discriminator: String(e.number),
    prompt: `#${e.number}${e.title ? ` (${e.title})` : ""} IS AN OPEN EPIC WHOSE EVERY CHILD IS CLOSED `
      + `(${e?.subIssuesSummary?.completed ?? 0} of ${e?.subIssuesSummary?.total ?? 0}).\n`
      + "TWO ANSWERS, AND THE ORDER DOES NOT PRESUME WHICH. Either the line of work is FINISHED -- close "
      + "the epic -- or the next tranche of children has simply never been filed, which is the more "
      + "valuable answer because it is unfiled WORK, invisible to every other cause since `epic` means "
      + "NOT PICKABLE. File those rows (a Region, an Acceptance, a done-when) with "
      + `\`gh issue edit <child> --parent ${e.number}\`.\n`
      + "WHY THIS IS NOT BOOKKEEPING: a finished epic left open is counted as backlog by everything that "
      + "counts backlog. Measured 2026-09-21, nine of the org's thirteen open epics were in this state "
      + "and the backlog read three times deeper than it was -- which is how the org ran out of work "
      + "without anyone noticing.\n"
      + "RECORD THE ANSWER ON THE EPIC either way, and READ ITS OWN RECENT COMMENTS FIRST: a durable "
      + "reason recorded there stands until something about THIS epic changes.",
    causeKey: `product-manager/epic-finished/epic-${e.number}`,
  }));
}

/**
 * The epics, but only when there is nothing on the shelf -- an unfiled epic is the org's most urgent
 * fact only in that state, and a busy tick must not pay to ask.
 *
 * (Extracted from `main`, which reached `complexity` 16 with the ternary inline -- the same seam the
 * dead man's switch and the required-check read each took, and for the same reason.)
 *
 * @param {any[]} readyRows
 */
function epicsWhenShelfEmpty(readyRows) {
  return readyRows.length === 0 ? readEpics() ?? [] : [];
}

/**
 * PURE. Does any open pull request have a settled-red check at all?
 *
 * The cheap question that decides whether the expensive one is worth asking. It deliberately looks at
 * EVERY check rather than the required ones -- it cannot know which those are yet, and asking is the
 * thing it is gating.
 *
 * @param {any[]} prs
 */
export function anyChecksRed(prs) {
  return prs.some((pr) => checksSettledGreen(newestPerName(pr?.statusCheckRollup ?? [])) === false);
}

/**
 * ONE SPELLING OF THE ENDPOINT, so the report names what the read actually asks for. A report that
 * quotes a path by hand drifts from the call beside it, and a wrong path in a diagnostic sends the next
 * reader to test something the gate never did.
 *
 * `branches/main`, NOT `branches/main/protection` (#2331). The protection endpoints are repository-ADMIN
 * only, and this gate runs as `a11ign-ai-workers` (`permissions.admin: false`), so it 404'd on every tick
 * for four days (#2106). `branches/main` needs only `pull` and carries the same list.
 */
const BRANCH_ENDPOINT = "repos/{owner}/{repo}/branches/main";

/**
 * What the gate asks of `BRANCH_ENDPOINT`: the list, plus `protected` so the "no usable list" report quotes
 * whether `main` is protected at all (`false` is a trunk fact worth escalating) instead of leaving the
 * reader to guess. Small enough to quote whole.
 */
const BRANCH_JQ = "{protected, contexts: .protection.required_status_checks.contexts}";

/**
 * The checks that can actually BLOCK A MERGE, or `null` when that could not be read.
 *
 * MEASURED 2026-09-19: `main`'s branch protection requires exactly one check --
 *
 *   required_status_checks: ["gate"]
 *
 * -- and `gate` is an aggregator whose `needs` names the nine jobs that matter. EVERY OTHER JOB IS RED
 * WITHOUT BLOCKING ANYTHING, and the gate woke a session for all of them equally.
 *
 * THE WASTED PROMPT THAT FOUND THIS. `sweep` (in `auto-arm.yml`, not in `gate`'s `needs`) went red on
 * #1750 at 14:34Z. The gate woke `worker-capture` with "#1750 at 7a9d8340 has FAILING checks and is
 * blocked... it is yours to fix". #1750 MERGED FOUR MINUTES LATER, at 14:38:46Z. The check was genuinely
 * red and the wake was genuinely useless, because that job could never have held the PR.
 *
 * FAILS OPEN, DELIBERATELY. A refused or malformed read returns `null` and the caller then behaves
 * EXACTLY as it did before this function existed -- every red check counts. The failure this guards is a
 * wasted turn; the failure it must not introduce is a red PR nobody is told about, which is the one
 * `failingChecksOrder` was written for in the first place (#1650, a `changeset` failure that sat while
 * its own session was idle).
 *
 * PAID ONLY WHEN SOMETHING IS RED. `main` calls this only if some open PR has a settled-red check, so a
 * healthy tick still costs the two calls this file's whole design rests on.
 *
 * AND IT SAYS SO WHEN IT FAILS OPEN (#2106). It had failed open on EVERY tick since it shipped, and the
 * only sign was a bare `gh: Not Found (HTTP 404)` on stderr -- `defaultRun` inherits stderr, so `gh`'s own
 * message was the whole report, beside an exit 0. The optimisation was dead in production for four days
 * and nothing said so. A read that fails open must announce it, or "fails open" is indistinguishable from
 * "never worked"; silence is what this repository's diagnostics model exists to refuse.
 *
 * ONCE PER TICK, because `requiredWhenRed` is the only caller and calls this at most once.
 *
 * @param {(args: string[]) => string} [run]
 * @param {(line: string) => void} [log]
 * @returns {string[] | null}
 */
export function requiredCheckNames(run = defaultRun, log = (line) => process.stderr.write(line)) {
  let answer;
  try {
    answer = run(["api", BRANCH_ENDPOINT, "--jq", BRANCH_JQ]);
  } catch (error) {
    // THE REFUSAL AND THE UNUSABLE ANSWER ARE DIFFERENT FACTS, so the call is separated from the parse.
    // A refusal says nothing about whether `main` is protected, and #2022 forbids reading it as if it did.
    const why = String(/** @type {any} */ (error)?.message ?? error).split("\n")[0].trim();
    log(cannotReadRequiredChecks(`was REFUSED (${why}).`));
    return null;
  }
  const contexts = parsedOrNull(answer)?.contexts;
  if (Array.isArray(contexts) && contexts.length > 0) return contexts;
  log(cannotReadRequiredChecks(`answered, but with no usable list of contexts: ${quoted(answer)}.`));
  return null;
}

/** How much of an unusable answer is worth echoing before it becomes the noise it is reporting. */
const ECHOED_ANSWER_CHARS = 200;

/**
 * The answer itself, bounded. `defaultRun` allows a 32MB body, and a diagnostic that pastes one into the
 * tick log replaces a silent failure with an unreadable one.
 * @param {string} text
 */
function quoted(text) {
  const trimmed = text.trim();
  return trimmed.length > ECHOED_ANSWER_CHARS
    ? `${trimmed.slice(0, ECHOED_ANSWER_CHARS)}... (${trimmed.length} chars)`
    : trimmed;
}

/** @param {string} text */
function parsedOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The one report, whatever went wrong, ending in what the gate does about it.
 *
 * THE CONSEQUENCE IS PART OF THE REPORT. A reader who sees only "could not read" has to know #1750 to
 * work out whether anything is at risk; saying the fallback out loud is what keeps this line from being
 * read as an outage. Nothing is missed -- the SAVING is.
 *
 * @param {string} diagnosis
 */
function cannotReadRequiredChecks(diagnosis) {
  return `CANNOT READ the required checks: \`gh api ${BRANCH_ENDPOINT}\` ${diagnosis} `
    + "Falling back to EVERY check on the head (pre-#1750 behaviour): no red pull request is missed, "
    + "but the wasted prompts #1750 was filed to stop are still being sent.\n";
}

/** Where `main` is now, and the one field of it the prompt needs. */
const BASE_TIP_ENDPOINT = "repos/{owner}/{repo}/commits/main";
/** A commit id, abbreviated or whole. An empty or non-hex `sha` would render as a blank tip in the prompt. */
const HEX_SHA = /^[0-9a-f]{7,40}$/i;
const BASE_TIP_JQ = "{sha: .sha, date: .commit.committer.date}";

/**
 * `main`'s tip commit and its committer date, or `null` (#2117).
 *
 * THIS IS A FACT FOR A PROMPT AND NEVER A PREDICATE. `null` -- refused, malformed, no date -- makes the
 * prompt say "not read", which is different from "has not moved", and changes nothing about whether or to
 * whom the order is sent. The committer date is a reading of when `main` last changed, not the instant of
 * the push: a rebased commit keeps an older date, so the prompt quotes the date and lets a reader `git log`.
 *
 * Refusals are announced on stderr like `requiredCheckNames`': a read that fails silently is
 * indistinguishable from one that never ran.
 *
 * @param {(args: string[]) => string} [run]
 * @param {(line: string) => void} [log]
 * @returns {{sha: string, date: string} | null}
 */
export function readBaseTip(run = defaultRun, log = (line) => process.stderr.write(line)) {
  let answer;
  try {
    answer = run(["api", BASE_TIP_ENDPOINT, "--jq", BASE_TIP_JQ]);
  } catch (error) {
    const why = String(/** @type {any} */ (error)?.message ?? error).split("\n")[0].trim();
    log(`CANNOT READ main's tip: \`gh api ${BASE_TIP_ENDPOINT}\` was REFUSED (${why}). `
      + "pr-checks-failing prompts will call `has main moved` UNKNOWN; no order is withheld for it.\n");
    return null;
  }
  const tip = parsedOrNull(answer);
  return HEX_SHA.test(String(tip?.sha)) && Number.isFinite(Date.parse(tip?.date)) ? tip : null;
}

/**
 * PURE. The rollup entries that can hold this pull request, given what is required.
 *
 * `null` required means "unreadable", and that is not the same as "nothing is required" -- the first must
 * consider every check (fail open), the second would consider none and go permanently silent. Keeping
 * them distinct is the whole reason `requiredCheckNames` returns `null` rather than `[]`.
 *
 * @param {any[]} rollup @param {string[] | null} required
 */
export function blockingChecks(rollup, required) {
  if (required === null) return rollup;
  return (rollup ?? []).filter((c) => required.includes(c?.name ?? c?.context));
}

/**
 * PURE. Which open pull requests LOOK like they should be merging already -- not a draft, not held, and
 * settled GREEN on every check that can actually block them?
 *
 * ANSWERED ENTIRELY FROM THE LIST THE GATE ALREADY HOLDS, which is what makes the queue read below
 * conditional rather than unconditional. `ceo`'s ruling of 2026-09-22 requires exactly that: the merge-
 * queue question is "asked only once a PR already looks green, unheld and unqueued". A healthy tick with
 * every open PR armed still pays one extra call; a tick with no green unheld PR at all pays none.
 *
 * `armabilityOf` IS THE HOLD PREDICATE, IMPORTED. It is the same function `arm-pr.mjs` and
 * `auto-arm-sweep.mjs` refuse a held PR with -- `pr-hold-state.mjs`'s own header records #645, where the
 * predicate was written twice and only one copy was correct. A third copy here would report a
 * deliberately held pull request as a stranded one, and send somebody to arm what a ruling holds.
 *
 * REQUIRED-ONLY, like `failingChecksOrder`. A PR green on `gate` merges whatever else is red, and `gate`
 * is the one required context on `main` (measured 2026-09-19). Counting every check would silence this
 * for any PR carrying a red `sweep` -- which is precisely the check the 2026-09-22 outage turned red on
 * every pull request it stranded.
 *
 * @param {any[]} prs @param {string[] | null} [required]
 * @returns {number[]} PR numbers, ascending
 */
export function shouldBeMerging(prs, required = null) {
  return mergeCandidates(prs, required).map((pr) => Number(pr.number)).sort((a, b) => a - b);
}

/**
 * PURE. The pull requests `shouldBeMerging` judges, as OBJECTS rather than numbers.
 *
 * EXTRACTED RATHER THAN COPIED (#2084), because two readers now ask the same question of the same
 * population and the second one needs a field the first throws away. `shouldBeMerging` wants numbers to
 * hand to `readUnarmed`; `reviewBlocked` below wants each PR's `reviewDecision`. A second copy of these
 * three filters is how `pr-hold-state.mjs`'s own header records #645 going wrong -- the predicate written
 * twice, one copy correct -- and here it would be worse than a wrong answer: the two causes would report
 * OVERLAPPING but different populations, so a pull request could be called stranded by one and healthy by
 * the other on the same tick.
 *
 * @param {any[]} prs @param {string[] | null} [required]
 * @returns {any[]}
 */
function mergeCandidates(prs, required = null) {
  return greenUnheldPrs(prs, required)
    .filter((pr) => conflictStateOf(pr) !== CONFLICT_STATE.CONFLICTING);
}

/**
 * PURE. The pull requests that are not a draft, not held and settled green on every required check --
 * BEFORE asking whether they can merge. Both halves of that question are read from this one population:
 * `mergeCandidates` keeps the ones that can, `conflictedPrs` the ones that cannot, so the two partition it
 * and no pull request is called stranded by one cause and healthy by another on the same tick (#2084's
 * argument for extracting `mergeCandidates`, applied once more).
 *
 * @param {any[]} prs @param {string[] | null} [required]
 * @returns {any[]}
 */
function greenUnheldPrs(prs, required = null) {
  return (prs ?? [])
    .filter((pr) => pr && pr.isDraft !== true && Number.isFinite(Number(pr.number)))
    // A DRAFT IS EXCLUDED AT THE SOURCE, NOT BY THE HOLD RULE: `gh pr merge --auto` refuses a draft
    // outright, so an unarmed draft is correct rather than stranded.
    .filter((pr) => armabilityOf({ labels: labelsOf(pr) }).arm)
    .filter((pr) => checksSettledGreen(
      blockingChecks(newestPerName(pr.statusCheckRollup ?? []), required)) === true);
}

/** The three answers `conflictStateOf` can give. `UNREAD` is deliberately not a spelling of "clear". */
export const CONFLICT_STATE = Object.freeze({
  /** GitHub says the branch cannot merge into `main` as it stands. */
  CONFLICTING: "CONFLICTING",
  /** GitHub named a merge state and it is not a conflict. */
  NOT_CONFLICTING: "NOT_CONFLICTING",
  /** The payload carried no usable state -- absent, or `UNKNOWN` while GitHub is still computing it. */
  UNREAD: "UNREAD",
});

/**
 * PURE. #2209: DOES THIS PULL REQUEST CONFLICT WITH `main`? -- three answers, and the third is not "no".
 *
 * EITHER FIELD SAYING CONFLICT IS ENOUGH. `mergeStateStatus: DIRTY` and `mergeable: CONFLICTING` are the
 * same fact in two vocabularies (#2203 carried both), and a conflict is the one state where believing the
 * louder of two fields is safe: the error it can make is a pull request reported to its author, who looks
 * and finds it clean, rather than one nobody was told about.
 *
 * ABSENT OR `UNKNOWN` IS `UNREAD`, AND IT FALLS THE WAY `readPrs`'s OWN `null`-MEANS-REFUSED RULE FALLS
 * (#1286), ONE FIELD DOWN: a question that was not answered is not answered "fine". Concretely, an unread
 * pull request is never certified as one that can merge and is never sent a conflict order it may not
 * deserve, and it STAYS in `mergeCandidates` -- exactly where it sat before this row. Dropping it there
 * would turn a field the gate lost, or GitHub had not yet computed, into a silently emptier
 * `pr-green-unarmed`, which is the reassuring direction a blind spot fails in.
 *
 * @param {any} pr
 * @returns {string} a `CONFLICT_STATE` value
 */
export function conflictStateOf(pr) {
  if (pr?.mergeStateStatus === "DIRTY" || pr?.mergeable === "CONFLICTING") return CONFLICT_STATE.CONFLICTING;
  const status = pr?.mergeStateStatus;
  if ((typeof status === "string" && status !== "UNKNOWN") || pr?.mergeable === "MERGEABLE") {
    return CONFLICT_STATE.NOT_CONFLICTING;
  }
  return CONFLICT_STATE.UNREAD;
}

/**
 * PURE. #2209: the green, unheld, non-draft pull requests that CANNOT MERGE because they conflict with
 * `main` -- the complement of `mergeCandidates` inside `greenUnheldPrs`.
 *
 * @param {any[]} prs @param {string[] | null} [required]
 * @returns {any[]} ascending by PR number
 */
export function conflictedPrs(prs, required = null) {
  return greenUnheldPrs(prs, required)
    .filter((pr) => conflictStateOf(pr) === CONFLICT_STATE.CONFLICTING)
    .sort((a, b) => Number(a.number) - Number(b.number));
}

/**
 * #2084: WHAT GITHUB'S OWN REVIEW DECISION SAYS ABOUT ONE PULL REQUEST -- five states, none of them a guess.
 *
 * THE FIELD IS NOT A STATEMENT ABOUT THE HEAD, AND THAT IS THE FINDING RATHER THAN A CAVEAT. A review
 * attaches to a COMMIT; `reviewDecision` is computed from the latest review REGARDLESS of which head it was
 * posted on. With `dismiss_stale_reviews: false` a refusal outlives the fix and an approval outlives the
 * diff it approved. So this reader deliberately reports GITHUB'S BLOCKING STATE and never claims the
 * decision was made at the current head -- claiming that is the error #2084 exists to name.
 *
 * ABSENT IS ITS OWN STATE AND IT IS NOT "FINE" (`UNREADABLE`), BUT IT IS NOT THIS CAUSE'S SUBJECT EITHER.
 * A payload that never carried the field says nothing about the pull request, so an order naming one would
 * be reporting the gate's own read rather than a state anybody can act on. It IS still the reassuring
 * direction -- a `readPrs` that stopped asking would empty this cause silently -- and the control for that
 * is named and lives one layer up, where the regression would actually be: `work-gate.test.ts`'s
 * "`reviewDecision` rides on readPrs's existing field list" asserts the `--json` argument itself. A guard
 * on the ARGUMENT catches the regression on every run; a guard in this verdict would instead fire on every
 * synthetic fixture in the suite, which is noise rather than a control.
 *
 * EMPTY IS DIFFERENT FROM ABSENT AND IS ALSO NOT A PASS (`NO_DECISION`). GitHub leaves `reviewDecision`
 * EMPTY when the base branch requires no approval -- `branch-protection.test.ts` calls it the #1968 state,
 * measured on a pull request carrying three reviews including an `APPROVED`. Nothing is blocked, and
 * nothing has been reviewed either; folding it into `APPROVED` would report an unprotected base as a
 * satisfied requirement.
 *
 * ANYTHING ELSE IS `UNRECOGNISED` AND STILL BLOCKS, which is `bindsMeVerdict`'s `!== "never"` shape one
 * file over and for its reason: an allowlist of the blocking values would be written from today's
 * vocabulary, and the one value nobody here has seen is exactly the one that would slip through. A state
 * this code cannot name must never be the state that lets a pull request read as healthy.
 *
 * @param {any} pr
 * @returns {{code: string, why: string}}
 */
export function reviewStateOf(pr) {
  if (!Object.hasOwn(pr ?? {}, "reviewDecision")) {
    return { code: REVIEW_STATE.UNREADABLE,
      why: "the payload carries no `reviewDecision` field at all -- this read never asked GitHub, so it is "
        + "not a statement about the pull request" };
  }
  const decision = pr.reviewDecision;
  if (decision === null || decision === "") {
    return { code: REVIEW_STATE.NO_DECISION,
      why: "`reviewDecision` is empty: the base branch computes no decision, so no approval is required and "
        + "none has been recorded -- the #1968 state, which is not an approval" };
  }
  if (decision === "APPROVED") return { code: REVIEW_STATE.APPROVED, why: "`reviewDecision` is APPROVED" };
  if (decision === "REVIEW_REQUIRED") {
    return { code: REVIEW_STATE.AWAITING_REVIEW,
      why: "`reviewDecision` is REVIEW_REQUIRED: GitHub is holding it for an approval nobody has posted" };
  }
  if (decision === "CHANGES_REQUESTED") {
    return { code: REVIEW_STATE.REFUSED,
      why: "`reviewDecision` is CHANGES_REQUESTED: a reviewer refused it, and GitHub will hold it until a "
        + "NEWER review says otherwise -- pushing past a refusal does not clear one" };
  }
  return { code: REVIEW_STATE.UNRECOGNISED,
    why: `\`reviewDecision\` is ${JSON.stringify(decision)}, which this gate has never seen: an unrecognised `
      + "state, and an unrecognised state must not read as a mergeable one" };
}

/** The five states `reviewStateOf` distinguishes. Two of them block, and two of the rest are not passes. */
export const REVIEW_STATE = Object.freeze({
  /** GitHub is waiting for an approval nobody has posted. */
  AWAITING_REVIEW: "AWAITING_REVIEW",
  /** A reviewer refused, and only a newer review clears it. */
  REFUSED: "REFUSED",
  /** The requirement is met. */
  APPROVED: "APPROVED",
  /** The base requires no decision, so there is none -- NOT an approval. */
  NO_DECISION: "NO_DECISION",
  /** The payload never carried the field. NOT a statement about the pull request. */
  UNREADABLE: "UNREADABLE",
  /** A value this gate cannot name. Blocks, deliberately. */
  UNRECOGNISED: "UNRECOGNISED",
});

/** The states that stop a pull request merging, however green and armed it looks. @type {readonly string[]} */
const BLOCKING_REVIEW_STATES = Object.freeze([
  REVIEW_STATE.AWAITING_REVIEW, REVIEW_STATE.REFUSED, REVIEW_STATE.UNRECOGNISED]);

/**
 * PURE. #2084: the pull requests that LOOK like they should be merging and that GitHub's review
 * requirement is holding -- plus any whose decision could not be read at all.
 *
 * `UNREADABLE` IS EXCLUDED, and `reviewStateOf`'s own note says where its control lives instead.
 *
 * THE POPULATION IS `mergeCandidates`', NOT EVERY OPEN PULL REQUEST, and each exclusion is another cause's
 * subject rather than an oversight: a draft belongs to `draft-awaiting-verdict`, a red one to
 * `pr-checks-failing`, and a held one is not merging BY DECISION. What is left is the state nothing in this
 * repository could see before -- not a draft, not held, green on every required check, and blocked anyway.
 *
 * @param {any[]} prs @param {string[] | null} [required]
 * @returns {{number: number, code: string, why: string}[]} ascending by PR number
 */
export function reviewBlocked(prs, required = null) {
  const byNumber = new Map(prs.map((pr) => [Number(pr.number), pr]));
  return mergeCandidates(prs, required)
    .map((pr) => ({ number: Number(pr.number), ...reviewStateOf(pr) }))
    .filter((r) => BLOCKING_REVIEW_STATES.includes(r.code))
    // #2416: `pr-review-blocked` is the third route into a review -- it tells `product-manager` to prompt the
    // reviewer for an AWAITING_REVIEW pull request. A labelled one is waiting for evidence, not a reviewer; a
    // REFUSED one stays, because a refusal is real whatever the PR is waiting on.
    .filter((r) => r.code !== REVIEW_STATE.AWAITING_REVIEW || !awaitingEvidence(byNumber.get(r.number)))
    .sort((a, b) => a.number - b.number);
}

/**
 * Which of these candidates has NOTHING armed -- read from the API, and `null` when it could not be read.
 *
 * THE COST, AND WHY IT IS A GRAPHQL CALL AND NOT A FIELD. `armedFromApi`'s third state is
 * `mergeQueueEntry`, and the merge queue is a GraphQL-only object: measured 2026-09-23 against
 * `gh version 2.100.0`, `gh pr list --json` offers `autoMergeRequest` and NOT `mergeQueueEntry`, so the
 * gate's existing `pr list` structurally cannot answer this however many fields are added to it. One
 * conditional call is the cheapest form the question has.
 *
 * `null` MEANS REFUSED, NEVER EMPTY -- `readPrs`'s rule (#1286) and for its reason. An empty list here
 * says "every green unheld PR is armed", which during the very outage this was built for is the one
 * answer that must never be invented.
 *
 * A CANDIDATE THE QUERY DID NOT RETURN IS DROPPED, NOT REPORTED. `=== false` and not `!== true`: an
 * absent number means the read did not cover it (a PR against another base, or past the 100-PR window),
 * and calling that "unarmed" would wake somebody to arm a pull request nothing has looked at.
 *
 * @param {number[]} candidates @param {(args: string[]) => string} [run]
 * @returns {number[] | null}
 */
export function readUnarmed(candidates, run = defaultRun) {
  if (candidates.length === 0) return [];
  try {
    const nodes = JSON.parse(run(openPullRequestsQueryArgs(REPO)));
    if (!Array.isArray(nodes)) return null;
    const armed = new Map(nodes.map((n) => [Number(n?.number), armedFromApi(n)]));
    return candidates.filter((n) => armed.get(n) === false);
  } catch {
    return null;
  }
}

/**
 * The head this pull request's review question is asked at, or `null` when it is not asked: red, still
 * running, or headless. Shared by `draftOrder` and the enrichment that decides which pull requests are
 * worth a commit read, so the two can never disagree about who is being asked.
 * @param {any} pr @returns {string | null}
 */
export function reviewableHead(pr) {
  if (checksSettledGreen(newestPerName(pr?.statusCheckRollup)) !== true) return null;
  return String(pr.headRefOid ?? "") || null;
}

/**
 * The verdict this pull request carries, looked for at EVERY head an update-branch made equivalent, newest
 * first. A reviewer who wrote `at <head8>` after the last update-branch wrote it at THAT sha, so reading
 * only the authored one would re-summon a reviewer who had answered.
 * @param {any} pr @param {string[]} heads
 */
export function verdictAmong(pr, heads) {
  const comments = (pr.comments ?? []).map((/** @type {any} */ c) => ({ body: c?.body ?? "", id: c?.id }));
  let found = verdictAtHead({ comments, head: heads[0], prAuthor: pr.author?.login ?? null });
  for (const head of heads.slice(1)) {
    if (found.verdict !== null) break;
    found = verdictAtHead({ comments, head, prAuthor: pr.author?.login ?? null });
  }
  return found;
}

/**
 * The commits of one pull request, oldest first, or `null` when the read was refused.
 *
 * REST, NOT THE LIST CALL, AND MEASURED: `commits` on `gh pr list --limit 100` is refused outright by
 * GraphQL ("requesting up to 1,000,000 possible nodes which exceeds the maximum limit of 500,000",
 * 2026-09-24) even with no other field beside it, so it cannot ride on `readPrs` however cheap it looks.
 * REST also spends the CORE pool, not the GRAPHQL one the list call already leans on, and returns every
 * commit rather than the first hundred -- `reviewChainOf` reads the END of the list.
 *
 * @param {number} number @param {(args: string[]) => string} run
 * @returns {{oid: string, messageHeadline: string, parents: number}[] | null}
 */
export function readCommitChain(number, run = defaultRun) {
  try {
    const out = run(["api", `repos/${REPO}/pulls/${number}/commits`, "--paginate", "--jq",
      ".[] | {oid: .sha, parents: (.parents | length), messageHeadline: (.commit.message | split(\"\\n\")[0])}"]);
    const commits = out.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
    return commits.length > 0 ? commits : null;
  } catch {
    // A REFUSED READ LEAVES THE PULL REQUEST UNENRICHED, and `draftOrder` then reads the current head alone
    // -- this gate's behaviour before #2176. Never an empty chain: that would claim "no commits".
    return null;
  }
}

/**
 * The pull requests, each with its `commits` attached WHERE THE REVIEW QUESTION NEEDS THEM -- green, and
 * with no verdict at the current head. Everything else is returned untouched, so a quiet queue pays no call
 * and a busy one pays one per unreviewed green pull request, not one per open one.
 *
 * @param {any[]} prs @param {(args: string[]) => string} [run]
 */
export function withCommitChains(prs, run = defaultRun) {
  return prs.map((pr) => {
    const head = reviewableHead(pr);
    // #2416: NO VERDICT WILL BE ASKED OF A LABELLED PULL REQUEST, so its commit chain is a call for nothing.
    if (!head || awaitingEvidence(pr) || verdictAmong(pr, [head]).verdict !== null) return pr;
    const commits = readCommitChain(Number(pr.number), run);
    return commits ? { ...pr, commits } : pr;
  });
}

/** #2416: the PR label meaning "my done-when needs an external run, and the evidence is not posted yet". */
export const AWAITING_EVIDENCE_LABEL = "awaiting-evidence";

/** #2416: how long a PR may carry the label with nobody saying what it waits on before `product-manager` is asked. */
export const AWAITING_EVIDENCE_QUIET_HOURS = 48;
export const AWAITING_EVIDENCE_QUIET_MS = AWAITING_EVIDENCE_QUIET_HOURS * HOUR_MS;

/** @param {any} pr */
export function awaitingEvidence(pr) {
  return labelsOf(pr).includes(AWAITING_EVIDENCE_LABEL);
}

/**
 * When the label was LAST applied to this pull request (ISO string), or `null` when it could not be read.
 *
 * THE EVENTS LIST, NOT THE TIMELINE: `issues/{n}/events` answers "when was this label applied" with a
 * `created_at` on each `labeled` event and is a strict subset of the timeline, so it is the cheaper of the two
 * reads that can answer it. THE LAST `labeled` EVENT, because a label removed (the evidence posted) and
 * applied again is a new wait. `null` is refused-or-never-applied, and neither becomes an order: an order
 * naming a PR whose label age is unknown would be a claim the gate never measured.
 *
 * @param {number} number @param {(args: string[]) => string} run @returns {string | null}
 */
export function readEvidenceLabelledAt(number, run = defaultRun) {
  try {
    const out = run(["api", `repos/${REPO}/issues/${number}/events`, "--paginate", "--jq",
      `.[] | select(.event == "labeled" and .label.name == "${AWAITING_EVIDENCE_LABEL}") | .created_at`]);
    const applied = out.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    return applied.length > 0 ? applied[applied.length - 1] : null;
  } catch {
    return null;
  }
}

/**
 * The pull requests, each one carrying the label with `awaitingSince` attached. A queue where nothing carries the
 * label pays NO call, and a labelled one pays one per labelled pull request -- the condition is answered from
 * the list already in hand, which is what makes the read affordable on every tick.
 *
 * @param {any[]} prs @param {(args: string[]) => string} [run]
 */
export function withEvidenceLabelAges(prs, run = defaultRun) {
  return prs.map((pr) => {
    if (!awaitingEvidence(pr)) return pr;
    const awaitingSince = readEvidenceLabelledAt(Number(pr.number), run);
    return awaitingSince ? { ...pr, awaitingSince } : pr;
  });
}

/**
 * THE `priority` LABEL ORDERS OFFERS, AND DOES NOT GRANT (#2296). `ceo` created it 2026-09-24 as "offer this
 * row before others"; nothing read it, so a priority row waited its turn by row number like any other.
 * Labelled rows go AHEAD of the rest and this runs BEFORE the per-tick slice, or a high-numbered priority
 * row would be cut by the very cap it exists to beat. A row `partitionUnclaimed` shelved never reaches
 * here, so the label cannot walk a row past B4 or a claim label.
 *
 * OLDEST FIRST WITHIN EACH GROUP, because a queue that hands out its newest rows first starves its oldest --
 * and the number is a row number, so ascending IS oldest. Hand assignment stays the fallback.
 *
 * @param {any[]} unclaimed
 */
function offerOrder(unclaimed) {
  const isPriority = (/** @type {any} */ row) => labelsOf(row).includes(PRIORITY_LABEL);
  return [...unclaimed].sort((a, b) =>
    Number(isPriority(b)) - Number(isPriority(a)) || Number(a.number) - Number(b.number));
}

/**
 * One order per unclaimed Ready row, priority rows first then oldest first, capped.
 *
 * SPLIT OUT OF `decide` for the same reason `laneBacklogOrders` was: adding lane routing took that
 * function past `local/max-physical-lines-per-function` 90. `decide` asks what the queue needs;
 * this asks which rows are on offer and to whom.
 *
 * @param {any[]} unclaimed the unclaimed Ready rows `partitionUnclaimed` judged actually claimable --
 *   the CLAIM_LABEL filter and the B4 filter both live there now, because the caller needs the rows
 *   this one discards (a shelved row is reported, not forgotten)
 */
function rowOrders(unclaimed) {
  const orders = [];
  // UNCLAIMED IS `ready` WITHOUT `in-progress`, and since 2026-09-18 also WITHOUT a B4 overlap against an
  // open PR -- both decided by `partitionUnclaimed`. This is still a CANDIDATE, not a grant:
  // `row-claim.mjs` is the authority and the woken engineer runs it. A gate that claimed rows would be a
  // second writer of the claim state, which is the race #176 already cost this repo once.
  //
  // ONE ORDER PER ROW, NOT ONE ORDER NAMING EVERY ROW -- and that is the difference between one engineer
  // working and several. This emitted a SINGLE order listing all unclaimed rows, and `wake` routes one
  // order to one session, so however deep the queue got, exactly one engineer was recruited per tick.
  // Measured 2026-09-17 with eight rows Ready: worker-capture woken at 18:52, worker-judge at 18:56,
  // worker-capture again at 18:58, and worker-tooling still idle throughout. The queue was not the
  // constraint and neither were the engineers; the ORDER SHAPE was.
  //
  // Per-row orders also make the ledger do the right thing. `wake` marks an agent working the moment it
  // prompts it, so several orders in one tick fan out across whoever is free, and a row already woken
  // for is a `causeKey` already spent -- the same row cannot recruit a second engineer on the next tick.
  for (const row of offerOrder(unclaimed).slice(0, MAX_ROW_ORDERS_PER_TICK)) {
    // NO SESSION NAMED. Which engineer takes it depends on who is idle RIGHT NOW, which only
    // `herdr agent list` knows -- so the order names the lane and `wake.mjs` picks the body.
    // ROUTED BY LANE. Every ready row went to `engineers` regardless of its lane, so a `lane:ceo` row
    // would have been offered to an engineer who may not act on it -- and 18 of the 49 open rows carry
    // that lane. `lane:any` and no lane are the pool, which is what "engineers" means here.
    const owner = laneOwnerOf(row);
    orders.push({
      session: owner ?? "engineers",
      cause: "ready-row-unclaimed",
      subject: `row-${row.number}`,
      // The spawner names the branch and the instance's first message from it (#2405).
      title: row.title ?? "",
      // THE ROW IS THE DISCRIMINATOR NOW, not the queue depth. Keyed on the count, every claim rewrote
      // every remaining order's key and re-woke someone for rows already being offered.
      discriminator: String(row.number),
      prompt: `Ready row #${row.number} is unclaimed${row.title ? `: ${row.title}` : ""}. Claim it with `
        + `\`node packages/agent-org/src/row-claim.mjs claim ${row.number} --session=<you> `
        + `--branch=agent/<slug>-${row.number} --worktree=../wt-${row.number}\` and build it there.\n`
        // BOTH FLAGS OR NEITHER, and the primary refuses the work entirely: `row-claim` creates the
        // worktree from `--branch` AND `--worktree` together and refuses when given only one, and the
        // tooling will not run from the primary checkout at all. The first engineer woken by this
        // system (2026-09-17) stopped and asked a human for both facts, because the order named
        // neither -- so they are named here rather than left to a role brief the session may not have
        // read yet. `../wt-<n>` is the sibling convention every live worktree on the host follows.
        // THE LAUNCH DIRECTORY IS NAMED, AND IT IS NOT THE PRIMARY (#2237) -- BUT NAMED AT DELIVERY, NOT HERE (#2405).
        // This sentence named `/home/agent/repos/role-<you>` for nine days after `launchGate` (#1352) began
        // refusing the primary, and `role-<you>` did not exist for six of the eight engineer addresses; the
        // fallback it offered instead (whichever linked worktree `git worktree list` named) let an engineer BORROW one a peer was working in.
        // The gate cannot know who takes a pool order, and so cannot know whether that address has a
        // worktree, so `wake.mjs` fills `LAUNCH_PLACEHOLDER` in when it knows the recipient (`addressed`).
        + `The claim creates that worktree for you. ${LAUNCH_PLACEHOLDER}\n`
        + "If the claim is refused because someone took it first, that is an answer: stop and say so.",
      causeKey: `${owner ?? "engineers"}/ready-row-unclaimed/${row.number}`,
    });
  }

  return orders;
}

/**
 * A READY ROW WHOSE WORK IS ALREADY ON `origin`, SAID OUT LOUD -- #2031.
 *
 * #2014 bought the interception at CLAIM time: a session that tries to claim such a row is refused and
 * told where the work is. IT SAYS NOTHING TO ANYONE WHO NEVER ATTEMPTS A CLAIM, and this gate -- which is
 * what actually offers rows to the org -- was one of those readers. Measured 2026-09-22 on #2000: the
 * branch was pushed at 21:02:36Z, the row read `ready` with no `session:` label until 21:22Z, and
 * `gh pr list --head <branch> --state all` returned `[]` throughout. The gate offered it as
 * `ready-row-unclaimed` every two minutes, because `ready` with no `session:` label was the entire
 * question it asked.
 *
 * IT NAMES THE BRANCH AND ITS SHA AND CONCLUDES NOTHING ELSE. A branch on `origin` whose name ends in
 * this row's number means the work EXISTS; it cannot tell finished work from abandoned work, and #2031's
 * own "what this will NOT fix" says so rather than leaving it implied. So the prompt sends the reader to
 * the branch with two commands that spend no pool, and names the three exits rather than asserting one.
 *
 * ROUTED TO THE LANE OWNER, ELSE `product-manager`. This is a QUEUE-STATE fact -- a row the board
 * advertises as startable that is not -- and `product-manager` is this org's first reader for rows, the
 * queue and holds (the chairman's 2026-09-14 routing direction). It is deliberately NOT routed to
 * `engineers`: the pool's answer to a row is to CLAIM it, which is the one action #2014 already refuses.
 *
 * A JUDGMENT CAUSE (`JUDGMENT_CAUSES`), because its answer is durable. "This branch is abandoned, leave
 * it" does not change the row, the branch or the sha, so an ACTION cause's twenty-minute expiry would
 * re-offer the identical question until the STUCK cap stopped it -- the cost `lane-backlog-unpromoted`
 * paid on #1564. The key carries the sha, so a PUSH to that branch is a new question and reaches the
 * owner immediately.
 *
 * @param {any[]} readyRows the `ready` rows (`readReadyRows`)
 * @param {{ branch: string, head: string, row: number }[] | null} [rowBranches]
 *        `readRowBranches`'s answer. `null` (the default) is "not asked or refused" and emits NOTHING:
 *        a tick that could not reach `origin` must not invent this condition, and must not report a
 *        false all-clear either -- it simply says nothing new, which is what it did before #2031.
 * @returns {{session: string, cause: string, subject: string, discriminator: string,
 *            prompt: string, causeKey: string}[]}
 */
export function rowBranchOrders(readyRows, rowBranches = null) {
  if (!Array.isArray(rowBranches)) return [];
  const byRow = branchIndex(rowBranches);
  const orders = [];
  // OLDEST FIRST AND CAPPED, `rowOrders`'s shape: a queue that hands out its newest rows first starves
  // its oldest, and the number is a row number, so ascending IS oldest.
  const oldestFirst = [...readyRows].sort((a, b) => Number(a.number) - Number(b.number));
  for (const row of oldestFirst) {
    // UNCLAIMED IS THE POPULATION, and `session:` is the label the done-when names. A claimed row
    // already has a session that knows about its own branch, and `claimed-row-amended` is the cause
    // that speaks to a holder. `CLAIM_LABEL` goes with it because the two are written together by
    // `row-claim.mjs` and a row carrying either is not a fresh start.
    if (sessionOf(row) || labelsOf(row).includes(CLAIM_LABEL)) continue;
    const pushed = byRow.get(Number(row.number)) ?? [];
    if (pushed.length === 0) continue;
    orders.push(unshippedOrder({ row, pushed }));
    if (orders.length >= MAX_ROW_ORDERS_PER_TICK) break;
  }
  return orders;
}

/**
 * The order itself, split out so `rowBranchOrders` stays a walk over rows (the Stepdown Rule, and the
 * same seam `claimedRowAmendedOrders`/`amendedOrder` already use).
 * @param {{ row: any, pushed: { branch: string, head: string }[] }} found
 */
function unshippedOrder({ row, pushed }) {
  const owner = laneOwnerOf(row) ?? "product-manager";
  const key = pushed.map(({ branch, head }) => `${branch}@${head}`).sort().join("+");
  const first = pushed[0].branch;
  return {
    session: owner,
    cause: "row-branch-unshipped",
    subject: `row-${row.number}`,
    discriminator: key,
    prompt: `Row #${row.number} reads \`ready\` and unclaimed, but ${branchesText(pushed)}.\n`
      + "THE BOARD IS SAYING SOMETHING THAT IS NOT TRUE, and until this is settled the gate has STOPPED "
      + `offering #${row.number} as a fresh start -- so nobody will be routed into work that may already `
      + "exist. Measured 2026-09-22 on #2000: its branch sat pushed for 20 minutes while the row read "
      + "`ready`, and a second session was routed into the same three Region paths.\n"
      + "READ THE BRANCH FIRST. Both of these spend NO API pool: "
      + `\`git fetch origin && git log --oneline origin/main..origin/${first}\` and `
      + `\`git diff origin/main...origin/${first}\`.\n`
      + "THEN ONE OF THREE, and this gate deliberately does not guess which: if the work is FINISHED, "
      + "open its pull request (that is the act that makes the row look claimed, and it is what was "
      + "missing); if it is ABANDONED, delete the branch on `origin` and the row goes back on offer "
      + "unchanged; if the trailing number is a COINCIDENCE rather than this row's work, rename or "
      + "delete that branch -- the match is on the name, which is all `ls-remote` can see.\n"
      + "IF IT NEEDS A WAIT INSTEAD, that goes in a FIELD and not a comment: `Not-before: YYYY-MM-DD` in "
      + `the body, \`gh issue edit ${row.number} --add-blocked-by <n>\`, or \`${ANSWER_PREFIX}<session>\`. `
      + "Each clears itself.",
    causeKey: `${owner}/row-branch-unshipped/row-${row.number}/${key}`,
  };
}

/**
 * One order per lane whose owner has backlog and nothing Ready.
 *
 * SPLIT OUT OF `decide` because adding it took that function past
 * `local/max-physical-lines-per-function` 90 and the pre-push gate refused it. The seam is the real
 * one: `decide` asks what the whole queue needs, this asks what each LANE OWNER is sitting on.
 *
 * @param {any[]} promotableRows @param {any[]} readyRows
 */
function laneBacklogOrders(promotableRows, readyRows) {
  const orders = [];
  // OWNERS, NOT LANES. A row reaches its owner by a `lane:` label OR by a routing label, and iterating
  // lanes could only ever find the first -- which is why `orchestrator`, whose work is routed by
  // `fleet-gated` rather than laned, was never told about any of it.
  // THE OWNERS ARE DERIVED FROM THE ROWS, NOT FROM A STATIC LIST. A static
  // `[...LANE_OWNER, ...ROUTED_TO]` was correct until `ownerOf` gained a third source -- an unlaned
  // `decision` routes to `product-manager`, which appears in neither map, so two rows (#1798, #1734)
  // resolved to an owner and then produced no order at all. A list that must be updated whenever
  // `ownerOf` gains a case is a list that will not be.
  /** @type {Set<string | readonly string[]>} */
  const owners = new Set(promotableRows.map((/** @type {any} */ r) => ownerOf(r))
    .filter((/** @type {string | readonly string[] | null} */ o) => o !== null));
  for (const owner of owners) {
    // REFERENCE EQUALITY, DELIBERATELY, for a pool owner: `ROUTED_TO`'s value is one frozen array
    // shared by every row it routes, never rebuilt per row, so grouping and re-filtering by `===` finds
    // every row in the pool exactly as it did when every owner was a string.
    const mine = promotableRows.filter((r) => ownerOf(r) === owner);
    const readyHere = readyRows.filter((r) => ownerOf(r) === owner
      && !labelsOf(r).includes(CLAIM_LABEL));
    if (mine.length === 0 || readyHere.length > 0) continue;
    orders.push(...backlogOrders(owner, mine));
  }
  return orders;
}

/**
 * THE REST OF THIS OWNER'S QUEUE, NAMED IN EVERY ORDER -- because a session gets ONE ORDER PER TICK.
 *
 * `wake.mjs`'s `deliver` marks a session `working` the moment it is prompted, so a second order in the
 * same tick is refused -- "you cannot type two prompts into a live terminal" is correct and is not going
 * to change. Before 2026-09-20 that cost nothing, because this cause emitted ONE order per owner naming
 * up to eight rows: a session got its whole queue in one prompt and could work several in one turn.
 *
 * #1799's fix re-keyed the cause PER ROW so a standing judgment stopped being re-litigated whenever an
 * unrelated row moved. That was right. THE IMPLEMENTATION SERIALISED THE OWNER'S QUEUE: one order per
 * row, one delivered per tick, and each of the others then deduped for the two-hour judgment TTL.
 *
 * MEASURED 2026-09-21, and the chairman is the one who noticed: `orchestrator` spent the day reasoning
 * correctly about #1768's capture window -- a row that cannot move for TWELVE HOURS -- while #1663,
 * #1042, #914 and #1830 sat with nothing stopping them and ten workers idle. Its answers were sound
 * every time; it was never told the others existed in the same breath.
 *
 * SO THE KEY STAYS PER ROW AND THE PROMPT CARRIES THE SET. Both properties, neither traded: the ledger
 * still dedupes one row's judgment without touching another's, and one turn can still clear several.
 *
 * @param {any[]} mine @param {any} current
 */
function alsoOwned(mine, current) {
  const others = mine.filter((/** @type {any} */ r) => r.number !== current.number);
  if (others.length === 0) return "";
  const named = others.slice(0, MAX_ROW_ORDERS_PER_TICK)
    .map((/** @type {any} */ r) => `#${r.number}`).join(", ");
  return `YOU ALSO OWN ${others.length} OTHER ACTIONABLE ROW(S): ${named}`
    + `${others.length > MAX_ROW_ORDERS_PER_TICK ? ", ..." : ""}.\n`
    + `IF #${current.number} CANNOT MOVE RIGHT NOW -- it waits on a clock, a capture window, or a `
    + "decision you do not own -- DO NOT END YOUR TURN THERE. Record why on it, then take the next row "
    + "on that list and work that instead. YOU GET ONE ORDER PER TICK, so the others are not coming in a "
    + "minute: each is deduped for two hours once offered, and the fleet or the queue sits idle "
    + "meanwhile. Working several of them in one turn is the intended use, not an overreach.";
}

/**
 * The orders a lane owner's backlog deserves -- ONE PER ROW, keyed on the row.
 *
 * KEYED PER ROW BECAUSE A STANDING JUDGMENT IS ABOUT A ROW, NOT ABOUT A COUNT. This used to emit one
 * order keyed `.../<count>`, and #1799 showed why that is wrong for `epic-unfiled`: the count conflates
 * *did the population I still need to judge change* with *did something unrelated get filed*. Every time
 * ANY row entered or left the lane the count moved, the causeKey changed, and `JUDGMENT_TTL_MS` could no
 * longer protect the rows whose answer had not changed. #1806 fixed `epic-unfiled` that way; this is the
 * same fix, applied to the cause the SAME LEDGER shows the SAME defect in.
 *
 * MEASURED 2026-09-20 on the live ledger -- twelve deliveries to `orchestrator` over 10.4 hours:
 *
 *   /3 /3 /2 /2 /3 /4 /7 /6 /5 /3 /3 /3
 *
 * SEVEN OF THE TWELVE fired INSIDE the two-hour TTL, at gaps of 4, 18, 4, 22, 27, 10 and 57 minutes --
 * each one a `sonnet`/`high` turn re-asking about rows already judged. The five that behaved are the
 * ones where the count happened not to move.
 *
 * THE PROMPT IMPROVES BY THE SAME CHANGE. "You own 7 rows, promote what is ready" is a survey; "#1663 is
 * in your lane and nothing is Ready" is a question with an answer, which is what this file's own header
 * asks of every prompt.
 *
 * A POOL OWNER GETS ONE ORDER PER NAME, NOT ONE ORDER FOR THE PAIR -- #1828. `wake.mjs` routes one order
 * to one session, so a single order naming both `orchestrator` and `worker-capture` would reach neither
 * reliably; the row must recruit whichever of the two is free, exactly as an unlaned Ready row already
 * does for the engineer pool.
 *
 * @param {string | readonly string[]} owner @param {any[]} mine
 */
function backlogOrders(owner, mine) {
  const names = Array.isArray(owner) ? owner : [/** @type {string} */ (owner)];
  return names.flatMap((name) => mine.slice(0, MAX_ROW_ORDERS_PER_TICK).map((/** @type {any} */ r) => ({
    session: name,
    cause: "lane-backlog-unpromoted",
    subject: `row-${r.number}`,
    discriminator: String(r.number),
    prompt: `#${r.number} is an open backlog row you own and there is NOTHING Ready among your rows.`
      + (laneOwnerOf(r) === name
        ? " It carries your lane: nobody else may promote it."
        : " It carries `fleet-gated`, which ROUTES rather than blocks -- the acceptance needs the fleet"
          + " or the lab, which you run. Check the fleet is up (`npm run fleet:status`) first; this row"
          + " is not waiting on hardware being broken.")
      + "\nPromote it if it is genuinely ready (a Region, an Acceptance, a done-when), answer it if it "
      + "waits on a decision, or say on the row why it should stay put -- leaving it and recording why "
      + "is a valid answer.\n"
      + "READ ITS OWN RECENT COMMENTS FIRST: a durable reason recorded there stands until something "
      + "about THIS row changes, not until an unrelated row moves (#1799).\n"
      + "RECORD THE ANSWER ON THE ROW, whatever it is. A decision that exists only in your terminal is "
      + "one the org cannot see: the next reader finds an untouched row and re-derives it from scratch.\n"
      + alsoOwned(mine, r),
    causeKey: `${name}/lane-backlog-unpromoted/row-${r.number}`,
  })));
}

/**
 * The one order for work only the chairman can do, or none.
 *
 * SPLIT OUT OF `decide` because it took that function past 90 physical lines and the pre-push gate
 * refused it -- the fourth such split, and the seam is the same each time: `decide` asks what the
 * queue needs, each helper asks one narrower question.
 *
 * @param {any[]} chairmanBlocked rows waiting on the chairman, oldest first
 */
function chairmanOrders(chairmanBlocked) {
  // THE ORG CANNOT WAKE A HUMAN, so this wakes the session whose brief says it briefs one. `ceo` is the
  // only onward route the escalation path has, and until now that route was a sentence rather than a
  // mechanism -- #63 sat four days blocking eight publish-gated rows because nothing carried it.
  //
  // THE DISCRIMINATOR IS THE AGE IN DAYS, which is what makes this bearable. Keyed on the row set it
  // would fire once and fall silent for ever -- the permanent-ledger bug again. Keyed on the age, `ceo`
  // is reminded once a DAY and the reminder grows, which is the right cadence for a question only a
  // person outside the org can answer and the wrong one to repeat every twenty minutes.
  if (chairmanBlocked.length === 0) return [];
  const oldest = daysSince(chairmanBlocked[0]?.updatedAt);
  const rows = chairmanBlocked.slice(0, 6).map((/** @type {any} */ r) => `#${r.number}`).join(", ");
  return [{
    session: "ceo",
    cause: "chairman-blocked",
    subject: "chairman",
    discriminator: String(oldest),
    prompt: `${chairmanBlocked.length} row(s) are labelled \`${CHAIRMAN_LABEL}\` and can only move by the `
      + `chairman's own hands: ${rows}${chairmanBlocked.length > 6 ? ", ..." : ""}. The quietest has had `
      + `NO ACTIVITY OF ANY KIND for ${oldest} day(s) -- not time spent waiting, which is longer: any `
      + "comment or label resets this, so read the row for when the chairman was last actually asked.\n"
      + "Brief the chairman: what is waiting, what it blocks downstream, and the single next action in "
      + "their hands. If a row no longer needs them, take the label off -- a stale one here makes the "
      + "count meaningless, which is how the last escalation went four days unread.",
    causeKey: `ceo/chairman-blocked/${oldest}`,
  }];
}

/**
 * The order asking `product-manager` to stock an empty POOL shelf, or `null` when it is not empty.
 *
 * SPLIT OUT OF `decide` when B4 shelving landed. The prompt now has to say WHICH of two things emptied
 * the shelf, and `decide` was already at `local/max-physical-lines-per-function` 90.
 *
 * IT NAMES THE BLOCKED ROWS RATHER THAN HIDING THEM, and that is not decoration. Shelving a B4-blocked
 * row means nobody is woken for it -- which is how a queue starves in silence, the same shape this order
 * already exists to catch one level up. And a blocked row is NOT one to promote past: it is waiting on a
 * pull request, so promoting another row over the same files just moves the refusal. The counts are
 * reported; which rows are genuinely promotable stays a judgment, for the reason below.
 *
 * THE SHELF ITSELF IS WORK, and nothing asked about it until 2026-09-17. Measured that day: 92 open
 * issues, 87 of them `backlog`, ZERO `ready`, and five engineers idle. The gate's engineer question is
 * "a `ready` row without `in-progress`", which was honestly no -- so it reported a quiet org while every
 * engineer waited behind an empty queue. `dispatcher` is retired and its brief's line survives it:
 * "the Ready column. It pulls; THIS ROLE STOCKS." The stocker had no trigger.
 *
 * FACTS, NOT A TARGET, and that distinction is the whole design. `product-manager`'s brief says Ready
 * holds at least three product rows; this does not ask for three. `ready:audit` exists because
 * `dispatcher` once labelled two rows `ready` TO HIT THAT FLOOR -- one disputed, one with no Region or
 * Acceptance -- and recorded the rule this obeys: *"a floor met by a label I control is not a
 * measurement."* A number here would buy relabelling. The order reports what is on the shelf and what
 * is behind it; which rows are genuinely promotable is a judgment and stays with the reader.
 *
 * ONLY WHEN THE SHELF IS EMPTY. A queue with anything in it is a queue the engineers can pull from, and
 * re-prompting on a short-but-non-empty Ready would be the floor by another name.
 * THE POOL'S SHELF, NOT THE WHOLE SHELF, and that distinction had three engineers idle. This counted
 * every unclaimed Ready row, so 14 rows Ready read as a well-stocked queue -- while 11 of them were
 * `lane:ceo` and 3 `lane:orchestrator` and NOT ONE was takeable by an engineer. Measured 2026-09-18,
 * minutes after lane routing shipped: ceo and orchestrator woke, promoted their own lanes, and went to
 * work, and the pool stayed starved because the shelf now looked full.
 *
 * It is the original empty-shelf defect one level down: a queue full of work nobody in that pool may
 * take is an EMPTY QUEUE TO THEM. `laneOwnerOf` already says who a row belongs to; a row with an owner
 * is somebody's, and the lane orders above are what ask them about it.
 *
 * AND B4-BLOCKED IS THE THIRD READING OF THAT SAME SHAPE (2026-09-18). A row an engineer may take but
 * cannot CLAIM is as empty to them as one that belongs to somebody else -- measured the same day the
 * lane reading above was, on the same three rows. The lane was never the whole answer there: #1452,
 * #1397 and #1320 all declare `.github/workflows/release.yml` and all sat behind draft #1695, so
 * re-laning them to `lane:any` would have handed an engineer the identical refusal.
 *
 * @param {{ offerable: any[], blocked: { number: number, owner: string | null, reason: string }[],
 *           promotable: number }} state
 */
function emptyShelfOrder({ offerable, blocked, promotable }) {
  const pool = offerable.filter((r) => laneOwnerOf(r) === null);
  if (pool.length > 0 || promotable === 0) return null;
  const poolBlocked = blocked.filter((b) => b.owner === null);
  const laned = offerable.length - pool.length;
  const why = [
    laned > 0 ? `${laned} unclaimed row(s) belong to a lane` : "",
    poolBlocked.length > 0
      ? `${poolBlocked.length} unlaned row(s) blocked (`
        + poolBlocked.map((b) => `#${b.number}: ${b.reason}`).join("; ")
        + ")"
      : "",
  ].filter(Boolean).join(", and ");
  return {
    session: "product-manager",
    cause: "ready-queue-empty",
    subject: "ready-queue",
    // THE COUNT IS THE DISCRIMINATOR, so the order stops repeating the moment a row is promoted and
    // re-fires if the shelf empties again at a different depth. Keyed on anything constant it would
    // nag every two minutes until someone acted, which is how a wake becomes noise to route around.
    discriminator: String(promotable),
    prompt: `The Ready queue has NOTHING an engineer may take${why ? ` -- ${why}` : ""} -- and `
      + `${promotable} unlaned backlog row(s) carry no label that means unpickable (not blocked, `
      + "fleet-gated, epic, disputed, decision, awaiting-merge, review-only or already claimed). Every "
      + "engineer is waiting on this queue rather than on work.\n"
      + (poolBlocked.length > 0
        // EACH ROW NAMES ITS OWN REASON ABOVE -- a B4 pull-request overlap and a declared `blockedBy`/
        // `Not-before:` wait clear by entirely different mechanisms (#1885), so this can promise only
        // what is true of every blocked row: promoting past it does not remove what is actually stopping it.
        ? "The blocked rows above are NOT rows to promote past: each names its own reason, and the work "
          + "that frees it belongs to whatever that reason names -- a pull request, a blocking issue, a "
          + "date -- not necessarily a pull request. Promoting a row whose Region overlaps another open "
          + "PR only moves that particular refusal.\n"
        : "")
      + "ASK OF EACH ROW: IS IT STILL TRUE? -- before asking whether it is promotable. A row can fail "
      + "every promotion test and still be FINISHED, and nothing else in this org checks. Measured "
      + "2026-09-21: this cause's own audit examined #1731 carefully, concluded correctly that it had "
      + "no Region, no Acceptance and no done-when, and declined to promote it -- while the defect it "
      + "describes had been fixed 17 HOURS EARLIER by #1764, with 30 sweep runs since and zero "
      + "failures. It was the only row between the queue and empty, and it was already done.\n"
      + "Promote what is genuinely ready -- a row with a Region, an Acceptance and a done-when -- and "
      + "leave the rest. This is deliberately NOT a request to reach a count: #ready:audit records "
      + "`dispatcher` labelling two rows ready to hit a floor, one disputed and one with neither field, "
      + "and a floor met by a label you control is not a measurement. Promoting nothing and saying why "
      + "is a valid answer.\n"
      + "RECORD WHAT YOU FOUND, ON THE ROWS YOU EXAMINED. An audit whose conclusion exists only in your "
      + "terminal is one the next audit must derive again from scratch -- and this one did: the 07:19Z "
      + "sweep reached a complete, well-argued verdict on #1731 and left no trace on it, so the same "
      + "reasoning was due to be repeated every two hours indefinitely.",
    causeKey: `product-manager/ready-queue-empty/${promotable}`,
  };
}

/**
 * How many open rows COULD move, and what is stopping the rest -- derived from the rows THE TICK ALREADY
 * HAS, never asked for again.
 *
 * FREE, AND THAT IS #1938. This used to be `readOpenRowState`, a second `gh issue list --state open
 * --limit 500` asking for `number,body,blockedBy` -- a strict subset of the fields `readOpenRows` had
 * already fetched over the identical population, in the same process, earlier in the same tick. It was
 * conditional, so it was cheap, but the cheapest read is the one already in hand.
 *
 * `null` IN, `null` OUT, AND THAT IS THE POINT. A REFUSED read is not an empty tracker (#1286): the
 * caller passes the UN-COALESCED `readOpenRows()` result, and a refusal stays `null` the whole way into
 * `stalledOrder`. Deriving this from `main`'s `readOpenRows() ?? []` instead would read a `gh` outage as
 * a healthy silent org and silence the dead man's switch on exactly the tick it matters most.
 *
 * IT RETURNS THE BREAKDOWN AS WELL AS THE COUNT, and that is the whole of #1935: this has always called
 * `waitingOn` on every open row and then thrown the answer away, keeping only `.length`. The condition --
 * date or row, WHICH date, WHICH row -- was computed and discarded at the same expression, and `ceo` then
 * spent an hour hand-reading twenty rows to recover it.
 *
 * @param {any[] | null | undefined} rows the un-coalesced `readOpenRows` result
 * @param {string} [today] an ISO `YYYY-MM-DD`
 * @returns {{reachable: number, waiting: ReturnType<typeof waitingBreakdown>} | null} `null` when the
 *   read was refused -- never a zero count, which would read as "the tracker is empty"
 */
export function openRowState(rows, today = todayIso()) {
  if (!Array.isArray(rows)) return null;
  // ROWS THAT ARE CORRECTLY WAITING ARE NOT A STALL, and counting them as one would be this switch
  // crying wolf -- the exact failure its own comment says matters more than the missing-switch one.
  // A queue where every row declares what it waits on is WORKING; the switch must fire on rows that
  // COULD move and are not moving.
  return { reachable: rows.filter((r) => waitingOn(r, today) === null).length,
    waiting: waitingBreakdown(rows, today) };
}

/**
 * The open rows that ARE waiting, grouped by what they wait on.
 *
 * GROUPED BY DATE RATHER THAN LISTED PER ROW, because the aggregate is the fact nobody could see. Every
 * one of the four rows parked to 2026-09-23 on 2026-09-22 was individually correct and recorded its
 * reasoning on its own row; what no reader had was "the pool's promotable stock went to zero at 11:45Z
 * and four sessions idled for seven hours". A per-row list says it in twelve lines and buries the date
 * the org un-stalls by itself.
 *
 * DATES SORT LEXICALLY, which is why `Not-before:` is ISO-only, so `[0]` is the earliest with no
 * comparator and no `Date` parsing.
 *
 * A THIRD GROUP, AND IT NEEDED AN EXPLICIT BRANCH RATHER THAN AN `else` (#2005). The two-kind version
 * read `kind === "date"` and treated EVERYTHING ELSE as a row-blocker, so the moment `waitingOn` gained
 * a third kind it would have pushed `{ number, on: undefined }` and reported an answer-waiting row as
 * "blocked by " with nothing after it -- a wrong fact, in the one report built to stop `ceo` hand-reading
 * twenty rows. An `else` over a closed set of two is a correct expression that becomes a false one
 * silently; the set is now matched by name and the `date` branch is no longer the discriminator.
 *
 * ANSWERS ARE GROUPED BY SESSION for the same reason dates are grouped by date: "3 rows are waiting on
 * `ceo`" is the fact a reader acts on, and three separate lines naming `ceo` is that fact spelled so it
 * has to be re-derived.
 *
 * @param {any[]} rows @param {string} today an ISO `YYYY-MM-DD`
 * @returns {{dates: {date: string, numbers: number[]}[], blocked: {number: number, on: number[]}[],
 *   answers: {session: string, numbers: number[]}[], total: number}}
 */
export function waitingBreakdown(rows, today = todayIso()) {
  const byDate = new Map();
  const bySession = new Map();
  const blocked = [];
  for (const row of rows ?? []) {
    const waiting = waitingOn(row, today);
    if (waiting === null) continue;
    if (waiting.kind === "date") byDate.set(waiting.date, [...(byDate.get(waiting.date) ?? []), Number(row.number)]);
    else if (waiting.kind === "answer") {
      bySession.set(waiting.session, [...(bySession.get(waiting.session) ?? []), Number(row.number)]);
    } else blocked.push({ number: Number(row.number), on: waiting.numbers });
  }
  const dates = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([date, numbers]) => ({ date, numbers }));
  const answers = [...bySession.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([session, numbers]) => ({ session, numbers }));
  return { dates, blocked, answers,
    total: dates.reduce((n, d) => n + d.numbers.length, 0) + blocked.length
      + answers.reduce((n, a) => n + a.numbers.length, 0) };
}

/**
 * At most this many row numbers are spelled out per group; the rest are counted.
 *
 * A PROMPT IS READ BY A SESSION WITH A CONTEXT BUDGET. Five hundred open rows could all be waiting, and a
 * paragraph naming every one of them is a page nobody finishes reading -- the same failure as a switch
 * that pages until it is ignored. The counts stay exact either way; only the enumeration is capped.
 */
const WAITING_ROWS_NAMED = 12;

/** `#1 #2 #3 +4 more` -- exact count, capped enumeration. @param {number[]} numbers */
function nameRows(numbers) {
  const shown = numbers.slice(0, WAITING_ROWS_NAMED).map((n) => `#${n}`).join(" ");
  const rest = numbers.length - WAITING_ROWS_NAMED;
  return rest > 0 ? `${shown} +${rest} more` : shown;
}

/**
 * The waiting conditions, as a paragraph, or `""` when no row carries one.
 *
 * `describeWaiting` RATHER THAN A SECOND COPY OF THE WORDING. `waiting-condition.mjs` is the one reader
 * of "this row is waiting on something" and it already owns how a wait is said out loud -- re-typing
 * "not before <date>" here is exactly the second-copy-of-a-predicate shape that module's own header
 * refuses.
 *
 * EMPTY IS A REAL ANSWER AND MUST STAY ONE. A stall where nothing declares a wait is the original
 * defect -- every row stopped by a label, a lane or a claim -- and the existing wording below is what
 * says so. This returns "" for that state rather than a paragraph saying "0 rows are waiting", so the
 * unexplained stall reads exactly as it did before #1935.
 *
 * @param {ReturnType<typeof waitingBreakdown> | null | undefined} waiting
 * @param {number} reachable the rows that could move, which is what `openRows` counts
 */
function waitingParagraph(waiting, reachable) {
  if (!waiting || waiting.total === 0) return "";
  const lines = [`SEPARATELY, AND NOT IN THAT ${reachable}: ${waiting.total} of the `
    + `${reachable + waiting.total} open row(s) carry a machine-readable waiting condition, which this `
    + "gate read on this tick. They are filtered out of the count above because they genuinely are not "
    + "startable -- but they are why the pool is empty, and nothing has ever said so.\n"];
  if (waiting.dates.length > 0) {
    lines.push(`  ${waiting.dates.reduce((n, d) => n + d.numbers.length, 0)} on a date: `
      + `${waiting.dates.map((d) => `${d.numbers.length} ${describeWaiting({ kind: "date", date: d.date })} `
        + `(${nameRows(d.numbers)})`).join("; ")}. THE EARLIEST IS ${waiting.dates[0].date}.\n`);
  }
  if (waiting.blocked.length > 0) {
    lines.push(`  ${waiting.blocked.length} on another row: ${waiting.blocked
      .slice(0, WAITING_ROWS_NAMED)
      .map((b) => `#${b.number} ${describeWaiting({ kind: "row", numbers: b.on })}`).join("; ")}`
      + `${waiting.blocked.length > WAITING_ROWS_NAMED ? ` +${waiting.blocked.length - WAITING_ROWS_NAMED} more` : ""}.\n`);
  }
  // THIS GROUP IS THE ONE A READER CAN CLEAR IN THE SAME TURN, and that is why it names the session
  // rather than counting. A date cannot be hurried and a blocking row is someone else's work; a question
  // owed is a session that can be asked now -- so of the three groups this is the one whose line turns
  // into an action, and burying it in "12 rows are waiting" is what made #2005 invisible for three days.
  if (waiting.answers.length > 0) {
    lines.push(`  ${waiting.answers.reduce((n, a) => n + a.numbers.length, 0)} on a session's answer: `
      + `${waiting.answers.map((a) => `${a.numbers.length} `
        + `${describeWaiting({ kind: "answer", session: a.session })} (${nameRows(a.numbers)})`).join("; ")}`
      + ". THAT SESSION REMOVING THE LABEL IS THE ACT OF ANSWERING, and it is the only thing that "
      + "releases these rows.\n");
  }
  // THE SELF-CLEARING PROPERTY IS WEAKER THAN IT READS, and this is the line that stops the reader
  // filing the whole paragraph under "fine, it clears tomorrow". A date-parked row can be waiting on
  // something that cannot happen WHILE it is parked: #1931 was `Not-before: 2026-09-23` with a done-when
  // of "the next merged PR carrying a `convinced` verdict", and no PR could merge because no row was
  // claimable -- so #1756, blocked by #1931, could not move either side of the date.
  lines.push("\"The org is waiting until <date>\" is a SCHEDULE and a valid answer -- say it and stop, "
    + "rather than reading twenty rows to re-derive it. But check the earliest date actually clears "
    + "something: a date-parked row whose done-when needs a merge cannot close while nothing is "
    + "claimable, so a stall can sustain itself across a date boundary.\n");
  return lines.join("");
}

/**
 * THE CAUSE THAT FIRES ON THE ABSENCE OF CAUSES -- a dead man's switch for the org.
 *
 * EVERY OTHER CAUSE FIRES ON A POSITIVE STATE: a draft exists, a row is unclaimed, a check is red. None
 * can fire on NOTHING HAPPENING, and nothing happening is the failure mode this org actually has. The
 * gate exits QUIET when no known cause matched, and that one exit covers two different worlds -- "there
 * is genuinely nothing to do" and "there is plenty to do and no cause can see it". Indistinguishable, so
 * the ABSENCE OF A SIGNAL was reported as health.
 *
 * MEASURED REPEATEDLY OVER 48 HOURS: a worker unable to capture for 4.9 days; #63's step 9 unstarted for
 * 18 hours with the publish blocked behind it; ten rows gated on a condition that had become true;
 * twenty-four rows waiting on a fleet healthy for two hours; a session stopped behind a menu. In every
 * case the gate was honestly QUIET, every session honestly idle, and the only thing that noticed was a
 * human reading a terminal. #928's own title records the shape from before this file existed: "main's
 * trunk-guard red for 27.8 hours unattended -- both sets of eyes were retired the same day."
 *
 * THE DISCRIMINATOR IS THE COUNT, so a stall of the same shape is one question and a tracker that moved
 * is a new one. As a JUDGMENT cause it holds for two hours rather than re-asking every twenty minutes:
 * the canonical write-up of this pattern is titled "A Dead-Man's Switch That Pages Once and Goes Quiet Is
 * Worse Than None", and the opposite failure is one that pages until nobody reads it.
 *
 * WHY `ceo` AND NOT `product-manager`: this is not a queue question. `product-manager` already answers
 * "is anything promotable" through `ready-queue-empty`, and has answered it correctly every time. This
 * asks "the org has open work and no way to reach any of it" -- a management question, and #912 deleted
 * the standing crons that made it somebody's job without replacing that half.
 *
 * WHAT IT NOW HANDS OVER, AND WHY THAT IS THE WHOLE ROW (#1935). Its prompt used to enumerate the things
 * that stop a row as "`blocked`, `fleet-gated`, `epic`, a lane, a claim" and never mention `Not-before:`
 * or `blockedBy` -- THE TWO FORMS THE 2026-09-19 CHAIRMAN DIRECTION MADE THE PREFERRED ONES over
 * `blocked`. So the one cause built to answer "the org has open work and no way to reach any of it"
 * could not name the most common modern reason a row is unreachable. Measured on the 2026-09-22T18:30Z
 * wake that found this: 12 of 20 open backlog rows carried one, four of them clearing the next day, and
 * `ceo` spent an hour hand-reading rows the gate had already read that same tick.
 *
 * THE DISCRIMINATOR STAYS THE REACHABLE COUNT, deliberately. A date clearing MOVES a row from waiting to
 * reachable, so the count changes, so the causeKey changes and the dedupe stops matching -- the existing
 * key already re-fires on exactly the event that matters, and folding the breakdown into it would page
 * again whenever any blocker anywhere changed shape without the org becoming any more reachable.
 *
 * @param {{ orders: unknown[], openRows: number | null,
 *           waiting?: ReturnType<typeof waitingBreakdown> | null }} state
 */
export function stalledOrder({ orders, openRows, waiting = null }) {
  // ONLY WHEN NOTHING ELSE FIRED. One order anywhere means some cause can still reach the org.
  if (orders.length > 0) return null;
  // A REFUSED READ IS NOT AN EMPTY TRACKER (#1286), and an empty one is not a stall: an org with no open
  // rows has finished, which is the one silence that is genuinely healthy.
  if (openRows === null || openRows === 0) return null;
  return {
    session: "ceo",
    cause: "org-stalled",
    subject: "org",
    discriminator: String(openRows),
    prompt: `NOTHING IS REACHABLE. The work gate found no cause of any kind this tick and ${openRows} `
      + "row(s) are open and could move, so every session is idle and will stay idle: no draft needs a "
      + "verdict, no row is claimable, no check is red, nothing is promotable.\n"
      + "That is NOT the org being finished. It means every one of those rows carries something that "
      + "stops it -- `blocked`, `fleet-gated`, `epic`, a lane, a claim -- and no cause can see past it.\n"
      + waitingParagraph(waiting, openRows)
      + "READ THE BACKLOG AND SAY WHY, then act. Shapes measured here in the last two days: a gate whose "
      + "condition became TRUE and nobody lifted the label; a row waiting on a capability that has since "
      + "recovered; a runbook step that exists only as prose, so no cause can name it; a session stopped "
      + "on a question, which `herdr --session org agent list` shows as `blocked` and which no wake will "
      + "ever reach.\n"
      + "You are the only session asked this. Every minute the org is stalled is capacity nobody is "
      + "using, and until now the only thing that noticed was the chairman reading a terminal.",
    causeKey: `ceo/org-stalled/${openRows}`,
  };
}

/**
 * Do the work the gate is allowed to do itself, and return only what still needs a session.
 *
 * THE RELAY TURN THIS REMOVES, MEASURED ON MERGED PULL REQUESTS. #1730 and #1748 both carried a
 * `convinced` verdict from a reviewer, and on both a session then woke, read the verdict the gate had
 * ALREADY PARSED, ran one `gh pr ready`, and wrote a comment restating it: *"Marked ready by
 * product-manager. reviewer-2's verdict at f47c2ee6 says convinced"*. Across the last 25 merged PRs the
 * median open-to-merge was SIX MINUTES, so this was never a queue problem -- it was a model turn spent
 * relaying a machine-readable fact between two machines.
 *
 * AND THE ROLE DOC ALREADY SAID SO. `packages/agent-org/docs/roles/reviewer.md` line 129: "a provisional
 * `convinced` IS the verdict: **the author marks ready on it**". `product-manager` was never supposed to
 * be in this path; the gate put them there by having no way to act, only to wake.
 *
 * FAILURE FALLS BACK RATHER THAN DISAPPEARING. A refused or errored `gh` call re-delivers the original
 * order, so the worst case is exactly today's behaviour and a line on stderr saying why. An action that
 * silently swallowed its failure would turn a visible wake into an invisible nothing, which is the
 * direction this repository has paid for before.
 *
 * A DRAIN DOES NOT WITHHOLD IT, and that is not an oversight: `draft-convinced-not-ready` is not in
 * `START_CAUSES` because marking a reviewed draft ready FINISHES work in flight rather than starting
 * any. A drain wants exactly this to happen.
 *
 * @param {any[]} orders @param {(args: string[]) => string} run @param {(line: string) => void} log
 * @returns {{ delivered: any[], performed: number }}
 */
export function performActions(orders, run = defaultRun, log = (line) => process.stderr.write(line)) {
  const delivered = [];
  let performed = 0;
  for (const order of orders) {
    const { action, ...rest } = order;
    if (!action) { delivered.push(order); continue; }
    try {
      run(["pr", "ready", String(action.pr)]);
      performed += 1;
      log(`DID ${action.kind} pr-${action.pr} (${order.cause}) -- no session woken\n`);
    } catch (/** @type {any} */ error) {
      log(`COULD NOT ${action.kind} pr-${action.pr}: ${error?.message ?? error} `
        + `-- delivering to ${rest.session} instead\n`);
      delivered.push(rest);
    }
  }
  return { delivered, performed };
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
 * @param {{ prs: any[], readyRows: any[], promotableRows?: any[], chairmanBlocked?: any[],
 *           prFiles?: { number: number, files: string[], changedFiles: number }[],
 *           drain?: boolean, required?: string[] | null, epics?: any[], answerOwed?: any[],
 *           openRows?: any[], unarmed?: number[] | null,
 *           claimedComments?: {number?: number, comments?: {body?: string, id?: string}[]}[],
 *           rowBranches?: {branch: string, head: string, row: number}[] | null,
 *           hostDrift?: {unit: string, problem: string, detail: string}[] | null,
 *           closings?: Map<number, number> | null, trunkRed?: ReturnType<typeof readTrunkRed>,
 *           baseTip?: {sha: string, date: string} | null,
 *           claimStalls?: import("./claim-stall.mjs").StallOrder[] }} state
 *        `claimStalls` is `claimStallTick`'s orders (#2470): a nudge to a holder whose claim has not moved, or a release
 *        `wake.mjs` performs. OMITTED MEANS NONE.
 *        `required` is the checks that can block a merge (`requiredCheckNames`), or `null` for
 *        "could not be read", which counts EVERY check as before this existed.
 *        `epics` are the open `epic` rows with their `subIssuesSummary` (`readEpics`); `[]` when
 *        refused or when the shelf was not empty enough to ask.
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
 *        `hostDrift` is `readHostDrift()` -- `host-units.mjs --json`'s findings, or `null`. OMITTED
 *        AND `null` MEAN THE SAME THING, "not asked or refused": no order is emitted, so a caller
 *        that cannot reach the host behaves exactly as it did before #2174. It carries no `= null`
 *        default for `rowBranches`'s reason -- a default parameter is a branch `complexity` counts,
 *        and `decide` sits exactly on its limit of 15.
 *        It spends NO API pool: see `readHostDrift`.
 *        `trunkRed` is `readTrunkRed()` -- the facts about a red `main`, or `null` when it is green or the
 *        read was refused. OMITTED AND `null` MEAN THE SAME THING and it carries no `= null` default, for
 *        `rowBranches`'s reason: `decide` sits exactly on its limit of 15.
 *        `baseTip` is `readBaseTip()` -- `main`'s tip commit, read only on a red tick (#2117). It carries no
 *        `= null` default for `rowBranches`'s reason, and OMITTED AND `null` MEAN THE SAME THING: the
 *        `pr-checks-failing` prompt says whether `main` moved is UNKNOWN. IT CHANGES ONLY THOSE WORDS.
 *        `unarmed` is `readUnarmed(shouldBeMerging(prs, required))` -- the green, unheld pull requests
 *        the API says nothing has armed. It DEFAULTS TO `null`, which is "not asked or refused" and
 *        emits no order: a caller that cannot make that read must never produce a false all-clear, and
 *        must never produce a false alarm either.
 * @returns {{session: string, cause: string, subject: string, discriminator: string,
 *            prompt: string, causeKey: string}[]}
 */
export function decide({ prs, readyRows, promotableRows = [], chairmanBlocked = [], prFiles = [],
  drain = false, required = null, epics = [], answerOwed = [], openRows = [], unarmed = null,
  claimedComments = [], rowBranches, hostDrift, closings, trunkRed, baseTip, claimStalls }) {
  // FIRST, BEFORE EVERY OTHER CAUSE (#2356): a red `main` outranks even `answer-owed` -- see `trunkRedOrders`.
  // `answer-owed` says another session is ALREADY STOPPED waiting on them, which outranks any standing question.
  const orders = [...trunkRedOrders(trunkRed), ...answerOrders(answerOwed)];
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
  orders.push(...blockerClearedOrders(openRows, todayIso(), Date.now(), prs));
  // #2470: A CLAIM THAT DOES NOT MOVE -- it addresses the session that holds a row, so it outranks every cause offering NEW work.
  orders.push(...stallOrdersOrNone(claimStalls));

  orders.push(...perPullRequestOrders(prs, required, baseTip));
  // #2031: AHEAD OF THE OFFER, AND IT IS THE SAME READING THAT WITHHELD IT. `partitionUnclaimed` shelves
  // the row on `rowBranches` and this emits the cause that names the branch -- one condition, one read,
  // said once as a withholding and once as a question. Ahead of `rowOrders` for the ordering reason the
  // causes above use: work that already EXISTS outranks work nobody has started.
  const { offerable, blocked } = partitionUnclaimed(readyRows, prFiles, { rowBranches, openRows });
  orders.push(...rowBranchOrders(readyRows, rowBranches));
  orders.push(...rowOrders(offerable));

  // #2139: AHEAD OF BOTH BACKLOG SURVEYS AND BEHIND EVERY OFFER, because it is neither. It names ONE row
  // and the exact set that cleared, which outranks `ready-queue-empty` and `lane-backlog-unpromoted`
  // asking somebody to go and LOOK at a backlog -- and it is deliberately not gated on the shelf being
  // empty, which is what kept both of those silent while six rows sat runnable for up to 16h09m behind a
  // four-row Ready queue. It sits behind `rowOrders` for the ordering the causes above use: a row already
  // on the shelf can be claimed this minute, while this one still needs promoting first.
  // #2286: `closings` LETS IT BACK OFF. Absent, it asks at the unstaged key on every TTL, as before.
  orders.push(...unclaimedBlockerClearedOrders(openRows, undefined, { closings }));

  // The backlog is counted the same way, or the order would report rows the pool equally cannot take.
  // `ownerOf`, not `laneOwnerOf`: routed rows reach `decide` now, and the POOL's count must be exactly
  // what it was -- an engineer offered a `fleet-gated` row would be queueing for a worker box.
  const poolPromotable = promotableRows.filter((r) => ownerOf(r) === null);
  const shelf = emptyShelfOrder({ offerable, blocked, promotable: poolPromotable.length });
  if (shelf) orders.push(shelf);

  orders.push(...laneBacklogOrders(promotableRows, readyRows));


  // AFTER the lane orders and BEFORE the chairman's: an unfiled epic is a supply problem, which only
  // matters once the queue and the lanes have nothing left to offer.
  orders.push(...epicOrders(epics, readyRows));
  // AFTER the unfiled epics. An epic with NO children is work nobody has filed at all; one whose children
  // are all closed may only need closing. The more likely supply of real work goes first.
  orders.push(...finishedEpicOrders(epics, readyRows));
  orders.push(...blockedReferentOrders(openRows, readyRows));
  // THE BATCH THAT USED TO BE A 01:00 TIMER. Placed here rather than first: a named row to fix
  // outranks a standing sweep, and `orchestrator` gets one order per tick either way.
  orders.push(...fleetBatchOrders(openRows));

  // #1969: AFTER the per-PR and per-row causes and BEFORE the chairman's. A green unarmed PR is finished
  // work that cannot land -- more urgent than a supply question, less urgent than a named red build,
  // and never withheld by a drain: a window stops the org TAKING ON work, not finishing what is in flight.
  orders.push(...greenUnarmedOrders(unarmed));

  // #2084: BESIDE `pr-green-unarmed` AND FOR ITS REASON, ONE SURFACE OVER. Both name finished work that
  // cannot land; that one is about the ARMING not having happened and this one about GitHub refusing to
  // complete it. Same population (`mergeCandidates`), same audience, same placement -- more urgent than a
  // supply question, less urgent than a named red build, and never withheld by a drain, because a drain
  // stops the org TAKING ON work rather than finishing what is in flight.
  orders.push(...reviewBlockedOrders(reviewBlocked(prs, required)));
  // #2209: `mergeCandidates` no longer holds a conflicting PR, so without this line it is reported nowhere
  // -- worse than before, when `pr-green-unarmed` at least named it. To its author; a drain keeps it.
  orders.push(...mergeConflictOrders(conflictedPrs(prs, required)));

  // #2174: AFTER the per-PR and per-row causes and BEFORE the chairman's, for `pr-green-unarmed`'s
  // reason applied to the machine rather than to a pull request. A stale host is finished work that has
  // not taken effect -- more urgent than a supply question, less urgent than a named red build. It is
  // deliberately NOT withheld by a drain: see `START_CAUSES`.
  orders.push(...hostDriftOrders(hostDrift));

  orders.push(...chairmanOrders(chairmanBlocked));


  // DRAIN WITHHOLDS, IT DOES NOT STOP. Filtering here rather than at each producer keeps the partition
  // in ONE place -- `START_CAUSES` is the whole statement of what "new work" means, and a cause added
  // without classifying it is caught by `work-gate.test.ts` rather than silently surviving a window.
  return drain ? orders.filter((o) => !START_CAUSES.includes(o.cause)) : orders;
}

/**
 * Everything the gate decided NOT to say, said on stderr where the tick log already reads.
 *
 * TWO KINDS OF SILENCE, ONE PLACE TO READ THEM. A row shelved on B4 and a cause withheld by a drain
 * are both work the gate can see and is deliberately not offering -- and both are invisible from the
 * orders alone, which is exactly how a starved queue reads as a quiet one. Neither costs a model turn.
 *
 * THE DRAIN LINE NAMES THE FILE ON PURPOSE. A marker left behind after a transfer would starve the org
 * for as long as nobody thought to look for it, so every tick says where it is and how to remove it.
 *
 * (Split out of `main`, which reached `complexity` 16 when the drain branch landed.)
 * @param {{ drain: boolean, blocked: { number: number, reason: string }[] }} withheld
 */
function reportWithheld({ drain, blocked }) {
  if (drain) {
    process.stderr.write(`DRAINING (${DRAIN_MARKER} exists): finishing work in flight, starting none. `
      + `Withheld: ${START_CAUSES.join(", ")}. Remove that file to reopen the queue.\n`);
  }
  for (const row of blocked) {
    process.stderr.write(`SHELVED row #${row.number}: ${row.reason}\n`);
  }
}

// --- #2401: A REVIEWER WHOSE CODEX FAILED TO AUTHENTICATE ---------------------------------------------------

/** Where the org's runtime state lives -- beside `wake.mjs`'s ledger, which defaults to the same directory. */
export const REVIEWER_STATE_DIR = `${process.env.HOME}/.cache/a11ign`;

/** The instances `wake.mjs` STARTED and has not ended: `{ "reviewer-<n>": { spawnedAt } }`. `wake` writes, this reads. */
export const REVIEWER_REGISTRY_FILE = "reviewer-instances.json";

/** Every change of the credential's `last_refresh`, one JSON line each -- the reading ruling 2 asked for. */
export const REVIEWER_REFRESH_LEDGER_FILE = "reviewer-refreshes";

/** The reviewers' codex credential. Only `last_refresh` is ever read from it: the tokens beside it are secrets. */
export const CODEX_AUTH_FILE = `${process.env.HOME}/.codex/auth.json`;

/**
 * CODEX'S OWN AUTH-FAILURE TEXT (signal a), READ FROM CODEX AND NOT INVENTED.
 *
 * Measured 2026-09-24 by scanning the printable strings of the installed `codex-cli 0.156.1` binary
 * (`~/.codex/packages/standalone/releases/0.156.1-x86_64-unknown-linux-musl/bin/codex`), no refresh forced.
 * These are the user-facing messages of its auth-recovery path, each verbatim:
 *   - "Your access token could not be refreshed. Please log out and sign in again."
 *   - "Your access token could not be refreshed because you have since logged out or signed in to another
 *      account. Please sign in again."
 *   - "Your authentication session could not be refreshed automatically. Please log out and sign in again."
 *   - "OAuth refresh token was rejected: " and "Failed to refresh token: " (the error prefixes)
 * WHAT THIS DOES NOT PROVE: that any of them RENDERS in a pane as written. No live failure was available -- forcing one
 * could log out live reviewers, which ruling 2 excluded -- so the match is a needle into a pane's recent
 * output, and the first real refresh either finds it or is caught by signal (b). A new codex may reword
 * these; `docs/known-gaps.md` says so.
 */
export const CODEX_AUTH_FAILURE_TEXT = Object.freeze([
  "Your access token could not be refreshed",
  "Your authentication session could not be refreshed automatically",
  "OAuth refresh token was rejected",
  "Failed to refresh token",
]);

/**
 * THE LOGGED-OUT STARTUP SCREEN (signal a, second form): what codex 0.157.0's TUI showed at startup on a REJECTED
 * credential (a deliberately expired, structurally valid fake in a private `CODEX_HOME`, 401), 2026-09-25, read in
 * tmux. It dropped to onboarding and rendered none of the four phrases above:
 *   Welcome to Codex, OpenAI's command-line coding agent / Sign in with ChatGPT / or connect an API key
 * WHAT THIS DOES NOT ESTABLISH: what a pane that loses its login MID-SESSION renders -- the case a running reviewer
 * meets. It is the startup path only, and `docs/known-gaps.md` §49's refresh race stays unmeasured.
 * `anchor` is the welcome line and `alsoShows` must be in the same text: "Sign in with ChatGPT" alone is a phrase a
 * reviewer QUOTES in a review, so neither half fires on its own. A separate list so the four above, whose provenance
 * test reads the installed binary, are unchanged.
 */
export const CODEX_LOGGED_OUT_SCREEN = Object.freeze({
  anchor: "Welcome to Codex, OpenAI's command-line coding agent",
  alsoShows: "Sign in with ChatGPT",
});

const MS_PER_MINUTE = 60_000;

/**
 * How long a reviewer may go without a verdict after the credential refreshed before that is called a failure.
 * A review is minutes of reading, not an hour, and a healthy reviewer that refreshed mid-review still answers
 * inside this; a number, not a measurement, and the refresh ledger is where the first real one is read.
 */
export const REVIEWER_SILENCE_MS = 30 * MS_PER_MINUTE;

/** The two causes whose recipient is a reviewer that owes a verdict. */
const REVIEWER_VERDICT_CAUSES = Object.freeze(["draft-awaiting-verdict", "verdict-comment-unreviewed"]);

/**
 * `credential.last_refresh` as epoch milliseconds, or `null` when the file cannot be read or carries none.
 * `null` is "could not ask" and signal (b) says nothing for it; it is never a time.
 * @param {string} [path] @param {(path: string, enc: "utf8") => string} [read]
 * @returns {number | null}
 */
export function readLastRefresh(path = CODEX_AUTH_FILE, read = readFileSync) {
  try {
    const at = Date.parse(String(JSON.parse(read(path, "utf8"))?.last_refresh ?? ""));
    return Number.isNaN(at) ? null : at;
  } catch {
    return null;
  }
}

/**
 * The instances `wake.mjs` started, from the registry file. `{}` for a missing file (nothing was started) AND for
 * one that will not parse -- the second is a lost reading, so it is never confused with an instance that FAILED.
 * @param {string} path @param {(path: string, enc: "utf8") => string} [read]
 * @returns {Record<string, {spawnedAt: number}>}
 */
export function readReviewerRegistry(path, read = readFileSync) {
  try {
    const parsed = JSON.parse(read(path, "utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The phrase of codex's own auth-failure text a pane shows, or `null`. The logged-out startup screen answers with
 * its welcome line.
 * @param {string | null | undefined} text
 * @returns {string | null}
 */
export function authFailureShownIn(text) {
  const shown = String(text ?? "");
  const { anchor, alsoShows } = CODEX_LOGGED_OUT_SCREEN;
  const loggedOut = shown.includes(anchor) && shown.includes(alsoShows) ? anchor : null;
  return CODEX_AUTH_FAILURE_TEXT.find((phrase) => shown.includes(phrase)) ?? loggedOut;
}

/**
 * The reviewer sessions this tick's orders say still OWE a verdict: an order addressed to `reviewer-<n>` for one
 * of the two verdict causes. The gate derives those from GitHub each tick, so "still emitted" is "still owed".
 * @param {{session: string, cause?: string}[]} orders
 * @returns {Set<string>}
 */
export function sessionsOwingVerdict(orders) {
  return new Set(orders
    .filter((o) => REVIEWER_VERDICT_CAUSES.includes(String(o.cause)) && reviewerInstanceNumber(o.session) !== null)
    .map((o) => o.session));
}

/**
 * WHICH LIVE REVIEWER INSTANCES HAVE FAILED TO AUTHENTICATE -- two signals, each named on the failure it yields.
 *
 *   pane            (a) the instance's pane shows codex's own auth-failure text. Asked of EVERY registered instance,
 *                   because the text is the failure itself and needs no bound.
 *   refresh-silence (b) `last_refresh` is later than the instance's start, it still owes a verdict, and the refresh is
 *                   older than `silenceMs`. A healthy reviewer that refreshed answers inside the bound; one that
 *                   lost its login sits at the prompt and never does.
 *
 * (b) NEEDS THE VERDICT STILL OWED, and that is what keeps an idle instance -- verdict posted, PR waiting to
 * merge -- from reading as failed the moment the credential moves. A `paneText` that cannot be read is `null`,
 * which says nothing for (a) and leaves (b) to stand alone.
 *
 * @param {{instances: Record<string, {spawnedAt: number}>, owing: Set<string>, lastRefresh: number | null,
 *   paneText: (session: string) => string | null, now: number, silenceMs?: number}} facts
 * @returns {{session: string, signals: string[]}[]}
 */
export function reviewerAuthFailures({ instances, owing, lastRefresh, paneText, now, silenceMs = REVIEWER_SILENCE_MS }) {
  return Object.entries(instances).flatMap(([session, { spawnedAt }]) => {
    const signals = [];
    if (authFailureShownIn(paneText(session)) !== null) signals.push("pane");
    const refreshedSinceStart = lastRefresh !== null && lastRefresh > spawnedAt;
    if (refreshedSinceStart && owing.has(session) && now - lastRefresh > silenceMs) signals.push("refresh-silence");
    return signals.length > 0 ? [{ session, signals }] : [];
  });
}

/**
 * The incident order to `ceo`, or none. `ceo` because the remedy is a re-login of the reviewer's codex account, an
 * interactive step only the chairman can take (ruling 2). JUDGMENT-keyed on the failed set and the refresh it
 * followed, so the same failure is not re-asked every twenty minutes and a NEW one is a new question.
 * @param {{session: string, signals: string[]}[]} failures @param {number | null} lastRefresh
 * @returns {{session: string, cause: string, subject: string, discriminator: string, prompt: string, causeKey: string}[]}
 */
export function reviewerAuthOrders(failures, lastRefresh) {
  if (failures.length === 0) return [];
  const key = `${failures.map((f) => f.session).sort().join(".")}/${lastRefresh === null ? "no-refresh" : new Date(lastRefresh).toISOString()}`;
  return [{
    session: "ceo",
    cause: "reviewer-auth-failed",
    subject: "reviewer-auth",
    discriminator: key,
    prompt: `${failures.length} reviewer instance(s) have FAILED TO AUTHENTICATE with codex:\n`
      + failures.map((f) => `  ${f.session}  (${f.signals.join(" + ")})`).join("\n") + "\n"
      + "`pane` is codex's own auth-failure text in the instance's pane; `refresh-silence` is the credential's "
      + "`last_refresh` moving after the instance started while it still owes a verdict for more than "
      + `${REVIEWER_SILENCE_MS / MS_PER_MINUTE} minutes.\n`
      + "THE REMEDY IS A RE-LOGIN OF THE REVIEWER'S CODEX ACCOUNT, and only the chairman can do it (`codex "
      + "login`, interactive). Afterwards close each failed workspace (`herdr --session org workspace close "
      + "<id>`): the gate starts a fresh instance for a pull request that still needs a verdict on its next tick. "
      + "The reading is `reviewer-refreshes`, beside the wake ledger (every refresh, with the live-instance count).",
    causeKey: `ceo/reviewer-auth-failed/${key}`,
  }];
}

/**
 * The ledger lines to append for this tick: a `refresh` line when `last_refresh` differs from the newest recorded
 * one, and a `failure` line for each instance found failed on a refresh not yet recorded as failing.
 *
 * EVERY REFRESH IS A READING (ruling 2): how many instances were live when it moved, and whether any then
 * failed, so "the first real refresh is the measurement" is a file someone can read. A failure is detected up to
 * `REVIEWER_SILENCE_MS` AFTER the refresh, so it is its own line naming the refresh it followed, never a
 * rewrite of the `refresh` line.
 *
 * @param {{ledger: {type: string, lastRefresh: string | null, session?: string}[], lastRefresh: number | null,
 *   live: string[], failures: {session: string, signals: string[]}[], now: number}} facts
 * @returns {object[]}
 */
export function refreshLedgerLines({ ledger, lastRefresh, live, failures, now }) {
  if (lastRefresh === null) return [];
  const iso = new Date(lastRefresh).toISOString();
  const at = new Date(now).toISOString();
  const lines = [];
  const known = ledger.some((l) => l.type === "refresh" && l.lastRefresh === iso);
  const hadOtherRefresh = ledger.some((l) => l.type === "refresh");
  if (!known) lines.push({ type: "refresh", at, lastRefresh: iso, live: live.length, liveSessions: live,
    firstRecorded: !hadOtherRefresh });
  for (const f of failures) {
    if (ledger.some((l) => l.type === "failure" && l.lastRefresh === iso && l.session === f.session)) continue;
    lines.push({ type: "failure", at, lastRefresh: iso, session: f.session, signals: f.signals });
  }
  return lines;
}

/** @param {string} path @param {(path: string, enc: "utf8") => string} [read] */
function readRefreshLedger(path, read = readFileSync) {
  try {
    return String(read(path, "utf8")).split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/**
 * The live reviewer instances' panes as text, through herdr: workspace list, the pane of the one labelled
 * `session`, and that pane's recent output. `null` for anything herdr will not say -- never `""`, which would
 * read as "a pane that shows no failure".
 *
 * A HERDR CALL FROM THE GATE, AND THE ONE EXCEPTION to its header (which keeps herdr to `wake.mjs` so this file
 * stays testable): the seam is `run`, INJECTED, and it is reached only for an instance in the registry, so a tick
 * with no reviewer instance makes no call at all.
 * @param {(args: string[]) => string} run
 * @returns {(session: string) => string | null}
 */
export function herdrPaneReader(run) {
  return (session) => {
    try {
      const workspaces = JSON.parse(run(["--session", "org", "workspace", "list"]))?.result?.workspaces ?? [];
      const workspace = workspaces.find((/** @type {any} */ w) => w.label === session)?.workspace_id;
      if (typeof workspace !== "string") return null;
      const panes = JSON.parse(run(["--session", "org", "pane", "list", "--workspace", workspace]))?.result?.panes ?? [];
      const pane = panes[0]?.pane_id;
      return typeof pane === "string" ? run(["--session", "org", "pane", "read", pane, "--lines", "60"]) : null;
    } catch {
      return null;
    }
  };
}

/**
 * The detector's whole tick: read the registry, the credential and the panes; append the refresh ledger; return
 * the incident order. Reads the SAME state directory `wake.mjs` writes its registry into.
 *
 * NEVER THROWS -- a detector that can crash the gate would stop every order behind it. A failure to append the
 * ledger is said on stderr and the order is still returned.
 *
 * @param {{orders: {session: string, cause?: string}[], dir?: string, authFile?: string, now?: number,
 *   run?: (args: string[]) => string, log?: (line: string) => void}} args
 */
export function reviewerAuthTick({ orders, dir = REVIEWER_STATE_DIR, authFile = CODEX_AUTH_FILE, now = Date.now(),
  run = herdrRun, log = (line) => process.stderr.write(line) }) {
  const instances = readReviewerRegistry(`${dir}/${REVIEWER_REGISTRY_FILE}`);
  const lastRefresh = readLastRefresh(authFile);
  const failures = reviewerAuthFailures({ instances, owing: sessionsOwingVerdict(orders), lastRefresh,
    paneText: Object.keys(instances).length > 0 ? herdrPaneReader(run) : () => null, now });
  const ledgerPath = `${dir}/${REVIEWER_REFRESH_LEDGER_FILE}`;
  const lines = refreshLedgerLines({ ledger: readRefreshLedger(ledgerPath), lastRefresh,
    live: Object.keys(instances), failures, now });
  try {
    if (lines.length > 0) {
      mkdirSync(dirname(ledgerPath), { recursive: true });
      appendFileSync(ledgerPath, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
    }
  } catch (err) {
    log(`reviewer-auth: could not append ${ledgerPath} (${String(/** @type {any} */ (err)?.message ?? err).split("\n")[0]}) -- the order below is unaffected.\n`);
  }
  return reviewerAuthOrders(failures, lastRefresh);
}

const BYTES_PER_GIB = 1_073_741_824;

/**
 * `/` and `/tmp` -> `root+tmp`: a mount as a word a causeKey can carry. `/` is `root`, any other loses its leading
 * slash and turns the rest into `-`.
 * @param {string[]} mounts
 */
function mountsLabel(mounts) {
  return mounts.map((m) => (m === "/" ? "root" : m.replace(/^\//, "").replaceAll("/", "-"))).join("+");
}

/** @param {import("./disk-headroom.mjs").LowFinding} f */
function describeLow(f) {
  const amount = f.resource === "bytes"
    ? `${(f.free / BYTES_PER_GIB).toFixed(1)} GiB of ${(f.total / BYTES_PER_GIB).toFixed(1)} GiB`
    : `${f.free.toLocaleString("en-US")} of ${f.total.toLocaleString("en-US")}`;
  return `${f.mounts.join(" + ")}  FREE ${f.resource.toUpperCase()}: ${amount} (${(f.fraction * 100).toFixed(1)}%)`;
}

/**
 * The incident order to `ceo`, or none (#2163). `ceo` because a full disk is the one fault every session shares and
 * no session owns, and the remedy (what to delete, whether to schedule the prune) is theirs to rule on.
 *
 * JUDGMENT-KEYED ON WHICH RESOURCE OF WHICH FILESYSTEM IS LOW, and on nothing else -- so a condition that persists
 * is asked again on the judgment window and not on every tick, and a SECOND resource going low is a new question
 * that reaches `ceo` at once. The cost, stated: 9% and 0% free are the same key, so a disk getting worse does not
 * re-page inside the window; the stderr line below is written every tick and does.
 *
 * @param {import("./disk-headroom.mjs").LowFinding[]} low
 * @returns {{session: string, cause: string, subject: string, discriminator: string, prompt: string, causeKey: string}[]}
 */
export function diskHeadroomOrders(low) {
  if (low.length === 0) return [];
  const key = low.map((f) => `${mountsLabel(f.mounts)}:${f.resource}`).sort().join(".");
  return [{
    session: "ceo",
    cause: "disk-headroom-low",
    subject: "disk-headroom",
    discriminator: key,
    prompt: `DISK HEADROOM IS LOW on this host (a resource is low below ${MIN_FREE_FRACTION * 100}% free):\n`
      + low.map((f) => `  ${describeLow(f)}`).join("\n") + "\n"
      + "BYTES AND INODES ARE JUDGED SEPARATELY, and `df -h` shows only bytes. On 2026-09-25 `/tmp` ran out of "
      + "INODES at 73% of its bytes and every session failed with ENOSPC for about six hours. Read both: "
      + "`df -h / /tmp` and `df -i / /tmp`.\n"
      + "What has filled it before: `/tmp/rv-*` review clones, `/tmp/claude-1000` session scratchpads, "
      + "`~/repos/wt-*` worktrees (each with a `node_modules`), and npm caches. `node "
      + "packages/agent-org/src/prune-tmp.mjs` classifies `/tmp` and removes NOTHING without `--apply`, and "
      + "`--apply` waits for a named list one cycle first (#2243). `npm run worktrees:prune` is the worktree half.\n"
      + "IF YOUR OWN SHELL IS FAILING WITH ENOSPC you cannot fix this from here: tell the chairman by another "
      + "route. The same reading is written on the tick's stderr before `wake` runs (`journalctl --user -u "
      + "a11ign-work-tick.service | grep 'DISK LOW'`), though that journal sits on this same filesystem.",
    causeKey: `ceo/disk-headroom-low/${key}`,
  }];
}

/**
 * The detector's whole tick: read `/` and `/tmp`, say on stderr what is low, return the incident order.
 *
 * NEVER THROWS, for `reviewerAuthTick`'s reason -- a detector that can crash the gate stops every order behind it.
 * A mount that cannot be READ is said on stderr and is neither reported low nor counted healthy: `statfs` failing
 * is not the disk being full, and silence about it would read as a clean bill.
 *
 * THE STDERR LINE IS THE CHANNEL THAT DOES NOT NEED THE DISK (#2163 done-when 4). `work-tick` relays the gate's
 * stderr BEFORE it runs `wake`, and `wake`'s writes (`wake-emitted`, the ledger) are what a full disk breaks: a
 * throwing write to `wake-emitted` ends `wake` with an uncaught exception, exit 1, BEFORE any delivery, and one to
 * the ledger ends it AFTER the first delivery and before the rest (both measured -- `disk-headroom.test.ts`). The
 * line is written whether or not the order is ever delivered. THE JOURNAL IT LANDS IN IS ON THE SAME FILESYSTEM
 * (`/var/log/journal`, persistent), so this is a channel that does not depend on a write BY THE ORG, not one proven
 * to survive an exhausted disk: journald's own free-space rules decide that, and nothing here has run it to zero.
 *
 * @param {{ read?: typeof diskHeadroom, log?: (line: string) => void }} [io]
 */
export function diskHeadroomTick({ read = diskHeadroom, log = (line) => process.stderr.write(line) } = {}) {
  try {
    const { low, unreadable } = read();
    for (const u of unreadable) {
      log(`disk-headroom: could not read ${u.mount} (${u.reason}) -- neither reported low nor counted healthy.\n`);
    }
    for (const f of low) log(`DISK LOW: ${describeLow(f)}\n`);
    return diskHeadroomOrders(low);
  } catch (err) {
    log(`disk-headroom: could not run (${String(/** @type {any} */ (err)?.message ?? err).split("\n")[0]}) -- no order this tick.\n`);
    return [];
  }
}

/** @param {string[]} args */
const herdrRun = (args) => execFileSync("herdr", args, { encoding: "utf8", timeout: 10_000 });

/**
 * The dead man's switch, wired: asked ONLY when everything else said nothing.
 *
 * Split out of `main`, which reached `complexity` 17 with it inline -- and the seam is real rather than
 * cosmetic: every other line in `main` is about delivering what the gate found, and this one is about
 * what it did NOT find.
 *
 * A DRAIN WITHHOLDS IT like any other START cause. During a transfer window the org is SUPPOSED to be
 * idle, and a switch that fires then is one people learn to ignore -- which is the failure mode the
 * pattern's own literature warns about more loudly than the missing-switch one.
 *
 * IT TAKES THE ROWS RATHER THAN READING THEM (#1938). `main` has the whole open-row list in hand by the
 * time this is reached, so asking again was a second `gh` call for a subset of a list already fetched.
 * What it must be handed is the UN-COALESCED result -- `readOpenRows()`, not `readOpenRows() ?? []` --
 * because those two spell "the API refused" and "the tracker is empty" identically, and only one of them
 * is a state where silence is honest.
 *
 * A REFUSAL SAYS SO OUT LOUD, and that line is how the difference is OBSERVABLE rather than ceremonial.
 * `stalledOrder` returns no order for either `null` or `0`, so without this the two states would be
 * indistinguishable from outside -- a silent tick that could not ask would look exactly like a silent
 * tick that asked and found a finished org. `main` already refuses to report a refused read as quiet for
 * the pull-request and Ready lanes (`CANNOT ASK` / `PARTIAL`); this is the same rule for this lane.
 *
 * @param {{ orders: unknown[], drain: boolean, performed?: number, openRows: any[] | null,
 *           log?: (line: string) => void }} state
 */
export function deadMansSwitch({ orders, drain, performed = 0, openRows,
  log = (line) => process.stderr.write(line) }) {
  // A PERFORMED ACTION IS ACTIVITY. Without this the gate could mark a draft ready, emit no order, and
  // then announce the org as stalled in the same tick -- reporting the one thing it just did as nothing.
  if (drain || orders.length > 0 || performed > 0) return [];
  // BOTH HALVES OF THE ANSWER FROM THE ROWS ALREADY READ: how many rows could move, and what is stopping
  // the ones that cannot. A refused read stays `null` all the way into `stalledOrder`, which is the
  // #1286 rule -- it must not collapse to a zero count, which would silence the switch on an API hiccup.
  const state = openRowState(openRows);
  if (state === null) {
    log("CANNOT ASK whether the org is stalled: the open-rows read was refused this tick. "
      + "This silence is NOT a quiet queue, and the dead man's switch did NOT examine anything.\n");
  }
  const stalled = stalledOrder({ orders, openRows: state?.reachable ?? null, waiting: state?.waiting });
  return stalled ? [stalled] : [];
}

/**
 * THE REFUSAL, WITH THE THREE FACTS THAT TELL A DEAD POOL FROM A QUIET QUEUE (#2003).
 *
 * The first sentence is unchanged and still does its job: it is correct, it is loud, and on 2026-09-22 it
 * ran on every tick from 20:28:15Z. What it could not say is the only thing a reader needs -- which
 * account was refused, which pool, and when it comes back. `328832207` is a user ID, not a login, and the
 * answer to "for how long" (52 minutes) was sitting in the headers of the call that had just failed.
 *
 * THE COST IS PAID ONLY HERE, AND IT IS ONE POINT. A healthy tick still makes exactly the reads `GH_READS`
 * names: this function is reached only when BOTH lanes have already refused, on a pool that by definition
 * has nothing left to protect, and `poolDiagnosis` spends a single probe whatever it finds there.
 *
 * A DEAD POOL BUYS THE RESET RATHER THAN THE LOGIN, because no one call buys both and "how long is the org
 * deaf" is the question the outage left unanswered; the account then reads `UNREADABLE (user ID ...)`.
 * `api-pool.mjs` records the alternatives that were measured and rejected.
 *
 * `run` IS REQUIRED, which is `apiBudget`'s rule (#1405) for its reason: a defaulted one is a live `gh`
 * call, and a test reaching this function would make it.
 *
 * @param {{run: (args: string[]) => string}} deps
 * @returns {string}
 */
export function cannotAskReport({ run }) {
  return "CANNOT ASK: neither the pull-request list nor the Ready rows could be read. "
    + "Nothing was examined -- this is NOT a quiet queue, and no session has been woken.\n"
    + `${refusalPoolLine(poolDiagnosis({ run }))}\n`;
}

/**
 * The agent host's drift, or `null` when the read could not be made -- #2174.
 *
 * SPAWNED, NOT IMPORTED, AND THE CHOICE IS MEASURED RATHER THAN STYLISTIC. The row offered three routes:
 * import `hostUnitDrift`, split it into a leaf module, or spawn `host:check`. A direct import is free at
 * LOAD -- `host-units.mjs` adds one file to a closure of 21, and 39.3ms against the gate's own 39.4ms,
 * five runs each -- so the row's constraint 1, which feared the import WEIGHT, is satisfied by it and
 * would have ended the question.
 *
 * WHAT THE WEIGHT MEASUREMENT MISSES IS THE CAPABILITY CLOSURE, and that is what decided this.
 * `host-units.mjs` calls `git log --all` (`addedOnSomeRef`), so importing it here puts a `history`
 * requirement into `work-gate.mjs` -- and this file is reached by `row-claim/runner-rule.mjs`, which most
 * of the packaging suite imports. MEASURED with `deriveClosureRequirements` over
 * `packages/lab/src/packaging/*.test.ts`, at `518de0e32` and again with the import added: **4 files
 * derive a `history` requirement, and 28 do with it.** Twenty-four test files that will never call this
 * code would owe a `History: full` declaration, paid by whoever next opens a PR whose Acceptance happens
 * to name one of them. A process boundary costs one node startup per tick and leaves the closure at 4.
 *
 * AND IT BUYS A PROPERTY THE IMPORT CANNOT. The session this cause wakes is told to run
 * `npm run host:check`; this spawns THE SAME FILE IN THE SAME TREE, so the gate and the human can never
 * disagree about what drifted. Two readers of one question is the defect this repository keeps
 * re-finding one level up, and here there is exactly one.
 *
 * `null` FOR EVERY UNREADABLE CASE AND NEVER `[]`, which is `readPrs`'s rule for its reason: a spawn
 * that failed, a non-zero exit, unparseable output and `asked: false` are all "not asked", while `[]` is
 * a host that was looked at and is correct. Both produce silence here and they are NOT the same claim --
 * `hostDriftOrders` keeps them apart, and `driftReport` keeps them apart for the CLI's reader.
 * @returns {{unit: string, problem: string, detail: string}[] | null}
 */
function readHostDrift() {
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

/** `host-units.mjs` beside this file -- RESOLVED, never imported. See `readHostDrift` for why. */
function hostUnitsEntry() {
  return fileURLToPath(new URL("./host-units.mjs", import.meta.url));
}

/**
 * The closing times `unclaimedBlockerClearedOrders` backs off on, read ONLY when some unclaimed row has a
 * cleared blocker to ask about. `openRows` is already in hand, so the condition costs no call, and a quiet
 * tracker pays nothing (`GH_READS.conditionalOnClearedRows`). `null` when there is nothing to ask about
 * OR the read was refused -- in both cases the caller's fallback is the unstaged first ask.
 *
 * @param {any[]} openRows
 */
function closingsWhenRowsCleared(openRows) {
  return unclaimedClearings(openRows).length > 0 ? readRecentlyClosed() : null;
}

function main() {
  refuseUnknownFlags([], { entry: import.meta.url, command: "node packages/agent-org/src/work-gate.mjs" });
  // READ BEFORE ANY GITHUB CALL (#2163), because it is the one reading a `CANNOT_ASK` exit must not hide: a tick
  // that cannot reach GitHub delivers nothing, so on that path the stderr line is the only thing that says the
  // disk is full. Its ORDER is put in front of the others further down.
  const diskOrders = diskHeadroomTick();
  const prs = readPrs();
  const readyRows = readReadyRows();

  // BOTH LANES REFUSED IS `CANNOT_ASK`; ONE IS `PARTIAL`. Nothing here may report a refused read as quiet.
  if (prs === null && readyRows === null) {
    process.stderr.write(cannotAskReport({ run: defaultRun }));
    process.exit(EXIT.CANNOT_ASK);
  }

  // The third read is only needed to size the refill, and a refused one must not read as an empty shelf.
  const promotableRows = readPromotableRows();
  const chairmanBlocked = readChairmanBlocked();
  // ONE COALESCE PER REFUSED LANE, NAMED. `prs ?? []` was written three times and `readyRows ?? []` twice;
  // each repetition is a branch `complexity` counts, and the names say what an empty list MEANS here --
  // a lane that could not be read, already reported as PARTIAL below, never a lane that is empty.
  const openPrs = prs ?? [];
  const rows = readyRows ?? [];
  const prFiles = comparablePrFiles(openPrs);
  const drain = draining();
  // ONE READ, THREE CAUSES -- and the refusal is kept BESIDE the coalesced list rather than instead of
  // it. `decide`'s label-derived causes want a list to filter, and an empty one is the right degradation
  // there; the dead man's switch needs to tell "refused" from "empty", so it is handed the raw result.
  // Both names exist so neither reader has to infer which of the two it was given (#1938).
  const openRowsRead = readOpenRows();
  const allOpen = openRowsRead ?? [];
  const claimedComments = claimedRowCommentsWhenHeld(allOpen);
  // #2031: A LOCAL git CALL, NOT AN API ONE -- it adds nothing to `GH_READS` and cannot be refused by an
  // exhausted pool, which is the whole reason the detection can exist. `GIT_READS` counts it.
  const rowBranches = readRowBranches();
  // #1969: NAMED RATHER THAN CALLED TWICE. `shouldBeMerging` needs the same answer `decide` does, and
  // `requiredWhenRed` makes a `gh` call when anything is red -- calling it inline in both places would
  // pay for it twice on exactly the red tick this row is about.
  const required = requiredWhenRed(openPrs);
  const baseTip = baseTipWhenRed(openPrs);
  const decided = decide({ prs: withEvidenceLabelAges(withCommitChains(openPrs)), readyRows: rows, promotableRows: promotableRows ?? [],
    chairmanBlocked: chairmanBlocked ?? [], prFiles, drain, required, baseTip,
    epics: epicsWhenShelfEmpty(rows),
    answerOwed: rowsOwingAnswers({ openRows: allOpen, openPrs, closedRows: closedAnswerRows() }),
    openRows: allOpen,
    // #2110: CONDITIONAL, and the condition is answered for free from the list already in hand --
    // `readOpenRows` fetched the labels, so "is anything claimed at all" costs no call. A quiet org with
    // nothing in progress pays nothing; a busy one pays exactly one, whatever the size of the queue.
    claimedComments: claimedComments ?? [],
    // #2470: the SAME comments, read once, and the raw `null` kept for the reader that must tell "refused" from "none".
    claimStalls: claimStallsNow(openRowsRead, claimedComments, prs),
    // #1969: CONDITIONAL, and the condition is answered for free from the list already in hand.
    // `shouldBeMerging` reads `openPrs`; only if it finds a green, unheld, non-draft PR is the
    // merge-queue call made at all.
    unarmed: readUnarmed(shouldBeMerging(openPrs, required)), rowBranches,
    // #2174: A LOCAL READ, NOT AN API ONE -- a `readdir`, some `readFileSync` and one `systemctl` spawn
    // per shipped timer. It adds nothing to `GH_READS` and cannot be refused by an exhausted pool, which
    // is what lets the detection exist at all.
    hostDrift: readHostDrift(),
    // #2286: CONDITIONAL, and the condition is answered for free from the list already in hand.
    closings: closingsWhenRowsCleared(allOpen),
    // #2356: `null` for a refused read or a green `main`, and the two need no telling apart HERE -- both
    // emit nothing, and a refused read is not reported as health because nothing else reads "trunk is fine".
    trunkRed: readTrunkRed() });
  const { delivered: orders, performed } = performActions(decided);
  orders.push(...reviewerAuthTick({ orders }));
  // FIRST OF ALL, AND ON PURPOSE (#2163): `wake` delivers in this order and records each delivery with a write, so
  // on a full disk the tick can end partway. The order that says the disk is full must not be the one behind it.
  orders.unshift(...diskOrders);
  orders.push(...deadMansSwitch({ orders, drain, performed, openRows: openRowsRead }));
  for (const order of orders) process.stdout.write(`${JSON.stringify(order)}\n`);

  // BOTH SHELVES ON ONE LINE-SHAPE. The engineer pool's B4/declared-wait shelvings and the fleet batch's
  // (#2027) are the same fact -- work the gate can see and is deliberately not offering -- and a row that
  // leaves a set silently is the defect both filters exist to fix.
  reportWithheld({ drain, blocked: [...partitionUnclaimed(rows, prFiles, { rowBranches, openRows: allOpen }).blocked,
    ...partitionFleetBatch(allOpen).waiting] });

  if (prs === null || readyRows === null) {
    process.stderr.write(`PARTIAL: could not read ${prs === null ? "the pull-request list" : "the Ready rows"}. `
      + `The ${orders.length} order(s) above are real; that lane was NOT examined and may hold work.\n`);
    process.exit(EXIT.PARTIAL);
  }
  // PERFORMED COUNTS AS WORK. A tick that marked a draft ready did something, and exiting QUIET would
  // report it as an idle org to every reader of this exit code.
  process.exit(orders.length > 0 || performed > 0 ? EXIT.WORK : EXIT.QUIET);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();

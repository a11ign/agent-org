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
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { realpathSync, existsSync } from "node:fs";
// RELATIVE, not the package specifier -- this must run before any `npm ci`/build, the same constraint
// `org-watch.mjs` and `build-packages.mjs` state at their own imports.
import { refuseUnknownFlags } from "../../worker-fleet/src/cli-flags.mjs";
import { READY_LABEL, CLAIM_LABEL } from "./claim-labels.mjs";
import { verdictAtHead } from "./review-verdict.mjs";
import { waitingOn, fleetWaitingOn, todayIso, describeWaiting, ANSWER_PREFIX } from "./waiting-condition.mjs";
import { newestPerName } from "./newest-check-run.mjs";
import { parityOwner } from "./review-attribution.mjs";
import { NO_VERDICT } from "./merge-guard/checks-rule.mjs";
// B4, ASKED EARLY. These are the SAME two functions `row-claim.mjs` runs at claim time, imported
// rather than reimplemented: `region-paths.mjs`'s own header records why a second copy of "what
// counts as a path" is not allowed to exist. Both are leaf-shaped and relative, so the gate keeps the
// property its own header states -- it runs before any `npm ci` or build.
import { declaredRegionFiles } from "./region-paths.mjs";
import { declaredClosedRows, fileOverlapReason } from "./row-claim/file-overlap-rule.mjs";
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
import { armabilityOf } from "./pr-hold-state.mjs";
import { REPO } from "../../../scripts/repo-identity.mjs";

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
  "blocked-unexaminable", "fleet-batch-due", "blocker-cleared", "pr-green-unarmed"];

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
 * THE RISK, STATED: a judgment wake that never lands is never retried. That is a real cost and a smaller
 * one than the alternative -- the STUCK counter still catches a cause that keeps being emitted, and any
 * change to the underlying state produces a new key. An unasked question is cheaper than a question
 * asked forty times.
 */
export const JUDGMENT_CAUSES = Object.freeze(["ready-queue-empty", "lane-backlog-unpromoted",
  "chairman-blocked", "org-stalled", "epic-unfiled", "epic-finished", "answer-owed",
  "blocked-unexaminable", "fleet-batch-due"]);

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
 */
export const START_CAUSES = Object.freeze(["ready-row-unclaimed", "ready-queue-empty",
  "lane-backlog-unpromoted", "org-stalled", "epic-unfiled", "epic-finished",
  "blocked-unexaminable", "fleet-batch-due"]);

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
      "number,isDraft,headRefOid,statusCheckRollup,author,comments,labels,files,changedFiles,body"]);
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
    "issue list --label chairman-blocked", "issue list (all open: answer/blocked labels)"],
  conditionalOnEmptyShelf: "issue list --label epic (readEpics)",
  // #2106 ADDED THE SECOND HALF OF THIS LINE, AND IT IS COUNTED FOR THE SAME REASON AS THE LINE BELOW:
  // `refusedProtectionDiagnosis` reads `branches/main` to tell FORBIDDEN from ABSENT, and a read that is
  // not written down here is one the next person inherits uncounted. It is conditional on the FIRST read
  // being refused, so a tick that can read the contexts pays one call and a healthy tick pays none.
  conditionalOnRed: "api branches/main/protection (requiredCheckNames), then -- only if that is refused --"
    + " api branches/main (the .protected discriminator, #2022)",
  // #1969, AND IT IS COUNTED HERE BECAUSE THE LAST ONE WAS NOT. This constant exists because "two `gh`
  // calls" was repeated for weeks while three readers were added, and a reviewer had to measure the call
  // sites to find it. The condition is `shouldBeMerging` finding a green, unheld, non-draft PR -- which
  // on a healthy queue is the COMMON case, so unlike the two above this one is usually paid. It is still
  // conditional rather than unconditional: a tick with nothing green and unheld makes no call at all.
  conditionalOnGreenUnheldPr: "api graphql (open PRs' mergeQueueEntry -- readUnarmed)",
});

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
 */
export const ROUTED_TO = Object.freeze({ "fleet-gated": Object.freeze(["orchestrator", "worker-capture"]) });

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

/** @param {any} x @returns {string[]} */
const labelsOf = (x) => (x?.labels ?? []).map((/** @type {any} */ l) => String(l?.name ?? l));

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
 * @returns {{ number: number, files: string[], changedFiles: number, closes: number[] }[]}
 */
export function comparablePrFiles(prs) {
  return prs
    .map((p) => ({
      number: Number(p?.number),
      changedFiles: Number(p?.changedFiles),
      files: (p?.files ?? []).map((/** @type {any} */ f) => String(f?.path ?? f)),
      closes: declaredClosedRows(p?.body),
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
 * @param {any} row @param {{ number: number, files: string[], changedFiles: number, closes?: number[] }[]} prFiles
 * @param {{ rootFiles?: Set<string> }} [options] passed to `declaredRegionFiles` so a test can name its
 *   own tree rather than needing this repository's
 * @returns {string | null}
 */
export function blockedOnOpenPr(row, prFiles, options) {
  // NOTHING TO OVERLAP. With no comparable open PR no refusal is possible, and reading the row's Region
  // to discover that would spawn `git ls-tree` for an answer already known.
  if (prFiles.length === 0) return null;
  const mine = declaredRegionFiles(String(row?.body ?? ""), options);
  if (mine === null) return null;
  return fileOverlapReason(mine, prFiles, { rowNumber: Number(row?.number) }).reason;
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
 * @param {any[]} readyRows @param {{ number: number, files: string[], changedFiles: number }[]} prFiles
 * @param {{ rootFiles?: Set<string> }} [options]
 * @returns {{ offerable: any[], blocked: { number: number, owner: string | null, reason: string }[] }}
 */
export function partitionUnclaimed(readyRows, prFiles, options) {
  const offerable = [];
  const blocked = [];
  const today = todayIso();
  for (const row of readyRows) {
    // #2005's OPEN-CHECK, ANSWERED BY THIS LINE AND NOT BY A NEW RULE. The filer asked whether
    // `answer:<session>` should hold a row against its OWN HOLDER -- #1948 was `in-progress` +
    // `session:worker-tooling` + `answer:worker-tooling`, and a session is not blocked by its own
    // unanswered question the way a stranger is. It never arises here: a claimed row carries
    // `CLAIM_LABEL` and leaves on this line, before anything asks what it is waiting on. So "not offered
    // to a session other than the one already holding it" needed no expression -- a held row is not
    // offered to anybody, which is strictly stronger and was already true.
    if (labelsOf(row).includes(CLAIM_LABEL)) continue;
    // A DECLARED WAIT SHELVES THE ROW RATHER THAN HIDING IT. It goes to `blocked` with its reason, so
    // the tick log says why -- a row that vanishes silently is the failure `blocked` already is.
    //
    // SINCE #2005 THAT INCLUDES `answer:<session>`, and nothing here changed to make it so: `waitingOn`
    // gained the kind and this call site inherited it. That is the seam working -- the alternative, a
    // third prefix check written out here beside the one `readPromotableRows` already had, is exactly
    // how the offer path and the promotion path came to disagree in the first place.
    const waiting = waitingOn(row, today);
    if (waiting) {
      blocked.push({ number: Number(row.number), owner: laneOwnerOf(row),
        reason: `${describeWaiting(waiting)} -- declared on the row, and it clears itself` });
      continue;
    }
    const reason = blockedOnOpenPr(row, prFiles, options);
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

const conclusionOf = (/** @type {any} */ c) => String(c?.conclusion ?? c?.state ?? "").toUpperCase();

/** @param {any} c */
function stillRunning(c) {
  const status = String(c?.status ?? "").toUpperCase();
  return status === "IN_PROGRESS" || status === "QUEUED" || status === "PENDING";
}

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
 * `NO_VERDICT` is IMPORTED: the rollup spells it in upper case, the REST read in lower (`update-branch-sweep.mjs`
 * #1100), and the concept is one ruling either way.
 *
 * @param {any[]} blocking the blocking checks, narrowed @param {any[]} head every check on the head, narrowed
 */
export function redOnlyBySupersededRun(blocking, head) {
  const red = blocking.filter((c) => checksSettledGreen([c]) === false);
  return red.length > 0 && red.every((c) => conclusionOf(c) === NO_VERDICT.toUpperCase()) && head.some(stillRunning);
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
function sessionOf(pr) {
  const label = labelsOf(pr).find((/** @type {string} */ n) => n.startsWith("session:"));
  return label ? label.slice("session:".length) : null;
}

/**
 * PAID ONLY BY A RED TICK. A healthy queue never asks what is required, so the UNCONDITIONAL read count
 * is unchanged -- see `GH_READS` for what that count actually is, and for the correction that had to be
 * made to this very comment.
 *
 * (Extracted from `main`, which reached `complexity` 17 with the ternary inline -- the same seam the
 * dead man's switch took, and for the same reason: `main` is about delivering what the gate found.)
 *
 * @param {any[]} prs
 */
function requiredWhenRed(prs) {
  return anyChecksRed(prs) ? requiredCheckNames() : null;
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
 * The milestone the fleet batch is scoped to. Matches `fleet-gated-nightly.mjs`'s own constant, which is
 * where #914's bar is written down.
 */
export const FLEET_MILESTONE = "Road to version one";

/**
 * The open `fleet-gated` rows on the milestone, SPLIT BY WHETHER ANYTHING IS STOPPING THEM -- #2027.
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
 * @param {any[]} rows @param {string} [milestone]
 * @param {{today?: string, nowMs?: number}} [clock] injected so a test moves time without a global stub
 * @returns {{batch: any[], waiting: {number: number, reason: string}[]}}
 */
export function partitionFleetBatch(rows, milestone = FLEET_MILESTONE, clock = {}) {
  const { today = todayIso(), nowMs = Date.now() } = clock;
  const batch = [];
  const waiting = [];
  const gated = (rows ?? [])
    .filter((r) => labelsOf(r).includes("fleet-gated"))
    .filter((r) => String(r?.milestone?.title ?? "") === milestone)
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
 * The `fleet-gated` rows on the milestone that ARE dispatchable -- the batch #914 describes.
 *
 * @param {any[]} rows @param {string} [milestone] @param {{today?: string, nowMs?: number}} [clock]
 */
export function fleetBatchRows(rows, milestone = FLEET_MILESTONE, clock = {}) {
  return partitionFleetBatch(rows, milestone, clock).batch;
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
 * @param {string} [milestone]
 * @param {{today?: string, nowMs?: number}} [clock]
 * @returns {{session: string, cause: string, subject: string, discriminator: string,
 *            prompt: string, causeKey: string}[]}
 */
export function fleetBatchOrders(rows, milestone = FLEET_MILESTONE, clock = {}) {
  const batch = fleetBatchRows(rows, milestone, clock);
  if (batch.length === 0) return [];
  const numbers = batch.map((r) => `#${r.number}`).join(", ");
  const key = batch.map((r) => r.number).join(".");
  return [{
    session: "orchestrator",
    cause: "fleet-batch-due",
    subject: "fleet-batch",
    discriminator: key,
    prompt: `${batch.length} row(s) carry \`fleet-gated\` and are open on "${milestone}": ${numbers}.\n`
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

/** The rows that owe someone an answer. @param {any[]} rows */
export function withAnswerLabel(rows) {
  return (rows ?? []).filter((r) => labelsOf(r).some((/** @type {string} */ n) => n.startsWith(ANSWER_PREFIX)));
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
 * @param {any[]} rows
 */
export function answerOrders(rows) {
  const orders = [];
  for (const [session, owed] of answersOwed(rows)) {
    for (const row of owed.slice(0, MAX_ROW_ORDERS_PER_TICK)) {
      orders.push({
        session,
        cause: "answer-owed",
        subject: `row-${row.number}`,
        discriminator: String(row.number),
        prompt: `#${row.number} IS WAITING ON AN ANSWER FROM YOU. Another session asked you something `
          + "there and cannot move until you reply -- read that row's most recent comments for the "
          + "question.\n"
          + `ANSWER ON THE ROW, then remove its \`${ANSWER_PREFIX}${session}\` label: taking the label `
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
 * @param {any[]} rows every open row
 * @param {string} [today]
 * @returns {{session: string, cause: string, subject: string, discriminator: string,
 *            prompt: string, causeKey: string}[]}
 */
export function blockerClearedOrders(rows, today = todayIso()) {
  const orders = [];
  for (const row of rows ?? []) {
    const session = sessionOf(row);
    const cleared = declaredBlockers(row);
    if (!session || !labelsOf(row).includes(CLAIM_LABEL) || cleared === null) continue;
    // THE LINE THAT MAKES `cleared` MEAN CLEARED. `waitingOn` reports an OPEN `blockedBy` node before
    // anything else, so passing here is what proves every number above is closed -- and it covers the
    // other two conditions in the same breath, which is why `declaredBlockers` does not re-ask.
    if (waitingOn(row, today)) continue;
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
 * ONE SPELLING OF THE ENDPOINT, so the report names what the read actually asked for. A report that
 * quotes a path by hand drifts from the call beside it, and a wrong path in a diagnostic sends the next
 * reader to test something the gate never did.
 */
const PROTECTION_ENDPOINT = "repos/{owner}/{repo}/branches/main/protection";

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
    answer = run(["api", PROTECTION_ENDPOINT, "--jq", ".required_status_checks.contexts"]);
  } catch (error) {
    // THE REFUSAL AND THE UNUSABLE ANSWER ARE DIFFERENT FACTS, so the call is separated from the parse
    // rather than sharing one `catch`. Only a call that never answered is worth asking a discriminator
    // about; a malformed body already proves the endpoint was reachable.
    log(cannotReadRequiredChecks(refusedProtectionDiagnosis({ run, error })));
    return null;
  }
  const contexts = parsedOrNull(answer);
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
  return `CANNOT READ the required checks: \`gh api ${PROTECTION_ENDPOINT}\` ${diagnosis} `
    + "Falling back to EVERY check on the head (pre-#1750 behaviour): no red pull request is missed, "
    + "but the wasted prompts #1750 was filed to stop are still being sent.\n";
}

/**
 * FORBIDDEN OR ABSENT -- and #2022's ruling is that a 404 here may NEVER be read as "unprotected".
 *
 * `branches/main/protection` 404s for both, so the 404 alone decides nothing. `branches/main.protected`
 * is the discriminator, it needs no admin, and it was measured 2026-09-22T23:05Z reading `true` in the
 * same second the protection endpoint 404'd for `a11ign-ai-workers` -- whose `permissions.admin` is
 * `false`, and which is the credential this gate runs with.
 *
 * DOUBLY CONDITIONAL, SO A HEALTHY TICK PAYS NOTHING. `requiredCheckNames` is itself paid only by a tick
 * that saw a settled-red check, and this second call is made only when THAT one was refused. A tick that
 * reads the contexts successfully never reaches this function at all -- which is the `GH_READS` bargain,
 * not a new unconditional cost.
 *
 * FAIL OPEN LIKE ITS CALLER. The discriminator can be refused too, and a refused discriminator produces a
 * loud `cannot tell` rather than a guess in either direction: guessing ABSENT is the reading #2022
 * forbids, and guessing FORBIDDEN would hide a genuinely unprotected trunk.
 *
 * @param {{ run: (args: string[]) => string, error: unknown }} deps
 */
function refusedProtectionDiagnosis({ run, error }) {
  const why = String(/** @type {any} */ (error)?.message ?? error).split("\n")[0].trim();
  const isProtected = branchProtectedFlag(run);
  if (isProtected === true) {
    return `was REFUSED (${why}), and \`branches/main.protected\` reads \`true\` in the same tick, `
      + "so this is FORBIDDEN rather than ABSENT: classic branch protection is admin-only and this "
      + "credential has `permissions.admin: false` (#2022's discriminator).";
  }
  if (isProtected === false) {
    return `was REFUSED (${why}), and \`branches/main.protected\` reads \`false\`, so protection is `
      + "genuinely ABSENT -- a trunk-protection fact, not a credential one, and worth escalating.";
  }
  return `was REFUSED (${why}), and the discriminator \`branches/main.protected\` could not be read `
    + "either, so this tick CANNOT TELL forbidden from absent. #2022 forbids reading it as unprotected.";
}

/**
 * `main`'s `protected` flag: `true`, `false`, or `null` when even this could not be read.
 *
 * READABLE WITHOUT ADMIN, which is the entire reason it can answer a question the protection endpoint
 * refuses to. Anything that is not a boolean is `null`: a field that came back missing or reshaped tells
 * us nothing, and inventing a `false` from it is the exact reading #2022 rules out.
 *
 * @param {(args: string[]) => string} run
 * @returns {boolean | null}
 */
function branchProtectedFlag(run) {
  try {
    const value = JSON.parse(run(["api", "repos/{owner}/{repo}/branches/main", "--jq", ".protected"]));
    return typeof value === "boolean" ? value : null;
  } catch {
    return null;
  }
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
  return (prs ?? [])
    .filter((pr) => pr && pr.isDraft !== true && Number.isFinite(Number(pr.number)))
    // A DRAFT IS EXCLUDED AT THE SOURCE, NOT BY THE HOLD RULE: `gh pr merge --auto` refuses a draft
    // outright, so an unarmed draft is correct rather than stranded.
    .filter((pr) => armabilityOf({ labels: labelsOf(pr) }).arm)
    .filter((pr) => checksSettledGreen(
      blockingChecks(newestPerName(pr.statusCheckRollup ?? []), required)) === true)
    .map((pr) => Number(pr.number))
    .sort((a, b) => a - b);
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
 * @returns {{session: string, cause: string, subject: string, discriminator: string,
 *            prompt: string, causeKey: string}[]}
 */
export function greenUnarmedOrders(unarmed) {
  if (unarmed === null || unarmed.length === 0) return [];
  const key = unarmed.join(".");
  return [{
    session: "product-manager",
    cause: "pr-green-unarmed",
    subject: "pr-green-unarmed",
    discriminator: key,
    prompt: `${unarmed.length} pull request(s) are green on every required check, NOT held, and NOTHING `
      + `HAS ARMED THEM: ${unarmed.map((n) => `#${n}`).join(", ")}.\n`
      + "This is the state a refused arming credential produces, and it is invisible everywhere else: "
      + "`queue-stalled.mjs` names armed PRs that cannot merge, and a green unarmed one is the mirror "
      + "nothing reported until #1969. It is read here with the HOST's identity, never the arming PAT, "
      + "so this order survives the outage it reports.\n"
      + "FIRST ASK WHETHER THE CREDENTIAL IS REFUSING, because one PR unarmed and all of them unarmed "
      + "want different acts: read the newest `arm` job log in `auto-arm.yml` -- since #1969 it prints a "
      + "`SCOPE` line saying whether the refusal is about that one PR or repository-wide, and names the "
      + "minute the pool returns.\n"
      + "REPOSITORY-WIDE: nothing will arm anything until that minute. Arm these by hand with "
      + "`node packages/agent-org/src/arm-pr.mjs --pr=<n> --repo=" + REPO + "` under an identity whose "
      + "pool is alive -- the workflow's own documented exception for a PR auto-arm never armed -- and "
      + "say on #1969 that it recurred, with the window.\n"
      + "ONE PR ONLY: it is likelier that PR never got an arming event (opened while conflicting, or "
      + "reopened). Arming it is the same command.\n"
      + "IF A PR HERE SHOULD NOT MERGE, the answer is a `hold:` label or a `session:` label on the PR "
      + "itself -- both are read by the same predicate this order used, so it leaves this set at once. A "
      + "PR you merely skip stays in the set and this order returns unchanged.",
    causeKey: `product-manager/pr-green-unarmed/${key}`,
  }];
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
 * @param {any} pr @param {string[] | null} [required]
 */
function failingChecksOrder(pr, required = null) {
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
  // ITS OWN SESSION FIRST. Falling back to `product-manager` rather than dropping the order: an unlabelled
  // red PR is still a stalled PR, and the queue's first reader can find out whose it is.
  const session = sessionOf(pr) ?? "product-manager";
  return {
    session,
    cause: "pr-checks-failing",
    subject: `pr-${pr.number}`,
    discriminator: head8,
    prompt: `#${pr.number} at \`${head8}\` has FAILING checks and is blocked. `
      + `${sessionOf(pr) ? "It carries your session label, so it is yours to fix." : "It names no session."} `
      + "Read the failing job, fix the cause on that branch and push. If the failure is not yours to fix "
      + "or the PR should be closed, say so on the PR -- a red pull request nobody answers never lands.",
    causeKey: `${session}/pr-checks-failing/pr-${pr.number}/${head8}`,
  };
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
 *        byIsAuthor: boolean | null}} found @param {string} head8
 */
function notConvincedOrder(pr, found, head8) {
  const owner = sessionOf(pr);
  const session = owner ?? "product-manager";
  const from = found.by ? ` from ${found.by}` : "";
  const prompt = owner
    ? `#${pr.number} at \`${head8}\` carries a NOT CONVINCED verdict${from} and it carries your session `
      + "label, so the rework is yours. Read the verdict, fix what it names on that branch and push. If "
      + "you believe the verdict is wrong, that is a DISPUTE rather than rework: say so on the PR and "
      + "product-manager decides. A refused verdict nobody answers is a pull request that never lands."
    : `#${pr.number} at \`${head8}\` carries a NOT CONVINCED verdict${from} and nothing has moved since. `
      + "Read the verdict, decide whether it stands, and route the rework to the session holding that "
      + "row -- or close the PR if the row was wrong. A refused verdict nobody answers is a pull request "
      + "that never lands.";
  return {
    session,
    cause: "verdict-not-convinced",
    subject: `pr-${pr.number}`,
    discriminator: head8,
    prompt,
    causeKey: `${session}/verdict-not-convinced/pr-${pr.number}/${head8}`,
  };
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
 * @param {any} pr @param {{verdict: string | null, by: string | null,
 *        byIsAuthor: boolean | null}} found @param {string} head8
 */
function settledVerdictOrder(pr, found, head8) {
  if (found.verdict === "convinced" && pr.isDraft) {
    return {
      session: "product-manager",
      cause: "draft-convinced-not-ready",
      subject: `pr-${pr.number}`,
      discriminator: head8,
      prompt: `Draft #${pr.number} at \`${head8}\` is green and carries a CONVINCED verdict`
        + `${found.by ? ` from ${found.by}` : ""}, and is still a draft. Per agent-practices a product `
        + "PR is marked ready once the reviewer is convinced. Mark it ready for review, or say on the PR "
        + "why it must stay a draft -- an unexplained convinced draft is work nobody is finishing.",
      causeKey: `product-manager/draft-convinced-not-ready/pr-${pr.number}/${head8}`,
      // THE GATE ALREADY KNOWS THE ANSWER, SO IT DOES THIS ONE ITSELF (see `performActions`). Every
      // condition for a safe ready-flip has been checked by the time we are here: not red, still a
      // draft, checks SETTLED green, and a convinced verdict AT THIS HEAD. The order stays attached as
      // the FALLBACK -- if `gh pr ready` fails, `product-manager` is woken exactly as before.
      //
      // `byIsAuthor === false` AND NOT `!== true`, deliberately. `verdictAtHead` returns `null` when the
      // opener named nobody (#1244) and refuses to guess, and a self-signed or unattributed verdict is
      // the one case where a human should look. Automating the attributed case and waking on the rest
      // keeps `ceo`'s one-in-five spot-check pointed at the verdicts that can actually be wrong.
      ...(found.byIsAuthor === false ? { action: { kind: "ready", pr: Number(pr.number) } } : {}),
    };
  }
  if (found.verdict === "not-convinced") return notConvincedOrder(pr, found, head8);
  // Any other settled verdict -- `unrecognised`, or one the opener did not attribute -- is left alone:
  // re-prompting a reviewer who has already answered costs more than waiting for a human to look.
  return null;
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
 * @param {any} pr @param {string[] | null} [required]
 */
function draftOrder(pr, required = null) {
  // RED FIRST, and before the draft check: a red PR is work whether or not it is a draft, and it can
  // never reach the reviewer lane below, which requires green.
  const red = failingChecksOrder(pr, required);
  if (red) return red;
  if (!pr?.isDraft) return null;
  if (checksSettledGreen(newestPerName(pr.statusCheckRollup)) !== true) return null;
  const head = String(pr.headRefOid ?? "");
  if (!head) return null;
  const found = verdictAtHead({
    comments: (pr.comments ?? []).map((/** @type {any} */ c) => ({ body: c?.body ?? "", id: c?.id })),
    head,
    prAuthor: pr.author?.login ?? null,
  });
  const head8 = head.slice(0, 8);
  // A VERDICT THE OPENER DID NOT ATTRIBUTE COUNTS AS SETTLED, and that is the wake side's default rather
  // than a reading of the comment: `verdictAtHead` returns `byIsAuthor: null` for it and refuses to guess
  // (#1244). Waking anyway would re-prompt a reviewer who has already answered; the cost of being wrong
  // the other way is one author-written verdict going unchallenged, which `ceo`'s spot-check of one
  // verdict in five is the control for.
  if (found.verdict !== null) return settledVerdictOrder(pr, found, head8);

  // ODD/EVEN PARITY IS THE ORG'S OWN SPLIT (`.claude/rules/agent-practices.md`): odd PR numbers go to
  // `reviewer`, even to `reviewer-2`. Stated there, applied here, spelled in neither twice -- and since
  // #2127 the arithmetic itself lives in `review-attribution.mjs`, beside the reader that checks whether
  // a posted review obeyed it. A detector with its own copy would agree with a router that had drifted.
  const session = parityOwner(pr.number);
  return {
    session,
    cause: "draft-awaiting-verdict",
    subject: `pr-${pr.number}`,
    discriminator: head8,
    prompt: `Draft #${pr.number} at \`${head8}\` has settled green checks and no verdict at that head. `
      + "Review it per packages/agent-org/docs/roles/reviewer.md and leave one comment carrying your verdict.",
    causeKey: `${session}/draft-awaiting-verdict/pr-${pr.number}/${head8}`,
  };
}

/**
 * One order per unclaimed Ready row, oldest first, capped.
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
  // OLDEST FIRST, because a queue that hands out its newest rows first starves its oldest -- and the
  // number is a row number, so ascending IS oldest.
  const oldestFirst = [...unclaimed].sort((a, b) => Number(a.number) - Number(b.number));
  for (const row of oldestFirst.slice(0, MAX_ROW_ORDERS_PER_TICK)) {
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
        + "The claim creates that worktree for you; run the command from the primary checkout, then do all "
        + "the work inside the new worktree rather than the primary.\n"
        + "If the claim is refused because someone took it first, that is an answer: stop and say so.",
      causeKey: `${owner ?? "engineers"}/ready-row-unclaimed/${row.number}`,
    });
  }

  return orders;
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
 *           openRows?: any[], unarmed?: number[] | null }} state
 *        `required` is the checks that can block a merge (`requiredCheckNames`), or `null` for
 *        "could not be read", which counts EVERY check as before this existed.
 *        `epics` are the open `epic` rows with their `subIssuesSummary` (`readEpics`); `[]` when
 *        refused or when the shelf was not empty enough to ask.
 *        `promotableRows` are the backlog rows carrying no unpickable label; `chairmanBlocked` are
 *        the rows waiting on the chairman, oldest first. `[]` for either when refused or empty.
 *        `prFiles` is `comparablePrFiles(prs)` -- the open PRs B4 may be asked about. It DEFAULTS TO
 *        `[]`, which means "no overlap is knowable", so every row is offered: the same behaviour as
 *        before B4 shelving existed, and the reason a caller that cannot read files is never worse off.
 *        `unarmed` is `readUnarmed(shouldBeMerging(prs, required))` -- the green, unheld pull requests
 *        the API says nothing has armed. It DEFAULTS TO `null`, which is "not asked or refused" and
 *        emits no order: a caller that cannot make that read must never produce a false all-clear, and
 *        must never produce a false alarm either.
 * @returns {{session: string, cause: string, subject: string, discriminator: string,
 *            prompt: string, causeKey: string}[]}
 */
export function decide({ prs, readyRows, promotableRows = [], chairmanBlocked = [], prFiles = [],
  drain = false, required = null, epics = [], answerOwed = [], openRows = [], unarmed = null }) {
  // FIRST, BEFORE EVERY OTHER CAUSE. Every other order asks a session what should happen next; this one
  // says another session is ALREADY STOPPED waiting on them. That outranks any standing question.
  const orders = [...answerOrders(answerOwed)];
  // SECOND, AND FOR THE SAME REASON ONE LEVEL IN (#2027). A session holding a row whose last blocker just
  // closed is not waiting on a decision -- it is stopped on work it can resume this minute, with whatever
  // is queued behind that row stopped with it. Ahead of every cause that offers NEW work: a row already
  // claimed and now runnable beats a row nobody has picked up.
  orders.push(...blockerClearedOrders(openRows));

  for (const pr of prs) {
    const order = draftOrder(pr, required);
    if (order) orders.push(order);
  }
  const { offerable, blocked } = partitionUnclaimed(readyRows, prFiles);
  orders.push(...rowOrders(offerable));


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

function main() {
  refuseUnknownFlags([], { entry: import.meta.url, command: "node packages/agent-org/src/work-gate.mjs" });
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
  // #1969: NAMED RATHER THAN CALLED TWICE. `shouldBeMerging` needs the same answer `decide` does, and
  // `requiredWhenRed` makes a `gh` call when anything is red -- calling it inline in both places would
  // pay for it twice on exactly the red tick this row is about.
  const required = requiredWhenRed(openPrs);
  const decided = decide({ prs: openPrs, readyRows: rows, promotableRows: promotableRows ?? [],
    chairmanBlocked: chairmanBlocked ?? [], prFiles, drain, required,
    epics: epicsWhenShelfEmpty(rows),
    answerOwed: withAnswerLabel(allOpen), openRows: allOpen,
    // #1969: CONDITIONAL, and the condition is answered for free from the list already in hand.
    // `shouldBeMerging` reads `openPrs`; only if it finds a green, unheld, non-draft PR is the
    // merge-queue call made at all.
    unarmed: readUnarmed(shouldBeMerging(openPrs, required)) });
  const { delivered: orders, performed } = performActions(decided);
  orders.push(...deadMansSwitch({ orders, drain, performed, openRows: openRowsRead }));
  for (const order of orders) process.stdout.write(`${JSON.stringify(order)}\n`);

  // BOTH SHELVES ON ONE LINE-SHAPE. The engineer pool's B4/declared-wait shelvings and the fleet batch's
  // (#2027) are the same fact -- work the gate can see and is deliberately not offering -- and a row that
  // leaves a set silently is the defect both filters exist to fix.
  reportWithheld({ drain, blocked: [...partitionUnclaimed(rows, prFiles).blocked,
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

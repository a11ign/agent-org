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
// IT COSTS TWO `gh` CALLS. `gh pr list --json number,isDraft,headRefOid,statusCheckRollup,author,comments`
// answers the whole reviewer lane in one (comments included -- that is what makes the verdict question
// free), and one `gh issue list --label ready` answers the engineers'. At two calls it can run every two
// minutes all day inside the rate limit, which is the property the whole design rests on.
//
// THIS SCRIPT DECIDES NOTHING ABOUT WHO IS FREE. It answers "is there work", never "who should take it":
// that needs `herdr agent list`'s `agent_status`, and putting it here would make the gate untestable
// without a running org and unrunnable from CI. `wake.mjs` owns that half; `row-claim.mjs` remains the
// authority on whether a row is actually yours.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
// RELATIVE, not the package specifier -- this must run before any `npm ci`/build, the same constraint
// `org-watch.mjs` and `build-packages.mjs` state at their own imports.
import { refuseUnknownFlags } from "../../worker-fleet/src/cli-flags.mjs";
import { READY_LABEL, CLAIM_LABEL } from "./claim-labels.mjs";
import { verdictAtHead } from "./review-verdict.mjs";
import { newestPerName } from "./newest-check-run.mjs";

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
export const CAUSES = ["draft-awaiting-verdict", "ready-row-unclaimed"];

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
      "number,isDraft,headRefOid,statusCheckRollup,author,comments,labels"]);
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : null;
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
 */
export const NOT_PICKABLE = Object.freeze(["blocked", "fleet-gated", "epic", "disputed", "decision",
  "awaiting-merge", "review-only", CLAIM_LABEL]);

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
    const out = run(["issue", "list", "--state", "open", "--label", "backlog", "--limit", "200",
      "--json", "number,labels"]);
    const parsed = JSON.parse(out);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((r) => !labelsOf(r).some((/** @type {string} */ n) => NOT_PICKABLE.includes(n)));
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
      "--json", "number,title,labels"]);
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
  const state = (/** @type {any} */ c) => String(c?.conclusion ?? c?.state ?? "").toUpperCase();
  const status = (/** @type {any} */ c) => String(c?.status ?? "").toUpperCase();
  if (rollup.some((c) => status(c) === "IN_PROGRESS" || status(c) === "QUEUED" || status(c) === "PENDING")) {
    return null;
  }
  const bad = ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"];
  return !rollup.some((c) => bad.includes(state(c)));
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
 * @param {any} pr
 */
function failingChecksOrder(pr) {
  if (checksSettledGreen(newestPerName(pr.statusCheckRollup)) !== false) return null;
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
 * The follow-up a SETTLED verdict deserves, or `null` when it deserves none.
 *
 * A VERDICT IS NOT THE END OF THE WORK, AND READING IT AS ONE LEFT PULL REQUESTS ABANDONED. The gate used
 * to say `if (found.verdict !== null) continue;` -- a verdict existed, so it moved on WITHOUT EVER ASKING
 * WHAT IT SAID. Measured 2026-09-17, hours after the tick went live: #1640 and #1634 had been green,
 * reviewed and CONVINCED AT HEAD since 2026-09-14 and were still drafts, and the gate called that a quiet
 * org for three days. `agent-practices.md` says a product PR "is marked ready only when the reviewer
 * writes convinced"; nothing asked whether that had been ACTED ON.
 *
 * BOTH GO TO `product-manager`, whose brief names exactly this work: first reader for "the queue and
 * process ... promotions, claim reports, merge close-outs". The PR's author cannot route either one --
 * every PR here is opened by the shared `a11ign-ai-workers` account, so there is no session in it to wake.
 *
 * @param {any} pr @param {{verdict: string | null, by: string | null}} found @param {string} head8
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
    };
  }
  if (found.verdict === "not-convinced") {
    return {
      session: "product-manager",
      cause: "verdict-not-convinced",
      subject: `pr-${pr.number}`,
      discriminator: head8,
      prompt: `#${pr.number} at \`${head8}\` carries a NOT CONVINCED verdict`
        + `${found.by ? ` from ${found.by}` : ""} and nothing has moved since. Read the verdict, decide `
        + "whether it stands, and route the rework to the session holding that row -- or close the PR if "
        + "the row was wrong. A refused verdict nobody answers is a pull request that never lands.",
      causeKey: `product-manager/verdict-not-convinced/pr-${pr.number}/${head8}`,
    };
  }
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
 * @param {any} pr
 */
function draftOrder(pr) {
  // RED FIRST, and before the draft check: a red PR is work whether or not it is a draft, and it can
  // never reach the reviewer lane below, which requires green.
  const red = failingChecksOrder(pr);
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
  // `reviewer`, even to `reviewer-2`. Stated there, applied here, spelled in neither twice.
  const session = Number(pr.number) % 2 === 1 ? "reviewer" : "reviewer-2";
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
 * @param {any[]} readyRows
 */
function rowOrders(readyRows) {
  const orders = [];
  // UNCLAIMED IS `ready` WITHOUT `in-progress`. This is a CANDIDATE, not a grant: `row-claim.mjs` is the
  // authority and the woken engineer runs it. A gate that claimed rows would be a second writer of the
  // claim state, which is the race #176 already cost this repo once.
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
  const unclaimed = readyRows.filter((r) => !labelsOf(r).includes(CLAIM_LABEL));
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
  for (const [lane, owner] of Object.entries(LANE_OWNER)) {
    const mine = promotableRows.filter((r) => labelsOf(r).includes(lane));
    const readyHere = readyRows.filter((r) => labelsOf(r).includes(lane)
      && !labelsOf(r).includes(CLAIM_LABEL));
    if (mine.length === 0 || readyHere.length > 0) continue;
    orders.push({
      session: owner,
      cause: "lane-backlog-unpromoted",
      subject: lane,
      // The count is the discriminator, so the order stops once the owner promotes one and re-fires if
      // the lane empties again at a different depth -- the same shape as `ready-queue-empty`.
      discriminator: String(mine.length),
      prompt: `Your lane \`${lane}\` has ${mine.length} open backlog row(s) and NOTHING Ready: `
        + `${mine.slice(0, 8).map((/** @type {any} */ r) => `#${r.number}`).join(", ")}`
        + `${mine.length > 8 ? ", ..." : ""}. Nobody else may promote these -- the lane is yours.\n`
        + "Promote what is genuinely ready (a Region, an Acceptance, a done-when), answer what is waiting "
        + "on a decision, and say so on anything that should stay put. Promoting nothing and recording "
        + "why is a valid answer; this is a report of what is waiting on you, not a quota.",
      causeKey: `${owner}/lane-backlog-unpromoted/${lane}/${mine.length}`,
    });
  }
  return orders;
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
 * @param {{ prs: any[], readyRows: any[], promotableRows?: any[], chairmanBlocked?: any[] }} state
 *        `promotableRows` are the backlog rows carrying no unpickable label; `chairmanBlocked` are
 *        the rows waiting on the chairman, oldest first. `[]` for either when refused or empty.
 * @returns {{session: string, cause: string, subject: string, discriminator: string,
 *            prompt: string, causeKey: string}[]}
 */
export function decide({ prs, readyRows, promotableRows = [], chairmanBlocked = [] }) {
  const orders = [];

  for (const pr of prs) {
    const order = draftOrder(pr);
    if (order) orders.push(order);
  }
  orders.push(...rowOrders(readyRows));


  // THE SHELF ITSELF IS WORK, and nothing asked about it until 2026-09-17. Measured that day: 92 open
  // issues, 87 of them `backlog`, ZERO `ready`, and five engineers idle. The gate's engineer question is
  // "a `ready` row without `in-progress`", which was honestly no -- so it reported a quiet org while every
  // engineer waited behind an empty queue. `dispatcher` is retired and its brief's line survives it:
  // "the Ready column. It pulls; THIS ROLE STOCKS." The stocker had no trigger.
  //
  // FACTS, NOT A TARGET, and that distinction is the whole design. `product-manager`'s brief says Ready
  // holds at least three product rows; this does not ask for three. `ready:audit` exists because
  // `dispatcher` once labelled two rows `ready` TO HIT THAT FLOOR -- one disputed, one with no Region or
  // Acceptance -- and recorded the rule this obeys: *"a floor met by a label I control is not a
  // measurement."* A number here would buy relabelling. The order reports what is on the shelf and what
  // is behind it; which rows are genuinely promotable is a judgment and stays with the reader.
  //
  // ONLY WHEN THE SHELF IS EMPTY. A queue with anything in it is a queue the engineers can pull from, and
  // re-prompting on a short-but-non-empty Ready would be the floor by another name.
  // THE POOL'S SHELF, NOT THE WHOLE SHELF, and that distinction had three engineers idle. This counted
  // every unclaimed Ready row, so 14 rows Ready read as a well-stocked queue -- while 11 of them were
  // `lane:ceo` and 3 `lane:orchestrator` and NOT ONE was takeable by an engineer. Measured 2026-09-18,
  // minutes after lane routing shipped: ceo and orchestrator woke, promoted their own lanes, and went to
  // work, and the pool stayed starved because the shelf now looked full.
  //
  // It is the original empty-shelf defect one level down: a queue full of work nobody in that pool may
  // take is an EMPTY QUEUE TO THEM. `laneOwnerOf` already says who a row belongs to; a row with an owner
  // is somebody's, and the lane orders above are what ask them about it.
  const poolRows = readyRows.filter((r) => !labelsOf(r).includes(CLAIM_LABEL) && laneOwnerOf(r) === null);
  // The backlog is counted the same way, or the order would report rows the pool equally cannot take.
  const poolPromotable = promotableRows.filter((r) => laneOwnerOf(r) === null);
  const promotable = poolPromotable.length;
  if (poolRows.length === 0 && promotable > 0) {
    orders.push({
      session: "product-manager",
      cause: "ready-queue-empty",
      subject: "ready-queue",
      // THE COUNT IS THE DISCRIMINATOR, so the order stops repeating the moment a row is promoted and
      // re-fires if the shelf empties again at a different depth. Keyed on anything constant it would
      // nag every two minutes until someone acted, which is how a wake becomes noise to route around.
      discriminator: String(promotable),
      prompt: `The Ready queue has NOTHING an engineer may take -- every unclaimed row belongs to a `
        + `lane -- and ${promotable} unlaned backlog row(s) carry no label that means `
        + "unpickable (not blocked, fleet-gated, epic, disputed, decision, awaiting-merge, review-only or "
        + "already claimed). Every engineer is waiting on this queue rather than on work.\n"
        + "Promote what is genuinely ready -- a row with a Region, an Acceptance and a done-when -- and "
        + "leave the rest. This is deliberately NOT a request to reach a count: #ready:audit records "
        + "`dispatcher` labelling two rows ready to hit a floor, one disputed and one with neither field, "
        + "and a floor met by a label you control is not a measurement. Promoting nothing and saying why "
        + "is a valid answer.",
      causeKey: `product-manager/ready-queue-empty/${promotable}`,
    });
  }

  orders.push(...laneBacklogOrders(promotableRows, readyRows));


  orders.push(...chairmanOrders(chairmanBlocked));


  return orders;
}

function main() {
  refuseUnknownFlags([], { entry: import.meta.url, command: "node packages/agent-org/src/work-gate.mjs" });
  const prs = readPrs();
  const readyRows = readReadyRows();

  // BOTH LANES REFUSED IS `CANNOT_ASK`; ONE IS `PARTIAL`. Nothing here may report a refused read as quiet.
  if (prs === null && readyRows === null) {
    process.stderr.write("CANNOT ASK: neither the pull-request list nor the Ready rows could be read. "
      + "Nothing was examined -- this is NOT a quiet queue, and no session has been woken.\n");
    process.exit(EXIT.CANNOT_ASK);
  }

  // The third read is only needed to size the refill, and a refused one must not read as an empty shelf.
  const promotableRows = readPromotableRows();
  const chairmanBlocked = readChairmanBlocked();
  const orders = decide({ prs: prs ?? [], readyRows: readyRows ?? [],
    promotableRows: promotableRows ?? [], chairmanBlocked: chairmanBlocked ?? [] });
  for (const order of orders) process.stdout.write(`${JSON.stringify(order)}\n`);

  if (prs === null || readyRows === null) {
    process.stderr.write(`PARTIAL: could not read ${prs === null ? "the pull-request list" : "the Ready rows"}. `
      + `The ${orders.length} order(s) above are real; that lane was NOT examined and may hold work.\n`);
    process.exit(EXIT.PARTIAL);
  }
  process.exit(orders.length > 0 ? EXIT.WORK : EXIT.QUIET);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();

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
import { newestPerName } from "./newest-check-run.mjs";
// B4, ASKED EARLY. These are the SAME two functions `row-claim.mjs` runs at claim time, imported
// rather than reimplemented: `region-paths.mjs`'s own header records why a second copy of "what
// counts as a path" is not allowed to exist. Both are leaf-shaped and relative, so the gate keeps the
// property its own header states -- it runs before any `npm ci` or build.
import { declaredRegionFiles } from "./region-paths.mjs";
import { fileOverlapReason } from "./row-claim/file-overlap-rule.mjs";

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
  "chairman-blocked", "org-stalled"];

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
  "chairman-blocked", "org-stalled"]);

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
 */
export const START_CAUSES = Object.freeze(["ready-row-unclaimed", "ready-queue-empty",
  "lane-backlog-unpromoted", "org-stalled"]);

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
      "number,isDraft,headRefOid,statusCheckRollup,author,comments,labels,files,changedFiles"]);
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
      "--json", "number,title,labels,body"]);
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
 * @param {any[]} prs
 * @returns {{ number: number, files: string[], changedFiles: number }[]}
 */
export function comparablePrFiles(prs) {
  return prs
    .map((p) => ({
      number: Number(p?.number),
      changedFiles: Number(p?.changedFiles),
      files: (p?.files ?? []).map((/** @type {any} */ f) => String(f?.path ?? f)),
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
 * @param {any} row @param {{ number: number, files: string[], changedFiles: number }[]} prFiles
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
  return fileOverlapReason(mine, prFiles).reason;
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
  for (const row of readyRows) {
    if (labelsOf(row).includes(CLAIM_LABEL)) continue;
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
        + "on a decision, and say so on anything that should stay put. This is a report of what is "
        + "waiting on you, not a quota: promoting nothing and recording why is a valid answer.\n"
        // RECORDED ON THE ROW, NOT IN THE TERMINAL, and this sentence exists because that is exactly what
        // went wrong: `orchestrator` reached a correct and well-argued answer on #1564 -- research row,
        // no Acceptance, waiting on a ceo ruling -- and wrote it only to its own screen. The org cannot
        // read a terminal. Nothing changed, so nothing downstream could tell the question had been
        // answered rather than ignored.
        + "RECORD THE ANSWER ON THE ROW, as a comment, whatever it is. A decision that exists only in "
        + "your terminal is one the org cannot see: the next reader finds an untouched row and has to "
        + "derive your conclusion again from scratch.",
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
      ? `${poolBlocked.length} unlaned row(s) (${poolBlocked.map((b) => `#${b.number}`).join(", ")}) are `
        + "B4-blocked behind an open pull request that already touches their Region"
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
        ? "The B4-blocked rows are NOT rows to promote past: each is waiting on a pull request, and the "
          + "work that frees it is that PR's. Promoting a row whose Region overlaps the same files only "
          + "moves the refusal.\n"
        : "")
      + "Promote what is genuinely ready -- a row with a Region, an Acceptance and a done-when -- and "
      + "leave the rest. This is deliberately NOT a request to reach a count: #ready:audit records "
      + "`dispatcher` labelling two rows ready to hit a floor, one disputed and one with neither field, "
      + "and a floor met by a label you control is not a measurement. Promoting nothing and saying why "
      + "is a valid answer.",
    causeKey: `product-manager/ready-queue-empty/${promotable}`,
  };
}

/**
 * Every open row, counted -- ONLY asked when the gate would otherwise say nothing.
 *
 * THE THIRD CALL, AND WHY IT DOES NOT BREAK THE TWO-CALL PROPERTY. This file's header rests on costing
 * two `gh` calls so it can run every two minutes all day. This read happens only when the other two
 * produced NO ORDERS -- a busy org never pays it, and a silent one pays it once to answer the question
 * its own silence raises. The steady state is unchanged.
 *
 * @param {(args: string[]) => string} [run]
 * @returns {number | null} `null` when refused -- never 0, which would read as "the tracker is empty"
 */
export function readOpenRowCount(run = defaultRun) {
  try {
    const parsed = JSON.parse(run(["issue", "list", "--state", "open", "--limit", "500", "--json", "number"]));
    return Array.isArray(parsed) ? parsed.length : null;
  } catch {
    return null;
  }
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
 * @param {{ orders: unknown[], openRows: number | null }} state
 */
export function stalledOrder({ orders, openRows }) {
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
      + "row(s) are open, so every session is idle and will stay idle: no draft needs a verdict, no row "
      + "is claimable, no check is red, nothing is promotable.\n"
      + "That is NOT the org being finished. It means every open row carries something that stops it -- "
      + "`blocked`, `fleet-gated`, `epic`, a lane, a claim -- and no cause can see past any of it.\n"
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
 *           drain?: boolean }} state
 *        `promotableRows` are the backlog rows carrying no unpickable label; `chairmanBlocked` are
 *        the rows waiting on the chairman, oldest first. `[]` for either when refused or empty.
 *        `prFiles` is `comparablePrFiles(prs)` -- the open PRs B4 may be asked about. It DEFAULTS TO
 *        `[]`, which means "no overlap is knowable", so every row is offered: the same behaviour as
 *        before B4 shelving existed, and the reason a caller that cannot read files is never worse off.
 * @returns {{session: string, cause: string, subject: string, discriminator: string,
 *            prompt: string, causeKey: string}[]}
 */
export function decide({ prs, readyRows, promotableRows = [], chairmanBlocked = [], prFiles = [],
  drain = false }) {
  const orders = [];

  for (const pr of prs) {
    const order = draftOrder(pr);
    if (order) orders.push(order);
  }
  const { offerable, blocked } = partitionUnclaimed(readyRows, prFiles);
  orders.push(...rowOrders(offerable));


  // The backlog is counted the same way, or the order would report rows the pool equally cannot take.
  const poolPromotable = promotableRows.filter((r) => laneOwnerOf(r) === null);
  const shelf = emptyShelfOrder({ offerable, blocked, promotable: poolPromotable.length });
  if (shelf) orders.push(shelf);

  orders.push(...laneBacklogOrders(promotableRows, readyRows));


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
 * @param {unknown[]} orders @param {boolean} drain
 */
function deadMansSwitch(orders, drain, performed = 0) {
  // A PERFORMED ACTION IS ACTIVITY. Without this the gate could mark a draft ready, emit no order, and
  // then announce the org as stalled in the same tick -- reporting the one thing it just did as nothing.
  if (drain || orders.length > 0 || performed > 0) return [];
  const stalled = stalledOrder({ orders, openRows: readOpenRowCount() });
  return stalled ? [stalled] : [];
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
  const prFiles = comparablePrFiles(prs ?? []);
  const drain = draining();
  const decided = decide({ prs: prs ?? [], readyRows: readyRows ?? [],
    promotableRows: promotableRows ?? [], chairmanBlocked: chairmanBlocked ?? [], prFiles, drain });
  const { delivered: orders, performed } = performActions(decided);
  orders.push(...deadMansSwitch(orders, drain, performed));
  for (const order of orders) process.stdout.write(`${JSON.stringify(order)}\n`);

  reportWithheld({ drain, blocked: partitionUnclaimed(readyRows ?? [], prFiles).blocked });

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

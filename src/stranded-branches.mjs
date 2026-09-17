#!/usr/bin/env node
// command: find pushed branches with no open PR, which are otherwise invisible to CI and review
// A PUSHED BRANCH WITH NO PR IS INVISIBLE, and nothing in this repo could find one (#247).
//
// `agent/ssh-key-defaults` sat pushed for ELEVEN HOURS carrying a finished security fix. No PR was ever
// opened, so no CI ever ran on it and no merge path existed for it -- found by a human reading a branch
// list while looking for something else.
//
// TWO EXISTING CHECKS CANNOT SEE THIS, BY DESIGN, NOT BY GAP:
//   `worktrees:prune` asks whether a branch is MERGED into origin/main -- the wrong question for a branch
//   that was never even proposed. It correctly leaves an unmerged, no-PR branch alone, silently.
//   `merge-guard` takes a PR NUMBER. A branch with no PR has nothing to ask it about.
//
// THE OBVIOUS HAND-ROLLED CHECK IS DEFEATED BY SQUASH MERGES, and this is the part worth recording.
// `git rev-list --count origin/main..origin/<branch>` reads > 0 for EVERY branch this repo squash-merges,
// because the squash commit is a different object from anything on the branch -- the same two-dot/three-dot
// diffing trap `row-reachability.mjs` already documents for held regions. Run over every pushed branch,
// this named 66 of 134 -- nearly all already landed. A check with that false-positive rate is unreadable.
//
// SO THE FILTER IS TWO STAGES, IN THIS ORDER, and the order is what makes the second stage trustworthy:
//   1. Has this branch EVER had a PR, of ANY state (open, closed, merged)? Asked of GitHub, never inferred
//      from git -- "PR state is the record git cannot reconstruct." A squash merge REQUIRES a PR to have
//      existed, so a branch with NO PR at all cannot have been squash-merged: the confound that defeats
//      rev-list-count on the full population cannot occur inside this narrower one.
//   2. ONLY for branches that pass stage 1 (no PR ever): does it still carry commits `origin/main` lacks?
//      Here `git rev-list --count` is a fact, not a false-positive machine, because stage 1 already ruled
//      out the one way it lies.
//
// THIS REPORTS CANDIDATES, NEVER CERTAINTIES. A first attempt at fully automated verification ("is the
// content REALLY absent from main") reported all eleven real candidates as IDENTICAL to main and was
// wrong -- `git diff --stat A B -- $FILES | tail -1` produced empty output on an EMPTY file list, and
// `${VAR:-IDENTICAL}` printed a clean verdict over the empty string. A check that reports clean having
// examined nothing, built inside the investigation of a missing check. A rebase whose content landed under
// a DIFFERENT branch's PR produces the identical shape (no PR of its own, commits ahead) and is not
// stranded -- distinguishing that from genuine stranded work needs a human reading the branch's own diff,
// which is exactly why this NAMES candidates rather than asserting a finding.
//
//   npm run branches:stranded
//
// Exit codes:
//   0  OK           -- pushed branches examined, none are candidates
//   1  CANDIDATE(S) -- named, one line each; this repo's own convention (row-reachability, ready-label-
//                      audit) of reporting rather than blocking anything
//   2  CANNOT ASK   -- a lookup failed. INCONCLUSIVE, never a clean sweep over an unreadable board. With
//                      --close, also a write that failed before any PR was commented on or closed: nothing
//                      was changed (#1480).
//   3  LANDED, THEN FAILED -- --close only: a PR had already been commented on or closed when a later `gh`
//                      call failed. The error line names every PR closed and the one command that is safe to
//                      run next, so a half-done sweep never reads as nothing done (#1480).
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { refuseUnknownFlags, flagValue } from "@a11ign/worker-fleet/cli-flags";
import { REPO } from "../../../scripts/repo-identity.mjs";
import { sandboxGitEnv } from "../../guards/src/git-env.mjs";
import { assertNoLeakInArgv } from "../../lab/src/packaging/leak-patterns.mjs";

export const EXIT = { OK: 0, CANDIDATES: 1, CANNOT_ASK: 2, LANDED_THEN_FAILED: 3 };

/** @type {(cmd: string, args: string[]) => string} */
const defaultRun = (cmd, args) => {
  assertNoLeakInArgv(cmd, args); // #1053: guarded in the SPAWN HELPER, so every call site here is covered
  return execFileSync(cmd, args,
    { encoding: "utf8", env: sandboxGitEnv(), stdio: ["ignore", "pipe", "pipe"] });
};
/** @param {string} line */
const writeOut = (line) => { process.stdout.write(line); };
/** @param {string} line */
const writeErr = (line) => { process.stderr.write(line); };

/**
 * Every branch pushed under `origin/agent/*` or `origin/lead/*` -- the two prefixes this repo's own
 * worktree/branch convention uses (see `prune-worktrees.mjs`'s `isStandingBranch`) -- with the `origin/`
 * prefix stripped so it matches a PR's `headRefName` verbatim.
 *
 * @param {{ run?: typeof defaultRun }} [deps]
 * @returns {string[]}
 */
export function fetchPushedBranches({ run = defaultRun } = {}) {
  /** @type {string} */
  let raw;
  try {
    raw = run("git", ["for-each-ref", "--format=%(refname:short)",
      "refs/remotes/origin/agent", "refs/remotes/origin/lead"]);
  } catch (cause) {
    throw new Error(`stranded-branches: could not list pushed branches -- refusing to guess. `
      + `${/** @type {Error} */ (cause).message}`, { cause });
  }
  return raw.split("\n").map((l) => l.trim()).filter(Boolean).map((r) => r.replace(/^origin\//, ""));
}

/**
 * The OPEN-PR listing's cap, and it is a REFUSAL BOUNDARY rather than a page size.
 *
 * `gh pr list` returns NEWEST-first, so a truncating `--limit` drops the OLDEST PRs. `gh` exits 0 whether
 * that is genuinely every PR or the first `PR_LIST_LIMIT` of more, and nothing in the response tells the
 * two apart -- so arriving AT it is the CANNOT-ASK state this file already has an exit code for, never a
 * performance setting to be raised (#321).
 *
 * IT NO LONGER BOUNDS `fetchAllPRHeadRefs`. That listing crossed 400 on 2026-09-09 and refused, exactly
 * as built; the fix is to PAGINATE TO THE END rather than to write a bigger number, because a bigger
 * number moves the cliff without removing it. `fetchOpenPRs` keeps the cap: its population is the OPEN
 * PRs (4 at the time of writing, against a limit of 400), so the cap there is not a paging bound anybody
 * expects to reach, and reaching it would mean something has gone very wrong rather than that the repo
 * grew.
 *
 * Contrast #286's `--limit 100` on a SCHEDULE workflow: there, 100 consecutive non-schedule runs *is
 * itself the finding* the check exists to report, so hitting that bound is a correct answer, not a
 * truncation -- the two look identical in the code and are opposite in meaning.
 */
export const PR_LIST_LIMIT = 400;

/** REST's maximum page size. Fewer, larger calls is the whole point of paginating over `gh pr list`. */
export const PR_PAGE_SIZE = 100;

/**
 * A runaway bound on the page walk, NOT a population bound: 100 pages is 10,000 PRs. Reaching it THROWS
 * for the same reason arriving at `PR_LIST_LIMIT` did -- a walk that stops at a limit cannot say whether
 * it reached the end -- so #321's lesson survives the move rather than being deleted with the constant
 * that carried it.
 */
export const MAX_PR_PAGES = 100;

/**
 * Every branch name that has EVER had a PR opened against it, in ANY state, PAGINATED TO THE END.
 *
 * THROWS on failure -- never an empty Set standing in for "no PR anywhere", which would read every pushed
 * branch as stranded. The same vacuity guard as `fetchOpenIssues`/`fetchLabels` elsewhere in this repo,
 * aimed at the opposite direction: there the danger is under-reporting a claim, here it is OVER-reporting
 * a stranded branch, and this file's stage-1 filter is "has this branch EVER had a PR" -- a PR dropped
 * off the end does not make the tool MISS a stranded branch, it makes the tool MANUFACTURE one.
 *
 * REST (`gh api`, core) rather than `gh pr list` (GraphQL). MEASURED, 2026-09-09 16:3xZ, against the
 * real repo: one `gh pr list --state all --limit 400 --json headRefName` cost **107 GraphQL points**.
 * Attributed rather than inferred -- a trivial probe either side of it moved the counter by exactly 1,
 * so the window was quiet and the 107 is this command's, not the account's. The same population over
 * REST is 5 core calls.
 *
 * 107 IS NOT THE EXHAUSTION, AND SAYING SO WOULD BE THE COMFORTABLE ERROR. The GraphQL pool reached
 * 5000/5000 account-wide at 14:41Z today, and 107 is 2% of it -- about 47 invocations. This was the
 * heaviest SINGLE consumer in an audit pass that spent 816 calls against a 300 budget; what exhausted
 * the pool across nine sessions is a separate question nobody has attributed.
 *
 * ASCENDING BY CREATION, which is not cosmetic. REST's default is newest-first, and a PR opened while the
 * walk is in flight shifts every later page down by one, so an entry is silently seen twice or not at
 * all. Ascending appends new PRs AFTER the position being read: the walk is stable, and the only thing it
 * can miss is a PR created during the walk, whose branch is by construction not stranded.
 *
 * THE TERMINATION IS A SHORT PAGE, which is a positive statement about having reached the end, rather
 * than a count compared against a limit, which is the thing that could not tell "all of them" from "the
 * first N of more".
 *
 * `prs` COUNTS ROWS AND `refs` COLLAPSES THEM. A branch reused across two PRs is two rows and one ref
 * -- measured live at 402 and 399 -- so reporting the Set's size as a PR count would be a real number
 * about the quantity NEXT TO the one named, which is this repo's most-repeated reporting defect.
 *
 * @param {{ run?: typeof defaultRun }} [deps]
 * @returns {{ refs: Set<string>, calls: number, prs: number }}
 */
export function fetchAllPRHeadRefs({ run = defaultRun } = {}) {
  /** @type {Set<string>} */
  const refs = new Set();
  let calls = 0;
  let prs = 0;
  for (let page = 1; page <= MAX_PR_PAGES; page += 1) {
    const rows = fetchPRHeadRefPage({ run, page });
    calls += 1;
    prs += rows.length;
    for (const ref of rows) refs.add(ref);
    // A SHORT PAGE IS THE END. A full one is not evidence of more, but asking again costs one call and
    // answers definitely; guessing costs the whole audit.
    if (rows.length < PR_PAGE_SIZE) return { refs, calls, prs };
  }
  throw new Error(`stranded-branches: still receiving full pages after ${MAX_PR_PAGES} of `
    + `${PR_PAGE_SIZE} -- refusing to guess whether that is the end. Either this repo has more than `
    + `${MAX_PR_PAGES * PR_PAGE_SIZE} PRs, in which case raise MAX_PR_PAGES deliberately, or the walk `
    + "is not advancing.");
}

/**
 * One page of PR head refs, PROJECTED IN THE REQUEST. `--jq` runs server-side of this process, so the
 * only thing crossing into node is the one field the check reads -- and it stays JSON rather than
 * newline-delimited text so that a MISSING ref arrives as `null` and can be refused. Projected to bare
 * lines, a PR whose head ref could not be read would arrive as the four characters `null` and be
 * indistinguishable from a branch actually named that.
 *
 * @param {{ run: typeof defaultRun, page: number }} deps
 * @returns {string[]}
 */
function fetchPRHeadRefPage({ run, page }) {
  const path = `repos/${REPO}/pulls?state=all&per_page=${PR_PAGE_SIZE}`
    + `&sort=created&direction=asc&page=${page}`;
  /** @type {string} */
  let raw;
  try {
    raw = run("gh", ["api", path, "--jq", "[.[] | {ref: .head.ref}]"]);
  } catch (cause) {
    throw new Error(`stranded-branches: could not list PRs from ${REPO} (page ${page}) -- refusing to `
      + `guess. ${/** @type {Error} */ (cause).message}`, { cause });
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`stranded-branches: gh's PR list (page ${page}) was not JSON -- refusing to guess. `
      + `First 200 chars: ${raw.slice(0, 200)}`, { cause });
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`stranded-branches: gh's PR list (page ${page}) was not an array -- refusing to `
      + `guess. Got: ${JSON.stringify(parsed).slice(0, 300)}`);
  }
  return parsed.map((/** @type {unknown} */ row, /** @type {number} */ i) => {
    const ref = /** @type {{ ref?: unknown }} */ (row)?.ref;
    if (typeof ref !== "string") {
      throw new Error(`stranded-branches: PR entry ${i} on page ${page} has no head ref -- refusing to `
        + `guess. Got: ${JSON.stringify(row).slice(0, 200)}`);
    }
    return ref;
  });
}

/**
 * Pure: which pushed branches have NEVER had a PR, of any state? Stage 1 of the two-stage filter -- see
 * this file's own header for why order matters here.
 *
 * @param {string[]} pushed
 * @param {Set<string>} prHeadRefs
 * @returns {string[]}
 */
export function branchesWithNoPR(pushed, prHeadRefs) {
  return pushed.filter((branch) => !prHeadRefs.has(branch));
}

/**
 * How many commits `branch` carries that `origin/main` lacks. Trustworthy ONLY for a branch already known
 * to have no PR (see this file's header) -- calling it on a squash-merged branch reproduces the exact
 * false-positive this tool exists to avoid.
 *
 * @param {string} branch
 * @param {{ run?: typeof defaultRun }} [deps]
 * @returns {number}
 */
export function aheadCount(branch, { run = defaultRun } = {}) {
  try {
    return Number(run("git", ["rev-list", "--count", `origin/main..origin/${branch}`]).trim());
  } catch (cause) {
    throw new Error(`stranded-branches: could not compute how far ${branch} is ahead of main -- `
      + `refusing to guess. ${/** @type {Error} */ (cause).message}`, { cause });
  }
}

/**
 * Pure: stage 2 of the filter, given stage 1's population and each one's ahead-count already looked up.
 * A branch with no PR and ZERO commits ahead of main is not a candidate -- it is an empty push, or a
 * branch whose tip happens to already equal main's, neither of which is stranded work.
 *
 * @param {string[]} noPRBranches
 * @param {Map<string, number>} aheadCounts
 * @returns {{ branch: string, aheadCount: number }[]}
 */
export function strandedCandidates(noPRBranches, aheadCounts) {
  return noPRBranches
    .map((branch) => ({ branch, aheadCount: aheadCounts.get(branch) ?? 0 }))
    .filter((c) => c.aheadCount > 0);
}

/**
 * A PULL REQUEST LIVES FOUR HOURS — B1, and this is the REFUSAL path, which matters more than the action.
 *
 * Closing a PR is the most destructive thing in this toolset, so what this declines to close is the part
 * worth reading. p90 to merge is 2.5 h and the median is 12 minutes; the two PRs closed by hand at 02:00Z
 * had been open ~25 hours at 373 and 392 commits behind, and neither was ever going to merge. Four hours
 * sits above p90 and far below anything that has ever failed to merge.
 *
 * ## `update-branch` CHANGED WHAT "OLD" MEANS, and without that the threshold reads as aggressive
 *
 * PRs no longer drift unattended: the sweep brought #477 and #473 current automatically and correctly
 * skipped #472 and #475 while they were red. So an old PR is now one that is genuinely ABANDONED rather
 * than merely stale, which is what makes four hours a sharper line than when the figure was written. A
 * reader who remembers tonight's 55-behind PRs will otherwise think it too short.
 *
 * ## WHAT IT REFUSES, and why each
 *
 * - **Under the threshold.** The ordinary case, and the one a bug here would destroy silently.
 * - **A draft.** Not offered for merge, so its age says nothing about abandonment.
 * - **Labelled `blocked`.** A PERSON refused it, and a clock does not overrule that -- the same reason
 *   the auto-arm sweep skips those.
 * - **Green and merely behind.** It is the merge train's, waiting its turn under B3's serialised sync.
 *   Closing a PR for being queued would punish it for the queue's own latency, and B3 is temporary while
 *   this rule is not. This is the interaction #460 asks to be decided here rather than discovered at
 *   4h01m.
 *
 * @param {{number: number, ageHours: number, isDraft?: boolean, labels?: string[],
 *          checksGreen?: boolean, behind?: number}} pr
 * @param {{maxAgeHours: number}} options
 * @returns {{action: "close", why: string} | {action: "keep", why: string}}
 */
export function decideForPR(pr, { maxAgeHours }) {
  // HOURS AND MINUTES, not `toFixed(1)`. At one decimal place 3.98h and 4.02h both render "4.0h", so a
  // kept PR read "4.0h old, under the 4h line" -- a number contradicting its own sentence, on the exact
  // boundary where somebody will be checking whether the sweep was right to spare it.
  const age = `${Math.floor(pr.ageHours)}h${String(Math.round((pr.ageHours % 1) * 60)).padStart(2, "0")}m`;
  if (pr.ageHours < maxAgeHours) {
    return { action: "keep", why: `${age} old, under the ${maxAgeHours}h line` };
  }
  if (pr.isDraft) return { action: "keep", why: "a draft is not offered for merge, so its age says nothing" };
  if ((pr.labels ?? []).includes("blocked")) {
    return { action: "keep", why: "labelled `blocked` -- a person refused this, and a clock does not overrule it" };
  }
  if (pr.checksGreen === true && (pr.behind ?? 0) > 0) {
    return { action: "keep",
      why: "green and behind, so it is the merge train's and is waiting its turn -- closing it would "
        + "punish a PR for the queue's latency rather than for its own staleness" };
  }
  return { action: "close",
    why: `${age} old, past the ${maxAgeHours}h line, and not waiting on anything` };
}

/**
 * The comment a closed PR gets. STALE and REJECTED need different words because the recovery differs:
 * one says "rebuild this from today's main", the other says "do not".
 *
 * THE BRANCH IS KEPT AND THE COMMENT SAYS SO. #172's branch was kept and its content re-derived from it;
 * a sweep that closed AND deleted would have destroyed a day of work that turned out to be sound.
 *
 * @param {{number: number, headRefName: string}} pr @param {string} why
 */
export function staleClosureComment(pr, why) {
  return `Closed as STALE by the lifetime sweep, not rejected — ${why}.\n\n`
    + `**The branch \`${pr.headRefName}\` is kept.** Nothing is lost: rebuild from today's \`main\` and open `
    + "a fresh PR. That is what happened to #172, whose branch was kept and whose content was re-derived "
    + "from it in an hour once the decision was made.\n\n"
    + "This is not a judgement on the work. A PR open this long is behind far enough that resolving it "
    + "costs more than rebuilding it, and every merge in this repository's record has happened well "
    + "inside the window.";
}

/**
 * Every open PR, with the four fields the decision needs. `gh` in JSON, one call.
 *
 * `statusCheckRollup` is DELIBERATELY NOT USED for `checksGreen`: it unions superseded check runs, so a
 * PR whose latest run succeeded reads as failing -- measured tonight on three PRs read as red by two
 * sessions, and filed as #450. The latest run per workflow is the bounded question; this asks `gh` for the
 * PR's own mergeable state instead, which is what the merge train acts on anyway.
 *
 * @param {{run?: (cmd: string, args: string[]) => string}} options
 */
export function fetchOpenPRs({ run = defaultRun } = {}) {
  const raw = run("gh", ["pr", "list", "--state", "open", "--limit", String(PR_LIST_LIMIT), "--json",
    "number,headRefName,createdAt,isDraft,labels,mergeStateStatus"]);
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("gh pr list did not return an array");
  // THE SAME AT-THE-CAP REFUSAL AS THE ALL-PRs LISTING HAD. It lived at one of the two call sites of the
  // one constant, which is this repository's most expensive recurring shape; when the all-PRs listing
  // moved to pagination the guard would have left with it, so it is stated here instead. Reaching 400
  // OPEN PRs is not repo growth -- it is the sweep about to close PRs from a truncated, newest-first
  // slice, with `--close` behind it.
  if (parsed.length === PR_LIST_LIMIT) {
    throw new Error(`stranded-branches: gh returned exactly ${PR_LIST_LIMIT} OPEN PRs, the configured `
      + "--limit -- cannot tell whether that is every open PR or a truncated, newest-first slice. "
      + "Refusing to sweep a population that may be missing its oldest members, which are exactly the "
      + "ones a lifetime sweep acts on.");
  }
  return parsed;
}

/**
 * A PR as the decision wants it. `ageHours` from `createdAt`, and `checksGreen` from the merge state
 * rather than from a rollup that cannot be trusted.
 *
 * @param {any} pr @param {Date} now
 */
export function prForDecision(pr, now) {
  return {
    number: pr.number,
    headRefName: pr.headRefName,
    ageHours: (now.getTime() - new Date(pr.createdAt).getTime()) / 3_600_000,
    isDraft: Boolean(pr.isDraft),
    labels: (pr.labels ?? []).map((/** @type {any} */ l) => String(l.name)),
    // BEHIND is the only state that means "waiting for the train". CLEAN merges on its own; BLOCKED and
    // DIRTY are the PR's own problem and the train will not touch them.
    checksGreen: pr.mergeStateStatus === "BEHIND" || pr.mergeStateStatus === "CLEAN",
    behind: pr.mergeStateStatus === "BEHIND" ? 1 : 0,
  };
}

/**
 * #1480: A `--close` FAILURE SAYS WHAT HAD ALREADY LANDED. The closure comment and the close were two unguarded
 * calls in a loop, so a throw on either escaped `main` and Node exited 1, the header's CANDIDATE(S), with PRs
 * already commented on or closed and nothing saying which. The error carries the header's exit code:
 * LANDED_THEN_FAILED when any write had landed, CANNOT_ASK when none had. Its remedy is the one that is safe to
 * follow: a PR left commented but open needs only its close, since re-running `--close` would comment on it twice.
 * @param {{ closed: number[], number: number, commented: boolean, error: unknown }} at
 * @returns {Error & { exitCode: number }}
 */
function sweepFailure({ closed, number, commented, error }) {
  const cause = error instanceof Error ? error.message.split("\n")[0] : String(error);
  if (!commented && closed.length === 0) {
    return Object.assign(new Error(`COULD NOT SWEEP: \`gh pr comment ${number}\` failed before any PR was `
      + `commented on or closed -- nothing was changed.\n  ${cause}`, { cause: error }), { exitCode: EXIT.CANNOT_ASK });
  }
  const done = closed.length > 0 ? closed.map((n) => `#${n}`).join(", ") : "none";
  const remedy = commented
    ? `#${number} has its closure comment but is still OPEN. Run only \`gh pr close ${number}\` once the cause `
      + `below is gone -- re-running --close would post a second comment on #${number}.`
    : `Nothing was written to #${number}. Re-running --close once the cause below is gone is safe: the PRs `
      + "already closed are no longer open.";
  return Object.assign(new Error(`LANDED, THEN FAILED: \`gh pr ${commented ? "close" : "comment"} ${number}\` failed `
    + `during --close. Closed with a comment, branch kept: ${done}. ${remedy}\n  ${cause}`, { cause: error }),
  { exitCode: EXIT.LANDED_THEN_FAILED });
}

/**
 * THE LIFETIME SWEEP — B1. REPORTS BY DEFAULT; closing is opt-in.
 *
 * `corpus-prune-orphans.mjs` (#195) established the shape and it matters more here: closing a PR is the
 * most destructive action in this toolset, so `--close` is a thing somebody types, never a default that
 * runs because a scheduled job forgot a flag. Without it this names what it WOULD close and changes
 * nothing.
 *
 * @param {{now?: Date, maxAgeHours?: number, close?: boolean,
 *          run?: (cmd: string, args: string[]) => string}} options
 */
export function sweepPullRequests({ now = new Date(), maxAgeHours = 4, close = false, run = defaultRun } = {}) {
  const prs = fetchOpenPRs({ run }).map((pr) => prForDecision(pr, now));
  const decided = prs.map((pr) => ({ pr, decision: decideForPR(pr, { maxAgeHours }) }));
  const closing = decided.filter((d) => d.decision.action === "close");

  // THE COUNT IS PRINTED WHETHER OR NOT ANYTHING IS FOUND. A sweep that exits quietly on zero is
  // indistinguishable from one that examined nothing, and this one has `--close` behind it.
  process.stdout.write(`lifetime sweep: ${prs.length} open PR(s) examined against a ${maxAgeHours}h line; `
    + `${closing.length} past it.\n`);
  for (const { pr, decision } of decided) {
    const verb = decision.action === "close" ? (close ? "CLOSING" : "WOULD CLOSE") : "keeping";
    process.stdout.write(`  ${verb.padEnd(11)} #${pr.number}  ${decision.why}\n`);
  }
  if (!close || closing.length === 0) return closing;

  /** @type {number[]} */
  const closed = [];
  for (const { pr, decision } of closing) {
    // THE BRANCH IS KEPT: `gh pr close` without `--delete-branch`, said out loud because the flag's
    // absence is the whole safety property and an absent flag is invisible in review.
    try {
      run("gh", ["pr", "comment", String(pr.number), "--body", staleClosureComment(pr, decision.why)]);
    } catch (error) {
      throw sweepFailure({ closed, number: pr.number, commented: false, error });
    }
    try {
      run("gh", ["pr", "close", String(pr.number)]);
    } catch (error) {
      throw sweepFailure({ closed, number: pr.number, commented: true, error });
    }
    closed.push(pr.number);
    process.stdout.write(`  closed #${pr.number}, branch ${pr.headRefName} KEPT\n`);
  }
  return closing;
}

/**
 * The `--dry-run`/`--close` half of `main`. A throw carrying the header's exit code is `sweepFailure`'s, already
 * worded; any other throw (the `gh pr list` lookup) changed nothing, so it is CANNOT_ASK (#1480).
 * @param {string[]} argv
 * @param {{ run: typeof defaultRun, err: (line: string) => void }} deps
 * @returns {number}
 */
function sweepCommand(argv, { run, err }) {
  const hours = flagValue(argv, "max-age-hours");
  try {
    sweepPullRequests({ close: argv.includes("--close"), maxAgeHours: hours ? Number(hours) : 4, run });
  } catch (error) {
    const { exitCode, message } = /** @type {Error & { exitCode?: number }} */ (error);
    err(`${exitCode === undefined ? `COULD NOT SWEEP: ${message}` : message}\n`);
    return exitCode ?? EXIT.CANNOT_ASK;
  }
  return EXIT.OK;
}

/**
 * The CLI, returning the header's exit code, with `run` injectable so a `--close` that fails part-way is driven
 * end to end without reaching GitHub (#1480).
 * @param {string[]} [argv]
 * @param {{ run?: typeof defaultRun, out?: (line: string) => void, err?: (line: string) => void }} [deps]
 * @returns {number}
 */
export function main(argv = process.argv.slice(2), { run = defaultRun, out = writeOut, err = writeErr } = {}) {
  refuseUnknownFlags(["--dry-run", "--close", "--max-age-hours="],
    { entry: import.meta.url, argv, command: "node packages/agent-org/src/stranded-branches.mjs" });
  if (argv.includes("--dry-run") || argv.includes("--close")) return sweepCommand(argv, { run, err });
  /** @type {string[]} */
  let pushed;
  /** @type {{ refs: Set<string>, calls: number, prs: number }} */
  let prs;
  try {
    pushed = fetchPushedBranches({ run });
    prs = fetchAllPRHeadRefs({ run });
  } catch (error) {
    err(`COULD NOT AUDIT: ${/** @type {Error} */ (error).message}\n`);
    return EXIT.CANNOT_ASK;
  }

  // WHAT THE FETCH SPENT, PRINTED WHETHER OR NOT ANYTHING IS FOUND. This listing was the heaviest
  // consumer in an audit pass that spent 816 calls against a 300 budget, and a cost nobody can see is a
  // cost nobody can attribute -- the pass was over budget for a week before the heaviest call was named.
  out(`PR listing: ${prs.prs} PR(s), ${prs.refs.size} distinct head ref(s), `
    + `over ${prs.calls} REST call(s) `
    + `(core, ${PR_PAGE_SIZE}/page; \`gh pr list\` spent GraphQL and capped at ${PR_LIST_LIMIT})\n`);

  const noPR = branchesWithNoPR(pushed, prs.refs);
  const aheadCounts = new Map();
  for (const branch of noPR) {
    try {
      aheadCounts.set(branch, aheadCount(branch, { run }));
    } catch (error) {
      err(`COULD NOT AUDIT: ${/** @type {Error} */ (error).message}\n`);
      return EXIT.CANNOT_ASK;
    }
  }
  const candidates = strandedCandidates(noPR, aheadCounts);

  if (candidates.length === 0) {
    out(`OK  ${pushed.length} pushed branch(es) examined, none are stranded-branch `
      + `candidates (no PR of any state, and commits main does not have)\n`);
    return EXIT.OK;
  }
  for (const { branch, aheadCount: count } of candidates) {
    out(`CANDIDATE  ${branch}  +${count} commit(s) ahead of main, no PR ever opened\n`);
  }
  err(`\n${candidates.length} branch(es) are CANDIDATES for stranded work, out of `
    + `${pushed.length} pushed. NOT a finding: a rebase whose content landed under a DIFFERENT branch's PR `
    + `produces the identical shape. Read each branch's own diff against main before opening a PR for it.\n`);
  return EXIT.CANDIDATES;
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  process.exitCode = main();
}

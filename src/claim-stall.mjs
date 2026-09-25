// @ts-check
// A CLAIM THAT DOES NOT MOVE, AND NOTHING THAT SAID SO -- #2470.
//
// `ceo`'s ruling on #2407 (2026-09-25): a row carried `session:worker-7` while `../wt-2407` held 215 lines
// uncommitted, unpushed, no pull request, last file change seven hours before -- and the session was BUSY the whole
// time, on another row. A status check says "working" and is right; THE ROW is what had stalled. Nothing in the gate
// read a claim going unmoved, and the one nudge that worked cost a `ceo` turn spent reading a pane.
//
// THIS FILE IS THE PURE HALF, AND A LEAF: it imports only `node:*`, the git-env scrubber and `claim-labels.mjs`, so
// `work-gate.mjs` (which runs before any `npm ci`) and `wake.mjs` can both import it without one importing the other.
// It DECIDES; the gate carries the decision as an order and `wake.mjs` performs the parts that need a pane.
//
// FOUR THINGS LIVE HERE, EACH THE ANSWER TO ONE DONE-WHEN OF #2470:
//   1. THE READING (`claimReading`): nudge, then release, on no progress on THE ROW for `STALL_INTERVAL_MS`.
//   2. THE RELEASES THAT ARE NOT A STALL: a claim whose row is BLOCKED and whose holder holds nothing (8), and one whose
//      pull request MERGED while the row stayed open (10). Same predicate for "holds nothing" as the stall's keep-work.
//   3. THE READINGS OF A HOST EVENT: the `herdr.service` restart (11) and an interrupted pane (9).
//   4. THE STATE THE SECOND READING NEEDS: a released row carries no memory of the first nudge unless it is written
//      down, and it is written down in `claim-stalls.json`, beside the wake ledger.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
// EVERY `git` SPAWN IN THIS REPO STRIPS `GIT_*` THROUGH ONE FUNCTION (`git-env.mjs`'s own header records the incident).
import { sandboxGitEnv } from "../../guards/src/git-env.mjs";
import { CLAIM_RECORD_MARKER } from "./claim-labels.mjs";

const MINUTE_MS = 60_000;

/**
 * The cause a nudge and a release both carry. One cause: the answer is an ACTION, never a question. THE ORDERS BELOW SPELL IT
 * AS A LITERAL, not through this constant, because `worker-profile.test.ts` finds the causes the gate emits by scanning for
 * `cause: "<name>"` -- and a test pins that the two spellings are the same string.
 */
export const CLAIM_STALLED = "claim-stalled";

/**
 * N: how long a claim may sit with nothing moving before it is nudged, and how long after the nudge before it is
 * released. ONE FIGURE FOR BOTH, because the second reading is the same question asked again.
 *
 * MEASURED, NOT CHOSEN (2026-09-25, read from GitHub by `worker-capture`; the method is in the pull request that
 * shipped this, and the numbers below are a reading at a moment, so re-derive before quoting):
 *   POPULATION  297 rows that LANDED (closed by a merged pull request) and carry a claim record before that PR, claimed
 *               2026-09-18T23:58Z .. 2026-09-25T13:43Z. From `gh api graphql` `pullRequests(states: MERGED)` over the newest
 *               400 (`closingIssuesReferences` or a `Closes #n` in the body) and `gh issue list --state closed --limit 700`.
 *   THE GAP     for each row, the LONGEST interval between consecutive events from the claim to the PR's creation, the
 *               events being the claim record, a commit (`committedDate`), a row comment by the account that wrote the claim
 *               record, and the PR itself. A worktree file's mtime is not retained after a merge, so it is NOT in this
 *               history: it can only SHORTEN a gap, which makes 120 minutes from these four the conservative figure (the
 *               nudge fires later, never earlier).
 *   RESULT      p50 9 min, p75 15, p90 26, p95 48 min. The largest gap on an ordinary row is 51 minutes; then NOTHING until
 *               264, and 13 rows above it (264 .. 962 minutes). 120 minutes sits at the 95.6th percentile: 284 of 297 rows
 *               at or below it, and every row above it is one a person had to notice (six are the rows `ceo`'s
 *               2026-09-25 sweep named).
 * WHAT THIS DOES NOT PROVE: that 120 is right for a slower regime. The population is one week of a fast one, and it is
 * rows that LANDED, so a row that stalled and was released never appears in it.
 */
export const STALL_INTERVAL_MS = 120 * MINUTE_MS;

/**
 * How long a nudge is OFFERED: `WAKE_TTL_MS`, the ledger's window for an action cause. Offered for exactly one window
 * means one delivery (the ledger holds a delivered key for that long) and no more: a longer offer would re-send it every
 * twenty minutes of the grace period and reach `MAX_DELIVERIES`, which escalates the ROW to the chairman for a stall this
 * cause exists to handle. A test pins that the two are the same number, because this file cannot import `wake.mjs`.
 */
export const NUDGE_OFFER_MS = 20 * MINUTE_MS;

/**
 * The window before a `herdr.service` restart in which a delivery is presumed KILLED if its target made no move.
 *
 * MEASURED (2026-09-25, `worker-capture`, from `wake-ledger` beside the wake ledger): 1,352 cause deliveries that were
 * ANSWERED -- the cause stopped being emitted, which `endedRuns` records as a `RESET` line -- read from the first delivery
 * in the run to the `RESET`. p50 4.0 min, p75 9.9, p90 61.5, p95 225. 60 minutes is p89.9: 1,216 of 1,352. A delivery
 * older than that at the moment of a restart has had longer than nine in ten answered orders ever took, so no move by then
 * is far likelier to be "ignored" than "killed". The 68-second case that started this row is one point in it.
 * NOT MEASURED, AND SAID SO: the handoff queue records when an order was delivered and never when it was answered, so the
 * authored half of the population has no latency here -- the window is taken from the derived half and applied to both.
 */
export const RESTART_RESEND_WINDOW_MS = 60 * MINUTE_MS;

/** The nudge memory, the kept-worktree records and the last restart acted on: beside the wake ledger. */
export const STALL_STATE_FILE = "claim-stalls.json";
export const KEPT_CLAIMS_FILE = "kept-claims.json";
export const RESTART_STATE_FILE = "restart-resends.json";

/**
 * What Claude Code prints, as the last line of a turn's output, when the process under it was killed mid-tool. Quoted
 * from #2470's own measurement at 2026-09-25T12:01Z -- "Every session mid-tool came back showing 'Interrupted · What
 * should Claude do instead?' and `herdr agent list` reported it `idle`". NOT SEEN LIVE BY THE AUTHOR OF THIS FILE: no
 * pane was interrupted while it was written, so the needle is the row's quotation and the first real interruption is
 * either matched by it or is a defect to report.
 */
export const INTERRUPTED_TEXT = "Interrupted · What should Claude do instead?";

// --- THE CLAIM RECORD, READ -----------------------------------------------------------------------------------------

const CLAIMED_BRANCH = /^Claimed-branch:\s*(.+)$/m;
const CLAIMED_WORKTREE = /^Claimed-worktree:\s*(.+)$/m;
const CLAIMED_BY = /-- claimed by `/;

/**
 * @typedef {{ body?: string, createdAt?: string, author?: { login?: string } | null, id?: string }} RowComment
 * @typedef {{ at: number, author: string | null, branch: string | null, worktree: string | null }} ClaimRecord
 */

/**
 * The newest claim record on a row, or `null` when none is a CLAIM: no record at all (a dispatch, or a claim that named
 * neither a branch nor a worktree), or the newest one is a RELEASE. `row-claim.mjs` owns the format
 * (`claimRecordComment`) and is unimportable from a tick, so this reads it by the same marker and the same two field
 * names, and the test round-trips the real writer through it.
 *
 * `at` is the record's own time and `author` its account -- which is how "a row comment BY THAT SESSION" is answered
 * without a session-to-account table: the claim was made under the account the claimant runs as.
 *
 * @param {RowComment[]} comments oldest first, the order `gh issue list --json comments` returns
 * @returns {ClaimRecord | null}
 */
export function claimRecordOf(comments) {
  const newest = comments.filter((c) => String(c.body ?? "").includes(CLAIM_RECORD_MARKER)).at(-1);
  if (newest === undefined || !CLAIMED_BY.test(String(newest.body))) return null;
  const body = String(newest.body);
  const at = Date.parse(String(newest.createdAt ?? ""));
  if (Number.isNaN(at)) return null;
  return { at, author: newest.author?.login ?? null,
    branch: CLAIMED_BRANCH.exec(body)?.[1].trim() ?? null, worktree: CLAIMED_WORKTREE.exec(body)?.[1].trim() ?? null };
}

/**
 * When the claimant last commented on the row after the claim: a comment by the claim record's own account, newer than
 * the record, that is not itself a record. `null` for none.
 *
 * KNOWN LIMIT, STATED: two sessions on one account (the workers' account, the leads' account) are one author. A comment
 * by `product-manager` on a row held by a leads-account seat therefore counts as a move. That reads MORE movement than
 * there is, which fires the nudge later and never earlier -- the direction `STALL_INTERVAL_MS` already chose.
 *
 * @param {RowComment[]} comments @param {ClaimRecord} record @returns {number | null}
 */
export function commentMove(comments, record) {
  let newest = null;
  for (const c of comments) {
    if (record.author === null || c.author?.login !== record.author) continue;
    if (String(c.body ?? "").includes(CLAIM_RECORD_MARKER)) continue;
    const at = Date.parse(String(c.createdAt ?? ""));
    if (!Number.isNaN(at) && at > record.at && (newest === null || at > newest)) newest = at;
  }
  return newest;
}

// --- GIT AND THE FILESYSTEM, THROUGH SEAMS --------------------------------------------------------------------------

/**
 * One process run, WITHOUT a throw: the status decides what an answer MEANS (`rev-parse --verify` exits 1 for "no such
 * ref", which is an answer, and anything else is "could not ask", which is not one).
 * @typedef {(dir: string, args: string[]) => { status: number | null, out: string }} GitRun
 * @typedef {{ git: GitRun, exists: (path: string) => boolean, mtime: (path: string) => number | null }} HostReads
 */

/** A read that could not be made. NEVER an absence: "no commit" is `null`, "could not ask git" is this. */
export class Unreadable extends Error {}

/**
 * `git -C <dir> ...`, never throwing: a timeout or a spawn failure is `status: null`, which every reader above turns into
 * `Unreadable` rather than into "no commits".
 * @type {GitRun}
 */
export const gitRun = (dir, args) => {
  const ran = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: sandboxGitEnv(), timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER });
  return { status: ran.status, out: ran.stdout ?? "" };
};
const GIT_TIMEOUT_MS = 20_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

/** @param {GitRun} git @param {string} dir @param {string[]} args @returns {string} */
function mustGit(git, dir, args) {
  const ran = git(dir, args);
  if (ran.status !== 0) throw new Unreadable(`git ${args.slice(0, 2).join(" ")} in ${dir} exited ${ran.status}`);
  return ran.out;
}

/**
 * The commit time (ms) of the newest commit `ref` holds that `origin/main` does not, `null` when it holds none or `ref`
 * does not exist. A branch that is not ahead of main has no commit of its own, and its tip's date is main's, not a move.
 * @param {GitRun} git @param {string} dir @param {string} ref @returns {number | null}
 */
export function newestOwnCommit(git, dir, ref) {
  const exists = git(dir, ["rev-parse", "--verify", "--quiet", ref]);
  if (exists.status === 1) return null;
  if (exists.status !== 0) throw new Unreadable(`git rev-parse ${ref} in ${dir} exited ${exists.status}`);
  const out = mustGit(git, dir, ["log", "-1", "--format=%ct", `origin/main..${ref}`]).trim();
  return out === "" ? null : Number(out) * 1000;
}

/** How many changed paths a worktree's mtime reading looks at: an untracked build directory must not cost the tick. */
const MAX_PATHS_STAT = 400;

/**
 * The newest mtime (ms) among the paths a worktree has CHANGED, or `null` for a clean one or none that still exists.
 * `--no-optional-locks` is the reason it is safe to ask every tick: a plain `git status` REFRESHES THE INDEX, and the
 * index's mtime would then be a "file change" caused by this very read.
 * @param {HostReads} io @param {string} dir @returns {number | null}
 */
export function fileMove({ git, mtime }, dir) {
  const out = mustGit(git, dir, ["status", "--porcelain", "--no-optional-locks", "--untracked-files=all", "-z"]);
  const entries = out.split("\0").filter((e) => e !== "");
  let newest = null;
  for (const entry of entries.slice(0, MAX_PATHS_STAT)) {
    // A rename's second token is the OLD name, which is not a path that exists; a token without a status is skipped.
    if (!/^[ MADRCU?!]{2} /.test(entry)) continue;
    const at = mtime(`${dir}/${entry.slice(3)}`);
    if (at !== null && (newest === null || at > newest)) newest = at;
  }
  return newest;
}

/**
 * WHETHER THE HOLDER HOLDS WORK THAT EXISTS NOWHERE ELSE -- one predicate for the stall's keep-work (7), the blocked
 * release (8) and the merged release (10), because "the same reading" was the row's own instruction.
 *
 *   dirty     a file in the worktree that git would not lose to a checkout
 *   unpushed  a commit reachable from HEAD and from NO remote-tracking ref -- exactly "exists nowhere else", where "ahead
 *             of origin/main" would call a pushed branch unpushed
 *
 * `unknown` is a third answer and never `none`: git that will not answer is not a clean tree, and the callers that RELEASE
 * refuse on it. No worktree and no local branch is `none` -- there is nothing on this host to lose.
 *
 * @param {HostReads} io
 * @param {{ worktree: string | null, branch: string | null, repo: string }} where `repo` is any checkout of the repository
 * @returns {{ state: "none" | "at-risk" | "unknown", dirty: number, unpushed: number, why?: string }}
 */
export function workAtRisk(io, { worktree, branch, repo }) {
  try {
    if (worktree !== null && io.exists(worktree)) {
      const dirty = mustGit(io.git, worktree, ["status", "--porcelain", "--no-optional-locks", "--untracked-files=all"])
        .split("\n").filter((l) => l.trim() !== "").length;
      const unpushed = Number(mustGit(io.git, worktree, ["rev-list", "--count", "HEAD", "--not", "--remotes"]).trim());
      return { state: dirty > 0 || unpushed > 0 ? "at-risk" : "none", dirty, unpushed };
    }
    if (branch === null) return { state: "none", dirty: 0, unpushed: 0 };
    const ref = io.git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    if (ref.status === 1) return { state: "none", dirty: 0, unpushed: 0 };
    if (ref.status !== 0) throw new Unreadable(`git rev-parse refs/heads/${branch} exited ${ref.status}`);
    const unpushed = Number(mustGit(io.git, repo, ["rev-list", "--count", `refs/heads/${branch}`, "--not", "--remotes"]).trim());
    return { state: unpushed > 0 ? "at-risk" : "none", dirty: 0, unpushed };
  } catch (err) {
    if (!(err instanceof Unreadable)) throw err;
    return { state: "unknown", dirty: 0, unpushed: 0, why: err.message };
  }
}

// --- THE READING ----------------------------------------------------------------------------------------------------

/**
 * Everything the reading knows about ONE claimed row. The two costly facts are THUNKS, so a row that is plainly moving
 * (a comment or a commit inside N) costs no `git status`, and a tick pays for a worktree only when the cheap signals
 * already say it has been quiet.
 *
 * @typedef {{
 *   row: number, title?: string, session: string, claimedAt: number,
 *   branch: string | null, worktree: string | null,
 *   comment: number | null, commit: number | null, push: number | null,
 *   file: () => number | null,
 *   work: () => ReturnType<typeof workAtRisk>,
 *   openPrs: number, mergedPr: { number: number, mergedAt: number } | null,
 *   waiting: string | null, blockedBy: number[],
 * }} ClaimFacts
 *
 * @typedef {{ kind: "moving", lastMoveAt: number } | { kind: "pr-owned" } | { kind: "waiting", waiting: string }
 *   | { kind: "nudge", lastMoveAt: number, idleMs: number }
 *   | { kind: "nudged", nudgedAt: number, lastMoveAt: number }
 *   | { kind: "release", why: "stalled" | "blocked" | "merged", lastMoveAt: number | null, idleMs: number | null,
 *       nudgedAt: number | null, edges?: number[], mergedPr?: number }
 *   | { kind: "holding", why: string }} Reading
 */

/** @param {(number | null)[]} times @returns {number | null} */
function latest(times) {
  const known = times.filter((t) => t !== null);
  return known.length === 0 ? null : Math.max(.../** @type {number[]} */ (known));
}

/**
 * The reading of one claim, or why it is left alone.
 *
 * ORDER IS THE DESIGN. A row with an OPEN PULL REQUEST is not this cause's: the PR-stage causes (`draft-awaiting-verdict`,
 * `pr-review-blocked`, `pr-green-unarmed`, `pr-merge-conflict`, `awaiting-evidence-stale`) each wake the author for an
 * actionable state, and a PR waiting on somebody else is not the holder stalling. A merged pull request whose row stayed
 * open is (10). An open `blockedBy` edge is (8) and NOT a wait to be respected, because a holder with nothing built has
 * nothing to protect. Only then a DECLARED wait (`answer:<session>`, a future `Not-before`, `needs:chairman`) -- data the
 * org already reads, so the row said why it is quiet. THE SESSION'S OWN STATUS IS NOT AN INPUT, and that is #2407's case:
 * `worker-7` was BUSY, on another row.
 *
 * THE CLOCK STARTS NO EARLIER THAN THE RESTART (11f): a session the outage silenced must not be nudged and then released
 * for a stall the gate itself caused and has not yet answered.
 *
 * @param {ClaimFacts} facts
 * @param {{ now: number, restartAt: number | null, nudge: { nudgedAt: number } | null, intervalMs?: number }} ctx
 * @returns {Reading}
 */
export function claimReading(facts, ctx) {
  const interval = ctx.intervalMs ?? STALL_INTERVAL_MS;
  if (facts.openPrs > 0) return { kind: "pr-owned" };
  const landed = mergedReading(facts);
  if (landed !== null) return landed;
  if (facts.blockedBy.length > 0) return blockedReading(facts);
  if (facts.waiting !== null) return { kind: "waiting", waiting: facts.waiting };
  const cheap = /** @type {number} */ (latest([facts.claimedAt, facts.comment, facts.commit, facts.push, ctx.restartAt]));
  if (ctx.now - cheap < interval) return { kind: "moving", lastMoveAt: cheap };
  const lastMoveAt = /** @type {number} */ (latest([cheap, facts.file()]));
  if (ctx.now - lastMoveAt < interval) return { kind: "moving", lastMoveAt };
  // THE SECOND READING: a nudge nothing has moved since. A move after the nudge, or a restart after it, is not "nothing".
  if (ctx.nudge !== null && ctx.nudge.nudgedAt > lastMoveAt) {
    if (ctx.now - ctx.nudge.nudgedAt >= interval) {
      return { kind: "release", why: "stalled", lastMoveAt, idleMs: ctx.now - lastMoveAt, nudgedAt: ctx.nudge.nudgedAt };
    }
    return { kind: "nudged", nudgedAt: ctx.nudge.nudgedAt, lastMoveAt };
  }
  return { kind: "nudge", lastMoveAt, idleMs: ctx.now - lastMoveAt };
}

/**
 * (10) A merged pull request on the claimed branch, no open one, nothing at risk: the work LANDED and the row stayed open
 * (`Closes: none`), so the instance is done and the ruling about the row is `product-manager`'s.
 * @param {ClaimFacts} facts @returns {Reading | null}
 */
function mergedReading(facts) {
  if (facts.mergedPr === null) return null;
  const work = facts.work();
  if (work.state !== "none") {
    return { kind: "holding", why: `#${facts.mergedPr.number} merged, but ${work.state === "unknown" ? "the worktree could not be read" : `the holder still has ${work.dirty} dirty file(s) and ${work.unpushed} unpushed commit(s)`}` };
  }
  return { kind: "release", why: "merged", lastMoveAt: null, idleMs: null, nudgedAt: null, mergedPr: facts.mergedPr.number };
}

/**
 * (8) An OPEN `blockedBy` edge and a holder holding nothing: released at once, no nudge. A holder that has built something
 * keeps the claim (its edge arrived while it held the row, and `claimed-row-amended` is what tells it).
 * @param {ClaimFacts} facts @returns {Reading}
 */
function blockedReading(facts) {
  const work = facts.work();
  if (work.state !== "none") {
    return { kind: "holding", why: work.state === "unknown" ? "blocked, and the worktree could not be read"
      : `blocked, but the holder has ${work.dirty} dirty file(s) and ${work.unpushed} unpushed commit(s)` };
  }
  return { kind: "release", why: "blocked", lastMoveAt: null, idleMs: null, nudgedAt: null, edges: facts.blockedBy };
}

// --- THE FACTS OF ONE ROW ---------------------------------------------------------------------------------------------

/**
 * @typedef {{ row: number, title?: string, session: string, waiting: string | null, blockedBy: number[],
 *   comments: RowComment[], openPrs: { headRefName?: string }[],
 *   mergedPrs: { number: number, headRefName?: string, mergedAt?: string }[] | null, repo: string }} ClaimInput
 */

/**
 * One claimed row's facts, or `{ skip }` saying why it is NOT EVALUATED this tick -- a row with no claim record cannot say
 * when it was claimed, and git that will not answer is not "no commits". A skipped row is neither nudged nor released,
 * and the caller SAYS so: silence about a claim it could not read would look like a claim that was fine.
 *
 * The branch is the claim record's own (`Claimed-branch:`), so the gate needs no naming convention. A pull request is
 * THIS row's when its head is that branch or ends `-<row>` (`row-branch-rule.mjs`'s own shape).
 *
 * @param {ClaimInput} input @param {HostReads} io @returns {ClaimFacts | { skip: string }}
 */
export function claimFactsFrom(input, io) {
  const record = claimRecordOf(input.comments);
  if (record === null) return { skip: `#${input.row} carries session:${input.session} but no claim record names when or where` };
  const worktree = record.worktree === null ? null : resolve(input.repo, record.worktree);
  const dir = worktree !== null && io.exists(worktree) ? worktree : input.repo;
  try {
    const branch = record.branch;
    const own = (/** @type {string | undefined} */ head) => head !== undefined && (head === branch || head.endsWith(`-${input.row}`));
    const merged = branch === null ? null : (input.mergedPrs ?? []).filter((p) => p.headRefName === branch
      && Date.parse(String(p.mergedAt ?? "")) > record.at).at(-1) ?? null;
    return { row: input.row, session: input.session, claimedAt: record.at, branch, worktree,
      ...(input.title === undefined ? {} : { title: input.title }),
      comment: commentMove(input.comments, record),
      commit: branch === null ? null : newestOwnCommit(io.git, dir, branch),
      push: branch === null ? null : newestOwnCommit(io.git, dir, `origin/${branch}`),
      file: () => (worktree !== null && io.exists(worktree) ? fileMove(io, worktree) : null),
      work: () => workAtRisk(io, { worktree, branch, repo: input.repo }),
      openPrs: input.openPrs.filter((p) => own(p.headRefName)).length,
      mergedPr: merged === null ? null : { number: merged.number, mergedAt: Date.parse(String(merged.mergedAt)) },
      waiting: input.waiting, blockedBy: input.blockedBy };
  } catch (err) {
    if (err instanceof Unreadable) return { skip: `#${input.row}: ${err.message}` };
    throw err;
  }
}

/**
 * `claimReading` that a read which will not answer cannot crash and cannot turn into a release: the thunks reach git, and
 * git that fails is `holding`, the reading that emits nothing and keeps the row's nudge memory out of it.
 * @param {ClaimFacts} facts @param {Parameters<typeof claimReading>[1]} ctx @returns {Reading}
 */
export function readClaim(facts, ctx) {
  try {
    return claimReading(facts, ctx);
  } catch (err) {
    if (err instanceof Unreadable) return { kind: "holding", why: err.message };
    throw err;
  }
}

// --- THE NUDGE MEMORY -----------------------------------------------------------------------------------------------

/** @typedef {Record<string, { session: string, nudgedAt: number }>} StallState keyed by row number */

/**
 * A JSON object kept in a file beside the wake ledger, or `{}`. A missing file is EMPTY and an unparseable one is empty too:
 * every file this reads is a MEMORY (the nudge, the kept worktree, the last restart acted on) whose loss costs one repeat of
 * something, and a memory that could stop the tick would be worse than none.
 * @param {string} path @param {typeof readFileSync} [read] @returns {Record<string, any>}
 */
export function readJsonObject(path, read = readFileSync) {
  try {
    const parsed = JSON.parse(String(read(path, "utf8")));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The nudge memory, from `claim-stalls.json`.
 * @param {string} path @param {typeof readFileSync} [read] @returns {StallState}
 */
export function readStallState(path, read = readFileSync) {
  return readJsonObject(path, read);
}

/**
 * The memory after this tick's readings: a NUDGE is recorded at `now`, a `nudged` row keeps its record, and every other
 * row -- moving, released, no longer claimed by that session -- loses it, so a row that stalls a second time is a first
 * reading again and not a release on the strength of last week's nudge.
 *
 * @param {StallState} before
 * @param {{ facts: ClaimFacts, reading: Reading }[]} readings @param {number} now
 * @returns {StallState}
 */
export function nextStallState(before, readings, now) {
  /** @type {StallState} */
  const after = {};
  for (const { facts, reading } of readings) {
    if (reading.kind === "nudge") after[facts.row] = { session: facts.session, nudgedAt: now };
    else if (reading.kind === "nudged") after[facts.row] = { session: facts.session, nudgedAt: reading.nudgedAt };
  }
  return JSON.stringify(after) === JSON.stringify(before) ? before : after;
}

/**
 * Write a memory ATOMICALLY (a temp file and a rename), because two processes read these files -- the gate and the tick -- and a
 * half-written one must read as the previous one, and never as an empty object.
 * @param {string} path
 * @param {object} state
 * @param {(path: string, data: string) => void} [writer] a seam, so a test writes nowhere
 */
export function writeJsonObject(path, state, writer = writeFileSync) {
  mkdirSync(dirname(path), { recursive: true });
  writer(`${path}.tmp`, `${JSON.stringify(state)}\n`);
  renameSync(`${path}.tmp`, path);
}

/** @param {string} path @param {StallState} state @param {(path: string, data: string) => void} [writer] */
export function writeStallState(path, state, writer = writeFileSync) {
  writeJsonObject(path, state, writer);
}

// --- THE ORDERS -----------------------------------------------------------------------------------------------------

/** @param {number} ms */
const minutes = (ms) => Math.round(ms / MINUTE_MS);

/**
 * @typedef {{ row: number, session: string, why: "stalled" | "blocked" | "merged", branch: string | null,
 *   worktree: string | null, idleMinutes: number | null, nudgedAt: number | null, edges?: number[],
 *   mergedPr?: number, answer?: string }} ReleaseRequest
 * @typedef {{ session: string, cause: string, subject: string, discriminator: string, prompt: string, causeKey: string,
 *   title?: string, release?: ReleaseRequest }} StallOrder
 */

/**
 * The nudge, to the holder: NAMES THE ROW AND THE INTERVAL (Acceptance 1), says what counts as a move so it can be
 * answered in one command, and says what happens if it is not -- including that the work is KEPT.
 *
 * KEYED ON `nudgedAt`, so the key is one per stall episode: it is byte-identical on every tick of the offer window (the
 * ledger drops the repeats) and a row that stalls again later is a new question.
 * @param {ClaimFacts} facts @param {number} nudgedAt @param {number} lastMoveAt @returns {StallOrder}
 */
function nudgeOrder(facts, nudgedAt, lastMoveAt) {
  const idle = minutes(nudgedAt - lastMoveAt);
  return {
    session: facts.session, cause: "claim-stalled", subject: `row-${facts.row}`, discriminator: `nudge-${nudgedAt}`,
    prompt: `#${facts.row} IS YOURS AND NOTHING ON IT HAS MOVED FOR ${idle} MINUTES (the gate's interval is `
      + `${minutes(STALL_INTERVAL_MS)}): no commit on \`${facts.branch ?? "its branch"}\`, no push, no pull request, no `
      + `changed file in \`${facts.worktree ?? "its worktree"}\`, no row comment from you. THE SIGNAL IS THE ROW, NOT YOU: `
      + "being busy on something else is exactly the case this exists for (#2407, a worktree with 215 uncommitted lines "
      + "and nobody had touched it for seven hours while its holder worked another row).\n"
      + "IF YOU ARE WORKING ON IT, SAY SO IN ONE COMMAND: commit what you have, push the branch, or comment on the row. Any "
      + "of the three is a move and resets the clock. IF YOU CANNOT, say what stops you in a FIELD, not a sentence "
      + "(`answer:<session>` for a ruling, `gh issue edit <n> --add-blocked-by <m>` for a row you wait on, "
      + "`Not-before:` for a date) -- each clears itself.\n"
      + `IF NOTHING MOVES FOR ANOTHER ${minutes(STALL_INTERVAL_MS)} MINUTES the claim is RELEASED and the row goes back to `
      + "the pool. Your worktree and everything unpushed in it are KEPT, and the next instance starts in them: nothing "
      + "you have built is lost, and nothing you have not built is held.",
    causeKey: `${facts.session}/${CLAIM_STALLED}/row-${facts.row}/nudge-${nudgedAt}`,
    ...(facts.title === undefined ? {} : { title: facts.title }),
  };
}

/**
 * The release, as an order `wake.mjs` PERFORMS. It carries every fact the performer needs and the prompt is only what a
 * log line says: a release is not a question, and no session is asked anything.
 * @param {ClaimFacts} facts @param {Extract<Reading, { kind: "release" }>} reading @returns {StallOrder}
 */
function releaseOrder(facts, reading) {
  /** @type {ReleaseRequest} */
  const release = { row: facts.row, session: facts.session, why: reading.why, branch: facts.branch, worktree: facts.worktree,
    idleMinutes: reading.idleMs === null ? null : minutes(reading.idleMs), nudgedAt: reading.nudgedAt,
    ...(reading.edges === undefined ? {} : { edges: reading.edges }),
    ...(reading.mergedPr === undefined ? {} : { mergedPr: reading.mergedPr, answer: "product-manager" }) };
  const said = reading.why === "stalled" ? `nothing moved for ${release.idleMinutes} minutes and the nudge was not answered`
    : reading.why === "blocked" ? `blocked by ${(reading.edges ?? []).map((n) => `#${n}`).join(", ")} and the holder holds nothing`
    : `#${reading.mergedPr} merged and the row stayed open`;
  return {
    session: facts.session, cause: "claim-stalled", subject: `row-${facts.row}`, discriminator: `release-${reading.why}`,
    prompt: `RELEASE the claim on #${facts.row} held by ${facts.session}: ${said}.`,
    causeKey: `${facts.session}/${CLAIM_STALLED}/row-${facts.row}/release-${reading.why}`, release,
  };
}

/**
 * The orders this tick's readings imply: a nudge for a row FIRST found stalled and for one still inside the offer window
 * of its nudge, and a release for a second reading, a blocked claim and a merged one. ONE ORDER PER ROW.
 *
 * @param {{ facts: ClaimFacts, reading: Reading }[] | undefined} readings @param {number} now
 * @returns {StallOrder[]}
 */
export function claimStalledOrders(readings, now) {
  /** @type {StallOrder[]} */
  const orders = [];
  for (const { facts, reading } of readings ?? []) {
    if (reading.kind === "nudge") orders.push(nudgeOrder(facts, now, reading.lastMoveAt));
    else if (reading.kind === "nudged" && now - reading.nudgedAt < NUDGE_OFFER_MS) {
      orders.push(nudgeOrder(facts, reading.nudgedAt, reading.lastMoveAt));
    } else if (reading.kind === "release") orders.push(releaseOrder(facts, reading));
  }
  return orders;
}

// --- THE HOST EVENTS ------------------------------------------------------------------------------------------------

/**
 * When `herdr.service` last STARTED, as epoch ms -- or `null` for anything that is not a time (the unit is not active, the
 * property is empty, `systemctl` would not answer). It answers only for the LATEST start; what is done for an earlier one
 * is `RESTART_STATE_FILE`, which keeps the last restart already acted on.
 *
 * `--timestamp=utc` because the default prints the host's zone as an abbreviation (`BST`) that no parser here can read.
 * @param {(args: string[]) => string} run `systemctl`'s stdout
 * @returns {number | null}
 */
export function readHerdrRestart(run) {
  try {
    const out = run(["--user", "show", "herdr.service", "-p", "ActiveEnterTimestamp", "--timestamp=utc"]);
    const m = /^ActiveEnterTimestamp=\w{3} (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) UTC$/m.exec(out);
    return m === null ? null : Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  } catch {
    return null;
  }
}

const INPUT_BOX_RULE = /^─{8,}$/;

/**
 * Does this pane's LAST LINE OF OUTPUT read `Interrupted`? "Last line" means the last non-empty line ABOVE the input box:
 * Claude Code draws a rule, the `❯` prompt and a second rule under everything it has printed, then a status footer, so
 * the bottom of the pane is never the answer. A pane with no box (a bare shell) is read from its own last line.
 *
 * `idle` is NOT the signal (#2470 measured herdr calling every interrupted pane `idle`), and the needle is anchored to the
 * LAST line so a session merely QUOTING the sentence earlier in its output is not resumed.
 * @param {string | null | undefined} text @returns {boolean}
 */
export function paneInterrupted(text) {
  const lines = String(text ?? "").split("\n").map((l) => l.trimEnd());
  const rules = lines.flatMap((l, i) => (INPUT_BOX_RULE.test(l.trim()) ? [i] : []));
  const content = rules.length >= 2 ? lines.slice(0, rules[rules.length - 2]) : lines;
  const last = [...content].reverse().find((l) => l.trim() !== "");
  return last !== undefined && last.includes(INTERRUPTED_TEXT);
}

/**
 * Deliveries a restart (or an interruption) killed: inside `windowMs` before `at`, and whose target made no move from the delivery until
 * `until`. `until` is `at` for an interruption noticed as it happens, and NOW for a restart: a tick that notices a restart LATE (the tick was
 * down, or this shipped after it) must not re-send what the session has since answered, so "no move before the restart" is read through to the
 * moment of asking. `moved` is asked only of a delivery inside the window.
 *
 * @template {{ session: string, at: number }} D
 * @param {{ deliveries: D[], at: number, until?: number, moved: (session: string, from: number, to: number) => boolean,
 *   windowMs?: number }} facts
 * @returns {D[]}
 */
export function killedDeliveries({ deliveries, at, until = at, moved, windowMs = RESTART_RESEND_WINDOW_MS }) {
  return deliveries.filter((d) => d.at >= at - windowMs && d.at < at && !moved(d.session, d.at, until));
}

/** @param {string} path @returns {number | null} the mtime in ms, `null` for a path that is gone */
export function statMtime(path) {
  try {
    return statSync(path).mtimeMs;
  } catch (err) {
    if (/** @type {any} */ (err)?.code === "ENOENT" || /** @type {any} */ (err)?.code === "ENOTDIR") return null;
    throw err;
  }
}

/** @param {string} path @returns {boolean} */
export const pathExists = (path) => existsSync(path);

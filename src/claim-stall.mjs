// @ts-check
// A CLAIM THAT DOES NOT MOVE, AND NOTHING THAT SAID SO -- #2470.
//
// `ceo`'s ruling on #2407 (2026-09-25): a row carried `session:worker-7` while `../wt-2407` held 215 lines
// uncommitted, unpushed, no pull request, last file change seven hours before -- and the session was BUSY the whole
// time, on another row. A status check says "working" and is right; THE ROW is what had stalled. Nothing in the gate
// read a claim going unmoved, and the one nudge that worked cost a `ceo` turn spent reading a pane.
//
// THIS FILE IS THE PURE HALF, AND A LEAF: it imports only `node:*`, the git-env scrubber, `claim-labels.mjs` and the
// shared `herdr-agents.mjs` leaf, so `work-gate.mjs` (which runs before any `pnpm install`) and `wake.mjs` can both import
// it without one importing the other. It DECIDES; the gate carries the decision as an order and `wake.mjs` performs
// the parts that need a pane.
//
// FIVE THINGS LIVE HERE, EACH THE ANSWER TO ONE DONE-WHEN (#2470's, or #2747's):
//   1. THE READING (`claimReading`): nudge, then release, on no progress on THE ROW for `STALL_INTERVAL_MS`.
//   2. THE RELEASES THAT ARE NOT A STALL: a claim whose row is BLOCKED and whose holder holds nothing (8), one whose
//      pull request MERGED while the row stayed open (10), and one whose SESSION IS GONE (#2747, `goneReading`).
//      Same predicate for "holds nothing" as the stall's keep-work.
//   3. THE READINGS OF A HOST EVENT: the `herdr.service` restart (11) and an interrupted pane (9).
//   4. THE STATE THE SECOND READING NEEDS: a released row carries no memory of the first nudge unless it is written
//      down, and it is written down in `claim-stalls.json`, beside the wake ledger. The same file remembers when a
//      holder was first found gone (#2747), so a transient partial listing cannot manufacture a release.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
// EVERY `git` SPAWN IN THIS REPO STRIPS `GIT_*` THROUGH ONE FUNCTION (`git-env.mjs`'s own header records the incident).
import { sandboxGitEnv } from "./lib/git-env.mjs";
import { CLAIM_RECORD_MARKER } from "./claim-labels.mjs";
import { ANSWER_PREFIX } from "./project-vocabulary.mjs";
// #3076: how a person is told a pull request's number -- `#38`, or `agent-org#38` for another tracked repository. A pure leaf, like the imports above.
import { subjectMention } from "./review-attribution.mjs";
// #2747: THE SAME "IS THIS LISTING THE WHOLE ORG" CHECK `wake.mjs`'s REVIEWER TEARDOWN USES (#2465) -- a leaf, so
// this file stays one. A listing that lacks `ceo`/`orchestrator` is a PARTIAL one and proves nothing about who else
// it left out; a session absent from a COMPLETE listing is real evidence, not yet a verdict (see `goneReading`).
import { listingIsComplete } from "./herdr-agents.mjs";
// #2999: THE IDLE-CLAIMANT READING, a sibling leaf. It decides whether an idle holder has a wait the org can read; this file carries the
// decision as the nudge and, a second reading later, as the release it already owned.
import { idleClaimantReading, idleNudgePrompt, IDLE_CLAIMANT_MS } from "./idle-claimant.mjs";

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
 *               at or below it. Ten of the thirteen above it are rows `ceo`'s 2026-09-25 ruling on the stalled sweep names as
 *               built, unpushed and idle (nine) or is the row that started it (#2407); the other three (#2181, #2223, #2451) were
 *               not examined.
 * WHAT THIS DOES NOT PROVE: that 120 is right for a slower regime. The population is one week of a fast one, and it is
 * rows that LANDED, so a row that stalled and was released never appears in it.
 */
export const STALL_INTERVAL_MS = 120 * MINUTE_MS;

/**
 * HOW LONG A NUDGE MAY GO UNDELIVERED before the claim is released anyway: twice N, counted from the nudge. A release is on the SECOND reading,
 * and the second reading is only fair to a holder that was TOLD: the nudge is offered every tick until the wake ledger records it delivered, and
 * the grace runs from THAT delivery (`claimReading`). A holder that is never wakeable -- `working` for hours, out of allowance, or gone -- would
 * otherwise hold the row for ever, so after this long the claim is released without the nudge having reached it; the work is kept either way.
 */
export const STALL_UNTOLD_RELEASE_MS = 2 * STALL_INTERVAL_MS;

/**
 * How long a pane must have been silent, with `Interrupted` as its last line, before it is RESUMED. Claude Code prints the same sentence when a
 * PERSON presses Esc as when the process under it was killed, and a person who stopped a session is about to type: resuming it two minutes later
 * would undo a deliberate stop. A killed pane stays interrupted for ever, so a wait costs the killed case only time. CHOSEN, NOT MEASURED: ten
 * minutes is long enough for a person to act and short beside the hours a killed session otherwise sits.
 */
export const INTERRUPTED_SETTLE_MS = 10 * MINUTE_MS;

/**
 * How long a claimed row's session must be ABSENT FROM A COMPLETE herdr LISTING before it is read as GONE, not merely
 * quiet (#2747). CHOSEN, NOT MEASURED: a genuinely closed workspace never reappears, so a wait costs only the false
 * case -- a listing that "dropped only some workspaces and happened to keep both [standing] panes"
 * ({@link listingIsComplete}'s own caveat, taken from #2465's measured shape of that exact failure). Ten minutes is a
 * handful of ticks (a tick is about two minutes), so ANY reappearance clears it before it matures, and it is still
 * far short of {@link STALL_INTERVAL_MS} -- the point of #2747 is not waiting hours for a hand-run `row-claim decline`.
 */
export const GONE_CONFIRM_MS = 10 * MINUTE_MS;

/**
 * The window before a `herdr.service` restart in which a delivery is presumed KILLED if its target made no move.
 *
 * MEASURED (2026-09-25, `worker-capture`, from the wake ledger itself): 1,352 cause deliveries that were
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

/**
 * What Claude Code prints when its OWN autocompact "rapid refill breaker" trips: the context refilled to the limit
 * within 3 turns of a compaction, 3 times in a row, so it stops the turn itself with this message instead of
 * compacting a fourth time (#2743's incident: worker-2623, 139 compactions, 5.4 hours, to a human's manual
 * interruption -- no code-level stop). EXTRACTED 2026-09-28 from the shipped binary itself
 * (`strings ~/.local/share/claude/versions/<version> | grep -A1 autocompact_thrashing`, the literal `apiError` code
 * and its message), not guessed. Anchored to the OPENING CLAUSE, not the full sentence: the message is long enough
 * to WRAP across several terminal lines and a single full-sentence needle (as {@link INTERRUPTED_TEXT} uses) would
 * never match any one of them. NOT SEEN LIVE: three attempts to force a real one (2026-09-28) were each cut off by
 * an unrelated safety classifier flagging the rapid mechanical repeated-file-read pattern as `[cyber]` before
 * compaction could thrash three times in a row; the needle is the shipped string and the first real thrash is
 * either matched by it or is a defect to report.
 */
export const THRASH_TEXT = "Autocompact is thrashing:";

/**
 * Claude Code's own turn-completion footer (`✻ Cooked for 1m 28s · done 9:57`, `✻ Baked for 7s · done 9:56`, one of
 * several whimsical verbs behind a spinner glyph that is not worth enumerating) -- printed ABOVE the input box after
 * a turn the process itself ended normally, unlike an interrupted (killed) pane's, which has nothing after its last
 * line because the process never got to print one. A thrash ends the turn the same way an ordinary completion does
 * (Claude Code's own query loop `yield`s the message, logs it, then returns -- the same shape as any other in-band
 * error), so THIS is what actually sits last above the box, not the message itself; `paneThrashed` must look past it.
 * The stable part is `done H:MM`, observed live in this same session multiple times -- not the verb, which varies.
 */
const DONE_FOOTER = /\bdone \d{1,2}:\d{2}\b/;

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
  const ran = spawnSync("git", gitInvocation(dir, args), { encoding: "utf8", env: sandboxGitEnv(), timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER });
  return { status: ran.status, out: ran.stdout ?? "" };
};

/**
 * THE ARGV, with `--no-optional-locks` where git accepts it: a GLOBAL option, before the subcommand. It is not a `status` flag -- `git status
 * --no-optional-locks` exits 129 (usage), which the first live run of this code found (the fakes in the tests answered any argv). It is on EVERY read,
 * and the reason is `status`'s: a plain one REFRESHES THE INDEX, and the index's mtime would be a "file change" caused by this very read.
 * @param {string} dir @param {string[]} args @returns {string[]}
 */
export function gitInvocation(dir, args) {
  return ["-C", dir, "--no-optional-locks", ...args];
}
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
 * {@link gitInvocation} is why it is safe to ask every tick: it never takes the index lock, so this read cannot manufacture the
 * "file change" it looks for.
 * @param {HostReads} io @param {string} dir @returns {number | null}
 */
export function fileMove({ git, mtime }, dir) {
  const out = mustGit(git, dir, ["status", "--porcelain", "--untracked-files=all", "-z"]);
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
 * IT ASSUMES A MERGE KEEPS THE BRANCH'S COMMITS reachable from `origin/main` (a MERGE COMMIT, which is what this repository's merge queue
 * makes -- read live at the first run: the merged branches of #2220 and #2188 both read `none`). A SQUASH-merging repository would leave the
 * branch's commits on no remote once its remote branch is pruned, and the merged release would read `at-risk` and never fire.
 *
 * @param {HostReads} io
 * @param {{ worktree: string | null, branch: string | null, repo: string }} where `repo` is any checkout of the repository
 * @returns {{ state: "none" | "at-risk" | "unknown", dirty: number, unpushed: number, why?: string }}
 */
export function workAtRisk(io, { worktree, branch, repo }) {
  try {
    if (worktree !== null && io.exists(worktree)) {
      const dirty = mustGit(io.git, worktree, ["status", "--porcelain", "--untracked-files=all"])
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
 *   openPrs: number, mergedPr: { number: number, mergedAt: number, repoKey?: string } | null,
 *   waiting: string | null, blockedBy: number[],
 *   waitKind?: string | null, ownPrs?: import("./idle-claimant.mjs").IdlePr[],
 * }} ClaimFacts
 *
 * @typedef {{ kind: "moving", lastMoveAt: number } | { kind: "pr-owned" } | { kind: "waiting", waiting: string }
 *   | { kind: "nudge", lastMoveAt: number, idleMs: number, idle?: boolean }
 *   | { kind: "nudged", nudgedAt: number, deliveredAt: number | null, lastMoveAt: number, idle?: boolean }
 *   | { kind: "idle-watch", since: number }
 *   | { kind: "vacating", since: number }
 *   | { kind: "release", why: "stalled" | "blocked" | "merged" | "gone", lastMoveAt: number | null, idleMs: number | null,
 *       nudgedAt: number | null, edges?: number[], mergedPr?: number, mergedPrRepoKey?: string, openPrs?: number[],
 *       openPrRepoKeys?: (string | undefined)[], since?: number, idle?: boolean }
 *   | { kind: "holding", why: string, expected?: boolean }} Reading
 */

/** @param {(number | null)[]} times @returns {number | null} */
function latest(times) {
  const known = times.filter((t) => t !== null);
  return known.length === 0 ? null : Math.max(.../** @type {number[]} */ (known));
}

/**
 * The reading of one claim, or why it is left alone: {@link clockReading}'s, and then -- for a claim it called `pr-owned` or `moving` -- the
 * IDLE-CLAIMANT overlay (#2999). Those two are the only readings that never asked what the holder is waiting for: every other reading
 * (a nudge, a release, a declared wait, a hold, a vacating session) has already decided.
 *
 * THE OVERLAY'S ORDER, AND WHY. A DECLARED FIELD ANSWERS EVERYTHING, so a holder carrying one is left on the clock's reading (which also drops
 * a remembered nudge: the holder answered it). Otherwise a remembered nudge that nothing has moved since is the SECOND reading, whatever the
 * holder's status is NOW -- a nudge wakes its holder, so by the next tick it is `working`, and a memory dropped on that tick would never reach
 * a release. Only then the idle clock: a first stall is the nudge, and a holder idle but short of N is `idle-watch`, which is how the first
 * idle tick is remembered (`herdr` reports a status and never since when).
 *
 * @param {ClaimFacts} facts
 * @param {{ now: number, restartAt: number | null, nudge: { nudgedAt: number, deliveredAt: number | null, idle?: boolean } | null,
 *   agents?: {label: string, status: string}[] | null, goneSince?: number | null, idleSince?: number | null, intervalMs?: number }} ctx
 * @returns {Reading}
 */
export function claimReading(facts, ctx) {
  const base = clockReading(facts, ctx);
  if (base.kind !== "pr-owned" && base.kind !== "moving") return base;
  const idle = idleClaimantReading({ session: facts.session, prs: facts.ownPrs ?? [],
    waitKinds: [...(facts.waitKind ? [facts.waitKind] : []), ...(facts.blockedBy.length > 0 ? ["blocked-by"] : [])] }, ctx);
  if (idle.kind === "waiting") return base;
  const held = ctx.nudge === null ? null : rememberedNudge(facts, ctx);
  if (held !== null) return held;
  if (idle.kind === "stall") return { kind: "nudge", idle: true, lastMoveAt: ctx.now - idle.idleMs, idleMs: idle.idleMs };
  if (idle.kind === "watching") return { kind: "idle-watch", since: idle.since };
  if (idle.kind === "unknown" && ctx.idleSince != null) return { kind: "idle-watch", since: ctx.idleSince };
  return base;
}

/**
 * The second reading of a REMEMBERED nudge, for a claim the clock called quiet-but-fine. The worktree is read HERE and only here: a row with no
 * nudge outstanding that is plainly moving costs no `git status` (`work-gate-claim-stalled.test.ts` pins it), and the overlay must not change that.
 * @param {ClaimFacts} facts @param {Parameters<typeof claimReading>[1]} ctx @returns {Reading | null}
 */
function rememberedNudge(facts, ctx) {
  const lastMoveAt = /** @type {number} */ (latest([facts.claimedAt, facts.comment, facts.commit, facts.push, ctx.restartAt, facts.file()]));
  return secondReading(facts, ctx, lastMoveAt);
}

/**
 * The CLOCK'S reading of one claim (#2470), or why it is left alone; {@link claimReading} adds the idle-claimant overlay (#2999) on top.
 *
 * ORDER IS THE DESIGN. A row with an OPEN PULL REQUEST is not this cause's: the PR-stage causes (`draft-awaiting-verdict`,
 * `pr-review-blocked`, `pr-green-unarmed`, `pr-merge-conflict`, `awaiting-evidence-stale`) each wake the author for an
 * actionable state, and a PR waiting on somebody else is not the holder stalling. THE ONE EXCEPTION IS A HOLDER THAT IS GONE (#3048): "owned
 * by a pull request" is not "owned by somebody", and the PR-stage causes wake an author who no longer exists, so every order to it is
 * `UNDELIVERED` on every tick for good. {@link goneWithOpenPrReading} releases it, and the row is HELD for `product-manager`, not returned to
 * the pool. A merged pull request whose row stayed
 * open is (10). An open `blockedBy` edge is (8) and NOT a wait to be respected, because a holder with nothing built has
 * nothing to protect. Only then a DECLARED wait (`answer:<session>`, a future `Not-before`, `needs:chairman`) -- data the
 * org already reads, so the row said why it is quiet. THE SESSION'S OWN STATUS IS NOT AN INPUT, and that is #2407's case:
 * `worker-7` was BUSY, on another row.
 *
 * THE CLOCK STARTS NO EARLIER THAN THE RESTART (11f): a session the outage silenced must not be nudged and then released
 * for a stall the gate itself caused and has not yet answered.
 *
 * THE SESSION'S EXISTENCE IS CHECKED BEFORE EVERYTHING BELOW BLOCKEDBY/WAITING (#2747): a gone session will never act
 * on a declared wait or a stale edge either, and #2623's own case (no open PR, no declared wait) is the ordinary shape
 * a merely-quiet claim was mistaken for. It runs AFTER `mergedReading`, because a merged `Closes: none` PR is a more
 * specific, positive outcome that deserves its own message even from a holder that has since closed its workspace.
 *
 * @param {ClaimFacts} facts
 * @param {Parameters<typeof claimReading>[1]} ctx
 * @returns {Reading}
 */
function clockReading(facts, ctx) {
  const interval = ctx.intervalMs ?? STALL_INTERVAL_MS;
  if (facts.openPrs > 0) return goneWithOpenPrReading(facts, ctx) ?? { kind: "pr-owned" };
  const landed = mergedReading(facts);
  if (landed !== null) return landed;
  const gone = goneReading(facts, ctx);
  if (gone !== null) return gone;
  if (facts.blockedBy.length > 0) return blockedReading(facts);
  if (facts.waiting !== null) return { kind: "waiting", waiting: facts.waiting };
  const cheap = /** @type {number} */ (latest([facts.claimedAt, facts.comment, facts.commit, facts.push, ctx.restartAt]));
  if (ctx.now - cheap < interval) return { kind: "moving", lastMoveAt: cheap };
  const lastMoveAt = /** @type {number} */ (latest([cheap, facts.file()]));
  if (ctx.now - lastMoveAt < interval) return { kind: "moving", lastMoveAt };
  const second = secondReading(facts, ctx, lastMoveAt);
  if (second !== null) return second;
  return { kind: "nudge", lastMoveAt, idleMs: ctx.now - lastMoveAt };
}

/**
 * THE SECOND READING: a nudge nothing has moved since. A move after the nudge, or a restart after it, is not "nothing", and the answer is then `null`.
 * IT IS FAIR ONLY TO A HOLDER THAT WAS TOLD: the grace runs from the nudge's DELIVERY, and a nudge that never reached its holder (working, out of
 * allowance, gone) releases after `STALL_UNTOLD_RELEASE_MS` from the nudge instead -- the work is kept either way. A holder with an OPEN PULL
 * REQUEST is never released (#2999): the release closes a spare's workspace, and a pull request whose author was closed under it is an
 * ownerless one -- so it stays `nudged`, and the nudge is not sent twice.
 * @param {ClaimFacts} facts @param {Parameters<typeof claimReading>[1]} ctx @param {number} lastMoveAt @returns {Reading | null}
 */
function secondReading(facts, ctx, lastMoveAt) {
  if (ctx.nudge === null || ctx.nudge.nudgedAt <= lastMoveAt) return null;
  const interval = ctx.intervalMs ?? STALL_INTERVAL_MS;
  const { nudgedAt, deliveredAt } = ctx.nudge;
  const idle = ctx.nudge.idle === true;
  const told = deliveredAt !== null && ctx.now - deliveredAt >= interval;
  if (facts.openPrs === 0 && (told || (deliveredAt === null && ctx.now - nudgedAt >= STALL_UNTOLD_RELEASE_MS))) {
    return { kind: "release", why: "stalled", lastMoveAt, idleMs: ctx.now - lastMoveAt, nudgedAt, ...(idle ? { idle } : {}) };
  }
  return { kind: "nudged", nudgedAt, deliveredAt, lastMoveAt, ...(idle ? { idle } : {}) };
}

/**
 * (#3048) A claim whose holder is GONE, on a row with an OPEN pull request of its own: {@link goneReading}'s reading (a `vacating` one, or the
 * `gone` release once {@link GONE_CONFIRM_MS} has passed) with the open PRs NAMED on the release, or `null` for a holder that is still there.
 *
 * WHAT BECOMES OF THE ROW IS RULED, NOT ASSUMED (`product-manager`, 2026-10-02): it is HELD FOR `product-manager` and NOT returned to the pool.
 * The claim labels come off and the PR and the kept worktree stay, but `ready` is not restored and `answer:product-manager` is set (the
 * release order's `answer`, which `decline` turns into that label), so `product-manager` reads the PR and rules: adopt it (a fresh `worker-<row>`
 * onto the existing branch) or close it and re-promote. A fresh claimant from the pool would build the row from its brief BESIDE a PR that
 * already carries the work: the ownerless-duplicate shape #2031 holds for a branch with no PR, where B4's file-overlap refusal would be an
 * incidental brake and not the design. A MERGED pull request is not this reading's (it keeps `pr-owned`, so `mergedReading` is not pre-empted).
 * @param {ClaimFacts} facts @param {Parameters<typeof claimReading>[1]} ctx @returns {Reading | null}
 */
function goneWithOpenPrReading(facts, ctx) {
  if (facts.mergedPr !== null) return null;
  const gone = goneReading(facts, ctx);
  if (gone === null || gone.kind !== "release") return gone;
  const own = facts.ownPrs ?? [];
  // The keys ride beside the numbers (which stay numbers) and only when a pull request is in another repository, so a home-only release is today's.
  return { ...gone, openPrs: own.map((pr) => pr.number), ...(own.some((pr) => pr.repoKey) ? { openPrRepoKeys: own.map((pr) => pr.repoKey || undefined) } : {}) };
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
    return { kind: "holding", expected: work.state !== "unknown",
      why: `${prMention(facts.mergedPr.number, facts.mergedPr.repoKey)} merged, but ${work.state === "unknown" ? "the worktree could not be read" : `the holder still has ${work.dirty} dirty file(s) and ${work.unpushed} unpushed commit(s)`}` };
  }
  return { kind: "release", why: "merged", lastMoveAt: null, idleMs: null, nudgedAt: null, mergedPr: facts.mergedPr.number,
    ...(facts.mergedPr.repoKey ? { mergedPrRepoKey: facts.mergedPr.repoKey } : {}) };
}

/**
 * herdr's word for a workspace with no agent detected in it (#2534, `wake.mjs`'s `hasNoAgent`, which this leaf cannot import).
 * @param {{status?: string}} agent
 */
function holdsNoAgent(agent) {
  return agent.status === "unknown";
}

/**
 * (#2747) A claim whose SESSION no longer exists in herdr's own listing -- not merely quiet, GONE: nobody is coming
 * back to finish it, nudged or not (#2623: workspace closed by hand, row left `session:worker-2623` with nothing
 * behind it, and nothing but the multi-hour stall clock would ever have caught it).
 *
 * `null` when nothing is learned this tick: herdr could not be asked (`ctx.agents` is `null`, NEVER read as gone from
 * silence), the session IS listed (definitive -- presence is positive evidence even in a listing that is otherwise
 * partial), or the listing is partial and nothing was seen before either (nothing to hold onto or advance).
 *
 * `vacating` is the interim, unreported state: first found absent from a COMPLETE listing, or still absent from one
 * on a later tick, but not yet {@link GONE_CONFIRM_MS} since the FIRST such tick. `ctx.goneSince` carries that first
 * tick forward (`nextStallState` writes it down, the same file the nudge memory lives in); a listing that is only
 * PARTIAL neither starts this clock nor resets it -- {@link listingIsComplete}'s own doc says why one complete
 * listing already needs a second to confirm a death, and this needs a wall-clock window of them for the same reason:
 * a session seen even once in the meantime is not gone, and any tick it is seen resets the whole thing (`claimReading`
 * never calls this when the session IS listed, so there is no reading here to carry a stale `since` forward).
 *
 * A holder whose workspace is listed but holds NO AGENT is read as absent too (#2863): herdr reports `unknown` for a pane
 * where no agent is detected, which is what a crashed claude leaves behind (`worker-2845`'s Bun segfault), and the label
 * survives it. Reading the label as presence offered the nudge every tick for hours to a session that could not receive
 * it, when this clock exists to release such a claim after ten minutes (#2534 closed the same defect for reviewers).
 * A holder listed WITH an agent is presence again, and resets the clock like any reappearance.
 *
 * @param {ClaimFacts} facts @param {{ now: number, agents?: {label: string, status: string}[] | null, goneSince?: number | null }} ctx
 * @returns {Reading | null}
 */
function goneReading(facts, ctx) {
  const agents = ctx.agents ?? null;
  if (agents === null) return null;
  if (agents.some((a) => a.label === facts.session && !holdsNoAgent(a))) return null;
  const goneSince = ctx.goneSince ?? null;
  if (!listingIsComplete(agents)) return goneSince === null ? null : { kind: "vacating", since: goneSince };
  const since = goneSince ?? ctx.now;
  if (ctx.now - since >= GONE_CONFIRM_MS) {
    return { kind: "release", why: "gone", lastMoveAt: null, idleMs: null, nudgedAt: null, since };
  }
  return { kind: "vacating", since };
}

/**
 * (8) An OPEN `blockedBy` edge and a holder holding nothing: released at once, no nudge. A holder that has built something
 * keeps the claim (its edge arrived while it held the row, and `claimed-row-amended` is what tells it).
 * @param {ClaimFacts} facts @returns {Reading}
 */
function blockedReading(facts) {
  const work = facts.work();
  if (work.state !== "none") {
    return { kind: "holding", expected: work.state !== "unknown", why: work.state === "unknown" ? "blocked, and the worktree could not be read"
      : `blocked, but the holder has ${work.dirty} dirty file(s) and ${work.unpushed} unpushed commit(s)` };
  }
  return { kind: "release", why: "blocked", lastMoveAt: null, idleMs: null, nudgedAt: null, edges: facts.blockedBy };
}

// --- THE FACTS OF ONE ROW ---------------------------------------------------------------------------------------------

/**
 * @typedef {import("./idle-claimant.mjs").IdlePr & { headRefName?: string }} OpenPr
 * @typedef {{ number: number, headRefName?: string, mergedAt?: string }} MergedPr
 * @typedef {{ open: OpenPr[] | null, merged: MergedPr[] | null }} ElsewherePrs the OTHER tracked code repositories' lists (#3075), each member
 *   tagged with the `repoKey` it came from. `open: null` is a read that was refused, and is never "none open".
 * @typedef {{ row: number, title?: string, session: string, waiting: string | null, blockedBy: number[],
 *   comments: RowComment[], openPrs: OpenPr[], mergedPrs: MergedPr[] | null, elsewhere?: ElsewherePrs, repo: string,
 *   waitKind?: string | null }} ClaimInput `openPrs` and `mergedPrs` are the HOME repository's; `elsewhere` is absent for a project with one code repository
 */

/**
 * (#3075) THE PULL REQUESTS A ROW'S WORK CAN BE IN, from every tracked code repository, by the ONE function every reader of "has this row got a pull
 * request" goes through: (8)'s `canRelease`, `pr-owned`, the second reading's guard, the gone-holder release and the merged release (10) all read
 * `facts.openPrs`, `facts.ownPrs` and `facts.mergedPr`, and all three are built from what this returns. `#3039`'s code was in `a11ign/agent-org`, its pull
 * request approved there, and the claim was released as "holds nothing built" because only THIS repository's list was read.
 *
 * `null` when an OPEN list could not be read, and the caller skips the claim: a read that could not be made is not a count of zero, and "zero" is what
 * (8) and the stalled release act on. A MERGED list only ever supplies positive evidence (the release (10) needs a hit), so one that is missing costs a
 * release and cannot cause one: the lists that WERE read are used, and it is `null` only when none was.
 * @param {ClaimInput} input @returns {{ open: OpenPr[], merged: MergedPr[] | null } | null}
 */
function pullRequestsAcrossRepos(input) {
  const { elsewhere } = input;
  if (elsewhere === undefined) return { open: input.openPrs, merged: input.mergedPrs };
  if (elsewhere.open === null) return null;
  const merged = input.mergedPrs === null && elsewhere.merged === null ? null : [...(input.mergedPrs ?? []), ...(elsewhere.merged ?? [])];
  return { open: [...input.openPrs, ...elsewhere.open], merged };
}

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
  const prs = pullRequestsAcrossRepos(input);
  if (prs === null) {
    return { skip: `#${input.row}: the other tracked repository's open pull requests could not be read, so a holder with nothing built here cannot be told from one whose work is there` };
  }
  const worktree = record.worktree === null ? null : resolve(input.repo, record.worktree);
  const dir = worktree !== null && io.exists(worktree) ? worktree : input.repo;
  try {
    const branch = record.branch;
    const own = (/** @type {string | undefined} */ head) => head !== undefined && (head === branch || head.endsWith(`-${input.row}`));
    const ownPrs = prs.open.filter((p) => own(p.headRefName));
    const merged = branch === null ? null : newestMergedAfter(prs.merged ?? [], branch, record.at);
    return { row: input.row, session: input.session, claimedAt: record.at, branch, worktree,
      ...(input.title === undefined ? {} : { title: input.title }),
      comment: commentMove(input.comments, record),
      commit: branch === null ? null : newestOwnCommit(io.git, dir, branch),
      push: branch === null ? null : newestOwnCommit(io.git, dir, `origin/${branch}`),
      file: () => (worktree !== null && io.exists(worktree) ? fileMove(io, worktree) : null),
      work: () => workAtRisk(io, { worktree, branch, repo: input.repo }),
      openPrs: ownPrs.length,
      mergedPr: merged === null ? null : { number: merged.number, mergedAt: Date.parse(String(merged.mergedAt)), ...(merged.repoKey ? { repoKey: merged.repoKey } : {}) },
      waiting: input.waiting, blockedBy: input.blockedBy,
      ...(input.waitKind === undefined ? {} : { waitKind: input.waitKind }),
      ownPrs };
  } catch (err) {
    if (err instanceof Unreadable) return { skip: `#${input.row}: ${err.message}` };
    throw err;
  }
}

/**
 * The newest pull request MERGED from `branch` after `since`, or `null`: a merge before this claim is another instance's work on the row.
 * @param {{ number: number, headRefName?: string, mergedAt?: string, repoKey?: string }[]} merged @param {string} branch @param {number} since
 * @returns {{ number: number, mergedAt: string, repoKey?: string } | null}
 */
function newestMergedAfter(merged, branch, since) {
  const after = merged.filter((p) => p.headRefName === branch && Date.parse(String(p.mergedAt ?? "")) > since);
  const [newest] = after.sort((a, b) => Date.parse(String(b.mergedAt)) - Date.parse(String(a.mergedAt)));
  return newest === undefined ? null : { number: newest.number, mergedAt: String(newest.mergedAt), repoKey: newest.repoKey };
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

/**
 * @typedef {Record<string, { session: string, nudgedAt?: number, goneSince?: number, idleSince?: number, idle?: boolean }>} StallState
 * keyed by row number, one memory or the other per row: a nudge (`idle` when it was the idle-claimant's, #2999), the tick a session was first
 * found gone, or the tick a holder was first found idle.
 */

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
 * The memory after this tick's readings: a NUDGE is recorded at `now`, a `nudged` row keeps its record (and so does a STALL release
 * that is not yet performed), a `vacating` row (#2747) keeps the tick its session was FIRST found gone (and so does a GONE release
 * that is not yet performed), and every other row -- moving, no longer claimed by that session, or a session that reappeared -- loses
 * its memory, so a row that stalls (or vacates) a second time is a first reading again and not a release on the strength of last
 * week's nudge (or an old absence a listing has since taken back).
 *
 * @param {StallState} before
 * @param {{ facts: ClaimFacts, reading: Reading }[]} readings @param {number} now
 * @returns {StallState}
 */
export function nextStallState(before, readings, now) {
  /** @type {StallState} */
  const after = {};
  for (const { facts, reading } of readings) {
    const memory = memoryOf(reading, now);
    if (memory !== null) after[facts.row] = { session: facts.session, ...memory };
  }
  return JSON.stringify(after) === JSON.stringify(before) ? before : after;
}

/**
 * What one reading leaves in the memory, or `null` for nothing. A NUDGE is recorded at `now` (`idle` when it was the idle-claimant's, #2999), a
 * `nudged` one keeps its record, an `idle-watch` the tick the holder was first found idle, a `vacating` one the tick it was first found gone.
 *
 * A STALL RELEASE THAT HAS NOT YET BEEN PERFORMED KEEPS ITS MEMORY: `wake.mjs` performs it after this tick, may fail (a workspace that will
 * not close, a decline that is refused), and the gate emits the order again next tick -- which must read as the SECOND reading again, not
 * forget the nudge and start a fresh two hours. Once performed the row is no longer claimed and the entry goes with it. A GONE RELEASE THAT HAS
 * NOT YET BEEN PERFORMED keeps its `goneSince` for the same reason.
 * @param {Reading} reading @param {number} now @returns {{ nudgedAt?: number, goneSince?: number, idleSince?: number, idle?: boolean } | null}
 */
function memoryOf(reading, now) {
  const idle = "idle" in reading && reading.idle ? { idle: true } : {};
  if (reading.kind === "nudge") return { nudgedAt: now, ...idle };
  if (reading.kind === "nudged") return { nudgedAt: reading.nudgedAt, ...idle };
  if (reading.kind === "idle-watch") return { idleSince: reading.since };
  if (reading.kind === "vacating") return { goneSince: reading.since };
  if (reading.kind !== "release") return null;
  if (reading.why === "stalled" && reading.nudgedAt !== null) return { nudgedAt: reading.nudgedAt, ...idle };
  if (reading.why === "gone" && reading.since !== undefined) return { goneSince: reading.since };
  return null;
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
 * @typedef {{ row: number, session: string, why: "stalled" | "blocked" | "merged" | "gone", branch: string | null,
 *   worktree: string | null, idleMinutes: number | null, nudgedAt: number | null, edges?: number[],
 *   mergedPr?: number, mergedPrRepoKey?: string, openPrs?: number[], openPrRepoKeys?: (string | undefined)[], answer?: string }} ReleaseRequest
 * @typedef {{ session: string, cause: string, subject: string, discriminator: string, prompt: string, causeKey: string,
 *   title?: string, release?: ReleaseRequest, resume?: boolean }} StallOrder
 */

/**
 * The nudge to an IDLE holder (#2999): the same cause, key and delivery as {@link nudgeOrder}'s -- so the ledger, the offer window and the
 * second reading's release are ONE mechanism -- with the text that spells the wait fields. A holder re-offered the nudge (not yet delivered)
 * is told the floor, `IDLE_CLAIMANT_MINUTES`, because only the first reading knew how long it had been idle.
 * @param {ClaimFacts} facts @param {number} nudgedAt @param {number} idleMs @returns {StallOrder}
 */
function idleNudgeOrder(facts, nudgedAt, idleMs) {
  return {
    session: facts.session, cause: "claim-stalled", subject: `row-${facts.row}`, discriminator: `idle-nudge-${nudgedAt}`,
    prompt: idleNudgePrompt({ row: facts.row, branch: facts.branch, idleMinutes: minutes(idleMs), releaseMinutes: minutes(STALL_INTERVAL_MS),
      canRelease: facts.openPrs === 0 }),
    causeKey: nudgeKey(facts.session, facts.row, nudgedAt), resume: true,
    ...(facts.title === undefined ? {} : { title: facts.title }),
  };
}

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
      + `(\`${ANSWER_PREFIX}<session>\` for a ruling, \`gh issue edit <n> --add-blocked-by <m>\` for a row you wait on, `
      + "`Not-before:` for a date) -- each clears itself.\n"
      + `IF NOTHING MOVES FOR ${minutes(STALL_INTERVAL_MS)} MINUTES AFTER THIS REACHES YOU the claim is RELEASED (the row is offered to `
      + "the pool again, or comes to `product-manager` if it was not Ready before you took it). Your worktree and everything unpushed in it "
      + "are KEPT, and the next instance starts in them: nothing you have built is lost, and nothing you have not built is held.",
    causeKey: nudgeKey(facts.session, facts.row, nudgedAt),
    // A NUDGE IS SENT AS A PLAIN PROMPT, NEVER BEHIND A `/clear` (#2470): its whole subject is what the session has built, and a standing seat
    // that was wiped first would be asked "what have you done" by a context that has forgotten.
    resume: true,
    ...(facts.title === undefined ? {} : { title: facts.title }),
  };
}

/**
 * The nudge's `causeKey`: one per stall episode. The gate derives it here and reads the wake ledger for it, and `wake.mjs` records it on delivery,
 * so the key has ONE spelling. @param {string} session @param {number} row @param {number} nudgedAt
 */
export function nudgeKey(session, row, nudgedAt) {
  return `${session}/${CLAIM_STALLED}/row-${row}/nudge-${nudgedAt}`;
}

/**
 * When the wake ledger last recorded `key` as DELIVERED, or `null`: the line `<epochMs>\t<causeKey>[...]` the tick writes once herdr has accepted the
 * prompt, with a `VOIDED` line (a delivery a restart killed) taking one back. THE LEDGER'S FORMAT IS `wake.mjs`'s, which this leaf cannot import, so
 * the test writes a line with the real `ledgerLine` and reads it here: a change of format breaks that test and not the release.
 * @param {string} raw the ledger's text @param {string} key @returns {number | null}
 */
export function nudgeDeliveredAt(raw, key) {
  /** @type {number[]} */
  const times = [];
  for (const line of raw.split("\n")) {
    const fields = line.trim().split("\t");
    const at = Number(fields[0]);
    if (!Number.isFinite(at)) continue;
    if (fields[1] === "VOIDED" && fields[2] === key) {
      const index = times.lastIndexOf(Number(fields[3]));
      times.splice(index === -1 ? times.length - 1 : index, 1);
    } else if (fields[1] === key) times.push(at);
  }
  return times.length === 0 ? null : Math.max(...times);
}

/**
 * (#3076) A PULL REQUEST'S NUMBER AS A PERSON READS IT: `#38` for the home repository, `agent-org#38` for another tracked one, because `#38` alone
 * opens the home repository's. Every spelling of a release's pull request -- the order's prompt here, the comment `wake.mjs` leaves on the row --
 * goes through this and the two below, so no sentence can name one without saying which repository it is in.
 * @param {number} number @param {string | undefined} repoKey @returns {string}
 */
function prMention(number, repoKey) {
  return subjectMention({ repoKey, number });
}

/** @param {{ mergedPr?: number, mergedPrRepoKey?: string }} release a release whose `why` is "merged" @returns {string} */
export function mergedPrMention(release) {
  return prMention(Number(release.mergedPr), release.mergedPrRepoKey);
}

/** @param {{ openPrs?: number[], openPrRepoKeys?: (string | undefined)[] }} release @returns {string} its open pull requests, comma-joined, each with its repository */
export function openPrMentions(release) {
  return (release.openPrs ?? []).map((n, i) => prMention(n, release.openPrRepoKeys?.[i])).join(", ");
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
    ...(reading.mergedPr === undefined ? {} : { mergedPr: reading.mergedPr, answer: "product-manager",
      ...(reading.mergedPrRepoKey === undefined ? {} : { mergedPrRepoKey: reading.mergedPrRepoKey }) }),
    // HELD, NOT POOLED (#3048): a gone holder's open PR is the work, so the row goes to `product-manager` and `ready` is not restored.
    ...(reading.openPrs === undefined || reading.openPrs.length === 0 ? {} : { openPrs: reading.openPrs, answer: "product-manager",
      ...(reading.openPrRepoKeys === undefined ? {} : { openPrRepoKeys: reading.openPrRepoKeys }) }) };
  const said = reading.why === "stalled" && reading.idle ? `idle with no wait field and nothing moved for ${release.idleMinutes} minutes, and the nudge was not answered`
    : reading.why === "stalled" ? `nothing moved for ${release.idleMinutes} minutes and the nudge was not answered`
    : reading.why === "blocked" ? `blocked by ${(reading.edges ?? []).map((n) => `#${n}`).join(", ")} and the holder holds nothing`
    : reading.why === "gone" ? `${facts.session} no longer exists in herdr's own listing${release.openPrs === undefined ? ""
      : `, and ${openPrMentions(release)} is still open (the row is held for product-manager, not returned to the pool)`}`
    : `${mergedPrMention(release)} merged and the row stayed open`;
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
    if (reading.kind === "nudge" && reading.idle) orders.push(idleNudgeOrder(facts, now, reading.idleMs));
    else if (reading.kind === "nudge") orders.push(nudgeOrder(facts, now, reading.lastMoveAt));
    // OFFERED UNTIL DELIVERED, and then never again: the ledger holds a delivered key for one wake window only, so an offer that outlived the
    // delivery would send it a second time.
    else if (reading.kind === "nudged" && reading.deliveredAt === null) {
      orders.push(reading.idle ? idleNudgeOrder(facts, reading.nudgedAt, IDLE_CLAIMANT_MS) : nudgeOrder(facts, reading.nudgedAt, reading.lastMoveAt));
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
 * Did this pane's LAST TURN end in the autocompact thrash guard? Above the input box exactly as {@link paneInterrupted}
 * reads it, but over the last PARAGRAPH (the trailing run of non-empty lines), not the last line: {@link THRASH_TEXT}'s
 * message wraps, so one line is not enough. A trailing {@link DONE_FOOTER} line is Claude Code's own completion chrome,
 * never the message, and is dropped first so the paragraph it belongs to is not mistaken for the one before it.
 *
 * Anchored to the last paragraph for the same reason `paneInterrupted` anchors to the last line: a session merely
 * DISCUSSING this string (this very row, read into its own pane) is not this turn's.
 * @param {string | null | undefined} text @returns {boolean}
 */
export function paneThrashed(text) {
  const lines = String(text ?? "").split("\n").map((l) => l.trimEnd());
  const rules = lines.flatMap((l, i) => (INPUT_BOX_RULE.test(l.trim()) ? [i] : []));
  const content = rules.length >= 2 ? lines.slice(0, rules[rules.length - 2]) : lines;
  let end = content.length;
  while (end > 0 && content[end - 1].trim() === "") end--;
  if (end > 0 && DONE_FOOTER.test(content[end - 1])) end--;
  while (end > 0 && content[end - 1].trim() === "") end--;
  let start = end;
  while (start > 0 && content[start - 1].trim() !== "") start--;
  const paragraph = content.slice(start, end).join(" ");
  return paragraph.includes(THRASH_TEXT);
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

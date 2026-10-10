// @ts-check
// A CLAIM THAT DOES NOT MOVE, AND NOTHING THAT SAID SO -- #2470.
//
// `ceo`'s ruling on #2407 (2026-09-25): a row carried `session:worker-7` while `../wt-2407` held 215 lines
// uncommitted, unpushed, no pull request, last file change seven hours before -- and the session was BUSY the whole
// time, on another row. A status check says "working" and is right; THE ROW is what had stalled. Nothing in the gate
// read a claim going unmoved, and the one nudge that worked cost a `ceo` turn spent reading a pane.
//
// THIS FILE IS THE PURE HALF, AND A LEAF: it imports only `node:*`, the git-env scrubber, `claim-labels.ts` and the
// shared `herdr-agents.ts` leaf, so `work-gate.ts` (which runs before any `pnpm install`) and `wake.ts` can both import
// it without one importing the other. It DECIDES; the gate carries the decision as an order and `wake.ts` performs
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
// EVERY `git` SPAWN IN THIS REPO STRIPS `GIT_*` THROUGH ONE FUNCTION (`git-env.ts`'s own header records the incident).
import { sandboxGitEnv } from "@a11ign/toolchain/lib/git-env";
import { CLAIM_RECORD_MARKER } from "./claim-labels.ts";
import { ANSWER_PREFIX, SESSION_PREFIX } from "./project-vocabulary.ts";
// #3076: how a person is told a pull request's number -- `#38`, or `agent-org#38` for another tracked repository. A pure leaf, like the imports above.
import { subjectMention } from "./review-attribution.ts";
// #2747: THE SAME "IS THIS LISTING THE WHOLE ORG" CHECK `wake.ts`'s REVIEWER TEARDOWN USES (#2465) -- a leaf, so
// this file stays one. A listing that lacks `ceo`/`orchestrator` is a PARTIAL one and proves nothing about who else
// it left out; a session absent from a COMPLETE listing is real evidence, not yet a verdict (see `goneReading`).
import { listingIsComplete } from "./herdr-agents.ts";
// #2999: THE IDLE-CLAIMANT READING, a sibling leaf. It decides whether an idle holder has a wait the org can read; this file carries the
// decision as the nudge and, a second reading later, as the release it already owned.
import { idleClaimantReading, idleNudgePrompt, stoppedNudgePrompt, declareNudgePrompt, isStoppedHolder, IDLE_CLAIMANT_MS, STOPPED_CLAIMANT_MS } from "./idle-claimant.ts";
import type { DeclarationReading } from "./worker-state.ts";
// #458: the failure ledger is a leaf of its own (`node:fs` only), so a recorder here keeps this file one.
import { recordFailures, type FailureEvent, type RecordResult } from "./failure-ledger.ts";
// #3445: WHETHER A PULL REQUEST IS THE CLAIMANT'S, for the open lookup and the merged one alike: a sibling leaf, so this file stays one.
import { ownsPr } from "./pr-ownership.ts";
import type { LabelEvent } from "./claim-provenance.ts";
// #3453: where a keyed repository's clone lives (`host.json`'s `clones`), for the read of the worktrees a merged pull request's work was in. A leaf too.
import { hostConfigPath, readHostConfig } from "./host-config.ts";

const MINUTE_MS = 60_000;

/**
 * The cause a nudge and a release both carry. One cause: the answer is an ACTION, never a question. THE ORDERS BELOW SPELL IT
 * AS A LITERAL, not through this constant, because `worker-profile.test.ts` finds the causes the gate emits by scanning for
 * `cause: "<name>"` -- and a test pins that the two spellings are the same string.
 */
export const CLAIM_STALLED = "claim-stalled";

/**
 * THE CAUSES THAT REPEAT AN ORDER TO A WORKER ON ITS OWN CLAIM (#4070, #4055 move 2): each is a "go back to your work" order, and each costs a
 * full-context turn. The count of these per claim is what {@link MAX_CONTINUATIONS} caps. Spelled as strings, not read from the gate, for the
 * reason {@link CLAIM_STALLED} gives.
 */
export const CONTINUATION_CAUSES = Object.freeze([CLAIM_STALLED, "pr-checks-failing", "pr-review-blocked", "answer-label-unexplained"]);

/**
 * THE nTH GATE ORDER TO ONE CLAIM GOES TO `orchestrator`, NOT TO THE WORKER AGAIN: three, the report's "two or three" at its upper end. A worker
 * sent the same kind of reminder twice and still not moving is not helped by a third copy of it; someone who can see why must. The row takes the
 * report's upper figure because the A/B cannot tell a cap that is too tight from a worker that needed the order, and escalating earlier would
 * hide the second. A reading to change it from is the A/B's own (continuations per claim, median and p90), not an opinion.
 */
export const MAX_CONTINUATIONS = 3;

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
const CLAIMED_NOTHING = /^Claimed-nothing:\s*(.+)$/m;
const CLAIMED_BY = /-- claimed by `/;

export type RowComment = { body?: string, createdAt?: string, author?: { login?: string } | null, id?: string };
/**
 * `nothing` is #3407's `Claimed-nothing:` claim: a claim that names no git object on purpose, which is evaluated by the clock and never released
 */
export type ClaimRecord = { at: number, author: string | null, branch: string | null, worktree: string | null, nothing: boolean };

/**
 * The newest claim record on a row, or `null` when none is a CLAIM: no record at all (a dispatch, or a claim that named
 * neither a branch nor a worktree), or the newest one is a RELEASE. `row-claim.ts` owns the format
 * (`claimRecordComment`) and is unimportable from a tick, so this reads it by the same marker and the same three field
 * names, and the test round-trips the real writer through it. A `Claimed-nothing:` record (#3407) IS a claim, with a null
 * branch and worktree; a release has no field and is "released by", so the two never share a spelling.
 *
 * `at` is the record's own time and `author` its account -- which is how "a row comment BY THAT SESSION" is answered
 * without a session-to-account table: the claim was made under the account the claimant runs as.
 *
 * @param {RowComment[]} comments oldest first, the order `gh issue list --json comments` returns
 * @returns {ClaimRecord | null}
 */
export function claimRecordOf(comments: RowComment[]): ClaimRecord | null {
  const newest = comments.filter((c) => String(c.body ?? "").includes(CLAIM_RECORD_MARKER)).at(-1);
  if (newest === undefined || !CLAIMED_BY.test(String(newest.body))) return null;
  const body = String(newest.body);
  const at = Date.parse(String(newest.createdAt ?? ""));
  if (Number.isNaN(at)) return null;
  return { at, author: newest.author?.login ?? null,
    branch: CLAIMED_BRANCH.exec(body)?.[1].trim() ?? null, worktree: CLAIMED_WORKTREE.exec(body)?.[1].trim() ?? null,
    nothing: CLAIMED_NOTHING.test(body) };
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
export function commentMove(comments: RowComment[], record: ClaimRecord): number | null {
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
 * One process run, WITHOUT a throw: the status decides what an answer MEANS (`rev-parse --verify` exits 1 for "no such ref", which is an answer, and anything else is "could not ask", which is not one).
 */
export type GitRun = (dir: string, args: string[]) => { status: number | null, out: string };
export type CloneAnswer = { clone: string } | { refusal: string };
/**
 * `cloneOf` (#3453) is the seam for WHERE A KEYED REPOSITORY'S CLONE LIVES; absent, it is `host.json`'s declaration ({@link cloneOfKey}).
 * `labelEvents` (#4789) is the row's `labeled`/`unlabeled` history, `null` for a read that could not be made; absent, the caller does not
 * date the session label and a merge counts from the claim record alone, as it did before.
 */
export type HostReads = { git: GitRun, exists: (path: string) => boolean, mtime: (path: string) => number | null, cloneOf?: (key: string) => CloneAnswer,
  labelEvents?: (row: number) => LabelEvent[] | null };

/** A read that could not be made. NEVER an absence: "no commit" is `null`, "could not ask git" is this. */
export class Unreadable extends Error {}

/**
 * `git -C <dir> ...`, never throwing: a timeout or a spawn failure is `status: null`, which every reader above turns into
 * `Unreadable` rather than into "no commits".
 * @type {GitRun}
 */
export const gitRun: GitRun = (dir, args) => {
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
export function gitInvocation(dir: string, args: string[]): string[] {
  return ["-C", dir, "--no-optional-locks", ...args];
}
const GIT_TIMEOUT_MS = 20_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

/** @param {GitRun} git @param {string} dir @param {string[]} args @returns {string} */
function mustGit(git: GitRun, dir: string, args: string[]): string {
  const ran = git(dir, args);
  if (ran.status !== 0) throw new Unreadable(`git ${args.slice(0, 2).join(" ")} in ${dir} exited ${ran.status}`);
  return ran.out;
}

/**
 * The commit time (ms) of the newest commit `ref` holds that `origin/main` does not, `null` when it holds none or `ref`
 * does not exist. A branch that is not ahead of main has no commit of its own, and its tip's date is main's, not a move.
 * @param {GitRun} git @param {string} dir @param {string} ref @returns {number | null}
 */
export function newestOwnCommit(git: GitRun, dir: string, ref: string): number | null {
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
export function fileMove({ git, mtime }: HostReads, dir: string): number | null {
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
 * @returns {{ state: "none" | "at-risk" | "unknown", dirty: number, unpushed: number, why?: string, trees?: string[] }}
 */
export function workAtRisk(io: HostReads, { worktree, branch, repo }: { worktree: string | null; branch: string | null; repo: string; }): { state: "none" | "at-risk" | "unknown"; dirty: number; unpushed: number; why?: string; trees?: string[]; } {
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

// --- THE PULL REQUEST'S OWN REPOSITORY (#3453) -------------------------------------------------------------------------

/**
 * #2969: WHERE A DECLARED KEY'S CLONE LIVES, from `host.json`'s `clones` (`{ "<key>": "<absolute path>" }`), or why it cannot be said. A clone is a
 * machine fact no repository can know (ADR 0040, decision 3). EVERY failure is a refusal naming the host file and what is wrong -- an unreadable file
 * is never read as "no clone declared", and a clone is never defaulted to the primary's checkout, whose `origin` is the wrong repository's. The reading
 * is `host-config.ts`'s (#2991), so a relative clone is refused with the whole file, naming `clones.<key>`. MOVED HERE from `wake.ts`'s
 * `reviewCloneOf` (which now calls it), because the merged release reads the same clones and this file cannot import `wake.ts`.
 * @param {string} key @param {{ path?: string, read?: typeof readFileSync }} [from] @returns {CloneAnswer}
 */
export function cloneOfKey(key: string, { path = hostConfigPath(), read = readFileSync }: { path?: string; read?: typeof readFileSync; } = {}): CloneAnswer {
  let host: Readonly<import("./host-config.ts").HostConfig>;
  try {
    host = readHostConfig(path, read);
  } catch (err) {
    return { refusal: `${path} cannot be read as the host declaration (${String((err as any)?.message ?? err).split("\n")[0]})` };
  }
  const clone = host.clones !== undefined && Object.hasOwn(host.clones, key) ? host.clones[key] : undefined;
  return clone === undefined ? { refusal: `${path} declares no absolute \`clones.${key}\` path` } : { clone };
}

/**
 * The worktrees `git worktree list --porcelain` names, each with its branch (`null` for a detached or bare one: a detached HEAD names no pull request,
 * so no test can say whose it is, and it is not read).
 * @param {string} out @returns {{ path: string, branch: string | null }[]}
 */
function worktreesListed(out: string): { path: string; branch: string | null; }[] {
  return out.split(/\n\s*\n/).flatMap((block) => {
    const lines = block.split("\n");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
    if (path === undefined || lines.includes("bare")) return [];
    const ref = lines.find((l) => l.startsWith("branch "))?.slice("branch ".length) ?? null;
    return [{ path, branch: ref === null ? null : ref.replace(/^refs\/heads\//, "") }];
  });
}

/**
 * THE WORK THE HOLDER HOLDS IN THE REPOSITORY A MERGED PULL REQUEST WAS IN. #3390's claim named a branch in THIS repository and its work was a
 * worktree of the `a11ign/agent-org` clone on another branch, so a read of the claim record's tree alone saw a clean, untouched one and would have
 * released a holder with a follow-up dirty or unpushed THERE. The trees read are the clone's worktrees on a branch `ownsPr` says is the holder's (the
 * claimed branch, one ending `-<row>`) or on the merged pull request's own head: the test the pull request itself was found by, not a naming convention.
 *
 * FAILS TOWARD REFUSING, as {@link workAtRisk} does: no declared clone, a clone that cannot be listed, or a tree that cannot be read is `unknown`, never
 * "no worktree, so nothing to lose". A clone that LISTED and holds no tree of the holder's is `none`, which is an answer.
 * @param {HostReads} io
 * @param {{ repoKey: string, head?: string, claimant: import("./pr-ownership.ts").Claim }} merged
 * @returns {ReturnType<typeof workAtRisk>}
 */
export function workAtRiskInPrRepo(io: HostReads, { repoKey, head, claimant }: { repoKey: string; head?: string; claimant: import("./pr-ownership.ts").Claim; }): ReturnType<typeof workAtRisk> {
  const found = (io.cloneOf ?? cloneOfKey)(repoKey);
  if ("refusal" in found) return { state: "unknown", dirty: 0, unpushed: 0, why: `no clone of \`${repoKey}\` to read (${found.refusal})`, trees: [] };
  const listed = io.git(found.clone, ["worktree", "list", "--porcelain"]);
  if (listed.status !== 0) {
    return { state: "unknown", dirty: 0, unpushed: 0, why: `\`git worktree list\` in ${found.clone} exited ${listed.status}`, trees: [] };
  }
  const holders = worktreesListed(listed.out)
    .filter((t) => t.branch !== null && ((head !== undefined && t.branch === head) || ownsPr(claimant, { headRefName: t.branch }) !== null));
  const reads = holders.map((t) => ({ path: t.path, ...workAtRisk(io, { worktree: t.path, branch: t.branch, repo: found.clone }) }));
  return combined(reads.map((r) => ({ ...r, why: r.why === undefined ? undefined : `${r.path}: ${r.why}` })), holders.map((t) => t.path));
}

/**
 * Several readings as one: `unknown` outranks `at-risk` outranks `none`, the counts add, and the trees that were READ ride along so a live reading can
 * name them.
 * @param {ReturnType<typeof workAtRisk>[]} readings @param {string[]} [trees] @returns {ReturnType<typeof workAtRisk>}
 */
function combined(readings: ReturnType<typeof workAtRisk>[], trees: string[] = []): ReturnType<typeof workAtRisk> {
  const unknown = readings.find((r) => r.state === "unknown");
  const dirty = readings.reduce((n, r) => n + r.dirty, 0);
  const unpushed = readings.reduce((n, r) => n + r.unpushed, 0);
  if (unknown !== undefined) return { state: "unknown", dirty, unpushed, ...(unknown.why === undefined ? {} : { why: unknown.why }), trees };
  return { state: dirty > 0 || unpushed > 0 ? "at-risk" : "none", dirty, unpushed, trees };
}

/**
 * THE ONE PREDICATE for whether the holder holds work that exists nowhere else, for the gate's readings AND `performRelease`'s fresh re-read (which
 * would otherwise be blind in the same place, and so could not catch what the gate missed): {@link workAtRisk} on the claim record's tree, and, when
 * the merged pull request is in ANOTHER tracked repository, {@link workAtRiskInPrRepo} too.
 * @param {HostReads} io
 * @param {{ worktree: string | null, branch: string | null, repo: string,
 *   merged?: { repoKey: string, head?: string, claimant: import("./pr-ownership.ts").Claim } }} where
 * @returns {ReturnType<typeof workAtRisk>}
 */
export function holderWorkAtRisk(io: HostReads, { merged, ...home }: {
        worktree: string | null; branch: string | null; repo: string;
        merged?: { repoKey: string; head?: string; claimant: import("./pr-ownership.ts").Claim; };
    }): ReturnType<typeof workAtRisk> {
  const here = workAtRisk(io, home);
  if (merged === undefined) return here;
  const there = workAtRiskInPrRepo(io, merged);
  return combined([here, there], there.trees);
}

// --- THE READING ----------------------------------------------------------------------------------------------------

/**
 * Everything the reading knows about ONE claimed row. The two costly facts are THUNKS, so a row that is plainly moving (a comment or a commit inside N) costs no `git status`, and a tick pays for a worktree only when the cheap signals already say it has been quiet. `nothing` (#3407): the claim names no git object on purpose, so it can be nudged and never released
 */
export type ClaimFacts = { row: number, title?: string, session: string, claimedAt: number, branch: string | null, worktree: string | null, comment: number | null, commit: number | null, push: number | null, file: () => number | null, work: () => ReturnType<typeof workAtRisk>, openPrs: number, mergedPr: { number: number, mergedAt: number, repoKey?: string, head?: string } | null, waiting: string | null, blockedBy: number[], waitKind?: string | null, ownPrs?: import("./idle-claimant.ts").IdlePr[], nothing?: boolean, declared?: DeclarationReading, mergedHeld?: string, clockHeld?: string, };
export type Reading = { kind: "moving", lastMoveAt: number } | { kind: "pr-owned" } | { kind: "waiting", waiting: string } | { kind: "nudge", lastMoveAt: number, idleMs: number, idle?: boolean } | { kind: "nudged", nudgedAt: number, deliveredAt: number | null, lastMoveAt: number, idle?: boolean } | { kind: "idle-watch", since: number } | { kind: "vacating", since: number } | { kind: "release", why: "stalled" | "blocked" | "merged" | "gone" | "closed" | "wait", lastMoveAt: number | null, idleMs: number | null, nudgedAt: number | null, edges?: number[], waiting?: string, mergedPr?: number, mergedPrRepoKey?: string, mergedPrHead?: string, openPrs?: number[], openPrRepoKeys?: (string | undefined)[], since?: number, idle?: boolean, interrupt?: boolean } | { kind: "holding", why: string, expected?: boolean };

/** @param {(number | null)[]} times @returns {number | null} */
function latest(times: (number | null)[]): number | null {
  const known = times.filter((t) => t !== null);
  return known.length === 0 ? null : Math.max(...(known as number[]));
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
 * WHY A `pr-owned` READING IS NOT THE LAST WORD (#4017). The 2026-10-04 ruling that an open pull request closing the row is not a stall read only
 * {@link clockReading}'s `pr-owned` branch, and this overlay sits ABOVE it and re-reads that very reading, so a holder the clock left alone was still nudged
 * here once it had been idle for N. Which facts reach a nudge is therefore decided in this function, not in the clock: an idle holder with a pull request
 * that is not yet {@link ownPrStillYoung}, and no declared wait.
 *
 * @param {ClaimFacts} facts
 * @param {{ now: number, restartAt: number | null, nudge: { nudgedAt: number, deliveredAt: number | null, idle?: boolean } | null,
 *   agents?: {label: string, status: string}[] | null, goneSince?: number | null, idleSince?: number | null, intervalMs?: number }} ctx
 * @returns {Reading}
 */
function overlayReading(facts: ClaimFacts, ctx: {
        now: number; restartAt: number | null; nudge: { nudgedAt: number; deliveredAt: number | null; idle?: boolean; } | null;
        agents?: { label: string; status: string; }[] | null; goneSince?: number | null; idleSince?: number | null; intervalMs?: number;
    }): Reading {
  const base = clockReading(facts, ctx);
  if (base.kind !== "pr-owned" && base.kind !== "moving") return base;
  // #458: THE STOPPED CLOCK is for a claim that names a branch; a `Claimed-nothing:` claim keeps N (it is idle at its prompt by design).
  // #460: `declared` is what the worker's last turn ended on, read by the gate for a claim that names a branch. Its presence turns the DECLARATION REGIME on, in
  // which an idle holder with no fresh and still-true declaration is stalled at M, a young pull request of its own no excuse (it should have declared `waiting-ci`).
  const regime = facts.declared !== undefined && facts.nothing !== true;
  const idle = idleClaimantReading({ session: facts.session, prs: facts.ownPrs ?? [], built: facts.nothing !== true,
    ...(regime ? { declared: facts.declared } : {}),
    waitKinds: [...(facts.waitKind ? [facts.waitKind] : []), ...(facts.blockedBy.length > 0 ? ["blocked-by"] : [])] }, ctx);
  if (idle.kind === "waiting" || (!regime && ownPrStillYoung(facts, ctx))) return base;
  const held = ctx.nudge === null ? null : rememberedNudge(facts, ctx);
  if (held !== null) return held;
  if (idle.kind === "stall") return { kind: "nudge", idle: true, lastMoveAt: ctx.now - idle.idleMs, idleMs: idle.idleMs };
  if (idle.kind === "watching") return { kind: "idle-watch", since: idle.since };
  if (idle.kind === "unknown" && ctx.idleSince != null) return { kind: "idle-watch", since: ctx.idleSince };
  return base;
}

/**
 * (#4017) A PULL REQUEST THE HOLDER OPENED INSIDE THE CLOCK'S OWN INTERVAL IS WAITING ON THE REVIEW THE ORG OWES, AND THAT IS NOT THE HOLDER STALLING.
 * Five idle nudges in three days were typed while a pull request closing the row was open (#3560, #3591, #3719, #3787, #3993), each 52 to 74 minutes
 * after the pull request opened and each before the gate had asked anybody to review it: the overlay's N is 45 minutes, derived from the gap between a
 * claim and its FIRST pull request (#2999), and was being applied to the gap between that pull request and its first review, which took 69 to 162 minutes
 * in the same five. A holder with nothing left to do but wait cannot shorten that wait, and the nudge starts a turn that re-reads its whole window.
 *
 * THE BOUND IS {@link STALL_INTERVAL_MS}, the interval `moving` already grants a row, and NOT a figure derived from those five: it keeps #2999's
 * own case (#2968 and #2969 sat behind `pr-owned` for 171 and 233 minutes) a stall, and moves nothing but the first two hours of a pull request's life.
 * THE NEWEST OWN PULL REQUEST DECIDES: opening a second one is a move. A pull request whose age the list did not carry, or carried unparseably, is NOT young --
 * absence is not proof, and it is today's reading.
 * @param {ClaimFacts} facts @param {{ now: number, intervalMs?: number }} ctx @returns {boolean}
 */
function ownPrStillYoung(facts: ClaimFacts, ctx: { now: number; intervalMs?: number; }): boolean {
  const interval = ctx.intervalMs ?? STALL_INTERVAL_MS;
  const opened = (facts.ownPrs ?? []).map((pr) => Date.parse(String((pr as { createdAt?: string }).createdAt ?? ""))).filter(Number.isFinite);
  return opened.length > 0 && ctx.now - Math.max(...opened) < interval;
}

/**
 * (#3407) THE READING OF ONE CLAIM, with the one thing no reading may do to a `Claimed-nothing:` claim taken off it: RELEASE it. A claim that names no
 * git object (a host act, a fleet or lab reading, a hand-claim) holds nothing the release's "holds nothing built" can be said of, because its work is not
 * a commit; the clock can only ask its holder, so a stalled one stays `nudged` (the nudge is sent once, and its memory kept) and every other release
 * is `holding`, EXPECTED and so silent -- a line said every tick about it is the defect this row removes. Releasing one is a ruling for `product-manager`.
 * @param {ClaimFacts} facts @param {Parameters<typeof overlayReading>[1]} ctx @returns {Reading}
 */
export function claimReading(facts: ClaimFacts, ctx: Parameters<typeof overlayReading>[1]): Reading {
  const reading = overlayReading(facts, ctx);
  if (facts.nothing !== true || reading.kind !== "release") return reading;
  if (reading.why === "stalled" && reading.nudgedAt !== null) {
    return { kind: "nudged", nudgedAt: reading.nudgedAt, deliveredAt: ctx.nudge?.deliveredAt ?? null, lastMoveAt: (reading.lastMoveAt as number),
      ...(reading.idle ? { idle: true } : {}) };
  }
  return { kind: "holding", expected: true, why: `a claim that names no branch or worktree is never released (${reading.why})` };
}

/**
 * The second reading of a REMEMBERED nudge, for a claim the clock called quiet-but-fine. The worktree is read HERE and only here: a row with no
 * nudge outstanding that is plainly moving costs no `git status` (`work-gate-claim-stalled.test.ts` pins it), and the overlay must not change that.
 * @param {ClaimFacts} facts @param {Parameters<typeof claimReading>[1]} ctx @returns {Reading | null}
 */
function rememberedNudge(facts: ClaimFacts, ctx: Parameters<typeof claimReading>[1]): Reading | null {
  const lastMoveAt = (latest([facts.claimedAt, facts.comment, facts.commit, facts.push, ctx.restartAt, facts.file()]) as number);
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
function clockReading(facts: ClaimFacts, ctx: Parameters<typeof claimReading>[1]): Reading {
  const interval = ctx.intervalMs ?? STALL_INTERVAL_MS;
  if (facts.openPrs > 0) return goneWithOpenPrReading(facts, ctx) ?? { kind: "pr-owned" };
  const landed = mergedReading(facts);
  if (landed !== null) return landed;
  const gone = goneReading(facts, ctx);
  if (gone !== null) return gone;
  if (facts.blockedBy.length > 0) return blockedReading(facts);
  if (facts.waiting !== null) return waitReading(facts, facts.waiting);
  const cheap = (latest([facts.claimedAt, facts.comment, facts.commit, facts.push, ctx.restartAt]) as number);
  if (ctx.now - cheap < interval) return { kind: "moving", lastMoveAt: cheap };
  const lastMoveAt = (latest([cheap, facts.file()]) as number);
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
function secondReading(facts: ClaimFacts, ctx: Parameters<typeof claimReading>[1], lastMoveAt: number): Reading | null {
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
function goneWithOpenPrReading(facts: ClaimFacts, ctx: Parameters<typeof claimReading>[1]): Reading | null {
  if (facts.mergedPr !== null) return null;
  const gone = goneReading(facts, ctx);
  if (gone === null || gone.kind !== "release") return gone;
  const own = facts.ownPrs ?? [];
  // `gh pr list` always returns the number; IdlePr only marks it optional. The keys ride beside the numbers (which stay numbers) and only when a pull request is in another repository, so a home-only release is today's.
  return { ...gone, openPrs: (own.map((pr) => pr.number) as number[]), ...(own.some((pr) => pr.repoKey) ? { openPrRepoKeys: own.map((pr) => pr.repoKey || undefined) } : {}) };
}

/** @param {{ trees?: string[] }} work @returns {string} the worktrees of the pull request's repository that were read, for a line naming where the work is */
function treesRead(work: { trees?: string[]; }): string {
  return work.trees === undefined || work.trees.length === 0 ? "" : `, in ${work.trees.join(", ")}`;
}

/**
 * (10) A merged pull request on the claimed branch, no open one, nothing at risk: the work LANDED and the row stayed open
 * (`Closes: none`), so the instance is done and the ruling about the row is `product-manager`'s. A merge that WOULD count from the claim record but whose
 * session label could not be dated is `holding` and says why (#4789): a release is the act that closes a workspace, so the read that could not be made
 * never takes it.
 * @param {ClaimFacts} facts @returns {Reading | null}
 */
function mergedReading(facts: ClaimFacts): Reading | null {
  if (facts.mergedHeld !== undefined) return { kind: "holding", why: facts.mergedHeld };
  if (facts.mergedPr === null) return null;
  const work = facts.work();
  if (work.state !== "none") {
    return { kind: "holding", expected: work.state !== "unknown",
      why: `${prMention(facts.mergedPr.number, facts.mergedPr.repoKey)} merged, but ${work.state === "unknown" ? `the worktree could not be read${work.why === undefined ? "" : ` (${work.why})`}` : `the holder still has ${work.dirty} dirty file(s) and ${work.unpushed} unpushed commit(s)${treesRead(work)}`}` };
  }
  return { kind: "release", why: "merged", lastMoveAt: null, idleMs: null, nudgedAt: null, mergedPr: facts.mergedPr.number,
    ...(facts.mergedPr.repoKey ? { mergedPrRepoKey: facts.mergedPr.repoKey } : {}),
    ...(facts.mergedPr.repoKey && facts.mergedPr.head ? { mergedPrHead: facts.mergedPr.head } : {}) };
}

/**
 * herdr's word for a workspace with no agent detected in it (#2534, `wake.ts`'s `hasNoAgent`, which this leaf cannot import).
 * @param {{status?: string}} agent
 */
function holdsNoAgent(agent: { status?: string; }) {
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
function goneReading(facts: ClaimFacts, ctx: { now: number; agents?: { label: string; status: string; }[] | null; goneSince?: number | null; }): Reading | null {
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
function blockedReading(facts: ClaimFacts): Reading {
  const work = facts.work();
  if (work.state !== "none") {
    return { kind: "holding", expected: work.state !== "unknown", why: work.state === "unknown" ? "blocked, and the worktree could not be read"
      : `blocked, but the holder has ${work.dirty} dirty file(s) and ${work.unpushed} unpushed commit(s)` };
  }
  return { kind: "release", why: "blocked", lastMoveAt: null, idleMs: null, nudgedAt: null, edges: facts.blockedBy };
}

/**
 * The declared waits a holder CANNOT FINISH THROUGH (#4637, class `row-not-finishable`): a future reading or date (`not-before`), another actor's act
 * (`answer:<other session>`, `needs:chairman`) and another row's result (a `Waiting-for:` on a row). `fleet-hold` is NOT one: it says the holder's own captures
 * own the workers, so it is the holder's wait to keep. `answer:<the holder>` never reaches here (`declaredWaitOf` drops it: the row is waiting on the holder).
 */
export const WAIT_RELEASE_KINDS: readonly string[] = Object.freeze(["not-before", "answer", "chairman", "blocked-by"]);

/**
 * A DECLARED wait, and what the holder may do about it. Release (8)'s logic applied to every wait the claimant cannot finish through: a holder
 * that holds NOTHING (the {@link workAtRisk} predicate (8) uses: no dirty file, no unpushed commit; and `clockReading` already returned `pr-owned` for an open
 * pull request) has nothing to protect, and keeping the claim only holds an engineer slot and its Region for the length of the wait. A holder
 * that holds work, or whose tree cannot be read, keeps today's `waiting` reading: the work is its own to ship, and an unreadable tree is not "nothing".
 * A kind this does not know (or a fact built without one) stays `waiting`, so a new kind of wait cannot start releasing by accident.
 * @param {ClaimFacts} facts @param {string} waiting @returns {Reading}
 */
function waitReading(facts: ClaimFacts, waiting: string): Reading {
  const kept: Reading = { kind: "waiting", waiting };
  if (facts.waitKind === undefined || facts.waitKind === null || !WAIT_RELEASE_KINDS.includes(facts.waitKind)) return kept;
  if (facts.work().state !== "none") return kept;
  return { kind: "release", why: "wait", lastMoveAt: null, idleMs: null, nudgedAt: null, waiting };
}

// --- THE FACTS OF ONE ROW ---------------------------------------------------------------------------------------------

export type OpenPr = import("./idle-claimant.ts").IdlePr & { headRefName?: string, title?: string };
export type MergedPr = { number: number, headRefName?: string, mergedAt?: string, title?: string, labels?: ({ name?: string } | string)[] };
/**
 * the OTHER tracked code repositories' lists (#3075), each member tagged with the `repoKey` it came from. `open: null` is a read that was refused, and is never "none open".
 */
export type ElsewherePrs = { open: OpenPr[] | null, merged: MergedPr[] | null };
/**
 * `openPrs` and `mergedPrs` are the HOME repository's; `elsewhere` is absent for a project with one code repository; `trackerRepo` is the home repository's `owner/repo`, which a pull request title's reference names (`ownsPr`'s third rung); `sessionRows` is how many claimed rows the session holds, and its label (the fourth rung) counts only for a session holding one
 * `now` (#612) is the tick's time, and with `intervalMs` (the stall interval, as `readClaim`'s context has it) it decides whether the claim record is old enough that the session label's time could be
 * the later start: absent, the caller does not date the clock and `claimedAt` is the record's, as it was before.
 */
export type ClaimInput = { row: number, title?: string, session: string, waiting: string | null, blockedBy: number[], comments: RowComment[], openPrs: OpenPr[], mergedPrs: MergedPr[] | null, elsewhere?: ElsewherePrs, repo: string, trackerRepo?: string, sessionRows?: number, waitKind?: string | null, now?: number, intervalMs?: number };

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
function pullRequestsAcrossRepos(input: ClaimInput): { open: OpenPr[]; merged: MergedPr[] | null; } | null {
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
 * The branch is the claim record's own (`Claimed-branch:`), so the gate needs no naming convention. Whether a pull request is
 * THIS row's is `ownsPr`'s answer, the same one for the open and the merged lookup (#3445): the work of #3390 merged on a branch it never claimed.
 *
 * @param {ClaimInput} input @param {HostReads} io @returns {ClaimFacts | { skip: string }}
 */
export function claimFactsFrom(input: ClaimInput, io: HostReads): ClaimFacts | { skip: string; } {
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
    const claimant = { row: input.row, branch, session: input.session, soleHolder: input.sessionRows === 1,
      ...(input.trackerRepo === undefined ? {} : { trackerRepo: input.trackerRepo }) };
    const ownPrs = prs.open.filter((p) => ownsPr(claimant, p) !== null);
    // ONE read of the row's label history serves both the merge's anchor and the clock's: the seam is asked at most once per claim per tick
    let labelled: { at: number | null } | undefined;
    const labelledAt = (): number | null => (labelled ??= { at: sessionLabelAddedAt(io.labelEvents?.(claimant.row) ?? null, claimant.session) }).at;
    const { merged, held } = landedWork({ merged: prs.merged ?? [], claimant, record, io, labelledAt });
    const clock = claimClock({ record, input, io, labelledAt });
    return { row: input.row, session: input.session, claimedAt: clock.at, branch, worktree,
      ...(input.title === undefined ? {} : { title: input.title }),
      comment: commentMove(input.comments, record),
      commit: branch === null ? null : newestOwnCommit(io.git, dir, branch),
      push: branch === null ? null : newestOwnCommit(io.git, dir, `origin/${branch}`),
      file: () => (worktree !== null && io.exists(worktree) ? fileMove(io, worktree) : null),
      work: () => holderWorkAtRisk(io, { worktree, branch, repo: input.repo,
        ...(merged?.repoKey ? { merged: { repoKey: merged.repoKey, head: merged.headRefName, claimant } } : {}) }),
      openPrs: ownPrs.length,
      mergedPr: merged === null ? null : { number: merged.number, mergedAt: Date.parse(String(merged.mergedAt)), ...(merged.repoKey ? { repoKey: merged.repoKey } : {}),
        ...(merged.headRefName ? { head: merged.headRefName } : {}) },
      waiting: input.waiting, blockedBy: input.blockedBy,
      ...(input.waitKind === undefined ? {} : { waitKind: input.waitKind }),
      ownPrs, ...(record.nothing ? { nothing: true } : {}), ...(held === null ? {} : { mergedHeld: held }),
      ...(clock.held === null ? {} : { clockHeld: clock.held }) };
  } catch (err) {
    if (err instanceof Unreadable) return { skip: `#${input.row}: ${err.message}` };
    throw err;
  }
}

/**
 * (#4789) THE MERGED PULL REQUEST THAT COUNTS AS THIS HOLDER'S LANDED WORK, anchored to when THIS session took the row and not only to the newest claim
 * record. A hand-started engineer writes no record, so the newest one is the PREVIOUS holder's, and a pull request that merged for that holder read as
 * the new one's work: a11ign#4524's `worker-4524` was released four minutes after its start for agent-org#562, merged ten hours before it.
 *
 * A merge counts only if it is after the record AND after the newest `labeled` event of `session:<session>`. The record is applied first (`fromRecord`), and
 * since that is the older anchor whenever a claim was made by `row-claim`, the label is only ever the stricter of the two for a hand start. A caller that
 * gives no `labelEvents` seam keeps the record alone; a seam that cannot answer, or an answer with no such event, gives `held`: the reason a merge that
 * counts from the record is NOT taken, which fails toward not releasing -- a release closes the holder's workspace, and the work is kept either way.
 * @param {{ merged: MergedPr[], claimant: import("./pr-ownership.ts").Claim, record: ClaimRecord, io: HostReads, labelledAt: () => number | null }} args
 * @returns {{ merged: ReturnType<typeof newestMergedAfter>, held: string | null }}
 */
function landedWork({ merged, claimant, record, io, labelledAt: labelledAtOf }: { merged: (MergedPr & { repoKey?: string; })[]; claimant: import("./pr-ownership.ts").Claim; record: ClaimRecord; io: HostReads; labelledAt: () => number | null; }): { merged: ReturnType<typeof newestMergedAfter>; held: string | null; } {
  const fromRecord = newestMergedAfter(merged, claimant, record.at);
  if (fromRecord === null || io.labelEvents === undefined) return { merged: fromRecord, held: null };
  const labelledAt = labelledAtOf();
  if (labelledAt === null) {
    return { merged: null, held: `${prMention(fromRecord.number, fromRecord.repoKey)} merged after the claim record, but when ${SESSION_PREFIX}${claimant.session} was added to #${claimant.row} could not be read, so it is not taken as this holder's landed work` };
  }
  return { merged: newestMergedAfter(merged, claimant, labelledAt), held: null };
}

/**
 * (#612) WHEN THIS HOLDER'S STALL CLOCK STARTS: the later of the newest claim record and the newest `labeled` event of its `session:` label. A hand
 * start writes no record, so the newest one is the PREVIOUS holder's, and a session started ten hours after it had ten idle hours at its first tick:
 * nudged at once, and released after the grace if it had not moved. #4789 anchored a merged pull request the same way; this is the clock's half.
 * A claim by `row-claim` (record and label together) reads exactly as before, the record being the later or the same.
 *
 * THE SEAM IS ASKED ONLY WHEN THE LABEL COULD MOVE THE ANSWER: a record younger than the stall interval is still inside `moving` whatever the label says,
 * so a quiet org spends no call. A caller that gives no `now` or no `labelEvents` seam keeps the record. A label time that cannot be read keeps the
 * record's too, never a later or an earlier one (a refused read is not a reason to nudge SOONER), and `held` says why so the tick can.
 * @param {{ record: ClaimRecord, input: ClaimInput, io: HostReads, labelledAt: () => number | null }} args @returns {{ at: number, held: string | null }}
 */
function claimClock({ record, input, io, labelledAt }: { record: ClaimRecord; input: ClaimInput; io: HostReads; labelledAt: () => number | null; }): { at: number; held: string | null; } {
  if (io.labelEvents === undefined || input.now === undefined) return { at: record.at, held: null };
  if (input.now - record.at < (input.intervalMs ?? STALL_INTERVAL_MS)) return { at: record.at, held: null };
  const at = labelledAt();
  if (at === null) {
    return { at: record.at, held: `when ${SESSION_PREFIX}${input.session} was added to #${input.row} could not be read, so the stall clock starts at the claim record` };
  }
  return { at: Math.max(record.at, at), held: null };
}

/**
 * When `session:<session>` was last ADDED to a row, from its label events, or `null` when that cannot be said: a read that was refused, or a history
 * with no such `labeled` event (never "the beginning of time", which would count every earlier merge). The newest wins, so a label taken off and put
 * back dates the holder who has it now.
 * @param {LabelEvent[] | null} events @param {string} session @returns {number | null}
 */
export function sessionLabelAddedAt(events: LabelEvent[] | null, session: string): number | null {
  if (events === null) return null;
  const label = `${SESSION_PREFIX}${session}`;
  const times = events.filter((e) => e.event === "labeled" && e.label === label).map((e) => Date.parse(e.at)).filter(Number.isFinite);
  return times.length === 0 ? null : Math.max(...times);
}

/** `gh <args>`, never throwing: a spawn failure or a timeout is `status: null`, which {@link readLabelEvents} turns into `null` and never into "no events". */
export type GhRun = (args: string[]) => { status: number | null, out: string };
const ghRun: GhRun = (args) => {
  const ran = spawnSync("gh", args, { encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER });
  return { status: ran.status, out: ran.stdout ?? "" };
};

/**
 * A row's label events through `gh api`, or `null` for any read that did not answer in full. One REST call, made only for a claim with a merged pull
 * request of its own after the record, so a quiet org spends none (and the REST core pool, not GraphQL's).
 * @param {number} row @param {string} repo `owner/repo` of the tracker, whose issue numbers the row is @param {GhRun} [run]
 * @returns {LabelEvent[] | null}
 */
export function readLabelEvents(row: number, repo: string, run: GhRun = ghRun): LabelEvent[] | null {
  const ran = run(["api", "--paginate", `repos/${repo}/issues/${row}/events`, "--jq",
    '.[] | select(.event == "labeled" or .event == "unlabeled") | {event: .event, label: .label.name, at: .created_at}']);
  if (ran.status !== 0) return null;
  try {
    return ran.out.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as LabelEvent);
  } catch {
    return null;
  }
}

/**
 * The newest pull request MERGED that the claimant owns (`ownsPr`) after `since`, or `null`: a merge before this claim is another instance's work on the row,
 * and that is a question about TIME, so it stays here and not in the ownership test.
 * @param {(MergedPr & { repoKey?: string })[]} merged @param {import("./pr-ownership.ts").Claim} claimant @param {number} since
 * @returns {{ number: number, mergedAt: string, repoKey?: string, headRefName?: string } | null}
 */
function newestMergedAfter(merged: (MergedPr & { repoKey?: string; })[], claimant: import("./pr-ownership.ts").Claim, since: number): { number: number; mergedAt: string; repoKey?: string; headRefName?: string; } | null {
  const after = merged.filter((p) => ownsPr(claimant, p) !== null && Date.parse(String(p.mergedAt ?? "")) > since);
  const [newest] = after.sort((a, b) => Date.parse(String(b.mergedAt)) - Date.parse(String(a.mergedAt)));
  return newest === undefined ? null : { number: newest.number, mergedAt: String(newest.mergedAt), repoKey: newest.repoKey, headRefName: newest.headRefName };
}

/**
 * `claimReading` that a read which will not answer cannot crash and cannot turn into a release: the thunks reach git, and
 * git that fails is `holding`, the reading that emits nothing and keeps the row's nudge memory out of it.
 * @param {ClaimFacts} facts @param {Parameters<typeof claimReading>[1]} ctx @returns {Reading}
 */
export function readClaim(facts: ClaimFacts, ctx: Parameters<typeof claimReading>[1]): Reading {
  try {
    return claimReading(facts, ctx);
  } catch (err) {
    if (err instanceof Unreadable) return { kind: "holding", why: err.message };
    throw err;
  }
}

// --- THE NUDGE MEMORY -----------------------------------------------------------------------------------------------

/**
 * keyed by row number, one memory or the other per row: a nudge (`idle` when it was the idle-claimant's, #2999), the tick a session was first found gone, or the tick a holder was first found idle.
 */
export type StallState = Record<string, { session: string, nudgedAt?: number, goneSince?: number, idleSince?: number, idle?: boolean }>;

/**
 * A JSON object kept in a file beside the wake ledger, or `{}`. A missing file is EMPTY and an unparseable one is empty too:
 * every file this reads is a MEMORY (the nudge, the kept worktree, the last restart acted on) whose loss costs one repeat of
 * something, and a memory that could stop the tick would be worse than none.
 * @param {string} path @param {typeof readFileSync} [read] @returns {Record<string, any>}
 */
export function readJsonObject(path: string, read: typeof readFileSync = readFileSync): Record<string, any> {
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
export function readStallState(path: string, read: typeof readFileSync = readFileSync): StallState {
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
export function nextStallState(before: StallState, readings: { facts: ClaimFacts; reading: Reading; }[], now: number): StallState {
  const after: StallState = {};
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
 * A STALL RELEASE THAT HAS NOT YET BEEN PERFORMED KEEPS ITS MEMORY: `wake.ts` performs it after this tick, may fail (a workspace that will
 * not close, a decline that is refused), and the gate emits the order again next tick -- which must read as the SECOND reading again, not
 * forget the nudge and start a fresh two hours. Once performed the row is no longer claimed and the entry goes with it. A GONE RELEASE THAT HAS
 * NOT YET BEEN PERFORMED keeps its `goneSince` for the same reason.
 * @param {Reading} reading @param {number} now @returns {{ nudgedAt?: number, goneSince?: number, idleSince?: number, idle?: boolean } | null}
 */
function memoryOf(reading: Reading, now: number): { nudgedAt?: number; goneSince?: number; idleSince?: number; idle?: boolean; } | null {
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
export function writeJsonObject(path: string, state: object, writer: (path: string, data: string) => void = writeFileSync) {
  mkdirSync(dirname(path), { recursive: true });
  writer(`${path}.tmp`, `${JSON.stringify(state)}\n`);
  renameSync(`${path}.tmp`, path);
}

/** @param {string} path @param {StallState} state @param {(path: string, data: string) => void} [writer] */
export function writeStallState(path: string, state: StallState, writer: (path: string, data: string) => void = writeFileSync) {
  writeJsonObject(path, state, writer);
}

// --- THE ORDERS -----------------------------------------------------------------------------------------------------

/** @param {number} ms */
const minutes = (ms: number) => Math.round(ms / MINUTE_MS);

/**
 * `interrupt` (#3535) is a closed row's per-row instance caught mid-turn: the performer stops it, with no prompt
 */
export type ReleaseRequest = { row: number, session: string, why: "stalled" | "blocked" | "merged" | "gone" | "closed" | "wait", branch: string | null, worktree: string | null, idleMinutes: number | null, nudgedAt: number | null, edges?: number[], waiting?: string, mergedPr?: number, mergedPrRepoKey?: string, mergedPrHead?: string, openPrs?: number[], openPrRepoKeys?: (string | undefined)[], answer?: string, interrupt?: boolean };
export type StallOrder = { session: string, cause: string, subject: string, discriminator: string, prompt: string, causeKey: string, title?: string, release?: ReleaseRequest, resume?: boolean };

/**
 * The nudge to an IDLE holder (#2999): the same cause, key and delivery as {@link nudgeOrder}'s -- so the ledger, the offer window and the
 * second reading's release are ONE mechanism -- with the text that spells the wait fields. A holder re-offered the nudge (not yet delivered)
 * is told the floor, `IDLE_CLAIMANT_MINUTES`, because only the first reading knew how long it had been idle.
 * @param {ClaimFacts} facts @param {number} nudgedAt @param {number} idleMs @returns {StallOrder}
 */
function idleNudgeOrder(facts: ClaimFacts, nudgedAt: number, idleMs: number): StallOrder {
  const what = { row: facts.row, branch: facts.branch, idleMinutes: minutes(idleMs), releaseMinutes: minutes(STALL_INTERVAL_MS), canRelease: facts.openPrs === 0 };
  return {
    session: facts.session, cause: "claim-stalled", subject: `row-${facts.row}`, discriminator: `idle-nudge-${nudgedAt}`,
    // #458: a holder the stopped clock applies to is told to CONTINUE; the text is chosen from the same facts the reading was
    prompt: facts.declared !== undefined && facts.nothing !== true ? declareNudgePrompt({ ...what, declared: facts.declared })
      : isStoppedHolder({ built: facts.nothing !== true, prs: facts.ownPrs }) ? stoppedNudgePrompt(what) : idleNudgePrompt(what),
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
function nudgeOrder(facts: ClaimFacts, nudgedAt: number, lastMoveAt: number): StallOrder {
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
 * The nudge's `causeKey`: one per stall episode. The gate derives it here and reads the wake ledger for it, and `wake.ts` records it on delivery,
 * so the key has ONE spelling. @param {string} session @param {number} row @param {number} nudgedAt
 */
export function nudgeKey(session: string, row: number, nudgedAt: number) {
  return `${session}/${CLAIM_STALLED}/row-${row}/nudge-${nudgedAt}`;
}

/**
 * When the wake ledger last recorded `key` as DELIVERED, or `null`: the line `<epochMs>\t<causeKey>[...]` the tick writes once herdr has accepted the
 * prompt, with a `VOIDED` line (a delivery a restart killed) taking one back. THE LEDGER'S FORMAT IS `wake.ts`'s, which this leaf cannot import, so
 * the test writes a line with the real `ledgerLine` and reads it here: a change of format breaks that test and not the release.
 * @param {string} raw the ledger's text @param {string} key @returns {number | null}
 */
export function nudgeDeliveredAt(raw: string, key: string): number | null {
  const times: number[] = [];
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
 * opens the home repository's. Every spelling of a release's pull request -- the order's prompt here, the comment `wake.ts` leaves on the row --
 * goes through this and the two below, so no sentence can name one without saying which repository it is in.
 * @param {number} number @param {string | undefined} repoKey @returns {string}
 */
function prMention(number: number, repoKey: string | undefined): string {
  return subjectMention({ repoKey, number });
}

/** @param {{ mergedPr?: number, mergedPrRepoKey?: string }} release a release whose `why` is "merged" @returns {string} */
export function mergedPrMention(release: { mergedPr?: number; mergedPrRepoKey?: string; }): string {
  return prMention(Number(release.mergedPr), release.mergedPrRepoKey);
}

/** @param {{ openPrs?: number[], openPrRepoKeys?: (string | undefined)[] }} release @returns {string} its open pull requests, comma-joined, each with its repository */
export function openPrMentions(release: { openPrs?: number[]; openPrRepoKeys?: (string | undefined)[]; }): string {
  return (release.openPrs ?? []).map((n, i) => prMention(n, release.openPrRepoKeys?.[i])).join(", ");
}

/**
 * The release, as an order `wake.ts` PERFORMS. It carries every fact the performer needs and the prompt is only what a
 * log line says: a release is not a question, and no session is asked anything.
 * @param {Pick<ClaimFacts, "row" | "session" | "branch" | "worktree">} facts @param {Extract<Reading, { kind: "release" }>} reading @returns {StallOrder}
 */
function releaseOrder(facts: Pick<ClaimFacts, "row" | "session" | "branch" | "worktree">, reading: Extract<Reading, { kind: "release"; }>): StallOrder {
  const release: ReleaseRequest = { row: facts.row, session: facts.session, why: reading.why, branch: facts.branch, worktree: facts.worktree,
    idleMinutes: reading.idleMs === null ? null : minutes(reading.idleMs), nudgedAt: reading.nudgedAt,
    ...(reading.interrupt === true ? { interrupt: true } : {}),
    ...(reading.edges === undefined ? {} : { edges: reading.edges }),
    ...(reading.waiting === undefined ? {} : { waiting: reading.waiting }),
    ...(reading.mergedPr === undefined ? {} : { mergedPr: reading.mergedPr, answer: "product-manager",
      ...(reading.mergedPrRepoKey === undefined ? {} : { mergedPrRepoKey: reading.mergedPrRepoKey }),
      ...(reading.mergedPrHead === undefined ? {} : { mergedPrHead: reading.mergedPrHead }) }),
    // HELD, NOT POOLED (#3048): a gone holder's open PR is the work, so the row goes to `product-manager` and `ready` is not restored.
    ...(reading.openPrs === undefined || reading.openPrs.length === 0 ? {} : { openPrs: reading.openPrs, answer: "product-manager",
      ...(reading.openPrRepoKeys === undefined ? {} : { openPrRepoKeys: reading.openPrRepoKeys }) }) };
  const said = reading.why === "stalled" && reading.idle ? `idle with no wait field and nothing moved for ${release.idleMinutes} minutes, and the nudge was not answered`
    : reading.why === "stalled" ? `nothing moved for ${release.idleMinutes} minutes and the nudge was not answered`
    : reading.why === "closed" ? `#${facts.row} is CLOSED${reading.interrupt === true ? ` while ${facts.session} is mid-turn on it, so the instance is interrupted` : ""}`
    : reading.why === "blocked" ? `blocked by ${(reading.edges ?? []).map((n) => `#${n}`).join(", ")} and the holder holds nothing`
    : reading.why === "wait" ? `${reading.waiting ?? "a declared wait"}, and the holder holds nothing`
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
export function claimStalledOrders(readings: { facts: ClaimFacts; reading: Reading; }[] | undefined, now: number): StallOrder[] {
  const orders: StallOrder[] = [];
  for (const { facts, reading } of readings ?? []) {
    if (reading.kind === "nudge" && reading.idle) orders.push(idleNudgeOrder(facts, now, reading.idleMs));
    else if (reading.kind === "nudge") orders.push(nudgeOrder(facts, now, reading.lastMoveAt));
    // OFFERED UNTIL DELIVERED, and then never again: the ledger holds a delivered key for one wake window only, so an offer that outlived the
    // delivery would send it a second time.
    else if (reading.kind === "nudged" && reading.deliveredAt === null) {
      const floor = facts.declared !== undefined && facts.nothing !== true || isStoppedHolder({ built: facts.nothing !== true, prs: facts.ownPrs }) ? STOPPED_CLAIMANT_MS : IDLE_CLAIMANT_MS;
      orders.push(reading.idle ? idleNudgeOrder(facts, reading.nudgedAt, floor) : nudgeOrder(facts, reading.nudgedAt, reading.lastMoveAt));
    } else if (reading.kind === "release") orders.push(releaseOrder(facts, reading));
  }
  return orders;
}

// --- THE LEDGER AND THE RESTART NOTICE (#458) --------------------------------------------------------------------------------------------

/**
 * The failure ledger's class key for a claimed worker that stopped (epic #4437). It is a constant of this file and not an entry of the ledger's seeded
 * `FAILURE_KINDS`: those files are #4452's and #4475's, and adding the key there is a one-line follow-up after they merge.
 */
export const CLAIMED_WORKER_STALLED = "claimed-worker-stalled";

/**
 * ONE EVENT PER UNANSWERED NUDGE, `<session>/#<row>/<nudge time>` (the nudge time in epoch ms, the spelling `nudgeKey` and the wake ledger carry, so a line
 * in one finds its line in the other). THE CLASS IS A NUDGE THE HOLDER DID NOT ANSWER, and the observable is the second reading's verdict
 * ({@link secondReading}): a `release` with `why: "stalled"` and a `nudgedAt`, i.e. nothing on the row moved after the nudge either. A FRESH nudge is
 * NOT an event (#4826): it is the guard working, and `repeatsIn` read each firing of it as a repeat of the class, so four nudges that all brought the
 * holder back (3 of the 4 rows closed within minutes) tripped `class-repeat` for a guard that had not failed. The fresh nudge stays recorded where it
 * already was, the wake ledger (`nudgeKey`).
 *
 * THE REF CARRIES `nudgedAt`, NOT `now`: the release is read on the tick it happens, long after the nudge, and a ref that moved with the tick would make
 * one episode two lines. A `nudged` reading is the same episode still inside its grace and is NOT an event. NOT SEEN, AND SAID HERE SO IT IS NOT A SURPRISE:
 * a holder that is never released (a `Claimed-nothing:` claim, #3407; an open pull request of its own, #2999) reads `nudged` for good, so an unanswered
 * nudge to one is in the wake ledger only. A second row's unanswered nudge is a different ref, which is what `repeatsIn` counts as a repeat of the class.
 * @param {{ facts: ClaimFacts, reading: Reading }[] | undefined} readings @param {number} now @returns {FailureEvent[]}
 */
export function stalledNudgeEvents(readings: { facts: ClaimFacts; reading: Reading; }[] | undefined, now: number): FailureEvent[] {
  return (readings ?? []).flatMap(({ facts, reading }) => reading.kind === "release" && reading.why === "stalled" && reading.nudgedAt !== null
    ? [{ classKey: CLAIMED_WORKER_STALLED, ref: `${facts.session}/#${facts.row}/${reading.nudgedAt}`, at: now }]
    : []);
}

/**
 * Append this tick's nudges to the failure ledger. NEVER THROWS INTO THE TICK (a recorder that stopped the tick would be the outage it records), and a
 * refused append is REPORTED by `recordFailures` and comes back as `refused`, never swallowed. `record` is the seam a test writes nowhere through.
 * @param {{ readings: { facts: ClaimFacts, reading: Reading }[] | undefined, now: number, logPath: string, record?: typeof recordFailures, report?: (line: string) => void }} tick
 * @returns {RecordResult}
 */
export function recordStalledNudges({ readings, now, logPath, record = recordFailures, report = (line) => process.stderr.write(`${line}\n`) }: {
        readings: { facts: ClaimFacts; reading: Reading; }[] | undefined; now: number; logPath: string; record?: typeof recordFailures; report?: (line: string) => void;
    }): RecordResult {
  try {
    return record({ logPath, events: stalledNudgeEvents(readings, now), now, report });
  } catch (cause) {
    const refused = String((cause as Error)?.message ?? cause).split("\n")[0].slice(0, 160);
    report(`${CLAIMED_WORKER_STALLED}: NOT RECORDED: ${refused}`);
    return { appended: 0, skipped: 0, refused };
  }
}

/** The memory of the restart notice, beside the nudge's: `{ "<session>/<row>": "<agent session id the holder was last told about>" }`. */
export const AGENT_SESSIONS_FILE = "agent-sessions.json";

/** `<session>/claim-stalled/row-<n>/restart-<id>`: one per restart of one holder's session, spelled like {@link nudgeKey} so the ledger reads it the same way. */
export function restartNoticeKey(session: string, row: number, agentSession: string) {
  return `${session}/${CLAIM_STALLED}/row-${row}/restart-${agentSession}`;
}

/**
 * THE ORDER TO A HOLDER WHOSE SESSION RESTARTED: its background tasks went with the old process, so the completion notice it is waiting for will never
 * come. The `claim-stalled` cause, like every "go back to your work" order here, so it is delivered and counted by the machinery that already is.
 * @param {ClaimFacts} facts @param {string} agentSession @returns {StallOrder}
 */
function restartNoticeOrder(facts: ClaimFacts, agentSession: string): StallOrder {
  return {
    session: facts.session, cause: "claim-stalled", subject: `row-${facts.row}`, discriminator: `restart-${agentSession}`,
    prompt: `#${facts.row} IS YOURS AND YOUR SESSION RESTARTED: every background task you started before the restart is LOST, and no completion notice `
      + "will ever arrive for it.\n"
      + `RE-READ the row, its pull request and its checks, then CONTINUE from where \`${facts.branch ?? "its branch"}\` stands: re-run what was running, push `
      + "what is unpushed. This is sent once for this restart.",
    causeKey: restartNoticeKey(facts.session, facts.row, agentSession), resume: true,
    ...(facts.title === undefined ? {} : { title: facts.title }),
  };
}

/**
 * WHO WAS TOLD THEIR TASKS ARE LOST, from the holder's agent-session id changing. NOT "the session started after its claim": a dispatch CLAIMS FIRST and
 * starts the process after, so every fresh start would read as one (#458's measurement comment). A restart is a second id for a holder the gate has
 * already seen, and `herdr agent list` carries it.
 *
 *   first sighting      remembered, no order: a fresh start (or the first tick after this ships) is not a restart
 *   same id             nothing
 *   a new id            ONE order, offered until the wake ledger shows it DELIVERED and then remembered; a holder mid-turn right after a restart is
 *                       `working`, so a notice dropped on the first tick would never reach it
 *   not listed          unchanged: `goneReading` owns an absent session, and a listing that failed (`null`) is never read as a restart
 *
 * A row already being nudged or released this tick (`nudge`, `nudged`, `release`, `vacating`) is skipped, since that order already tells the holder to
 * continue. A `Claimed-nothing:` claim is never told (as the stopped clock is not its own). `after` carries only the rows still claimed, so it cannot grow.
 * @param {{ readings: { facts: ClaimFacts, reading: Reading }[], sessions: Map<string, string> | null, acked: Record<string, string>, delivered: (key: string) => boolean }} tick
 * @returns {{ orders: StallOrder[], after: Record<string, string> }}
 */
export function restartNotices({ readings, sessions, acked, delivered }: {
        readings: { facts: ClaimFacts; reading: Reading; }[]; sessions: Map<string, string> | null; acked: Record<string, string>; delivered: (key: string) => boolean;
    }): { orders: StallOrder[]; after: Record<string, string>; } {
  const orders: StallOrder[] = [];
  const after: Record<string, string> = {};
  const skipped: Reading["kind"][] = ["nudge", "nudged", "release", "vacating"];
  for (const { facts, reading } of readings) {
    const slot = `${facts.session}/${facts.row}`;
    const remembered = typeof acked[slot] === "string" ? acked[slot] : undefined;
    const current = sessions?.get(facts.session);
    if (remembered !== undefined) after[slot] = remembered;
    if (current === undefined || facts.nothing === true) continue;
    if (remembered === undefined) { after[slot] = current; continue; }
    if (remembered === current) continue;
    if (delivered(restartNoticeKey(facts.session, facts.row, current))) { after[slot] = current; continue; }
    if (!skipped.includes(reading.kind)) orders.push(restartNoticeOrder(facts, current));
  }
  return { orders, after };
}

// --- A CLOSED ROW'S CLAIM (#3535) -----------------------------------------------------------------------------------------

/** a pull request GitHub says closed the row: ANY of them, in any tracked repository */
export type ClosingPr = { number: number, headRefName?: string, title?: string };
/**
 * a CLOSED row that still carries the claim label, as `gh issue list --state closed --label in-progress` returns it
 */
export type ClosedClaimedRow = { number: number, title?: string, labels?: ({ name?: string } | string)[], comments?: RowComment[], closedByPullRequestsReferences?: ClosingPr[] };

/**
 * THE ORDERS FOR CLAIMS THAT OUTLIVED THEIR ROW: a row CLOSED (not planned, or superseded by hand) while it still carries `in-progress` and a
 * `session:` label. Measured on #3530: closed 51 seconds after the claim, labels taken off by hand 14 min 8 s later, the instance still building.
 *
 * NOTHING ELSE CAN SEE ONE. `claimStallTick` evaluates the OPEN claimed rows, a closed row is in none of them, and `spareDecision` ends an
 * instance only BETWEEN turns, which is right for a row that is open (forcing a delivery wipes the work it interrupts, #1966) and wrong for one that no longer exists.
 *
 * A ROW CLOSED BY ITS OWN PULL REQUEST IS NOT THIS RELEASE'S: one of `closedByPullRequestsReferences` is the CLAIMANT'S (`ownsPr`: the claimed branch, the row
 * suffix or the title's reference, the same rungs the merged release uses), the merge's own sweep takes the labels off, and a claimant whose pull request merged is
 * ended by the rule that says so. It is SAID on `log`, never silently skipped. A closing reference that is NOT the claimant's -- somebody else's pull request, in
 * this repository or the other -- closed a row whose holder is still building, and that is exactly this release's case (review of #313, 2026-10-06).
 *
 * THE INTERRUPT IS DECIDED HERE, FROM THE READING OF HERDR: the holder is a per-row instance (`isInstance`) AND `working`. A standing seat is
 * released and never interrupted, and an idle instance has nothing to interrupt. `agents === null` (herdr could not be asked) is NOT "idle": the release
 * still happens, because the row's state is what decides it, and it is said that the instance's state was unread.
 *
 * `rows === null` is a refused read -- reported as UNREAD, never as "no closed claim" and never as one found.
 * @param {{ rows: ClosedClaimedRow[] | null, agents: { label: string, status: string }[] | null, repo: string,
 *   isInstance: (session: string) => boolean, log?: (line: string) => void, trackerRepo?: string }} args
 * @returns {StallOrder[]}
 */
export function closedClaimOrders({ rows, agents, repo, isInstance, log = () => {}, trackerRepo }: {
        rows: ClosedClaimedRow[] | null; agents: { label: string; status: string; }[] | null; repo: string;
        isInstance: (session: string) => boolean; log?: (line: string) => void; trackerRepo?: string;
    }): StallOrder[] {
  if (rows === null) {
    log(`claim-stall: the closed rows still carrying a claim were NOT read this tick${agents === null ? " (herdr could not be asked, so whether a per-row instance exists is unknown)" : ""} -- a closed row's claim was NOT evaluated.\n`);
    return [];
  }
  const orders: StallOrder[] = [];
  for (const row of rows) {
    const order = closedClaimOrder(row, { agents, repo, isInstance, log, trackerRepo });
    if (order !== null) orders.push(order);
  }
  return orders;
}

/**
 * ONE closed row's release order, or `null` with the reason said on `log`.
 * @param {ClosedClaimedRow} row
 * @param {{ agents: { label: string, status: string }[] | null, repo: string, isInstance: (session: string) => boolean, log: (line: string) => void, trackerRepo?: string }} ctx
 * @returns {StallOrder | null}
 */
function closedClaimOrder(row: ClosedClaimedRow, { agents, repo, isInstance, log, trackerRepo }: { agents: { label: string; status: string; }[] | null; repo: string; isInstance: (session: string) => boolean; log: (line: string) => void; trackerRepo?: string; }): StallOrder | null {
  const names = (row.labels ?? []).map((l) => (typeof l === "string" ? l : String(l.name ?? "")));
  const sessions = names.filter((n) => n.startsWith(SESSION_PREFIX));
  if (sessions.length !== 1) {
    log(`claim-stall: closed #${row.number} carries ${sessions.length} session labels -- its claim was not released.\n`);
    return null;
  }
  const session = sessions[0].slice(SESSION_PREFIX.length);
  const record = claimRecordOf(row.comments ?? []);
  const claimant = { row: row.number, branch: record?.branch ?? null, session, ...(trackerRepo === undefined ? {} : { trackerRepo }) };
  const own = (row.closedByPullRequestsReferences ?? []).find((pr) => ownsPr(claimant, pr) !== null);
  if (own !== undefined) {
    log(`claim-stall: #${row.number} was closed by its own pull request (#${own.number}) -- the merge's settle owns its labels, not a closed release.\n`);
    return null;
  }
  const worktree = record?.worktree ?? null;
  const holder = agents?.find((a) => a.label === session);
  if (agents === null) log(`claim-stall: closed #${row.number}: herdr's state of ${session} was not read, so no interrupt is ordered.\n`);
  return releaseOrder({ row: row.number, session, branch: record?.branch ?? null,
    worktree: worktree === null ? null : resolve(repo, worktree) },
  { kind: "release", why: "closed", lastMoveAt: null, idleMs: null, nudgedAt: null,
    ...(isInstance(session) && holder?.status === "working" ? { interrupt: true } : {}) });
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
export function readHerdrRestart(run: (args: string[]) => string): number | null {
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
export function paneInterrupted(text: string | null | undefined): boolean {
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
export function paneThrashed(text: string | null | undefined): boolean {
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
export function killedDeliveries<D extends { at: number; session: string }>({ deliveries, at, until = at, moved, windowMs = RESTART_RESEND_WINDOW_MS }: {
        deliveries: D[]; at: number; until?: number; moved: (session: string, from: number, to: number) => boolean;
        windowMs?: number;
    }): D[] {
  return deliveries.filter((d) => d.at >= at - windowMs && d.at < at && !moved(d.session, d.at, until));
}

/** @param {string} path @returns {number | null} the mtime in ms, `null` for a path that is gone */
export function statMtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch (err) {
    if ((err as any)?.code === "ENOENT" || (err as any)?.code === "ENOTDIR") return null;
    throw err;
  }
}

/** @param {string} path @returns {boolean} */
export const pathExists = (path: string): boolean => existsSync(path);

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { CLAIM_RECORD_MARKER } from "../claim-labels.ts";
import { decidedBy } from "../decided-by.ts";
import { SESSION_PREFIX } from "../project-vocabulary.ts";
import { subjectMention } from "../review-attribution.ts";
import { listingIsComplete } from "../herdr-agents.ts";
import { idleClaimantReading, idleLimitMs, redOwnPrs, MAX_UNANSWERED_NUDGES, type IdleReading } from "../idle-claimant.ts";
import type { DeclarationReading } from "../worker-state.ts";
import { brokenChecks } from "../red-pr.ts";
import { ownsPr } from "../pr-ownership.ts";
import type { LabelEvent } from "../claim-provenance.ts";
import { hostConfigPath, readHostConfig } from "../host-config.ts";
import { parseWaits, conditionHolds, isItemWait, type RefFact } from "../wait-condition.ts";
import { claimRecordOf, type RowComment, type ClaimRecord } from "../claim-record.ts";

export const MINUTE_MS = 60_000;

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
export const DONE_FOOTER = /\bdone \d{1,2}:\d{2}\b/;

/**
 * When the claimant last commented on the row after the claim: a comment newer than the record that is not itself a record, and that is
 * EITHER by the claim record's own account OR marked `decided-by` the holder's own session. `null` for none.
 *
 * THE MARKER IS HOW A HOLDER'S COMMENT IS RECOGNISED WHEN THE ACCOUNTS DIFFER (agent-org#913, class `claimed-worker-stalled`, a11ign#4892): the claim
 * record is posted by the scheduler's account and the worker comments as the workers' account (#793), so the account test alone read no worker
 * comment as a move, and a worker whose whole deliverable was a comment was nudged and then released for work that had finished.
 *
 * KNOWN LIMIT, STATED: two sessions on one account (the workers' account, the leads' account) are one author. A comment by `product-manager`
 * on a row held by a leads-account seat therefore counts as a move by the ACCOUNT test, marker or not. That reads MORE movement than there is,
 * which fires the nudge later and never earlier -- the direction `STALL_INTERVAL_MS` already chose. A marker naming another session does not
 * COUNT by itself (it is not this holder's) but is not subtracted from the account test either: the role is a herdr workspace label and
 * need not be the session's name, so subtracting it could read a holder's own comment as silence.
 *
 * @param {RowComment[]} comments @param {ClaimRecord} record @param {string} session the claimant's session, the one the marker must name
 * @returns {number | null}
 */
export function commentMove(comments: RowComment[], record: ClaimRecord, session: string): number | null {
  let newest = null;
  for (const c of comments) {
    const ownAccount = record.author !== null && c.author?.login === record.author;
    if (!ownAccount && decidedBy(c.body) !== session) continue;
    if (String(c.body ?? "").includes(CLAIM_RECORD_MARKER)) continue;
    const at = Date.parse(String(c.createdAt ?? ""));
    const isLaterRecord = !Number.isNaN(at) && at > record.at && (newest === null || at > newest);
    if (isLaterRecord) newest = at;
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
  let host: Readonly<import("../host-config.ts").HostConfig>;
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
export function workAtRiskInPrRepo(io: HostReads, { repoKey, head, claimant }: { repoKey: string; head?: string; claimant: import("../pr-ownership.ts").Claim; }): ReturnType<typeof workAtRisk> {
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
        merged?: { repoKey: string; head?: string; claimant: import("../pr-ownership.ts").Claim; };
    }): ReturnType<typeof workAtRisk> {
  const here = workAtRisk(io, home);
  if (merged === undefined) return here;
  const there = workAtRiskInPrRepo(io, merged);
  return combined([here, there], there.trees);
}

// --- THE READING ----------------------------------------------------------------------------------------------------

/**
 * Everything the reading knows about ONE claimed row. The four git facts (`commit`, `push`, `file`, `work`) are THUNKS that {@link claimFactsFrom} MEMOISES, so a row costs only the reads its reading asks for, each at most once per tick (agent-org#1083): a row an open pull request owns costs no git at all, a row that is plainly moving (a comment or a commit inside N) costs no `git status`, and a tick pays for a worktree only when the cheap signals already say it has been quiet. A thunk that throws {@link Unreadable} is not cached, and {@link readClaim} turns it into `holding`. `nothing` (#3407): the claim names no git object on purpose, so it can be nudged and never released
 */
export type ClaimFacts = { row: number, title?: string, session: string, claimedAt: number, branch: string | null, worktree: string | null, comment: number | null, commit: () => number | null, push: () => number | null, file: () => number | null, work: () => ReturnType<typeof workAtRisk>, openPrs: number, mergedPr: { number: number, mergedAt: number, repoKey?: string, head?: string } | null, waiting: string | null, blockedBy: number[], waitKind?: string | null, ownPrs?: import("../idle-claimant.ts").IdlePr[], nothing?: boolean, declared?: DeclarationReading, mergedHeld?: string, clockHeld?: string, };
export type Reading = { kind: "moving", lastMoveAt: number } | { kind: "pr-owned" } | { kind: "waiting", waiting: string } | { kind: "nudge", lastMoveAt: number, idleMs: number, idle?: boolean, count?: number, unanswered?: number } | { kind: "nudged", nudgedAt: number, deliveredAt: number | null, lastMoveAt: number, idle?: boolean, idleSince?: number, idleAgain?: true, count?: number } | { kind: "idle-watch", since: number } | { kind: "vacating", since: number } | { kind: "release", why: "stalled" | "blocked" | "merged" | "gone" | "closed" | "wait", lastMoveAt: number | null, idleMs: number | null, nudgedAt: number | null, edges?: number[], waiting?: string, mergedPr?: number, mergedPrRepoKey?: string, mergedPrHead?: string, openPrs?: number[], openPrRepoKeys?: (string | undefined)[], since?: number, idle?: boolean, interrupt?: boolean, count?: number, idleSince?: number } | { kind: "holding", why: string, expected?: boolean };

/** @param {(number | null)[]} times @returns {number | null} */
function latest(times: (number | null)[]): number | null {
  const known = times.filter((t) => t !== null);
  return known.length === 0 ? null : Math.max(...(known as number[]));
}

/**
 * (agent-org#743) A HOLDER'S OWN PULL REQUESTS, each with `failingChecks`: the names `red-pr.ts`'s `brokenChecks` finds on its rollup (the newest run of each name, a
 * `hold:`'s own two jobs left out). `idleClaimantReading`, `idleLimitMs` and `redOwnPrs` read that field and nothing of the rollup.
 * @param {any[] | undefined} prs @returns {any[]}
 */
export function withRedChecks<T extends object>(prs: T[] | undefined): (T & { failingChecks: string[] })[] {
  return (prs ?? []).map((pr) => ({ ...pr, failingChecks: [...new Set(brokenChecks(pr as never).map((check) => check.name))] }));
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
 * AN OPEN PULL REQUEST OF THE HOLDER'S IS NEVER A NUDGE (agent-org#805). The clock reads it `pr-owned`, and this overlay re-reads that reading, so the order of
 * the two is what decides: a `pr-owned` holder is returned as it is, whatever its idle time, its declaration and the age of the pull request, and nothing
 * here or in the clock types a claim-stalled order for a row with one open. The ruling is the row's, not the clock's: #4017 let a pull request be nudged
 * once it was two hours old, and a row with an open closing pull request must type no claim-stalled order at all.
 *
 * @param {ClaimFacts} facts
 * @param {{ now: number, restartAt: number | null, nudge: { nudgedAt: number, deliveredAt: number | null, idle?: boolean, count?: number } | null,
 *   agents?: {label: string, status: string}[] | null, goneSince?: number | null, idleSince?: number | null, intervalMs?: number }} ctx
 * @returns {Reading}
 */
function overlayReading(facts: ClaimFacts, ctx: {
        now: number; restartAt: number | null; nudge: { nudgedAt: number; deliveredAt: number | null; idle?: boolean; count?: number; } | null;
        agents?: { label: string; status: string; }[] | null; goneSince?: number | null; idleSince?: number | null; intervalMs?: number;
    }): Reading {
  const base = clockReading(facts, ctx);
  if (base.kind !== "pr-owned" && base.kind !== "moving") return base;
  // (agent-org#805) AN OPEN PULL REQUEST OF THE HOLDER'S IS NEVER A NUDGE, except a RED one: the red-check nudge (`redCheckNudgePrompt`) is the one exception the
  // #1151 ruling names, because it exists for an open, red pull request. Everything below that is a counted nudge is reached by a red holder only.
  const red = facts.nothing !== true && redOwnPrs(withRedChecks(facts.ownPrs)).length > 0;
  if (facts.openPrs > 0 && !red) return base;
  // #458: THE STOPPED CLOCK is for a claim that names a branch; a `Claimed-nothing:` claim keeps N (it is idle at its prompt by design).
  // #460: `declared` is what the worker's last turn ended on, read by the gate for a claim that names a branch. Its presence turns the DECLARATION REGIME on, in
  // which an idle holder with no fresh and still-true declaration is stalled at M, a young pull request of its own no excuse (it should have declared `waiting-ci`).
  const regime = facts.declared !== undefined && facts.nothing !== true;
  const idle = idleClaimantReading({ session: facts.session, prs: withRedChecks(facts.ownPrs), built: facts.nothing !== true,
    ...(regime ? { declared: facts.declared } : {}),
    waitKinds: [...(facts.waitKind ? [facts.waitKind] : []), ...(facts.blockedBy.length > 0 ? ["blocked-by"] : [])] }, ctx);
  if (idle.kind === "waiting") return base;
  // (agent-org#743) A HOLDER WITH A PULL REQUEST OPEN IS COUNTED, one without it is the second reading's (below): the two paths do not meet. Only a red one reaches here (above).
  const counted = facts.openPrs > 0 && facts.nothing !== true;
  const held = ctx.nudge === null ? null : counted ? unansweredNudges(facts, idle, ctx) : rememberedNudge(facts, ctx);
  if (held !== null) return held.kind === "nudged" && !counted ? idleAgainReading(held, idle, facts, ctx) : held;
  if (idle.kind === "stall") return { kind: "nudge", idle: true, lastMoveAt: ctx.now - idle.idleMs, idleMs: idle.idleMs };
  if (idle.kind === "watching") return { kind: "idle-watch", since: idle.since };
  if (idle.kind === "unknown" && ctx.idleSince != null) return { kind: "idle-watch", since: ctx.idleSince };
  return base;
}

/**
 * (agent-org#860, a11ign#4957 cause 3) A NUDGED HOLDER THAT IS IDLE AGAIN. The chairman's rule is that a second idle period after the nudge files an incident, and the
 * only writer was a RELEASE carrying `nudgedAt`: a holder with a pull request is never released (#2999), a `Claimed-nothing:` claim is never released (#3407) and
 * a keyed row's release is withheld, so each read `nudged` for good and left no line. The run is counted from the later of its own first idle tick and the nudge's DELIVERY,
 * so a holder idle before the nudge reached it, or one the nudge never reached, is not "idle again" yet. `idleSince` is kept in the memory (`memoryOf`) and dropped the
 * tick the holder is not idle, so a holder that worked in between starts the period over. A declared wait (`idle.kind` `waiting`) never gets here, the overlay having
 * returned before the nudge is read, which is the "no declaration" half. NOT READ HERE, AND SAID: "no wake since the nudge" -- a later order to the holder is not
 * subtracted, so one wake after the nudge does not excuse the holder; the gate sends none while a nudge is outstanding.
 * @param {Reading & { kind: "nudged" }} held @param {IdleReading} idle @param {ClaimFacts} facts @param {Parameters<typeof claimReading>[1]} ctx @returns {Reading}
 */
function idleAgainReading(held: Reading & { kind: "nudged"; }, idle: IdleReading, facts: ClaimFacts, ctx: Parameters<typeof claimReading>[1]): Reading {
  if (idle.kind !== "watching" && idle.kind !== "stall") return held;
  const limit = idleLimitMs({ built: facts.nothing !== true, prs: withRedChecks(facts.ownPrs),
    ...(facts.declared !== undefined && facts.nothing !== true ? { declared: facts.declared } : {}) });
  const runStart = held.deliveredAt === null ? idle.since : Math.max(idle.since, held.deliveredAt);
  const again = held.deliveredAt !== null && ctx.now - runStart >= limit;
  return { ...held, idleSince: idle.since, ...(again ? { idleAgain: true as const } : {}) };
}

/**
 * (agent-org#743, a11ign#4437) THE NUDGES A HOLDER WITH A PULL REQUEST OPEN HAS LEFT UNANSWERED, COUNTED PER STALL. Until now such a holder read `nudged` for good: the
 * second reading never releases a holder whose pull request is open (#2999, `secondReading`), so a holder idle on a red pull request for ten hours was told once and
 * kept its slot. THE STALL ENDS ON PROGRESS, and progress is the row's definition and not the clock's: a commit on the branch, a pull request opened, a head moved
 * (a push), or the claim taken again, after the latest nudge. A comment or a changed file is a move for {@link clockReading}'s 120 minutes and is NOT one here, because a
 * holder that answers every nudge with a row comment is the one this exists for. Progress returns `null`, which is a FIRST reading again: the memory is replaced by a
 * fresh nudge numbered 1, or dropped when the holder is working.
 *
 * AN UNANSWERED NUDGE is {@link idleAgainReading}'s `idleAgain`: delivered, then a full idle period with no wait field and nothing declared. The first and second are
 * followed by the next nudge (NUMBERED, `count`, and carrying the one it supersedes as `unanswered` so the failure ledger still files one event per unanswered nudge);
 * THE THIRD IS FOLLOWED BY THE RELEASE, the same `stalled` release the no-pull-request path performs, with the pull request left as it is (no `openPrs`, so no
 * `answer:` and the row goes back to the pool as the release always did). A nudge that was not DELIVERED is not unanswered, and one that cannot be delivered holds the
 * claim as it did before this: the count adds a release and removes none.
 * @param {ClaimFacts} facts @param {IdleReading} idle @param {Parameters<typeof claimReading>[1]} ctx @returns {Reading | null}
 */
function unansweredNudges(facts: ClaimFacts, idle: IdleReading, ctx: Parameters<typeof claimReading>[1]): Reading | null {
  const nudge = ctx.nudge as NonNullable<typeof ctx.nudge>;
  const opened = (facts.ownPrs ?? []).map((pr) => Date.parse(String((pr as { createdAt?: string }).createdAt ?? ""))).filter(Number.isFinite);
  const progress = latest([facts.claimedAt, facts.commit(), facts.push(), ctx.restartAt, ...opened]);
  if (progress !== null && nudge.nudgedAt <= progress) return null;
  const count = nudge.count ?? 1;
  const lastMoveAt = (latest([facts.claimedAt, facts.comment, facts.commit(), facts.push(), ctx.restartAt]) as number);
  const told = idleAgainReading({ kind: "nudged", nudgedAt: nudge.nudgedAt, deliveredAt: nudge.deliveredAt, lastMoveAt, ...(nudge.idle === true ? { idle: true } : {}),
    ...(count > 1 ? { count } : {}) }, idle, facts, ctx);
  if (told.kind !== "nudged" || told.idleAgain !== true || idle.kind !== "stall") return told;
  if (count >= MAX_UNANSWERED_NUDGES) {
    return { kind: "release", why: "stalled", lastMoveAt, idleMs: idle.idleMs, nudgedAt: nudge.nudgedAt, idle: true, count, idleSince: idle.since };
  }
  return { kind: "nudge", idle: true, lastMoveAt: ctx.now - idle.idleMs, idleMs: idle.idleMs, count: count + 1, unanswered: nudge.nudgedAt };
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
  const lastMoveAt = (latest([facts.claimedAt, facts.comment, facts.commit(), facts.push(), ctx.restartAt, facts.file()]) as number);
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
  const cheap = (latest([facts.claimedAt, facts.comment, facts.commit(), facts.push(), ctx.restartAt]) as number);
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
 * REQUEST is never released by THIS reading (#2999): the release closes a spare's workspace, and a pull request whose author was closed under it is an
 * ownerless one -- so it stays `nudged` here. It is nudged again and, after {@link MAX_UNANSWERED_NUDGES} that nothing answered, released, by
 * {@link unansweredNudges} (agent-org#743), which the overlay asks instead of this for such a holder.
 * @param {ClaimFacts} facts @param {Parameters<typeof claimReading>[1]} ctx @param {number} lastMoveAt @returns {Reading | null}
 */
function secondReading(facts: ClaimFacts, ctx: Parameters<typeof claimReading>[1], lastMoveAt: number): Reading | null {
  if (ctx.nudge === null || ctx.nudge.nudgedAt <= lastMoveAt) return null;
  const interval = ctx.intervalMs ?? STALL_INTERVAL_MS;
  const { nudgedAt, deliveredAt } = ctx.nudge;
  const idle = ctx.nudge.idle === true;
  const told = deliveredAt !== null && ctx.now - deliveredAt >= interval;
  const isStalled = facts.openPrs === 0 && (told || (deliveredAt === null && ctx.now - nudgedAt >= STALL_UNTOLD_RELEASE_MS));
  if (isStalled) {
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

/**
 * #1281 (class `row-not-finishable`): THE `Waiting-for:` A CLAIM WOULD BE TAKEN ON, read as `waitingForOf` reads it for a holder -- a line of the row's body whose
 * condition `conditionHolds` says is `false`. A release on an unmet wait does not hold if the same wait is accepted again at the next claim, so the claim asks
 * the question the gate's release did. `readRef` is the reader of one referenced item's state (`null` when it could not be read) and `repo` the tracker the
 * row is in, which a bare `#n` of the line names. An UNKNOWN condition (`null`: an unread reference, `manual`, a line outside the grammar) is NOT unmet: a failed
 * read never refuses a claim. A met condition is not refused, so the row is claimable the tick it becomes true.
 * @param {string | null} body @param {string} repo @param {(ref: { repo: string, number: number }) => RefFact | null} readRef @returns {string | null} the unmet line's text
 */
export function unmetWaitingFor(body: string | null, repo: string, readRef: (ref: { repo: string; number: number; }) => RefFact | null): string | null {
  for (const wait of parseWaits(body)) {
    if (!isItemWait(wait)) continue;
    const fact = readRef({ repo: wait.repo ?? repo, number: wait.number });
    if (fact !== null && conditionHolds(wait, { items: { [wait.key]: fact } }) === false) return wait.text;
  }
  return null;
}

// --- THE FACTS OF ONE ROW ---------------------------------------------------------------------------------------------

export type OpenPr = import("../idle-claimant.ts").IdlePr & { headRefName?: string, title?: string };
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
 * `read`, run at most once: the second ask is the first's answer. A read that THROWS is not remembered (the next ask runs it again), so a refused
 * read is never mistaken for an answer. Scoped to ONE row's facts and so to one tick: `performRelease`'s fresh re-read goes through
 * {@link holderWorkAtRisk} itself and never through a memo, which is what makes it a re-read.
 * @template T @param {() => T} read @returns {() => T}
 */
export function once<T>(read: () => T): () => T {
  let held: { value: T } | undefined;
  return () => (held ??= { value: read() }).value;
}

/**
 * One claimed row's facts, or `{ skip }` saying why it is NOT EVALUATED this tick -- a row with no claim record cannot say
 * when it was claimed. A skipped row is neither nudged nor released, and the caller SAYS so: silence about a claim it could not read would look like
 * a claim that was fine. Git that will not answer is not "no commits" either, but it is found when the fact is ASKED FOR (agent-org#1083), where
 * {@link readClaim} holds the row; the tick's own `movesOf` is the one reader that asks for every row, and names the row in `skipped`.
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
    comment: commentMove(input.comments, record, input.session),
    commit: branch === null ? () => null : once(() => newestOwnCommit(io.git, dir, branch)),
    push: branch === null ? () => null : once(() => newestOwnCommit(io.git, dir, `origin/${branch}`)),
    file: once(() => (worktree !== null && io.exists(worktree) ? fileMove(io, worktree) : null)),
    work: once(() => holderWorkAtRisk(io, { worktree, branch, repo: input.repo,
      ...(merged?.repoKey ? { merged: { repoKey: merged.repoKey, head: merged.headRefName, claimant } } : {}) })),
    openPrs: ownPrs.length,
    mergedPr: merged === null ? null : { number: merged.number, mergedAt: Date.parse(String(merged.mergedAt)), ...(merged.repoKey ? { repoKey: merged.repoKey } : {}),
      ...(merged.headRefName ? { head: merged.headRefName } : {}) },
    waiting: input.waiting, blockedBy: input.blockedBy,
    ...(input.waitKind === undefined ? {} : { waitKind: input.waitKind }),
    ownPrs, ...(record.nothing ? { nothing: true } : {}), ...(held === null ? {} : { mergedHeld: held }),
    ...(clock.held === null ? {} : { clockHeld: clock.held }) };
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
function landedWork({ merged, claimant, record, io, labelledAt: labelledAtOf }: { merged: (MergedPr & { repoKey?: string; })[]; claimant: import("../pr-ownership.ts").Claim; record: ClaimRecord; io: HostReads; labelledAt: () => number | null; }): { merged: ReturnType<typeof newestMergedAfter>; held: string | null; } {
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
function newestMergedAfter(merged: (MergedPr & { repoKey?: string; })[], claimant: import("../pr-ownership.ts").Claim, since: number): { number: number; mergedAt: string; repoKey?: string; headRefName?: string; } | null {
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
export type StallState = Record<string, { session: string, nudgedAt?: number, goneSince?: number, idleSince?: number, idle?: boolean, nudges?: number }>;

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
 * (#3076) A PULL REQUEST'S NUMBER AS A PERSON READS IT: `#38` for the home repository, `agent-org#38` for another tracked one, because `#38` alone
 * opens the home repository's. Every spelling of a release's pull request -- the order's prompt here, the comment `wake.ts` leaves on the row --
 * goes through this and the two below, so no sentence can name one without saying which repository it is in.
 * @param {number} number @param {string | undefined} repoKey @returns {string}
 */
export function prMention(number: number, repoKey: string | undefined): string {
  return subjectMention({ repoKey, number });
}

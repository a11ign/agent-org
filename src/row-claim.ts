// @ts-check
// command: check, claim, or decline a tracker row by reading its labels, the record, never git history
// IS THIS ROW CLAIMED? -- reads the BOARD (issue labels), never git history.
//
// #28 and #30 (2026-09-06) were both pulled twice in one hour. Both workers ran the documented collision
// check -- `git log --branches='agent/*' --not origin/main -- <region path>` -- and both got a clean,
// correct answer to the wrong question. That check answers "would I collide with someone in this FILE";
// it does not answer "is somebody already on this ROW", and a branch existing (or not) is not a claim.
// The claim that DID exist sat on the board the whole time: Status `In progress` plus the `in-progress`
// label, unconsulted because the documented procedure named the region check, never the board.
//
// `in-progress` is the label to trust, not the Project Status field, per `product-manager`'s own ruling:
// the Project Status field is a VIEW, and the label -- applied to the issue itself, timestamped by
// GitHub's own timeline -- is the record. `session:<name>` labels name who.
//
// THE VACUITY GUARD IS THE SHARPEST VERSION OF THIS REPO'S OWN RECURRING SHAPE: a query that fails and
// is read as "no labels" would report every row UNCLAIMED, turning one duplicate pull into a queue-wide
// free-for-all. So `fetchLabels` refuses to guess -- any malformed, incomplete, or failed response is a
// thrown error, never a silent empty array. See `decideClaim`'s own doc for why "unclaimed" must be
// EARNED, not defaulted to.
//
// #176 (2026-09-07): a `session:` label marked who held a row AFTER they took it, but nothing marked it
// as it went OUT -- so a row handed out in a dispatcher message and a row taken by `claim` were
// indistinguishable from unclaimed until the SECOND of the two acted, and three real double-dispatches
// (#156, #158, #159) were caught only by a worker's own caution, not by this tool. The fix, per
// `dispatcher`'s 2026-09-07 ruling quoted on the row: apply `in-progress` + `session:<name>` at DISPATCH,
// not only at claim -- so THREE states exist, not two: unclaimed, dispatched-but-not-started (in-progress
// + session, no `started`), and started (`started` too). `dispatchRow` writes the first pair;
// `claimRow`/`startRow` additionally writes `started`, so a worker pulling a row itself with no prior
// dispatch goes straight from unclaimed to started, and a worker beginning a row dispatcher already
// marked goes from dispatched to started without a second race window.
//
// The cost this trades for: a row dispatched and then declined would sit marked forever with nobody
// obligated to un-label it -- `dispatcher`'s own judgement is that a STALE `in-progress` is visible and
// costs a question, while a double-dispatch is invisible and costs a worker's evening, and that trade is
// right. `declineRow` is the remedy: it returns a row this session holds to genuinely unclaimed, and is
// also the general "give it back" this tool always lacked -- #186 needed it too, when `worker-audit`
// claimed a row, found it unstartable, and had no way to release it short of a hand edit.
//
// #226: A WORKER FINDING A DISPATCHED ROW ALREADY CLOSED, HELD OR BUILT IS A DISAGREEMENT NOBODY RECORDS.
// Three times on 2026-09-07 a worker ran `check`, was told a verdict, and then discovered reality was
// different -- and every one of those reached `dispatcher` as a message and died there. This is #188 one
// layer out: `merge-guard`'s wrong answers were absorbed by branch protection, so nothing recorded them
// being wrong; `row-claim check`'s wrong answers are absorbed by a person being careful, which does not
// survive the session.
//
// So EVERY `check` call now appends its own verdict to a log -- unconditionally, not only when something
// later turns out wrong. That is what makes "how often is this tool wrong" answerable rather than "three
// times that somebody happened to mention": the check-log is the DENOMINATOR, and a `conflict` entry
// (recorded by a worker who found reality different, pairing the tool's own verdict with what they found)
// is the NUMERATOR. A log that only ever grew on disagreement could never tell "the tool was right" from
// "nobody checked" -- the exact trap #188's `agreementLogPath` already exists to avoid, and the reason
// this reuses its `gitCommonDir`/`appendJsonl` (both exported from `merge-guard.mjs` for exactly this)
// rather than inventing a second version of "append one JSON line, fail loud".
//
// IT RECORDS; IT NEVER GATES -- same as `reportReachability` below. A log write failing is reported and
// never touches `process.exitCode`, for the identical reason `reportReachability`'s own failure does not:
// "I could not tell you whether it is claimed" and "I could not log that I told you" are different
// failures, and conflating them would make a full disk read as an unreadable board.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { existsSync, realpathSync, readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// RELATIVE, NOT the `@a11ign/screenreader-fleet/cli-flags` package specifier: that export map
// points at `dist/`, so it needs both `node_modules` AND a completed build. This file is reachable
// from a pre-install entry (see `pre-install-import-graph.test.ts`, which derives that population
// rather than naming it), and there it dies on startup with ERR_MODULE_NOT_FOUND.
import { refuseUnknownFlags } from "./lib/cli-flags.mjs";
import { REPO } from "./project-identity.ts";
import { homeProjectDeclaration, PROJECT_DECLARATION_PATH } from "./project-config.ts";
import { READY_LABEL, WAS_READY_LABEL } from "./ready-label-audit.ts";
import { gitCommonDir, appendJsonl } from "./merge-guard.ts";
import { withBoardSnapshot, PROJECT_OWNER, PROJECT_NUMBER } from "./board-snapshot.ts";
import { runnerReason, laneReason, drainReason, oneRowReason } from "./row-claim/runner-rule.mjs";
import { activeDrain, sparePathsFrom, ledgerPathFrom, isSpareRole, isPersistentRole, readSpareRegistry } from "./wake.ts";
import { readWithFirstWaveTogether, runBatch } from "./work-gate.ts"; // #3566, slice 4: `wake.mjs` above already loads it, and it never loads this file
import { readJsonObject, writeJsonObject } from "./claim-stall.ts";
import { inBuildReason, lookupHeldRows, lookupOtherHeldIssues } from "./row-claim/own-pr-health-rule.mjs";
import { resolveBlockedByOverride, blockedByExceptionNote } from "./row-claim/blocked-by-rule.mjs";
import { blockedByEdgeReason, lookupBlockedByEdge } from "./row-claim/blocked-by-edge-rule.mjs";
import { claimedRegionOverlapReason, fileOverlapReason, lookupClaimedRegions, lookupMyRegionFiles, lookupOpenPrFiles } from "./row-claim/file-overlap-rule.mjs";
import { templateFieldsReason, lookupIssueBody } from "./row-claim/template-fields-rule.mjs";
import { staleRuleReason } from "./row-claim/stale-rule-guard.mjs";
// #2031 EXTRACTED THE RULE THIS FILE DEFINED, and the extraction is the whole of this file's change.
// `work-gate.mjs` now asks the same question of every Ready row, and #2031's own filing names the reason
// it may not re-derive it: "both parse a trailing `-<n>` out of an `ls-remote` listing, and #2014's
// `rowBranchesOnOrigin` is the tested spelling". The FAILURE POLICY stayed here -- see `rowBranchesOnOrigin`
// below, which still throws -- because the gate's is deliberately different.
import { LS_REMOTE_ARGS, branchesForRow } from "./row-claim/row-branch-rule.mjs";
import { sandboxGitEnv } from "./lib/git-env.mjs";
import { primaryWorktreeOf, unverifiedRecords } from "./prune-worktrees.ts";
import { claimRefusal, recordRemoval } from "./worktree-removal.ts";

/** What the worktree-removal log (#2782) names as the asker for this file's two removers. */
const CALLER = "row-claim.mjs";
import { CLAIM_LABEL, STARTED_LABEL, CLAIM_RECORD_MARKER, STATE_LABELS, stateLabelFindings } from "./claim-labels.ts";
// #2619 (child 3d of #69): the rest of this file's vocabulary -- `blocked`, `answer:`, `session:`.
import { BLOCKED_LABEL, BACKLOG_LABEL, ANSWER_PREFIX, SESSION_PREFIX } from "./project-vocabulary.ts";
import { worktreeOwner, stampWorktree, OWNER_FILE } from "./worktree-owner.ts";
import { launchGate } from "./board-snapshot-scope.ts";
import { assertNoLeakInArgv } from "./lib/leak-patterns.mjs";

// #804: CLAIM_LABEL/STARTED_LABEL are IMPORTED (above) from the leaf claim-labels.mjs and re-exported
// here, not declared in this file -- see claim-labels.mjs's own header for why. Every existing
// `import { CLAIM_LABEL } from "./row-claim.ts"` call site is unchanged. A bare `export {...} from`
// would forward the binding WITHOUT creating a local one, and this file's own code below needs the local
// name -- hence import-then-export as two separate statements rather than one re-export line.
export { CLAIM_LABEL, STARTED_LABEL };
// #2619 (child 3d of #69): IMPORTED, NOT REDECLARED -- `project-vocabulary.mjs`'s fields, re-exported
// under this file's own established name so `BLOCKED_LABEL`'s existing importers keep working unchanged.
export { BLOCKED_LABEL };
/** #2470: `decline --answer=<session>` adds `answer:<session>`, the label `waiting-condition.mjs` reads as "that session owes an answer". */
const ANSWER_LABEL_PREFIX = ANSWER_PREFIX;

/**
 * #771: the `Filed-by: <session>` line `row-file.mjs` writes, or `null` when absent -- a LITERAL line
 * match only. Older prose ("Filed by `orchestrator`", no hyphen, no colon-value structure) is NEVER
 * inferred as this: #737 and #758 both carry that sentence and both must read `unrecorded`, the same rule
 * #603's owned-path sign-off already applies to "I checked" standing in for a stated fact.
 * @param {string} body
 * @returns {string | null}
 */
export function filedByLine(body: string): string | null {
  const match = /^Filed-by:\s*(.+)$/m.exec(body);
  return match ? match[1].trim() : null;
}
// #656: THE CLAIM RECORDS THE BRANCH. `session:*` names WHO holds a row; nothing named WHAT git object
// that session was actually working on, so the dispatcher's own attempt to carry #614 -- "the row moves
// to whoever is free" -- discovered only by running `git worktree add` that the branch was checked out
// on this same machine, in the owner's own worktree, with no way to have known that beforehand. A row's
// claim is now the one place that fact is recorded, so an escalating session can tell a PORTABLE row
// (branch not held anywhere) from a HELD one before it ever offers to take it.
export const BRANCH_LABEL_PREFIX = "branch:";
// #665: THE CLAIM RECORDS THE WORKTREE TOO. Measured 2026-09-09T10:03Z: 115 worktrees on the host with
// ~57 MB free -- each row taken opens one and nothing closes it when the row is done, because "prune
// after every merge" is a habit, and this repository's own rule is that anything a human has to
// remember is something that does not happen. Recording the path at claim time is what lets RELEASING
// the claim -- the moment the releasing session, and only it, is known to be done with that directory --
// remove it automatically rather than trusting the next sweep to notice.
export const WORKTREE_LABEL_PREFIX = "worktree:";

// #987: AND NEITHER OF THOSE TWO FACTS FITS IN A LABEL. GitHub caps a label NAME at 50 characters, so
// `worktree:` (9) leaves 41 for a path and `branch:` (7) leaves 43. An ordinary worktree beside this
// checkout -- `/Users/<user>/Documents/repos/personal/a11y-wt-987` -- is 50 characters on its own, making
// a 59-character label, and `gh issue edit --add-label` answers HTTP 422. Measured 2026-09-11 while
// claiming #986 (72 characters, refused); measured again the day this row was built: of the 33 rows that
// have ever carried one, every single `worktree:` label names a short `/private/tmp/wt-<row>` path,
// because that is the only shape that fits. The flag's documented usage could not be followed for the
// common case, so engineers dropped the flag -- and #933's hazard (uncommitted work in a retired
// session's worktree, invisible to every enumeration) went unrecorded precisely where it is most likely.
//
// SO THE RECORD MOVES TO A CLAIM COMMENT, and the two labels are no longer written.
//
// A comment rather than the row BODY, deliberately. The body is a read-modify-write with no atomicity and
// it is not this tool's to own: rows carry `## Region`/`## Acceptance`/`## Open-check` sections that
// product-manager amends -- one was amended on THIS row while it sat in the Ready column -- and a claim
// rewriting a body it read a moment earlier would silently drop that edit. A comment is append-only, so
// two writers cannot clobber each other, and `row-claim` already posts one (#741's exception note).
// RE-EXPORTED FROM THE LEAF, not declared here -- #2110 gave `work-gate.mjs` a reason to read it, and
// this file is unimportable from a tick (see `claim-labels.mjs`'s own header for the whole argument).
// Every existing `import { CLAIM_RECORD_MARKER } from "./row-claim.ts"` keeps working unchanged,
// exactly as it did for the four labels above it.
export { CLAIM_RECORD_MARKER };
const CLAIM_RECORD_BRANCH = "Claimed-branch:";
const CLAIM_RECORD_WORKTREE = "Claimed-worktree:";
// #3407: the spelling of a claim that names NO git object (a host act, a fleet or lab reading, a hand-claim). It is a CLAIM -- "claimed by", with
// a field -- and so is not a release, which has no field; the stall check reads it by the clock and never releases it.
const CLAIM_RECORD_NOTHING = "Claimed-nothing:";
const NOTHING_REASON = "the claim named no branch and no worktree";

/**
 * Pure: the claim-record comment for a claim (or, with both fields absent, for a RELEASE).
 *
 * The marker is an HTML comment so it is invisible in the rendered thread while still being the thing
 * `claimRecordFrom` matches on -- a prose heading would be matched by anyone quoting this comment, which
 * is the mention-versus-use trap `acceptance-commands.mjs`'s header already names.
 *
 * A release writes the marker with NO field lines rather than writing nothing, because "released" and
 * "never recorded" have to be distinguishable: without it the last CLAIM comment would still be the
 * newest record, and `check` would keep naming a worktree this tool had already removed.
 *
 * #3407: `nothing` is the reason a CLAIM names no git object (`Claimed-nothing: <reason>`). It is what makes that claim legible to the stall
 * check, which reads a record's own time and cannot evaluate a claim that wrote none.
 * @param {{ session: string, branch?: string | null, worktree?: string | null, nothing?: string | null, released?: boolean }} record
 * @returns {string}
 */
export function claimRecordComment({ session, branch, worktree, nothing, released = false }: { session: string; branch?: string | null; worktree?: string | null; nothing?: string | null; released?: boolean; }): string {
  const what = released ? `released by \`${session}\`` : `claimed by \`${session}\``;
  const lines = released ? [] : [
    ...(branch ? [`${CLAIM_RECORD_BRANCH} ${branch}`] : []),
    ...(worktree ? [`${CLAIM_RECORD_WORKTREE} ${worktree}`] : []),
    ...(nothing ? [`${CLAIM_RECORD_NOTHING} ${nothing}`] : []),
  ];
  return [CLAIM_RECORD_MARKER, `**Claim record** -- ${what}.`, "", ...lines,
    ...(lines.length === 0 ? ["No branch or worktree is recorded for this row."] : []),
    "", "The branch and worktree live here rather than in a `branch:`/`worktree:` label because GitHub "
    + "caps a label name at 50 characters and an ordinary absolute path does not fit (#987).",
  ].join("\n");
}

/**
 * Pure: the branch and worktree the NEWEST claim-record comment names, or nulls when none does.
 *
 * Newest wins, and only comments carrying the marker are read -- a row can be claimed, released and
 * claimed again, and each of those appended its own record. `comments` is oldest-first, the order
 * `gh issue view --json comments` returns.
 * @param {string[]} comments comment bodies, oldest first
 * @returns {{ branch: string | null, worktree: string | null, recorded: boolean, nothing?: true }} `nothing` is present only for a
 *   #3407 nothing-claim, so every reading that does not know of it is unchanged
 */
export function claimRecordFrom(comments: string[]): { branch: string | null; worktree: string | null; recorded: boolean; nothing?: true; } {
  const records = comments.filter((c) => c.includes(CLAIM_RECORD_MARKER));
  const newest = records.at(-1);
  if (newest === undefined) return { branch: null, worktree: null, recorded: false };
  const read = (key: string) => {
    const match = new RegExp(`^${key}\\s*(.+)$`, "m").exec(newest);
    return match ? match[1].trim() : null;
  };
  return { branch: read(CLAIM_RECORD_BRANCH), worktree: read(CLAIM_RECORD_WORKTREE), recorded: true,
    ...(read(CLAIM_RECORD_NOTHING) === null ? {} : { nothing: true }) };
}

/**
 * #1432: Pure: the session the NEWEST claim-record comment was written by, or null -- null for no record, and for a
 * RELEASE, which names who released it and claims nothing.
 * @param {string[]} comments comment bodies, oldest first
 * @returns {string | null}
 */
export function claimRecordSession(comments: string[]): string | null {
  const newest = comments.filter((c) => c.includes(CLAIM_RECORD_MARKER)).at(-1);
  if (newest === undefined) return null;
  const match = /\*\*Claim record\*\* -- claimed by `([^`]+)`/.exec(newest);
  return match ? match[1] : null;
}

/**
 * Pure: the branch and worktree a row records, preferring the claim comment and falling back to a
 * `branch:`/`worktree:` LABEL written before #987 landed.
 *
 * THE FALLBACK IS A MIGRATION READ WITH AN END CONDITION, not a second spelling of the same fact. The
 * comment is the only place a NEW claim writes; the label is only ever read. Measured the day this
 * landed: **3 open rows** carried one (#772, #987, #1019) and 30 closed ones did. It can be deleted once
 * this prints 0:
 *
 * ```bash
 * gh issue list --state open --limit 200 --json labels \
 *   --jq '[.[]|select(.labels|map(.name)|any(startswith("branch:") or startswith("worktree:")))]|length'
 * ```
 *
 * Dropping it sooner would leave a stale `worktree:` label on one of those three and skip removing the
 * directory it names, which is the one outcome #665 exists to prevent.
 * @param {{ labels: string[], comments: string[] }} row
 * @returns {{ branch: string | null, worktree: string | null }}
 */
export function claimedObjects({ labels, comments }: { labels: string[]; comments: string[]; }): { branch: string | null; worktree: string | null; } {
  const fromComment = claimRecordFrom(comments);
  if (fromComment.recorded) {
    return { branch: fromComment.branch, worktree: fromComment.worktree, ...(fromComment.nothing ? { nothing: true } : {}) };
  }
  const labelled = claimStatus(labels);
  return { branch: labelled.branch, worktree: labelled.worktree };
}

export type IssueClaim = { number: number, title: string, labels: string[], state?: "OPEN" | "CLOSED" };

/**
 * #709: `git worktree remove` (below) DESTROYS A DIRECTORY, and an unscrubbed spawn inherits any
 * `GIT_DIR`/`GIT_WORK_TREE` a caller's environment carries -- the exact shape that once redirected a
 * spawned git call onto the wrong repository. `sandboxGitEnv()` scrubs every `GIT_*` var; applying it to
 * every spawn here, `gh` included, costs nothing (`gh` reads none of them) and needs no second helper for
 * the one call that actually matters.
 * @type {(cmd: string, args: string[]) => string}
 */
const defaultRun: (cmd: string, args: string[]) => string = (cmd, args): string => {
  assertNoLeakInArgv(cmd, args); // #1053: guarded in the SPAWN HELPER -- three comment writers below
  return execFileSync(cmd, args, { encoding: "utf8", env: sandboxGitEnv() });
};

/**
 * `run` that asks GitHub for a given ROW READ once (a11ign/a11ign#3566, slice 5). One claim's checks each read the row they are about -- the template
 * check and B4's Region lookup both read its `body`; the claim's own `blockedBy` check and B2/B4's both read its edge -- so the same `gh issue
 * view`/`list` went out twice, about 0.45 s each, inside a tick that waits for it. A repeated read of the same arguments returns the first answer.
 *
 * ONLY THE PRE-WRITE CHECKS ARE GIVEN THIS: it is a snapshot of the row from the start of the claim, which is what those checks already compare
 * against, and nothing after the first write may be answered from it (the labels are read again, fresh, right before and right after the write that
 * claims). A read that THROWS is not remembered, so a failed read is retried exactly as before; a write is never passed through the cache.
 * @param {typeof defaultRun} run
 * @returns {typeof defaultRun}
 */
function readsOnce(run: typeof defaultRun): typeof defaultRun {
  const answers: Map<string, string> = new Map();
  return (cmd, args) => {
    const isRowRead = cmd === "gh" && args[0] === "issue" && (args[1] === "view" || args[1] === "list");
    if (!isRowRead) return run(cmd, args);
    const key = JSON.stringify(args);
    const known = answers.get(key);
    if (known !== undefined) return known;
    const answer = run(cmd, args);
    answers.set(key, answer);
    return answer;
  };
}

// #749: `gh issue edit --add-label <name>` REFUSES a label that does not exist -- and #677's own
// reproduction (13:23:15Z) showed the failure is NOT atomic: the SAME command's `--remove-label ready`
// still applied while every `--add-label` (including `branch:agent/activation-budget-677`) did not,
// because `branch:<name>` and `worktree:<path>` are PER-ROW-UNIQUE labels this repo has never created in
// advance -- `gh label list | grep '^branch:'` returned 0 the day this row was filed, and `worktree:`
// (#665, the identical shape one field over) was found to be exactly as unwritten while fixing this.
// `--force` makes creation idempotent (updates color/description rather than erroring) so this never
// fails on a label a previous claim already made.
/**
 * #883: EXPORTED, not module-private -- `row-file.mjs` needs the identical creation for the `lane:<owner>`
 * labels it derives, and a second copy of "create a label idempotently before adding it" is the same
 * fact-stated-twice shape #749 itself exists to name. Behaviour is unchanged for every existing caller.
 * @param {string[]} labels @param {{ run?: typeof defaultRun, batch?: typeof runBatch }} [deps] `batch` (#3566, slice 9) asks the creates together; absent, one by one
 */
export function ensureLabelsExist(labels: string[], { run = defaultRun, batch }: { run?: typeof defaultRun; batch?: typeof runBatch; } = {}) {
  const create = (label: string) => ["label", "create", label, "--repo", REPO, "--force"];
  if (batch !== undefined && labels.length > 1 && createdTogether(labels.map(create), batch)) return;
  for (const label of labels) run("gh", create(label));
}

/**
 * (#3566, slice 9) THE CLAIM'S LABEL CREATES WAIT TOGETHER: a real claim made four `label create --force` one after another, 3,168 ms of its 15,662 ms.
 * Each creates-or-updates one label to the same colour and description every time, so none reads another's result and each is idempotent. The commands
 * are the sequential ones' own.
 *
 * A REFUSED CREATE, OR A BATCH THAT COULD NOT RUN, IS SAID AND THEN ASKED AGAIN ONE AT A TIME: `--force` makes the repeat harmless, and the repeat is what
 * throws the error the claim always threw, before any label of the row is written. `false` here means "nothing is known to have landed, ask them one by one".
 * @param {string[][]} argvs @param {typeof runBatch} batch
 * @returns {boolean} whether every create was answered
 */
function createdTogether(argvs: string[][], batch: typeof runBatch): boolean {
  try {
    for (const args of argvs) assertNoLeakInArgv("gh", args); // #1053: the batch is a spawn of its own, so the guard `defaultRun` carries is asked here as well
    const answers = batch(argvs.map((args) => ({ args, repo: undefined })));
    if (answers.every((answer) => !("failed" in answer))) return true;
    process.stderr.write("NOTE: a label create was refused in the batch, so the creates run one by one\n");
  } catch (error) {
    process.stderr.write(`NOTE: the label creates could not be batched, so they run one by one: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  return false;
}

/**
 * Reads an issue's CURRENT labels from the real board. Injectable `run`, the same seam
 * `install-git-hooks.mjs` uses, so this is testable without a network call or a real repo.
 *
 * REFUSES TO GUESS: `gh` failing (network, auth, a deleted issue), or answering with a shape this
 * function does not recognise, throws -- it never falls through to an empty label list, which is
 * indistinguishable from "genuinely no labels" and would make every failure read as UNCLAIMED.
 *
 * #2617: `repo` is the TRACKER the row lives in -- the one the project's declaration names for it (default the first).
 *
 * @param {number} issueNumber
 * @param {{ run?: typeof defaultRun, repo?: string }} [deps]
 * @returns {IssueClaim}
 */
export function fetchLabels(issueNumber: number, { run = defaultRun, repo = REPO }: { run?: typeof defaultRun; repo?: string; } = {}): IssueClaim {
  let raw: string;
  try {
    raw = run("gh", ["issue", "view", String(issueNumber), "--repo", repo,
      "--json", "number,title,labels,state"]);
  } catch (cause) {
    throw new Error(`row-claim: could not read issue #${issueNumber} from ${repo} -- refusing to guess `
      + `whether it is claimed. ${(cause as Error).message}`, { cause });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`row-claim: gh's response for issue #${issueNumber} was not JSON -- refusing to `
      + `guess. First 200 chars: ${raw.slice(0, 200)}`, { cause });
  }
  const obj = (parsed as { number?: unknown, title?: unknown, labels?: unknown, state?: unknown });
  if (typeof obj?.number !== "number" || typeof obj?.title !== "string" || !Array.isArray(obj?.labels)) {
    throw new Error(`row-claim: gh's response for issue #${issueNumber} is missing number/title/labels -- `
      + `refusing to guess. Got: ${JSON.stringify(parsed).slice(0, 300)}`);
  }
  const names = obj.labels.map((l: unknown) => {
    const name = (l as { name?: unknown })?.name;
    if (typeof name !== "string") {
      throw new Error(`row-claim: a label on issue #${issueNumber} has no name -- refusing to guess. `
        + `Got: ${JSON.stringify(l)}`);
    }
    return name;
  });
  // #752: OPTIONAL, DELIBERATELY -- every existing caller/test that mocks a `gh issue view` response
  // without a `state` field must keep behaving exactly as it did (the open case), so an absent or
  // unrecognised value is treated as "not verified closed" rather than refused outright. `declineRow`
  // is the one place this actually changes behaviour, and only when `state` is the literal `"CLOSED"`.
  const state = obj.state === "OPEN" || obj.state === "CLOSED" ? obj.state : undefined;
  return { number: obj.number, title: obj.title, labels: names, state };
}

/**
 * #987: the row's comment bodies, oldest first -- the thread `claimRecordFrom` reads the recorded branch
 * and worktree out of.
 *
 * THROWS rather than returning null on a failed read, unlike the `lookup`-wrapped helpers next door, and
 * that asymmetry is the point: `declineRow` uses this to decide which directory to remove, so a read that
 * silently became "no worktree recorded" would skip the removal and report a clean decline -- unreadable
 * is not unrecorded, the same distinction `arm-pr`'s own label read already refuses to blur.
 * @param {number} issueNumber
 * @param {{ run?: typeof defaultRun, repo?: string }} [deps] `repo` is the tracker the row lives in
 * @returns {string[]}
 */
export function fetchClaimComments(issueNumber: number, { run = defaultRun, repo = REPO }: { run?: typeof defaultRun; repo?: string; } = {}): string[] {
  let raw: string;
  try {
    raw = run("gh", ["issue", "view", String(issueNumber), "--repo", repo, "--json", "comments"]);
  } catch (cause) {
    throw new Error(`row-claim: could not read issue #${issueNumber}'s comments from ${repo} -- refusing `
      + `to guess what branch or worktree its claim recorded. ${(cause as Error).message}`,
    { cause });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`row-claim: gh's comment response for issue #${issueNumber} was not JSON -- refusing `
      + `to guess. First 200 chars: ${raw.slice(0, 200)}`, { cause });
  }
  const comments = (parsed as { comments?: unknown })?.comments;
  if (!Array.isArray(comments)) {
    throw new Error(`row-claim: gh's response for issue #${issueNumber} carried no comments array -- `
      + `refusing to guess. Got: ${JSON.stringify(parsed).slice(0, 300)}`);
  }
  return comments.map((c: unknown) => {
    const body = (c as { body?: unknown })?.body;
    return typeof body === "string" ? body : "";
  });
}

/**
 * Pure: does this label set say the row is claimed, and by whom, and has work actually started?
 *
 * `sessions` can be EMPTY even when `claimed` is true -- a row moved to In progress by the dispatcher
 * before assigning it (exactly how #55 itself was claimed) has `in-progress` with no `session:*` yet.
 * That is still a claim; "claimed, owner not yet recorded" and "unclaimed" are different states and this
 * function does not conflate them.
 *
 * `started` is a THIRD, independent bit (#176): `in-progress` alone (or with a session) means dispatched
 * but not yet begun; `in-progress` + `started` means the assigned session is actually working it. A row
 * can be `claimed` with `started: false` -- that is the dispatched-not-started state this function exists
 * to make visible, not an inconsistency to normalise away.
 *
 * `branch` (#656) is the row's recorded `branch:<name>` label, or `null` when none is set -- a row can
 * be legitimately claimed with no branch yet (dispatched but not started, or a non-code row entirely), so
 * absence here is a real state, not a parse failure. Only the FIRST such label is read; more than one
 * would mean two claims wrote branches without one being declined first, which `writeRowLabels`'s own
 * race handling already prevents from standing.
 *
 * `worktree` (#665) is the identical shape one field over -- the row's recorded `worktree:<path>` label,
 * or `null`. Recorded alongside `branch` so `declineRow` knows what directory to remove when the claim
 * is released, without guessing a path from a naming convention nobody enforces.
 *
 * @param {string[]} labels
 * @returns {{ claimed: boolean, started: boolean, sessions: string[], branch: string | null, worktree: string | null }}
 */
export function claimStatus(labels: string[]): { claimed: boolean; started: boolean; sessions: string[]; branch: string | null; worktree: string | null; } {
  const branchLabel = labels.find((l) => l.startsWith(BRANCH_LABEL_PREFIX));
  const worktreeLabel = labels.find((l) => l.startsWith(WORKTREE_LABEL_PREFIX));
  return {
    claimed: labels.includes(CLAIM_LABEL),
    started: labels.includes(STARTED_LABEL),
    sessions: labels.filter((l) => l.startsWith(SESSION_PREFIX)).map((l) => l.slice(SESSION_PREFIX.length)),
    branch: branchLabel ? branchLabel.slice(BRANCH_LABEL_PREFIX.length) : null,
    worktree: worktreeLabel ? worktreeLabel.slice(WORKTREE_LABEL_PREFIX.length) : null,
  };
}

/**
 * Pure: given the labels read BEFORE this session's own claim attempt, should it proceed?
 *
 * A row already carrying `session:<mySession>` is not a collision -- resuming your own claimed row (the
 * pull-before-report loop revisiting a row it already owns) must not read as someone else having it.
 *
 * @param {string[]} labelsBefore
 * @param {string} mySession
 * @returns {{ proceed: true } | { proceed: false, reason: string }}
 */
export function decideClaim(labelsBefore: string[], mySession: string): { proceed: true; } | { proceed: false; reason: string; } {
  // #444: a RESERVATION check, ahead of the CLAIM check -- a row can be `ready` (not yet `in-progress`)
  // and still reserved for a specific session, which is #324's own shape before anyone claims it.
  const reserved = runnerReason(labelsBefore, mySession);
  if (reserved) return { proceed: false, reason: reserved };

  // #1039: BESIDE THE RESERVATION, AND BEFORE THE `claimed` CHECK for the same reason. A row can be
  // `ready` and in somebody else's lane, which is exactly the state #965 was in when it was claimed --
  // a check gated on `claimed` first would let anyone take an unclaimed row out of its owner's lane.
  const lane = laneReason(labelsBefore, mySession);
  if (lane) return { proceed: false, reason: lane };

  const status = claimStatus(labelsBefore);
  if (!status.claimed) return { proceed: true };
  if (status.sessions.includes(mySession)) return { proceed: true };
  const by = status.sessions.length > 0 ? status.sessions.join(", ") : "someone (no session label recorded yet)";
  return { proceed: false, reason: `issue is already claimed by ${by}` };
}

/**
 * Moves an issue's Project Status field -- the VIEW -- to match the label that is the RECORD. #400: a
 * claim writing the label and leaving Status behind is what let 45 stale Status values regenerate at the
 * rate work is claimed, measured live as `unlabeled ready / labeled in-progress` for the three minutes
 * between a real claim and the next hourly audit.
 *
 * SNAPSHOTTED FIRST, via `withBoardSnapshot` (#399): the day this row was filed, a single-field Project
 * mutation silently dropped all 112 items' Status values, and only a snapshot taken minutes earlier for
 * an unrelated reason made recovery possible. No board write ships without one.
 *
 * NEVER THROWS, on purpose -- but the two ways it can fail to move Status are NOT the same failure, per
 * `ceo`'s 2026-09-08 ruling on this issue: "'could not ask' and 'asked and wrote' must not look the same,
 * and a half-applied claim is worse than none."
 *
 * A row genuinely not on the Project is a real, common state -- four existed the night this was written --
 * and `gh project item-edit` refuses it with a STABLE, recognisable message ("is not an item in project
 * N"); this is the one case this issue's own acceptance text names outright ("a claim on a row that is not
 * on the Project at all must not fail"), so it is reported as `notOnBoard: true` and never treated as a
 * defect for a caller to surface as a failure.
 *
 * ANY OTHER failure -- auth, network, a field-name typo, a real API error -- is the half-applied case ceo's
 * ruling is about: the label (the record) was written and the view write genuinely did not reach the
 * board. That is reported as `notOnBoard: false`, and callers (`writeRowLabels`/`declineRow` below) surface
 * it distinctly rather than folding it into an ordinary success.
 *
 * Reading that a mutation failed is not the same failure as being unable to tell whether it failed at all
 * -- matching `reportReachability`'s own rule a few functions up -- so this still never THROWS; it reports
 * via the return value and `log`, and it is `writeRowLabels`/`declineRow`'s job to decide what that means
 * for their own exit code.
 *
 * `issueNumber` ITSELF IS EXCLUDED FROM THE SNAPSHOT'S OWN #747 FLOOR (#891, live 2026-09-09): that floor
 * refuses if any open `ready` row has no Status, and it does not know the difference between "a row
 * silently lost its Status, neglected" and "this exact call is what is about to give it one" -- so a row
 * that already carries `ready` by the time it reaches `gh project item-add` (any caller passing gh's own
 * `-l ready`/`--label=ready` straight through does this; `row-file.mjs`'s `--ready` sentinel is a separate,
 * later convention that does not stop it) trips the floor on ITSELF, refusing every time. See
 * `readyRowsMissingStatus`'s own header for the full account.
 *
 * @param {number} issueNumber
 * @param {string} statusName exactly one of the Project's real Status option names ("Ready", "In progress", …)
 * @param {{ run?: typeof defaultRun, log?: (line: string) => void, snapshot?: typeof withBoardSnapshot }} [deps]
 * @returns {{ moved: true } | { moved: false, reason: string, notOnBoard: boolean }}
 */
export function moveProjectStatus(issueNumber: number, statusName: string,
  { run = defaultRun, log = (line) => process.stderr.write(`${line}\n`), snapshot = withBoardSnapshot }: { run?: typeof defaultRun; log?: (line: string) => void; snapshot?: typeof withBoardSnapshot; } = {}): { moved: true; } | { moved: false; reason: string; notOnBoard: boolean; } {
  const url = `https://github.com/${REPO}/issues/${issueNumber}`;
  try {
    snapshot(() => run("gh", ["project", "item-edit", String(PROJECT_NUMBER), "--owner", PROJECT_OWNER,
      "--url", url, "--field", "Status", "--value", statusName]),
      // #1275: the snapshot covers the one item this edit touches, not the whole board.
      { run, log, excludeIssueNumber: issueNumber, touches: issueNumber });
    return { moved: true };
  } catch (error) {
    const message = (error as Error).message;
    // `gh`'s own wording, observed live against issue #393 (closed, never added to the Project): stable
    // enough to match on because it names the mechanism ("is not an item in project N"), not a paraphrase.
    const notOnBoard = /is not an item in project/.test(message);
    const reason = `could not move #${issueNumber}'s Status to "${statusName}" -- ${message}`;
    log(`row-claim: ${reason}`);
    return { moved: false, reason, notOnBoard };
  }
}

/**
 * WRITE-THEN-VERIFY, not verify-then-write. Shared by `dispatchRow` and `claimRow`, which differ only in
 * whether `started` is among the labels written.
 *
 * Reading labels and THEN writing them leaves the gap between the two open to another session doing the
 * same thing -- and propagation lag is measured, not hypothetical (a bulk board query reported a row
 * `Ready` moments after it was known taken, 2026-09-06). Writing first narrows that window: this session's
 * own write lands as one atomic label-add, and the RE-READ after writing is what would catch a genuine
 * collision in the gap, not the read before it.
 *
 * NOT proven race-free, and that is stated rather than hidden: two `gh issue edit --add-label` calls a
 * few hundred milliseconds apart both succeed (label add is idempotent, not compare-and-swap), so a
 * collision landing inside this function's own write-then-reread window is only DETECTED after the fact,
 * on the re-read -- via `session:*` labels both being present -- never prevented outright. GitHub's REST
 * API has no compare-and-swap primitive for labels to close that window completely; building one (an
 * external lock service, or polling the issue timeline for the event PRECEDING commitment) is
 * disproportionate to a defect that, both times it fired today, was "nobody checked the board at all" --
 * not two sessions racing within the same second. That narrower race is refuted as a target for THIS row;
 * see the commit message for the measurement this claim rests on.
 *
 * Re-adding a label the row already carries (e.g. `claimRow` on a row `dispatchRow` already marked for
 * this same session) is a harmless no-op -- `--add-label` is idempotent -- so this needs no special case
 * for "already dispatched to me, now starting".
 *
 * ALSO REMOVES `ready` IN THE SAME CALL. `dispatchRow`/`claimRow` only ever added labels, so a row still
 * carrying `ready` at the moment it was dispatched came out the other side as `ready` + `in-progress` +
 * `session:*` -- exactly the state `ready-label-audit.mjs` exists to catch (a row cannot be both
 * "unclaimed, pickable" and "claimed"), found on #197's own review after being stripped by hand seventeen
 * times in one evening. `--remove-label` on a label a row does not carry is a harmless no-op, so this needs
 * no branch for "was it ready in the first place".
 *
 * `runner:*` (#444) IS DELIBERATELY NEVER REMOVED HERE -- it survives a claim, unlike `ready`. It records
 * WHO the row was reserved for, and that fact does not stop being true once the reservation is honoured;
 * removing it would lose the record of why a specific session took this row rather than another. A closed
 * row still carrying it is handled separately, as debris (`ready-label-audit.mjs`'s `isClosedDebrisLabel`).
 */

/**
 * B2 (#476) + B4 (#462) + the row's own `blockedBy` edge (#1886), COMPOSED: should `mySession` start a
 * NEW row right now, independent of whether this particular row is claimed by someone else? `null` means
 * proceed; a string is the refusal reason.
 *
 * ALL THREE FAIL OPEN ON A LOOKUP FAILURE, deliberately -- the opposite of `decideClaim`'s own "unclaimed
 * must be EARNED, not defaulted to" rule a few functions up. That rule protects a VERDICT about who holds
 * a row; this protects a session's ability to claim ANYTHING at all when the network is down or `gh` is
 * unauthenticated -- the identical reasoning `merge-guard.mjs`'s `racesAnArmedMerge` states for the same
 * choice made the other way: a convenience guard that blocks all work on a lookup failure gets bypassed
 * and then never consulted again, which is worse than the rare miss it would have caught.
 *
 * #989: THE CHECK-STATE DEPS ARE GONE. B2 used to read the session's own PR colour and this paragraph
 * explained why `requiredContexts`/`checkRuns` were injected separately from `run` -- they reach `gh`
 * through `merge-guard/lookups.mjs`'s own helper, so a fixture injecting `run` alone placed a real network
 * call. B2 now asks whether a ROW is in build and reads no check state at all, so the deps have no
 * subject; callers still passing them are simply ignored, which is why no test had to change for it.
 * #2617: `repo` is the TRACKER the row lives in (default the first), and every read below that is about a ROW -- B2's held rows, the
 * `blockedBy` edge, the Region -- reads it there. B4's pull-request read is NOT that repository's alone: it reads every code
 * repository the project declares (`lookupOpenPrFiles`), and `repo` only tells it whose rows a `Closes` names.
 * @param {number} issueNumber the row about to be claimed -- excluded from B2's "other held rows" check
 * @param {string} mySession
 * @param {{ run?: typeof defaultRun, repo?: string, repos?: readonly { key: string, repo: string }[], adoptedBranch?: string,
 *           }} deps `repos` is the code repositories B4 reads; absent, every one the project declares. `adoptedBranch` (#2769) is
 *   the branch `--adopt` is re-stamping, so the open PR from it is the row's own work under B4 even if it declares `Closes: none`
 * @returns {string | null}
 */
export function sessionEligibilityReason(issueNumber: number, mySession: string, { run = defaultRun, repo = REPO, repos, adoptedBranch }: {
    run?: typeof defaultRun; repo?: string; repos?: readonly { key: string; repo: string; }[]; adoptedBranch?: string;
} = {}): string | null {
  const ghRun = (args: string[]) => run("gh", args);

  // #989: B2 asks whether a ROW is in build, not whether a PR is open. `null` from the lookup is
  // INCONCLUSIVE and returns no refusal, exactly as the PR-shaped version did -- a failed lookup must
  // never invent a block any more than it may invent a clearance.
  const heldRows = lookupHeldRows(mySession, issueNumber, { run: ghRun, repo });
  const inBuild = heldRows === null ? null : inBuildReason(heldRows, Date.now(), { repo });
  if (inBuild) return inBuild;

  // #1886: THE ROW BEING CLAIMED may itself carry an open `blockedBy` edge -- a declared wait GitHub
  // already records, and the gate's own wake computation already reads before ever offering this row.
  // Checked before B4's file-overlap round trip: a row that should not be claimed AT ALL right now needs
  // no comparison against anyone else's open PR. PR #1891 NOT CONVINCED: `writeRowLabels` now also runs
  // this same check unconditionally, before it decides whether this function is even called (see its own
  // comment) -- so on the `!alreadyMine` path that reaches here, this is a second read of a fact already
  // known not to be blocking. Kept here rather than dropped: this function is called directly (#1886's own
  // Open-check), and its own contract -- "is THIS row startable at all right now" -- is not truthfully
  // answered without it.
  const blockedRow = lookupBlockedByEdge(issueNumber, { run: ghRun, repo });
  const blocked = blockedByEdgeReason(blockedRow);
  if (blocked) return blocked;

  const myFiles = lookupMyRegionFiles(issueNumber, { run: ghRun, repo });
  const otherPrFiles = lookupOpenPrFiles({ run: ghRun, trackerRepo: repo, repos });
  if (myFiles !== null && otherPrFiles !== null) {
    // #2101: the row's OWN pull request is not a competitor for its files. Without this number B4
    // refuses a row whose PR was opened before its claim -- against the very work that would finish it.
    const { reason, emptyOtherPrs } = fileOverlapReason(myFiles, otherPrFiles, { rowNumber: issueNumber, adoptedBranch });
    for (const prNumber of emptyOtherPrs) {
      process.stderr.write(`row-claim: ${prLabel(prNumber)} is open and reports ZERO changed files -- not folded `
        + "into \"no overlap\", just nothing to compare against right now. Worth a look if that surprises "
        + "you (B4, #462).\n");
    }
    if (reason) return reason;
  }
  return myFiles === null ? null : claimedRegionsReason(myFiles, { issueNumber, openPrs: otherPrFiles ?? [], run: ghRun, repo });
}

/**
 * #3475: B4's SECOND HALF AT THE CLAIM -- this row's Region against the Regions of the rows already `in-progress`, which hold files from
 * their claim and have no open pull request until their first push. A FAILED READ REFUSES, naming itself INCONCLUSIVE: unlike the
 * pull-request read above, which fails open and always has, this comparison is the only thing standing between two claims and one file
 * for the whole claim-to-first-push window, so "could not read who holds what" must not pass as "nobody does". The gate offers the row
 * again on its next tick, so the cost of a transient failure is one tick. A row whose Region declares no file reads nothing at all.
 *
 * @param {string[]} myFiles this row's Region entries
 * @param {{ issueNumber: number, openPrs: { closes?: number[] | number | null }[], run: (args: string[]) => string, repo: string }} where
 *   `openPrs` is what the pull-request comparison was given, so a claimed row with a pull request is counted once, by its files
 * @returns {string | null}
 */
function claimedRegionsReason(myFiles: string[], { issueNumber, openPrs, run, repo }: { issueNumber: number; openPrs: { closes?: number[] | number | null; }[]; run: (args: string[]) => string; repo: string; }): string | null {
  if (myFiles.length === 0) return null;
  const claimed = lookupClaimedRegions({ run, repo });
  if (claimed === null) return claimedRowsUnread("retry the claim (the gate offers the row again by itself).");
  return claimedRegionsVerdict(myFiles, claimed, { issueNumber, openPrs });
}

/** @param {string} then what happens next, which differs between the claim and `check` @returns {string} */
const claimedRowsUnread = (then: string): string => "B4 COULD NOT BE ASKED which rows are already claimed: that list could not be read, so this row's "
  + `Region cannot be compared with theirs. INCONCLUSIVE, not clear -- ${then}`;

/**
 * #3475: THE VERDICT OVER A READ THAT SUCCEEDED, shared by the claim and `check` so the prediction is the refusal. Two rows that were
 * BOTH dispatched `in-progress` before either claimed would each refuse the other and neither could ever start; so a row that is
 * itself already claimed yields only to the claimed rows with a LOWER number, and the lowest proceeds. A row not yet claimed yields
 * to every one.
 *
 * @param {string[]} myFiles
 * @param {{ number: number, files: string[], blockedBy: number[] }[]} claimed every `in-progress` row with a Region, the asker's included
 * @param {{ issueNumber: number, openPrs: { closes?: number[] | number | null }[] }} where
 * @returns {string | null}
 */
function claimedRegionsVerdict(myFiles: string[], claimed: { number: number; files: string[]; blockedBy: number[]; }[], { issueNumber, openPrs }: { issueNumber: number; openPrs: { closes?: number[] | number | null; }[]; }): string | null {
  const alreadyClaimed = claimed.some((row) => row.number === issueNumber);
  const competitors = alreadyClaimed ? claimed.filter((row) => row.number < issueNumber) : claimed;
  const edges = new Map(claimed.map((row) => [row.number, row.blockedBy]));
  const blockersOf = (n: number) => edges.get(n) ?? null;
  return claimedRegionOverlapReason(myFiles, competitors, { rowNumber: issueNumber, blockersOf, openPrs });
}

/**
 * #741: does `--blocked-by=#N` change an otherwise-refusing `ineligible` verdict into a proceed? Pulled
 * out of `writeRowLabels` to keep that function's own complexity below the lint gate, matching this
 * file's own established pattern (`declineOwnershipReason`, `declineRemoveLabels`) for exactly this
 * reason.
 *
 * This re-runs `lookupOwnPrHealth`/`ownPrHealthReason` itself, rather than reading `sessionEligibilityReason`'s
 * `ineligible` string apart -- that function returns one string for B2, B4 and #1886's `blockedBy`-edge
 * check alike, and the override must never apply to the other two (a file-overlap refusal, or a refusal
 * from the ROW'S OWN `blockedBy` edge, has nothing to do with the claimant's own PR being unhealthy -- see
 * `blocked-by-edge-rule.mjs`'s own header for why that one gets no override at all). The `blockedBy`
 * PARAMETER here is the raw `--blocked-by=#N` FLAG VALUE, unrelated to the row's own GitHub `blockedBy`
 * edge despite the shared name -- one is an override argument a session types, the other is state GitHub
 * records on the issue. A flag value present while the refusal is NOT a B2 one, or absent entirely, is a
 * plain pass-through of `ineligible`.
 *
 * @param {{ issueNumber: number, mySession: string, ineligible: string, blockedBy: string | undefined }} attempt
 * @param {{ ghRun: (args: string[]) => string }} deps
 * @returns {{ proceed: true, blockedByNote: string | null } | { proceed: false, reason: string }}
 */
function eligibilityWithBlockedBy({ issueNumber, mySession, ineligible, blockedBy }: { issueNumber: number; mySession: string; ineligible: string; blockedBy: string | undefined; }, deps: { ghRun: (args: string[]) => string; }): { proceed: true; blockedByNote: string | null; } | { proceed: false; reason: string; } {
  if (!blockedBy) return { proceed: false, reason: ineligible };
  const heldRows = lookupHeldRows(mySession, issueNumber, { run: deps.ghRun });
  const inBuild = heldRows === null ? null : inBuildReason(heldRows);
  if (!inBuild) return { proceed: false, reason: ineligible };
  // #741's OVERRIDE NEEDS AN OPEN PR TO CARRY ITS MEASUREMENT COMMENT, AND A ROW IN BUILD HAS NONE -- that
  // is what "in build" means. So the override cannot fire on a #989 refusal, and `resolveBlockedByOverride`
  // says exactly that ("no open PR of this session's own was found to attach a measurement comment to")
  // rather than being silently skipped. Moving the measurement comment onto the ROW is a separate row; it
  // is a change to what #741 asks for, not a rename.
  const override = resolveBlockedByOverride(null, blockedBy, { run: deps.ghRun });
  if (!override.ok) {
    return { proceed: false,
      reason: `${ineligible} (--blocked-by=${blockedBy} did not apply: ${override.reason})` };
  }
  return { proceed: true, blockedByNote: blockedByExceptionNote(override) };
}

/**
 * #741: posts the exception comment IF an override actually fired -- pulled out purely so the `if` does
 * not add to `writeRowLabels`'s own complexity count (a called function's branches are not the caller's).
 * @param {number} issueNumber
 * @param {string | null} blockedByNote
 * @param {(cmd: string, args: string[]) => string} runFn
 */
function postBlockedByNoteIfAny(issueNumber: number, blockedByNote: string | null, runFn: (cmd: string, args: string[]) => string) {
  if (blockedByNote) {
    runFn("gh", ["issue", "comment", String(issueNumber), "--repo", REPO, "--body", blockedByNote]);
  }
}

/**
 * #987: posts the claim record -- the branch and worktree, in a comment, because neither fits in a label.
 *
 * A claim that names NEITHER posts the #3407 nothing-claim (`Claimed-nothing:`): it has no git object to record, but it
 * still has a time and a claimant, and a claim that wrote no record was skipped by the stall check on every tick, so an
 * abandoned one could never be told from a live one. A RELEASE is spelled "released by" with no field, and the two states
 * must not share a spelling.
 * @param {number} issueNumber
 * @param {{ session: string, branch?: string, worktree?: string }} record
 * @param {(cmd: string, args: string[]) => string} runFn
 */
function postClaimRecord(issueNumber: number, { session, branch, worktree }: { session: string; branch?: string; worktree?: string; }, runFn: (cmd: string, args: string[]) => string) {
  const body = claimRecordComment({ session, branch, worktree, nothing: !branch && !worktree ? NOTHING_REASON : null });
  runFn("gh", ["issue", "comment", String(issueNumber), "--repo", REPO, "--body", body]);
}

/**
 * #987: posts the RELEASE record, superseding whatever the last claim recorded -- pulled out of
 * `declineRow` for the same reason `postBlockedByNoteIfAny` and `declineRemoveLabels` were (a called
 * function's own branches are not the caller's, and `declineRow` sits one step from the complexity gate).
 *
 * Nothing is posted when nothing was recorded: a row that never named a branch or worktree has no record
 * to supersede, and a marker comment on it would be noise a future `claimRecordFrom` then has to read. A
 * #3407 nothing-claim IS a record, and it is superseded like any other: left newest, a later claim that
 * wrote nothing would inherit its time.
 * @param {number} issueNumber
 * @param {{ session: string, recorded: { branch: string | null, worktree: string | null, nothing?: true } }} release
 * @param {(cmd: string, args: string[]) => string} runFn
 */
function postReleaseRecord(issueNumber: number, { session, recorded }: { session: string; recorded: { branch: string | null; worktree: string | null; nothing?: true; }; }, runFn: (cmd: string, args: string[]) => string) {
  if (!recorded.branch && !recorded.worktree && !recorded.nothing) return;
  runFn("gh", ["issue", "comment", String(issueNumber), "--repo", REPO, "--body",
    claimRecordComment({ session, released: true })]);
}

/**
 * #1399: THE EXIT CODE FOR A COMMAND THAT WROTE, THEN FAILED. Distinct from 0 (clean), 1 (refused, nothing
 * written), 2 (`COULD NOT DETERMINE`: nothing known to be written) and 3 (claimed, but the Status view could
 * not follow). Measured on #1399 at `326c9b71`: `claim` wrote four label definitions, added its labels and
 * removed `ready`, then its verify read failed on an exhausted GraphQL pool -- and printed `COULD NOT
 * DETERMINE`, exit 2, with nothing on stdout, so the caller read a claimed row as untouched. `decline` did the
 * same after removing the worktree and the labels, when its release record failed.
 */
export const LANDED_WRITE_EXIT = 4;

/**
 * #1399: runs `act`, which pushes a description onto `landed` after each write it KNOWS succeeded. A failure
 * after at least one is re-thrown carrying that list, so the CLI reports what the row now holds rather than
 * `COULD NOT DETERMINE`. A failure before any write propagates unchanged -- that is still "nothing written".
 * @template T
 * @param {number} issueNumber
 * @param {string[]} landed
 * @param {() => T} act
 * @returns {T}
 */
export function withLandedWrites<T>(issueNumber: number, landed: string[], act: () => T): T {
  try {
    return act();
  } catch (cause) {
    if (landed.length === 0) throw cause;
    throw Object.assign(new Error(`row-claim: #${issueNumber} WAS WRITTEN before a later step failed -- `
      + `landed: ${landed.join("; ")}. The step that failed: ${(cause as Error).message}`, { cause }),
    { landed: [...landed] });
  }
}

/**
 * The writes a `withLandedWrites` failure carries, or `null` for an error that landed nothing.
 * @param {unknown} error
 * @returns {string[] | null}
 */
export function landedWritesOf(error: unknown): string[] | null {
  const landed = (error as { landed?: unknown } | null)?.landed;
  return Array.isArray(landed) ? landed : null;
}

/**
 * What a `claim`/`dispatch`/`decline` CLI prints, and exits with, for a thrown error -- one function so the
 * three catches cannot drift apart. Pure.
 * @param {unknown} error
 * @returns {{ exitCode: number, text: string }}
 */
export function failureReport(error: unknown): { exitCode: number; text: string; } {
  const message = (error as Error).message;
  if (landedWritesOf(error) === null) return { exitCode: 2, text: `COULD NOT DETERMINE: ${message}` };
  return { exitCode: LANDED_WRITE_EXIT, text: `PARTIALLY WRITTEN (exit ${LANDED_WRITE_EXIT}, NOT "could not determine" `
    + `-- the row has changed): ${message}. Read the row by REST before retrying or editing it by hand.` };
}

/**
 * #2151: THE WHOLE LABEL LIST a claim leaves the row carrying, computed from `labels` as read immediately
 * before the write: everything it already holds stays, `ready` goes, and each of `add` joins unless the
 * row has it. Pure.
 *
 * KEEPING what is there is what makes the `dispatched -> started` resume safe as a SET: the row already
 * holds `in-progress`, `session:<me>` and `was-ready` (its `ready` went at the dispatch), so they are
 * passed through rather than re-added, and a `was-ready` marker the resume would not recompute survives.
 * @param {readonly string[]} labels
 * @param {readonly string[]} add
 * @returns {string[]}
 */
export function labelSetForClaim(labels: readonly string[], add: readonly string[]): string[] {
  const kept = labels.filter((l) => l !== READY_LABEL);
  return [...kept, ...add.filter((l) => !kept.includes(l))];
}

/**
 * #2151: `PUT /repos/<repo>/issues/<n>/labels` -- GitHub's "Set labels for an issue" -- as `gh api`
 * arguments: the whole list in ONE request, so there is no add half and no remove half to come apart.
 * `row-file.mjs`'s `labelSetArgs` builds the identical request for the promote act (#2111) and cannot be
 * imported from here (it imports this module and runs an act on load); it is outside this row's Region, so
 * folding the two into one function is left to whoever next touches that file.
 * @param {number} issueNumber
 * @param {readonly string[]} labels
 * @returns {string[]}
 */
export function claimLabelSetArgs(issueNumber: number, labels: readonly string[]): string[] {
  return ["api", "--method", "PUT", `repos/${REPO}/issues/${issueNumber}/labels`,
    ...labels.flatMap((label) => ["-f", `labels[]=${label}`])];
}

/**
 * #749, then #2151: writes the claim's labels, split from `writeRowLabels` for the same reason
 * `postBlockedByNoteIfAny` above is (a called function's own lines are not the caller's).
 *
 * THE WRITE IS ONE `PUT`, NOT AN ADD FOLLOWED BY A REMOVAL. #749 split the two because #677 measured one
 * `gh issue edit` half-applying (its `--remove-label ready` landed while every `--add-label` did not), and
 * ordering the removal last kept a failure recoverable -- but it left a window in which the row carried
 * `ready` beside `in-progress`, PERMANENTLY if the second call never ran, which `ready-label-audit`'s
 * `handClaims` reads as a claim made outside this mechanism. A set replacement has no window: the row's
 * labels are exactly the list below or, if the request failed, untouched.
 *
 * WHAT A SET COSTS THAT A DELTA DID NOT, and the answer: it carries every OTHER label the row holds, so a
 * label added by somebody else between the read it was computed from and the write is ERASED, not merely
 * outraced -- and when that label is ANOTHER SESSION'S CLAIM it would erase the very record the after-the-fact
 * race check below needs to find. So the list is computed from a read taken HERE, one request before the
 * write and not the several lookups earlier that `writeRowLabels` read `before` at, and a claim by anyone
 * else in that fresh read is REFUSED rather than written over. GitHub offers no compare-and-set on labels,
 * so the window narrows and never closes; what remains is the `completeClaim` re-read, unchanged, which
 * still backs off a claim that lost a race in it. A resume is answered by `decideClaim`, which proceeds on
 * this session's own claim, and by {@link labelSetForClaim}, which keeps what it holds.
 *
 * The label must EXIST before it is named (see `ensureLabelsExist`'s own header), and that too happens
 * before the read, so the read stays as close to the write as it can.
 *
 * #987: NO `branch:`/`worktree:` LABEL IS BUILT HERE ANY MORE -- see `CLAIM_RECORD_MARKER`'s own header
 * for why (GitHub's 50-character label-name cap made the documented `--worktree=<path>` usage impossible
 * for any path outside `/private/tmp`). The two facts are written as a claim COMMENT instead, by
 * `writeRowLabels` after it knows it won the race.
 * @param {number} issueNumber
 * @param {{ run: typeof defaultRun, mySession: string, extraLabels: string[], landed: string[], labelBatch?: typeof runBatch }} args
 *   `landed` gains the write once it has succeeded (#1399)
 * @returns {{ refusal: string | null }} a refusal means NOTHING was written
 */
function applyClaimLabels(issueNumber: number, { run, mySession, extraLabels, landed, labelBatch }: { run: typeof defaultRun; mySession: string; extraLabels: string[]; landed: string[]; labelBatch?: typeof runBatch; }): { refusal: string | null; } {
  const claimLabels = [CLAIM_LABEL, `${SESSION_PREFIX}${mySession}`, ...extraLabels];
  ensureLabelsExist([...claimLabels, WAS_READY_LABEL], { run, batch: labelBatch });
  const fresh = fetchLabels(issueNumber, { run });
  const decision = decideClaim(fresh.labels, mySession);
  if (!decision.proceed) {
    return { refusal: `${decision.reason} -- as read immediately before the label write, which a claim that `
      + "landed since the first read would otherwise have been erased by. Nothing was written." };
  }
  // #449: `ready` is seen ONLY here, so the marker `declineRow` restores it from is decided here, on the
  // read the write is computed from. A resume finds `ready` already gone and adds nothing.
  const wasReady = fresh.labels.includes(READY_LABEL);
  const labels = labelSetForClaim(fresh.labels, wasReady ? [...claimLabels, WAS_READY_LABEL] : claimLabels);
  run("gh", claimLabelSetArgs(issueNumber, labels));
  landed.push(`set the row's labels to ${labels.join(", ")} (\`${READY_LABEL}\` removed in the same write)`);
  return { refusal: null };
}

/**
 * RULE: IS THE ASKING SESSION A PERSISTENT SEAT? -- #3415. A persistent seat is a conversation, not an engineer, so it is
 * refused EVERY claim, resumed or new (it can hold none to resume). The router's half is `engineerEligibility`, which never
 * offers it a row; **the offer alone is not the limit, the claim is the other half** -- a seat told to claim by hand goes
 * around any router. THE FACT IS INJECTED, as `drained` is: {@link persistentNow} reads it at the CLI.
 * @param {string} mySession @param {boolean} persistent
 * @returns {string | null} a refusal reason, or null if `mySession` may claim
 */
export function persistentReason(mySession: string, persistent: boolean): string | null {
  if (!persistent) return null;
  return `${mySession} is a PERSISTENT seat (\`"persistent": true\` in the roster's sessions.json, #3415): a standing conversation `
    + "that is never cleared and is never offered a row or a work order. It claims no row; ask `product-manager` to route the "
    + "work to an engineer.";
}

/**
 * (#3566, slice 4) EVERYTHING A CLAIM CHECKS BEFORE IT WRITES -- the template fields, the row's own `blockedBy` edge and, for a new row, B2/B4 -- moved
 * out of `writeRowLabels` unchanged so it can be run twice by `readWithFirstWaveTogether`: once as a rehearsal against empty answers, to see which reads
 * it makes first, and once against the real ones. IT WRITES NOTHING AND SAYS NOTHING on the rehearsal (every answer is empty, so no pull request is
 * listed to be reported), which is what makes the second run safe. `preWrite` is the claim's read-once `run`.
 * @param {{ issueNumber: number, mySession: string, before: { labels: string[] }, drained: readonly string[],
 *           instance: { spare: boolean, rows: readonly number[] }, adoptedBranch?: string, blockedBy?: string }} claim
 * @param {typeof defaultRun} preWrite
 * @returns {{ refusal: { claimed: false, reason: string } | null, blockedByNote: Parameters<typeof postBlockedByNoteIfAny>[1] }}
 */
function preWriteChecks({ issueNumber, mySession, before, drained, instance, adoptedBranch, blockedBy }: {
        issueNumber: number; mySession: string; before: { labels: string[]; }; drained: readonly string[];
        instance: { spare: boolean; rows: readonly number[]; }; adoptedBranch?: string; blockedBy?: string;
    }, preWrite: typeof defaultRun): { refusal: { claimed: false; reason: string; } | null; blockedByNote: Parameters<typeof postBlockedByNoteIfAny>[1]; } {
  // #707: THE TEMPLATE FIELDS, checked on EVERY claim attempt -- unlike the session-eligibility block
  // below, this is a property of the ROW, not of who is claiming it or when they last touched it, so it
  // is not skipped on a resumed (`alreadyMine`) claim: a row dispatched before this check shipped, or by
  // a hand-claim (#673) that bypassed row-claim entirely, must still be caught the first time row-claim
  // itself acts on it, which may well be a "resume".
  const ghRunForBody = (args: string[]) => preWrite("gh", args);
  const body = lookupIssueBody(issueNumber, { run: ghRunForBody });
  if (body !== null) {
    const templateReason = templateFieldsReason(body, issueNumber);
    if (templateReason) return { refusal: { claimed: false, reason: templateReason }, blockedByNote: null };
  }

  // #1886, PR #1891 NOT CONVINCED (reviewer, 576a678b): THE ROW'S OWN `blockedBy` EDGE, checked on EVERY
  // claim attempt -- same reasoning as the template-fields check just above, and for the same reason: it
  // is a property of the ROW, not of who is claiming it or when. The first fix put this check inside
  // `sessionEligibilityReason` and called it only from the `!alreadyMine` branch below, which meant a
  // row already dispatched to this session (the `dispatched -> started` resume) never saw it at all --
  // reviewer reproduced this directly against #1883's open edge: `claimRow` still returned `claimed: true`
  // with zero `blockedBy` reads. `sessionEligibilityReason` keeps its own copy of this check below, for
  // its non-resumed B2/B4 bundle and for any caller (such as #1886's own Open-check) that reads it
  // directly -- this one is what makes the row-owned property actually hold on every attempt, resumed or
  // not.
  const blockedRow = lookupBlockedByEdge(issueNumber, { run: ghRunForBody });
  const blockedReason = blockedByEdgeReason(blockedRow);
  if (blockedReason) return { refusal: { claimed: false, reason: blockedReason }, blockedByNote: null };

  // B2 (#476) + B4 (#462): SESSION ELIGIBILITY, not row ownership -- `decideClaim` above already answered
  // "is this row somebody else's"; these ask "should THIS session start ANY new row right now", which is
  // why they are skipped entirely when resuming a row this session already holds (the `dispatched ->
  // started` transition is not a NEW front, and re-running these lookups on every resume would be pure
  // cost for a question already answered the first time this row was claimed). The row-owned `blockedBy`
  // check above is not part of this bundle any more precisely because it is NOT a session-eligibility
  // question -- see the comment just above it.
  const alreadyMine = claimStatus(before.labels).sessions.includes(mySession);
  let blockedByNote = null;
  if (!alreadyMine) {
    // #2324: A NEW ROW, which is the only kind a drained role is refused -- resuming its own is not one.
    const drain = drainReason(mySession, drained);
    if (drain) return { refusal: { claimed: false, reason: drain }, blockedByNote: null };
    // #2407: ONE INSTANCE, ONE ROW -- the same "new row only" placement, for a spare that holds or has held another.
    const oneRow = oneRowReason(mySession, issueNumber, instance);
    if (oneRow) return { refusal: { claimed: false, reason: oneRow }, blockedByNote: null };
    const ineligible = sessionEligibilityReason(issueNumber, mySession, { run: preWrite, adoptedBranch });
    if (ineligible) {
      const eligibility = eligibilityWithBlockedBy({ issueNumber, mySession, ineligible, blockedBy },
        { ghRun: ghRunForBody });
      if (!eligibility.proceed) return { refusal: { claimed: false, reason: eligibility.reason }, blockedByNote: null };
      blockedByNote = eligibility.blockedByNote;
    }
  }
  return { refusal: null, blockedByNote };
}

/**
 * @param {number} issueNumber
 * @param {string} mySession
 * @param {string[]} extraLabels labels written alongside `in-progress` + `session:<name>` -- `[]` for a
 *   dispatch, `[STARTED_LABEL]` for a claim/start
 * @param {{ run?: typeof defaultRun, moveStatus?: typeof moveProjectStatus, branch?: string,
 *           worktree?: string, blockedBy?: string, drained?: readonly string[],
 *           instance?: { spare: boolean, rows: readonly number[] }, adoptedBranch?: string, persistent?: boolean,
 *           batch?: typeof runBatch, labelBatch?: typeof runBatch }} deps
 *   `labelBatch` (#3566, slice 9) asks the four label creates BEFORE the claiming write together, with the same default as `batch`; the write itself and
 *   its reads either side stay one at a time. `batch` (#3566, slice 4) answers the pre-write reads together: absent, it is the real batch ONLY when `run` is the real `gh` -- a test's `run`
 *   stands for `gh` and sees its calls one at a time. `persistent` (#3415) is whether the roster marks the asking session a persistent seat -- see {@link persistentNow};
 *   absent is not one. `drained` (#2324) is the roles the drain holds back now -- see {@link drainedNow}. ABSENT MEANS NONE, so a
 *   caller that does not say is not refused for a fact it never asked about; the CLI is what asks. `instance`
 *   (#2407) is what the asking session's instance holds or has held -- see {@link instanceNow}, and the same
 *   convention: absent is a standing engineer with no rows.
 * @returns {{ claimed: true, statusMoved: true } | { claimed: true, statusMoved: false, notOnBoard: boolean, statusReason: string } | { claimed: false, reason: string }}
 */
function writeRowLabels(issueNumber: number, mySession: string, extraLabels: string[],
  { run = defaultRun, moveStatus = moveProjectStatus, branch, worktree, blockedBy, drained = [],
    instance = { spare: false, rows: [] }, adoptedBranch, persistent = false,
    batch = run === defaultRun ? runBatch : undefined,
    labelBatch = run === defaultRun ? runBatch : undefined }: {
          run?: typeof defaultRun; moveStatus?: typeof moveProjectStatus; branch?: string;
          worktree?: string; blockedBy?: string; drained?: readonly string[];
          instance?: { spare: boolean; rows: readonly number[]; }; adoptedBranch?: string; persistent?: boolean;
          batch?: typeof runBatch; labelBatch?: typeof runBatch;
      } = {}): { claimed: true; statusMoved: true; } | { claimed: true; statusMoved: false; notOnBoard: boolean; statusReason: string; } | { claimed: false; reason: string; } {
  const before = fetchLabels(issueNumber, { run });
  const decision = decideClaim(before.labels, mySession);
  if (!decision.proceed) return { claimed: false, reason: decision.reason };
  const notEngineer = persistentReason(mySession, persistent);
  if (notEngineer) return { claimed: false, reason: notEngineer };

  // #3566, slice 4: THE CHECKS BELOW ONLY READ, so the reads they can be seen to make FIRST go out together (`readWithFirstWaveTogether`, the gate's
  // seam): the claim waited for the SUM of a dozen `gh` round trips, and now waits for the slowest. The commands, their parsing and every verdict are
  // the checks' own; a read the rehearsal could not foresee (the claimed rows' Regions wait for a Region that names a file) runs on its own as before.
  // NOTHING FROM THE FIRST WRITE ON IS PART OF THIS: the labels above and the labels `applyClaimLabels` reads again stay fresh and sequential.
  const checked = readWithFirstWaveTogether(
    (together) => preWriteChecks({ issueNumber, mySession, before, drained, instance, adoptedBranch, blockedBy },
      readsOnce((cmd, args) => {
        if (cmd !== "gh") return run(cmd, args);
        assertNoLeakInArgv(cmd, args); // #1053: the batch is a spawn of its own, so the guard `defaultRun` carries is asked here as well
        return together(args);
      })),
    (args) => run("gh", args), batch);
  if (checked.refusal) return checked.refusal;
  const { blockedByNote } = checked;

  const sessionLabel = `${SESSION_PREFIX}${mySession}`;
  const landed: string[] = [];
  // #1399: FROM THE FIRST WRITE ON, A FAILURE IS A PARTIAL WRITE, never `COULD NOT DETERMINE` -- see
  // `LANDED_WRITE_EXIT`. The checks above wrote nothing, so a throw from them still propagates as it did.
  return withLandedWrites(issueNumber, landed, () => {
    const { refusal } = applyClaimLabels(issueNumber, { run, mySession, extraLabels, landed, labelBatch });
    if (refusal) return { claimed: false, reason: refusal };
    return completeClaim(issueNumber,
      { run, moveStatus, mySession, sessionLabel, extraLabels, blockedByNote, branch, worktree, landed });
  });
}

/**
 * #1399: the claim after its labels landed -- the verify, the race back-off, the records and the Status move --
 * split from `writeRowLabels` so every write here is recorded in `landed` as it succeeds.
 * @param {number} issueNumber
 * @param {{ run: typeof defaultRun, moveStatus: typeof moveProjectStatus, mySession: string, sessionLabel: string,
 *   extraLabels: string[], blockedByNote: Parameters<typeof postBlockedByNoteIfAny>[1], branch?: string,
 *   worktree?: string, landed: string[] }} state
 * @returns {{ claimed: true, statusMoved: true } | { claimed: true, statusMoved: false, notOnBoard: boolean, statusReason: string } | { claimed: false, reason: string }}
 */
function completeClaim(issueNumber: number,
  { run, moveStatus, mySession, sessionLabel, extraLabels, blockedByNote, branch, worktree, landed }: {
      run: typeof defaultRun; moveStatus: typeof moveProjectStatus; mySession: string; sessionLabel: string;
      extraLabels: string[]; blockedByNote: Parameters<typeof postBlockedByNoteIfAny>[1]; branch?: string;
      worktree?: string; landed: string[];
  }): { claimed: true; statusMoved: true; } | { claimed: true; statusMoved: false; notOnBoard: boolean; statusReason: string; } | { claimed: false; reason: string; } {
  const after = fetchLabels(issueNumber, { run });
  const afterStatus = claimStatus(after.labels);
  const otherSessions = afterStatus.sessions.filter((s) => s !== mySession);
  if (otherSessions.length > 0) {
    // LOST THE RACE, DETECTED AFTER THE FACT: back off rather than leave a contested claim standing.
    // Removing only OUR OWN session label and any of our extras, never `in-progress` (which the other
    // session's claim needs) and never the other session's label (not ours to touch).
    //
    // #987: there is no branch/worktree label to take back any more, and nothing to retract in the thread
    // either -- the claim-record comment is posted BELOW this block, so a claim that lost the race never
    // wrote one. That ordering is the same reason #741's exception note sits where it does.
    run("gh", ["issue", "edit", String(issueNumber), "--repo", REPO,
      ...[sessionLabel, ...extraLabels].flatMap((l) => ["--remove-label", l])]);
    landed.push(`backed off: removed labels ${[sessionLabel, ...extraLabels].join(", ")}`);
    return { claimed: false, reason: `lost a race to ${otherSessions.join(", ")} -- backed off` };
  }
  // #741: THE EXCEPTION GOES ON THE RECORD, in the same act that wins the claim -- never on a race we
  // then lost (the block above already returned), so a losing session's attempted override leaves no
  // comment behind naming an exception it never actually exercised.
  postBlockedByNoteIfAny(issueNumber, blockedByNote, run);
  if (blockedByNote) landed.push("posted the --blocked-by exception note");
  // #987: THE BRANCH AND WORKTREE GO ON THE RECORD HERE, for the identical reason #741's note above does
  // -- after the race is known to be won, so a losing session never leaves a record naming a worktree it
  // did not get to keep. `branch`/`worktree` are the values this claim was GIVEN, not values read back:
  // there is nothing to read back yet, and the comment IS the record.
  postClaimRecord(issueNumber, { session: mySession, branch, worktree }, run);
  landed.push(`posted the claim record (branch ${branch ?? "none"}, worktree ${worktree ?? "none"})`);
  // #400: THE LABEL IS THE RECORD; THIS MOVES THE VIEW TO MATCH IT, IN THE SAME ACT. A view corrected only
  // by a later sweep is wrong between sweeps, and "between sweeps" is where a worker reads it -- measured
  // live, a row read `unlabeled ready / labeled in-progress` for the three minutes between a real claim and
  // the next audit pass. `moveStatus` never throws (see its own comment); a claim this session actually
  // holds must complete regardless of whether the Project view could be updated to match -- but a genuine,
  // unexpected Status-write failure (as opposed to the row simply not being on the board) is a HALF-APPLIED
  // claim, per ceo's ruling, and must be visible to the caller rather than folded into a plain success.
  const statusResult = moveStatus(issueNumber, "In progress", { run });
  if (statusResult.moved) return { claimed: true, statusMoved: true };
  return { claimed: true, statusMoved: false, notOnBoard: statusResult.notOnBoard, statusReason: statusResult.reason };
}

/**
 * Print whether the row can be STARTED today, alongside whether it is claimed (#177).
 *
 * A SEPARATE PROCESS on purpose. `row-reachability.mjs` walks every remote ref and shells `git` dozens of
 * times; importing it would make every `check` pay that even when the answer is not wanted, and a slow
 * claim tool is one people stop running before claiming -- which is the defect `row-claim` exists for.
 *
 * ITS FAILURE IS NOT THIS COMMAND'S FAILURE. If reachability cannot be computed, the claim answer above
 * is still correct and is what the caller asked for; swallowing the reachability error here keeps
 * "I could not tell you whether it is startable" from reading as "I could not tell you whether it is
 * claimed". The exit code is set before this runs and is never touched by it.
 *
 * RETURNS the verdict (#226), rather than only printing it, so the caller can log the exact same answer
 * it showed the worker -- `code: null` for the one case not even the subprocess's own exit code can name
 * (the spawn itself failing, e.g. `node` missing), kept distinct from `row-reachability.mjs`'s own real
 * `CANNOT_ASK` (2), which IS a code and is logged as one.
 *
 * @param {number} issueNumber
 * @returns {{ code: number | null, output: string }}
 *
 * @param {number} issueNumber
 */
function reportReachability(issueNumber: number): { code: number | null; output: string; } {
  try {
    // `fileURLToPath`, NOT `.pathname` -- a URL's pathname is percent-ENCODED, so a checkout under a
    // path containing a space becomes `%20` and node cannot find the file. This repo already records that
    // exact defect for entry-point guards built by string concatenation; it is the same trap read from
    // the other end.
    const out = execFileSync("node",
      [fileURLToPath(new URL("row-reachability.mjs", import.meta.url)), String(issueNumber)],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    process.stdout.write(out);
    return { code: 0, output: out };
  } catch (error) {
    const spawned = (error as {stdout?: string, stderr?: string, status?: number});
    const output = `${spawned.stdout ?? ""}${spawned.stderr ?? ""}`;
    process.stdout.write(output);
    return { code: typeof spawned.status === "number" ? spawned.status : null, output };
  }
}

/**
 * DISPATCH: mark a row taken the moment it is handed to a session, before that session has done anything.
 * This is the fix for #176 -- called by `dispatcher`/`product-manager` in the same action as assigning a
 * row in a message, so a second dispatch in the same window sees this one on the board rather than
 * reading unclaimed. Writes `in-progress` + `session:<name>` only; `started` is NOT set, which is what
 * makes `check`/`status` able to report "dispatched but not started" rather than collapsing it into
 * "started".
 *
 * @param {number} issueNumber
 * @param {string} mySession
 * @param {{ run?: typeof defaultRun, moveStatus?: typeof moveProjectStatus }} [deps]
 */
export function dispatchRow(issueNumber: number, mySession: string, deps: { run?: typeof defaultRun; moveStatus?: typeof moveProjectStatus; } = {}) {
  return writeRowLabels(issueNumber, mySession, [], deps);
}

/**
 * CLAIM / START: mark a row as actually being worked. Used two ways -- a worker self-pulling a row with
 * no prior dispatch goes straight from unclaimed to started; a worker beginning a row `dispatchRow`
 * already marked for it goes from dispatched to started, re-adding the same `in-progress`/`session:*`
 * labels harmlessly and adding `started`.
 *
 * `branch` (#656) and `worktree` (#665) are OPTIONAL, deliberately -- not every claimed row changes code
 * (a doc row, a filing task) and neither may exist at the moment `started` is written even for one that
 * does. Passed once here, at the point a worker actually knows its own worktree's path and branch name.
 *
 * `blockedBy` (#741) is the raw `--blocked-by=#N` flag value -- releases B2 ONLY, and only when the
 * claimant's own open PR already carries a qualifying measurement comment and `#N` is confirmed open;
 * see `blocked-by-rule.mjs`. Absent, B2 behaves exactly as it always has.
 *
 * @param {number} issueNumber
 * @param {string} mySession
 * @param {{ run?: typeof defaultRun, moveStatus?: typeof moveProjectStatus, branch?: string,
 *           worktree?: string, blockedBy?: string, drained?: readonly string[],
 *           instance?: { spare: boolean, rows: readonly number[] }, adoptedBranch?: string, persistent?: boolean }} [deps]
 * `adoptedBranch` (#2769) is set by `--adopt` alone: the branch of the tree it resumes, whose open PR is the row's own work for B4.
 * @returns {{ claimed: true, statusMoved: true } | { claimed: true, statusMoved: false, notOnBoard: boolean, statusReason: string } | { claimed: false, reason: string }}
 */
export function claimRow(issueNumber: number, mySession: string, deps: {
    run?: typeof defaultRun; moveStatus?: typeof moveProjectStatus; branch?: string;
    worktree?: string; blockedBy?: string; drained?: readonly string[];
    instance?: { spare: boolean; rows: readonly number[]; }; adoptedBranch?: string; persistent?: boolean;
} = {}): { claimed: true; statusMoved: true; } | { claimed: true; statusMoved: false; notOnBoard: boolean; statusReason: string; } | { claimed: false; reason: string; } {
  return writeRowLabels(issueNumber, mySession, [STARTED_LABEL], deps);
}

// --- #2617 (child 3b of #69): WHICH TRACKER A ROW IS IN, AND WHAT A NAME IS WHEN TWO TRACKERS BOTH HAVE A ROW 7 -----------------
//
// A project declares its trackers in `.agent-org/project.json` and each carries a KEY; the empty key is the primary project's first
// tracker, so every name, ledger line and label that exists today keeps its meaning (ADR 0040, decision 2). `--tracker=<key>` says which
// tracker a row number is in, and absent it is the empty key: a command written before this row is the same command.
//
// A NAME IS `<role>-<key>-<n>` FOR A NON-EMPTY KEY AND `<role>-<n>` FOR THE EMPTY ONE, which is what keeps `worker-7` and
// `worker-agent-org-7` two sessions and `../wt-7` and `../wt-agent-org-7` two directories. `claimNames` is that grammar in ONE place.
//
// WHAT A CLAIM IN ANOTHER TRACKER CAN DO TODAY: `check` reads it in full. A `claim`, `dispatch`, `decline` or `conflict` there is REFUSED
// BEFORE ANY WRITE, and says why: they write the row's labels and move its card on the Project board, and the tool's labels are #2619's
// (3d) and its board snapshot is bound to the first tracker's board (`board-snapshot-scope.mjs`), so a write would land on the wrong
// board or half-apply. A refusal that names its owner is the honest edge of this row, not a claim that the write is handled.

export type Tracker = { key: string, repo: string, board: { owner: string, number: number } };

/**
 * The tracker a key names, or a refusal that lists what IS declared -- never a fallback to the first, which is how a row number in the
 * wrong repository would be read as the right one without an error.
 * @param {string} key
 * @param {{ tracker: readonly Tracker[] }} [declaration] the project's declaration; defaults to this checkout's
 * @returns {{ ok: true, tracker: Tracker } | { ok: false, reason: string }}
 */
export function trackerFor(key: string, declaration: { tracker: readonly Tracker[]; } = homeProjectDeclaration()): { ok: true; tracker: Tracker; } | { ok: false; reason: string; } {
  const found = declaration.tracker.find((tracker) => tracker.key === key);
  if (found) return { ok: true, tracker: found };
  const declared = declaration.tracker.map((tracker) => (tracker.key === "" ? "the empty key" : `\`${tracker.key}\``)).join(", ");
  return { ok: false, reason: `no tracker with key \`${key}\` is declared in ${PROJECT_DECLARATION_PATH} (declared: ${declared}); `
    + "nothing is defaulted to another tracker's row of the same number" };
}

/**
 * The worktree directory name and the spawned session name for row `number` of the tracker `key` (decision 2's grammar):
 * `wt-<n>` and `worker-<n>` for the empty key, byte for byte what the tool has always used, and `wt-<key>-<n>` and `worker-<key>-<n>` otherwise.
 * @param {{ key: string, number: number }} row
 * @returns {{ worktree: string, session: string }}
 */
export function claimNames({ key, number }: { key: string; number: number; }): { worktree: string; session: string; } {
  const qualified = key === "" ? "" : `${key}-`;
  return { worktree: `wt-${qualified}${number}`, session: `worker-${qualified}${number}` };
}

/**
 * Pure: is a claim in tracker `key` named the way decision 2 says, and may it write at all? `null` for the empty key -- every claim
 * written before this row -- and otherwise the FIRST thing wrong, in the order a person fixes them: an undeclared key, a worktree
 * whose directory name would be shared with the same-numbered row of another tracker, a session named as though it held that row in
 * the first tracker, and last the edge above.
 *
 * ONLY THE ONE COLLIDING SESSION SHAPE IS REFUSED (`worker-<n>` for a row that is not the first tracker's): a standing seat is named by
 * its seat (`worker-5`) and claims whatever row it is handed, so the rule is that the row's number is never the only thing telling two
 * trackers' workers apart -- not that every session must spell its tracker.
 * @param {{ mode: "dispatch" | "claim" | "decline" | "conflict", key: string, number: number, session?: string, worktree?: string }} claim
 * @param {{ tracker: readonly Tracker[] }} [declaration]
 * @returns {string | null}
 */
export function trackerClaimRefusal({ mode, key, number, session, worktree }: { mode: "dispatch" | "claim" | "decline" | "conflict"; key: string; number: number; session?: string; worktree?: string; }, declaration: { tracker: readonly Tracker[]; } = homeProjectDeclaration()): string | null {
  if (key === "") return null;
  const found = trackerFor(key, declaration);
  if (!found.ok) return found.reason;
  const names = claimNames({ key, number });
  if (worktree !== undefined && basename(worktree.replace(/\/+$/, "")) !== names.worktree) {
    return `a claim in tracker \`${key}\` names its worktree \`${names.worktree}\`, not \`${worktree}\`: \`wt-${number}\` is the FIRST tracker's row ${number}'s directory, `
      + "and two trackers both have a row of that number (ADR 0040, decision 2)";
  }
  if (session === claimNames({ key: "", number }).session) {
    return `\`${session}\` is the name of the session that holds the FIRST tracker's row ${number}; a worker on tracker \`${key}\`'s row ${number} is `
      + `\`${names.session}\` (ADR 0040, decision 2), or its \`${SESSION_PREFIX}\` label would name two rows`;
  }
  return `\`${mode}\` in tracker \`${key}\` writes the row's labels and moves its card on the Project board, and neither is built for a second `
    + "tracker yet: the labels are the label row's (#2619, 3d) and the board snapshot is bound to the first tracker's board. "
    + `\`check --tracker=${key}\` reads the row in full. Nothing was written.`;
}

// --- #1432: `claim` OWNS THE WORKTREE --------------------------------------------------------------------------------
//
// Twice on 2026-09-13 a hand-written claim chain continued after `git worktree add` FAILED on a path or branch a peer
// had already created, and acted INSIDE the peer's worktree (wt-1408 at 20:49Z, wt-1398 about 21:00Z). `claim` only
// RECORDED the branch and worktree it was given; it never created or checked them, so the chain that did was typed by
// hand in every session, and a failed step left the next command running wherever the failure left it.
//
// So given `--branch` and `--worktree`, `claim` refuses before ANY write when the path or the branch already exists --
// naming the owner where one is recorded -- and otherwise creates the worktree itself, stamps it, then claims.
//
// WORKER-JUDGE'S QUESTION, DECIDED: `claim` does NOT refuse when its cwd's branch differs from `--branch`. The worktree
// is now created at `--worktree` by `claim` itself, so where `claim` runs no longer decides where the work lands; and
// the normal recipe runs `claim` from the session's PREVIOUS worktree, whose branch is by definition a different one,
// so that refusal would refuse every correct claim. The incident's danger was a chain acting in a tree it did not
// create, and a claim that creates its own tree closes that.

/**
 * #1432: Pure: a claim given ONE of `--branch`/`--worktree` is refused -- `claim` creates the worktree from both, and
 * recording one without the other is the half-claim the hand-written chain used to leave.
 * #2470: and `--adopt=<session>` is refused without both, since it names the tree it claims in place.
 * @param {{ branch?: string, worktree?: string, adopt?: string }} flags
 * @returns {string | null}
 */
export function worktreeFlagsReason({ branch, worktree, adopt }: { branch?: string; worktree?: string; adopt?: string; }): string | null {
  if (adopt !== undefined && !(branch && worktree)) {
    return "--adopt needs --branch and --worktree (#2470): it claims THAT tree, in place, on THAT branch.";
  }
  if (Boolean(branch) === Boolean(worktree)) return null;
  return "--branch and --worktree go together (#1432): `claim` creates the worktree at --worktree on the new branch "
    + "--branch, from origin/main. Give both, or neither for a row that changes no code.";
}

/** @param {unknown} error @returns {number | null} */
function exitStatusOf(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

/**
 * `git` answered "no such ref" (`absentStatus`) -> false; a zero exit -> true; ANY other failure throws, because
 * "could not ask" is not "absent", and creating a branch on a guess is how the incident started.
 * @param {string[]} args @param {number} absentStatus @param {string} what @param {typeof defaultRun} run
 * @returns {boolean}
 */
function gitRefExists(args: string[], absentStatus: number, what: string, run: typeof defaultRun): boolean {
  try {
    run("git", args);
    return true;
  } catch (cause) {
    if (exitStatusOf(cause) === absentStatus) return false;
    throw new Error(`row-claim: could not ask git whether ${what} exists -- refusing to create it on a guess. `
      + `${(cause as Error).message}`, { cause });
  }
}

/**
 * #3745: WHAT A LOCAL BRANCH OF THE CLAIM'S NAME HOLDS, so a leftover that holds nothing is not a collision. A multi-slice row leaves
 * its first slice's branch behind after the PR merges (origin deletes its copy, the local one stays), and the next claim for the row
 * derives the same name: #3566 was offered and refused on 93 ticks in 24 hours. THE TEST IS THE LOSS THE REFUSAL GUARDS AGAINST: the
 * tip is an ancestor of `origin/main` (so recreating the name loses no commit) and NO worktree holds the branch (so no tree is
 * standing on it). Either reading that is not `yes` refuses, and one git cannot answer is not `yes`: "could not ask" is never "free".
 * `origin/main` is the ref as this clone last fetched it, which can only be BEHIND origin, so a stale one refuses a branch that is
 * in fact merged and never frees one that is not.
 * @param {string} branch @param {typeof defaultRun} run
 * @returns {{ exists: false } | { exists: true, free: true, tip: string } | { exists: true, free: false, why: string }}
 */
function localBranchReading(branch: string, run: typeof defaultRun): { exists: false; } | { exists: true; free: true; tip: string; } | { exists: true; free: false; why: string; } {
  const tip = localBranchTip(branch, run);
  if (tip === null) return { exists: false };
  const holder = worktreeHolding(branch, run);
  const merged = mergedIntoMain(branch, run);
  const standing = merged.merged ? "merged into origin/main" : merged.why;
  if (holder.held) return { exists: true, free: false, why: `${standing}, and held by the worktree ${holder.path ?? holder.why}` };
  if (!merged.merged) return { exists: true, free: false, why: standing };
  return { exists: true, free: true, tip };
}

/**
 * The tip of `refs/heads/<branch>`, or `null` when there is no such branch. Any other failure throws: creating a branch on a guess is
 * how #1432 started.
 * @param {string} branch @param {typeof defaultRun} run
 * @returns {string | null}
 */
function localBranchTip(branch: string, run: typeof defaultRun): string | null {
  try {
    return String(run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).trim();
  } catch (cause) {
    if (exitStatusOf(cause) === 1) return null;
    throw new Error(`row-claim: could not ask git whether branch ${branch} locally exists -- refusing to create it on a guess. `
      + `${(cause as Error).message}`, { cause });
  }
}

/**
 * Is the tip of the local `branch` an ancestor of `origin/main`? A "no" counts the commits it is ahead by; a git failure is its own
 * answer ("NOT known to be merged"), never a "yes".
 * @param {string} branch @param {typeof defaultRun} run
 * @returns {{ merged: true } | { merged: false, why: string }}
 */
function mergedIntoMain(branch: string, run: typeof defaultRun): { merged: true; } | { merged: false; why: string; } {
  try {
    run("git", ["merge-base", "--is-ancestor", `refs/heads/${branch}`, "origin/main"]);
    return { merged: true };
  } catch (cause) {
    if (exitStatusOf(cause) !== 1) {
      return { merged: false, why: `NOT known to be merged into origin/main (git could not say: ${(cause as Error).message.split("\n")[0]})` };
    }
  }
  try {
    const ahead = String(run("git", ["rev-list", "--count", `origin/main..refs/heads/${branch}`])).trim();
    return { merged: false, why: `NOT merged into origin/main, ${ahead} commit(s) ahead` };
  } catch {
    return { merged: false, why: "NOT merged into origin/main (the commits ahead could not be counted)" };
  }
}

/**
 * The worktree whose HEAD is `refs/heads/<branch>` (`git worktree list --porcelain`, the main one included). A listing git cannot give
 * is `held` with no path, never "not held".
 * @param {string} branch @param {typeof defaultRun} run
 * @returns {{ held: false } | { held: true, path?: string, why: string }}
 */
function worktreeHolding(branch: string, run: typeof defaultRun): { held: false; } | { held: true; path?: string; why: string; } {
  let listing: string;
  try {
    listing = String(run("git", ["worktree", "list", "--porcelain"]));
  } catch (cause) {
    return { held: true, why: `(git could not list the worktrees: ${(cause as Error).message.split("\n")[0]})` };
  }
  for (const entry of listing.split(/\n\n+/)) {
    const lines = entry.split("\n");
    if (!lines.includes(`branch refs/heads/${branch}`)) continue;
    const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    return { held: true, path, why: "(a worktree)" };
  }
  return { held: false };
}

/**
 * Who a branch belongs to, as far as the tracker records: the claim record of the row its trailing number names.
 * A read that fails SAYS so; it is never turned into an owner or into "nobody".
 * @param {string} branch @param {typeof defaultRun} run
 * @returns {string}
 */
function branchOwnerText(branch: string, run: typeof defaultRun): string {
  const match = /-(\d+)$/.exec(branch);
  if (!match) return "its name carries no row number, so there is no claim record to name an owner";
  const row = Number(match[1]);
  try {
    const comments = fetchClaimComments(row, { run });
    const session = claimRecordSession(comments);
    if (claimRecordFrom(comments).branch === branch && session) return `row #${row}'s claim record names \`${session}\``;
    return `row #${row}'s newest claim record does not name this branch`;
  } catch (cause) {
    return `row #${row}'s claim record could not be read: ${(cause as Error).message}`;
  }
}

/**
 * #2014: Every branch `origin` holds whose name ends `-<issueNumber>` -- the ROW's branches, whatever the claimer chose
 * to call theirs. `ls-remote` spends no GraphQL, which is the point: the board goes stale exactly when the pool is
 * exhausted and no PR could be opened, so a detector that spent the pool would be blind in that same outage.
 * That has to hold for the REFUSAL as well as the detection, or the guard spends the pool it says it does not --
 * see `rowBranchRefusal`, which is why it takes no `run`.
 * A listing that FAILS throws; "could not ask origin" is not "the row has no branch".
 * @param {number} issueNumber @param {typeof defaultRun} run
 * @returns {{ branch: string, head: string }[]}
 */
function rowBranchesOnOrigin(issueNumber: number, run: typeof defaultRun): { branch: string; head: string; }[] {
  let listing: string;
  try {
    listing = run("git", [...LS_REMOTE_ARGS]);
  } catch (cause) {
    throw new Error(`row-claim: could not ask origin which branches it holds for row #${issueNumber} -- refusing to `
      + `claim on a guess. ${(cause as Error).message}`, { cause });
  }
  return branchesForRow(listing, issueNumber);
}

/**
 * #2014: The refusal for a row whose work may already be on `origin` under a branch nobody here named. It must be
 * FOLLOWABLE, and "claim it again with --branch=<that branch>" is not -- the check one line up would refuse that too.
 * So it names the three real exits, including the one for a trailing number that is a coincidence.
 *
 * IT DOES NOT NAME AN OWNER, and that is the correction reviewer-2 found at `47d9c128`. It called `branchOwnerText`,
 * which is `gh issue view --json comments` -- GraphQL -- so the guard advertised as pool-free spent the pool in the
 * one outage it exists for. Two reasons it is dropped rather than made conditional: every branch here has THIS row's
 * trailing number by construction, so the only record it could read is the record of the row the reader is already
 * looking at; and it is unreadable exactly when it would matter, because a stale row means the pool that would
 * answer is gone. `git log origin/<branch>` is in the message below and says whose work it is without spending
 * anything. Taking no `run` is what HOLDS that -- the constraint is held by construction, not by assertion, the same
 * way `reportB4` holds read-only one screen down.
 * @param {number} issueNumber @param {{ branch: string, head: string }[]} found
 * @returns {string}
 */
function rowBranchRefusal(issueNumber: number, found: { branch: string; head: string; }[]): string {
  const named = found.map(({ branch, head }) => `\`${branch}\` at ${head}`).join("; ");
  return `origin ALREADY HOLDS ${found.length === 1 ? "a branch" : `${found.length} branches`} for row #${issueNumber}: `
    + `${named}. Refusing before any write: this row's work may already be pushed, and the board cannot show it -- `
    + "opening the PR that would is the one act that spends GraphQL, so a row goes stale precisely when the pool is "
    + "gone (#2014). This refusal therefore reads no claim record and asks no API; what to do next, after reading the "
    + `work with \`git fetch origin && git log origin/${found[0].branch}\` and `
    + `\`git diff origin/main...origin/${found[0].branch}\`: `
    + "if it is YOUR OWN earlier work, finish it on that branch and open its PR -- you do not need a fresh claim; "
    + "if it is another session's, leave this row alone, say on the row that the branch exists, and take another row; "
    + `if its trailing -${issueNumber} is a coincidence rather than this row's work, delete that branch on origin and `
    + "claim again.";
}

/**
 * #1432: THE REFUSAL, BEFORE ANY WRITE: the target PATH exists, or the target BRANCH exists locally or on origin. Each
 * of those three names its owner where one is recorded -- the path's `.a11y-owner` stamp (#1128), the branch's claim
 * record (one `gh issue view`).
 * #2014 adds a fourth, asked of the ROW rather than of the name the claimer typed: all three above interrogate
 * `branch`, which is the author's free choice, so two sessions picking different slugs collided with nothing.
 * The fourth NAMES NO OWNER, deliberately, so that it spends nothing: a `gh` read here would be a GraphQL call on
 * the one path whose whole premise is an exhausted GraphQL pool. `rowBranchRefusal` carries the full reasoning.
 * @param {{ branch: string, worktree: string, issueNumber: number, adopt?: string, mySession?: string }} target
 *   `adopt` (#2470) names the session whose EXISTING tree this claim takes in place -- see {@link adoptionReason}.
 *   `mySession` (#2842) is the claimant, so a refusal over the claimant's OWN tree can say which cleanliness reading failed
 * @param {{ run?: typeof defaultRun, exists?: (path: string) => boolean, owner?: (worktree: string) => string | null }} [deps]
 * @returns {string | null} the refusal, or null to go ahead
 */
export function worktreeTargetReason({ branch, worktree, issueNumber, adopt, mySession }: { branch: string; worktree: string; issueNumber: number; adopt?: string; mySession?: string; }, { run = defaultRun, exists = existsSync, owner = worktreeOwner }: { run?: typeof defaultRun; exists?: (path: string) => boolean; owner?: (worktree: string) => string | null; } = {}): string | null {
  if (adopt !== undefined) return adoptionReason({ branch, worktree, adopt }, { run, exists, owner });
  if (exists(worktree)) {
    const who = owner(worktree);
    return `--worktree=${worktree} ALREADY EXISTS, ${who ? `stamped by \`${who}\`` : "UNSTAMPED (nobody recorded an owner, which is not the same as free)"}. `
      + "Refusing before any write: a claim that went on would act inside a tree it did not create."
      + ownTreeRemedy({ worktree, branch, who, mySession }, run);
  }
  const local = localBranchReading(branch, run);
  if (local.exists && !local.free) {
    return `--branch=${branch} ALREADY EXISTS locally (${branchOwnerText(branch, run)}), ${local.why}. Refusing before any write.`;
  }
  if (gitRefExists(["ls-remote", "--exit-code", "--heads", "origin", branch], 2, `branch ${branch} on origin`, run)) {
    return `--branch=${branch} ALREADY EXISTS on origin (${branchOwnerText(branch, run)}). Refusing before any write.`;
  }
  const rowBranches = rowBranchesOnOrigin(issueNumber, run);
  if (rowBranches.length > 0) return rowBranchRefusal(issueNumber, rowBranches);
  return null;
}

/**
 * #2470: THE ONE CASE IN WHICH A CLAIM MAY GO ON INSIDE A TREE IT DID NOT CREATE: `--adopt=<session>` names the session that made
 * it, and the tree must be that session's, on that branch. `release` (`decline --keep-worktree`) leaves a stalled holder's tree
 * in place with the work in it, and the next instance for the row starts THERE -- which the refusal above forbids for a tree it
 * finds, and rightly (two 2026-09-13 incidents of acting in a peer's tree). So the exception is made narrow enough to keep the
 * guard's whole reason: the named session must be the one the STAMP names (#1128), so a tree stamped by anybody else, or by
 * nobody, is still refused; and the tree must already be on the branch the claim records, so it cannot be pointed at a
 * different one. Refuses BEFORE any write, like every reason here.
 * @param {{ branch: string, worktree: string, adopt: string }} target
 * @param {{ run: typeof defaultRun, exists: (path: string) => boolean, owner: (worktree: string) => string | null }} deps
 * @returns {string | null}
 */
function adoptionReason({ branch, worktree, adopt }: { branch: string; worktree: string; adopt: string; }, { run, exists, owner }: { run: typeof defaultRun; exists: (path: string) => boolean; owner: (worktree: string) => string | null; }): string | null {
  if (!exists(worktree)) {
    return `--adopt=${adopt} names ${worktree}, which does not exist -- there is nothing to adopt. Refusing before any write.`;
  }
  const who = owner(worktree);
  if (who !== adopt) {
    return `--worktree=${worktree} is ${who ? `stamped by \`${who}\`, not \`${adopt}\`` : "UNSTAMPED (nobody recorded an owner)"}. `
      + "Refusing before any write (#1432): only the tree of the session --adopt names may be claimed in place.";
  }
  const head = headBranchOf(worktree, run);
  if (head !== branch) {
    return `--worktree=${worktree} is on ${head === null ? "no branch (detached)" : `\`${head}\``}, not --branch=${branch}. `
      + "Refusing before any write: an adopted tree keeps the branch its work is on.";
  }
  return null;
}

/** @param {string} worktree @param {typeof defaultRun} run @returns {string | null} the branch checked out there, `null` when detached or unreadable */
function headBranchOf(worktree: string, run: typeof defaultRun): string | null {
  try {
    return String(run("git", ["-C", worktree, "symbolic-ref", "--short", "HEAD"])).trim() || null;
  } catch {
    return null;
  }
}

/**
 * #2842: IS THIS TREE PROVABLY LOSING NOTHING if a claim goes on inside it? FOUR readings, each a way a deletion or a careless
 * adoption could lose work, and the FIRST that fails is named -- so a refusal can tell the next session which one it was rather
 * than only that the path exists: (1) a tracked file modified or staged, (2) an untracked file (`git status --porcelain` reads
 * both; they are split so the message says which), (3) HEAD ahead of `origin/main`, (4) the claim branch's tip (`branch`, else
 * the one checked out) not an ancestor of `origin/main`. Reading 4 differs from 3 only when HEAD is detached somewhere else
 * while the branch holds commits -- the case a HEAD-only reading calls clean. Gitignored files are not read, as in
 * {@link worktreeStatus}; that is safe HERE only because an adoption deletes nothing.
 * A reading git cannot answer is `clean: false` with that said: "could not ask" is never "clean".
 * @param {{ worktree: string, branch?: string }} tree @param {{ run?: typeof defaultRun }} [deps]
 * @returns {{ clean: true } | { clean: false, why: string }}
 */
export function worktreeCleanliness({ worktree, branch }: { worktree: string; branch?: string; }, { run = defaultRun }: { run?: typeof defaultRun; } = {}): { clean: true; } | { clean: false; why: string; } {
  /** @param {string[]} args */
  const git = (...args: string[]) => String(run("git", ["-C", worktree, ...args]));
  try {
    const lines = git("status", "--porcelain").split("\n").filter(Boolean);
    // The owner stamp is this tree's own marker, not work: a tree cut before `.a11y-owner` was gitignored would otherwise read dirty.
    const untracked = lines.filter((l) => l.startsWith("??") && l !== `?? ${OWNER_FILE}`);
    const tracked = lines.filter((l) => !l.startsWith("??"));
    if (tracked.length > 0) return { clean: false, why: `it has uncommitted changes to tracked files (${tracked.slice(0, 5).join("; ")})` };
    if (untracked.length > 0) return { clean: false, why: `it has untracked files (${untracked.slice(0, 5).join("; ")})` };
    const ahead = Number(git("rev-list", "--count", "origin/main..HEAD").trim());
    if (ahead > 0) return { clean: false, why: `HEAD is ${ahead} commit(s) ahead of origin/main` };
    const tip = branch ?? headBranchOf(worktree, run);
    if (tip !== null && branchTipIsUnpushed(worktree, tip, run)) {
      return { clean: false, why: `branch \`${tip}\`'s tip is not an ancestor of origin/main (unpushed commits)` };
    }
    return { clean: true };
  } catch (cause) {
    return { clean: false, why: `git could not answer (${(cause as Error).message.split("\n")[0]}), and "could not ask" is not "clean"` };
  }
}

/**
 * @param {string} worktree @param {string} branch @param {typeof defaultRun} run
 * @returns {boolean} true when the LOCAL branch exists and its tip is not an ancestor of `origin/main`. A branch that does not
 *   exist has no tip to lose (exit 1 of both reads is "no"); any OTHER failure throws, because "could not ask" is not "absent".
 */
function branchTipIsUnpushed(worktree: string, branch: string, run: typeof defaultRun): boolean {
  const ref = `refs/heads/${branch}`;
  if (!gitRefExists(["-C", worktree, "rev-parse", "--verify", "--quiet", ref], 1, `branch ${branch} in ${worktree}`, run)) return false;
  try {
    run("git", ["-C", worktree, "merge-base", "--is-ancestor", ref, "origin/main"]);
    return false;
  } catch (cause) {
    if (exitStatusOf(cause) === 1) return true;
    throw cause;
  }
}

/**
 * #2842: THE SENTENCE A REFUSAL OVER THE CLAIMANT'S OWN TREE ENDS WITH -- which cleanliness reading failed, and the two exits.
 * Empty for anyone else's tree: the reading is the claimant's to act on only where the tree is theirs.
 * @param {{ worktree: string, branch: string, who: string | null, mySession?: string }} tree @param {typeof defaultRun} run
 * @returns {string}
 */
function ownTreeRemedy({ worktree, branch, who, mySession }: { worktree: string; branch: string; who: string | null; mySession?: string; }, run: typeof defaultRun): string {
  if (!mySession || who !== mySession) return "";
  const reading = worktreeCleanliness({ worktree, branch }, { run });
  if (reading.clean) return " The tree is the claimant's own and reads clean, so it is adopted without a flag; this refusal is for another reason.";
  return ` It is YOUR OWN tree and is not adopted automatically, because ${reading.why}. Push or discard that work, or re-run with `
    + `--adopt=${mySession} to take the tree and its work in place.`;
}

/**
 * #2748: the "cannot tell" answer to "is this session's predecessor instance confirmed gone" -- a pure
 * stub, kept for tests and for any caller with no ledger to read. Production no longer uses it directly
 * (see {@link predecessorGoneReading}): `adoptFor` reads a real record now, so the ordinary CLI claim can
 * actually reach the adoption this row promises, not just the mechanism for it.
 * @returns {null}
 */
export function predecessorLivenessUnknown(): null {
  return null;
}

/** #2748: where a decline's "predecessor confirmed gone" attestations live -- beside the wake ledger, one entry per session. */
const PREDECESSOR_GONE_FILE = "declined-predecessors";

/** @param {string} ledgerPath @returns {string} */
function predecessorGonePath(ledgerPath: string): string {
  return `${dirname(ledgerPath)}/${PREDECESSOR_GONE_FILE}`;
}

/**
 * #2748: RECORDS THAT THIS SESSION'S PREDECESSOR IS GONE, at the one moment something already knows it --
 * an EXPLICIT `--predecessor-gone` assertion on a `--keep-worktree` decline, never a `--keep-worktree`
 * decline alone (reviewer-2754's second verdict, at `8396865b7`: a `--keep-worktree` decline is not proof
 * of death by itself -- #2470 (6)'s own standing-engineer release keeps that session's process running,
 * so a decline can land while the "predecessor" is still very much alive). The trust placed in the
 * explicit flag is the SAME trust `#2470`'s own `--adopt=<session>` flag already places in whoever types
 * it: this file does not re-verify liveness with herdr (that general read is #2747's, and out of scope
 * here, see the row's own "Not in this row"), it remembers that a caller who actually knows already
 * attested it -- a human confirming a predecessor gone by hand (#2623's own shape) or #2470's automated
 * stall release, which passes the flag only when `closeHolder` truly closed the workspace or found it
 * already absent, never when a standing seat's process was left running.
 * @param {string} mySession @param {{ ledgerPath?: string }} [deps]
 */
export function recordPredecessorGone(mySession: string, { ledgerPath = ledgerPathFrom(process.argv) }: { ledgerPath?: string; } = {}) {
  const path = predecessorGonePath(ledgerPath);
  const all = readJsonObject(path);
  all[mySession] = { at: Date.now() };
  writeJsonObject(path, all);
}

/**
 * #2748: THE REAL ANSWER `adoptFor` GIVES `implicitAdoptSession` IN PRODUCTION. `true` only when a decline
 * carrying an EXPLICIT `--predecessor-gone` assertion recorded this exact session as gone
 * ({@link recordPredecessorGone}); `null` ("cannot tell") for everything else, including a session this
 * file has simply never heard of and an ordinary `--keep-worktree` decline that made no such assertion --
 * it has no way to attest "still alive", only "declared gone" or "nothing recorded", so it can never
 * manufacture the `false` a live, contrary predecessor would need (Done-when 2's positive control).
 * @param {string} session @param {{ ledgerPath?: string }} [deps]
 * @returns {boolean | null}
 */
export function predecessorGoneReading(session: string, { ledgerPath = ledgerPathFrom(process.argv) }: { ledgerPath?: string; } = {}): boolean | null {
  return readJsonObject(predecessorGonePath(ledgerPath))[session] ? true : null;
}

/**
 * #2748: the session to treat as `--adopt` when the claimant typed none. Live-discovered on #2623's own
 * respawn: re-claiming a row under the SAME session name refused on that session's OWN leftovers (the
 * worktree/branch it had stamped itself), a case #2470's `--adopt` already solves once the claimant knows
 * to type it -- but nothing told the ordinary respawn path to. This is the ruling that lets the ORDINARY
 * claim command find it: `undefined` unless the claim target is ALREADY the very session's own stamped
 * tree AND that session's predecessor instance is independently confirmed gone (never merely "quiet" --
 * see {@link predecessorLivenessUnknown}). Where either is not true, this answers `undefined` and
 * `worktreeTargetReason` refuses precisely as it always has: this narrows that refusal, it does not
 * remove the #1128 safety it was built for.
 * #2842 widens "AND that session's predecessor is confirmed gone" to "OR the tree is demonstrably clean" ({@link worktreeCleanliness}).
 * @param {{ worktree: string, mySession: string, exists: (path: string) => boolean,
 *   owner: (worktree: string) => string | null, predecessorGone: (session: string) => boolean | null,
 *   clean?: (worktree: string) => boolean }} args `clean` defaults to "not clean", so a caller that supplies none behaves as before
 * @returns {string | undefined}
 */
export function implicitAdoptSession({ worktree, mySession, exists, owner, predecessorGone, clean = () => false }: {
        worktree: string; mySession: string; exists: (path: string) => boolean;
        owner: (worktree: string) => string | null; predecessorGone: (session: string) => boolean | null;
        clean?: (worktree: string) => boolean;
    }): string | undefined {
  if (!exists(worktree)) return undefined;
  if (owner(worktree) !== mySession) return undefined;
  const gone = predecessorGone(mySession);
  if (gone === true) return mySession;
  if (gone === false) return undefined; // a reading that says the predecessor is ALIVE outranks "the tree looks clean"
  // #2842: a tree that is demonstrably CLEAN holds nothing an adoption could lose, so it needs no record that its
  // predecessor is gone -- the record is a proof of a different thing (that nothing is still WORKING in it) and a clean tree
  // has no work for a live predecessor to lose. Adopting rather than deleting and recreating: it removes nothing, so it
  // cannot lose a gitignored file either, and it needs no knowledge of which branch the old tree was on.
  return clean(worktree) ? mySession : undefined;
}

/**
 * A claim that did not win leaves nothing behind: the worktree and branch this call created a moment ago are removed.
 * A removal that fails is SAID, never swallowed.
 * @param {{ branch: string, worktree: string }} target @param {typeof defaultRun} run
 * @returns {string}
 */
function undoCreatedWorktree({ branch, worktree }: { branch: string; worktree: string; }, run: typeof defaultRun, record = recordRemoval): string {
  // #2782: THE ONE REMOVER THAT DOES NOT ASK THE ROW'S CLAIM, deliberately. It runs because the claim was LOST, so the row
  // carries the WINNER's `session:` label by construction and `claimRefusal` would refuse every time; what makes it safe is that
  // `worktreeTargetReason` refused an existing path before this call made the tree, so nothing in it predates this call.
  // It still writes its line, and that line is how a later reader tells this remover from a prune.
  const line = { path: worktree, branch, caller: CALLER, reason: "the claim did not win; removing the tree this call created" };
  try {
    record({ ...line, event: "removing" });
    run("git", ["worktree", "remove", "--force", worktree]);
    record({ ...line, event: "removed" });
    run("git", ["branch", "-D", branch]);
    return `the worktree ${worktree} and branch ${branch} it had just created were removed`;
  } catch (cause) {
    return `the worktree ${worktree} and branch ${branch} it had just created could NOT be removed: `
      + `${(cause as Error).message}`;
  }
}

/**
 * #1432: CLAIM, CREATING THE WORKTREE -- `row-claim claim --branch=<b> --worktree=<p>`. In order: refuse if the path or
 * branch exists, or (#2014) if origin already holds a branch for THIS ROW; fetch; `git worktree add -b <b> <p>
 * origin/main`; stamp it; claim. A claim that is refused or loses
 * its race removes what this created. A failure after the worktree landed carries it in #1399's landed list.
 * @param {number} issueNumber
 * @param {string} mySession
 * @param {{ branch: string, worktree: string, adopt?: string, run?: typeof defaultRun, exists?: (path: string) => boolean,
 *   owner?: (worktree: string) => string | null, stamp?: (worktree: string, session: string) => void,
 *   claim?: typeof claimRow, claimDeps?: Parameters<typeof claimRow>[2] }} args
 *   `adopt` (#2470) claims the EXISTING tree of the session it names, in place -- see {@link adoptionReason}
 * @returns {ReturnType<typeof claimRow>}
 */
export function claimWithWorktree(issueNumber: number, mySession: string, { branch, worktree, adopt, run = defaultRun, exists = existsSync,
  owner = worktreeOwner, stamp = stampWorktree, claim = claimRow, claimDeps = {} }: {
        branch: string; worktree: string; adopt?: string; run?: typeof defaultRun; exists?: (path: string) => boolean;
        owner?: (worktree: string) => string | null; stamp?: (worktree: string, session: string) => void;
        claim?: typeof claimRow; claimDeps?: Parameters<typeof claimRow>[2];
    }): ReturnType<typeof claimRow> {
  const refusal = worktreeTargetReason({ branch, worktree, issueNumber, adopt, mySession }, { run, exists, owner });
  if (refusal) return { claimed: false, reason: refusal };
  if (adopt !== undefined) return adoptWorktree(issueNumber, mySession, { branch, worktree, adopt, run, stamp, claim, claimDeps });
  const landed: string[] = [];
  return withLandedWrites(issueNumber, landed, () => {
    run("git", ["fetch", "--quiet", "origin"]);
    const replaced = replacedMergedTip(branch, run);
    run("git", ["worktree", "add", replaced ? "-B" : "-b", branch, worktree, "origin/main"]);
    landed.push(`created worktree ${worktree} on ${replaced ? "recreated" : "new"} branch ${branch} from origin/main`);
    stamp(worktree, mySession);
    landed.push(`stamped ${worktree} as ${mySession}'s`);
    const result = claim(issueNumber, mySession, { run, ...claimDeps, branch, worktree });
    if (result.claimed) return replaced ? { ...result, replacedTip: replaced } : result;
    return { claimed: false, reason: `${result.reason} -- and ${undoCreatedWorktree({ branch, worktree }, run)}` };
  });
}

/**
 * #3745: the tip a leftover local branch of the claim's name held, when the claim is about to recreate the name over it -- `null` for
 * the ordinary case of no such branch. `worktreeTargetReason` has already let it through (merged, held by no worktree), and this
 * ASKS AGAIN after the fetch, because the fetch is what moves `origin/main` and a branch force-pushed away from main would make the
 * first answer wrong. Throws, before anything is written, if the old tip is not an ancestor of `origin/main`: recreating the name
 * must leave the old tip reachable from main, or it would be the loss the refusal exists to prevent.
 * @param {string} branch @param {typeof defaultRun} run
 * @returns {string | null}
 */
function replacedMergedTip(branch: string, run: typeof defaultRun): string | null {
  const tip = localBranchTip(branch, run);
  if (tip === null) return null;
  const reading = localBranchReading(branch, run);
  if (reading.exists && reading.free) return tip;
  throw new Error(`row-claim: --branch=${branch} exists locally and is not free to recreate after the fetch: `
    + `${reading.exists ? reading.why : "it vanished"}. Nothing was written.`);
}

/**
 * #2470: THE CLAIM OF A TREE THAT ALREADY HOLDS WORK. Re-stamps it to the claimant and claims with the branch and worktree
 * recorded, and creates NOTHING -- no fetch, no `worktree add`, and above all no removal: a claim that loses its race leaves the
 * tree exactly where it found it, RE-STAMPED BACK to its previous owner, because unlike a tree this call made, this one holds
 * somebody's unpushed work and `undoCreatedWorktree` would destroy it.
 * @param {number} issueNumber @param {string} mySession
 * @param {{ branch: string, worktree: string, adopt: string, run: typeof defaultRun,
 *   stamp: (worktree: string, session: string) => void, claim: typeof claimRow, claimDeps: Parameters<typeof claimRow>[2] }} args
 * @returns {ReturnType<typeof claimRow>}
 */
function adoptWorktree(issueNumber: number, mySession: string, { branch, worktree, adopt, run, stamp, claim, claimDeps }: {
        branch: string; worktree: string; adopt: string; run: typeof defaultRun;
        stamp: (worktree: string, session: string) => void; claim: typeof claimRow; claimDeps: Parameters<typeof claimRow>[2];
    }): ReturnType<typeof claimRow> {
  const landed: string[] = [];
  return withLandedWrites(issueNumber, landed, () => {
    stamp(worktree, mySession);
    landed.push(`re-stamped ${worktree} from ${adopt} to ${mySession}`);
    // #2769: the branch being adopted is B4's fact that its own PR is not a competitor, even when that PR is a `Closes: none` split.
    const result = claim(issueNumber, mySession, { run, ...claimDeps, branch, worktree, adoptedBranch: branch });
    if (result.claimed) return result;
    stamp(worktree, adopt);
    return { claimed: false, reason: `${result.reason} -- the adopted worktree ${worktree} was left in place, with its work, and re-stamped \`${adopt}\`` };
  });
}

/**
 * #665: Is `worktreePath` clean (no uncommitted changes)? `{ clean: false }` names every dirty path --
 * the issue's own stated acceptance: "A dirty worktree is refused by name, listing the files." A path
 * that no longer exists (already removed by hand, or never created) reads as CLEAN: nothing there can be
 * lost, and refusing to release a claim over a directory that is already gone would be the housekeeping
 * failure this row exists to fix, one layer over.
 * @param {string} worktreePath
 * @param {{ run?: typeof defaultRun }} [deps]
 * @returns {{ clean: true } | { clean: false, files: string[] }}
 */
export function worktreeStatus(worktreePath: string, { run = defaultRun }: { run?: typeof defaultRun; } = {}): { clean: true; } | { clean: false; files: string[]; } {
  if (!existsSync(worktreePath)) return { clean: true };
  const out = run("git", ["-C", worktreePath, "status", "--porcelain"]);
  const files = out.split("\n").filter(Boolean);
  return files.length === 0 ? { clean: true } : { clean: false, files };
}

/**
 * #665: Removes `worktreePath` via `git worktree remove` -- REFUSING on a dirty tree, by name, never
 * `--force`. A dirty worktree is exactly the state this function exists to protect; forcing past it would
 * be the destructive shortcut CLAUDE.md already warns against for `git checkout --` one door over. A path
 * that no longer exists is treated as already-removed success, not a failure to report.
 *
 * #1373: CLEAN IS A FACT ABOUT WHAT GIT TRACKS. `runs/` is gitignored, so a worktree holding the only copies
 * of board snapshots reads clean and `git worktree remove` deletes them. It refuses, naming the count, unless
 * every `runs/` file is in the primary checkout with a matching non-empty sha256 -- `prune-worktrees.mjs`'s
 * `unverifiedRecords`, the one predicate both removers share. `hash` is injectable so a test can drive the
 * row's incident: two failed reads that compare equal.
 * #2782: THE ROW'S CLAIM IS READ, AND THE LINE IS WRITTEN. `decline` already proved the row is claimed by `session`; this asks
 * whether the row the TREE names (its branch, its `wt-<n>` directory) carries anyone ELSE's `session:` label, which is the copy
 * of a claim `.a11y-owner` cannot be. A `removing` line precedes the delete and a `removed`/`failed` line follows it.
 *
 * @param {string} worktreePath
 * @param {{ run?: typeof defaultRun, hash?: (file: string) => string, session?: string, branch?: string | null,
 *   claim?: typeof claimRefusal, record?: typeof recordRemoval }} [deps]
 * @returns {{ removed: true } | { removed: false, reason: string, files?: string[] }}
 */
export function removeClaimedWorktree(worktreePath: string, { run = defaultRun, hash, session, branch = null, claim = claimRefusal,
  record = recordRemoval }: {
        run?: typeof defaultRun; hash?: (file: string) => string; session?: string; branch?: string | null;
        claim?: typeof claimRefusal; record?: typeof recordRemoval;
    } = {}): { removed: true; } | { removed: false; reason: string; files?: string[]; } {
  if (!existsSync(worktreePath)) return { removed: true };
  const status = worktreeStatus(worktreePath, { run });
  if (!status.clean) {
    return { removed: false,
      reason: `${worktreePath} has uncommitted change(s) -- refusing to remove it: ${status.files.join(", ")}`,
      files: status.files };
  }
  const held = unverifiedRecords(worktreePath, primaryWorktreeOf(worktreePath, { run }), { hash });
  if (held.refused) return { removed: false, reason: held.reason };
  const claimed = claim({ path: worktreePath, branch }, { except: session });
  if (claimed.refused) return { removed: false, reason: claimed.reason };
  const line = { path: worktreePath, branch, caller: CALLER, reason: `decline by ${session ?? "an unnamed session"}` };
  try {
    record({ ...line, event: "removing" });
  } catch (cause) {
    return { removed: false, reason: `the removal log could not be written, so ${worktreePath} was not removed (#2782): ${(cause as Error).message}` };
  }
  try {
    run("git", ["worktree", "remove", worktreePath]);
    record({ ...line, event: "removed" });
    return { removed: true };
  } catch (error) {
    record({ ...line, event: "failed", detail: (error as Error).message });
    return { removed: false,
      reason: `git worktree remove failed -- ${(error as Error).message}` };
  }
}

/**
 * Pure: every label a decline removes -- pulled out of `declineRow` to keep that function's own
 * complexity below the lint gate, and because "what comes off a decline" is a fact worth naming on its
 * own. #656/#665: the branch and worktree labels come off too -- a released row is no longer this
 * session's, and a stale `branch:*`/`worktree:*` naming an object nobody here is working any more is
 * worse than none: it would tell a future escalation "held" for a row that is actually free.
 * @param {{ branch: string | null, worktree: string | null }} status
 * @param {string} mySession
 * @param {boolean} wasReady
 * @returns {string[]}
 */
function declineRemoveLabels(status: { branch: string | null; worktree: string | null; }, mySession: string, wasReady: boolean): string[] {
  return [CLAIM_LABEL, `${SESSION_PREFIX}${mySession}`, STARTED_LABEL,
    ...(status.branch ? [`${BRANCH_LABEL_PREFIX}${status.branch}`] : []),
    ...(status.worktree ? [`${WORKTREE_LABEL_PREFIX}${status.worktree}`] : []),
    ...(wasReady ? [WAS_READY_LABEL] : [])];
}

/**
 * #2746: THE DECLINE LABEL WRITE, VERIFIED. `gh issue edit --remove-label ... --add-label ...` in one
 * call is NOT one write -- #677's own live reproduction had the `--remove-label` apply while every
 * `--add-label` did not, because a label named for the first time (`branch:`/`worktree:` there;
 * `${ANSWER_LABEL_PREFIX}<session>` here is the identical PER-SESSION-UNIQUE shape) does not yet exist,
 * and `gh` refuses to add a label it has never created. #749/#2151 fixed this for `claimRow`
 * (`ensureLabelsExist` before the write, then a re-read `writeRowLabels`'s own header calls
 * WRITE-THEN-VERIFY) -- `declineRow` never got either half, and #2623's row is the live cost: the gate's
 * `claim-stall.mjs` released it at 03:44:09Z, `decline` exited clean and printed `DECLINED`, and the
 * row's `in-progress`/`started`/`session:worker-2623` labels never moved on GitHub. A `gh` exit code is
 * proof the COMMAND ran, never proof the EFFECT landed (`docs/operational-lessons.md`'s own standing
 * rule, restated here because this call had never had to honour it): create what is about to be added,
 * then read the row back and REFUSE to report a decline that did not durably change it.
 *
 * #3942: AND ONE STATE LABEL, NOT NONE. `answer:<session>` is not a state, so the decline-with-answer edit that added only it left
 * fourteen open rows in no state at all -- invisible to the Ready lane, the claim pool and every label-keyed count -- once the answerer
 * removed it (the correct act). An OPEN row whose labels after the write hold no state label is refused here for the same reason a label
 * that did not land is: the edit ran and its effect is not the one a decline promises. A closed row has no lane to be in (`closed`).
 * @param {number} issueNumber @param {string[]} removeLabels @param {string[]} addLabels
 * @param {{ run: typeof defaultRun, landed: string[], closed: boolean }} deps
 */
function writeDeclineLabels(issueNumber: number, removeLabels: string[], addLabels: string[], { run, landed, closed }: { run: typeof defaultRun; landed: string[]; closed: boolean; }) {
  ensureLabelsExist(addLabels, { run });
  run("gh", ["issue", "edit", String(issueNumber), "--repo", REPO,
    ...removeLabels.flatMap((l) => ["--remove-label", l]),
    ...addLabels.flatMap((l) => ["--add-label", l])]);
  const after = fetchLabels(issueNumber, { run }).labels;
  const stillThere = removeLabels.filter((l) => after.includes(l));
  const stillMissing = addLabels.filter((l) => !after.includes(l));
  if (stillThere.length > 0 || stillMissing.length > 0) {
    throw new Error(`row-claim: #${issueNumber}'s decline edit did NOT durably land -- re-reading the row, `
      + `it still carries ${stillThere.length > 0 ? stillThere.join(", ") : "(none)"} and is still missing `
      + `${stillMissing.length > 0 ? stillMissing.join(", ") : "(none)"}. Refusing to report DECLINED over a `
      + "write whose effect this call cannot confirm (#2746).");
  }
  const stateless = closed ? [] : stateLabelFindings([{ number: issueNumber, labels: after }]);
  if (stateless.length > 0) {
    throw new Error(`row-claim: #${issueNumber}'s decline edit left an OPEN row with ${stateless[0].labels.length === 0 ? "NO state label" : `TWO state labels (${stateless[0].labels.join(", ")})`}`
      + ` (it carries: ${after.join(", ") || "(none)"}). A row is in exactly one of ${STATE_LABELS.join(", ")}; one in none is absent from the Ready lane, the claim pool `
      + "and every label-keyed count. Refusing to report DECLINED over it (#3942).");
  }
  landed.push(`removed labels ${removeLabels.join(", ")}${addLabels.length > 0 ? `; added ${addLabels.join(", ")}` : ""} (verified by re-read)`);
}

/**
 * Pure: what a decline's label EDIT should add, and whether that amounts to a `ready` restore -- pulled
 * out of `declineRow` to keep its own complexity below the lint gate, same reason `declineRemoveLabels`
 * was. `isClosed` wins over every other reason to add a label (#752): a closed row has no lane to go back
 * to, so neither `wasReady` nor `blockedReason` may add anything once it is true.
 * @param {{ isClosed: boolean, wasReady: boolean, blockedReason: string | undefined, answer?: string, keepsState?: boolean }} facts
 * `keepsState` is a state label the decline does not remove (a row claimed from `backlog` still carries it).
 * @returns {{ restoreReady: boolean, addLabels: string[] }}
 */
function declineAddLabels({ isClosed, wasReady, blockedReason, answer, keepsState = false }: { isClosed: boolean; wasReady: boolean; blockedReason: string | undefined; answer?: string; keepsState?: boolean; }): { restoreReady: boolean; addLabels: string[]; } {
  if (isClosed) return { restoreReady: false, addLabels: [] };
  // #2470: `answer:<session>` says the row is not for the pool: a session owes a RULING on it (the work merged and the row is
  // still open, or it needs a decision), so it neither returns to `ready` nor is marked `blocked`.
  // #3942: BUT `answer:` IS NOT A STATE, and it clears by being REMOVED -- so as the row's only label of the kind it left the row in
  // NO state once answered (fourteen rows). `backlog` is the one state the gate does not offer and nobody has to remember to remove:
  // `ready` beside `answer:` WOULD be offered (the prefix is not in `NOT_STARTABLE`), and `blocked` has no referent.
  if (answer) return { restoreReady: false, addLabels: [`${ANSWER_LABEL_PREFIX}${answer}`, ...(keepsState ? [] : [BACKLOG_LABEL])] };
  const restoreReady = wasReady && !blockedReason;
  return { restoreReady, addLabels: blockedReason ? [BLOCKED_LABEL] : restoreReady ? [READY_LABEL] : [] };
}

/**
 * Pure: may `mySession` decline this row at all, given its labels? Pulled out of `declineRow` to keep
 * that function's own complexity below the lint gate -- the three ownership checks it always ran, now
 * named as the single question they jointly answer.
 * @param {{ claimed: boolean, sessions: string[] }} status
 * @param {string} mySession
 * @returns {string | null} a refusal reason, or `null` to proceed
 */
function declineOwnershipReason(status: { claimed: boolean; sessions: string[]; }, mySession: string): string | null {
  if (!status.claimed) return "row is not claimed -- nothing to decline";
  if (status.sessions.length > 1) {
    return `row carries multiple session labels (${status.sessions.join(", ")}) -- an unresolved race, `
      + "not a single decline; resolve it by hand";
  }
  if (!status.sessions.includes(mySession)) {
    const by = status.sessions.length > 0 ? status.sessions.join(", ") : "someone (no session label recorded yet)";
    return `row is held by ${by}, not ${mySession} -- refusing to release a claim that is not this session's`;
  }
  return null;
}

/**
 * DECLINE: give a row back. The second acceptance case for #176 -- a row dispatched (or claimed) and then
 * declined must return to genuinely unclaimed and say so, not sit `in-progress` forever with nobody
 * obligated to un-label it. Also the general "release" this tool always lacked: #186 needed exactly this
 * when `worker-audit` claimed a row, found it unstartable, and had to be un-labelled by hand.
 *
 * Refuses to release a row this session does not hold -- decline is a session giving BACK its own claim,
 * never a way to clear someone else's. A row with more than one session label (a race not yet resolved
 * one way or the other) is also refused rather than guessed at, because removing all of them would take
 * back a claim that may be the OTHER session's legitimate one.
 *
 * #449: RESTORES THE LABEL THE ROW CARRIED BEFORE THE CLAIM, NOT ALWAYS `ready`. Measured live on #171:
 * a row claimed then correctly declined came out `[backlog]` -- not held, not `ready`, invisible to the
 * Ready queue, because the old code only ever stripped the claim labels and never asked what was true
 * before them. `WAS_READY_LABEL` (written by `writeRowLabels`, in the same edit that removed `ready`) is
 * the only place that fact survives, so this reads it rather than assuming.
 *
 * THE ASYMMETRY: a decline is not always a return to `ready`. `blockedReason`, when given, means the
 * decline is itself a finding -- the row is blocked, not merely released -- and must NOT read as ready
 * again just because it was before. It adds `BLOCKED_LABEL` instead, and records the reason as an issue
 * comment (never a label -- a label carries no free text) so the finding survives for whoever picks the
 * row up next. Either way the marker is removed in the same edit: its job -- carrying the fact from claim
 * to decline -- is done the moment this function reads it.
 *
 * #665: REMOVES THE RECORDED WORKTREE FIRST, before touching any label. A dirty worktree refuses the
 * WHOLE decline, not merely the removal -- otherwise the claim record disappears while the directory (and
 * whatever uncommitted work sits in it) silently survives, untracked by anything that could tell a future
 * session it still needs attention. Safe specifically because DECLINING is releasing YOUR OWN claim: the
 * releasing session is, by construction, the one that owns the worktree being removed.
 *
 * #752: A CLOSED ROW HAS NO LANE TO GO BACK TO. Measured live: `decline`d #721 restored `ready` because
 * it carried `WAS_READY_LABEL`, and #721 was already closed -- the row that was "genuinely unclaimed,
 * pickable" one edit ago is now "done", and a closed row cannot be both. `ready-label-audit.mjs`'s own
 * `isClosedDebrisLabel` already names `ready`/`in-progress`/`session:*` as debris ON a closed row; this
 * is that same fact enforced at the ONE place that was still writing `ready` onto one. `isClosed` wins
 * over EVERY other reason to add a label -- `wasReady` and `blockedReason` both describe what the row
 * needs going forward, and a closed row has no "forward". Labels only come OFF; nothing goes back on, and
 * no Project Status move is attempted (there is no board lane for done work to return to).
 *
 * @param {number} issueNumber
 * @param {string} mySession
 * #2470: `keepWorktree` LEAVES THE RECORDED WORKTREE IN PLACE. Without it a decline removes the tree first and refuses while it is
 * dirty, which for a session that stalled with 215 uncommitted lines either destroys a clean tree's unpushed commits (the branch
 * survives, the tree does not) or cannot run at all. With it the release is a LABEL and RECORD operation and touches no file;
 * the caller decides what becomes of the tree. `answer` releases to `answer:<session>` instead of `ready` -- see `declineAddLabels`.
 *
 * @param {{ run?: typeof defaultRun, moveStatus?: typeof moveProjectStatus, blockedReason?: string,
 *           removeWorktree?: typeof removeClaimedWorktree, keepWorktree?: boolean, predecessorGone?: boolean, answer?: string,
 *           fetchComments?: typeof fetchClaimComments, recordGone?: typeof recordPredecessorGone }} [deps]
 * @returns {{ declined: true, restoredReady: boolean, blocked: boolean, closed: boolean, statusMoved: true }
 *   | { declined: true, restoredReady: true, blocked: false, closed: false, statusMoved: false,
 *       notOnBoard: boolean, statusReason: string }
 *   | { declined: false, reason: string }}
 */
export function declineRow(issueNumber: number, mySession: string,
  { run = defaultRun, moveStatus = moveProjectStatus, blockedReason, removeWorktree = removeClaimedWorktree,
    fetchComments = fetchClaimComments, keepWorktree = false, predecessorGone = false, answer, recordGone = recordPredecessorGone }: {
          run?: typeof defaultRun; moveStatus?: typeof moveProjectStatus; blockedReason?: string;
          removeWorktree?: typeof removeClaimedWorktree; keepWorktree?: boolean; predecessorGone?: boolean; answer?: string;
          fetchComments?: typeof fetchClaimComments; recordGone?: typeof recordPredecessorGone;
      } = {}): { declined: true; restoredReady: boolean; blocked: boolean; closed: boolean; statusMoved: true; } |
{
    declined: true; restoredReady: true; blocked: false; closed: false; statusMoved: false;
    notOnBoard: boolean; statusReason: string;
} |
{ declined: false; reason: string; } {
  if (blockedReason && answer) {
    return { declined: false, reason: "--blocked and --answer are two different releases (a finding vs. a ruling owed); give one" };
  }
  const before = fetchLabels(issueNumber, { run });
  const status = claimStatus(before.labels);
  const ownershipReason = declineOwnershipReason(status, mySession);
  if (ownershipReason) return { declined: false, reason: ownershipReason };
  // #987: THE RECORDED OBJECTS COME FROM THE CLAIM COMMENT NOW, with the old `worktree:` label as a
  // migration read for the three open rows that still carry one -- `claimedObjects`' own header carries
  // the count and the command that says when the fallback can go. Read AFTER the ownership check, so a
  // decline this session was never entitled to make costs no extra `gh` call.
  const recorded = claimedObjects({ labels: before.labels, comments: fetchComments(issueNumber, { run }) });
  const landed: string[] = [];
  // #1399: as `writeRowLabels` -- from the worktree removal on, a failure reports what it already changed.
  return withLandedWrites(issueNumber, landed, () => releaseRow(issueNumber,
    { run, moveStatus, blockedReason, removeWorktree, keepWorktree, predecessorGone, answer, mySession, before, status, recorded, landed, recordGone }));
}

/**
 * #1399: `declineRow` from the worktree removal on -- every write recorded in `landed` as it succeeds.
 * @param {number} issueNumber
 * @param {{ run: typeof defaultRun, moveStatus: typeof moveProjectStatus, blockedReason?: string,
 *   removeWorktree: typeof removeClaimedWorktree, keepWorktree: boolean, predecessorGone: boolean, answer?: string, mySession: string,
 *   before: IssueClaim, status: ReturnType<typeof claimStatus>, recorded: { branch: string | null, worktree: string | null, nothing?: true },
 *   landed: string[], recordGone: typeof recordPredecessorGone }} state
 * @returns {ReturnType<typeof declineRow>}
 */
function releaseRow(issueNumber: number,
  { run, moveStatus, blockedReason, removeWorktree, keepWorktree, predecessorGone, answer, mySession, before, status, recorded, landed, recordGone }: {
      run: typeof defaultRun; moveStatus: typeof moveProjectStatus; blockedReason?: string;
      removeWorktree: typeof removeClaimedWorktree; keepWorktree: boolean; predecessorGone: boolean; answer?: string; mySession: string;
      before: IssueClaim; status: ReturnType<typeof claimStatus>; recorded: { branch: string | null; worktree: string | null; nothing?: true; };
      landed: string[]; recordGone: typeof recordPredecessorGone;
  }): ReturnType<typeof declineRow> {
  // #665: THE WORKTREE COMES OFF FIRST, before any label is touched -- a dirty one refuses the WHOLE
  // decline (see this function's own header for why), so the claim record stays intact until an operator
  // has dealt with the uncommitted work by hand.
  if (recorded.worktree && keepWorktree) {
    landed.push(`KEPT the recorded worktree ${recorded.worktree} (#2470: it holds the released instance's work)`);
    // #2748 (reviewer-2754's second verdict): a --keep-worktree decline is NOT by itself proof the
    // predecessor is gone -- a standing engineer's stalled release keeps its process running (#2470 (6)),
    // so only an EXPLICIT --predecessor-gone assertion from a caller that actually knows writes the record.
    if (predecessorGone) recordGone(mySession);
  } else if (recorded.worktree) {
    const removal = removeWorktree(recorded.worktree, { run, session: mySession, branch: recorded.branch });
    if (!removal.removed) return { declined: false, reason: removal.reason };
    landed.push(`removed the recorded worktree ${recorded.worktree}`);
  }

  const isClosed = before.state === "CLOSED";
  const wasReady = before.labels.includes(WAS_READY_LABEL);
  const keepsState = before.labels.some((l) => l !== CLAIM_LABEL && STATE_LABELS.includes(l));
  const { restoreReady, addLabels } = declineAddLabels({ isClosed, wasReady, blockedReason, answer, keepsState });
  const removeLabels = declineRemoveLabels(status, mySession, wasReady);
  writeDeclineLabels(issueNumber, removeLabels, addLabels, { run, landed, closed: isClosed });

  // #987: AND THE RELEASE GOES ON THE RECORD, so the newest claim-record comment stops naming a worktree
  // this call has just removed.
  postReleaseRecord(issueNumber, { session: mySession, recorded }, run);
  if (recorded.branch || recorded.worktree || recorded.nothing) landed.push("posted the release record");

  if (blockedReason && !isClosed) {
    // A LABEL CARRIES NO FREE TEXT -- the reason has to live somewhere a future reader can see it, and an
    // issue comment is where every other "record why" in this codebase already puts one
    // (board-report.mjs, npm-token-liveness.mjs).
    run("gh", ["issue", "comment", String(issueNumber), "--repo", REPO, "--body",
      `Declined by \`${mySession}\` and marked \`blocked\`: ${blockedReason}`]);
    landed.push("posted the blocked reason");
  }

  if (isClosed) {
    // NO STATUS MOVE -- a closed row is off the board's lanes entirely, and `statusMoved: true` here
    // means the identical "nothing needed moving" reading the other no-restore branch already uses.
    return { declined: true, restoredReady: false, blocked: false, closed: true, statusMoved: true };
  }
  if (!restoreReady) {
    // Neither a genuine restore (nothing to move to "Ready" for) nor a verified "Blocked" Status option
    // exists to move to instead -- labels only, per this row's own stated Region. `statusMoved: true` here
    // means "nothing needed moving", not "something moved"; it reads as a clean decline either way.
    return { declined: true, restoredReady: false, blocked: Boolean(blockedReason), closed: false, statusMoved: true };
  }
  // #400: THE MATCHING MOVE ON RELEASE. "Genuinely unclaimed" and "Ready" are the same state in this
  // tracker's own model (`ready-label-audit.mjs`'s definition: a row cannot be both "unclaimed, pickable"
  // and "claimed"), so a decline moves the view back the same way a claim moved it forward. Never throws;
  // see `moveProjectStatus`'s own comment for why an unexpected failure here is surfaced distinctly rather
  // than folded into a plain `declined: true`.
  const statusResult = moveStatus(issueNumber, "Ready", { run });
  if (statusResult.moved) {
    return { declined: true, restoredReady: true, blocked: false, closed: false, statusMoved: true };
  }
  return { declined: true, restoredReady: true, blocked: false, closed: false, statusMoved: false,
    notOnBoard: statusResult.notOnBoard, statusReason: statusResult.reason };
}

/** @returns {string} the check/conflict log's path -- shared across every worktree, per `gitCommonDir`. */
export function checkLogPath(): string {
  return `${gitCommonDir()}/row-claim-check-log.jsonl`;
}

/**
 * Appends ONE `check` verdict -- called on EVERY `check`/`--row=` invocation, whatever it found. This is
 * the log's DENOMINATOR (#226): without an entry for every ask, a reader can never tell "the tool has been
 * asked N times and wrong M of them" from "the tool has only ever been asked when someone suspected it".
 *
 * #2617: `tracker` is the key of the tracker the row is in, present ONLY for a non-empty key -- so a first-tracker entry is the line it always
 * was, and a second tracker's `check 7` cannot be read as the first's (`latestCheckFor`).
 *
 * @param {string} logPath
 * @param {{ issueNumber: number, tracker?: string, claimed: boolean, started: boolean, sessions: string[],
 *           reachability: { code: number | null, output: string } | null }} entry
 */
export function recordCheck(logPath: string, entry: {
        issueNumber: number; tracker?: string; claimed: boolean; started: boolean; sessions: string[];
        reachability: { code: number | null; output: string; } | null;
    }) {
  appendJsonl(logPath, { kind: "check", at: new Date().toISOString(), ...entry });
}

/**
 * Appends ONE `conflict` -- a worker's own finding, paired with the tool's most recently recorded verdict
 * for the SAME issue. This is the log's NUMERATOR. `recordedVerdict` is whatever `latestCheckFor` returned
 * -- `null` when nobody ever ran `check` on this issue first, which is itself worth keeping rather than
 * inventing a verdict that was never given.
 *
 * @param {string} logPath
 * @param {{ issueNumber: number, recordedVerdict: object | null, found: string }} entry
 */
export function recordConflict(logPath: string, entry: { issueNumber: number; recordedVerdict: object | null; found: string; }) {
  appendJsonl(logPath, { kind: "conflict", at: new Date().toISOString(), ...entry });
}

/**
 * The most recently recorded `check` entry for an issue, or `null` if `check` was never run against it --
 * mirrors `merge-guard.mjs`'s `latestVerdictFor` exactly, one field renamed.
 *
 * @param {string} logPath
 * @param {number} issueNumber
 * @returns {Record<string, any> | null}
 */
export function latestCheckFor(logPath: string, issueNumber: number): Record<string, any> | null {
  let text: string;
  try {
    text = readFileSync(logPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const entries = text.split("\n").filter(Boolean).map((line) => JSON.parse(line))
    // #2617: `conflict` is the first tracker's alone, so a `check` of ANOTHER tracker's row of this number is not its verdict.
    .filter((entry) => entry.kind === "check" && entry.issueNumber === issueNumber && (entry.tracker ?? "") === "");
  return entries.length > 0 ? entries[entries.length - 1] : null;
}

/**
 * Records the `check` verdict without letting a LOGGING failure read as a CLAIM-DETERMINATION failure --
 * the same distinction `reportReachability`'s own doc draws for reachability. A full disk should not turn
 * a correctly-answered `check` into `COULD NOT DETERMINE`.
 *
 * @param {Parameters<typeof recordCheck>[1]} entry
 */
function recordCheckSafely(entry: Parameters<typeof recordCheck>[1]) {
  try {
    recordCheck(checkLogPath(), entry);
  } catch (error) {
    process.stderr.write(`row-claim: could not record this check to the log -- the answer above is still `
      + `correct. ${(error as Error).message}\n`);
  }
}

function usage() {
  return "Usage:\n"
    + "  node packages/agent-org/src/row-claim.mjs --row=<issue-number>                       (status: three states)\n"
    + "  node packages/agent-org/src/row-claim.mjs check <issue-number> [--tracker=<key>]     (alias of --row=; #2617: --tracker= reads a row of that tracker of `.agent-org/project.json`, and claim/dispatch/decline/conflict there are refused before any write)\n"
    + "  node packages/agent-org/src/row-claim.mjs dispatch <issue-number> --session=<name>   (mark taken at dispatch)\n"
    + "  node packages/agent-org/src/row-claim.mjs claim <issue-number> --session=<name> [--branch=<name>] "
    + "[--worktree=<path>] [--adopt=<session>] [--blocked-by=#N]  (mark started; #2470: --adopt claims that session's EXISTING tree in place instead of creating one; #2748: omitting --adopt still does this when the target is your OWN --session's already-stamped tree and your predecessor instance is independently confirmed gone, never merely quiet; #1432: given both, CREATES the worktree at <path> on new branch <name> from origin/main, refusing first if either exists; #656/#665: records the branch and worktree "
    + "-- #987: in a claim COMMENT, so a path of ANY length works, where a label capped it at 41 characters, "
    + "so a future escalation can tell portable from held, and decline can remove the worktree safely; "
    + "#741: --blocked-by releases B2 only with a measurement comment already on this session's own open "
    + "PR, and only while #N is open)\n"
    + "  node packages/agent-org/src/row-claim.mjs decline <issue-number> --session=<name> [--keep-worktree] "
    + "[--predecessor-gone] [--answer=<session>]    (give it back; #665: also "
    + "removes the recorded worktree, refusing by name if it is dirty; #2470: --keep-worktree leaves it, with its work, and "
    + "#2748: --predecessor-gone additionally attests --session's holder is confirmed gone (never implied by --keep-worktree "
    + "alone), so an ordinary same-session reclaim can later adopt the tree it left; "
    + `--answer= releases to that session's \`${ANSWER_PREFIX}\` label instead of \`${READY_LABEL}\`)\n`
    + "  node packages/agent-org/src/row-claim.mjs conflict <issue-number> --found=<text>     (#226: reality differed)\n";
}

/**
 * Renders the three-state read `claimStatus` makes possible, shared by `--row=` and `check`. A boolean
 * "claimed" cannot express the state #176 is about -- see the file header.
 *
 * UNCLAIMED IS NOT THE SAME AS STARTABLE (#177), and the labels cannot tell you which. Three rows on
 * 2026-09-07 were `ready`, not `fleet-gated`, correctly classified, and unstartable: one held by an
 * unmerged branch, one whose step 1 could not reproduce on `main`, and one whose SUBJECT existed on a
 * single open PR and nowhere else. A worker should learn that here rather than at step 1, which is where
 * the evening goes -- so an unclaimed row also gets `reportReachability`'s answer, REPORTED, NEVER
 * ENFORCED: the exit code below is untouched, because the inference is coarse (the blocking PR may land
 * in ten minutes, or the worker may mean to build on that branch) and a check that refuses a claim on it
 * would be bypassed and then not consulted at all.
 *
 * @param {number} issueNumber
 * @param {string} title
 * @param {{ claimed: boolean, started: boolean, sessions: string[], branch: string | null, worktree: string | null }} status
 * @param {{ body: string | null, recorded: { branch: string | null, worktree: string | null } }} read
 *   `body` is the row's raw body, for #771's `Filed-by:` line -- `null` on a failed lookup, printed
 *   distinctly from a genuinely absent line (CANNOT_ASK is not "unrecorded"). `recorded` is #987's
 *   branch/worktree, resolved from the claim comment rather than from `status`'s labels; bundled with
 *   `body` rather than added as a fifth parameter, per this repo's own argument-object convention.
 */
function renderStatus(issueNumber: number, title: string, status: { claimed: boolean; started: boolean; sessions: string[]; branch: string | null; worktree: string | null; }, { body, recorded }: { body: string | null; recorded: { branch: string | null; worktree: string | null; }; }) {
  // #771: printed for BOTH branches below -- who filed a row is a fact about the row, independent of
  // whether it is currently claimed.
  const filedBy = body === null ? "(could not read body)" : filedByLine(body) ?? "unrecorded";
  if (!status.claimed) {
    process.stdout.write(`UNCLAIMED -- #${issueNumber} "${title}" -- Filed-by: ${filedBy}\n`);
    process.exitCode = 0;
    const reachability = reportReachability(issueNumber);
    // #1063: and B4, read-only. Printed AFTER reachability because it is the narrower question: the
    // reachability report is about whether the work can start at all, this is about whether the claim
    // will be allowed.
    reportB4(issueNumber);
    recordCheckSafely({ issueNumber, claimed: false, started: false, sessions: [], reachability });
    return;
  }
  const by = status.sessions.length > 0 ? status.sessions.join(", ") : "someone (no session label yet)";
  const state = status.started ? "STARTED" : "DISPATCHED (not started)";
  // #656: THE RECORDED BRANCH, so a session weighing whether to escalate can tell a portable claim (no
  // branch recorded, or none checked out here) from a held one BEFORE it ever tries `git worktree add`
  // on the branch name -- exactly the check the dispatcher's own #614 attempt had no way to make first.
  const branchSuffix = recorded.branch ? `, branch ${recorded.branch}` : "";
  // #665: THE RECORDED WORKTREE, for the identical reason -- and so a session reading a stale-looking
  // claim can see, from the board alone, whether a local directory is what is actually holding it open.
  const worktreeSuffix = recorded.worktree ? `, worktree ${recorded.worktree}` : "";
  process.stdout.write(`${state} by ${by}${branchSuffix}${worktreeSuffix} -- #${issueNumber} "${title}" `
    + `-- Filed-by: ${filedBy}\n`);
  process.exitCode = 1;
  recordCheckSafely({ issueNumber, claimed: true, started: status.started, sessions: status.sessions,
    reachability: null });
}

/**
 * #2617: A PULL REQUEST NAMED IN A LINE -- `#7` for the first repository's, which is a number and always was, and `owner/repo#7`
 * (already a string) for another's, because two repositories both have a #7.
 * @param {number | string} pr
 * @returns {string}
 */
function prLabel(pr: number | string): string {
  return typeof pr === "number" ? `#${pr}` : pr;
}

/**
 * #1063: B4'S OWN VERDICT, ON THE READ PATH -- pure, so both outcomes are drivable.
 *
 * `check` used to say "IT DOES NOT RUN B4" and mean it: the overlap rule lived only on the claim path, so
 * the command an agent runs to DECIDE whether to claim did not run the rule that decides whether the
 * claim is allowed. #1054 closed the half that could be closed honestly -- `check` reads the same declared
 * Region B4 reads, and its verdict NAMED the rule it was not running. This runs it.
 *
 * WHY THE PREDICTION WAS NOT ENOUGH. #1056's line inferred the refusal from "an OPEN PR holds a file".
 * B4 itself excludes `.changeset/` on both sides, surfaces an OPEN PR whose file list reads empty as a
 * diagnostic rather than folding it into "no conflict", and names the PR and the exact files. A reader got
 * a weaker, hand-derived answer from the command they run FIRST and the real one only by attempting the
 * write.
 *
 * READ-ONLY IS THE WHOLE CONSTRAINT, AND IT IS HELD BY CONSTRUCTION RATHER THAN BY ASSERTION -- said here
 * so the next reader does not go looking for the test. `fileOverlapReason` is pure over two lists;
 * `lookupOpenPrFiles` is one `gh pr list --json number,changedFiles,files`, paging REST only for a PR whose list
 * is short of its count (#1419). Neither writes, and neither can: there is
 * no write path in this function's import closure to assert the absence of. This is the READ standing in for the write, which
 * is the thing #1054 exists because it was not.
 *
 * A FAILED LOOKUP IS INCONCLUSIVE, NEVER "NO OVERLAP" -- `lookupOpenPrFiles` and `lookupMyRegionFiles`
 * both return `null` when they could not ask, and a null read here would otherwise print the same silence
 * as a clean one. That conflation is the defect this file's own `startability` refuses one level up.
 *
 * @param {string[] | null} myFiles this row's declared Region, or null when it could not be read
 * @param {{ number: number, files: string[], changedFiles: number, closes?: number[], repo?: string, repoKey?: string }[] | null} otherPrFiles every
 *   other open PR, its files, its count (#1419), and the rows it declares it closes (#2101), or null. (#2617) `repo` and `repoKey` name a pull
 *   request of a repository other than the first
 * @param {number | null} [rowNumber] the row this is being asked about (#2101), so its own pull request is
 *   excluded. `check` knows it and passes it; omitting it is the unconditional B4 of before.
 * @returns {string[]} lines to print -- NEVER empty. Three states, three sentences: refused,
 *   could-not-ask, clear. It said "empty only when B4 genuinely found no overlap" until #1085's review,
 *   which is the shape this repo records most: a doc line two lines above the function, stating what the
 *   code used to do, in the place it will be believed.
 */
export function b4Lines(myFiles: string[] | null, otherPrFiles: { number: number; files: string[]; changedFiles: number; closes?: number[]; repo?: string; repoKey?: string; }[] | null, rowNumber: number | null = null): string[] {
  if (myFiles === null || otherPrFiles === null) {
    return ["B4 COULD NOT BE ASKED: the open pull requests or this row's Region could not be read. "
      + "INCONCLUSIVE, not clear -- `row-claim claim` asks again and may refuse."];
  }
  const { reason, emptyOtherPrs } = fileOverlapReason(myFiles, otherPrFiles, { rowNumber });
  const lines = [];
  // THREE STATES, THREE SENTENCES -- worker-capture reviewing #1085. The first version printed a refusal,
  // announced INCONCLUSIVE, and said NOTHING when clear. So `row-claim check` on a clean row was
  // byte-identical to `row-reachability.mjs` run standalone, while the verdict above promised the reader
  // they had the B4 half. **I closed the null-versus-clean conflation inside this function and left the
  // clean-versus-not-run one open at its edge**, which is the same defect one step out.
  lines.push(reason
    ? `B4 REFUSES THIS CLAIM: ${reason}`
    : "B4: no open pull request holds any file in this row's Region.");
  if (emptyOtherPrs.length > 0) {
    lines.push(`  NOTE: ${emptyOtherPrs.map(prLabel).join(", ")} read as touching NO files. An open PR with an empty `
      + "file list is a stale reading, not a clean one -- B4's own #462 finding.");
  }
  return lines;
}

/**
 * #1063: the lookup, the verdict and the printing, in one exported unit -- because MUTATION FOUND THE
 * WIRING UNHELD. `b4Lines` was covered four ways and `if (b4.length > 0) process.stdout.write(...)` at the
 * call site was **0 red**: the function could be perfect and never reached.
 *
 * That is the shape this session has now hit three times in its own work -- the seam driven, the call site
 * not -- so the printing moved in here where a spy can hold it. **What remains unheld is one line**:
 * `renderStatus`'s call to this function. Each extraction moves the unheld surface up one level rather
 * than removing it, and saying which line is left is the honest end of that regress.
 *
 * #2617: `repo` is the TRACKER the row lives in. It reaches the Region read and tells B4 whose rows a `Closes` names; the pull requests it
 * compares against are every declared code repository's regardless.
 *
 * @param {number} issueNumber
 * @param {{ write?: (s: string) => void,
 *   repo?: string,
 *   mine?: (n: number, where?: { repo?: string }) => string[] | null,
 *   others?: (where?: { trackerRepo?: string }) => { number: number, files: string[], changedFiles: number, closes?: number[] }[] | null,
 *   claimed?: (where?: { repo?: string }) => { number: number, files: string[], blockedBy: number[] }[] | null }} [deps]
 */
export function reportB4(issueNumber: number, deps: {
    write?: (s: string) => void;
    repo?: string;
    mine?: (n: number, where?: { repo?: string; }) => string[] | null;
    others?: (where?: { trackerRepo?: string; }) => { number: number; files: string[]; changedFiles: number; closes?: number[]; }[] | null;
    claimed?: (where?: { repo?: string; }) => { number: number; files: string[]; blockedBy: number[]; }[] | null;
} = {}) {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const mine = deps.mine ?? lookupMyRegionFiles;
  const others = deps.others ?? lookupOpenPrFiles;
  // NO EMPTINESS GUARD, because `b4Lines` is never empty -- and a dead guard reads as a live one. It was
  // here until #1085's review: the `reportB4 never writes` mutation was 1 red and this `if` is what that
  // red would have been credited to, so the next person mutating here would conclude the empty case was
  // covered by a branch that can no longer be taken.
  const myFiles = mine(issueNumber, { repo: deps.repo });
  const otherPrs = others({ trackerRepo: deps.repo });
  const lines = b4Lines(myFiles, otherPrs, issueNumber);
  // #3475: THE CLAIMED-ROW HALF, only when the first half could be asked -- a failed read there has already said INCONCLUSIVE.
  if (myFiles !== null && otherPrs !== null) lines.push(claimedB4Line(myFiles, issueNumber, otherPrs, deps));
  write(`${lines.join("\n")}\n`);
}

/**
 * #3475: `check`'s sentence for the claimed-row half of B4: refused, could-not-ask, or clear -- the claim's own verdict, read-only.
 * The asking row's own `blockedBy` edge is not read: the claim refuses on an open one before it gets to B4, so it never reaches here.
 * @param {string[]} myFiles @param {number} issueNumber @param {{ closes?: number[] | number | null }[]} openPrs
 * @param {{ repo?: string, claimed?: (where?: { repo?: string }) => { number: number, files: string[], blockedBy: number[] }[] | null }} deps
 * @returns {string}
 */
function claimedB4Line(myFiles: string[], issueNumber: number, openPrs: { closes?: number[] | number | null; }[], deps: { repo?: string; claimed?: (where?: { repo?: string; }) => { number: number; files: string[]; blockedBy: number[]; }[] | null; }): string {
  const claimed = (deps.claimed ?? lookupClaimedRegions)({ repo: deps.repo });
  if (claimed === null) return claimedRowsUnread("`row-claim claim` refuses on it.");
  const reason = myFiles.length === 0 ? null : claimedRegionsVerdict(myFiles, claimed, { issueNumber, openPrs });
  return reason ? `B4 REFUSES THIS CLAIM: ${reason}` : "B4: no row already claimed holds any file in this row's Region.";
}

/**
 * #2617: the row is read in the tracker `trackerKey` names (default the first). ITS OWN FUNCTION for a second tracker rather than a
 * parameter of `renderStatus`, because `renderStatus`'s unclaimed branch is pinned to call `reportB4(issueNumber)` literally
 * (`row-claim.test.ts`) and that is the first tracker's read exactly as it was.
 * @param {number} issueNumber @param {string} [trackerKey]
 */
function runStatus(issueNumber: number, trackerKey: string = "") {
  const found = trackerFor(trackerKey);
  if (!found.ok) {
    process.stderr.write(`COULD NOT DETERMINE: ${found.reason}\n`);
    process.exitCode = 2;
    return;
  }
  const { repo } = found.tracker;
  try {
    const { labels, title } = fetchLabels(issueNumber, { repo });
    // #771: same injected-`run` shape `writeRowLabels` already uses for the identical lookup.
    const ghRunForBody = (args: string[]) => defaultRun("gh", args);
    const body = lookupIssueBody(issueNumber, { run: ghRunForBody, repo });
    // #987: the recorded branch/worktree now live in a comment, so `check` reads the thread too. Same
    // `claimedObjects` resolution `declineRow` uses, so the two can never disagree about which directory
    // a claim is holding open.
    const recorded = claimedObjects({ labels, comments: fetchClaimComments(issueNumber, { repo }) });
    if (trackerKey !== "") {
      renderTrackerStatus(found.tracker, { issueNumber, title, status: claimStatus(labels), body, recorded });
      return;
    }
    renderStatus(issueNumber, title, claimStatus(labels), { body, recorded });
  } catch (error) {
    process.stderr.write(`COULD NOT DETERMINE: ${(error as Error).message}\n`);
    process.exitCode = 2;
  }
}

/**
 * #2617: `renderStatus` for a row of a tracker that is not the first: the same three-state answer and the same B4, named `<key>#<n>` (decision 2)
 * so two trackers' row 7 read as two rows, and with the reachability read left out and SAID to be -- `row-reachability.mjs` reads the first
 * tracker's rows and would answer about the wrong one. The log entry carries the key, so it is never taken for the first tracker's `check`.
 * @param {Tracker} tracker
 * @param {{ issueNumber: number, title: string, status: ReturnType<typeof claimStatus>, body: string | null,
 *   recorded: { branch: string | null, worktree: string | null } }} row
 */
function renderTrackerStatus(tracker: Tracker, { issueNumber, title, status, body, recorded }: {
        issueNumber: number; title: string; status: ReturnType<typeof claimStatus>; body: string | null;
        recorded: { branch: string | null; worktree: string | null; };
    }) {
  const name = `${tracker.key}#${issueNumber}`;
  const filedBy = body === null ? "(could not read body)" : filedByLine(body) ?? "unrecorded";
  if (!status.claimed) {
    process.stdout.write(`UNCLAIMED -- ${name} "${title}" -- Filed-by: ${filedBy}\n`);
    process.stdout.write(`REACHABILITY: not run for ${name} -- \`row-reachability.mjs\` reads the first tracker's rows only, so its answer would be about another row (#2617).\n`);
    reportB4(issueNumber, { repo: tracker.repo });
    process.exitCode = 0;
    recordCheckSafely({ issueNumber, tracker: tracker.key, claimed: false, started: false, sessions: [], reachability: null });
    return;
  }
  const by = status.sessions.length > 0 ? status.sessions.join(", ") : "someone (no session label yet)";
  const state = status.started ? "STARTED" : "DISPATCHED (not started)";
  const branchSuffix = recorded.branch ? `, branch ${recorded.branch}` : "";
  const worktreeSuffix = recorded.worktree ? `, worktree ${recorded.worktree}` : "";
  process.stdout.write(`${state} by ${by}${branchSuffix}${worktreeSuffix} -- ${name} "${title}" -- Filed-by: ${filedBy}\n`);
  process.exitCode = 1;
  recordCheckSafely({ issueNumber, tracker: tracker.key, claimed: true, started: status.started, sessions: status.sessions, reachability: null });
}

/**
 * Pure: the one-line summary of a successful dispatch/claim -- pulled out of `runDispatchOrClaim` to keep
 * that function's own complexity below the lint gate. `record` bundles `branch`/`worktree` rather than
 * two more positional parameters, per this repo's own "no boolean-flag-shaped argument lists" convention.
 * @param {"dispatch" | "claim"} mode
 * @param {number} issueNumber
 * @param {string} mySession
 * @param {{ branch?: string, worktree?: string, adopt?: string, replacedTip?: string }} record
 * @returns {string}
 */
export function claimLineFor(mode: "dispatch" | "claim", issueNumber: number, mySession: string, { branch, worktree, adopt, replacedTip }: { branch?: string; worktree?: string; adopt?: string; replacedTip?: string; }): string {
  const label = mode === "dispatch" ? "DISPATCHED" : "STARTED";
  const startedSuffix = mode === "claim" ? ` / ${STARTED_LABEL}` : "";
  // #987: `branch <name>`, not `branch:<name>` -- the colon form named a LABEL, and this claim no longer
  // writes one. The same two facts are in the claim-record comment, and saying `branch:` here would tell a
  // reader to go looking for a label that is not there.
  const branchSuffix = mode === "claim" && branch ? ` / branch ${branch}` : "";
  const worktreeSuffix = mode === "claim" && worktree ? ` / worktree ${worktree}${adopt ? ` (ADOPTED from ${adopt}, work kept)` : ""}` : "";
  // #3745: the leftover branch's tip, so a reader can find what the name held; it is an ancestor of origin/main by construction.
  const replacedSuffix = replacedTip ? ` (recreated over a leftover branch merged into origin/main, old tip ${replacedTip})` : "";
  return `${label} -- #${issueNumber} is now ${CLAIM_LABEL} / session:${mySession}`
    + `${startedSuffix}${branchSuffix}${worktreeSuffix}${replacedSuffix}`;
}

/**
 * #1432: which write a `dispatch`/`claim` CLI makes -- a claim given a branch and worktree creates them first.
 * @param {"dispatch" | "claim"} mode @param {number} issueNumber @param {string} mySession
 * @param {{ branch?: string, worktree?: string, blockedBy?: string, adopt?: string }} flags
 */
function claimOrDispatch(mode: "dispatch" | "claim", issueNumber: number, mySession: string, { branch, worktree, blockedBy, adopt }: { branch?: string; worktree?: string; blockedBy?: string; adopt?: string; }) {
  if (mode === "dispatch") return dispatchRow(issueNumber, mySession);
  const claimDeps = { blockedBy, drained: drainedNow(), instance: instanceNow(mySession, issueNumber), persistent: persistentNow(mySession) };
  if (branch && worktree) return claimWithWorktree(issueNumber, mySession, { branch, worktree, adopt, claimDeps });
  return claimRow(issueNumber, mySession, claimDeps);
}

/**
 * #2324: the roles the drain holds back at the moment of THIS claim -- the same `activeDrain` `wake.mjs`'s router
 * reads, so the offer and the refusal cannot disagree. Read here, at the CLI, and not inside the library
 * functions: a test or another caller handing `claimRow` a session gets the claim's other rules and not a fact
 * about this host's ledger.
 *
 * FAILS OPEN AND SAYS SO, like B2/B4/#1886 beside it: a claim guard that stops every claim when a file is
 * unreadable gets bypassed and then never consulted. A lifted drain costs one avoidable claim; a stuck one
 * strands the row.
 * @returns {string[]}
 */
function drainedNow(): string[] {
  try {
    return activeDrain({ cycles: sparePathsFrom(ledgerPathFrom([])).cycles });
  } catch (error) {
    process.stderr.write(`row-claim: could not read the drain (${String((error as any)?.message ?? error)
      .split("\n")[0]}) -- claiming as though it were lifted (#2324).\n`);
    return [];
  }
}

/**
 * #3415: is the asking session a persistent seat, for {@link persistentReason} -- read here, at the CLI, as {@link drainedNow} is.
 * FAILS OPEN AND SAYS SO, like the drain: a claim guard that stops every claim when the roster is unreadable gets bypassed and
 * then never consulted, and the router's own refusal (`engineerEligibility`) still never offers the seat a row.
 * @param {string} mySession
 * @returns {boolean}
 */
function persistentNow(mySession: string): boolean {
  try {
    return isPersistentRole(mySession);
  } catch (error) {
    process.stderr.write(`row-claim: could not read the roster's persistent seats (${String((error as any)?.message ?? error)
      .split("\n")[0]}) -- claiming as though ${mySession} were not one (#3415).\n`);
    return false;
  }
}

/**
 * #2407: what the asking session's INSTANCE holds or has held, for {@link oneRowReason} -- read here, at the CLI, as
 * {@link drainedNow} is, so the rule takes a fact and not a host's files.
 *
 * ONLY A SPARE IS ASKED ABOUT: the mark is the roster's (`isSpareRole`), so a standing engineer costs no lookup and is
 * never refused. The rows are the registry beside the wake ledger (every row a tick has seen this instance hold, which
 * outlives the row's `session:` label) plus the open rows labelled with the session right now (which a tick may not
 * have observed yet). FAILS OPEN AND SAYS SO, like the drain: a claim guard that stops every claim when a file or the
 * API is unreadable gets bypassed and then never consulted, and a leak this misses is exactly what the ledger's
 * failed-cycle line records.
 * @param {string} mySession @param {number} issueNumber
 * @returns {{ spare: boolean, rows: number[] }}
 */
function instanceNow(mySession: string, issueNumber: number): { spare: boolean; rows: number[]; } {
  try {
    if (!isSpareRole(mySession)) return { spare: false, rows: [] };
    const registry = readSpareRegistry(sparePathsFrom(ledgerPathFrom([])).registry);
    const labelled = lookupOtherHeldIssues(mySession, issueNumber);
    if (labelled === null) {
      process.stderr.write(`row-claim: could not read the rows ${mySession} holds -- using only the registry (#2407).\n`);
    }
    return { spare: true, rows: [...(registry[mySession]?.rows ?? []), ...(labelled ?? [])] };
  } catch (error) {
    process.stderr.write(`row-claim: could not read the instance's rows (${String((error as any)?.message ?? error)
      .split("\n")[0]}) -- claiming as though it held none (#2407).\n`);
    return { spare: false, rows: [] };
  }
}

/**
 * #2617: `decline` and `conflict`, BEFORE EITHER READS A THING -- a second tracker's row of this number must never be acted on as the first's.
 * @param {"decline" | "conflict"} mode @param {number} issueNumber @param {string[]} rest
 */
function runDeclineOrConflict(mode: "decline" | "conflict", issueNumber: number, rest: string[]) {
  const refusal = trackerClaimRefusal({ mode, key: trackerKeyOf(rest), number: issueNumber });
  if (refusal) {
    process.stdout.write(`NOT CLAIMED: ${refusal}\n`);
    process.exitCode = 1;
    return;
  }
  if (mode === "decline") runDecline(issueNumber, rest);
  else runConflict(issueNumber, rest);
}

/**
 * #2617: the tracker key a command names with `--tracker=<key>`; the EMPTY key, the first tracker, when it names none.
 * @param {string[]} args
 * @returns {string}
 */
function trackerKeyOf(args: string[]): string {
  return args.find((a) => a.startsWith("--tracker="))?.slice("--tracker=".length) ?? "";
}

/**
 * #2748: the CLI's `--adopt=` value, resolving the implicit case -- pulled out of `runDispatchOrClaim` to keep
 * that function's own complexity below the lint gate, same reason `drainedNow`/`instanceNow` were. Nobody types
 * `--adopt=<name>` naming THEMSELVES -- a same-session respawn just runs the ordinary claim command, which is
 * why it used to refuse on its own predecessor's leftovers. Resolved once, here, so both the claim and the
 * printed line (`claimLineFor`) agree on what actually happened.
 * @param {"dispatch" | "claim"} mode @param {string} mySession
 * @param {{ adoptFlag?: string, branch?: string, worktree?: string }} flags
 * @returns {string | undefined}
 */
export function adoptFor(mode: "dispatch" | "claim", mySession: string, { adoptFlag, branch, worktree }: { adoptFlag?: string; branch?: string; worktree?: string; }): string | undefined {
  if (adoptFlag !== undefined) return adoptFlag;
  if (mode !== "claim" || !branch || !worktree) return undefined;
  return implicitAdoptSession({ worktree, mySession, exists: existsSync, owner: worktreeOwner, predecessorGone: predecessorGoneReading,
    clean: (tree) => worktreeCleanliness({ worktree: tree, branch }).clean });
}

/**
 * @param {"dispatch" | "claim"} mode
 * @param {number} issueNumber
 * @param {string[]} rest
 */
function runDispatchOrClaim(mode: "dispatch" | "claim", issueNumber: number, rest: string[]) {
  const sessionFlag = rest.find((a) => a.startsWith("--session="));
  const mySession = sessionFlag?.slice("--session=".length);
  if (!mySession) {
    process.stderr.write(`row-claim ${mode}: --session=<name> is required\n${usage()}`);
    process.exitCode = 2;
    return;
  }
  // #656/#665: `--branch=`/`--worktree=` ONLY MEAN ANYTHING FOR `claim` -- a dispatch precedes either
  // existing, so `dispatchRow` never reads them (it does not accept those deps at all); silently ignoring
  // them on `dispatch` rather than refusing here matches `wasReady`'s own "unused declaration is a
  // warning, never a hard error" tolerance elsewhere in this file, not a new inconsistency.
  const branchFlag = rest.find((a) => a.startsWith("--branch="));
  const branch = branchFlag?.slice("--branch=".length);
  const worktreeFlag = rest.find((a) => a.startsWith("--worktree="));
  const worktree = worktreeFlag?.slice("--worktree=".length);
  // #741: `--blocked-by=` ONLY MEANS ANYTHING FOR `claim`, for the identical reason `--branch=`/
  // `--worktree=` do -- a dispatch precedes any of this session's own PR existing at all.
  const blockedByFlag = rest.find((a) => a.startsWith("--blocked-by="));
  const blockedBy = blockedByFlag?.slice("--blocked-by=".length);
  // #2470: `--adopt=<session>` claims that session's EXISTING tree in place (the respawn of a released row starts in the work).
  const adoptFlag = rest.find((a) => a.startsWith("--adopt="))?.slice("--adopt=".length);
  const adopt = adoptFor(mode, mySession, { adoptFlag, branch, worktree });
  const flagsReason = mode === "claim" ? worktreeFlagsReason({ branch, worktree, adopt }) : null;
  if (flagsReason) {
    process.stderr.write(`row-claim claim: ${flagsReason}\n`);
    process.exitCode = 2;
    return;
  }
  // #2617: A ROW OF ANOTHER TRACKER is named per decision 2 and, until its labels and board are built, refused before any write.
  const trackerRefusal = trackerClaimRefusal({ mode, key: trackerKeyOf(rest), number: issueNumber, session: mySession, worktree });
  if (trackerRefusal) {
    process.stdout.write(`NOT CLAIMED: ${trackerRefusal}\n`);
    process.exitCode = 1;
    return;
  }
  try {
    const result = claimOrDispatch(mode, issueNumber, mySession, { branch, worktree, blockedBy, adopt });
    if (result.claimed) {
      const claimLine = claimLineFor(mode, issueNumber, mySession, { branch, worktree, adopt,
        replacedTip: (result as { replacedTip?: string }).replacedTip });
      if (result.statusMoved) {
        process.stdout.write(`${claimLine}\n`);
        process.exitCode = 0;
      } else if (result.notOnBoard) {
        // #400's own acceptance case: a row with no Project item at all is a known, permitted gap, not a
        // failure -- the claim (the record) stands and this exits clean.
        process.stdout.write(`${claimLine} (not on the Project board -- Status view not applicable)\n`);
        process.exitCode = 0;
      } else {
        // ceo's ruling: a half-applied claim -- the label (the record) is written, but the board Status
        // write genuinely failed -- must never look like the plain success above. Exit code 3, distinct
        // from 0 (clean), 1 (not claimed) and 2 (could not determine at all).
        process.stdout.write(`${claimLine}, BUT the Project Status could not be moved to match: `
          + `${result.statusReason}\n`);
        process.exitCode = 3;
      }
    } else {
      process.stdout.write(`NOT CLAIMED: ${result.reason}\n`);
      process.exitCode = 1;
    }
  } catch (error) {
    // #1399: a failure after a landed write exits LANDED_WRITE_EXIT and names the writes; otherwise exit 2.
    const report = failureReport(error);
    process.stderr.write(`${report.text}\n`);
    process.exitCode = report.exitCode;
  }
}

/**
 * #2470: `--keep-worktree` (leave the recorded tree in place) and `--answer=<session>` (release to that session's `answer:` label).
 * #2748: `--predecessor-gone` is a SEPARATE, explicit assertion -- never implied by `--keep-worktree` alone (reviewer-2754's second
 * verdict) -- that the session named by `--session=` is independently confirmed gone, not merely that its claim is being released.
 * @param {string[]} rest
 * @returns {{ keepWorktree: boolean, predecessorGone: boolean, answer: string | undefined } | { refusal: string }}
 */
function releaseFlags(rest: string[]): { keepWorktree: boolean; predecessorGone: boolean; answer: string | undefined; } | { refusal: string; } {
  const answer = rest.find((a) => a.startsWith("--answer="))?.slice("--answer=".length);
  if (rest.some((a) => a.startsWith("--answer=")) && !answer) return { refusal: "--answer=<session> needs a session, not an empty string" };
  return { keepWorktree: rest.includes("--keep-worktree"), predecessorGone: rest.includes("--predecessor-gone"), answer };
}

/**
 * @param {number} issueNumber
 * @param {string[]} rest
 */
function runDecline(issueNumber: number, rest: string[]) {
  const sessionFlag = rest.find((a) => a.startsWith("--session="));
  const mySession = sessionFlag?.slice("--session=".length);
  if (!mySession) {
    process.stderr.write(`row-claim decline: --session=<name> is required\n${usage()}`);
    process.exitCode = 2;
    return;
  }
  const blockedFlag = rest.find((a) => a.startsWith("--blocked="));
  const blockedReason = blockedFlag?.slice("--blocked=".length);
  if (blockedFlag && !blockedReason) {
    process.stderr.write(`row-claim decline: --blocked=<reason> needs a reason, not an empty string\n`);
    process.exitCode = 2;
    return;
  }
  const release = releaseFlags(rest);
  if ("refusal" in release) {
    process.stderr.write(`row-claim decline: ${release.refusal}\n`);
    process.exitCode = 2;
    return;
  }
  const { keepWorktree, predecessorGone, answer } = release;
  try {
    const result = declineRow(issueNumber, mySession, { blockedReason, keepWorktree, predecessorGone, answer });
    if (result.declined) {
      // #449/#752: WHAT CAME BACK, NOT JUST THAT SOMETHING DID -- the four shapes read differently to a
      // human deciding what happens next: restored (pickable again), blocked (a finding, do not repick
      // yet), closed (done -- "restored to ready" would be false on its face), or neither (was never
      // `ready`, unclaimed and no more startable than that already implies).
      const outcome = result.closed ? `; the row is CLOSED, so it is NOT returned to \`${READY_LABEL}\``
        : answer ? `and labelled \`${ANSWER_PREFIX}${answer}\` (NOT returned to \`${READY_LABEL}\`)`
        : result.blocked ? `and marked \`${BLOCKED_LABEL}\``
        : result.restoredReady ? `and restored to \`${READY_LABEL}\``
        : `(was not \`${READY_LABEL}\` before the claim -- not restored)`;
      if (result.statusMoved) {
        process.stdout.write(`DECLINED -- #${issueNumber} is unclaimed again ${outcome}\n`);
        process.exitCode = 0;
      } else if (result.notOnBoard) {
        process.stdout.write(`DECLINED -- #${issueNumber} is unclaimed again ${outcome} (not on the Project `
          + `board -- Status view not applicable)\n`);
        process.exitCode = 0;
      } else {
        process.stdout.write(`DECLINED -- #${issueNumber} is unclaimed again ${outcome}, BUT the Project `
          + `Status could not be moved to match: ${result.statusReason}\n`);
        process.exitCode = 3;
      }
    } else {
      process.stdout.write(`NOT DECLINED: ${result.reason}\n`);
      process.exitCode = 1;
    }
  } catch (error) {
    // #1399: a failure after a landed write exits LANDED_WRITE_EXIT and names the writes; otherwise exit 2.
    const report = failureReport(error);
    process.stderr.write(`${report.text}\n`);
    process.exitCode = report.exitCode;
  }
}

/**
 * A worker recording that reality differed from `check`'s own last-recorded verdict for this issue (#226)
 * -- CLOSED when it read startable, already built, a held region that turned out to matter, or the
 * inverse. Pairs the tool's verbatim answer with what was actually found, the same way `merge-guard`'s
 * `reconcile` pairs a recorded verdict with the real PR outcome -- except here nothing can look the real
 * outcome up automatically, so the worker who found it IS the reconciliation.
 *
 * @param {number} issueNumber
 * @param {string[]} rest
 */
function runConflict(issueNumber: number, rest: string[]) {
  const foundFlag = rest.find((a) => a.startsWith("--found="));
  const found = foundFlag?.slice("--found=".length);
  if (!found) {
    process.stderr.write(`row-claim conflict: --found=<what you found instead> is required\n${usage()}`);
    process.exitCode = 2;
    return;
  }
  try {
    const recordedVerdict = latestCheckFor(checkLogPath(), issueNumber);
    recordConflict(checkLogPath(), { issueNumber, recordedVerdict, found });
    const against = recordedVerdict
      ? `against the check recorded at ${recordedVerdict.at}`
      : "-- no prior `check` was ever recorded for this issue, so there is nothing to pair it against, "
        + "and that absence is itself recorded";
    process.stdout.write(`RECORDED -- #${issueNumber} conflict logged ${against}\n`);
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`COULD NOT RECORD: ${(error as Error).message}\n`);
    process.exitCode = 2;
  }
}

/**
 * EVERY FLAG THIS COMMAND ACCEPTS, exported so a test can drive the argv its callers build (`wake.mjs`'s claim, release and undo) through the
 * REAL list rather than a restated copy. #2841: `--predecessor-gone` was parsed below and sent by `performRelease` from #2748, but was
 * never added here, so every gone-worker release was refused at the guard before any parse -- each side was tested alone.
 */
export const ROW_CLAIM_FLAGS = ["--session", "--row=", "--found=", "--blocked=", "--branch=", "--worktree=",
  "--blocked-by=", "--keep-worktree", "--predecessor-gone", "--answer=", "--adopt=", "--tracker="];

async function main() {
  // THE PULL LOOP RESTS ON THIS COMMAND, so a flag it silently discards is the worst place for one.
  // Measured 2026-09-07 before this guard: `row-claim.mjs check 161 --jsonn` printed the ordinary claim
  // line and exited 0, and so did `--format=json`. Both look like a machine-readable request that was
  // honoured.
  //
  // `--row=` IS DECLARED ALONGSIDE `--session` because #197 added it while this branch was open: it is
  // the bare status-read shape below, and a guard listing only `--session` would refuse the command's
  // own documented invocation. A flag guard that has not been merged forward is a guard that breaks the
  // thing it protects.
  refuseUnknownFlags(ROW_CLAIM_FLAGS, { entry: import.meta.url, command: "node packages/agent-org/src/row-claim.mjs" });
  // #1352: FIRST OF ALL, where it was launched. From the primary checkout or a plain clone this refuses before any read,
  // exit 2 -- the "could not determine at all" outcome every consumer already classifies, as the stale-rule guard does.
  if (launchGate("row-claim")) {
    process.exitCode = 2;
    return;
  }
  // #1014: BEFORE ANY VERDICT, ask whether this checkout's copy of the rule is the current one. A refusal
  // printed from a retired rule names a policy the org no longer has, and nothing in the message says which
  // version produced it -- measured 2026-09-12, when BOTH halves of one refusal described rules replaced
  // four minutes apart. `COULD NOT DETERMINE` and exit 2 deliberately, not a new prefix: this is the
  // existing "could not determine at all" outcome, and every consumer already classifies it.
  //
  // AT THE ONE CHOKE POINT, not per mode. `check` prints the same rule-derived verdict `claim` does, so a
  // guard on the claim path alone would leave the read that people quote unheld -- this repository's most
  // expensive recurring shape is a remedy applied at one call site when the behaviour reaches several.
  const stale = staleRuleReason();
  if (stale) {
    process.stderr.write(`COULD NOT DETERMINE: ${stale}\n`);
    process.exitCode = 2;
    return;
  }
  const argv = process.argv.slice(2);
  const rowFlag = argv.find((a) => a.startsWith("--row="));

  // Bare `--row=<n>` (the acceptance's own invocation shape) is a status read with no mode word.
  if (rowFlag && argv[0] === rowFlag) {
    const issueNumber = Number(rowFlag.slice("--row=".length));
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      process.stderr.write(usage());
      process.exitCode = 2;
      return;
    }
    runStatus(issueNumber, trackerKeyOf(argv));
    return;
  }

  const [mode, issueArg, ...rest] = argv;
  const issueNumber = Number(issueArg);
  if (!mode || !Number.isInteger(issueNumber) || issueNumber <= 0) {
    process.stderr.write(usage());
    process.exitCode = 2;
    return;
  }

  if (mode === "check") {
    runStatus(issueNumber, trackerKeyOf(rest));
    return;
  }
  if (mode === "dispatch" || mode === "claim") {
    runDispatchOrClaim(mode, issueNumber, rest);
    return;
  }
  if (mode === "decline" || mode === "conflict") {
    runDeclineOrConflict(mode, issueNumber, rest);
    return;
  }

  process.stderr.write(usage());
  process.exitCode = 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  main();
}

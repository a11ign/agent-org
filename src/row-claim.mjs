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
import { fileURLToPath } from "node:url";
// RELATIVE, NOT the `@a11ign/worker-fleet/cli-flags` package specifier: that export map
// points at `dist/`, so it needs both `node_modules` AND a completed build. This file is reachable
// from a pre-install entry (see `pre-install-import-graph.test.ts`, which derives that population
// rather than naming it), and there it dies on startup with ERR_MODULE_NOT_FOUND.
import { refuseUnknownFlags } from "../../worker-fleet/src/cli-flags.mjs";
import { REPO } from "../../../scripts/repo-identity.mjs";
import { READY_LABEL, WAS_READY_LABEL } from "./ready-label-audit.mjs";
import { gitCommonDir, appendJsonl } from "./merge-guard.mjs";
import { withBoardSnapshot, PROJECT_OWNER, PROJECT_NUMBER } from "./board-snapshot.mjs";
import { runnerReason, laneReason } from "./row-claim/runner-rule.mjs";
import { inBuildReason, lookupHeldRows } from "./row-claim/own-pr-health-rule.mjs";
import { resolveBlockedByOverride, blockedByExceptionNote } from "./row-claim/blocked-by-rule.mjs";
import { fileOverlapReason, lookupMyRegionFiles, lookupOpenPrFiles } from "./row-claim/file-overlap-rule.mjs";
import { templateFieldsReason, lookupIssueBody } from "./row-claim/template-fields-rule.mjs";
import { staleRuleReason } from "./row-claim/stale-rule-guard.mjs";
import { sandboxGitEnv } from "../../guards/src/git-env.mjs";
import { primaryWorktreeOf, unverifiedRecords } from "./prune-worktrees.mjs";
import { CLAIM_LABEL, STARTED_LABEL } from "./claim-labels.mjs";
import { worktreeOwner, stampWorktree } from "./worktree-owner.mjs";
import { launchGate } from "./board-snapshot-scope.mjs";
import { assertNoLeakInArgv } from "../../lab/src/packaging/leak-patterns.mjs";

// #804: CLAIM_LABEL/STARTED_LABEL are IMPORTED (above) from the leaf claim-labels.mjs and re-exported
// here, not declared in this file -- see claim-labels.mjs's own header for why. Every existing
// `import { CLAIM_LABEL } from "./row-claim.mjs"` call site is unchanged. A bare `export {...} from`
// would forward the binding WITHOUT creating a local one, and this file's own code below needs the local
// name -- hence import-then-export as two separate statements rather than one re-export line.
export { CLAIM_LABEL, STARTED_LABEL };
export const BLOCKED_LABEL = "blocked";

/**
 * #771: the `Filed-by: <session>` line `row-file.mjs` writes, or `null` when absent -- a LITERAL line
 * match only. Older prose ("Filed by `orchestrator`", no hyphen, no colon-value structure) is NEVER
 * inferred as this: #737 and #758 both carry that sentence and both must read `unrecorded`, the same rule
 * #603's owned-path sign-off already applies to "I checked" standing in for a stated fact.
 * @param {string} body
 * @returns {string | null}
 */
export function filedByLine(body) {
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
export const CLAIM_RECORD_MARKER = "<!-- row-claim: claim record -->";
const CLAIM_RECORD_BRANCH = "Claimed-branch:";
const CLAIM_RECORD_WORKTREE = "Claimed-worktree:";

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
 * @param {{ session: string, branch?: string | null, worktree?: string | null, released?: boolean }} record
 * @returns {string}
 */
export function claimRecordComment({ session, branch, worktree, released = false }) {
  const what = released ? `released by \`${session}\`` : `claimed by \`${session}\``;
  const lines = released ? [] : [
    ...(branch ? [`${CLAIM_RECORD_BRANCH} ${branch}`] : []),
    ...(worktree ? [`${CLAIM_RECORD_WORKTREE} ${worktree}`] : []),
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
 * @returns {{ branch: string | null, worktree: string | null, recorded: boolean }}
 */
export function claimRecordFrom(comments) {
  const records = comments.filter((c) => c.includes(CLAIM_RECORD_MARKER));
  const newest = records.at(-1);
  if (newest === undefined) return { branch: null, worktree: null, recorded: false };
  const read = (/** @type {string} */ key) => {
    const match = new RegExp(`^${key}\\s*(.+)$`, "m").exec(newest);
    return match ? match[1].trim() : null;
  };
  return { branch: read(CLAIM_RECORD_BRANCH), worktree: read(CLAIM_RECORD_WORKTREE), recorded: true };
}

/**
 * #1432: Pure: the session the NEWEST claim-record comment was written by, or null -- null for no record, and for a
 * RELEASE, which names who released it and claims nothing.
 * @param {string[]} comments comment bodies, oldest first
 * @returns {string | null}
 */
export function claimRecordSession(comments) {
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
export function claimedObjects({ labels, comments }) {
  const fromComment = claimRecordFrom(comments);
  if (fromComment.recorded) return { branch: fromComment.branch, worktree: fromComment.worktree };
  const labelled = claimStatus(labels);
  return { branch: labelled.branch, worktree: labelled.worktree };
}

/**
 * @typedef {{ number: number, title: string, labels: string[], state?: "OPEN" | "CLOSED" }} IssueClaim
 */

/**
 * #709: `git worktree remove` (below) DESTROYS A DIRECTORY, and an unscrubbed spawn inherits any
 * `GIT_DIR`/`GIT_WORK_TREE` a caller's environment carries -- the exact shape that once redirected a
 * spawned git call onto the wrong repository. `sandboxGitEnv()` scrubs every `GIT_*` var; applying it to
 * every spawn here, `gh` included, costs nothing (`gh` reads none of them) and needs no second helper for
 * the one call that actually matters.
 * @type {(cmd: string, args: string[]) => string}
 */
const defaultRun = (cmd, args) => {
  assertNoLeakInArgv(cmd, args); // #1053: guarded in the SPAWN HELPER -- three comment writers below
  return execFileSync(cmd, args, { encoding: "utf8", env: sandboxGitEnv() });
};

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
 * @param {string[]} labels @param {{ run?: typeof defaultRun }} [deps]
 */
export function ensureLabelsExist(labels, { run = defaultRun } = {}) {
  for (const label of labels) run("gh", ["label", "create", label, "--repo", REPO, "--force"]);
}

/**
 * Reads an issue's CURRENT labels from the real board. Injectable `run`, the same seam
 * `install-git-hooks.mjs` uses, so this is testable without a network call or a real repo.
 *
 * REFUSES TO GUESS: `gh` failing (network, auth, a deleted issue), or answering with a shape this
 * function does not recognise, throws -- it never falls through to an empty label list, which is
 * indistinguishable from "genuinely no labels" and would make every failure read as UNCLAIMED.
 *
 * @param {number} issueNumber
 * @param {{ run?: typeof defaultRun }} [deps]
 * @returns {IssueClaim}
 */
export function fetchLabels(issueNumber, { run = defaultRun } = {}) {
  /** @type {string} */
  let raw;
  try {
    raw = run("gh", ["issue", "view", String(issueNumber), "--repo", REPO,
      "--json", "number,title,labels,state"]);
  } catch (cause) {
    throw new Error(`row-claim: could not read issue #${issueNumber} from ${REPO} -- refusing to guess `
      + `whether it is claimed. ${/** @type {Error} */ (cause).message}`, { cause });
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`row-claim: gh's response for issue #${issueNumber} was not JSON -- refusing to `
      + `guess. First 200 chars: ${raw.slice(0, 200)}`, { cause });
  }
  const obj = /** @type {{ number?: unknown, title?: unknown, labels?: unknown, state?: unknown }} */ (parsed);
  if (typeof obj?.number !== "number" || typeof obj?.title !== "string" || !Array.isArray(obj?.labels)) {
    throw new Error(`row-claim: gh's response for issue #${issueNumber} is missing number/title/labels -- `
      + `refusing to guess. Got: ${JSON.stringify(parsed).slice(0, 300)}`);
  }
  const names = obj.labels.map((/** @type {unknown} */ l) => {
    const name = /** @type {{ name?: unknown }} */ (l)?.name;
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
 * @param {{ run?: typeof defaultRun }} [deps]
 * @returns {string[]}
 */
export function fetchClaimComments(issueNumber, { run = defaultRun } = {}) {
  /** @type {string} */
  let raw;
  try {
    raw = run("gh", ["issue", "view", String(issueNumber), "--repo", REPO, "--json", "comments"]);
  } catch (cause) {
    throw new Error(`row-claim: could not read issue #${issueNumber}'s comments from ${REPO} -- refusing `
      + `to guess what branch or worktree its claim recorded. ${/** @type {Error} */ (cause).message}`,
    { cause });
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`row-claim: gh's comment response for issue #${issueNumber} was not JSON -- refusing `
      + `to guess. First 200 chars: ${raw.slice(0, 200)}`, { cause });
  }
  const comments = /** @type {{ comments?: unknown }} */ (parsed)?.comments;
  if (!Array.isArray(comments)) {
    throw new Error(`row-claim: gh's response for issue #${issueNumber} carried no comments array -- `
      + `refusing to guess. Got: ${JSON.stringify(parsed).slice(0, 300)}`);
  }
  return comments.map((/** @type {unknown} */ c) => {
    const body = /** @type {{ body?: unknown }} */ (c)?.body;
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
export function claimStatus(labels) {
  const branchLabel = labels.find((l) => l.startsWith(BRANCH_LABEL_PREFIX));
  const worktreeLabel = labels.find((l) => l.startsWith(WORKTREE_LABEL_PREFIX));
  return {
    claimed: labels.includes(CLAIM_LABEL),
    started: labels.includes(STARTED_LABEL),
    sessions: labels.filter((l) => l.startsWith("session:")).map((l) => l.slice("session:".length)),
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
export function decideClaim(labelsBefore, mySession) {
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
export function moveProjectStatus(issueNumber, statusName,
  { run = defaultRun, log = (line) => process.stderr.write(`${line}\n`), snapshot = withBoardSnapshot } = {}) {
  const url = `https://github.com/${REPO}/issues/${issueNumber}`;
  try {
    snapshot(() => run("gh", ["project", "item-edit", String(PROJECT_NUMBER), "--owner", PROJECT_OWNER,
      "--url", url, "--field", "Status", "--value", statusName]),
      // #1275: the snapshot covers the one item this edit touches, not the whole board.
      { run, log, excludeIssueNumber: issueNumber, touches: issueNumber });
    return { moved: true };
  } catch (error) {
    const message = /** @type {Error} */ (error).message;
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
 * B2 (#476) + B4 (#462), COMPOSED: should `mySession` start a NEW row right now, independent of whether
 * this particular row is claimed by someone else? `null` means proceed; a string is the refusal reason.
 *
 * BOTH FAIL OPEN ON A LOOKUP FAILURE, deliberately -- the opposite of `decideClaim`'s own "unclaimed must
 * be EARNED, not defaulted to" rule a few functions up. That rule protects a VERDICT about who holds a
 * row; this protects a session's ability to claim ANYTHING at all when the network is down or `gh` is
 * unauthenticated -- the identical reasoning `merge-guard.mjs`'s `racesAnArmedMerge` states for the same
 * choice made the other way: a convenience guard that blocks all work on a lookup failure gets bypassed
 * and then never consulted again, which is worse than the rare miss it would have caught.
 *
 * #989: THE CHECK-STATE DEPS ARE GONE. B2 used to read the session's own PR colour and this paragraph
 * explained why `requiredContexts`/`checkRuns` were injected separately from `run` -- they reach `gh`
 * through `merge-guard/lookups.mjs`'s own helper, so a fixture injecting `run` alone placed a real network
 * call. B2 now asks whether a ROW is in build and reads no check state at all, so the deps have no
 * subject; callers still passing them are simply ignored, which is why no test had to change for it.
 * @param {number} issueNumber the row about to be claimed -- excluded from B2's "other held rows" check
 * @param {string} mySession
 * @param {{ run?: typeof defaultRun,
 *           }} deps
 * @returns {string | null}
 */
export function sessionEligibilityReason(issueNumber, mySession, { run = defaultRun } = {}) {
  const ghRun = (/** @type {string[]} */ args) => run("gh", args);

  // #989: B2 asks whether a ROW is in build, not whether a PR is open. `null` from the lookup is
  // INCONCLUSIVE and returns no refusal, exactly as the PR-shaped version did -- a failed lookup must
  // never invent a block any more than it may invent a clearance.
  const heldRows = lookupHeldRows(mySession, issueNumber, { run: ghRun });
  const inBuild = heldRows === null ? null : inBuildReason(heldRows);
  if (inBuild) return inBuild;

  const myFiles = lookupMyRegionFiles(issueNumber, { run: ghRun });
  const otherPrFiles = lookupOpenPrFiles({ run: ghRun });
  if (myFiles !== null && otherPrFiles !== null) {
    const { reason, emptyOtherPrs } = fileOverlapReason(myFiles, otherPrFiles);
    for (const prNumber of emptyOtherPrs) {
      process.stderr.write(`row-claim: #${prNumber} is open and reports ZERO changed files -- not folded `
        + "into \"no overlap\", just nothing to compare against right now. Worth a look if that surprises "
        + "you (B4, #462).\n");
    }
    if (reason) return reason;
  }
  return null;
}

/**
 * #741: does `--blocked-by=#N` change an otherwise-refusing `ineligible` verdict into a proceed? Pulled
 * out of `writeRowLabels` to keep that function's own complexity below the lint gate, matching this
 * file's own established pattern (`declineOwnershipReason`, `declineRemoveLabels`) for exactly this
 * reason.
 *
 * This re-runs `lookupOwnPrHealth`/`ownPrHealthReason` itself, rather than reading `sessionEligibilityReason`'s
 * `ineligible` string apart -- that function returns one string for B2 and B4 alike, and the override must
 * never apply to B4 (a file-overlap refusal has nothing to do with the claimant's own PR being unhealthy).
 * A `blockedBy` value present while the refusal is NOT a B2 one, or absent entirely, is a plain pass-through
 * of `ineligible`.
 *
 * @param {{ issueNumber: number, mySession: string, ineligible: string, blockedBy: string | undefined }} attempt
 * @param {{ ghRun: (args: string[]) => string }} deps
 * @returns {{ proceed: true, blockedByNote: string | null } | { proceed: false, reason: string }}
 */
function eligibilityWithBlockedBy({ issueNumber, mySession, ineligible, blockedBy }, deps) {
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
function postBlockedByNoteIfAny(issueNumber, blockedByNote, runFn) {
  if (blockedByNote) {
    runFn("gh", ["issue", "comment", String(issueNumber), "--repo", REPO, "--body", blockedByNote]);
  }
}

/**
 * #987: posts the claim record -- the branch and worktree, in a comment, because neither fits in a label.
 *
 * A claim that names NEITHER posts nothing: a dispatch, or a non-code row, has no git object to record,
 * and a marker comment carrying no fields is how a RELEASE is spelled (`claimRecordFrom` would read this
 * as "released" rather than "claimed with nothing"). Those two states must not share a spelling.
 * @param {number} issueNumber
 * @param {{ session: string, branch?: string, worktree?: string }} record
 * @param {(cmd: string, args: string[]) => string} runFn
 */
function postClaimRecord(issueNumber, { session, branch, worktree }, runFn) {
  if (!branch && !worktree) return;
  const body = claimRecordComment({ session, branch, worktree });
  runFn("gh", ["issue", "comment", String(issueNumber), "--repo", REPO, "--body", body]);
}

/**
 * #987: posts the RELEASE record, superseding whatever the last claim recorded -- pulled out of
 * `declineRow` for the same reason `postBlockedByNoteIfAny` and `declineRemoveLabels` were (a called
 * function's own branches are not the caller's, and `declineRow` sits one step from the complexity gate).
 *
 * Nothing is posted when nothing was recorded: a row that never named a branch or worktree has no record
 * to supersede, and a marker comment on it would be noise a future `claimRecordFrom` then has to read.
 * @param {number} issueNumber
 * @param {{ session: string, recorded: { branch: string | null, worktree: string | null } }} release
 * @param {(cmd: string, args: string[]) => string} runFn
 */
function postReleaseRecord(issueNumber, { session, recorded }, runFn) {
  if (!recorded.branch && !recorded.worktree) return;
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
export function withLandedWrites(issueNumber, landed, act) {
  try {
    return act();
  } catch (cause) {
    if (landed.length === 0) throw cause;
    throw Object.assign(new Error(`row-claim: #${issueNumber} WAS WRITTEN before a later step failed -- `
      + `landed: ${landed.join("; ")}. The step that failed: ${/** @type {Error} */ (cause).message}`, { cause }),
    { landed: [...landed] });
  }
}

/**
 * The writes a `withLandedWrites` failure carries, or `null` for an error that landed nothing.
 * @param {unknown} error
 * @returns {string[] | null}
 */
export function landedWritesOf(error) {
  const landed = /** @type {{ landed?: unknown } | null} */ (error)?.landed;
  return Array.isArray(landed) ? landed : null;
}

/**
 * What a `claim`/`dispatch`/`decline` CLI prints, and exits with, for a thrown error -- one function so the
 * three catches cannot drift apart. Pure.
 * @param {unknown} error
 * @returns {{ exitCode: number, text: string }}
 */
export function failureReport(error) {
  const message = /** @type {Error} */ (error).message;
  if (landedWritesOf(error) === null) return { exitCode: 2, text: `COULD NOT DETERMINE: ${message}` };
  return { exitCode: LANDED_WRITE_EXIT, text: `PARTIALLY WRITTEN (exit ${LANDED_WRITE_EXIT}, NOT "could not determine" `
    + `-- the row has changed): ${message}. Read the row by REST before retrying or editing it by hand.` };
}

/**
 * #749: writes the claim's labels, split from `writeRowLabels` for the same reason
 * `postBlockedByNoteIfAny` above is (a called function's own lines are not the caller's).
 *
 * The label must EXIST before `gh` can add it (see `ensureLabelsExist`'s own header), and the ADD and the
 * REMOVE are now two SEPARATE calls, in that order, rather than one combined edit -- #677's own
 * reproduction proved a combined call is not atomic (its `--remove-label ready` applied while every
 * `--add-label` did not), so "leaves the row's labels exactly as it found them on ANY failure" can only be
 * honoured by making the removal wait until the additions are KNOWN to have succeeded: `run` throws on a
 * non-zero exit (`defaultRun`'s own `execFileSync`), so a failed ADD call never reaches the REMOVE below --
 * the row keeps `ready` (worse than a clean claim, but recoverable and visible) rather than losing it while
 * gaining nothing.
 *
 * #987: NO `branch:`/`worktree:` LABEL IS BUILT HERE ANY MORE -- see `CLAIM_RECORD_MARKER`'s own header
 * for why (GitHub's 50-character label-name cap made the documented `--worktree=<path>` usage impossible
 * for any path outside `/private/tmp`). The two facts are written as a claim COMMENT instead, by
 * `writeRowLabels` after it knows it won the race.
 * @param {number} issueNumber
 * @param {{ run: typeof defaultRun, sessionLabel: string, extraLabels: string[], wasReady: boolean,
 *   landed: string[] }} args `landed` gains each write once it has succeeded (#1399)
 */
function applyClaimLabels(issueNumber, { run, sessionLabel, extraLabels, wasReady, landed }) {
  const labelsToAdd = [CLAIM_LABEL, sessionLabel, ...extraLabels,
    ...(wasReady ? [WAS_READY_LABEL] : [])];
  ensureLabelsExist(labelsToAdd, { run });
  run("gh", ["issue", "edit", String(issueNumber), "--repo", REPO,
    ...labelsToAdd.flatMap((l) => ["--add-label", l])]);
  landed.push(`added labels ${labelsToAdd.join(", ")}`);
  run("gh", ["issue", "edit", String(issueNumber), "--repo", REPO, "--remove-label", READY_LABEL]);
  landed.push(`removed label ${READY_LABEL}`);
}

/**
 * @param {number} issueNumber
 * @param {string} mySession
 * @param {string[]} extraLabels labels written alongside `in-progress` + `session:<name>` -- `[]` for a
 *   dispatch, `[STARTED_LABEL]` for a claim/start
 * @param {{ run?: typeof defaultRun, moveStatus?: typeof moveProjectStatus, branch?: string,
 *           worktree?: string, blockedBy?: string }} deps
 * @returns {{ claimed: true, statusMoved: true } | { claimed: true, statusMoved: false, notOnBoard: boolean, statusReason: string } | { claimed: false, reason: string }}
 */
function writeRowLabels(issueNumber, mySession, extraLabels,
  { run = defaultRun, moveStatus = moveProjectStatus, branch, worktree, blockedBy } = {}) {
  const before = fetchLabels(issueNumber, { run });
  const decision = decideClaim(before.labels, mySession);
  if (!decision.proceed) return { claimed: false, reason: decision.reason };

  // #707: THE TEMPLATE FIELDS, checked on EVERY claim attempt -- unlike the session-eligibility block
  // below, this is a property of the ROW, not of who is claiming it or when they last touched it, so it
  // is not skipped on a resumed (`alreadyMine`) claim: a row dispatched before this check shipped, or by
  // a hand-claim (#673) that bypassed row-claim entirely, must still be caught the first time row-claim
  // itself acts on it, which may well be a "resume".
  const ghRunForBody = (/** @type {string[]} */ args) => run("gh", args);
  const body = lookupIssueBody(issueNumber, { run: ghRunForBody });
  if (body !== null) {
    const templateReason = templateFieldsReason(body, issueNumber);
    if (templateReason) return { claimed: false, reason: templateReason };
  }

  // B2 (#476) + B4 (#462): SESSION ELIGIBILITY, not row ownership -- `decideClaim` above already answered
  // "is this row somebody else's"; these ask "should THIS session start ANY new row right now", which is
  // why they are skipped entirely when resuming a row this session already holds (the `dispatched -> started`
  // transition is not a NEW front, and re-running these lookups on every resume would be pure cost for a
  // question already answered the first time this row was claimed).
  const alreadyMine = claimStatus(before.labels).sessions.includes(mySession);
  let blockedByNote = null;
  if (!alreadyMine) {
    const ineligible = sessionEligibilityReason(issueNumber, mySession, { run });
    if (ineligible) {
      const eligibility = eligibilityWithBlockedBy({ issueNumber, mySession, ineligible, blockedBy },
        { ghRun: ghRunForBody });
      if (!eligibility.proceed) return { claimed: false, reason: eligibility.reason };
      blockedByNote = eligibility.blockedByNote;
    }
  }

  const sessionLabel = `session:${mySession}`;
  // #449: RECORD, IN THE SAME EDIT, THAT THIS ROW WAS `ready` BEFORE THE CLAIM -- `declineRow`'s only way
  // to know whether releasing this row should restore `ready`, since removing it below is the one place
  // that fact is ever seen. A resumed claim (dispatched -> started, `ready` already gone) computes false
  // here and adds nothing, harmlessly -- the marker this row's own earlier dispatch already wrote stays
  // exactly where it is.
  const wasReady = before.labels.includes(READY_LABEL);
  /** @type {string[]} */
  const landed = [];
  // #1399: FROM THE FIRST WRITE ON, A FAILURE IS A PARTIAL WRITE, never `COULD NOT DETERMINE` -- see
  // `LANDED_WRITE_EXIT`. The checks above wrote nothing, so a throw from them still propagates as it did.
  return withLandedWrites(issueNumber, landed, () => {
    applyClaimLabels(issueNumber, { run, sessionLabel, extraLabels, wasReady, landed });
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
function completeClaim(issueNumber,
  { run, moveStatus, mySession, sessionLabel, extraLabels, blockedByNote, branch, worktree, landed }) {
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
  if (branch || worktree) landed.push(`posted the claim record (branch ${branch ?? "none"}, worktree ${worktree ?? "none"})`);
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
function reportReachability(issueNumber) {
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
    const spawned = /** @type {{stdout?: string, stderr?: string, status?: number}} */ (error);
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
export function dispatchRow(issueNumber, mySession, deps = {}) {
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
 *           worktree?: string, blockedBy?: string }} [deps]
 * @returns {{ claimed: true, statusMoved: true } | { claimed: true, statusMoved: false, notOnBoard: boolean, statusReason: string } | { claimed: false, reason: string }}
 */
export function claimRow(issueNumber, mySession, deps = {}) {
  return writeRowLabels(issueNumber, mySession, [STARTED_LABEL], deps);
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
 * @param {{ branch?: string, worktree?: string }} flags
 * @returns {string | null}
 */
export function worktreeFlagsReason({ branch, worktree }) {
  if (Boolean(branch) === Boolean(worktree)) return null;
  return "--branch and --worktree go together (#1432): `claim` creates the worktree at --worktree on the new branch "
    + "--branch, from origin/main. Give both, or neither for a row that changes no code.";
}

/** @param {unknown} error @returns {number | null} */
function exitStatusOf(error) {
  const status = /** @type {{ status?: unknown } | null} */ (error)?.status;
  return typeof status === "number" ? status : null;
}

/**
 * `git` answered "no such ref" (`absentStatus`) -> false; a zero exit -> true; ANY other failure throws, because
 * "could not ask" is not "absent", and creating a branch on a guess is how the incident started.
 * @param {string[]} args @param {number} absentStatus @param {string} what @param {typeof defaultRun} run
 * @returns {boolean}
 */
function gitRefExists(args, absentStatus, what, run) {
  try {
    run("git", args);
    return true;
  } catch (cause) {
    if (exitStatusOf(cause) === absentStatus) return false;
    throw new Error(`row-claim: could not ask git whether ${what} exists -- refusing to create it on a guess. `
      + `${/** @type {Error} */ (cause).message}`, { cause });
  }
}

/**
 * Who a branch belongs to, as far as the tracker records: the claim record of the row its trailing number names.
 * A read that fails SAYS so; it is never turned into an owner or into "nobody".
 * @param {string} branch @param {typeof defaultRun} run
 * @returns {string}
 */
function branchOwnerText(branch, run) {
  const match = /-(\d+)$/.exec(branch);
  if (!match) return "its name carries no row number, so there is no claim record to name an owner";
  const row = Number(match[1]);
  try {
    const comments = fetchClaimComments(row, { run });
    const session = claimRecordSession(comments);
    if (claimRecordFrom(comments).branch === branch && session) return `row #${row}'s claim record names \`${session}\``;
    return `row #${row}'s newest claim record does not name this branch`;
  } catch (cause) {
    return `row #${row}'s claim record could not be read: ${/** @type {Error} */ (cause).message}`;
  }
}

/**
 * #1432: THE REFUSAL, BEFORE ANY WRITE: the target PATH exists, or the target BRANCH exists locally or on origin. Each
 * names its owner where one is recorded -- the path's `.a11y-owner` stamp (#1128), the branch's claim record.
 * @param {{ branch: string, worktree: string }} target
 * @param {{ run?: typeof defaultRun, exists?: (path: string) => boolean, owner?: (worktree: string) => string | null }} [deps]
 * @returns {string | null} the refusal, or null to go ahead
 */
export function worktreeTargetReason({ branch, worktree }, { run = defaultRun, exists = existsSync, owner = worktreeOwner } = {}) {
  if (exists(worktree)) {
    const who = owner(worktree);
    return `--worktree=${worktree} ALREADY EXISTS, ${who ? `stamped by \`${who}\`` : "UNSTAMPED (nobody recorded an owner, which is not the same as free)"}. `
      + "Refusing before any write: a claim that went on would act inside a tree it did not create.";
  }
  if (gitRefExists(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], 1, `branch ${branch} locally`, run)) {
    return `--branch=${branch} ALREADY EXISTS locally (${branchOwnerText(branch, run)}). Refusing before any write.`;
  }
  if (gitRefExists(["ls-remote", "--exit-code", "--heads", "origin", branch], 2, `branch ${branch} on origin`, run)) {
    return `--branch=${branch} ALREADY EXISTS on origin (${branchOwnerText(branch, run)}). Refusing before any write.`;
  }
  return null;
}

/**
 * A claim that did not win leaves nothing behind: the worktree and branch this call created a moment ago are removed.
 * A removal that fails is SAID, never swallowed.
 * @param {{ branch: string, worktree: string }} target @param {typeof defaultRun} run
 * @returns {string}
 */
function undoCreatedWorktree({ branch, worktree }, run) {
  try {
    run("git", ["worktree", "remove", "--force", worktree]);
    run("git", ["branch", "-D", branch]);
    return `the worktree ${worktree} and branch ${branch} it had just created were removed`;
  } catch (cause) {
    return `the worktree ${worktree} and branch ${branch} it had just created could NOT be removed: `
      + `${/** @type {Error} */ (cause).message}`;
  }
}

/**
 * #1432: CLAIM, CREATING THE WORKTREE -- `row-claim claim --branch=<b> --worktree=<p>`. In order: refuse if the path or
 * branch exists; fetch; `git worktree add -b <b> <p> origin/main`; stamp it; claim. A claim that is refused or loses
 * its race removes what this created. A failure after the worktree landed carries it in #1399's landed list.
 * @param {number} issueNumber
 * @param {string} mySession
 * @param {{ branch: string, worktree: string, run?: typeof defaultRun, exists?: (path: string) => boolean,
 *   owner?: (worktree: string) => string | null, stamp?: (worktree: string, session: string) => void,
 *   claim?: typeof claimRow, claimDeps?: Parameters<typeof claimRow>[2] }} args
 * @returns {ReturnType<typeof claimRow>}
 */
export function claimWithWorktree(issueNumber, mySession, { branch, worktree, run = defaultRun, exists = existsSync,
  owner = worktreeOwner, stamp = stampWorktree, claim = claimRow, claimDeps = {} }) {
  const refusal = worktreeTargetReason({ branch, worktree }, { run, exists, owner });
  if (refusal) return { claimed: false, reason: refusal };
  /** @type {string[]} */
  const landed = [];
  return withLandedWrites(issueNumber, landed, () => {
    run("git", ["fetch", "--quiet", "origin"]);
    run("git", ["worktree", "add", "-b", branch, worktree, "origin/main"]);
    landed.push(`created worktree ${worktree} on new branch ${branch} from origin/main`);
    stamp(worktree, mySession);
    landed.push(`stamped ${worktree} as ${mySession}'s`);
    const result = claim(issueNumber, mySession, { run, ...claimDeps, branch, worktree });
    if (result.claimed) return result;
    return { claimed: false, reason: `${result.reason} -- and ${undoCreatedWorktree({ branch, worktree }, run)}` };
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
export function worktreeStatus(worktreePath, { run = defaultRun } = {}) {
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
 * @param {string} worktreePath
 * @param {{ run?: typeof defaultRun, hash?: (file: string) => string }} [deps]
 * @returns {{ removed: true } | { removed: false, reason: string, files?: string[] }}
 */
export function removeClaimedWorktree(worktreePath, { run = defaultRun, hash } = {}) {
  if (!existsSync(worktreePath)) return { removed: true };
  const status = worktreeStatus(worktreePath, { run });
  if (!status.clean) {
    return { removed: false,
      reason: `${worktreePath} has uncommitted change(s) -- refusing to remove it: ${status.files.join(", ")}`,
      files: status.files };
  }
  const held = unverifiedRecords(worktreePath, primaryWorktreeOf(worktreePath, { run }), { hash });
  if (held.refused) return { removed: false, reason: held.reason };
  try {
    run("git", ["worktree", "remove", worktreePath]);
    return { removed: true };
  } catch (error) {
    return { removed: false,
      reason: `git worktree remove failed -- ${/** @type {Error} */ (error).message}` };
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
function declineRemoveLabels(status, mySession, wasReady) {
  return [CLAIM_LABEL, `session:${mySession}`, STARTED_LABEL,
    ...(status.branch ? [`${BRANCH_LABEL_PREFIX}${status.branch}`] : []),
    ...(status.worktree ? [`${WORKTREE_LABEL_PREFIX}${status.worktree}`] : []),
    ...(wasReady ? [WAS_READY_LABEL] : [])];
}

/**
 * Pure: what a decline's label EDIT should add, and whether that amounts to a `ready` restore -- pulled
 * out of `declineRow` to keep its own complexity below the lint gate, same reason `declineRemoveLabels`
 * was. `isClosed` wins over every other reason to add a label (#752): a closed row has no lane to go back
 * to, so neither `wasReady` nor `blockedReason` may add anything once it is true.
 * @param {{ isClosed: boolean, wasReady: boolean, blockedReason: string | undefined }} facts
 * @returns {{ restoreReady: boolean, addLabels: string[] }}
 */
function declineAddLabels({ isClosed, wasReady, blockedReason }) {
  if (isClosed) return { restoreReady: false, addLabels: [] };
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
function declineOwnershipReason(status, mySession) {
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
 * @param {{ run?: typeof defaultRun, moveStatus?: typeof moveProjectStatus, blockedReason?: string,
 *           removeWorktree?: typeof removeClaimedWorktree,
 *           fetchComments?: typeof fetchClaimComments }} [deps]
 * @returns {{ declined: true, restoredReady: boolean, blocked: boolean, closed: boolean, statusMoved: true }
 *   | { declined: true, restoredReady: true, blocked: false, closed: false, statusMoved: false,
 *       notOnBoard: boolean, statusReason: string }
 *   | { declined: false, reason: string }}
 */
export function declineRow(issueNumber, mySession,
  { run = defaultRun, moveStatus = moveProjectStatus, blockedReason, removeWorktree = removeClaimedWorktree,
    fetchComments = fetchClaimComments } = {}) {
  const before = fetchLabels(issueNumber, { run });
  const status = claimStatus(before.labels);
  const ownershipReason = declineOwnershipReason(status, mySession);
  if (ownershipReason) return { declined: false, reason: ownershipReason };
  // #987: THE RECORDED OBJECTS COME FROM THE CLAIM COMMENT NOW, with the old `worktree:` label as a
  // migration read for the three open rows that still carry one -- `claimedObjects`' own header carries
  // the count and the command that says when the fallback can go. Read AFTER the ownership check, so a
  // decline this session was never entitled to make costs no extra `gh` call.
  const recorded = claimedObjects({ labels: before.labels, comments: fetchComments(issueNumber, { run }) });
  /** @type {string[]} */
  const landed = [];
  // #1399: as `writeRowLabels` -- from the worktree removal on, a failure reports what it already changed.
  return withLandedWrites(issueNumber, landed, () => releaseRow(issueNumber,
    { run, moveStatus, blockedReason, removeWorktree, mySession, before, status, recorded, landed }));
}

/**
 * #1399: `declineRow` from the worktree removal on -- every write recorded in `landed` as it succeeds.
 * @param {number} issueNumber
 * @param {{ run: typeof defaultRun, moveStatus: typeof moveProjectStatus, blockedReason?: string,
 *   removeWorktree: typeof removeClaimedWorktree, mySession: string, before: IssueClaim,
 *   status: ReturnType<typeof claimStatus>, recorded: { branch: string | null, worktree: string | null },
 *   landed: string[] }} state
 * @returns {ReturnType<typeof declineRow>}
 */
function releaseRow(issueNumber,
  { run, moveStatus, blockedReason, removeWorktree, mySession, before, status, recorded, landed }) {
  // #665: THE WORKTREE COMES OFF FIRST, before any label is touched -- a dirty one refuses the WHOLE
  // decline (see this function's own header for why), so the claim record stays intact until an operator
  // has dealt with the uncommitted work by hand.
  if (recorded.worktree) {
    const removal = removeWorktree(recorded.worktree, { run });
    if (!removal.removed) return { declined: false, reason: removal.reason };
    landed.push(`removed the recorded worktree ${recorded.worktree}`);
  }

  const isClosed = before.state === "CLOSED";
  const wasReady = before.labels.includes(WAS_READY_LABEL);
  const { restoreReady, addLabels } = declineAddLabels({ isClosed, wasReady, blockedReason });
  const removeLabels = declineRemoveLabels(status, mySession, wasReady);
  run("gh", ["issue", "edit", String(issueNumber), "--repo", REPO,
    ...removeLabels.flatMap((l) => ["--remove-label", l]),
    ...addLabels.flatMap((l) => ["--add-label", l])]);
  landed.push(`removed labels ${removeLabels.join(", ")}${addLabels.length > 0 ? `; added ${addLabels.join(", ")}` : ""}`);

  // #987: AND THE RELEASE GOES ON THE RECORD, so the newest claim-record comment stops naming a worktree
  // this call has just removed.
  postReleaseRecord(issueNumber, { session: mySession, recorded }, run);
  if (recorded.branch || recorded.worktree) landed.push("posted the release record");

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
export function checkLogPath() {
  return `${gitCommonDir()}/row-claim-check-log.jsonl`;
}

/**
 * Appends ONE `check` verdict -- called on EVERY `check`/`--row=` invocation, whatever it found. This is
 * the log's DENOMINATOR (#226): without an entry for every ask, a reader can never tell "the tool has been
 * asked N times and wrong M of them" from "the tool has only ever been asked when someone suspected it".
 *
 * @param {string} logPath
 * @param {{ issueNumber: number, claimed: boolean, started: boolean, sessions: string[],
 *           reachability: { code: number | null, output: string } | null }} entry
 */
export function recordCheck(logPath, entry) {
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
export function recordConflict(logPath, entry) {
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
export function latestCheckFor(logPath, issueNumber) {
  /** @type {string} */
  let text;
  try {
    text = readFileSync(logPath, "utf8");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return null;
    throw error;
  }
  const entries = text.split("\n").filter(Boolean).map((line) => JSON.parse(line))
    .filter((entry) => entry.kind === "check" && entry.issueNumber === issueNumber);
  return entries.length > 0 ? entries[entries.length - 1] : null;
}

/**
 * Records the `check` verdict without letting a LOGGING failure read as a CLAIM-DETERMINATION failure --
 * the same distinction `reportReachability`'s own doc draws for reachability. A full disk should not turn
 * a correctly-answered `check` into `COULD NOT DETERMINE`.
 *
 * @param {{ issueNumber: number, claimed: boolean, started: boolean, sessions: string[],
 *           reachability: { code: number | null, output: string } | null }} entry
 */
function recordCheckSafely(entry) {
  try {
    recordCheck(checkLogPath(), entry);
  } catch (error) {
    process.stderr.write(`row-claim: could not record this check to the log -- the answer above is still `
      + `correct. ${/** @type {Error} */ (error).message}\n`);
  }
}

function usage() {
  return "Usage:\n"
    + "  node packages/agent-org/src/row-claim.mjs --row=<issue-number>                       (status: three states)\n"
    + "  node packages/agent-org/src/row-claim.mjs check <issue-number>                       (alias of --row=)\n"
    + "  node packages/agent-org/src/row-claim.mjs dispatch <issue-number> --session=<name>   (mark taken at dispatch)\n"
    + "  node packages/agent-org/src/row-claim.mjs claim <issue-number> --session=<name> [--branch=<name>] "
    + "[--worktree=<path>] [--blocked-by=#N]  (mark started; #1432: given both, CREATES the worktree at <path> on new branch <name> from origin/main, refusing first if either exists; #656/#665: records the branch and worktree "
    + "-- #987: in a claim COMMENT, so a path of ANY length works, where a label capped it at 41 characters, "
    + "so a future escalation can tell portable from held, and decline can remove the worktree safely; "
    + "#741: --blocked-by releases B2 only with a measurement comment already on this session's own open "
    + "PR, and only while #N is open)\n"
    + "  node packages/agent-org/src/row-claim.mjs decline <issue-number> --session=<name>    (give it back; #665: also "
    + "removes the recorded worktree, refusing by name if it is dirty)\n"
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
function renderStatus(issueNumber, title, status, { body, recorded }) {
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
 * @param {{ number: number, files: string[], changedFiles: number }[] | null} otherPrFiles every other open PR, its
 *   files and its count (#1419), or null
 * @returns {string[]} lines to print -- NEVER empty. Three states, three sentences: refused,
 *   could-not-ask, clear. It said "empty only when B4 genuinely found no overlap" until #1085's review,
 *   which is the shape this repo records most: a doc line two lines above the function, stating what the
 *   code used to do, in the place it will be believed.
 */
export function b4Lines(myFiles, otherPrFiles) {
  if (myFiles === null || otherPrFiles === null) {
    return ["B4 COULD NOT BE ASKED: the open pull requests or this row's Region could not be read. "
      + "INCONCLUSIVE, not clear -- `row-claim claim` asks again and may refuse."];
  }
  const { reason, emptyOtherPrs } = fileOverlapReason(myFiles, otherPrFiles);
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
    lines.push(`  NOTE: #${emptyOtherPrs.join(", #")} read as touching NO files. An open PR with an empty `
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
 * @param {number} issueNumber
 * @param {{ write?: (s: string) => void,
 *   mine?: (n: number) => string[] | null,
 *   others?: () => { number: number, files: string[], changedFiles: number }[] | null }} [deps]
 */
export function reportB4(issueNumber, deps = {}) {
  const write = deps.write ?? ((/** @type {string} */ text) => process.stdout.write(text));
  const mine = deps.mine ?? lookupMyRegionFiles;
  const others = deps.others ?? lookupOpenPrFiles;
  // NO EMPTINESS GUARD, because `b4Lines` is never empty -- and a dead guard reads as a live one. It was
  // here until #1085's review: the `reportB4 never writes` mutation was 1 red and this `if` is what that
  // red would have been credited to, so the next person mutating here would conclude the empty case was
  // covered by a branch that can no longer be taken.
  write(`${b4Lines(mine(issueNumber), others()).join("\n")}\n`);
}

/** @param {number} issueNumber */
function runStatus(issueNumber) {
  try {
    const { labels, title } = fetchLabels(issueNumber);
    // #771: same injected-`run` shape `writeRowLabels` already uses for the identical lookup.
    const ghRunForBody = (/** @type {string[]} */ args) => defaultRun("gh", args);
    const body = lookupIssueBody(issueNumber, { run: ghRunForBody });
    // #987: the recorded branch/worktree now live in a comment, so `check` reads the thread too. Same
    // `claimedObjects` resolution `declineRow` uses, so the two can never disagree about which directory
    // a claim is holding open.
    const recorded = claimedObjects({ labels, comments: fetchClaimComments(issueNumber) });
    renderStatus(issueNumber, title, claimStatus(labels), { body, recorded });
  } catch (error) {
    process.stderr.write(`COULD NOT DETERMINE: ${/** @type {Error} */ (error).message}\n`);
    process.exitCode = 2;
  }
}

/**
 * Pure: the one-line summary of a successful dispatch/claim -- pulled out of `runDispatchOrClaim` to keep
 * that function's own complexity below the lint gate. `record` bundles `branch`/`worktree` rather than
 * two more positional parameters, per this repo's own "no boolean-flag-shaped argument lists" convention.
 * @param {"dispatch" | "claim"} mode
 * @param {number} issueNumber
 * @param {string} mySession
 * @param {{ branch?: string, worktree?: string }} record
 * @returns {string}
 */
function claimLineFor(mode, issueNumber, mySession, { branch, worktree }) {
  const label = mode === "dispatch" ? "DISPATCHED" : "STARTED";
  const startedSuffix = mode === "claim" ? ` / ${STARTED_LABEL}` : "";
  // #987: `branch <name>`, not `branch:<name>` -- the colon form named a LABEL, and this claim no longer
  // writes one. The same two facts are in the claim-record comment, and saying `branch:` here would tell a
  // reader to go looking for a label that is not there.
  const branchSuffix = mode === "claim" && branch ? ` / branch ${branch}` : "";
  const worktreeSuffix = mode === "claim" && worktree ? ` / worktree ${worktree}` : "";
  return `${label} -- #${issueNumber} is now ${CLAIM_LABEL} / session:${mySession}`
    + `${startedSuffix}${branchSuffix}${worktreeSuffix}`;
}

/**
 * #1432: which write a `dispatch`/`claim` CLI makes -- a claim given a branch and worktree creates them first.
 * @param {"dispatch" | "claim"} mode @param {number} issueNumber @param {string} mySession
 * @param {{ branch?: string, worktree?: string, blockedBy?: string }} flags
 */
function claimOrDispatch(mode, issueNumber, mySession, { branch, worktree, blockedBy }) {
  if (mode === "dispatch") return dispatchRow(issueNumber, mySession);
  if (branch && worktree) return claimWithWorktree(issueNumber, mySession, { branch, worktree, claimDeps: { blockedBy } });
  return claimRow(issueNumber, mySession, { blockedBy });
}

/**
 * @param {"dispatch" | "claim"} mode
 * @param {number} issueNumber
 * @param {string[]} rest
 */
function runDispatchOrClaim(mode, issueNumber, rest) {
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
  const flagsReason = mode === "claim" ? worktreeFlagsReason({ branch, worktree }) : null;
  if (flagsReason) {
    process.stderr.write(`row-claim claim: ${flagsReason}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    const result = claimOrDispatch(mode, issueNumber, mySession, { branch, worktree, blockedBy });
    if (result.claimed) {
      const claimLine = claimLineFor(mode, issueNumber, mySession, { branch, worktree });
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
 * @param {number} issueNumber
 * @param {string[]} rest
 */
function runDecline(issueNumber, rest) {
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
  try {
    const result = declineRow(issueNumber, mySession, { blockedReason });
    if (result.declined) {
      // #449/#752: WHAT CAME BACK, NOT JUST THAT SOMETHING DID -- the four shapes read differently to a
      // human deciding what happens next: restored (pickable again), blocked (a finding, do not repick
      // yet), closed (done -- "restored to ready" would be false on its face), or neither (was never
      // `ready`, unclaimed and no more startable than that already implies).
      const outcome = result.closed ? "; the row is CLOSED, so it is NOT returned to `ready`"
        : result.blocked ? "and marked `blocked`"
        : result.restoredReady ? "and restored to `ready`"
        : "(was not `ready` before the claim -- not restored)";
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
function runConflict(issueNumber, rest) {
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
    process.stderr.write(`COULD NOT RECORD: ${/** @type {Error} */ (error).message}\n`);
    process.exitCode = 2;
  }
}

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
  refuseUnknownFlags(["--session", "--row=", "--found=", "--blocked=", "--branch=", "--worktree=",
    "--blocked-by="], { entry: import.meta.url, command: "node packages/agent-org/src/row-claim.mjs" });
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
    runStatus(issueNumber);
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
    runStatus(issueNumber);
    return;
  }
  if (mode === "dispatch" || mode === "claim") {
    runDispatchOrClaim(mode, issueNumber, rest);
    return;
  }
  if (mode === "decline") {
    runDecline(issueNumber, rest);
    return;
  }
  if (mode === "conflict") {
    runConflict(issueNumber, rest);
    return;
  }

  process.stderr.write(usage());
  process.exitCode = 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  main();
}

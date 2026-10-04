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
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import { realpathSync, existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
// RELATIVE, not the package specifier -- this must run before any `pnpm install`/build, the same constraint
// `org-watch.mjs` and `build-packages.mjs` state at their own imports.
import { refuseUnknownFlags } from "./lib/cli-flags.mjs";
import { READY_LABEL, CLAIM_LABEL, CLAIM_RECORD_MARKER } from "./claim-labels.mjs";
import { verdictAmong, patchIdOfDiff, evidenceHeads, refusalHeads, refusalLiftedAt } from "./review-verdict.mjs";
// `verdictAmong` lives in review-verdict.mjs (#3030), so a test of the verdict reader need not import this file and its token.
export { verdictAmong };
import { waitingOn, fleetWaitingOn, todayIso, describeWaiting, ANSWER_PREFIX, answersOwedBy, bareAnswerLabel }
  from "./waiting-condition.mjs";
import { newestPerName } from "./newest-check-run.mjs";
import { reviewerInstance, subjectIdentity, subjectMention, subjectRef } from "./review-attribution.mjs";
// B4, ASKED EARLY. These are the SAME two functions `row-claim.mjs` runs at claim time, imported
// rather than reimplemented: `region-paths.mjs`'s own header records why a second copy of "what
// counts as a path" is not allowed to exist. Both are leaf-shaped and relative, so the gate keeps the
// property its own header states -- it runs before any `pnpm install` or build.
import { declaredRegionFiles } from "./region-paths.mjs";
import { claimedRegionOverlapReason, claimedRegionsOf, declaredClosedRows, fileOverlapReason } from "./row-claim/file-overlap-rule.mjs";
// #1959: THE ONE READER OF `docs/lane-ownership.json`, imported rather than re-parsed -- a lane's `paths`
// and `except` are `ceo`'s to move, and a second copy here would drift the way #939's nine spellings did.
// Leaf-shaped and relative, so the gate keeps the property its own header states.
import { loadLanes, inLane } from "./lane-ownership.mjs";
// #2031, AND IMPORTED FOR THE SAME REASON THE TWO LINES ABOVE ARE. The trailing-`-<n>` rule is #2014's,
// already exercised through `row-claim.mjs`'s own refusal; a second copy here is the drift that row's
// filing named in so many words. `row-branch-rule.mjs` imports NOTHING, and `git-env.mjs` imports nothing
// either, so the gate keeps the property its own header states -- it runs before any `pnpm install` or build.
import { LS_REMOTE_ARGS, rowBranchesInListing } from "./row-claim/row-branch-rule.mjs";
// #2791: THE RULE `row-claim.mjs` REFUSES A CLAIM ON, imported unchanged as `row-file` already does -- a second
// copy of "which sections must a row state" is the drift this whole family of imports exists to prevent.
import { missingTemplateFields } from "./row-claim/template-fields-rule.mjs";
// #2823: THE CLOSES RULE `closes-mismatch-check.mjs` PASSES A PULL REQUEST ON, imported and not retyped -- the gate and the
// CI step must call the same condition "repo-wide", or a PR the check passes with a warning is one the gate never reports.
import { isRepoWideResolutionFault, recentClosesSiblings } from "./closes-mismatch-check.mjs";
import { extractClosesDeclaration } from "./acceptance-commands.mjs";
// EVERY `git` SPAWN IN THIS REPO STRIPS `GIT_*` THROUGH ONE FUNCTION (`git-env.mjs`'s own header records
// the 2026-09-06 incident where an inherited `GIT_DIR` landed fifteen commits in the wrong checkout).
// This tick runs under systemd, where the environment is not the one a person typed.
import { sandboxGitEnv } from "./lib/git-env.mjs";
// THE REFUSAL PATH ONLY, and a LEAF import so this file keeps the property its own header states. The
// reader lived in `queue-table.mjs` until #2003; importing THAT would have pulled five modules into the
// graph of a script that runs 720 times a day, to use a function it calls only when already refusing.
import { poolDiagnosis, refusalPoolLine, poolFromRateLimitField } from "./api-pool.mjs";
import { declaredGhAccount } from "./gh-identity.mjs";
import { stateEntryPath } from "./host-config.mjs"; // #2799
// #2848: THE REPEATING-LINE QUESTION, in its own leaf for the reason `disk-headroom.mjs` is one: it reads the journal, not GitHub.
import { repeatingLinesTick } from "./repeating-lines.mjs";
// #2936: THE ORG-HEALTH QUESTION, in its own leaf for the same reason: relative imports only, so the gate keeps the property its own header states.
import { redSinceOf, readToolAgreement } from "./org-health.mjs";
// #2938: THE DAILY RETROSPECTIVE, in its own leaf for the same reason: it reads the journal, the ledger and a day of PRs once, and says what it found.
import { retrospectiveTick } from "./org-retro.mjs";
import { isBrokenRed } from "./red-pr.mjs"; // #2997
import { tapShadowReads } from "./shadow-reads.mjs"; // #2849
// #1969, AND THE PREDICATE IS IMPORTED RATHER THAN RE-DECIDED. `armedFromApi` knows THREE armed states --
// merged, a pending auto-merge, and SITTING IN THE MERGE QUEUE, where `autoMergeRequest` reads `null` on a
// correctly armed pull request (#1729/#1727, and #2004 for the read that fed it). `ceo`'s ruling names
// that reuse as a constraint: "the predicate is NOT `autoMergeRequest == null` -- a queued PR reads null".
// `openPullRequestsQueryArgs` is the same file's read, split out so this asks the identical question.
// Both are leaf-shaped: `auto-arm-sweep.mjs` imports only `node:*`, `cli-flags.mjs` (already here) and
// `pr-hold-state.mjs` (no imports at all), so the gate keeps the property its own header states.
import { armedFromApi, openPullRequestsQueryArgs } from "./auto-arm-sweep.mjs";
import { armabilityOf, holdersOf } from "./pr-hold-state.mjs";
// #3019: ARMED-AND-EJECTED IS READ WHERE `armed` IS DECIDED. `pr-armed-state.mjs` is the leaf `armedFromApi` lives in; the
// timeline reading is its sibling and this file only RUNS the query it builds, so there is still one place deciding it.
import { ejectionQueryArgs, queueEjectionOf } from "./pr-armed-state.mjs";
import { summarizeTestLog, testIdentity } from "./parent-recheck-summary.mjs";
import { REPO } from "./project-identity.mjs";
import { HOME_CHECKOUT, homeProjectDeclaration } from "./project-config.mjs";
import { verifyCheckoutOf, withVerifyStamps } from "./verify-stamp.mjs"; // #3215
import { CAUSES, JUDGMENT_CAUSES, START_CAUSES } from "./cause-declaration.mjs";
// #3390: the first line of the comment `answers.mjs` writes when the chairman answers, so a half-finished answer can be recognised by what it says.
import { PROVENANCE as CHAIRMAN_ANSWER_PROVENANCE } from "./messaging/answers.mjs";
// #2619 (child 3d of #69): the rest of this file's vocabulary -- `backlog`, `needs:chairman`,
// `out-of-release`, `blocked`, the `lane:`/`session:` prefixes and `lane:any`.
import { BACKLOG_LABEL, NEEDS_CHAIRMAN_LABEL as CHAIRMAN_LABEL, OUT_OF_RELEASE_LABEL, BLOCKED_LABEL,
  LANE_PREFIX, SESSION_PREFIX } from "./project-vocabulary.mjs";
// #2075: WHICH PROJECT A ROW MUST BE ON. `board-snapshot-scope.mjs` runs no `gh` and imports only `node:*`, the repo
// identity and `settle-closed-status.mjs`, so the gate keeps the property its own header states.
import { PROJECT_NUMBER } from "./board-snapshot-scope.mjs";
// #2356: A RED `main` WAKES A FIXER. Imports only `node:*`, `parent-recheck-summary.mjs` and the repo identity,
// so the gate keeps the property its own header states -- it runs before any `pnpm install` or build.
import { readTrunkRed, trunkOfCodeRepository, trunkRedOrders } from "./trunk-red.mjs";
// #2163: FREE BYTES AND FREE INODES. Imports only `node:*`, so the gate keeps the property its own header states.
import { diskHeadroom, MIN_FREE_FRACTION } from "./disk-headroom.mjs";
// #2470: A CLAIM THAT DOES NOT MOVE. A leaf, like every import above, so the gate keeps the property its own header states.
import { KEPT_CLAIMS_FILE, readJsonObject, writeJsonObject } from "./claim-stall.mjs";
// #2845: WHO STAMPED A WORKTREE -- the reading a refused claim names. Imports only `node:*` and `lib/`, like the rest.
import { worktreeOwner } from "./worktree-owner.mjs";
// #2542: THE PULL-REQUEST ORDERS -- the orders that ask a session to act on a pull request's state -- live in
// `work-gate/pr-orders.mjs`, which imports the shared PR facts BACK from this file. The cycle is safe because
// nothing there reads an import at load time (only inside a function), and this file stays the entry point:
// every name that module exported is re-exported here, so no caller of `work-gate.mjs` changes.
import { requiredWhenNeeded, perPullRequestOrders, greenUnarmedOrders, reviewBlockedOrders,
  stalledPrOrders, STALL_REASONS_WITHOUT_A_CAUSE, HOLD_RED_JOBS, ownerOfPr } from "./work-gate/pr-orders.mjs";
export { redOnlyBySupersededRun, mergeConflictOrders, greenUnarmedOrders, reviewBlockedOrders, HOLD_RED_JOBS,
  stallReasonOf, stallOrderOf, stalledPrOrders, STALL_REASON, STALL_REASONS_WITHOUT_A_CAUSE, ownerOfPr,
  awaitingEvidenceStaleOrders } from "./work-gate/pr-orders.mjs";
import { labJobFinishedOrders, readLabJobRecords, readDispatchedLabJobs } from "./work-gate/lab-job-orders.mjs";
// #2898: THE ORG-HEALTH FACTS AND ORDERS live in `work-gate/org-health.mjs`, which imports the shared reads BACK from this file (the cycle `pr-orders.mjs` above describes);
// every name it exported is re-exported here, so no caller of `work-gate.mjs` changes.
import { orgHealthNow, rulingOrdersNow } from "./work-gate/org-health.mjs";
// #2898: WHO OWNS A PULL REQUEST lives in `work-gate/pr-owners.mjs`, which imports the shared session reads BACK from this file (the cycle `pr-orders.mjs` above describes);
// every name it exported is re-exported here, so no caller of `work-gate.mjs` changes.
import { withPrOwners } from "./work-gate/pr-owners.mjs";
// #2898: THE ROW-CALL-COUNT ORDERS live in `work-gate/row-call-count-orders.mjs`, which imports the shared claim reads BACK from this file (the cycle `pr-orders.mjs` above describes);
// every name it exported is re-exported here, so no caller of `work-gate.mjs` changes.
import { rowCallCountOrders, rowCallCountSignals, liveClaudeTurns, readWaitClearedAt } from "./work-gate/row-call-count-orders.mjs";
// #2898: THE CLAIM-STALL TICK lives in `work-gate/claim-stall-tick.mjs`, which imports the shared claim reads BACK from this file (the cycle `pr-orders.mjs` above describes);
// every name it exported is re-exported here, so no caller of `work-gate.mjs` changes.
import { stallOrdersOrNone, claimStallsNow } from "./work-gate/claim-stall-tick.mjs";
export { claimStallTick, claimStallsNow } from "./work-gate/claim-stall-tick.mjs";
export { ROW_CALL_COUNT_SPLIT_THRESHOLD, claimedRowSession, rowCallCountSignals, ROW_CALL_COUNT_ASSESSED_MARKER,
  rowCallCountAssessedCalls, formatRowCallCountAssessment, rowCallCountOrders } from "./work-gate/row-call-count-orders.mjs";
export { withClosingRowOwners, withNamedOwners, withPrOwners, withEndedLabels } from "./work-gate/pr-owners.mjs";
export { FLEET_CAPTURES_LEDGER, readFleetCaptures, fleetWaitingFacts, stalledPrFacts,
  MAX_WAIT_READS, refFactOf, readWaitRef, readWaitFacts, readRefFacts, waitTickFacts, staleWaitOrders,
  rulingOrdersNow, orgHealthNow } from "./work-gate/org-health.mjs";

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

// #2621 (child 3e of #69): CAUSES, JUDGMENT_CAUSES AND START_CAUSES ARE COMPUTED, NOT SPELLED HERE. A
// cause used to be added to these three arrays AND to `worker-profile.mjs`'s `PROFILES` separately --
// four lists in two files a cause had to be added to together, and a cause added to one and not the
// others is a recorded trap. `cause-declaration.mjs` is now the one place a cause is declared
// (`{cause, group, profile}`), and these three names -- unchanged from here on -- are its computation.
// See that file's own header for the general "action vs judgment" and "start vs finish" reasoning, and
// its `TOOL_CAUSE_DECLARATIONS` for each cause's own.
export { CAUSES, JUDGMENT_CAUSES, START_CAUSES };

/** Where the drain marker lives. `touch` it to open a window; `rm` it to close one. */
export const DRAIN_MARKER = stateEntryPath("drain");

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

/**
 * THE REPOSITORY THE READS ARE ABOUT, when it is not the checkout's own (#2618, child 3c of #69). `undefined` -- the primary
 * project's, and every read before a second repository existed -- runs `gh` exactly as it always ran, with no `env` option
 * added, so one declared project makes the same calls it made. Any other repository is `GH_REPO`, which `gh pr`, `gh issue`,
 * `gh label` and the `{owner}/{repo}` placeholders of `gh api` all honour, so ONE seam scopes every reader including the zero-argument
 * wrappers `main` calls, without threading a repository through thirty signatures.
 *
 * Synchronous (`execFileSync`) and restored in a `finally`, which is what makes an ambient safe: no read of one repository
 * can run while another's is set.
 * @type {string | undefined}
 */
let activeRepo;

/**
 * Run `read` with every `gh` call it makes aimed at `repo` (`undefined` is the checkout's own).
 * @template T
 * @param {string | undefined} repo @param {() => T} read @returns {T}
 */
export function inRepo(repo, read) {
  const outer = activeRepo;
  activeRepo = repo;
  try {
    return read();
  } finally {
    activeRepo = outer;
  }
}

/** The repository a literal-path read (`repos/<repo>/...`) asks about: the scoped one, else the checkout's own. */
export const repoNow = () => activeRepo ?? REPO;

/** @param {string[]} args @param {string} [repo] the repository to aim at; the ambient one when omitted */
export const defaultRun = (args, repo = activeRepo) => execFileSync("gh", args,
  { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, ...(repo === undefined ? {} : { env: { ...process.env, GH_REPO: repo } }) });

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
      "number,isDraft,headRefOid,baseRefName,statusCheckRollup,author,comments,labels,files,changedFiles,body,"
      // #2084: `reviewDecision` IS WHAT GITHUB ITSELF MERGES ON, AND NO QUEUE READ HERE TOUCHED IT.
      // Measured at `468a74f1b`: `git grep -l reviewDecision -- '*.mjs'` returns exactly ONE file, and it
      // is not a queue read -- `row-claim/own-pr-health-rule.mjs` (#2126, merged the same day #2084 was
      // filed) reads it to answer "may this session claim ANOTHER ROW". That refusal emits no order, wakes
      // nobody, fires only on `CHANGES_REQUESTED`, and only for the session holding that row. Nothing that
      // reads the QUEUE touched the field: not this file, not `queue-table.mjs`, not `merge-guard.mjs`,
      // not `auto-arm-sweep.mjs` -- so #2049 sat green, armed and unmergeable for over seven hours with
      // every org read calling it healthy. (#2084's own body says the grep returned zero; that was true
      // when it was filed at 08:5xZ and #2126 landed the same day. The list of readers it names is right.)
      // It arrives on the `pr list` call this function already makes -- one more name in the `--json`
      // list, no extra request and no extra pool -- which is the whole reason the blind spot is worth
      // closing HERE rather than in `queue-table.mjs`, whose own header records dropping
      // `mergeStateStatus` precisely because a GraphQL-only field meant a second, refusable call.
      + "reviewDecision,"
      // #2470: `headRefName` -- WHICH BRANCH a pull request is on, so a claimed row can be asked "does it have an open
      // one". One more name on the call already made, like the two above; it is what keeps a row whose author is in
      // review out of `claim-stalled`, whose subject is the build and not the wait for a verdict.
      + "headRefName,"
      // #3445: `title`, the third rung of `ownsPr` (a title ending in the row's `owner/repo#n`); `labels` is already above, the fourth.
      + "title,"
      // #2209: `mergeStateStatus` AND `mergeable`, BOTH ON THE SAME CALL, because nothing here read whether
      // a pull request CONFLICTS with `main`. #2203 went DIRTY when #2205 merged, was green and approved,
      // and was reported as a credential outage while six Ready rows sat behind it. `gh pr list --json`
      // offers both names (checked 2026-09-24), so this is two more names on a request already made --
      // not the second, refusable call `queue-table.mjs`'s header records avoiding. GitHub computes them
      // lazily and may answer `UNKNOWN`; `conflictStateOf` reads that as unread, never as clean.
      + "mergeStateStatus,mergeable,"
      // #2365: `reviews` AND NOT `latestReviews`, MEASURED 2026-09-24 against `gh` on this host. Both ride on
      // the `--limit 100` call without tripping GraphQL's node limit (which `commits` does), but
      // `latestReviews[].commit.oid` comes back the EMPTY STRING and `reviews[].commit.oid` carries the sha the
      // review was posted at -- and "was this convinced verdict converted into a review AT THIS HEAD" is a
      // question about exactly that sha. `gh api .../pulls/N/reviews` `commit_id` agrees with it. No second call.
      + "reviews,"
      // #2823: `closingIssuesReferences` (what GitHub will close) and `createdAt` (how long the condition has stood), on the
      // same call, so `closesUnresolvedOrders` reads the Closes condition without a second request.
      // #2996: `updatedAt`, the QUIET SINCE of a wait with no stated reason, on the same call.
      + "closingIssuesReferences,createdAt,updatedAt"]);
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? withPagedFiles(parsed, { run }) : null;
  } catch {
    return null;
  }
}

/** Where a truncated pull request's paged file list is remembered between ticks: each tick is a fresh process, so memory would not outlive one. */
const PAGED_FILES_CACHE = "truncated-pr-files.json";
/** How many paged lists the cache keeps. A version PR's head moves with every push to `main`, so an unbounded file would grow for as long as it lives. */
const PAGED_FILES_KEPT = 20;

/**
 * #3365: A PULL REQUEST OF MORE THAN 100 FILES IS COMPARED BY ALL OF ITS FILES, NOT DROPPED. `gh pr list --json files` returns the first 100 and
 * never says so; `comparablePrFiles` rightly refuses a list shorter than `changedFiles`, so the gate could not shelve a row against such a PR
 * while the claim and the spawn check (`pagedPrFiles`, `file-overlap-rule.mjs`) paged REST and refused it. The release workflow's version PR is
 * 146 files and open nearly all the time: a row naming a `package.json` was offered 30 ticks running and refused at the spawn every time.
 *
 * ONLY a truncated PR is paged, and a complete list costs no call and no disk read. The paged list is cached by PR number + head sha, so a
 * two-minute tick pays the REST pages once per head. A PR whose paging FAILS (or comes back with the wrong count) is returned as it was and
 * still drops out of the comparison, as it did before: the gate fails open and the claim stays the authority. That is said on stderr.
 * NEVER THROWS: a failure here must not turn into a refused `pr list`.
 *
 * `{owner}/{repo}` are `gh api`'s own placeholders, resolved from the `GH_REPO` that `run` is aimed with.
 * @param {any[]} prs @param {{ run: (args: string[]) => string, cachePath?: string, log?: (line: string) => void }} deps
 * @returns {any[]}
 */
export function withPagedFiles(prs, { run, cachePath = stateEntryPath(PAGED_FILES_CACHE), log = (line) => process.stderr.write(line) }) {
  const truncated = prs.filter((pr) => Array.isArray(pr?.files) && pr.files.length < Number(pr.changedFiles));
  if (truncated.length === 0) return prs;
  const cache = readPagedFilesCache(cachePath, log);
  let fetched = false;
  const paged = new Map(truncated.map((pr) => {
    const key = typeof pr.headRefOid === "string" ? `${pr.number}@${pr.headRefOid}` : null;
    const cached = key === null ? undefined : cache[key];
    if (Array.isArray(cached) && cached.length === pr.changedFiles) return [pr, cached];
    const files = pageFilesOf(pr, { run, log });
    if (files !== null && key !== null) { cache[key] = files; fetched = true; }
    return [pr, files];
  }));
  if (fetched) writePagedFilesCache(cachePath, cache, log);
  return prs.map((pr) => ((paged.get(pr) ?? null) === null ? pr : { ...pr, files: /** @type {string[]} */ (paged.get(pr)).map((path) => ({ path })) }));
}

/** @param {any} pr @param {{ run: (args: string[]) => string, log: (line: string) => void }} deps @returns {string[] | null} `null` when the pages could not be read whole */
function pageFilesOf(pr, { run, log }) {
  try {
    const files = run(["api", "--paginate", `repos/{owner}/{repo}/pulls/${pr.number}/files?per_page=100`, "--jq", ".[].filename"]).split("\n").filter(Boolean);
    if (files.length === pr.changedFiles) return files;
    log(`work-gate: #${pr.number} lists ${files.length} files when paged, not the ${pr.changedFiles} it reports -- left out of B4's comparison; the claim still refuses (#3365)\n`);
  } catch (error) {
    log(`work-gate: could not page #${pr.number}'s files past ${pr.files.length} (${String(/** @type {Error} */ (error).message).split("\n")[0]}) `
      + "-- left out of B4's comparison, so the gate fails open and the claim still refuses (#3365)\n");
  }
  return null;
}

/** @param {string} path @param {(line: string) => void} log @returns {Record<string, string[]>} an absent file is an empty cache; an unreadable one is said aloud and is too */
function readPagedFilesCache(path, log) {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    log(`work-gate: ${path} is unreadable (${/** @type {Error} */ (error).message}); paging again (#3365)\n`);
    return {};
  }
}

/** Keeps the newest `PAGED_FILES_KEPT` entries (insertion order), and writes through a rename so a tick reading it never sees half a file. */
function writePagedFilesCache(/** @type {string} */ path, /** @type {Record<string, string[]>} */ cache, /** @type {(line: string) => void} */ log) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const kept = Object.fromEntries(Object.entries(cache).slice(-PAGED_FILES_KEPT));
    const scratch = `${path}.${process.pid}.tmp`;
    writeFileSync(scratch, JSON.stringify(kept));
    renameSync(scratch, path);
  } catch (error) {
    log(`work-gate: could not remember the paged file lists in ${path} (${/** @type {Error} */ (error).message}); the next tick pages again (#3365)\n`);
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
    "issue list --label chairman-blocked", "issue list (all open: answer/blocked labels)",
    // #2202: TWO SMALL CALLS, because a closed row still owing an answer is invisible to the open read above
    // and `gh` cannot filter a label PREFIX. The first lists the repo's `answer:` label names, the second
    // asks for the closed rows carrying any of them -- exact, so no window a row can fall out of silently.
    "label list --search answer: (readClosedAnswerRows)",
    "issue list --state closed --search label:<answer labels> (readClosedAnswerRows -- answer-owed on a closed row)",
    // #2641: THE THIRD OF THEM, and the one that moved the count from 9 to 10. A pull request that is no longer open is
    // not an `issue list` row and not a `readPrs` row, and a stuck cause whose subject is a MERGED one (`trunkRedOrders`)
    // labels it `answer:ceo` where nothing looked. Same label names as the call above, so no second `label list`.
    "pr list --state all --search 'label:<answer labels> -is:open' (readClosedAnswerRows -- answer-owed on a merged or closed pull request)",
    // #2356: ONE REST CALL on the core pool -- the newest runs of `trunk.yml` on `main` (readTrunkRed).
    "api actions/workflows/trunk.yml/runs (readTrunkRed -- trunk-red)",
    // #2075: ONE GRAPHQL CALL PER 100 OPEN ROWS (one, at 50 open), each row carrying ITS OWN `projectItems` -- never the board
    // listing, which lags minutes behind an add (see `readRowsOffBoard`).
    "api graphql repository.issues(states: OPEN) { projectItems } (readRowsOffBoard -- row-off-board)",
    // #2936: ONE REST CALL on the core pool -- the 20 newest-updated closed pull requests, of which the latest `merged_at` is the last merge.
    "api repos/{repo}/pulls?state=closed&sort=updated (readLastMergedAt -- org-health's no-merge-while-work-exists)"],
  conditionalOnEmptyShelf: "issue list --label epic (readEpics)",
  // #3390: TWO REST CALLS PER ROW LABELLED `needs:chairman` (its `labeled` events, and its comments), and NONE when nothing carries the label.
  conditionalOnChairmanLabelledRow: "api repos/{owner}/{repo}/issues/{n}/events and /comments (withChairmanEventTimes -- chairman-answered)",
  // #3079: ONE REST CALL PER NON-PRIMARY CODE REPOSITORY, every tick -- the newest push runs of its `ci.yml` on `main` -- and three more on a tick that finds
  // it red. None for one declared project, which is why it is not in `unconditional`: that list is the primary's own.
  perOtherCodeRepository: "api repos/{repo}/actions/workflows/ci.yml/runs (readTrunkRed -- trunk-red for a declared code repository)",
  // ONE call, and it needs no admin (#2331). It used to be two -- the admin-only protection endpoint, then
  // `branches/main` as the discriminator for its 404 (#2106, #2022) -- and the discriminator's only job
  // was to explain the admin-only 404, which `branches/main` does not give a non-admin credential. Conditional on a settled-red check.
  // #3448: AND ON A GREEN DRAFT, which the ready-flip over a red verify stamp needs the required list for (`requiredWhenNeeded`).
  conditionalOnRed: "api branches/main (requiredCheckNames)",
  // #2117: ONE MORE CORE READ ON THE SAME RED TICK -- `main`'s tip commit, so the `pr-checks-failing` prompt can
  // say whether `main` moved after the failing run started. `branches/main` already carries that commit, but
  // `requiredCheckNames` returns a bare list and four tests pin its shape; a second read costs one call on a tick
  // that is already paying one, and never touches a healthy tick.
  conditionalOnRedBase: "api commits/main (readBaseTip -- pr-checks-failing's `has main moved`)",
  // #1969, AND IT IS COUNTED HERE BECAUSE THE LAST ONE WAS NOT. This constant exists because "two `gh`
  // calls" was repeated for weeks while three readers were added, and a reviewer had to measure the call
  // sites to find it. The condition is `shouldBeMerging` finding a green, unheld, non-draft PR -- which
  // on a healthy queue is the COMMON case, so unlike the two above this one is usually paid. It is still
  // conditional rather than unconditional: a tick with nothing green and unheld makes no call at all.
  // #3045 (was #2176's commit chain): ONE REST CALL PER PULL REQUEST THE REVIEW QUESTION IS ASKED OF, plus one per older head a review or
  // verdict names (at most MAX_EVIDENCE_HEADS), on the CORE pool; a pull request whose checks are running adds the commit list. `commits`
  // cannot ride on `pr list`: GraphQL refuses it.
  conditionalOnUnreviewedGreenPr: "api repos/{repo}/compare/{base}...{head} (withPatchIds -- the patch id), and pulls/{n}/commits while checks run",
  // a11ign#3199: ONE REST CALL PER COMMIT COMPARED, and only for a pull request with a refusal at an older head whose patch equals the head's
  // (`refusalHeads`): each such commit, then the head when one of them had a failing check. A pull request with no such refusal pays none.
  conditionalOnEqualPatchRefusal: "api repos/{repo}/commits/{sha}/check-runs (withFailingChecks -- does the refusal still apply)",
  // #2416: ONE REST CALL PER OPEN PULL REQUEST CARRYING `awaiting-evidence`, and NONE when no open pull
  // request carries it -- the label's age is not on `pr list`, so the labelled ones are asked and only those.
  conditionalOnAwaitingEvidenceLabel: "api repos/{repo}/issues/{n}/events (readEvidenceLabelledAt -- awaiting-evidence-stale)",
  // #3384: ONE REST CALL PER CLAIMED ROW ALREADY OVER THE CALL-COUNT THRESHOLD that declares no wait now -- the events say when its last wait was lifted,
  // so the calls made during the wait are not charged to it. A row at or under the threshold, or waiting, pays none.
  conditionalOnCallCountedRow: "api repos/{repo}/issues/{n}/events (readWaitClearedAt -- row-call-count-signal)",
  conditionalOnGreenUnheldPr: "api graphql (open PRs' mergeQueueEntry -- readUnarmed)",
  // #3019: ONE GRAPHQL CALL PER UNARMED CANDIDATE (the timeline's queue events, readEjections), and for one the queue EJECTED, one REST
  // call for the failed `merge_group` run and one `run view --log-failed`. A healthy tick has no unarmed candidate and pays none of it.
  conditionalOnUnarmedPr: "api graphql timelineItems (readEjections); api actions/runs?event=merge_group; run view --log-failed (readEjectionRun)",
  // #2110, AND IT IS ONE CALL FOR THE WHOLE CLAIMED POPULATION RATHER THAN ONE PER ROW. `--label
  // in-progress` filters server-side, so the page is the claimed rows and nothing else -- 8 of them on
  // 2026-09-23 against 500 open rows -- and asking every one of them for its comments in a single
  // `issue list` is what keeps this a bounded read as the org grows. A per-row `issue view` would have
  // been N calls and would have made the tick's cost a function of how busy the org is, which is the one
  // property `work:tick` cannot trade away.
  //
  // CONDITIONAL, AND HONESTLY SO: the condition is that ANY row is claimed, which a busy org always
  // satisfies. It is counted as conditional rather than unconditional because a quiet org genuinely pays
  // nothing, and because the answer is already in hand -- `readOpenRows` has fetched the labels, so
  // asking costs no call of its own. The comment bodies are NOT added to the unconditional 500-row read:
  // that would carry every comment on every open row through a 32MB buffer on every tick.
  conditionalOnClaimedRows: "issue list --label in-progress --json number,comments"
    + " (readClaimedRowComments -- claimed-row-amended)",
  // #2470: ONE MORE READ, PAID BY THE SAME CONDITION (some row is claimed) and for the same reason it is one call and not
  // one per row: the newest merged pull requests, of which the claimed branches' are found by name. It bounds what a
  // release for a MERGED row can see to the newest 100 -- at this org's rate about a day -- and a merge older than that,
  // seen only after the gate was down for longer, is missed, not guessed.
  conditionalOnClaimedBranches: "pr list --state merged --limit 100 --json number,headRefName,mergedAt,title,labels"
    + " (readMergedPrs -- claim-stalled's merged release)",
  // #2286, WIDENED BY #2741: ONE CALL FOR EVERY BLOCKER, paid only when some unclaimed row OR some
  // claimed one has a cleared blocker to ask about. `gh`'s `blockedBy` nodes carry no closing time, and a
  // per-blocker read would make the tick's cost a function of how many rows are waiting.
  conditionalOnClearedRows: "issue list --state closed --limit 100 --json number,closedAt"
    + " (readRecentlyClosed -- unclaimed-blocker-cleared's and blocker-cleared's backoff)",
  // #2356: FOUR MORE REST CALLS, paid ONLY by a tick that found `main` red -- the run's jobs, the recheck
  // job's annotations, `run view --log-failed` for the failing test names, and the merged PR's session.
  // A healthy `main` pays none of them; a red one is rare and short-lived by the ruling this cause serves.
  conditionalOnRedTrunk: "api runs/{id}/jobs, check-runs/{id}/annotations, run view --log-failed,"
    + " commits/{sha}/pulls (readTrunkRed -- trunk-red)",
});

/**
 * THE READS THAT SPEND NO API POOL AT ALL, counted separately BECAUSE they are free rather than left out
 * because they are.
 *
 * `GH_READS` above exists because "two `gh` calls" was repeated for weeks while three readers were added,
 * and a reviewer had to measure the call sites to find it. A read that costs no pool is even easier to
 * add uncounted, and this one is load-bearing in a way that makes its cost worth writing down: #2031's
 * detection MUST NOT spend GraphQL, because the board goes stale precisely when the pool is exhausted
 * and a detector that spent it would be blind in the same outage that produces the defect. That is a
 * property of the implementation, so it is stated where the next person adding a read will read it, and
 * pinned behaviourally in `work-gate.test.ts` (the seam is handed a spy and the binary it spawns is
 * asserted to be `git`, never `gh`).
 */
export const GIT_READS = Object.freeze({
  unconditional: ["git ls-remote --heads origin (readRowBranches -- row-branch-unshipped)"],
  // #2470: LOCAL, AND SPENDS NO POOL. Per claimed row: `git rev-parse` and `git log` for the newest commit on its branch and
  // on `origin/<branch>`; `git status`, `git rev-list` only for a row that is quiet or blocked or merged. Plus one
  // `systemctl --user show herdr.service` for the restart the no-progress clock may not start before.
  // #2941: LOCAL, ONE CALL AT MOST. `git worktree list --porcelain` plus a `.a11y-owner` read per stamped tree, made only when a
  // pull request reaches the stamp rung of `ownerOfPr` -- no label, no live row, no live session in its head ref.
  conditionalOnUnownedPr: "git worktree list --porcelain; .a11y-owner per stamped tree (withNamedOwners -- ownerOfPr's stamp rung)",
  conditionalOnClaimedRows: "git rev-parse/log per claimed branch; git status/rev-list per QUIET claimed worktree;"
    + " systemctl --user show herdr.service (claim-stalled)",
});

/**
 * Every `git` spawn in this file, stripped of the `GIT_*` redirects git exports into a hook environment.
 * `git-env.mjs`'s header records the incident: fifteen commits landed in the wrong checkout because an
 * inherited `GIT_DIR` beat `cwd`. This tick runs under systemd, where the environment is not one a
 * person typed and is therefore not one anybody has looked at.
 * @param {string} cmd @param {string[]} args
 */
const defaultSpawn = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", env: sandboxGitEnv() });

/**
 * `git`'s leading arguments for every read about the PROJECT: `-C <the project checkout>`. #3091: the tick's
 * `WorkingDirectory` is this TOOL's checkout since the cut-over, so a bare `git ls-remote --heads origin` asked
 * the TOOL's repository about the PROJECT's rows -- a tool branch ending `-3064` shelved row #3064 for 88
 * ticks. `HOME_CHECKOUT` is what every other project-file read in the tool already asks.
 */
const PROJECT_GIT = Object.freeze(["-C", HOME_CHECKOUT]);

/**
 * WHAT ORIGIN ACTUALLY HOLDS -- every branch whose name ends `-<digits>`, with that row number.
 *
 * #2031: THE GATE HAD NO WAY TO SEE PUSHED WORK, and `ready` with no `session:` label was the entire
 * question it asked before offering a row as a fresh start. Measured 2026-09-22 on #2000: the branch
 * `agent/worktree-prune-unit-2000` was pushed at 21:02:36Z and the row read `ready` and unclaimed until
 * 21:22Z, with `gh pr list --head <branch> --state all` returning `[]` for that whole window. The gate
 * offered it throughout and routed a second session into the same three Region paths at 21:06Z; what
 * stopped that session was a worktree-PATH collision, which is not a guard aimed at this.
 *
 * `ls-remote` RATHER THAN A `gh` CALL, AND THAT IS THE DESIGN RATHER THAN A SAVING. Opening the pull
 * request is the act that makes a row look claimed, and that act spends GraphQL -- #1996's PR was never
 * opened because the shared 5,000-point pool was exhausted until 21:20:11Z. So the board goes stale
 * exactly when the pool is gone, and a detector that spent the pool would be blind in the one outage it
 * exists for. This is a LOCAL git call: it fits inside the tick's budget without widening `GH_READS`.
 *
 * `null` FOR A REFUSAL, NEVER `[]` -- #1286's rule, and here it means the cause is not evaluated this
 * tick and NOTHING is shelved. "Could not ask origin" is not "no row has a branch", and it is not
 * "every row has one" either: a tick that cannot reach the remote must go on offering rows exactly as it
 * did before this existed. `row-claim.mjs` THROWS on the same failure and that difference is deliberate
 * -- a claim is about to write and must refuse on a guess; a tick is about to say nothing new.
 *
 * @param {(cmd: string, args: string[]) => string} [run]
 * @returns {{ branch: string, head: string, row: number }[] | null} `null` when refused, never `[]`
 */
export function readRowBranches(run = defaultSpawn) {
  try {
    return rowBranchesInListing(run("git", [...PROJECT_GIT, ...LS_REMOTE_ARGS]));
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
 *
 * `meta` joined 2026-09-20 (#1804): a `backlog`+`meta` row ("Not work: a container or process row") has
 * no Region/Acceptance/done-when shape to promote and, unlike `fleet-gated`, is not routed to anyone
 * either -- so it belongs in the POOL's list, not just the owner's subtraction. #20 (the daily board
 * report thread) carried `backlog`+`meta` with no other `NOT_STARTABLE` label and kept re-triggering
 * `ready-queue-empty` on a judgment already settled five times that day.
 */
export const NOT_PICKABLE = Object.freeze([BLOCKED_LABEL, "fleet-gated", "epic", "disputed", "decision",
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
 *
 * THE POOL IS ONE NAME AGAIN -- #2506, the pool half of the standing-engineer retirement (`ceo`'s ruling on
 * #2470, "The pool, decided"). `worker-capture` is retired, so no generic engineer may claim a `fleet-gated`
 * `lane:orchestrator` row (`laneReason` refuses it) and fleet-gated throughput is `orchestrator`'s own turn
 * rate until `orchestrator` shows a generic engineer's `lab:job` dispatch cannot collide with another capture;
 * the exception then attaches to a ROW, not to a name. The value stays a LIST on purpose: every reader above
 * still treats it as one.
 */
export const ROUTED_TO = Object.freeze({ "fleet-gated": Object.freeze(["orchestrator"]) });

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
export const LANE_OWNER = Object.freeze({ [`${LANE_PREFIX}ceo`]: "ceo", [`${LANE_PREFIX}orchestrator`]: "orchestrator" });

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
 *
 * IMPORTED, NOT REDECLARED (#2619, child 3d of #69): `project-vocabulary.mjs`'s field, aliased to this
 * file's own established name.
 */
export { CHAIRMAN_LABEL };

/**
 * The label for a row parked ON PURPOSE until its prerequisite phase is done (chairman, 2026-09-26): `ceo` schedules
 * it, and it is never `needs:chairman`. Like that label it is a wait `waitingOn` does not read, and this is the THIRD
 * reader of the gap (after #2583 and #2604): #2568 was ordered for promotion 30 minutes after `product-manager` had
 * parked it, because its blockers had closed. Skipped in each population that offers a row for PROMOTION, not taught
 * to `waitingOn`, which every reader of that function would then inherit.
 */
export const PARKED_LABEL = "parked";

/**
 * Where a `ready-row-unclaimed` order says which directory to launch the claim from -- FILLED IN BY `wake.mjs` (#2405),
 * because the answer is a fact about the RECIPIENT (does `role-<you>` exist?) and the gate routes a pool order before
 * anyone has taken it. Exported from here so the two files cannot spell it differently; `wake.mjs` already imports this one.
 */
export const LAUNCH_PLACEHOLDER = "<launch-directory>";

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
    return withChairmanEventTimes(parsed.sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt))), run);
  } catch {
    return null;
  }
}

/**
 * #3390: THE CHAIRMAN'S OWN GITHUB LOGIN. A comment from it after the label went on is an answer. The org's accounts are deliberately
 * absent: `ceo` recording an answer is the half-finished state this check catches, and it is recognised by the provenance line instead.
 * A renamed account reads as "never answered" until this moves, which is the quiet direction, so a rename is a row to file.
 */
export const CHAIRMAN_LOGINS = Object.freeze(["DanBeckDev"]);

/** @param {string[]} times ISO times @returns {string | null} the newest, or `null` for none */
function newestTime(times) {
  const dated = times.filter((t) => Number.isFinite(Date.parse(t)));
  return dated.length === 0 ? null : dated.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
}

/** @param {string} out `gh api --jq` output, one JSON object per line @returns {any[]} */
function jsonLines(out) {
  return out.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
}

/**
 * When `needs:chairman` was LAST applied to the row, or `null` when no `labeled` event could be read for it. The last one, because a
 * label taken off and applied again is a new ask -- that is how a row is re-asked, as data rather than prose.
 * @param {number} number @param {(args: string[]) => string} run
 */
function readChairmanLabelledAt(number, run) {
  const out = run(["api", `repos/{owner}/{repo}/issues/${number}/events`, "--paginate", "--jq",
    `.[] | select(.event == "labeled" and .label.name == "${CHAIRMAN_LABEL}") | .created_at`]);
  return newestTime(out.split("\n").map((line) => line.trim()));
}

/**
 * When the chairman last acted on the row: a comment by the chairman's own login, or the answer comment `answers.mjs` writes (a bot's
 * account carrying `PROVENANCE` as its FIRST words -- a line quoted further down is somebody repeating it, not the chairman answering).
 * `null` when there is none. The body is cut in the projection: the provenance line is the first line and nothing else is read.
 * @param {number} number @param {(args: string[]) => string} run
 */
function readChairmanEventAt(number, run) {
  const out = run(["api", `repos/{owner}/{repo}/issues/${number}/comments`, "--paginate", "--jq",
    ".[] | {author: (.user.login // \"\"), at: .created_at, body: ((.body // \"\") | .[0:200])}"]);
  const events = jsonLines(out).filter((c) => CHAIRMAN_LOGINS.includes(c.author) || String(c.body).startsWith(CHAIRMAN_ANSWER_PROVENANCE));
  return newestTime(events.map((c) => String(c.at)));
}

/**
 * Each row with `labelledAt` and `chairmanEventAt` (ISO or `null`) attached -- the two times `chairmanAnsweredOrders` compares.
 * ONE PAIR OF REST CALLS PER LABELLED ROW and none when nothing carries the label (`GH_READS.conditionalOnChairmanLabelledRow`).
 *
 * A ROW WHOSE READ WAS REFUSED, OR WHOSE LABEL TIME COULD NOT BE FOUND, CARRIES `chairmanReadRefused` AND NEITHER TIME: "could not
 * determine" shares a value with neither "answered" nor "not answered" (`chairmanReadsRefused` reports them, the tick says so).
 * @param {any[]} rows @param {(args: string[]) => string} run
 */
export function withChairmanEventTimes(rows, run) {
  return rows.map((row) => {
    try {
      const labelledAt = readChairmanLabelledAt(Number(row.number), run);
      if (labelledAt === null) return { ...row, chairmanReadRefused: true };
      return { ...row, labelledAt, chairmanEventAt: readChairmanEventAt(Number(row.number), run) };
    } catch {
      return { ...row, chairmanReadRefused: true };
    }
  });
}

/** @param {any[]} rows rows from {@link readChairmanBlocked} @returns {number[]} the rows whose timeline could not be read */
export function chairmanReadsRefused(rows) {
  return rows.filter((row) => row.chairmanReadRefused === true).map((row) => Number(row.number));
}

/**
 * #3390: ONE ORDER TO `ceo` PER `needs:chairman` ROW WHOSE NEWEST CHAIRMAN-SIDE EVENT IS NEWER THAN ITS NEWEST LABEL EVENT.
 *
 * #3228 was labelled 2026-10-03T14:05:56Z, the chairman's session commented 2026-10-04T10:17:05Z, and the label stood for hours:
 * the daily reminder covers the whole set and cannot tell an answered row from an unanswered one. THE GATE WRITES NO LABELS, so it
 * orders the session whose job it is: take the label off, or take it off and apply it again after stating the new act (a newer label
 * event ends the order, so re-asking is data and not prose).
 *
 * KEYED ON THE ROW AND THE CHAIRMAN EVENT'S TIME: a new event is a new question, the same one is not asked as new. A row without both
 * times (never read, or refused) is skipped here and reported by {@link chairmanReadsRefused}; `NaN > NaN` is false, so absence is not "answered".
 *
 * @param {any[]} rows @returns {{session: string, cause: string, subject: string, discriminator: string, prompt: string, causeKey: string}[]}
 */
export function chairmanAnsweredOrders(rows) {
  const answered = rows.filter((row) => Date.parse(row.chairmanEventAt) > Date.parse(row.labelledAt));
  return answered.slice(0, MAX_ROW_ORDERS_PER_TICK).map((row) => {
    const ref = subjectRef(row.repoKey, row.number);
    const stamp = String(row.chairmanEventAt).replace(/[-:]/g, "");
    return {
      session: "ceo",
      cause: "chairman-answered",
      subject: `row-${ref}`,
      discriminator: stamp,
      prompt: `${subjectMention(row)} STILL CARRIES \`${CHAIRMAN_LABEL}\` AND THE CHAIRMAN HAS ACTED ON IT SINCE: the label was last `
        + `applied at ${row.labelledAt}, and the chairman-side event (their own comment, or the answer comment carrying the messaging `
        + `provenance line) is at ${row.chairmanEventAt}.\n`
        + "Read the row and do ONE of two things:\n"
        + `- it was answered: \`gh issue edit ${row.number} --remove-label ${CHAIRMAN_LABEL}\`, and record what you will do about it;\n`
        + "- it was NOT answered and something is still owed: remove the label and apply it again, after stating the NEW act the chairman "
        + "must take. The label's newer event is what ends this order, so re-asking is a field and not a sentence.\n"
        + "A stale label re-alerts the chairman and makes the count meaningless (#3228 held it for hours).",
      causeKey: `ceo/chairman-answered/row-${ref}/${stamp}`,
    };
  });
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
    const out = run(["issue", "list", "--state", "open", "--label", BACKLOG_LABEL, "--limit", "200",
      "--json", "number,title,createdAt,labels,body,blockedBy"]);
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
    //
    // `needs:chairman` IS A WAIT THAT `waitingOn` DOES NOT READ, AND THIS IS THE SECOND READER OF THAT GAP
    // (#2604, after #2583/#2585 closed `unclaimedClearings`). The label names a person and clears when
    // removed, so a row carrying it is not stock anybody can promote: `ready-queue-empty` counted #2561 (whose
    // first step, a private repository, did not exist) and woke `product-manager` to re-derive a verdict
    // already on the row. Dropped HERE, in this reader's own population, and not taught to `waitingOn`, which
    // every reader of that function would then inherit -- the same choice #2585 made.
    return parsed.filter((r) => !labelsOf(r).some((/** @type {string} */ n) => NOT_STARTABLE.includes(n)))
      .filter((r) => !labelsOf(r).includes(CHAIRMAN_LABEL))
      // `parked` IS THE THIRD READER OF THE SAME GAP (#2653): a row parked until its prerequisite phase is done is
      // not stock either, and `laneBacklogOrders` and `decide`'s pool count consume THIS list, so they inherit it.
      .filter((r) => !labelsOf(r).includes(PARKED_LABEL))
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

/** The label `ceo` created for "offer this row before others"; `offerOrder` reads it (#2296). */
export const PRIORITY_LABEL = "priority";

/** @param {any} x @returns {string[]} */
export const labelsOf = (x) => (x?.labels ?? []).map((/** @type {any} */ l) => String(l?.name ?? l));

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
 * #3095: THE LIST MAY HOLD THE PULL REQUESTS OF MORE THAN ONE DECLARED REPOSITORY, and a pull request `tagged` with its `repo` and
 * `repoKey` keeps both, so `fileOverlapReason` compares a Region entry only with the files of the repository it is prefixed for and names
 * the PR as `#7 in owner/repo`. Its `Closes #7` is read against ITS OWN repository (`prRepo`), as `lookupOpenPrFiles` does: a bare number
 * in agent-org's PR body is agent-org's #7, never the tracker's row 7. An untagged PR (the primary's own) is exactly what it was.
 *
 * @param {any[]} prs
 * #2493: `held` rides along too -- whether the PR carries a `hold:` label -- from `labels`, already on that call.
 *
 * @param {{ trackerRepo?: string }} [where] the tracker whose rows a `Closes` is read against; the project's first when omitted
 * @returns {{ number: number, files: string[], changedFiles: number, closes: number[], held: boolean, repo?: string, repoKey?: string }[]}
 */
export function comparablePrFiles(prs, { trackerRepo } = {}) {
  return prs
    .map((p) => ({
      number: Number(p?.number),
      changedFiles: Number(p?.changedFiles),
      files: (p?.files ?? []).map((/** @type {any} */ f) => String(f?.path ?? f)),
      closes: declaredClosedRows(p?.body, { ...(p?.repo === undefined ? {} : { prRepo: p.repo }), ...(trackerRepo === undefined ? {} : { trackerRepo }) }),
      // #2493: the other half of the exclusion `fileOverlapReason` reads -- a `hold:` label on the PR.
      held: holdersOf(labelsOf(p)).length > 0,
      ...(p?.repo === undefined ? {} : { repo: String(p.repo), repoKey: String(p.repoKey ?? "") }),
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
 * #2493: AND SO DOES THE HELD-PR EXCLUSION, for the same reason: a PR carrying `hold:` whose every closed row is
 * `blockedBy` this row is waiting on it and cannot merge first, so it is no reason to withhold the row -- #2399 was
 * shelved behind #2376, which was waiting on #2399. `blockersOf` is how the gate answers "what blocks that row" from
 * the `blockedBy` it already holds for every open row (`blockersFromRows`), so it makes no call of its own.
 *
 * @param {any} row @param {{ number: number, files: string[], changedFiles: number, closes?: number[], held?: boolean }[]} prFiles
 * @param {{ rootFiles?: Set<string>, blockersOf?: (row: number) => number[] | null }} [options] `rootFiles` is
 *   passed to `declaredRegionFiles` so a test can name its own tree rather than needing this repository's
 * @returns {string | null}
 */
export function blockedOnOpenPr(row, prFiles, options) {
  // NOTHING TO OVERLAP. With no comparable open PR no refusal is possible, and reading the row's Region
  // to discover that would spawn `git ls-tree` for an answer already known.
  if (prFiles.length === 0) return null;
  const mine = declaredRegionFiles(String(row?.body ?? ""), options);
  if (mine === null) return null;
  return fileOverlapReason(mine, prFiles, { rowNumber: Number(row?.number), blockersOf: options?.blockersOf }).reason;
}

/**
 * #3475: why B4 would refuse this row RIGHT NOW because of a row somebody has ALREADY CLAIMED, or `null`. A claimed row holds its Region's
 * files from its claim, and has no open pull request until its first push, so `blockedOnOpenPr` cannot see it -- #3414 was offered and
 * claimed over three files #3423 had held for 27 minutes. The reason names the holder, and it clears when that row closes or is released:
 * the shelving is derived each tick from the `openRows` the gate already read, and writes nothing.
 *
 * FAILS THE WAY THE PULL-REQUEST HALF DOES: no `openRows` read, or a row with no Region section, is "cannot ask" and shelves nothing,
 * and the claim still asks (and refuses on a failed read). `claimed` is {@link claimedRegionsOf}'s output, computed once per call.
 *
 * @param {any} row @param {{ number: number, files: string[] }[]} claimed
 * @param {{ rootFiles?: Set<string>, blockersOf?: (row: number) => number[] | null, openPrs?: { closes?: number[] }[] }} options
 * @returns {string | null}
 */
export function blockedOnClaimedRow(row, claimed, options) {
  if (claimed.length === 0) return null;
  const mine = declaredRegionFiles(String(row?.body ?? ""), options);
  if (mine === null) return null;
  return claimedRegionOverlapReason(mine, claimed, { rowNumber: Number(row?.number), blockersOf: options.blockersOf, openPrs: options.openPrs });
}

/**
 * #2493: what blocks a row, answered from the open rows the gate has ALREADY READ -- `blockedBy` rides
 * `readOpenRows`'s call -- so the exclusion costs the gate nothing. `null` for a row not among them (closed, or
 * beyond the read's limit), which the rule reads as "not excluded".
 *
 * @param {any[] | null | undefined} openRows
 * @returns {(row: number) => number[] | null}
 */
export function blockersFromRows(openRows) {
  const byNumber = new Map((openRows ?? []).map((r) => [Number(r?.number), r]));
  return (number) => {
    const found = byNumber.get(number);
    return found ? (found.blockedBy?.nodes ?? []).map((/** @type {any} */ n) => Number(n.number)) : null;
  };
}

/**
 * PURE. `readRowBranches`'s flat listing, indexed by row number.
 *
 * An ABSENT or `null` listing yields an EMPTY index, and every caller then behaves exactly as it did
 * before #2031 -- that is the degradation `readRowBranches`'s `null` is for, expressed once here rather
 * than as a branch at each of the two call sites.
 * @param {{ branch: string, head: string, row: number }[] | null | undefined} rowBranches
 * @returns {Map<number, { branch: string, head: string }[]>}
 */
function branchIndex(rowBranches) {
  /** @type {Map<number, { branch: string, head: string }[]>} */
  const byRow = new Map();
  for (const found of rowBranches ?? []) {
    const list = byRow.get(found.row) ?? [];
    list.push({ branch: found.branch, head: found.head });
    byRow.set(found.row, list);
  }
  return byRow;
}

/**
 * PURE. What the tick log says about a row whose branches `origin` already holds.
 *
 * IT STATES THE BRANCH AND ITS SHA AND CONCLUDES NOTHING, which is #2031's own "what this will NOT fix":
 * a branch on `origin` for a `ready` row means only that a branch exists. Whether it is finished work
 * awaiting a pull request, or abandoned work, is a reading of the branch -- so this must not assert the
 * row is done, and the wording is the guard against a reader inferring it from a cause that fired.
 * @param {{ branch: string, head: string }[] } pushed
 * @returns {string}
 */
function branchesText(pushed) {
  const named = pushed.map(({ branch, head }) => `\`${branch}\` at ${head.slice(0, 12)}`).join("; ");
  return `origin already holds ${pushed.length === 1 ? "a branch" : `${pushed.length} branches`} carrying `
    + `this row's number: ${named}. That is NOT a claim that the work is finished -- only that it EXISTS `
    + "and nothing on the board says so";
}

/**
 * The template sections this row's body does not state, `[]` when it is complete OR WHEN THE BODY WAS NOT READ.
 * A row with no string `body` is "not asked", never "asked and empty": `readReadyRows` always requests it, so a
 * caller that lacks it (a fixture, a future read) must not shelve the whole queue on an absence.
 * @param {any} row
 * @returns {string[]}
 */
function missingFieldsOf(row) {
  return typeof row?.body === "string" ? missingTemplateFields(row.body) : [];
}

/** @param {string[]} missing @returns {string} */
const templateGapText = (missing) => `its body has no ${missing.map((f) => `\`## ${f}\``).join(", ")}`;

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
 * @param {any[]} readyRows @param {{ number: number, files: string[], changedFiles: number, closes?: number[], held?: boolean }[]} prFiles
 * @param {{ rootFiles?: Set<string>,
 *           openRows?: any[] | null,
 *           rowBranches?: { branch: string, head: string, row: number }[] | null,
 *           clock?: {today?: string, nowMs?: number} }} [options]
 *        `rowBranches` is `readRowBranches()`. It DEFAULTS TO ABSENT, which is "not asked or refused":
 *        nothing is shelved for it and every row is offered exactly as it was before #2031, so a tick
 *        that cannot reach `origin` is never worse off than one from before this existed.
 *        `openRows` (#2493) is every open row the gate read, for the `blockedBy` edges that say whether a HELD PR is
 *        waiting on the row asked about. ABSENT, no held PR is excluded and B4 refuses exactly as before.
 *        It is also where #3475 reads the rows already CLAIMED (`in-progress`), whose Regions hold their files before any pull request
 *        exists: a Ready row sharing a file with one is shelved, naming it. ABSENT, no row is shelved for it.
 *        `clock` is injected the way `partitionFleetBatch` already injects one, and #2113 is why this
 *        path needs one at all: a `Not-before:` may now name an HOUR, so whether a row is offerable can
 *        change within a single day and a test cannot pin that against the host clock.
 * @returns {{ offerable: any[], blocked: { number: number, owner: string | null, reason: string }[] }}
 */
export function partitionUnclaimed(readyRows, prFiles, options) {
  const offerable = [];
  const blocked = [];
  const { today = todayIso(), nowMs = Date.now() } = options?.clock ?? {};
  const onOrigin = branchIndex(options?.rowBranches);
  const blockersOf = blockersFromRows(options?.openRows);
  const claimed = claimedRegionsOf(options?.openRows, options) ?? [];
  for (const row of readyRows) {
    // #2005's OPEN-CHECK, ANSWERED BY THIS LINE AND NOT BY A NEW RULE. The filer asked whether
    // `answer:<session>` should hold a row against its OWN HOLDER -- #1948 was `in-progress` +
    // `session:worker-tooling` + `answer:worker-tooling`, and a session is not blocked by its own
    // unanswered question the way a stranger is. It never arises here: a claimed row carries
    // `CLAIM_LABEL` and leaves on this line, before anything asks what it is waiting on. So "not offered
    // to a session other than the one already holding it" needed no expression -- a held row is not
    // offered to anybody, which is strictly stronger and was already true.
    if (labelsOf(row).includes(CLAIM_LABEL)) continue;
    // #2791: A ROW THE CLAIM WILL REFUSE FOR A TEMPLATE DEFECT IS NOT STOCK. #2729 and #2730 read `ready` for ~38h
    // with no `## Open-check`, so every offer ended in `NOT CLAIMED: ... is missing Open-check` while the pool
    // counted them and `ready-queue-empty` stayed silent. SHELVED, like every reason here, and the reason
    // names the section: `incompleteRowOrders` is what asks somebody to add it.
    const missing = missingFieldsOf(row);
    if (missing.length > 0) {
      blocked.push({ number: Number(row.number), ...subjectIdentity(row), owner: laneOwnerOf(row),
        reason: `${templateGapText(missing)} -- \`row-claim\` refuses it, and it clears when the section is added` });
      continue;
    }
    // #2031, AND AHEAD OF EVERY OTHER SHELVING REASON. The others say this row cannot be STARTED yet;
    // this one says it may already be FINISHED, and offering it as a fresh start is the one outcome
    // measured to cost a whole session's turn -- #2000 was offered throughout the 20 minutes its branch
    // sat unshipped on `origin`, and a second session was routed into its three Region paths.
    // SHELVED RATHER THAN DROPPED, like every other reason here: the `SHELVED row #N:` line names the
    // branch and its sha, and `rowBranchOrders` sends somebody to read it. A row that vanishes silently
    // is the failure `blocked` already is.
    const pushed = onOrigin.get(Number(row.number)) ?? [];
    if (pushed.length > 0) {
      blocked.push({ number: Number(row.number), ...subjectIdentity(row), owner: laneOwnerOf(row), reason: branchesText(pushed) });
      continue;
    }
    // A DECLARED WAIT SHELVES THE ROW RATHER THAN HIDING IT. It goes to `blocked` with its reason, so
    // the tick log says why -- a row that vanishes silently is the failure `blocked` already is.
    //
    // SINCE #2005 THAT INCLUDES `answer:<session>`, and nothing here changed to make it so: `waitingOn`
    // gained the kind and this call site inherited it. That is the seam working -- the alternative, a
    // third prefix check written out here beside the one `readPromotableRows` already had, is exactly
    // how the offer path and the promotion path came to disagree in the first place.
    const waiting = waitingOn(row, today, nowMs);
    if (waiting) {
      blocked.push({ number: Number(row.number), ...subjectIdentity(row), owner: laneOwnerOf(row),
        reason: `${describeWaiting(waiting)} -- declared on the row, and it clears itself` });
      continue;
    }
    const reason = blockedOnOpenPr(row, prFiles, { ...options, blockersOf }) ?? blockedOnClaimedRow(row, claimed, { ...options, blockersOf, openPrs: prFiles });
    if (reason) blocked.push({ number: Number(row.number), ...subjectIdentity(row), owner: laneOwnerOf(row), reason });
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

export const conclusionOf = (/** @type {any} */ c) => String(c?.conclusion ?? c?.state ?? "").toUpperCase();

/** @param {any} c */
export function stillRunning(c) {
  const status = String(c?.status ?? "").toUpperCase();
  return status === "IN_PROGRESS" || status === "QUEUED" || status === "PENDING";
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
export function sessionOf(pr) {
  const label = labelsOf(pr).find((/** @type {string} */ n) => n.startsWith(SESSION_PREFIX));
  return label ? label.slice(SESSION_PREFIX.length) : null;
}

/**
 * PAID ONLY BY A RED TICK, the condition `requiredWhenNeeded` had before a green draft also asked it (#3448), so a healthy
 * queue pays neither this nor the base-tip read (#2117). Extracted from `main` for `requiredWhenNeeded`'s reason, and
 * exported with a `run` seam so a test can assert a healthy tick makes NO call.
 *
 * @param {any[]} prs @param {(args: string[]) => string} [run]
 * @returns {{sha: string, date: string} | null}
 */
export function baseTipWhenRed(prs, run = defaultRun) {
  return anyChecksRed(prs) ? readBaseTip(run) : null;
}

/**
 * PAID ONLY BY A TICK THAT CAN SEE A CLAIM. The `requiredWhenNeeded`/`epicsWhenShelfEmpty` shape: the
 * condition is derived from rows already in hand, so an org holding nothing makes no call.
 *
 * Extracted rather than written inline in `main` for the reason the two above it were -- `main`'s job is
 * to deliver what the gate found, and `complexity` counts every inline ternary there.
 *
 * @param {any[]} openRows
 * @returns {any[] | null} `null` when not asked or refused -- `decide` treats both the same way
 */
function claimedRowCommentsWhenHeld(openRows) {
  const held = openRows.some((r) => labelsOf(r).includes(CLAIM_LABEL));
  return held ? readClaimedRowComments() : null;
}

/**
 * #3486: THE CLAIMED ROWS' COMMENTS AS THE OUTCOME CLOCK READS THEM. `claimedRowCommentsWhenHeld` answers `null` for TWO things -- no row is claimed (nothing
 * was asked) and the read was refused -- and the clock must tell them apart: the first is "no claimed row to age", the second is "unread", reported as such
 * and never as nothing overdue. A claimed row and a `null` is the refusal; no claimed row is `[]`.
 * @param {any[]} openRows @param {any[] | null} claimedComments
 * @returns {any[] | null}
 */
function claimedCommentsForClock(openRows, claimedComments) {
  return claimedComments ?? (openRows.some((r) => labelsOf(r).includes(CLAIM_LABEL)) ? null : []);
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
      "--json", "number,title,labels,body,blockedBy,milestone,updatedAt"]));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * #2202: THE CLOSED ROWS THAT STILL OWE AN ANSWER -- the half of `answer-owed` that `readOpenRows` cannot see.
 *
 * `answer:<session>` is the org's only machine-readable "a named session still owes an answer here", and
 * `readOpenRows` is `--state open`, so a merge that closed the row ended the wake and nothing said it had
 * stopped. Measured 2026-09-22: #1936, #1970 and #2034, each labelled 5m23s to 14m45s before the merge that
 * closed it, none of the three questions ever answered. The close path now KEEPS the label
 * (`labelsToStrip`) and says so; this is what keeps acting on it.
 *
 * #2641: A MERGE CLOSES TWO THINGS, and this read chased only one. `trunkRedOrders` names the MERGED PULL REQUEST that
 * turned `main` red as its subject, `stuckRowOf` turns that into a number and `escalateStuck` labels it `answer:ceo`; a
 * pull request that is no longer open is no `gh issue list` row and no `readPrs` row, so that label was set and read by
 * nothing. `gh pr list --state all` is asked with `-is:open` -- merged AND closed-unmerged, the open ones being
 * `readPrs`'s -- so the same label names cost ONE more call and not a second `label list`. It asks for `isDraft`
 * because that field is how `isPullRequest` knows the row came from a pull request, and so how `answerOrders` says
 * "pull request" and not "row" to the session it wakes.
 *
 * THREE CALLS, AND EVERY ONE IS EXACT. `gh` matches one whole label name, and this is a PREFIX over one name per
 * session, so the repo's own `answer:` labels are listed first and the closed rows and pull requests carrying any of
 * them are asked for by name (`label:"a","b"` is GitHub's OR). A window over the newest closed rows or merged pull
 * requests would be one call, but a question older than the window would fall out of it -- the silent-void defect
 * again, one level down -- so this pays the calls to have no such edge. `-is:open` keeps the PR read's 100 for the
 * population it is FOR: an open pull request carrying the label would otherwise spend the window.
 *
 * ALL OR NOTHING: a refusal of either read is `null` for the whole, so `closedAnswerRows` says it once rather than
 * ordering the half that answered and staying silent about the half that did not.
 *
 * @param {(args: string[]) => string} [run]
 * @returns {any[] | null} `null` when refused, never `[]` -- "could not ask" is not "nobody owes anything"
 */
export function readClosedAnswerRows(run = defaultRun) {
  try {
    const labels = JSON.parse(run(["label", "list", "--search", ANSWER_PREFIX, "--limit", "100",
      "--json", "name"]));
    if (!Array.isArray(labels)) return null;
    const names = labels.map((l) => l?.name).filter((n) => typeof n === "string" && n.startsWith(ANSWER_PREFIX));
    if (names.length === 0) return [];
    const byLabel = `label:${names.map((n) => `"${n}"`).join(",")}`;
    const closedIssues = JSON.parse(run(["issue", "list", "--state", "closed", "--limit", "100",
      "--search", byLabel, "--json", "number,title,labels,state"]));
    const closedPrs = JSON.parse(run(["pr", "list", "--state", "all", "--limit", "100",
      "--search", `${byLabel} -is:open`, "--json", "number,title,labels,state,isDraft"]));
    if (!Array.isArray(closedIssues) || !Array.isArray(closedPrs)) return null;
    return withAnswerLabel([...closedIssues, ...closedPrs]);
  } catch {
    return null;
  }
}

/**
 * WHICH ROWS ARE THE FLEET BATCH -- ONE SPELLING, IMPORTED BY BOTH FEEDERS (#2443).
 *
 * The batch used to be scoped by the version-one-path MILESTONE, and `fleet-gated-nightly.mjs` carried
 * its own copy of that constant. A `fleet-gated` label means "the acceptance needs a fleet run"; a
 * milestone means "on the version-one path". Those are different questions, so a `fleet-gated` row filed
 * off-path, or moved there by #2273's sort, was invisible to `orchestrator` and nothing said so (#2212 sat
 * on `Out of release` for hours on 2026-09-24 until `product-manager` moved it back by hand).
 *
 * THE LABEL, AND THE ROW'S OWN WAITING FIELDS, AND NOTHING ELSE. `listArgs` is the `gh issue list` half
 * for the feeder that queries; `matches` is the local half for the feeder that already holds every open
 * row. Two feeders reading one object cannot disagree about the population again.
 */
export const FLEET_GATED_SELECTOR = Object.freeze({
  label: "fleet-gated",
  listArgs: Object.freeze(["--label", "fleet-gated"]),
  /** @param {any} row */
  matches: (row) => labelsOf(row).includes("fleet-gated"),
});

/**
 * The open `fleet-gated` rows, SPLIT BY WHETHER ANYTHING IS STOPPING THEM -- #2027.
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
 * `needs:chairman` IS THE FIFTH READER OF THE SAME GAP `waitingOn` deliberately does not close (after
 * #2583/#2585, #2604 and #2653's `parked`): the label names a person and clears when removed, and
 * `waitingOn`/`fleetWaitingOn` do not read it on purpose, so teaching it here rather than there keeps
 * every OTHER reader of those functions unchanged. Without this, `fleet-batch-due` re-fired on #2728
 * three minutes after `orchestrator` had already answered it -- a credential row that should never have
 * carried `fleet-gated`, but whose re-firing this filter alone would have prevented: `needs:chairman` is
 * not one of the order's own three machine-readable exits (`Fleet-hold-until:`, `--add-blocked-by`,
 * `Not-before:`), so a row answered that way never left the set. The rule is the one #1899 applied to
 * `answer:<session>`: a hold is an answer.
 *
 * @param {any[]} rows
 * @param {{today?: string, nowMs?: number}} [clock] injected so a test moves time without a global stub
 * @returns {{batch: any[], waiting: {number: number, reason: string}[]}}
 */
export function partitionFleetBatch(rows, clock = {}) {
  const { today = todayIso(), nowMs = Date.now() } = clock;
  const batch = [];
  const waiting = [];
  const gated = (rows ?? [])
    .filter(FLEET_GATED_SELECTOR.matches)
    .sort((a, b) => Number(a.number) - Number(b.number));
  for (const row of gated) {
    const held = labelsOf(row).includes(CHAIRMAN_LABEL)
      ? `waiting on the chairman (${CHAIRMAN_LABEL})`
      : fleetHeldPhrase(row, today, nowMs);
    if (held) {
      waiting.push({ number: Number(row.number),
        reason: `${held} -- declared on the row, and it clears itself` });
    } else batch.push(row);
  }
  return { batch, waiting };
}

/** @param {any} row @param {string} today @param {number} nowMs @returns {string | null} */
function fleetHeldPhrase(row, today, nowMs) {
  const held = fleetWaitingOn(row, today, nowMs);
  return held ? describeWaiting(held) : null;
}

/**
 * The `fleet-gated` rows that ARE dispatchable -- the batch #914 describes.
 *
 * @param {any[]} rows @param {{today?: string, nowMs?: number}} [clock]
 */
export function fleetBatchRows(rows, clock = {}) {
  return partitionFleetBatch(rows, clock).batch;
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
 * @param {{today?: string, nowMs?: number}} [clock]
 * @returns {{session: string, cause: string, subject: string, discriminator: string,
 *            prompt: string, causeKey: string}[]}
 */
export function fleetBatchOrders(rows, clock = {}) {
  const batch = fleetBatchRows(rows, clock);
  if (batch.length === 0) return [];
  const numbers = batch.map((r) => subjectMention(r)).join(", ");
  const key = batch.map((r) => subjectRef(r.repoKey, r.number)).join(".");
  return [{
    session: "orchestrator",
    cause: "fleet-batch-due",
    subject: "fleet-batch",
    discriminator: key,
    prompt: `${batch.length} row(s) carry \`fleet-gated\` and are open: ${numbers}.\n`
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

/**
 * A ROW FILED WITHOUT `row-file` IS INVISIBLE ON PROJECT 1, AND THE CHECK THAT SEES IT WOKE NOBODY (#2075).
 *
 * `row-file` is the only path that boards a row and nothing requires it. Measured 2026-09-23: 9 of 50 open rows had no
 * Project 1 item, two of them `ready` (claimable on the label, invisible in every Status view), and 28 of the 121 rows filed
 * since 2026-09-22T00:00Z (23%) never reached the board. `ready-label-audit`'s `reportAbsentFromBoard` asked exactly this and
 * answered correctly -- on a daily schedule, into a nightly that is red by design, so #1889 was still absent twenty hours
 * after it printed `ABSENT`. This is that question asked where `agent-practices.md` says such a question belongs: in the
 * gate, on an API call rather than a model turn and not a day late.
 *
 * IT ASKS EACH ROW FOR ITS OWN MEMBERSHIP AND NEVER READS THE BOARD LISTING, and that is the load-bearing choice. Measured
 * 2026-09-23 (the row's own comment): `gh project item-list` did NOT contain #2075 and #2076 about four minutes after they
 * were added, while `repository.issue(n).projectItems` reported both on the board seconds later. A tick runs every two
 * minutes, so a listing-based cause would wake `product-manager` for rows `row-file` had just boarded correctly -- the
 * noisiest possible false positive, on the one path that works. One connection query carries every open row's
 * `projectItems` in a single call, so this costs no more than the listing would have.
 *
 * `onBoard` IS TRI-STATE: `true`, `false`, or `null` for "could not tell" -- a row with more items than the page returned and
 * none of them Project 1, which is not the same claim as "not on the board" and is never reported as one.
 *
 * @typedef {{ number: number, title: string, createdMs: number, onBoard: boolean | null }} BoardFacts
 */
export const ROW_OFF_BOARD_QUERY = `
  query($owner: String!, $name: String!, $after: String) {
    # #3448: THE ACCOUNT AND ITS GRAPHQL BUDGET, IN AN ANSWER THIS TICK ALREADY PAYS FOR. \`rateLimit\` is never charged, so the pool-low signal costs no point.
    viewer { login }
    rateLimit { limit remaining resetAt }
    repository(owner: $owner, name: $name) {
      issues(states: OPEN, first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number title createdAt
          projectItems(first: 10) { totalCount nodes { project { number } } }
        }
      }
    }
  }
`;

/** The pages `readRowsOffBoard` will walk. Beyond this it returns `null`: a partial list is not a reading. */
const ROW_OFF_BOARD_MAX_PAGES = 10;

/**
 * HOW YOUNG A ROW IS TOO YOUNG TO CALL OFF THE BOARD. Not a lag allowance -- the read above has none -- but the window in
 * which `row-file` itself is between `gh issue create` and the board: the `item-add` of #2028 landed 3s after its creation and
 * the Status and label 8s and 9s after it (a timeline read from GitHub, ONE observation, not a bound). Five minutes is thirty
 * times that observation and one third of a wake's expiry window; a row genuinely left off is reported five minutes later than
 * it could have been, which nobody can measure against a defect that ran for twenty hours. CHOSEN WITH MARGIN, NOT DERIVED --
 * so it is a named constant beside its reason, and the freshness case in `work-gate.test.ts` pins that a row younger than
 * it is not reported.
 */
export const ROW_OFF_BOARD_GRACE_MS = 5 * 60_000;

/**
 * One open issue's board facts, from its `repository.issues` node.
 * @param {any} node
 * @returns {BoardFacts}
 */
function boardFactsOf(node) {
  const items = node?.projectItems;
  const found = Array.isArray(items?.nodes) && items.nodes.some((/** @type {any} */ n) => n?.project?.number === PROJECT_NUMBER);
  const complete = Array.isArray(items?.nodes) && items.nodes.length >= items.totalCount;
  return { number: node.number, title: String(node.title ?? ""), createdMs: Date.parse(node.createdAt),
    onBoard: found ? true : complete ? false : null };
}

/**
 * Every open row's Project 1 membership, read PER ISSUE, or `null` when the read was refused or is not a whole list.
 *
 * `null` MEANS COULD NOT ASK, NEVER "NOTHING IS OFF THE BOARD" -- #1286's rule, for its reason: a refused `gh` exits non-zero
 * with empty stdout, and an empty answer would read as a clean board. `errors` beside `data` is refused too (#555), and so is
 * a list still paging at `ROW_OFF_BOARD_MAX_PAGES`.
 *
 * #3448: THE GRAPHQL POOL THE ANSWER NAMES IS PUSHED ONTO `pools` (the first page's: one budget, read once), so the tick learns its own account's budget from the
 * read it was making. A refused read pushes nothing, and the pool-low signal then says it was not read.
 *
 * @param {(args: string[]) => string} [run]
 * @param {import("./org-health.mjs").PoolReading[]} [pools]
 * @returns {BoardFacts[] | null}
 */
export function readRowsOffBoard(run = defaultRun, pools = []) {
  const [owner, name] = repoNow().split("/");
  /** @type {BoardFacts[]} */
  const facts = [];
  try {
    let after = null;
    for (let page = 0; page < ROW_OFF_BOARD_MAX_PAGES; page++) {
      const args = ["api", "graphql", "-f", `query=${ROW_OFF_BOARD_QUERY}`, "-F", `owner=${owner}`, "-F", `name=${name}`];
      if (after !== null) args.push("-f", `after=${after}`);
      const parsed = JSON.parse(run(args));
      const issues = parsed?.errors ? null : parsed?.data?.repository?.issues;
      if (!Array.isArray(issues?.nodes)) return null;
      const pool = page === 0 ? poolFromRateLimitField(parsed.data) : null;
      if (pool !== null) pools.push(pool);
      facts.push(...issues.nodes.map(boardFactsOf));
      if (issues.pageInfo?.hasNextPage !== true) return facts;
      after = issues.pageInfo.endCursor;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The open rows that are provably off Project 1, oldest number first: no item there, and old enough that `row-file` cannot
 * still be on its way to adding one.
 *
 * @param {BoardFacts[]} facts
 * @param {number} [nowMs]
 * @returns {{ number: number, repoKey?: string, title: string }[]}
 */
export function rowsOffBoard(facts, nowMs = Date.now()) {
  return facts
    .filter((f) => f.onBoard === false && nowMs - f.createdMs >= ROW_OFF_BOARD_GRACE_MS)
    .map(({ number, title }) => ({ number, title }))
    .sort((a, b) => a.number - b.number);
}

/**
 * THE CAUSE: an open row has no item on Project 1, and `product-manager` is asked to board it (#2075).
 *
 * KEYED ON THE SET OF ABSENT ROW NUMBERS, `fleetBatchOrders`'s shape and for its reason: the key changes when the set
 * changes, so a row newly off the board is a new question, and it is the same string while the set is unchanged, so the wake
 * ledger's dedupe does not re-ask a settled one (#1433/#1435's defect from the other side). An EMPTY set is no order: this org
 * is normally clean, and a cause that could not go quiet would fire on every tick for ever. `null` (could not ask) is also no
 * order -- silence that is NOT a clean board, which the tick says on stderr.
 *
 * PLACED BESIDE `hostDriftOrders` in `decide`, AND FOR ITS REASON: a tracker that has drifted from what was filed is finished work
 * that has not taken effect (the row exists; nobody can see it) -- more urgent than a supply question, less urgent than a named
 * red build, and not withheld by a drain (see `START_CAUSES`).
 *
 * IT DOES NOT BOARD THE ROW. Boarding carries a Status judgment (#1990 is `In progress`, #2068 is `Ready`) and this repository's
 * audits report the debris rather than act on the tracker.
 *
 * @param {BoardFacts[] | null | undefined} facts `readRowsOffBoard`'s result; OMITTED AND `null` MEAN "NOT ASKED"
 * @param {number} [nowMs]
 * @returns {{session: string, cause: string, subject: string, discriminator: string,
 *            prompt: string, causeKey: string}[]}
 */
export function rowOffBoardOrders(facts, nowMs = Date.now()) {
  const absent = rowsOffBoard(facts ?? [], nowMs);
  if (absent.length === 0) return [];
  const key = absent.map((r) => subjectRef(r.repoKey, r.number)).join(".");
  return [{
    session: "product-manager",
    cause: "row-off-board",
    subject: "project-1",
    discriminator: key,
    prompt: `${absent.length} open row(s) have NO item on Project ${PROJECT_NUMBER}, so they are invisible in every Status view:\n`
      + absent.map((r) => `  ${subjectMention(r)} ${r.title}`).join("\n") + "\n"
      + "A row filed with a bare `gh issue create` never reaches the board: only `row-file` boards one, and a board label applied "
      + `AT CREATION (\`${READY_LABEL}\` or \`${BACKLOG_LABEL}\` one second after the row exists) is the fingerprint of that path. Each was read from `
      + "the ISSUE's own `projectItems`, not from a board listing (which lags minutes behind an add), and none is younger than "
      + `${ROW_OFF_BOARD_GRACE_MS / 60_000} minutes.\n`
      + `For each: add it to Project 1 at the Status its label says (\`${READY_LABEL}\` -> Ready, \`${BACKLOG_LABEL}\` -> Backlog, \`${CLAIM_LABEL}\` -> `
      + `In progress), and give it a release declaration (a milestone or \`${OUT_OF_RELEASE_LABEL}\`) if it has none -- \`row-file\` would have `
      + "refused a filing without one. THIS ORDER DOES NOT BOARD THE ROW FOR YOU: the Status is a judgment and it is yours.\n"
      + "THIS ARRIVES WHEN THE SET CHANGES. A row you leave off stays in the set and this order returns unchanged.",
    causeKey: `product-manager/row-off-board/${key}`,
  }];
}

/**
 * THE HOST WENT STALE ON A MERGE AND NOTHING IN THIS ORG FOUND OUT -- #2174.
 *
 * The shipped units are COPIES, not symlinks (`host-units.mjs` says so in its own header and explains
 * why), so every merge touching `packages/agent-org/host/` makes the agent host stale the instant it
 * lands and changes nothing on the host. The only instrument that can see it is `pnpm run host:check`,
 * and until this cause NOTHING CALLED IT -- one file in `packages/agent-org/src` and the whole of
 * `.github/workflows` mentioned the drift reader, and that file was the one defining it.
 *
 * THREE INSTANCES IN 24 HOURS, and the third had a consequence. #2003's comment-only diff to
 * `a11ign-work-tick.service` left the host stale overnight, found only because somebody ran `host:check`
 * by hand. #2144 (#1998) merged 2026-09-23T14:04:06Z changing the board unit's `ExecStart`; eight hours
 * later the service manager still loaded the pre-#1998 program, and it would have dispatched the 06:10Z
 * board edition from 31 lines of untracked bash whose entire deliverable was that it stop being that
 * (#2173). A merge that changes nothing on the host is, from inside this org, indistinguishable from a
 * merge that worked.
 *
 * THE GATE IS ALREADY STANDING IN THE RIGHT PLACE, which is the whole reason this is cheap.
 * `a11ign-work-tick.service` runs on the agent host every two minutes with `pnpm run primary:update` as
 * its `ExecStartPre`, so the tick reads a checkout at most one tick behind `main` FROM the one machine
 * that can also read `~/.config/systemd/user`. Both sides of the comparison are already under its hand.
 * It spends NO API pool -- a `readdir`, some `readFileSync` and one `systemctl` spawn per shipped timer,
 * never a `gh` call -- so it does not touch the two-call budget the gate's whole design rests on.
 * MEASURED on this host, `hostUnitDrift({})` five runs: 78.0, 77.5, 83.3, 85.1, 81.5 ms, mean 81.1 ms.
 * At 720 ticks a day that is 58 seconds of CPU a day, against the 2.07s the same unit's `primary:update`
 * already costs per tick when there is nothing to do -- about 4% of a step the tick already pays for.
 * Not material, so nothing is short-circuited; measured first, which is what constraint 5 asked.
 *
 * DETECT AND WAKE, NEVER AUTO-INSTALL -- ruled on the row so review does not re-litigate it, and the
 * shipped code holds it: this function returns ORDERS and calls nothing. The tick COULD run
 * `host:install` itself and must not, because `hostUnitsInstall`'s removal loop deletes every installed
 * `a11ign-*` unit the tree does not ship, and this org has twice been one command away from losing a live
 * one -- the board dispatch pair (#1993) and the `worktrees:prune` pair (#2002), both hand-installed,
 * both offered for deletion by the remedy, both caught by a PERSON reading the output. A unit the tree
 * has not shipped YET is a normal state, not an error, and no automatic actor can tell it from a
 * retirement.
 *
 * KEYED ON THE DRIFT SET, NOT A COUNT AND NOT A CLOCK -- `fleetBatchOrders`'s rule, for its reason. The
 * key names every drifting unit AND its problem, sorted, so a second unit joining is a new question that
 * reaches the owner, a unit whose problem CHANGES (`NOT INSTALLED` becoming `STALE`) is a new question
 * too, and a host stale in exactly the same way on the next tick mints the identical key and the ledger
 * drops it. A count would collide two different drift sets of the same size, which is #1799's finding.
 *
 * AN ACTION CAUSE, so it is deliberately OUT of `JUDGMENT_CAUSES` and keeps `wake.mjs`'s twenty-minute
 * expiry. It names a thing to DO -- read these findings, then run the remedy -- and if the wake does not
 * stick, nothing happens and nobody notices, which is the defect the expiry exists for (#1433, #1435 sat
 * Ready overnight behind a spent causeKey).
 *
 * `[]` AND `null` BOTH EMIT NOTHING, AND THEY ARE NOT THE SAME CLAIM. `hostUnitDrift` returns `[]` for a
 * clean host AND for a machine with no user systemd manager -- CI, a reviewer's laptop, a container --
 * and `null` here is a read that THREW. All three are silence, because none of them is a stale host; but
 * reading "not asked" as "all correct" is this repository's most-repeated defect, so `driftReport` keeps
 * the two apart in the CLI's output and the tests below assert the three separately rather than once.
 *
 * @param {{unit: string, problem: string, detail: string}[] | null | undefined} drift
 *        `host:check --json`'s findings.
 *        `null`/omitted is "not asked or refused" and emits nothing -- a caller that cannot read the
 *        host must never produce a false all-clear and must never invent a false alarm either.
 * @returns {{session: string, cause: string, subject: string, discriminator: string,
 *            prompt: string, causeKey: string}[]}
 */
export function hostDriftOrders(drift) {
  const findings = Array.isArray(drift) ? drift : [];
  if (findings.length === 0) return [];
  const key = findings.map((f) => `${f.unit}:${f.problem}`).sort().join(".");
  return [{
    session: HOST_DRIFT_SESSION,
    cause: "host-units-stale",
    subject: "host-units",
    discriminator: key,
    prompt: `The agent host has drifted from the tree: ${findings.length} finding(s).\n`
      + `${findings.map((f) => `  ${f.unit}: ${f.problem}\n    ${f.detail}`).join("\n")}\n`
      + "THIS IS A DETECTOR, NOT AN INSTALLER. The tick deliberately does not run the remedy: "
      + "`host:install` DELETES every installed `a11ign-*` unit the tree does not ship, and a unit the "
      + "tree has not shipped yet is a normal state no automatic actor can tell from a retirement. "
      + "Twice this org was one command away from deleting a live timer (#1993, #2002) and a person "
      + "reading the output is what stopped it both times.\n"
      + "SO READ BEFORE YOU RUN. Confirm no finding above is a live orphan -- a second reading that does "
      + "NOT go through the same reader, such as a diff of the installed `a11ign-*` set against "
      + "`packages/agent-org/host/` -- and say on the row what it said, whichever way it went. If that "
      + "reading disagrees with this one, STOP and report rather than running the remedy.\n"
      + "Then `pnpm run host:install`, and post whether any `REMOVED` line appeared: not one is expected, "
      + "and a `REMOVED` line is a finding rather than a step. `pnpm run host:check` answers it in the "
      + "same minute -- `hostUnitsInstall` runs `daemon-reload` itself, so nothing waits for the next "
      + "firing.\n"
      + "A STALE UNIT IS NOT A COSMETIC DIFF. The unit files are copies, so a merged edit reaches this "
      + "host only when somebody reinstalls -- and until then every property this repository can read "
      + "about that unit is a property of a file that is not the one running.",
    causeKey: `${HOST_DRIFT_SESSION}/host-units-stale/${key}`,
  }];
}

/**
 * WHO IS WOKEN, NAMED ON THE ROW RATHER THAN ASSUMED, because #2174 asked for exactly that.
 *
 * `orchestrator`, on #2002's own reasoning: host writes are its work, and `agent-practices.md` already
 * makes it the first reader for fleet and host questions. THE COUNTER-EVIDENCE, stated because it is
 * real: no entry in `docs/lane-ownership.json` covers host paths at all, and BOTH host writes this org
 * has actually made were `worker-capture`'s -- #2002 on 2026-09-23T07:15Z and #2173 at 15:54Z. So this
 * is a routing choice with a live exception, not a settled fact; it is one line to change if the
 * exception becomes the rule, and the wake ledger will show which session actually answers.
 */
const HOST_DRIFT_SESSION = "orchestrator";

/**
 * A PRIMARY THAT IS NOT AT `origin/main` IS A SIGNAL, NOT A JOURNAL LINE (#2781).
 *
 * `a11ign-work-tick.service` runs `primary:update` as `ExecStartPre=-`, so when it fails the tick goes on -- and from
 * 2026-09-28T12:01Z a dirty primary made it fail on every tick for 22 hours (2,652 journal lines) while the gate gave orders from
 * `a5f407d4f`. Nothing told any session. `ceo` owns the primary (`.github/CLAUDE.md`), so `ceo` is told, with the dirty paths
 * and how far behind, on the tick they appear.
 *
 * TWO CONDITIONS, NEITHER DERIVED FROM THE UPDATE'S FAILURE: tracked paths with uncommitted changes (a dirty primary is reported
 * before a newer `origin/main` makes it conflict), or HEAD is not `origin/main` (behind, or carrying commits origin lacks).
 *
 * AN ACTION CAUSE, so `wake.mjs`'s twenty-minute expiry RE-DELIVERS it until it clears -- a wake that does not stick leaves the
 * gate running stale with nobody told, which is the defect. KEYED ON THE TWO SHAS AND THE DIRTY SET, so a further merge or a
 * further edit is a new question and an unchanged stale primary is not a new one every tick.
 *
 * `null`/omitted emit NOTHING and are not a clean reading: a linked worktree, CI or a repository with no `origin/main` cannot be asked.
 *
 * INCIDENT BEHIND THE ORDER'S TEXT (moved out of it, #3444: the agent reading the order cannot use it):
 * the 2026-09-28 stale primary was an interactive session's uncommitted edits, which no hook refuses.
 *
 * @param {import("./update-primary.mjs").PrimaryDrift | null | undefined} drift
 * @returns {{session: string, cause: string, subject: string, discriminator: string,
 *            prompt: string, causeKey: string}[]}
 */
export function primaryStaleOrders(drift) {
  if (!drift || (drift.behind === 0 && drift.ahead === 0 && drift.dirty.length === 0)) return [];
  const dirty = [...drift.dirty].sort();
  const key = `${drift.sha.slice(0, 9)}.${drift.originSha.slice(0, 9)}.${createHash("sha256").update(dirty.join("\n")).digest("hex").slice(0, 8)}`;
  return [{
    session: "ceo",
    cause: "primary-stale",
    subject: "primary-checkout",
    discriminator: key,
    prompt: `The PRIMARY checkout is not at \`origin/main\`: it is at ${drift.sha.slice(0, 9)}, ${drift.behind} commit(s) behind `
      + `${drift.originSha.slice(0, 9)}${drift.ahead > 0 ? ` and carrying ${drift.ahead} commit(s) origin lacks` : ""}. Every order this gate gives `
      + "is given from THAT code, and every agent reads its role briefs and scripts out of it.\n"
      + (dirty.length > 0 ? `${dirty.length} tracked path(s) carry uncommitted changes, which is what makes \`pnpm run primary:update\` refuse `
        + `("would be overwritten by checkout"):\n${dirty.map((path) => `  ${path}`).join("\n")}\n` : "No tracked path is dirty, so the update itself "
        + "is failing for another reason: run `pnpm run primary:update` and read its output.\n")
      + "THE EDITS ARE NOT YOURS TO DISCARD UNREAD: an interactive session left them there, and no hook "
      + "refuses an uncommitted edit. Save `git diff` to `" + stateEntryPath("salvage") + "/primary-<date>.patch` first and say on #2781 "
      + "where it went, then clear the tracked paths and run `pnpm run primary:update`. This order repeats until the primary is at `origin/main`.",
    causeKey: `ceo/primary-stale/${key}`,
  }];
}

/**
 * EVERY ORDER SAYS THE GATE IS RUNNING STALE WHEN IT IS (#2781, done-when 2), with the sha and the count, at the head of its prompt.
 * The builder's choice between this and withholding: withholding would stall the whole org on a condition `ceo` can clear in one
 * command, but an order presented as current from stale code is what cost 22 hours, so the orders go out and SAY WHAT THEY ARE.
 * Applied to the tick's orders after `decide`, so no cause's own text or key changes; `primary-stale` already says it.
 *
 * @template {{cause: string, prompt: string}} T
 * @param {T[]} orders @param {import("./update-primary.mjs").PrimaryDrift | null | undefined} drift @returns {T[]}
 */
export function withStalePrimaryNotice(orders, drift) {
  if (!drift || drift.behind === 0) return orders;
  const notice = `[THIS GATE IS RUNNING FROM A STALE PRIMARY: ${drift.sha.slice(0, 9)}, ${drift.behind} commit(s) behind origin/main ${drift.originSha.slice(0, 9)}. `
    + "What this order asks may already be superseded on main; check before acting.]\n";
  return orders.map((order) => (order.cause === "primary-stale" ? order : { ...order, prompt: notice + order.prompt }));
}

/**
 * `update-primary.mjs --drift` -- SPAWNED, like `readHostDrift`, so the gate and `primary:update` read one question with one
 * reader and the gate's import closure does not grow. `null` for every unreadable case (a spawn that failed, a non-zero exit,
 * unparseable output, `asked: false`), which is silence and never a clean primary.
 * @returns {import("./update-primary.mjs").PrimaryDrift | null}
 */
function readPrimaryDriftNow() {
  const run = spawnSync(process.execPath, [fileURLToPath(new URL("./update-primary.mjs", import.meta.url)), "--drift"], { encoding: "utf8" });
  if (run.status !== 0 || typeof run.stdout !== "string") return null;
  try {
    const parsed = JSON.parse(run.stdout);
    return parsed?.asked === true && parsed.drift ? parsed.drift : null;
  } catch {
    return null;
  }
}

/**
 * #2202: `readClosedAnswerRows` with its refusal SAID. Every other reader here degrades to `[]` silently, and
 * that is the one shape this row exists to end for this question -- an answer owed that stopped waking a
 * session with nothing saying it had -- so a refused read is a line, not an empty list.
 * @returns {any[]}
 */
function closedAnswerRows() {
  const rows = readClosedAnswerRows();
  if (rows === null) {
    process.stderr.write("NOTE: could not read the closed rows that still owe an answer -- a question on a row "
      + "a merge already closed -- or a pull request no longer open -- is NOT being chased this tick (#2202, #2641).\n");
    return [];
  }
  return withoutEndedAnswerSessions(rows);
}

/**
 * #2609: A CLOSED ROW'S `answer:<session>` FOR A SESSION THAT HAS ENDED HAS NO ADDRESSEE (#2459's second producer).
 * The close path keeps the label on purpose (#2202), so a question closed unanswered still wakes the session that owes
 * the answer -- and that is right for a LIVE session and wrong for one torn down with its row: engineer instances are
 * one per row, and `worker-8` on #2116 was ordered `UNDELIVERED ... no workspace labelled` seven ticks running.
 *
 * WHAT ESTABLISHES `ended`, AND WHAT IT COSTS. The label is absent from `herdr workspace list` AND a teardown wrote it
 * down: `endedSessionLabels` reads the spare-cycle ledger and the reviewer-endings ledger, two local files and no API
 * call. Absent WITHOUT that record is not ended (`reviewer-<n>` is started after its order can exist, #2459 done-when 4),
 * and a herdr that does not answer classifies NOTHING: a blip read as every session gone would silence every question.
 * The herdr call is made only when a closed row carries an `answer:` label at all, so a quiet tracker pays nothing.
 *
 * Only the ENDED session's label is taken off the row COPY; another session's `answer:` on the same row still orders.
 * @param {any[]} rows
 * @param {{agents?: () => string[] | null, ended?: () => Map<string, number>, say?: (line: string) => void}} [io]
 * @returns {any[]}
 */
export function withoutEndedAnswerSessions(rows, { agents = liveWorkspaceLabels, ended = endedSessionLabels,
  say = (line) => process.stderr.write(line) } = {}) {
  const owed = rows.filter((r) => labelsOf(r).some((n) => n.startsWith(ANSWER_PREFIX)));
  if (owed.length === 0) return rows;
  const live = agents();
  if (live === null) {
    say(`NOTE: herdr did not answer, so no closed row's \`${ANSWER_PREFIX}\` label was classed as gone this tick -- every one `
      + "still orders (#2609).\n");
    return rows;
  }
  let gone;
  try {
    gone = ended();
  } catch (err) {
    say(`NOTE: the ended-session ledgers could not be read (${String(/** @type {any} */ (err)?.message ?? err).split("\n")[0]}) -- no closed row's \`${ANSWER_PREFIX}\` label was classed as gone this tick (#2609).\n`);
    return rows;
  }
  return rows.map((row) => dropGoneLabels(row, (session) => session !== "engineers" && !live.includes(session)
    && gone.has(session), say));
}

/**
 * `row` without its `answer:<session>` labels for sessions `isGone` names, saying each one -- as GONE, never as busy.
 * @param {any} row @param {(session: string) => boolean} isGone @param {(line: string) => void} say
 */
function dropGoneLabels(row, isGone, say) {
  const goneLabels = labelsOf(row).filter((n) => n.startsWith(ANSWER_PREFIX) && isGone(n.slice(ANSWER_PREFIX.length)));
  for (const label of goneLabels) {
    say(`SKIPPED answer-owed for ${label.slice(ANSWER_PREFIX.length)} on closed row #${row.number}: that session has ENDED `
      + "(it is absent from herdr and a teardown recorded its ending), so the order would have no addressee (#2609).\n");
  }
  return goneLabels.length === 0 ? row
    : { ...row, labels: (row.labels ?? []).filter((/** @type {any} */ l) => !goneLabels.includes(l?.name ?? l)) };
}

/**
 * Every workspace label herdr knows, or `null` when it would not say -- never `[]`, which would read as "nobody is
 * live" and class every session gone. @returns {string[] | null}
 */
export function liveWorkspaceLabels() {
  try {
    const workspaces = JSON.parse(herdrRun(["--session", "org", "workspace", "list"]))?.result?.workspaces;
    return Array.isArray(workspaces) ? workspaces.map((/** @type {any} */ w) => String(w.label ?? "")) : null;
  } catch {
    return null;
  }
}

/** @param {string} path @param {typeof readFileSync} read @returns {string} `""` for a file that is not there; THROWS otherwise */
function evidenceText(path, read) {
  try {
    return String(read(path, "utf8"));
  } catch (err) {
    if (/** @type {any} */ (err)?.code === "ENOENT") return "";
    throw err;
  }
}

/** @param {string} path @param {typeof readFileSync} read @returns {any[]} an unparseable line is skipped: it cannot establish an ending */
function evidenceLines(path, read) {
  return evidenceText(path, read).split("\n").filter((l) => l.trim() !== "").flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

/**
 * WHICH LABELS A TEARDOWN RECORDED AS ENDED, and when (ms) -- the same reading as `wake.mjs`'s `endedSessions`, which this
 * file cannot import (it imports this one). Two ledgers name an ending (`spare-cycles`, one line per engineer instance
 * closed; `reviewer-endings`) and two registries name what STARTED and has not ended: an entry stamped at or after the
 * ending is a later instance under the same name, and the label is not ended. THROWS on a file that exists and cannot be
 * read, so the caller drops nothing on a reading it could not make.
 * @param {{dir?: string, read?: typeof readFileSync}} [io] @returns {Map<string, number>}
 */
export function endedSessionLabels({ dir = REVIEWER_STATE_DIR, read = readFileSync } = {}) {
  /** @type {Map<string, number>} */
  const ended = new Map();
  /** @param {unknown} label @param {number} at */
  const note = (label, at) => {
    if (typeof label !== "string" || label === "?" || !Number.isFinite(at)) return;
    if (at > (ended.get(label) ?? -Infinity)) ended.set(label, at);
  };
  for (const cycle of evidenceLines(`${dir}/spare-cycles`, read)) note(cycle.role, Number(cycle.at));
  for (const ending of evidenceLines(`${dir}/reviewer-endings`, read)) note(ending.session, Date.parse(ending.at));
  for (const file of ["spare-instances.json", REVIEWER_REGISTRY_FILE]) {
    const text = evidenceText(`${dir}/${file}`, read);
    const registry = text === "" ? {} : JSON.parse(text);
    for (const [label, started] of Object.entries(registry ?? {})) {
      if (Number(started?.spawnedAt) >= (ended.get(label) ?? Infinity)) ended.delete(label);
    }
  }
  return ended;
}

/** The rows that owe someone an answer. @param {any[]} rows */
export function withAnswerLabel(rows) {
  return (rows ?? []).filter((r) => labelsOf(r).some((/** @type {string} */ n) => n.startsWith(ANSWER_PREFIX)));
}

/**
 * EVERY place an `answer:<session>` label can sit, as the one list `decide` takes (#2492). Three reads, one
 * input: the open rows, the open pull requests the gate already holds (`gh issue list` never returns a PR,
 * which is why a label on #2376 woke nobody), and the closed rows still owing (#2202). Kept as one named
 * function so a fourth place is one line here, and a test can call it rather than read `main`'s text. `closedRows`
 * is every subject that is no longer open: closed ISSUES (#2202) and merged or closed pull requests (#2641).
 *
 * @param {{ openRows: any[], openPrs: any[], closedRows: any[] }} reads
 */
export function rowsOwingAnswers({ openRows, openPrs, closedRows }) {
  return [...withAnswerLabel(openRows), ...withAnswerLabel(openPrs), ...closedRows];
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
  return (rows ?? []).filter((r) => labelsOf(r).includes(BLOCKED_LABEL)
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
 * INCIDENT BEHIND THE ORDER'S TEXT (moved out of it, #3444: the agent reading the order cannot use it):
 * until 2026-09-21 this prompt said a comment alone was fine. #1520 -- a measurement waiting for a run count to reach 20, which is neither
 * a row, a date nor a person -- was then correctly re-answered FOUR TIMES IN NINE HOURS (23:43, 01:44, 05:45, 08:21), each a full turn
 * reaching the identical conclusion, because nothing could record that the question had been answered.
 * On 2026-09-20 eleven rows carried the `blocked` label with the queue empty behind them, one (#1731) about code fixed the day before.
 *
 * @param {any[]} rows @param {any[]} readyRows @param {string} [today]
 */
export function blockedReferentOrders(rows, readyRows, today = todayIso()) {
  if (readyRows.length > 0) return [];
  return blockedWithoutReferent(rows, today).slice(0, MAX_ROW_ORDERS_PER_TICK)
    .map((/** @type {any} */ r) => ({
      session: "product-manager",
      cause: "blocked-unexaminable",
      subject: `row-${subjectRef(r.repoKey, r.number)}`,
      discriminator: subjectRef(r.repoKey, r.number),
      prompt: `${subjectMention(r)}${r.title ? ` (${r.title})` : ""} is labelled \`${BLOCKED_LABEL}\` and names NOTHING a `
        + "machine can check -- no `blockedBy` edge, no `Not-before:` line. NOTHING IN THIS ORG CAN SEE "
        + `IT: \`${BLOCKED_LABEL}\` is filtered out before any cause runs, so only a person re-reading the row can `
        + "ever lift it.\n"
        + "Read it and do ONE of four things: record the real blocker as data "
        + "(`gh issue edit " + `${r.number}` + " --add-blocked-by <n>`, or a `Not-before: YYYY-MM-DD` "
        + `line in the body); or REMOVE the \`${BLOCKED_LABEL}\` label if the condition has already become true; `
        + `or, IF IT WAITS ON A PERSON, label it \`${CHAIRMAN_LABEL}\` -- that names a referent, `
        + "`chairman-blocked` already routes it, and taking the label off is the act of clearing it; "
        + "or, if the wait is real and none of those three can express it, say on the row IN ONE LINE "
        + "what would clear it and who would notice, AND ADD A `Not-before:` FOR WHEN IT SHOULD NEXT BE "
        + "RE-CHECKED -- a week out is usually right.\n"
        + "THE `Not-before:` IS NOT OPTIONAL ON THAT LAST OPTION: nothing can record that the question "
        + "was answered, so an explanation with no horizon is not a terminal state; it is a loop the org "
        + "has been instructed to run.\n"
        + "A HORIZON IS ALSO THE HONEST ANSWER TO ROT. An unexaminable wait is exactly the kind that "
        + "quietly becomes true -- so it should go quiet for a while and then be asked ONCE more, not go "
        + "quiet forever and not be asked every two hours. Pick the date by when you would want to know "
        + "if nothing had changed.\n"
        + "Before reaching for that option at all, ask whether the wait is really on a person -- most "
        + `are, and \`${CHAIRMAN_LABEL}\` is then the honest answer.\n`
        + "THE CONDITION HAS OFTEN ALREADY CLEARED: check that first.",
      causeKey: `product-manager/blocked-unexaminable/row-${subjectRef(r.repoKey, r.number)}`,
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
 * Whether `row` is a pull request as `readPrs` returns one. `gh issue list` never returns `isDraft` or
 * `headRefOid` and `gh pr list --json` always does, so the shape says which list it came from without a
 * tag every caller would have to remember to set. A PR from `readPrs` carries no `state` either -- it reads
 * as open, which is what `--state open` made it.
 *
 * @param {any} row
 */
function isPullRequest(row) {
  return typeof row?.isDraft === "boolean" || typeof row?.headRefOid === "string";
}

/**
 * The sentence that says the subject is no longer open, or "" when it is. A MERGED pull request is its own case (#2641):
 * `state` is `MERGED`, not `CLOSED`, and "a merge closed it" would be the wrong verb for one that was never closed.
 * @param {any} row @param {string} subject `"row"` or `"pull request"`
 */
function closedNote(row, subject) {
  if (row.state === "MERGED") {
    return `THE ${subject.toUpperCase()} IS MERGED: it merged while your answer was still owed, and merging did not answer `
      + "it (#2641). A merged pull request still takes a comment, so answer there.\n";
  }
  if (row.state !== "CLOSED") return "";
  return `THE ${subject.toUpperCase()} IS CLOSED: ${subject === "row" ? "a merge closed it" : "it was closed"} while your answer `
    + `was still owed, and closing did not answer it (#2202). A closed ${subject} takes a comment, so answer there.\n`;
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
 * A PULL REQUEST IS ONE OF THE `rows` (#2492). `gh issue list` does not return pull requests, so a label
 * set on a PR was read by nothing (#2376 carried `answer:worker-tooling` and `answer:ceo` and the wake
 * ledger held no `answer-owed` entry for it). `main` now hands this `readPrs`'s open PRs beside the rows.
 * GitHub numbers issues and pull requests in ONE namespace, so `row-<n>` still names exactly one thing and
 * the key needs no second spelling; only the WORDS change, so the reader looks where the question is.
 *
 * INCIDENT BEHIND THE ORDER'S TEXT (moved out of it, #3444: the agent reading the order cannot use it):
 * on 2026-09-20 a question sat unread for 6.5 hours while the session that asked it re-posted five times.
 *
 * @param {any[]} rows
 */
export function answerOrders(rows) {
  const orders = [];
  for (const [session, owed] of answersOwed(rows)) {
    for (const row of owed.slice(0, MAX_ROW_ORDERS_PER_TICK)) {
      const subject = isPullRequest(row) ? "pull request" : "row";
      orders.push({
        session,
        cause: "answer-owed",
        subject: `row-${subjectRef(row.repoKey, row.number)}`,
        discriminator: subjectRef(row.repoKey, row.number),
        prompt: `${subjectMention(row)} ${isPullRequest(row) ? "IS A PULL REQUEST " : "IS "}WAITING ON AN ANSWER FROM YOU. `
          + `Another session asked you something there and cannot move until you reply -- read that ${subject}'s `
          + "most recent comments for the question.\n"
          + closedNote(row, subject)
          + `ANSWER ON THE ${subject.toUpperCase()}, then remove its \`${ANSWER_PREFIX}${session}\` label: taking the label `
          + "off IS the act of answering, and it is the only thing that stops this being asked again.\n"
          + "\"I cannot answer this\" is an answer -- say so, say who can, and re-label it to them. "
          + "What is not an answer is silence: nothing in this org reads comments, so the asker cannot move.",
        causeKey: `${session}/answer-owed/row-${subjectRef(row.repoKey, row.number)}`,
      });
    }
  }
  return orders;
}

/**
 * This row/PR's own `labeled` and `commented` timeline events, projected to the fields `bareAnswerLabel`
 * reads -- never the whole payload, which on a long-lived row carries every review, commit and
 * cross-reference too.
 *
 * `null` ON A REFUSED READ, NEVER `[]`: an empty timeline would read every outstanding `answer:` label on
 * it as bare, which is the false-positive direction a refused read must not produce (`readCommitShas`'s
 * own rule, applied here).
 *
 * @param {number} number @param {(args: string[]) => string} run
 * @returns {{event: string, label?: {name: string}, created_at: string}[] | null}
 */
export function readRowTimeline(number, run = defaultRun) {
  try {
    const out = run(["api", `repos/${repoNow()}/issues/${number}/timeline`, "--paginate", "--jq",
      '.[] | select(.event == "labeled" or .event == "commented") | '
      + '{event: .event, label: {name: .label.name}, created_at: .created_at}']);
    return out.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
  } catch {
    return null;
  }
}

/**
 * One order: wake `holder` because `owed`'s `answer:` label has nothing said on `row` since `labelledAt`.
 * @param {any} row @param {string} holder @param {string} owed @param {string} labelledAt
 */
function bareAnswerLabelOrder(row, holder, owed, labelledAt) {
  const subject = isPullRequest(row) ? "pull request" : "row";
  return {
    session: holder,
    cause: "answer-label-unexplained",
    subject: `row-${subjectRef(row.repoKey, row.number)}`,
    discriminator: `${owed}/${labelledAt}`,
    prompt: `${subjectMention(row)} carries \`${ANSWER_PREFIX}${owed}\`, applied at ${labelledAt}, with `
      + `NOTHING posted on this ${subject} since -- so ${owed} cannot tell a real question from a label `
      + "applied out of habit or by mistake (#2711).\n"
      + `POST THE QUESTION ${owed} is meant to answer, or remove the label if it no longer applies -- `
      + "leaving it as it is asks the addressee to clear a label that means nothing.",
    causeKey: `${holder}/answer-label-unexplained/row-${subjectRef(row.repoKey, row.number)}/${owed}/${labelledAt}`,
  };
}

/**
 * Every unexplained `answer:` label on ONE row/PR, turned into orders. PAID ONLY BY A ROW THAT ALREADY
 * CARRIES THE LABEL AT ALL: the timeline read happens after both cheap checks below have already refused.
 * @param {any} row @param {(args: string[]) => string} run
 */
function bareAnswerLabelOrdersForRow(row, run) {
  const holder = sessionOf(row);
  const owedSessions = answersOwedBy(row);
  if (!holder || owedSessions.length === 0) return [];
  const timeline = readRowTimeline(Number(row.number), run);
  const orders = [];
  for (const owed of owedSessions) {
    const bare = bareAnswerLabel(timeline, owed);
    if (bare) orders.push(bareAnswerLabelOrder(row, holder, owed, bare.labelledAt));
  }
  return orders;
}

/**
 * `answerOrders`'s natural neighbour (#2711): that one wakes the NAMED session to answer; this wakes the
 * LABELLING session, because the addressee has no way to tell a real question from a label applied out of
 * habit or by mistake, and the label alone cannot say which. Live evidence: `worker-2632` added
 * `answer:ceo` to its own PR #2649 twice with no comment either time, and `ceo` cleared it twice with
 * nothing to answer.
 *
 * THE ROW'S OWN `session:` LABEL IS THE LABELLING SESSION, not the timeline's `actor.login`. Every org
 * session shares one of a handful of GitHub accounts (`.claude/rules/gh-api-budget.md`), so the timeline
 * can say which ACCOUNT wrote the label and never which SESSION -- but every observed case is the row's
 * own holder setting `answer:` on the row they are stopped on, which `sessionOf` already names. A row with
 * no holder has no session this cause can wake, so it is skipped rather than guessed at.
 *
 * @param {any[]} rowsOwingAnswers `withAnswerLabel`'s output -- open rows and open pull requests together
 * @param {(args: string[]) => string} [run]
 */
export function bareAnswerLabelOrders(rowsOwingAnswers, run = defaultRun) {
  const orders = [];
  for (const row of rowsOwingAnswers ?? []) {
    orders.push(...bareAnswerLabelOrdersForRow(row, run));
    if (orders.length >= MAX_ROW_ORDERS_PER_TICK) return orders.slice(0, MAX_ROW_ORDERS_PER_TICK);
  }
  return orders;
}

/** @param {ReturnType<typeof bareAnswerLabelOrders> | undefined} orders */
const bareAnswerOrdersOrNone = (orders) => orders ?? [];

/**
 * #2161: the rows an open pull request DECLARES it closes -- the holders who have demonstrably acted.
 * `declaredClosedRows` is the parser B4 and B7 already share, so "this PR is the row's own work" means
 * one thing in all three places, and `Closes: none` and a malformed body both read as `[]` and so screen
 * nothing. It reads `prs` and not `comparablePrFiles`: that filter drops a PR whose file list is
 * truncated, which is right for an overlap comparison and would here silently withdraw the screen for
 * the largest pull requests -- the ones most likely to be a row's whole build.
 * #2493: a pull request carrying a `hold:` label does not count -- see the body.
 * @param {any[] | null | undefined} openPrs
 * @returns {Set<number>}
 */
function rowsWithOpenPr(openPrs) {
  // #2493: A HELD PR IS NOT AN ACT, IT IS A DECLARED WAIT. `hold:` is the owner saying "do not merge me yet", and the
  // wait behind it is a `blockedBy` edge (#2400 section 2) -- so the holder of a held PR is exactly who must hear
  // that the last edge closed. Counting it as "resumed" silenced the one wake the ruling relies on: #2376's owner
  // had an open PR naming #2359 and would never have been told #2399 merged.
  return new Set((openPrs ?? []).filter((pr) => holdersOf(labelsOf(pr)).length === 0)
    .flatMap((pr) => declaredClosedRows(pr?.body)));
}

/**
 * Whether a CLAIMED row is waiting on something, for the two readers that screen one (`blockerClearedOrders` and
 * `anyBlockerClearingCandidate`), so the population that pays for a `closings` read cannot drift from the one that
 * uses it. `fleetWaitingOn` is the declared-field waits (#2186); the two labels are the rest.
 *
 * `needs:chairman` AND `parked` ARE WAITS `waitingOn` DELIBERATELY DOES NOT READ, AND THIS IS THE FOURTH READER OF
 * THAT GAP (#2780, after #2583/#2604/#2653 closed the three that reach an UNCLAIMED row). The order says "PICK IT
 * BACK UP" to a holder whose row names a person or the schedule as the one thing it waits on: #2623
 * (`needs:chairman` from 2026-09-28T16:06:31Z) was asked 19+ times in a day, and the prompt's own remedies never
 * mention the label. Skipped here rather than taught to `waitingOn`, which every reader would then inherit.
 *
 * @param {any} row @param {string} today @param {number} nowMs
 */
export function holderWaitingOn(row, today, nowMs) {
  const labels = labelsOf(row);
  return Boolean(fleetWaitingOn(row, today, nowMs)) || labels.includes(CHAIRMAN_LABEL) || labels.includes(PARKED_LABEL);
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
 * AND NOT A ROW THE FLEET HOLDS (#2186). This asks `fleetWaitingOn`, not `waitingOn`, because the split
 * between them was drawn for the OFFER path -- whether a row is reachable by the engineer pool -- and this
 * cause is not that: it addresses the session that already holds the row and says "PICK IT BACK UP". For
 * that caller a live `Fleet-hold-until:` is as disqualifying as an open `blockedBy` edge. Measured
 * 2026-09-23: #2114's holder was woken at 15:37Z for a row the fleet held until 22:00Z, while the same
 * tick's shelf line said so. The hold clears itself, so the order goes out the tick after it passes.
 *
 * AND NOT A HOLDER WHO HAS ALREADY RESUMED (#2161). An open pull request whose `Closes:` names the row is
 * the holder's own answer to this cause: they picked the row back up, built it and opened the PR, and
 * "PICK IT BACK UP" is then a question with a known answer. Measured 2026-09-23 on three rows: 6m56s past a
 * green draft (#2031), 1m47s (#2145), and 2m24s after APPROVED and in the merge queue (#2170) -- and
 * because this is an ACTION cause `wake`'s twenty-minute expiry re-offers it for as long as the key still
 * matches, so the bound is `MAX_DELIVERIES` and reaching it labels a built, green row `needs:chairman`.
 * THE PR IS THE DISCRIMINATOR, on `worker-judge`'s argument on the row: an open PR means ACTED ON. `prs` is the read
 * `draftOrder` already made, so the narrowing spends no call and does not touch `GH_READS`. #3451 OVERTURNED THE SECOND HALF of that
 * argument, "a claim timestamp is not one": a claim is REFUSED while a `blockedBy` edge is open, so a holder that claimed after
 * the last blocker closed was told by the claim itself, and "abandoned after claiming" is `claim-stalled`'s to find, not this
 * cause's (#3390: claimed 101 s after the clearing, woken 91 minutes later, 1 min 46 s after its PR opened). `claimFacts` carries
 * what the claim-stall tick already read, and a drop is returned with its reason beside the orders -- see `staleClearing`.
 *
 * #2741: A CLEARING THAT DOES NOT RECUR BACKS OFF THE SAME WAY `unclaimedBlockerClearedOrders` DOES.
 * `closings` says when each blocker closed, and the causeKey then carries `promotionAskWindow`'s suffix
 * exactly as that function's does -- one ask at once, again at 6h and 24h, then every 72h for ever. A
 * `Not-before:`/`answer:`/`blockedBy` cycle that changes nothing about the row does not reopen the first
 * window: #1756 escalated twice in one day because the pre-#2741 key never changed and this is an ACTION
 * cause, so answering `answer:ceo` correctly reset the counter and the twenty-minute expiry rebuilt the
 * same six deliveries from zero. WITHOUT `closings` (`null`, or an old caller) every ask is the unstaged
 * first one, which is the behaviour before this backoff existed and what a refused read must fall back to.
 *
 * INCIDENT BEHIND THE ORDER'S TEXT (moved out of it, #3444: the agent reading the order cannot use it):
 * no other cause addresses a session that already holds a row. On 2026-09-22 #1908's last blocker closed at 21:26:02Z, the next tick said
 * nothing to `worker-capture`, and six rows sat behind it until a label meant for something else was applied by hand.
 *
 * @param {any[]} rows every open row
 * @param {string} [today]
 * @param {number} [nowMs] the clock a timestamped hold is read against, injected so a test moves time
 * @param {{openPrs?: any[], closings?: Map<number, number> | null, claimFacts?: import("./work-gate/claim-stall-tick.mjs").ClaimFactsOfTick | null}} [reads]
 *   the reads this cause takes BEYOND `rows` itself, bundled so a 5th positional parameter does not join `nowMs` (`max-params`).
 *   `openPrs` is `readPrs`'s open pull requests. OMITTED MEANS "NOT ASKED", and the cause then behaves
 *   exactly as before #2161: it fails toward telling the holder, never toward silence.
 *   `closings` is `readRecentlyClosed`'s map, or `null` for "not asked or refused" -- see this function's
 *   own header for what that falls back to.
 *   `claimFacts` (#3451) is the claim-stall tick's reading of every claimed row (`onFacts`). OMITTED MEANS NOT ASKED (no drop, no line); `null` is a tick that
 *   read no claim, which keeps every order and says so.
 * @returns {{ orders: {session: string, cause: string, subject: string, discriminator: string, prompt: string, causeKey: string}[],
 *   drops: BlockerClearedDrop[], log: string[] }} `drops` are the orders NOT emitted and why; `log` is every line the tick prints about them
 */
export function blockerClearedReading(rows, today = todayIso(), nowMs = Date.now(), { openPrs = [], closings = null, claimFacts } = {}) {
  /** @type {ReturnType<typeof blockerClearedReading>} */
  const reading = { orders: [], drops: [], log: [] };
  const resumed = rowsWithOpenPr(openPrs);
  for (const row of rows ?? []) {
    const session = sessionOf(row);
    const cleared = declaredBlockers(row);
    if (!session || !labelsOf(row).includes(CLAIM_LABEL) || cleared === null) continue;
    if (resumed.has(Number(row.number))) continue;
    // THE LINE THAT MAKES `cleared` MEAN CLEARED. `waitingOn` reports an OPEN `blockedBy` node before
    // anything else, so passing here is what proves every number above is closed -- and it covers the
    // other conditions in the same breath, which is why `declaredBlockers` does not re-ask.
    if (holderWaitingOn(row, today, nowMs)) continue;
    const window = clearingAskWindow(cleared, nowMs, closings);
    if (!window) continue;
    const key = cleared.join(".");
    const causeKey = `${session}/blocker-cleared/row-${subjectRef(row.repoKey, row.number)}/${key}${window.suffix}`;
    const verdict = staleClearing({ row, cleared, causeKey, closings, claimFacts, nowMs });
    reading.log.push(...verdict.log);
    if (verdict.drop !== null) {
      reading.drops.push(verdict.drop);
      continue;
    }
    reading.orders.push({
      session,
      cause: "blocker-cleared",
      subject: `row-${subjectRef(row.repoKey, row.number)}`,
      discriminator: key,
      prompt: `${subjectMention(row)} IS YOURS AND IS NO LONGER BLOCKED. Every row it declared a dependency on `
        + `is now closed: ${cleared.map((n) => `#${n}`).join(", ")}.\n`
        + "PICK IT BACK UP; you already hold the claim, so nothing else will offer it.\n"
        + "IF IT IS STILL NOT RUNNABLE, say so in a FIELD, not a comment: "
        + `\`gh issue edit ${row.number} --add-blocked-by <n>\`, a \`Not-before: YYYY-MM-DD\` line, or `
        + `\`${ANSWER_PREFIX}<session>\` if you wait on a decision. Each clears itself.`,
      causeKey,
    });
    if (reading.orders.length >= MAX_ROW_ORDERS_PER_TICK) break;
  }
  return reading;
}

/**
 * `blockerClearedReading`'s orders alone, for every caller that has no use for what was dropped (`decide`: the drops are said by `main`, once).
 * @param {Parameters<typeof blockerClearedReading>} args
 */
export function blockerClearedOrders(...args) {
  return blockerClearedReading(...args).orders;
}

/**
 * THE THREE REASONS A `blocker-cleared` ORDER IS DROPPED (#3451), a CLOSED set: a fourth is a new decision, not a spelling, and `work-gate-stale-blocker-cleared.test.ts` fails on one.
 * @typedef {"claimed-after-clearing" | "own-pull-request" | "moved-since-clearing"} BlockerClearedDropReason
 * @typedef {{ causeKey: string, reason: BlockerClearedDropReason, at: number }} BlockerClearedDrop `at` is the time that decided it: the claim's, the pull request's
 *   open or merge, or the holder's newest move
 */
export const BLOCKER_CLEARED_DROP_REASONS = Object.freeze(["claimed-after-clearing", "own-pull-request", "moved-since-clearing"]);

/** @param {number} ms @returns {string} */
const isoOf = (ms) => new Date(ms).toISOString();

/**
 * WHY NO `blocker-cleared` ORDER IS NEEDED, or `null` when the holder still has to be told -- from facts the same tick already read (#3451).
 * #3390 was told "PICK IT BACK UP" 91 minutes after its blocker closed, 1 min 46 s after it had opened its pull request, having CLAIMED 101 s after the clearing.
 * In the order asked: (1) the claim post-dates the clearing, which the claim itself refused to be made before; (2) a pull request of the claim's own
 * (`ownsPr`, in ANY tracked repository) is open and not held (#2493: a held PR is a declared wait, whose owner must hear the last edge close) or merged since the
 * claim; (3) the holder commented, committed or pushed AFTER the clearing. A holder who claimed before and has done none of that (#1908) is not here.
 * @param {import("./work-gate/claim-stall-tick.mjs").ClaimMoves} moves @param {number} clearedAtMs @param {number} nowMs
 * @returns {{ reason: BlockerClearedDropReason, at: number } | null}
 */
function whyNotNeeded(moves, clearedAtMs, nowMs) {
  if (moves.claimedAt >= clearedAtMs) return { reason: "claimed-after-clearing", at: moves.claimedAt };
  const opened = moves.openPrs.filter((pr) => holdersOf(labelsOf(pr)).length === 0).map((pr) => Date.parse(String(pr.createdAt)));
  const acts = [...opened.map((at) => (Number.isFinite(at) ? at : nowMs)), ...(moves.mergedAt === null ? [] : [moves.mergedAt])];
  if (acts.length > 0) return { reason: "own-pull-request", at: Math.min(...acts) };
  const moved = Math.max(...[moves.comment, moves.commit, moves.push].filter((t) => t !== null));
  return moved > clearedAtMs ? { reason: "moved-since-clearing", at: moved } : null;
}

/**
 * The read that was REFUSED, as a phrase, or `null` when every read the drop needs was made. FAILING TOWARD TELLING THE HOLDER: a refusal drops nothing, because
 * an order that should not have gone costs a wake and a drop that should not have happened strands a row (this function's own header).
 * @param {{ row: any, cleared: number[], closings: Map<number, number> | null, claimFacts: import("./work-gate/claim-stall-tick.mjs").ClaimFactsOfTick | null }} reads
 * @returns {string | null}
 */
function refusedRead({ row, cleared, closings, claimFacts }) {
  if (claimFacts === null) return "the claim-stall tick read no claim";
  if (closings === null) return "the closing times were not read";
  const unclosed = cleared.find((n) => !closings.has(n));
  if (unclosed !== undefined) return `the closing time of #${unclosed} was not read`;
  if (claimFacts.moves.has(Number(row.number))) return null;
  return `the claim read was refused (${claimFacts.skipped.get(Number(row.number)) ?? "the claim-stall tick did not evaluate this row"})`;
}

/**
 * `blockerClearedReading`'s drop for ONE row about to be ordered, with the lines to print. `claimFacts` undefined is a caller that did not ask: no drop, no line.
 * @param {{ row: any, cleared: number[], causeKey: string, closings: Map<number, number> | null, nowMs: number,
 *   claimFacts?: import("./work-gate/claim-stall-tick.mjs").ClaimFactsOfTick | null }} args
 * @returns {{ drop: BlockerClearedDrop | null, log: string[] }}
 */
function staleClearing({ row, cleared, causeKey, closings, claimFacts, nowMs }) {
  if (claimFacts === undefined) return { drop: null, log: [] };
  const refused = refusedRead({ row, cleared, closings, claimFacts });
  if (refused !== null || closings === null || claimFacts === null) {
    return { drop: null, log: [`blocker-cleared ${subjectMention(row)}: order KEPT -- ${refused}, so nothing was checked against it\n`] };
  }
  const moves = /** @type {import("./work-gate/claim-stall-tick.mjs").ClaimMoves} */ (claimFacts.moves.get(Number(row.number)));
  const clearedAtMs = Math.max(...cleared.map((n) => /** @type {number} */ (closings.get(n))));
  const why = whyNotNeeded(moves, clearedAtMs, nowMs);
  if (why === null) return { drop: null, log: [] };
  return { drop: { causeKey, ...why },
    log: [`SHELVED row ${subjectMention(row)}: blocker-cleared order dropped, ${why.reason} (claimed ${isoOf(moves.claimedAt)}, blockers closed ${isoOf(clearedAtMs)}, decided ${isoOf(why.at)})\n`] };
}

export const HOUR_MS = 60 * 60 * 1000;

/**
 * WHEN AN UNANSWERED `unclaimed-blocker-cleared` ORDER MAY BE ASKED AGAIN -- #2286.
 *
 * MEASURED 2026-09-24 (a reading at a moment, from the host's wake ledger): 28 of `product-manager`'s 46
 * recent deliveries were this cause and 23 of them were four rows re-asked at an UNCHANGED key on the
 * two-hour `JUDGMENT_TTL_MS`, six times each over ten hours, with nothing changed between. #2280
 * re-measured the whole ledger and found the same thing at scale: 447 of 454 redundant deliveries were
 * this TTL re-ask working as designed, 7 were inside the window. So the defect is not a leak in the
 * dedupe; it is that the TTL is a FIXED interval, and a fixed interval is the right answer for a question
 * that may have been missed and the wrong one for a question that has been missed FIVE TIMES.
 *
 * A BACKOFF, DERIVED FROM WHEN THE ROW WAS CLEARED, so the gate stays stateless (see `decide`): the
 * order is emitted only during a WINDOW that opens at each offset after the last blocker closed.
 *
 *   0    the clearing itself, at once. #2139 exists because six rows sat runnable up to 16h09m; nothing
 *        here may delay the FIRST ask, and the key of this window is byte-identical to the pre-#2286 key.
 *   6h   a second ask, because an order that lands while `product-manager` is mid-turn is genuinely
 *        missed sometimes, and six hours is one working stretch. #2149 and #2092 were being worked ten
 *        hours after their first delivery, so the second ask is the one that earns its turn.
 *   24h  a third, a day on: the row is now the oldest thing in the queue and the ask is cheap next to
 *        the cost of a forgotten row.
 *   72h, AND EVERY 72h FOR EVER AFTER. THE TAIL NEVER ENDS, which is `ceo`'s first constraint: a row
 *        nobody answered must not go silent, or the treadmill is replaced by the forgotten row this
 *        cause was written to stop. Three days is a long weekend, so a row is never unasked longer.
 *
 * `ceo` DID NOT PICK THIS SCHEDULE AND NOTHING EVIDENCES IT; the four rows' cost under it is in #2286's
 * pull request, and a different ladder is a change to these two constants and nothing else.
 *
 * EACH WINDOW IS EXACTLY `JUDGMENT_TTL_MS` LONG, AND THAT COUPLING IS THE MECHANISM. `wake` dedupes a
 * judgment cause for two hours after a delivery, and a delivery can only happen inside the window, so a
 * key delivered at time `t >= start` is held until `t + 2h >= start + 2h`, the window's end: ONE delivery
 * per window with no state kept anywhere. A window shorter than the TTL would ask once per window too;
 * a longer one would let the TTL re-ask inside it, which is the treadmill. `work-gate.test.ts` pins the
 * two numbers equal, because `wake.mjs` imports this file and cannot be imported back.
 *
 * A window whose order was never delivered (the session was busy, the tick was refused) is RETRIED every
 * tick until the window closes, then not until the next one -- the cost of stopping the treadmill, stated.
 */
export const PROMOTION_ASK_OFFSETS_MS = Object.freeze([0, 6 * HOUR_MS, 24 * HOUR_MS]);

/** The interval of the tail: an ask at every multiple of this after the ladder, for ever. */
export const PROMOTION_ASK_PERIOD_MS = 72 * HOUR_MS;

/** How long each ask stays open -- `wake.mjs`'s `JUDGMENT_TTL_MS`, pinned equal by the test. */
export const PROMOTION_ASK_WINDOW_MS = 2 * HOUR_MS;

/**
 * PURE. The ask a row is in, `age` after its last blocker closed -- or `null` between asks.
 *
 * @param {number} age milliseconds since the clearing; a future stamp (clock skew) reads as zero
 * @returns {{suffix: string} | null} `suffix` is `""` for the first ask, else `@<hours>h`, and it is
 *          part of the causeKey so each window is a NEW question to `wake`'s ledger
 */
export function promotionAskWindow(age) {
  const at = Math.max(0, age);
  const tail = Math.floor(at / PROMOTION_ASK_PERIOD_MS) * PROMOTION_ASK_PERIOD_MS;
  const start = Math.max(tail, ...PROMOTION_ASK_OFFSETS_MS.filter((o) => o <= at));
  if (at - start >= PROMOTION_ASK_WINDOW_MS) return null;
  return { suffix: start === 0 ? "" : `@${start / HOUR_MS}h` };
}

/**
 * When the last of `cleared` closed, in epoch ms. A blocker missing from `closings` closed before the
 * window that read covers, so it counts as the epoch: the row lands on the wall-clock 72-hour grid
 * (`promotionAskWindow`'s tail) rather than being anchored to a moment nobody can name.
 *
 * @param {number[]} cleared @param {Map<number, number>} closings
 */
function clearedAt(cleared, closings) {
  return Math.max(...cleared.map((n) => closings.get(n) ?? 0));
}

/**
 * The backoff window a clearing is in, shared by `blockerClearedOrders` and `unclaimedBlockerClearedOrders`
 * (#2741) so the "no `closings`, no backoff" fallback is written once rather than as two ternaries that
 * could drift. `null` `closings` (not asked or refused) is the unstaged first ask, forever.
 * @param {number[]} cleared @param {number} nowMs @param {Map<number, number> | null} closings
 * @returns {{suffix: string} | null}
 */
function clearingAskWindow(cleared, nowMs, closings) {
  return closings ? promotionAskWindow(nowMs - clearedAt(cleared, closings)) : { suffix: "" };
}

/** How many of the most recently closed rows `readRecentlyClosed` asks for: about two days of merges. */
const RECENTLY_CLOSED_LIMIT = 100;

/**
 * When each of the most recently closed rows closed, or `null` when the read is refused.
 *
 * ONE CALL FOR EVERY BLOCKER, NOT ONE PER ROW: `gh`'s `blockedBy` nodes carry `number` and `state` and no
 * closing time, and a per-blocker `issue view` would make the tick's cost a function of how many rows are
 * waiting -- the property `GH_READS` exists to protect. A blocker older than this list is treated as old
 * (`clearedAt`), which is what it is.
 *
 * `null` IS "COULD NOT READ" AND `unclaimedBlockerClearedOrders` FAILS OPEN ON IT: with no closing time the
 * gate asks at the unstaged key, which is the pre-#2286 behaviour. The alternative -- reading a refused
 * call as "everything closed long ago" -- would silence a FRESH clearing behind the 72-hour grid, the
 * exact stranding #2139 was written to end.
 *
 * @param {(args: string[]) => string} [run]
 * @returns {Map<number, number> | null}
 */
export function readRecentlyClosed(run = defaultRun) {
  try {
    const parsed = JSON.parse(run(["issue", "list", "--state", "closed", "--limit",
      String(RECENTLY_CLOSED_LIMIT), "--json", "number,closedAt"]));
    if (!Array.isArray(parsed)) return null;
    /** @type {Map<number, number>} */
    const closings = new Map();
    for (const r of parsed) {
      const at = Date.parse(r?.closedAt);
      if (Number.isFinite(at)) closings.set(Number(r.number), at);
    }
    return closings;
  } catch {
    return null;
  }
}

/**
 * THE SAME CLEARING, ONE POPULATION OVER: an UNCLAIMED row whose last declared blocker closed -- #2139.
 *
 * `blockerClearedOrders` above scopes itself with `labelsOf(row).includes(CLAIM_LABEL)`, and that single
 * condition is the whole gap. A row NOBODY holds reaches no cause at all when its blockers clear:
 * `blocker-cleared` wants a claim, `lane-backlog-unpromoted` addresses only a lane OWNER, and
 * `ready-queue-empty` fires only when the unlaned Ready pool is EMPTY. So a `lane:any` backlog row that
 * has just become startable is visible to the gate and addressed by nothing in it.
 *
 * MEASURED 2026-09-23 ON THE LIVE TRACKER, and the shape is the point rather than the six rows. A sweep
 * for open rows whose every declared blocker is CLOSED returned SIX -- none claimed, none `ready`, all
 * `lane:any`, every one structurally startable -- stranded 57m, 4h30m, 13h43m, 13h51m, 14h09m and
 * **16h09m**, with three of five peer sessions idle the whole time. They were found because a queued
 * report about an unrelated row sent a human looking.
 *
 * AND THE READY QUEUE WAS NOT EMPTY -- FOUR ROWS. That is precisely why the one cause that would
 * eventually have looked stayed silent, and it is why this cause is NOT gated on an empty shelf the way
 * `epic-unfiled` and `blocked-unexaminable` are. The failure being named is a queue with DEPTH and no
 * THROUGHPUT: work the org already owns, already scoped, and merely unpromoted. A shelf-empty gate would
 * have withheld every one of those six for sixteen hours and then reported them as a supply problem.
 *
 * TO `product-manager`, because promotion is that session's call: `agent-practices.md` makes it first
 * reader for "filing and amendments ... holds, lane labels, promotions". This cause does not promote
 * anything itself -- it asks the one session that may.
 *
 * ONE ORDER PER ROW, KEYED ON THE SET THAT CLEARED -- `blockerClearedOrders`' key discipline from #1799,
 * unchanged. An unchanged clearing asks once; a row blocked again and cleared again is a new question.
 *
 * `READY_LABEL` IS EXCLUDED AND IT IS NOT A TIDINESS FILTER. A `ready` row is already offered by
 * `ready-row-unclaimed`, so asking `product-manager` to promote it would be asking for a promotion that
 * has already happened -- an order whose own subject line is false, which is worse than a duplicate.
 *
 * A ROW HIDDEN BY A `NOT_PICKABLE` LABEL IS NAMED, NOT DROPPED, and #1561 is why. Its `blockedBy` edge
 * cleared itself at 2026-09-23T08:28:00Z exactly as designed and it still sat 4h30m, because a hand-set
 * `blocked` LABEL outlived the referent it named: `blocked` is in `NOT_PICKABLE`, so a self-clearing edge
 * was overridden by a non-self-clearing label. Excluding that row would reproduce the very invisibility
 * that stranded it, and `blocked-unexaminable` -- the only other cause that could have reached it -- is
 * itself shelf-gated and was silent for the same four hours. So the order reports the row AND names what
 * still hides it, which is the one thing #2139 forbids doing silently: never reported as free.
 *
 * AN UNANSWERED ORDER BACKS OFF (#2286): see `PROMOTION_ASK_OFFSETS_MS`. `closings` says when each blocker
 * closed; without it (`null`, or an old caller) every order is the unstaged first ask, which is the
 * behaviour before the backoff existed and is what a refused read must fall back to.
 *
 * @param {any[]} rows every open row
 * @param {string} [today]
 * @param {{closings?: Map<number, number> | null, now?: number}} [when]
 * @returns {{session: string, cause: string, subject: string, discriminator: string,
 *            prompt: string, causeKey: string}[]}
 */
export function unclaimedBlockerClearedOrders(rows, today = todayIso(), { closings = null, now = Date.now() } = {}) {
  const orders = [];
  for (const { row, cleared } of unclaimedClearings(rows, today, now)) {
    const window = clearingAskWindow(cleared, now, closings);
    if (window) orders.push(promotionOrder(row, cleared, window.suffix));
    if (orders.length >= MAX_ROW_ORDERS_PER_TICK) break;
  }
  return orders;
}

/**
 * The unclaimed rows whose last declared blocker has closed, with the set that cleared -- the population
 * `unclaimedBlockerClearedOrders` asks about, and the one `main` reads BEFORE deciding whether to pay for
 * `readRecentlyClosed` at all. Split out so those two callers cannot drift into two spellings of "cleared".
 *
 * `nowMs` IS THE CLOCK THE HOUR-FORM `Not-before:` IS READ AGAINST (#2812). `today` only decides the date form, so a
 * caller that injected `now` and not this left the hour to the real clock: a fixture naming 2026-09-30T00:00:00Z as
 * the future went red on main when the wall clock passed it.
 *
 * @param {any[]} rows @param {string} [today] @param {number} [nowMs]
 * @returns {{row: any, cleared: number[]}[]}
 */
export function unclaimedClearings(rows, today = todayIso(), nowMs = Date.now()) {
  const found = [];
  for (const row of rows ?? []) {
    const labels = labelsOf(row);
    const cleared = declaredBlockers(row);
    if (labels.includes(CLAIM_LABEL) || labels.includes(READY_LABEL) || cleared === null) continue;
    // `needs:chairman` IS A WAIT AND `waitingOn` DOES NOT READ IT (#2583). The label names a person and
    // clears when removed, exactly as `blockedWithoutReferent` already rules, so an order to PROMOTE such a
    // row offers work whose first step is impossible (#2561: its private repository did not exist), and
    // repeats at every `PROMOTION_ASK_OFFSETS_MS` step. Skipped HERE, in this cause's own population,
    // rather than taught to `waitingOn`, which every reader of that function would then inherit.
    if (labels.includes(CHAIRMAN_LABEL)) continue;
    // `parked` IS THE SAME WAIT WITH A DIFFERENT LIFTER (#2653): `ceo` schedules the row when its prerequisite phase
    // is done, so a cleared blocker is not the event that promotes it. #2568 was ordered 30 minutes after being parked.
    if (labels.includes(PARKED_LABEL)) continue;
    // THE LINE THAT MAKES `cleared` MEAN CLEARED, and `blockerClearedOrders`' own sentence applies here
    // unchanged: `waitingOn` reports an OPEN `blockedBy` node before anything else, so passing here is
    // what proves every number above is closed -- and it covers the `Not-before:` and `answer:` cases in
    // the same breath, which is why `declaredBlockers` does not re-ask.
    if (waitingOn(row, today, nowMs)) continue;
    found.push({ row, cleared });
  }
  return found;
}

/**
 * The order `unclaimedBlockerClearedOrders` emits for one row.
 *
 * SPLIT OUT so the loop above reads as the four conditions it actually applies. The prompt carries the
 * ANSWER -- which row, what cleared, and what still hides it -- because a woken turn that has to survey
 * the tracker is a tick with extra steps.
 *
 * INCIDENT BEHIND THE ORDER'S TEXT (moved out of it, #3444: the agent reading the order cannot use it):
 * a shelf with four rows on it is why six rows sat runnable for up to 16h09m on 2026-09-23 with three engineers idle.
 * #1561's `blockedBy` cleared at 2026-09-23T08:28:00Z exactly as designed and the row sat another 4h30m behind a hand-set `blocked` label.
 *
 * @param {any} row @param {number[]} cleared
 * @param {string} [suffix] which re-ask this is -- `""` for the first, `@6h` for the one due six hours on
 */
function promotionOrder(row, cleared, suffix = "") {
  // RE-DERIVED RATHER THAN PASSED IN: the caller's list is its own, and a helper that reads the row it
  // is describing cannot be handed labels belonging to a different one.
  const hiding = labelsOf(row).filter((n) => NOT_PICKABLE.includes(n));
  const key = cleared.join(".");
  return {
    session: "product-manager",
    cause: "unclaimed-blocker-cleared",
    subject: `row-${subjectRef(row.repoKey, row.number)}`,
    discriminator: key,
    prompt: `${subjectMention(row)}${row.title ? ` (${row.title})` : ""} IS UNCLAIMED AND NO LONGER BLOCKED. `
      + `Every row it declared a dependency on is now closed: ${cleared.map((n) => `#${n}`).join(", ")}.\n`
      + "NOTHING ELSE IN THIS ORG WILL SAY SO. `blocker-cleared` addresses the session HOLDING a row and "
      + "nobody holds this one; `lane-backlog-unpromoted` addresses a lane OWNER; `ready-queue-empty` "
      + "fires only when the Ready shelf is EMPTY. Depth is not throughput.\n"
      + `PROMOTE IT, OR RECORD WHY NOT AS DATA. A \`${READY_LABEL}\` label is the promotion; anything else goes in a `
      + `FIELD and not a comment -- \`gh issue edit ${row.number} --add-blocked-by <n>\`, a `
      + `\`Not-before: YYYY-MM-DDTHH:MM:SSZ\` line in the body, or \`${ANSWER_PREFIX}<session>\` if it `
      + "waits on a ruling. Each clears itself, each stops this being asked again, and nothing in this "
      + "org reads comments.\n"
      + (hiding.length > 0
        ? `IT STILL CARRIES ${hiding.map((n) => `\`${n}\``).join(", ")}, AND THAT IS WHAT NOW HIDES IT `
          + "-- the edge cleared itself and the label did not. "
          + `Take the label off if its condition has become true; if the wait is real, it is `
          + "one of the three fields above, which is the whole difference between a condition that "
          + "clears itself and one only a person re-reading the row can lift.\n"
        : "")
      + "THIS IS NOT A SURVEY OF THE BACKLOG. One row, one clearing, already named -- if the answer is "
      + "\"it stays in backlog\", say so in a field and this stops asking.",
    causeKey: `product-manager/unclaimed-blocker-cleared/row-${subjectRef(row.repoKey, row.number)}/${key}${suffix}`,
  };
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
 * THE MARKERS A ROW USES TO SAY "THIS CHANGED UNDER YOU" -- #2110.
 *
 * DECLARED AND PARSED, NEVER INFERRED FROM PROSE, and that is the whole design rather than a nicety. A
 * cause that fired on ANY comment on a claimed row would wake the holder for their own claim record,
 * their own build report and every clarifying reply -- comment-noise arriving one door along from the
 * gap it was meant to close. So this reads the same shape the `Acceptance:`/`Closes:`/`Not-before:`
 * family already established: a literal a writer has to choose on purpose.
 *
 * TWO SPELLINGS BECAUSE THE TWO WRITERS ARE DIFFERENT. A ruling lands as a COMMENT (`## CONSTRAINT` is
 * the heading `product-manager` used on #2099 at 10:22:34Z, before this cause existed to read it); a
 * constraint the row is filed or amended with lands in the BODY, where `row-file`'s own sections live and
 * where a comment would be the wrong place. Both are append-only from a reader's point of view.
 */
export const CONSTRAINT_COMMENT_MARKER = "## CONSTRAINT";
export const CONSTRAINT_BODY_PREFIX = "Constraint:";

/**
 * Pure: the `## CONSTRAINT` comments a row gained AFTER its newest claim record, oldest first.
 *
 * THE CLAIM RECORD IS THE CLOCK, AND IT COSTS NOTHING. `row-claim` appends `CLAIM_RECORD_MARKER` to the
 * thread on every claim, and `gh issue list --json comments` returns comments OLDEST-FIRST -- so
 * "after the claim" is a position in a list this gate already has in hand, with no timestamp arithmetic
 * and no second read. A row claimed, released and claimed again anchors on the NEWEST record, which is
 * `claimRecordFrom`'s own rule for the same reason: the current holder is the one being told.
 *
 * A ROW WITH NO CLAIM RECORD ANCHORS AT THE START OF THE THREAD. Pre-#987 claims wrote labels and no
 * comment, and the rows carrying them are real; refusing to look would make this cause silently blind to
 * the oldest claims in the tracker, which is a worse failure than announcing a constraint that has been
 * sitting there. It is still one order, because the key names the marker.
 *
 * @param {{body?: string, id?: string}[]} comments oldest first, as `gh issue list --json comments` returns
 * @returns {{body?: string, id?: string}[]}
 */
export function constraintsAfterClaim(comments) {
  const list = comments ?? [];
  let claimedAt = -1;
  for (let i = 0; i < list.length; i += 1) {
    if ((list[i]?.body ?? "").includes(CLAIM_RECORD_MARKER)) claimedAt = i;
  }
  return list.slice(claimedAt + 1).filter((c) => hasConstraintHeading(c?.body ?? ""));
}

/**
 * Pure: does this comment body carry the `## CONSTRAINT` heading as a HEADING?
 *
 * ANCHORED TO A LINE START, so a comment that QUOTES the marker in a sentence -- or that quotes this very
 * rule while explaining it -- is not itself a constraint. That is the mention-versus-use trap
 * `acceptance-commands.mjs` names, and it is the one a plain `includes` would walk straight into: the
 * comment announcing this cause on the row would have fired it.
 * @param {string} body
 */
function hasConstraintHeading(body) {
  return new RegExp(`^${CONSTRAINT_COMMENT_MARKER}\\s*$`, "m").test(body);
}

/**
 * Pure: the amendments a CLAIMED row is currently carrying, in a form a causeKey can name.
 *
 * THREE MARKERS, AND EACH ONE ANSWERS "AFTER THE CLAIM" DIFFERENTLY. This is stated here rather than
 * discovered by the next reader, because one of the three cannot answer it at all:
 *
 *   `comment`    ANSWERED EXACTLY -- its position after the newest claim record, see above.
 *   `blocked-by` ANSWERED BY A RULE ELSEWHERE. `blocked-by-edge-rule.mjs` (#1886, closed 2026-09-22)
 *                REFUSES a claim on a row carrying an open `blockedBy`, so an open edge on a row that IS
 *                claimed can only have arrived after the claim. That is exactly #1918: claimed while
 *                clean, blocked by #2100 afterwards, where no claim-time rule can ever reach it.
 *   `body`       NOT ANSWERED, AND SAYING SO IS THE POINT. Nothing in `gh issue list --json` dates a body
 *                line, and dating one would cost a timeline call PER ROW -- the one thing this read may
 *                not become. So a row FILED with a `Constraint:` line and then claimed emits this cause
 *                once, on the first tick after the claim. That is one order telling a holder to read a
 *                constraint on a row they hold, which is not the failure this cause is about; it is
 *                keyed like the others, so it is once and never again.
 *
 * @param {any} row
 * @param {{body?: string, id?: string}[]} comments this row's comments, oldest first
 * @returns {{kind: string, id: string, says: string}[]}
 */
export function amendmentsOn(row, comments) {
  const markers = [];
  const newest = constraintsAfterClaim(comments).at(-1);
  if (newest) markers.push({ kind: "comment", id: String(newest.id ?? "unidentified"),
    says: `a \`${CONSTRAINT_COMMENT_MARKER}\` comment` });
  for (const line of constraintLines(row?.body ?? "")) {
    markers.push({ kind: "body", id: digestOf(line), says: `the row body's \`${line}\`` });
  }
  const open = openBlockers(row);
  if (open.length > 0) {
    markers.push({ kind: "blocked-by", id: `blocked.${open.join(".")}`,
      says: `an open \`blockedBy\` edge on ${open.map((n) => `#${n}`).join(", ")}` });
  }
  return markers;
}

/**
 * Pure: the row body's `Constraint:` lines, whole, in the order they appear.
 *
 * THE WHOLE LINE IS THE MARKER because the whole line is what changes. Keying on the mere PRESENCE of a
 * `Constraint:` line would make a row whose constraint was REPLACED look unchanged, and the replacement
 * is precisely the amendment a holder must be told about.
 * @param {string} body
 * @returns {string[]}
 */
function constraintLines(body) {
  return [...(body ?? "").matchAll(new RegExp(`^${CONSTRAINT_BODY_PREFIX}\\s*(?:.*\\S)`, "gm"))]
    .map((m) => m[0].trim());
}

/**
 * Pure: the row's STILL-OPEN `blockedBy` numbers, sorted, or `[]`.
 *
 * SORTED for `declaredBlockers`'s reason one function up: GitHub returns the nodes in its own order and an
 * unsorted key would mint a different question for the same set of blockers.
 * @param {any} row
 * @returns {number[]}
 */
export function openBlockers(row) {
  return (row?.blockedBy?.nodes ?? [])
    .filter((/** @type {any} */ n) => String(n?.state ?? "").toUpperCase() === "OPEN")
    .map((/** @type {any} */ n) => Number(n.number))
    .sort((/** @type {number} */ a, /** @type {number} */ b) => a - b);
}

/**
 * A short, stable name for a marker GitHub gives no id to -- a body line. Content-derived, so it moves
 * when the line does, which is what makes a REPLACED constraint a new question.
 * @param {string} text
 */
function digestOf(text) {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

/**
 * A ROW MOVED UNDER THE SESSION HOLDING IT, AND NOTHING IN THIS ORG SAID SO -- #2110.
 *
 * MEASURED TWICE IN ONE MORNING, 2026-09-23. #2099 was claimed by `worker-capture` at 09:54:06Z and built
 * by 10:16:50Z; at 10:22:34Z `product-manager` recorded `ceo`'s ruling on it -- *"this row may NOT be
 * implemented by granting a token"* -- 28 minutes after the claim and 6 minutes after the work was
 * finished. It happened to be complied with, and nothing in this org CAUSED that: the gate emitted no
 * cause for `worker-capture` at all, because a claimed row is outside every population it walks.
 * `ready-row-unclaimed` had stopped matching at 09:54 and `blocker-cleared` is the only cause whose
 * subject is a row somebody already holds. The same hour, `orchestrator` was holding #1918 while it
 * acquired an open `blockedBy` on #2100 -- the same defect wearing the other marker.
 *
 * NOT A MESSAGING ROW, AND THAT WAS RULED RATHER THAN ASSUMED. The tempting fix is to make `SendMessage`
 * addresses discoverable; `ceo` steered away from it on 2026-09-23 because the ruling landed precisely
 * BECAUSE it was put on the row. This repo's own rule names the remedy in so many words: if you think you
 * need a cron, the gate is missing a question. This is that question, and it needs no address book at all
 * -- the row's own `session:` label names who owes the answer.
 *
 * ONE ORDER PER ROW, KEYED ON WHAT IS CURRENTLY THERE. The key names EVERY marker the row carries rather
 * than a count or a clock, which is `fleetBatchOrders`'s and `blocker-cleared`'s shape and buys the two
 * properties done-when 3 asks for: a second constraint changes the set, so it is a second question that
 * reaches the holder; an unchanged row mints the identical key on every subsequent tick and the ledger
 * drops it. It is deliberately not "the newest marker" -- the three kinds share no clock (a body line has
 * no timestamp at all), so "newest" would have to be invented, and a constraint REPLACED by a different
 * one would key the same under it and never be told.
 *
 * THE POSITIVE CONTROL LIVES IN `work-gate.test.ts`: an ordinary comment on a claimed row -- a claim
 * record, a build report -- must emit NOTHING. Without it this is a comment-noise generator and the tests
 * that assert silence would all pass against a function that returns `[]`.
 *
 * @param {any[]} rows every open row (`readOpenRows`)
 * @param {{number?: number, comments?: {body?: string, id?: string}[]}[]} [claimedComments]
 *        `readClaimedRowComments`'s answer. `[]` is "not asked or refused", which evaluates the body and
 *        edge markers and not the comment one -- a degradation that can go quiet, never one that invents.
 * @returns {{session: string, cause: string, subject: string, discriminator: string,
 *            prompt: string, causeKey: string}[]}
 */
export function claimedRowAmendedOrders(rows, claimedComments = []) {
  const byRow = new Map((claimedComments ?? []).map((r) => [Number(r?.number), r?.comments ?? []]));
  const orders = [];
  for (const row of rows ?? []) {
    const session = sessionOf(row);
    if (!session || !labelsOf(row).includes(CLAIM_LABEL)) continue;
    const markers = amendmentsOn(row, byRow.get(Number(row.number)) ?? []);
    if (markers.length === 0) continue;
    orders.push(amendedOrder({ row, session, markers }));
    if (orders.length >= MAX_ROW_ORDERS_PER_TICK) break;
  }
  return orders;
}

/**
 * The order itself, split out so `claimedRowAmendedOrders` stays a walk over rows (the Stepdown Rule, and
 * `max-lines-per-function`).
 *
 * INCIDENT BEHIND THE ORDER'S TEXT (moved out of it, #3444: the agent reading the order cannot use it):
 * on 2026-09-23 a ruling reached #2099 six minutes AFTER the build was finished and 28 minutes after the claim; it was honoured only because
 * a human read the thread, and this gate said nothing to the session that held the row.
 *
 * @param {{row: any, session: string, markers: {kind: string, id: string, says: string}[]}} found
 */
function amendedOrder({ row, session, markers }) {
  const key = markers.map((m) => m.id).join("+");
  return {
    session,
    cause: "claimed-row-amended",
    subject: `row-${subjectRef(row.repoKey, row.number)}`,
    discriminator: key,
    prompt: `${subjectMention(row)} IS YOURS AND IT HAS CHANGED UNDER YOU. It now carries `
      + `${markers.map((m) => m.says).join(" and ")}.\n`
      + "GO AND READ IT BEFORE YOU WRITE ANOTHER LINE, and if you have already built, check the diff "
      + "against it rather than your memory of the brief: a ruling can arrive after the build is "
      + "finished, and nothing else tells the session that holds the row.\n"
      + "THEN SAY WHAT YOU DID ABOUT IT, on the row. If the constraint makes the row unbuildable as "
      + `written, that is an answer and it goes in a FIELD: \`${ANSWER_PREFIX}<session>\` for a ruling, `
      + `\`gh issue edit ${row.number} --add-blocked-by <n>\` for a row you must wait on, a `
      + "`Not-before: YYYY-MM-DD` line for a date. Each clears itself.\n"
      + "IF IT IS AN OPEN `blockedBy` EDGE: you were not refused at claim time because the edge did not "
      + "exist then (`blocked-by-edge-rule.mjs` would have refused you) -- it arrived while you held the "
      + "row, which is exactly what happened to #1918 on #2100.",
    causeKey: `${session}/claimed-row-amended/row-${subjectRef(row.repoKey, row.number)}/${key}`,
  };
}

/**
 * The comments on every CLAIMED row, in one call.
 *
 * `--label in-progress` IS THE WHOLE POINT. The claimed population is the only one this cause has a
 * question about, and filtering server-side is what makes this a bounded read rather than 500 rows of
 * comment bodies through a 32MB buffer. See `GH_READS.conditionalOnClaimedRows` for the arithmetic.
 *
 * `null` FOR A REFUSAL, NEVER `[]` -- #1286's rule, and here it means the comment half of
 * `claimed-row-amended` is not evaluated this tick. The body and edge halves still are, because they ride
 * the read that has already happened.
 *
 * @param {(args: string[]) => string} [run]
 * @returns {any[] | null} `null` when refused, never `[]`
 */
export function readClaimedRowComments(run = defaultRun) {
  try {
    const parsed = JSON.parse(run(["issue", "list", "--state", "open", "--label", CLAIM_LABEL,
      "--limit", "200", "--json", "number,comments"]));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// --- #2470: A CLAIM THAT DOES NOT MOVE ---------------------------------------------------------------------------------

/**
 * The newest merged pull requests, in ONE call, for the claimed branches whose work landed while the row stayed open.
 * `null` FOR A REFUSAL, NEVER `[]` (#1286): an unread list is not "nothing merged", and the merged release is simply not
 * evaluated this tick.
 * @param {(args: string[]) => string} [run]
 * @returns {{ number: number, headRefName: string, mergedAt: string, title: string, labels: { name: string }[] }[] | null}
 */
export function readMergedPrs(run = defaultRun) {
  try {
    const parsed = JSON.parse(run(["pr", "list", "--state", "merged", "--limit", "100", "--json",
      "number,headRefName,mergedAt,title,labels"]));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Each open pull request with `checksPending`: a check of its NEWEST run per name is still running. The idle-claimant reading counts that as a wait
 * (#2999), and it is decided HERE, through `newestPerName` and `stillRunning`, so there is one reader of the rollup and one meaning of "running".
 * @param {any[]} prs
 */
export function withChecksPending(prs) {
  return prs.map((pr) => ({ ...pr, checksPending: newestPerName(pr?.statusCheckRollup ?? []).some(stillRunning) }));
}

/**
 * (#3075) THE OTHER TRACKED CODE REPOSITORIES' OPEN AND MERGED PULL REQUESTS, for `claimFactsFrom`: a claim's work can be in a repository other than the
 * one holding the row (`a11ign/agent-org`'s #38 for #3039), and a list of this repository's alone reads that holder as one with nothing built. Each lane
 * is read by the readers the scope enumeration already uses (`readPrs`, `readMergedPrs`), aimed at the repository, and its members are tagged with the key.
 * `undefined` for a project with one code repository, so its reads are exactly what they were. An OPEN list is `null` when ANY repository's was refused (the
 * claim is then skipped); a merged one only when EVERY repository's was.
 * @param {readonly Scope[]} [scopes] @param {(args: string[], repo?: string) => string} [run]
 * @returns {{ open: any[] | null, merged: any[] | null } | undefined}
 */
export function readElsewherePrs(scopes = scopesOf([homeProjectDeclaration()]), run = defaultRun) {
  const lanes = scopes.filter((scope) => scope.key !== "" && scope.code !== null).map((scope) => {
    const repo = /** @type {ScopeRepository} */ (scope.code).repo;
    const aimed = (/** @type {string[]} */ args) => run(args, repo);
    return { open: tagged(readPrs(aimed), scope.key, repo), merged: tagged(readMergedPrs(aimed), scope.key, repo) };
  });
  if (lanes.length === 0) return undefined;
  return { open: lanes.some((lane) => lane.open === null) ? null : lanes.flatMap((lane) => lane.open ?? []),
    merged: lanes.every((lane) => lane.merged === null) ? null : lanes.flatMap((lane) => lane.merged ?? []) };
}

/** @param {string[]} args */
export const systemctlRun = (args) => execFileSync("systemctl", args, { encoding: "utf8", timeout: 10_000 });

/** The project checkout this tool serves (`HOME_CHECKOUT`, not `src` up three): where `../wt-<row>` claim records are resolved against. */
export const REPO_CHECKOUT = HOME_CHECKOUT;

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
 *          body?: string, labels?: {name?: string}[],
 *          blockedBy?: {nodes?: {number?: number, state?: string}[]}}[]} epics
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
    .filter((e) => waitingOn(e, today) === null)
    // `parked` AND `needs:chairman` ARE WAITS THAT `waitingOn` DOES NOT READ, AND THIS IS THE FIFTH READER OF THAT
    // GAP (#2583, #2604, #2653 and #2780 each taught one population; `epicOrders` was one none of them reached).
    // MEASURED 2026-10-02: #2628 (the documents axis, `parked` by `ceo` on 2026-09-26, the lift `ceo`'s when
    // `v2 — SaaS depth` closes) was ordered to `product-manager` THREE TIMES IN ONE DAY, and each answer was the
    // same comment ("left WHOLE", the reason already on the row). Dropped HERE, beside the `waitingOn` filter, and
    // not taught to `waitingOn`, which every reader of that function would then inherit. Removing the label puts
    // the epic back, so the lift clears itself.
    .filter((e) => !labelsOf(e).some((/** @type {string} */ n) => n === PARKED_LABEL || n === CHAIRMAN_LABEL));
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
    subject: `epic-${subjectRef(e.repoKey, e.number)}`,
    discriminator: subjectRef(e.repoKey, e.number),
    prompt: `NOTHING IS READY AND ${subjectMention(e)}${e.title ? ` (${e.title})` : ""} IS AN OPEN EPIC WITH NO `
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
    causeKey: `product-manager/epic-unfiled/epic-${subjectRef(e.repoKey, e.number)}`,
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
 * INCIDENT BEHIND THE ORDER'S TEXT (moved out of it, #3444: the agent reading the order cannot use it):
 * measured 2026-09-21, nine of the org's thirteen open epics were finished and the backlog read three times deeper than it was.
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
    subject: `epic-${subjectRef(e.repoKey, e.number)}`,
    discriminator: subjectRef(e.repoKey, e.number),
    prompt: `${subjectMention(e)}${e.title ? ` (${e.title})` : ""} IS AN OPEN EPIC WHOSE EVERY CHILD IS CLOSED `
      + `(${e?.subIssuesSummary?.completed ?? 0} of ${e?.subIssuesSummary?.total ?? 0}).\n`
      + "TWO ANSWERS, AND THE ORDER DOES NOT PRESUME WHICH. Either the line of work is FINISHED -- close "
      + "the epic -- or the next tranche of children has simply never been filed, which is the more "
      + "valuable answer because it is unfiled WORK, invisible to every other cause since `epic` means "
      + "NOT PICKABLE. File those rows (a Region, an Acceptance, a done-when) with "
      + `\`gh issue edit <child> --parent ${e.number}\`.\n`
      + "WHY THIS IS NOT BOOKKEEPING: a finished epic left open is counted as backlog by everything that "
      + "counts backlog, so the backlog reads deeper than it is -- which is how the org runs out of "
      + "work without anyone noticing.\n"
      + "RECORD THE ANSWER ON THE EPIC either way, and READ ITS OWN RECENT COMMENTS FIRST: a durable "
      + "reason recorded there stands until something about THIS epic changes.",
    causeKey: `product-manager/epic-finished/epic-${subjectRef(e.repoKey, e.number)}`,
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
 * ONE SPELLING OF THE ENDPOINT, so the report names what the read actually asks for. A report that
 * quotes a path by hand drifts from the call beside it, and a wrong path in a diagnostic sends the next
 * reader to test something the gate never did.
 *
 * `branches/main`, NOT `branches/main/protection` (#2331). The protection endpoints are repository-ADMIN
 * only, and this gate runs as `a11ign-ai-workers` (`permissions.admin: false`), so it 404'd on every tick
 * for four days (#2106). `branches/main` needs only `pull` and carries the same list.
 */
const BRANCH_ENDPOINT = "repos/{owner}/{repo}/branches/main";

/**
 * What the gate asks of `BRANCH_ENDPOINT`: the list, plus `protected` so the "no usable list" report quotes
 * whether `main` is protected at all (`false` is a trunk fact worth escalating) instead of leaving the
 * reader to guess. Small enough to quote whole.
 */
const BRANCH_JQ = "{protected, contexts: .protection.required_status_checks.contexts}";

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
 * ONCE PER TICK, because `requiredWhenNeeded` is the only caller and calls this at most once.
 *
 * @param {(args: string[]) => string} [run]
 * @param {(line: string) => void} [log]
 * @returns {string[] | null}
 */
export function requiredCheckNames(run = defaultRun, log = (line) => process.stderr.write(line)) {
  let answer;
  try {
    answer = run(["api", BRANCH_ENDPOINT, "--jq", BRANCH_JQ]);
  } catch (error) {
    // THE REFUSAL AND THE UNUSABLE ANSWER ARE DIFFERENT FACTS, so the call is separated from the parse.
    // A refusal says nothing about whether `main` is protected, and #2022 forbids reading it as if it did.
    const why = String(/** @type {any} */ (error)?.message ?? error).split("\n")[0].trim();
    log(cannotReadRequiredChecks(`was REFUSED (${why}).`));
    return null;
  }
  const contexts = parsedOrNull(answer)?.contexts;
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
  return `CANNOT READ the required checks: \`gh api ${BRANCH_ENDPOINT}\` ${diagnosis} `
    + "Falling back to EVERY check on the head (pre-#1750 behaviour): no red pull request is missed, "
    + "but the wasted prompts #1750 was filed to stop are still being sent.\n";
}

/** Where `main` is now, and the one field of it the prompt needs. */
const BASE_TIP_ENDPOINT = "repos/{owner}/{repo}/commits/main";
/** A commit id, abbreviated or whole. An empty or non-hex `sha` would render as a blank tip in the prompt. */
const HEX_SHA = /^[0-9a-f]{7,40}$/i;
const BASE_TIP_JQ = "{sha: .sha, date: .commit.committer.date}";

/**
 * `main`'s tip commit and its committer date, or `null` (#2117).
 *
 * THIS IS A FACT FOR A PROMPT AND NEVER A PREDICATE. `null` -- refused, malformed, no date -- makes the
 * prompt say "not read", which is different from "has not moved", and changes nothing about whether or to
 * whom the order is sent. The committer date is a reading of when `main` last changed, not the instant of
 * the push: a rebased commit keeps an older date, so the prompt quotes the date and lets a reader `git log`.
 *
 * Refusals are announced on stderr like `requiredCheckNames`': a read that fails silently is
 * indistinguishable from one that never ran.
 *
 * @param {(args: string[]) => string} [run]
 * @param {(line: string) => void} [log]
 * @returns {{sha: string, date: string} | null}
 */
export function readBaseTip(run = defaultRun, log = (line) => process.stderr.write(line)) {
  let answer;
  try {
    answer = run(["api", BASE_TIP_ENDPOINT, "--jq", BASE_TIP_JQ]);
  } catch (error) {
    const why = String(/** @type {any} */ (error)?.message ?? error).split("\n")[0].trim();
    log(`CANNOT READ main's tip: \`gh api ${BASE_TIP_ENDPOINT}\` was REFUSED (${why}). `
      + "pr-checks-failing prompts will call `has main moved` UNKNOWN; no order is withheld for it.\n");
    return null;
  }
  const tip = parsedOrNull(answer);
  return HEX_SHA.test(String(tip?.sha)) && Number.isFinite(Date.parse(tip?.date)) ? tip : null;
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
  return mergeCandidates(prs, required).map((pr) => Number(pr.number)).sort((a, b) => a - b);
}

/**
 * PURE. The pull requests `shouldBeMerging` judges, as OBJECTS rather than numbers.
 *
 * EXTRACTED RATHER THAN COPIED (#2084), because two readers now ask the same question of the same
 * population and the second one needs a field the first throws away. `shouldBeMerging` wants numbers to
 * hand to `readUnarmed`; `reviewBlocked` below wants each PR's `reviewDecision`. A second copy of these
 * three filters is how `pr-hold-state.mjs`'s own header records #645 going wrong -- the predicate written
 * twice, one copy correct -- and here it would be worse than a wrong answer: the two causes would report
 * OVERLAPPING but different populations, so a pull request could be called stranded by one and healthy by
 * the other on the same tick.
 *
 * @param {any[]} prs @param {string[] | null} [required]
 * @returns {any[]}
 */
function mergeCandidates(prs, required = null) {
  return greenUnheldPrs(prs, required)
    .filter((pr) => conflictStateOf(pr) !== CONFLICT_STATE.CONFLICTING);
}

/**
 * PURE. The pull requests that are not a draft, not held and settled green on every required check --
 * BEFORE asking whether they can merge. Both halves of that question are read from this one population:
 * `mergeCandidates` keeps the ones that can, `conflictedPrs` the ones that cannot, so the two partition it
 * and no pull request is called stranded by one cause and healthy by another on the same tick (#2084's
 * argument for extracting `mergeCandidates`, applied once more).
 *
 * @param {any[]} prs @param {string[] | null} [required]
 * @returns {any[]}
 */
function greenUnheldPrs(prs, required = null) {
  return (prs ?? [])
    .filter((pr) => pr && pr.isDraft !== true && Number.isFinite(Number(pr.number)))
    // A DRAFT IS EXCLUDED AT THE SOURCE, NOT BY THE HOLD RULE: `gh pr merge --auto` refuses a draft
    // outright, so an unarmed draft is correct rather than stranded.
    .filter((pr) => armabilityOf({ labels: labelsOf(pr) }).arm)
    .filter((pr) => checksSettledGreen(
      blockingChecks(newestPerName(pr.statusCheckRollup ?? []), required)) === true);
}

/** The three answers `conflictStateOf` can give. `UNREAD` is deliberately not a spelling of "clear". */
export const CONFLICT_STATE = Object.freeze({
  /** GitHub says the branch cannot merge into `main` as it stands. */
  CONFLICTING: "CONFLICTING",
  /** GitHub named a merge state and it is not a conflict. */
  NOT_CONFLICTING: "NOT_CONFLICTING",
  /** The payload carried no usable state -- absent, or `UNKNOWN` while GitHub is still computing it. */
  UNREAD: "UNREAD",
});

/**
 * PURE. #2209: DOES THIS PULL REQUEST CONFLICT WITH `main`? -- three answers, and the third is not "no".
 *
 * EITHER FIELD SAYING CONFLICT IS ENOUGH. `mergeStateStatus: DIRTY` and `mergeable: CONFLICTING` are the
 * same fact in two vocabularies (#2203 carried both), and a conflict is the one state where believing the
 * louder of two fields is safe: the error it can make is a pull request reported to its author, who looks
 * and finds it clean, rather than one nobody was told about.
 *
 * ABSENT OR `UNKNOWN` IS `UNREAD`, AND IT FALLS THE WAY `readPrs`'s OWN `null`-MEANS-REFUSED RULE FALLS
 * (#1286), ONE FIELD DOWN: a question that was not answered is not answered "fine". Concretely, an unread
 * pull request is never certified as one that can merge and is never sent a conflict order it may not
 * deserve, and it STAYS in `mergeCandidates` -- exactly where it sat before this row. Dropping it there
 * would turn a field the gate lost, or GitHub had not yet computed, into a silently emptier
 * `pr-green-unarmed`, which is the reassuring direction a blind spot fails in.
 *
 * @param {any} pr
 * @returns {string} a `CONFLICT_STATE` value
 */
export function conflictStateOf(pr) {
  if (pr?.mergeStateStatus === "DIRTY" || pr?.mergeable === "CONFLICTING") return CONFLICT_STATE.CONFLICTING;
  const status = pr?.mergeStateStatus;
  if ((typeof status === "string" && status !== "UNKNOWN") || pr?.mergeable === "MERGEABLE") {
    return CONFLICT_STATE.NOT_CONFLICTING;
  }
  return CONFLICT_STATE.UNREAD;
}

/**
 * PURE. #2209: the green, unheld, non-draft pull requests that CANNOT MERGE because they conflict with
 * `main` -- the complement of `mergeCandidates` inside `greenUnheldPrs`.
 *
 * @param {any[]} prs @param {string[] | null} [required]
 * @returns {any[]} ascending by PR number
 */
export function conflictedPrs(prs, required = null) {
  return greenUnheldPrs(prs, required)
    .filter((pr) => conflictStateOf(pr) === CONFLICT_STATE.CONFLICTING)
    .sort((a, b) => Number(a.number) - Number(b.number));
}

/**
 * #2084: WHAT GITHUB'S OWN REVIEW DECISION SAYS ABOUT ONE PULL REQUEST -- five states, none of them a guess.
 *
 * THE FIELD IS NOT A STATEMENT ABOUT THE HEAD, AND THAT IS THE FINDING RATHER THAN A CAVEAT. A review
 * attaches to a COMMIT; `reviewDecision` is computed from the latest review REGARDLESS of which head it was
 * posted on. With `dismiss_stale_reviews: false` a refusal outlives the fix and an approval outlives the
 * diff it approved. So this reader deliberately reports GITHUB'S BLOCKING STATE and never claims the
 * decision was made at the current head -- claiming that is the error #2084 exists to name.
 *
 * ABSENT IS ITS OWN STATE AND IT IS NOT "FINE" (`UNREADABLE`), BUT IT IS NOT THIS CAUSE'S SUBJECT EITHER.
 * A payload that never carried the field says nothing about the pull request, so an order naming one would
 * be reporting the gate's own read rather than a state anybody can act on. It IS still the reassuring
 * direction -- a `readPrs` that stopped asking would empty this cause silently -- and the control for that
 * is named and lives one layer up, where the regression would actually be: `work-gate.test.ts`'s
 * "`reviewDecision` rides on readPrs's existing field list" asserts the `--json` argument itself. A guard
 * on the ARGUMENT catches the regression on every run; a guard in this verdict would instead fire on every
 * synthetic fixture in the suite, which is noise rather than a control.
 *
 * EMPTY IS DIFFERENT FROM ABSENT AND IS ALSO NOT A PASS (`NO_DECISION`). GitHub leaves `reviewDecision`
 * EMPTY when the base branch requires no approval -- `branch-protection.test.ts` calls it the #1968 state,
 * measured on a pull request carrying three reviews including an `APPROVED`. Nothing is blocked, and
 * nothing has been reviewed either; folding it into `APPROVED` would report an unprotected base as a
 * satisfied requirement.
 *
 * ANYTHING ELSE IS `UNRECOGNISED` AND STILL BLOCKS, which is `bindsMeVerdict`'s `!== "never"` shape one
 * file over and for its reason: an allowlist of the blocking values would be written from today's
 * vocabulary, and the one value nobody here has seen is exactly the one that would slip through. A state
 * this code cannot name must never be the state that lets a pull request read as healthy.
 *
 * @param {any} pr
 * @returns {{code: string, why: string}}
 */
export function reviewStateOf(pr) {
  if (!Object.hasOwn(pr ?? {}, "reviewDecision")) {
    return { code: REVIEW_STATE.UNREADABLE,
      why: "the payload carries no `reviewDecision` field at all -- this read never asked GitHub, so it is "
        + "not a statement about the pull request" };
  }
  const decision = pr.reviewDecision;
  if (decision === null || decision === "") {
    return { code: REVIEW_STATE.NO_DECISION,
      why: "`reviewDecision` is empty: the base branch computes no decision, so no approval is required and "
        + "none has been recorded -- the #1968 state, which is not an approval" };
  }
  if (decision === "APPROVED") return { code: REVIEW_STATE.APPROVED, why: "`reviewDecision` is APPROVED" };
  if (decision === "REVIEW_REQUIRED") {
    return { code: REVIEW_STATE.AWAITING_REVIEW,
      why: "`reviewDecision` is REVIEW_REQUIRED: GitHub is holding it for an approval nobody has posted" };
  }
  if (decision === "CHANGES_REQUESTED") {
    return { code: REVIEW_STATE.REFUSED,
      why: "`reviewDecision` is CHANGES_REQUESTED: a reviewer refused it, and GitHub will hold it until a "
        + "NEWER review says otherwise -- pushing past a refusal does not clear one" };
  }
  return { code: REVIEW_STATE.UNRECOGNISED,
    why: `\`reviewDecision\` is ${JSON.stringify(decision)}, which this gate has never seen: an unrecognised `
      + "state, and an unrecognised state must not read as a mergeable one" };
}

/** The five states `reviewStateOf` distinguishes. Two of them block, and two of the rest are not passes. */
export const REVIEW_STATE = Object.freeze({
  /** GitHub is waiting for an approval nobody has posted. */
  AWAITING_REVIEW: "AWAITING_REVIEW",
  /** A reviewer refused, and only a newer review clears it. */
  REFUSED: "REFUSED",
  /** The requirement is met. */
  APPROVED: "APPROVED",
  /** The base requires no decision, so there is none -- NOT an approval. */
  NO_DECISION: "NO_DECISION",
  /** The payload never carried the field. NOT a statement about the pull request. */
  UNREADABLE: "UNREADABLE",
  /** A value this gate cannot name. Blocks, deliberately. */
  UNRECOGNISED: "UNRECOGNISED",
});

/** The states that stop a pull request merging, however green and armed it looks. @type {readonly string[]} */
export const BLOCKING_REVIEW_STATES = Object.freeze([
  REVIEW_STATE.AWAITING_REVIEW, REVIEW_STATE.REFUSED, REVIEW_STATE.UNRECOGNISED]);

/**
 * PURE. The commit the newest `CHANGES_REQUESTED` review was posted at, or `null` when the payload names none.
 *
 * `reviews` AND NOT `latestReviews` for the reason `readPrs` records (#2365): `latestReviews[].commit.oid` comes
 * back empty. `null` is "the payload cannot say", never "at no commit" -- the order then tells the reader to
 * look rather than asserting a comparison nobody made. The LAST refusal is taken on the assumption that `gh` lists
 * reviews oldest first, as GitHub's API does; that order was NOT confirmed here (the one PR read had a single review).
 *
 * @param {any} pr @returns {string | null}
 */
function refusalCommitOf(pr) {
  if (!Array.isArray(pr?.reviews)) return null;
  const refusals = pr.reviews.filter((/** @type {any} */ r) => r?.state === "CHANGES_REQUESTED");
  const oid = refusals.at(-1)?.commit?.oid;
  return oid ? String(oid) : null;
}

/**
 * PURE. #3045: whether a pull request's patch at its current head equals its patch at `oid` -- the head a review was posted at. `null`
 * when `oid` is absent or either patch was not read (`withPatchIds`), because absence of a reading is not a reading of change.
 * @param {any} pr @param {string | null} oid @returns {boolean | null}
 */
function patchUnchangedSince(pr, oid) {
  const ids = pr?.patchIds ?? {};
  const now = ids[String(pr?.headRefOid ?? "")];
  const then = oid ? ids[oid] : undefined;
  return typeof now === "string" && typeof then === "string" ? now === then : null;
}

/**
 * PURE. #2084: the pull requests that LOOK like they should be merging and that GitHub's review
 * requirement is holding -- plus any whose decision could not be read at all.
 *
 * `UNREADABLE` IS EXCLUDED, and `reviewStateOf`'s own note says where its control lives instead.
 *
 * THE POPULATION IS `mergeCandidates`', NOT EVERY OPEN PULL REQUEST, and each exclusion is another cause's
 * subject rather than an oversight: a draft belongs to `draft-awaiting-verdict`, a red one to
 * `pr-checks-failing`, and a held one is not merging BY DECISION. What is left is the state nothing in this
 * repository could see before -- not a draft, not held, green on every required check, and blocked anyway.
 *
 * EACH ENTRY CARRIES THE FACTS ROUTING NEEDS (#2283): the PR's `session:` label (`null` when it has none), the
 * head, and -- for a refusal -- the commit the refusing review was posted at. The label is what lets
 * `reviewBlockedOrders` send a labelled pull request to its own session instead of to `product-manager`;
 * the two commits let the order open with the comparison the #2084 diagnosis turns on.
 *
 * @param {any[]} prs @param {string[] | null} [required]
 * `patchUnchanged` (#3045) is whether the pull request's patch is the one the refusing review was posted at: `true`, or `false`, or `null` when
 * either patch was not read -- unread is not changed, and is not unchanged either.
 *
 * `refusalLifted` (a11ign#3199) is whether the refusal was posted for a check that failed at that commit and fails at none now, at an equal
 * patch (`refusalLiftedAt`, the decider the door asks): a refusal that only a fresh review can lift and that no rework could.
 *
 * @returns {{number: number, code: string, why: string, session: string | null, head: string,
 *            refusedAt: string | null, patchUnchanged: boolean | null, refusalLifted: boolean}[]} ascending by PR number
 */
export function reviewBlocked(prs, required = null) {
  const byNumber = new Map(prs.map((pr) => [Number(pr.number), pr]));
  return mergeCandidates(prs, required)
    .map((pr) => ({ number: Number(pr.number), ...subjectIdentity(pr), ...reviewStateOf(pr), session: sessionOf(pr),
      head: String(pr.headRefOid ?? ""), refusedAt: refusalCommitOf(pr), patchUnchanged: patchUnchangedSince(pr, refusalCommitOf(pr)),
      refusalLifted: refusalLiftedAt(pr, refusalCommitOf(pr)) }))
    .filter((r) => BLOCKING_REVIEW_STATES.includes(r.code))
    // #2416: `pr-review-blocked` is the third route into a review -- it tells `product-manager` to prompt the
    // reviewer for an AWAITING_REVIEW pull request. A labelled one is waiting for evidence, not a reviewer; a
    // REFUSED one stays, because a refusal is real whatever the PR is waiting on.
    .filter((r) => r.code !== REVIEW_STATE.AWAITING_REVIEW || !awaitingEvidence(byNumber.get(r.number)))
    .sort((a, b) => a.number - b.number);
}

// --- #1959: A PIPELINE PULL REQUEST WITH NO CODE-OWNER REVIEW ------------------------------------------

/**
 * `docs/lane-ownership.json`'s pipeline lane (`.github/workflows/`, owner `ceo`), or `null` when the file
 * cannot be read.
 *
 * `null` IS CANNOT-ASK, NEVER "NOTHING OWNS THE PIPELINE" -- `loadLanes`'s own rule: a check that answers
 * "clear" because it could not find its own rules is worse than no check, and `pipelineCodeownerReviewMissing`
 * below reads this return the same way.
 * @returns {{owner: string, paths: string[], except?: string[]} | null}
 */
function pipelineLane() {
  return loadLanes()?.lanes.find((l) => l.lane === "the pipeline") ?? null;
}

/**
 * A lane's role-name owner, spelled as the GitHub login CODEOWNERS names -- `codeowners-lane-sync.test.ts`'s
 * own `ROLE_LOGIN`, deliberately re-asserted here rather than shared: `docs/lane-ownership.json` names the
 * ROLE ("ceo") and never the account, and a shared module would make the mapping look derived from a file
 * that does not carry it. `ceo`'s to move, same as that test's copy.
 */
const ROLE_LOGIN = Object.freeze({ ceo: "a11ign-ai-leads" });

/**
 * Does this PR touch a path CODEOWNERS actually assigns to the lane's owner -- inside `paths` and outside
 * every `except` entry, the same last-matching-pattern rule GitHub applies to the file itself. A PR
 * touching ONLY an excepted path (`.github/workflows/consumer-gate.yml`) answers `false`.
 * @param {string[]} files @param {{paths: string[], except?: string[]}} lane
 */
function touchesOwnedLanePath(files, lane) {
  return files.some((f) => inLane(f, lane.paths) && !inLane(f, lane.except ?? []));
}

/**
 * PURE. #1959: every open pull request CODEOWNERS assigns to the pipeline lane's owner and that owner has
 * not approved -- the gap nothing asked about before this row. `reviewDecision` alone cannot say WHO
 * approved, only that GitHub is satisfied, and measured 2026-09-22: `DanBeckDev` (`ceo`'s login) has never
 * authored a formal GitHub review in this repository, so a pipeline PR could sit indefinitely on an
 * unanswered CODEOWNERS request -- advisory today, a hard merge block the moment #1756's flip lands.
 *
 * EXCLUDES A PR THE OWNER AUTHORED. GitHub will not request a review from a pull request's own author, so
 * no such request is ever outstanding for one, and the bypass allowance #2022 requires covers exactly this
 * case -- checked explicitly rather than left to `reviews` staying empty, so a future change to how GitHub
 * reports self-authored PRs cannot silently start firing this cause on `ceo`'s own work.
 *
 * `prFiles` IS `comparablePrFiles`'S OUTPUT, NOT `pr.files` RE-READ. That function already drops any PR
 * whose file list does not match its `changedFiles` count (`gh pr list --json files` truncates at 100; `readPrs` pages
 * such a PR first since #3365, and one it could not page still drops out), so
 * this cause inherits the same guarantee: it can be silent about a PR the gate cannot see the whole of, but
 * it can never fire on a partial list and miss the path that mattered.
 *
 * @param {any[]} prs @param {{number: number, files: string[]}[]} prFiles
 * @returns {{number: number, repoKey?: string, session: string | null}[]} ascending by PR number
 */
export function pipelineCodeownerReviewMissing(prs, prFiles) {
  const lane = pipelineLane();
  const login = lane && /** @type {Record<string, string>} */ (ROLE_LOGIN)[lane.owner];
  if (!login) return [];
  const filesByNumber = new Map(prFiles.map((p) => [Number(p.number), p.files]));
  return prs
    .filter((pr) => pr.author?.login !== login)
    .filter((pr) => touchesOwnedLanePath(filesByNumber.get(Number(pr.number)) ?? [], lane))
    .filter((pr) => !(pr.reviews ?? []).some(
      (/** @type {any} */ r) => r?.state === "APPROVED" && r?.author?.login === login))
    .map((pr) => ({ number: Number(pr.number), ...subjectIdentity(pr), session: sessionOf(pr) }))
    .sort((a, b) => a.number - b.number);
}

/**
 * ONE ORDER NAMING EVERY PULL REQUEST STILL MISSING ITS CODE-OWNER REVIEW -- `greenUnarmedOrders`'s shape
 * and for its reason: the set is what makes the cause self-clearing, keyed on WHICH pull requests are
 * still waiting rather than on any one push, so a review that clears one leaves it out of the next key.
 *
 * `ceo` ALWAYS, WHOEVER OPENED THE PULL REQUEST -- unlike `pr-review-blocked`'s owned/unowned split, the
 * act this order asks for (`ceo` posting a formal review) is never a labelled session's to do; the label,
 * when there is one, is named in the prompt only so `ceo` knows whose branch it is.
 *
 * @param {{number: number, repoKey?: string, session: string | null}[]} missing
 * @returns {{session: string, cause: string, subject: string, discriminator: string, prompt: string,
 *            causeKey: string}[]}
 */
function pipelineCodeownerReviewOrders(missing) {
  if (missing.length === 0) return [];
  const key = missing.map((m) => subjectRef(m.repoKey, m.number)).join(".");
  const named = missing.map((m) => `${subjectMention(m)}${m.session ? ` (${m.session})` : ""}`).join(", ");
  return [{
    session: "ceo",
    cause: "pr-codeowner-review-missing",
    subject: "pr-codeowner-review-missing",
    discriminator: key,
    prompt: `${missing.length} open pull request(s) touch a \`.github/workflows/\` path CODEOWNERS `
      + `assigns to you and carry NO APPROVED review from you: ${named}.\n`
      + "Nothing asked for this review before #1959: `reviewDecision` alone cannot say the approval came "
      + "from the code owner, and you have never authored a formal GitHub review in this repository. It is "
      + "advisory today -- #1756 (still open) is what turns it into a hard merge block.\n"
      + "Review each and post a formal GitHub review (approve or request changes) -- a comment on the "
      + "pull request is not a review and does not satisfy CODEOWNERS.",
    causeKey: `ceo/pr-codeowner-review-missing/${key}`,
  }];
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
    const nodes = JSON.parse(run(openPullRequestsQueryArgs(repoNow())));
    if (!Array.isArray(nodes)) return null;
    const armed = new Map(nodes.map((n) => [Number(n?.number), armedFromApi(n)]));
    return candidates.filter((n) => armed.get(n) === false);
  } catch {
    return null;
  }
}

/**
 * #3019: WHICH OF THE UNARMED CANDIDATES WERE ARMED AND THEN EJECTED, split out before `greenUnarmedOrders` sees them.
 *
 * `readUnarmed` says "nothing is armed NOW"; that is also what a PR the queue removed for a red `merge_group` run looks like,
 * and the order built from it told `product-manager` to re-arm it into a third red run. Each candidate's timeline is read
 * (one call each -- the candidates are the few PRs a tick found green and unarmed) and an ejected one is returned with what
 * the owner needs: when, which run, which subtests.
 *
 * `null` WHEN THE CANDIDATES THEMSELVES WERE REFUSED, and a candidate whose OWN timeline read is refused or unreadable is
 * DROPPED FROM BOTH SIDES: it is neither called unarmed nor called ejected, because either would be a guess and an order
 * built on a guess is the defect this fixes. A refused read sends no order, never a false all-clear.
 *
 * @param {number[] | null} unarmed `readUnarmed`'s answer
 * @param {(args: string[]) => string} [run]
 * @returns {{ unarmed: number[], ejections: Map<number, {removedAt: string | null, runId: number | null, failingTests: string[] | null}> } | null}
 */
export function readEjections(unarmed, run = defaultRun) {
  if (unarmed === null) return null;
  const ejections = new Map();
  const stillUnarmed = [];
  for (const number of unarmed) {
    const ejection = readEjection(number, run);
    if (ejection === null) continue;
    if (ejection.ejected) ejections.set(number, readEjectionRun(number, ejection.removedAt, run));
    else stillUnarmed.push(number);
  }
  return { unarmed: stillUnarmed, ejections };
}

/** @param {number} number @param {(args: string[]) => string} run */
function readEjection(number, run) {
  try {
    return queueEjectionOf(JSON.parse(run(ejectionQueryArgs({ number, repo: repoNow() }))));
  } catch {
    return null; // refused or not JSON: `queueEjectionOf(null)`'s own answer for "the API did not say"
  }
}

/**
 * The failed `merge_group` run behind one ejection and the subtests it failed -- each fact `null` when it could not be read,
 * because an order that names an ejection without its run is still better than none, and one that INVENTS a run is worse.
 *
 * The run is found by its branch (`gh-readonly-queue/main/pr-<n>-<sha>`, measured on `agent-org#16`): the newest failed
 * `merge_group` run for this PR created no later than the removal. A PR ejected twice has two, and the removal time picks.
 *
 * @param {number} number @param {string | null} removedAt @param {(args: string[]) => string} run
 */
function readEjectionRun(number, removedAt, run) {
  const found = { removedAt, runId: /** @type {number | null} */ (null), failingTests: /** @type {string[] | null} */ (null) };
  try {
    /** @type {{ id: number, head_branch: string, conclusion: string, created_at: string }[]} */
    const runs = JSON.parse(run(["api", `repos/${repoNow()}/actions/runs?event=merge_group&per_page=50`, "--jq", "[.workflow_runs[] | {id, head_branch, conclusion, created_at}]"]));
    const failed = runs
      .filter((r) => String(r.head_branch).includes(`/pr-${number}-`) && r.conclusion === "failure"
        && (removedAt === null || String(r.created_at) <= removedAt))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
    if (!failed) return found;
    found.runId = Number(failed.id);
    found.failingTests = failingSubtestsOf(run(["run", "view", String(failed.id), "--repo", repoNow(), "--log-failed"]));
  } catch {
    /* the facts read so far stand; the order says the rest could not be read */
  }
  return found;
}

/**
 * The failing subtest identities in a `--log-failed` dump, capped so a mass failure does not become the order.
 * `null` when the log names none: "the log did not say" is a different report from "no subtest failed".
 * @param {string} log
 * @returns {string[] | null}
 */
function failingSubtestsOf(log) {
  const lines = log.split("\n").map((l) => l.replace(/^.*?\t.*?\t/, "").replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /, ""));
  const { notOkLines } = summarizeTestLog(lines.join("\n"));
  const names = [...new Set(notOkLines.map(testIdentity))];
  return names.length === 0 ? null : names.slice(0, MAX_EJECTION_SUBTESTS);
}
const MAX_EJECTION_SUBTESTS = 5;

/**
 * Is this pull request's red made ONLY of the hold's own manufactured jobs? A `hold:` label reddens
 * exactly `HOLD_RED_JOBS` on purpose (`work-gate/pr-orders.mjs`'s own header), and the REVIEW question
 * does not care who placed the hold -- unlike `redOnlyFromHoldOf`, which asks whether a hold answers a
 * SPECIFIC session and is used to decide whether that session gets a "fix your build" order. Here the
 * question is only "is this red manufactured or real", so any `hold:` label counts.
 *
 * A hold must keep stopping a MERGE (`armabilityOf`/`greenUnheldPrs`, unaffected -- neither calls this).
 * It must stop blocking a REVIEW, which is the defect #2709 was filed for: PR #2649 carried a release
 * condition needing a verdict, and the hold's own red checks made `reviewableHead` return `null` before
 * anyone was ever asked for one.
 * @param {any} pr @param {any[]} onHead every check on the head, narrowed by `newestPerName`
 */
function redOnlyFromAnyHold(pr, onHead) {
  if (holdersOf(labelsOf(pr)).length === 0) return false;
  const red = onHead.filter((c) => checksSettledGreen([c]) === false);
  return red.length > 0 && red.every((c) => HOLD_RED_JOBS.includes(String(c?.name ?? c?.context)));
}

/**
 * The head this pull request's review question is asked at, or `null` when it is not asked: red, still
 * running, or headless. Shared by `draftOrder` and the enrichment that decides which pull requests are
 * worth a commit read, so the two can never disagree about who is being asked.
 * @param {any} pr @returns {string | null}
 */
export function reviewableHead(pr) {
  const onHead = newestPerName(pr?.statusCheckRollup);
  if (checksSettledGreen(onHead) !== true && !redOnlyFromAnyHold(pr, onHead)) return null;
  return String(pr.headRefOid ?? "") || null;
}

/**
 * #3045: THE PATCH ID OF ONE HEAD -- what the pull request changes relative to its base, hashed -- or `null` when the read was refused.
 *
 * THE COMPARE API'S DIFF, `base...head`, because that is `merge-base(base, head)..head` and the gate holds no checkout. Reading it
 * as a diff (not the JSON's per-file `patch`) is what keeps a large change whole: the JSON truncates a file's patch silently, and a
 * truncated patch would hash two different changes to one id. A refusal -- including GitHub's own "diff too large" -- is `null`,
 * which every caller reads as "the patch is not known", never as "the patch is empty".
 *
 * `head` MAY BE AN ABBREVIATION (a verdict's `at <head8>`): the compare API resolves it.
 *
 * @param {string} head @param {string} base @param {(args: string[]) => string} run @returns {string | null}
 */
export function readPatchId(head, base, run = defaultRun) {
  try {
    return patchIdOfDiff(run(["api", "-H", "Accept: application/vnd.github.diff", `repos/${repoNow()}/compare/${base}...${head}`]));
  } catch {
    return null;
  }
}

/**
 * #3045: The shas of one pull request's commits, oldest first, or `null` when the read was refused. REST, not the list call: `commits`
 * on `gh pr list --limit 100` is refused outright by GraphQL ("requesting up to 1,000,000 possible nodes which exceeds the maximum
 * limit of 500,000", 2026-09-24), and REST returns every commit rather than the first hundred.
 *
 * @param {number} number @param {(args: string[]) => string} run @returns {string[] | null}
 */
export function readCommitShas(number, run = defaultRun) {
  try {
    const out = run(["api", `repos/${repoNow()}/pulls/${number}/commits`, "--paginate", "--jq", ".[].sha"]);
    const shas = out.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    return shas.length > 0 ? shas : null;
  } catch {
    // A REFUSED READ LEAVES THE PULL REQUEST UNENRICHED: the gate then reads the current head alone. Never an empty list, which would claim "no commits".
    return null;
  }
}

/**
 * #3045: HOW THE REVIEW QUESTION STANDS FOR A PULL REQUEST -- `"settled"` (green, so a reviewer is asked now), `"running"` (checks not
 * finished, which an update-branch causes on a head with no new work), or `null` (red or headless: not this question's). The one place
 * the two readers of it, `withPatchIds` and `draftOrder`, can agree. The `awaiting-evidence` label is NOT read here: `draftOrder` still
 * reads a verdict somebody posted on a labelled pull request, and only `withPatchIds` declines to spend calls on one.
 *
 * @param {any} pr @returns {"settled" | "running" | null}
 */
export function reviewWait(pr) {
  if (!pr?.headRefOid) return null;
  if (reviewableHead(pr)) return "settled";
  return checksSettledGreen(newestPerName(pr?.statusCheckRollup)) === null ? "running" : null;
}

/**
 * #3045: THE PULL REQUESTS, each with `patchIds` (oid -> patch id) WHERE THE REVIEW QUESTION NEEDS THEM, so a verdict, a review and a
 * refusal can stand for the PATCH rather than for the head they were posted at. Everything else is returned untouched, so a red or
 * labelled pull request pays no call.
 *
 * A `"settled"` pull request is read at its head and at every older head a review or verdict names (`evidenceHeads`). A `"running"`
 * one is read at its head and its PREDECESSOR only: the question is whether the checks now running are for a head that adds nothing
 * (an update-branch), and if so `draftOrder` keeps the order it already had instead of dropping it for the minutes CI takes -- which
 * is what wrote a `RESET` and re-armed the order after each of #3033's four merges. A refused read leaves a pull request unenriched.
 *
 * @param {any[]} prs @param {(args: string[]) => string} [run]
 */
export function withPatchIds(prs, run = defaultRun) {
  return prs.map((pr) => {
    const wait = awaitingEvidence(pr) ? null : reviewWait(pr);
    if (wait === null) return pr;
    const base = String(pr.baseRefName ?? "main");
    const head = String(pr.headRefOid);
    const others = wait === "settled" ? evidenceHeads(pr) : predecessorOf(pr, run);
    const entries = [head, ...others].map((oid) => /** @type {const} */ ([oid, readPatchId(oid, base, run)]));
    const known = entries.filter(([, id]) => id !== null);
    return known.length > 0 ? withFailingChecks({ ...pr, patchIds: Object.fromEntries(known) }, run) : pr;
  });
}

/**
 * a11ign#3199: THE NAMES OF THE CHECK RUNS THAT CONCLUDED `failure` AT ONE COMMIT, or `null` when the read was refused. `[]` is a real answer
 * (nothing failed there) and `null` is "not known": a refusal is never read as green, because a refusal lifted on an unread check would
 * hand a refused pull request back to a reviewer on a guess.
 *
 * `commit` MAY BE AN ABBREVIATION (a verdict's `at <head8>`): the commits endpoint resolves it, as the compare API does.
 *
 * @param {string} commit @param {(args: string[]) => string} run @returns {string[] | null}
 */
export function readFailingChecks(commit, run = defaultRun) {
  try {
    const out = run(["api", `repos/${repoNow()}/commits/${commit}/check-runs?per_page=100`, "--paginate",
      "--jq", '.check_runs[] | select(.conclusion == "failure") | .name']);
    return [...new Set(out.split("\n").map((l) => l.trim()).filter((l) => l !== ""))];
  } catch {
    return null;
  }
}

/**
 * a11ign#3199: A PULL REQUEST WITH `failingChecks` (oid -> names of the check runs that concluded `failure` there) FOR THE ONE QUESTION THAT NEEDS
 * THEM: does a refusal at an older head with an equal patch still apply (`refusalLifted`, the decider the door asks too)? Only a pull request
 * with such a refusal pays anything, and then one read per commit compared: each refusal head, and the current head only when one of those
 * had a failure, since a refusal at an all-green commit is the #3033 shape and stays standing whatever the head looks like. A refused read
 * leaves the commit out, and absent is not green.
 *
 * @param {any} pr @param {(args: string[]) => string} run
 */
function withFailingChecks(pr, run) {
  const refused = refusalHeads(pr);
  if (refused.length === 0) return pr;
  /** @type {Record<string, string[]>} */
  const failing = {};
  for (const oid of refused) {
    const names = readFailingChecks(oid, run);
    if (names !== null) failing[oid] = names;
  }
  const head = String(pr.headRefOid);
  const now = Object.keys(failing).length > 0 && Object.values(failing).some((names) => names.length > 0) ? readFailingChecks(head, run) : null;
  if (now !== null) failing[head] = now;
  return Object.keys(failing).length > 0 ? { ...pr, failingChecks: failing } : pr;
}

/**
 * The commit before a pull request's head, as a one-element list, or none when the commits could not be read or do not end at the
 * head (a push landed between the list and the commits).
 * @param {any} pr @param {(args: string[]) => string} run @returns {string[]}
 */
function predecessorOf(pr, run) {
  const shas = readCommitShas(Number(pr.number), run);
  return shas && shas.length >= 2 && shas[shas.length - 1] === String(pr.headRefOid) ? [shas[shas.length - 2]] : [];
}

/** #2416: the PR label meaning "my done-when needs an external run, and the evidence is not posted yet". */
export const AWAITING_EVIDENCE_LABEL = "awaiting-evidence";

/** #2416: how long a PR may carry the label with nobody saying what it waits on before `product-manager` is asked. */
export const AWAITING_EVIDENCE_QUIET_HOURS = 48;
export const AWAITING_EVIDENCE_QUIET_MS = AWAITING_EVIDENCE_QUIET_HOURS * HOUR_MS;

/** @param {any} pr */
export function awaitingEvidence(pr) {
  return labelsOf(pr).includes(AWAITING_EVIDENCE_LABEL);
}

/**
 * When the label was LAST applied to this pull request (ISO string), or `null` when it could not be read.
 *
 * THE EVENTS LIST, NOT THE TIMELINE: `issues/{n}/events` answers "when was this label applied" with a
 * `created_at` on each `labeled` event and is a strict subset of the timeline, so it is the cheaper of the two
 * reads that can answer it. THE LAST `labeled` EVENT, because a label removed (the evidence posted) and
 * applied again is a new wait. `null` is refused-or-never-applied, and neither becomes an order: an order
 * naming a PR whose label age is unknown would be a claim the gate never measured.
 *
 * @param {number} number @param {(args: string[]) => string} run @returns {string | null}
 */
export function readEvidenceLabelledAt(number, run = defaultRun) {
  try {
    const out = run(["api", `repos/${repoNow()}/issues/${number}/events`, "--paginate", "--jq",
      `.[] | select(.event == "labeled" and .label.name == "${AWAITING_EVIDENCE_LABEL}") | .created_at`]);
    const applied = out.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    return applied.length > 0 ? applied[applied.length - 1] : null;
  } catch {
    return null;
  }
}

/**
 * The pull requests, each one carrying the label with `awaitingSince` attached. A queue where nothing carries the
 * label pays NO call, and a labelled one pays one per labelled pull request -- the condition is answered from
 * the list already in hand, which is what makes the read affordable on every tick.
 *
 * @param {any[]} prs @param {(args: string[]) => string} [run]
 */
export function withEvidenceLabelAges(prs, run = defaultRun) {
  return prs.map((pr) => {
    if (!awaitingEvidence(pr)) return pr;
    const awaitingSince = readEvidenceLabelledAt(Number(pr.number), run);
    return awaitingSince ? { ...pr, awaitingSince } : pr;
  });
}

/**
 * `{ branch -> stamped session }` for every worktree on this host, from ONE local `git worktree list --porcelain` and a file read
 * per stamped tree. `null` when git refused: a refused read names nobody, which is a fall to `ceo`, never a guess. Spends no pool.
 *
 * @param {(cmd: string, args: string[]) => string} [run] @param {typeof worktreeOwner} [owner]
 * @returns {Map<string, string> | null}
 */
export function readWorktreeStamps(run = defaultSpawn, owner = worktreeOwner) {
  try {
    const stamps = new Map();
    for (const block of run("git", [...PROJECT_GIT, "worktree", "list", "--porcelain"]).split(/\n\s*\n/)) {
      const path = /^worktree (.+)$/m.exec(block)?.[1];
      const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
      const stamped = path && branch ? owner(path) : null;
      if (stamped) stamps.set(branch, stamped);
    }
    return stamps;
  } catch {
    return null;
  }
}

/**
 * The lazy, once-per-tick stamp lookup `withNamedOwners` takes: the first call reads the host, every later one reuses it.
 * @param {() => Map<string, string> | null} [read]
 * @returns {(branch: string) => string | null}
 */
export function stampLookup(read = readWorktreeStamps) {
  /** @type {Map<string, string> | null | undefined} */
  let stamps;
  return (branch) => {
    if (stamps === undefined) stamps = read();
    return stamps?.get(branch) ?? null;
  };
}

/**
 * THE `priority` LABEL ORDERS OFFERS, AND DOES NOT GRANT (#2296). `ceo` created it 2026-09-24 as "offer this
 * row before others"; nothing read it, so a priority row waited its turn by row number like any other.
 * Labelled rows go AHEAD of the rest and this runs BEFORE the per-tick slice, or a high-numbered priority
 * row would be cut by the very cap it exists to beat. A row `partitionUnclaimed` shelved never reaches
 * here, so the label cannot walk a row past B4 or a claim label.
 *
 * OLDEST FIRST WITHIN EACH GROUP, because a queue that hands out its newest rows first starves its oldest --
 * and the number is a row number, so ascending IS oldest. Hand assignment stays the fallback.
 *
 * @param {any[]} unclaimed
 */
function offerOrder(unclaimed) {
  const isPriority = (/** @type {any} */ row) => labelsOf(row).includes(PRIORITY_LABEL);
  return [...unclaimed].sort((a, b) =>
    Number(isPriority(b)) - Number(isPriority(a)) || Number(a.number) - Number(b.number));
}

/**
 * How a Ready row is CLAIMED, in words. The primary project's is exactly the sentence it always was.
 *
 * A row in another tracker is NOT claimable with a bare number: `row-claim.mjs claim 7` reads row 7 of the PRIMARY's tracker, so an
 * engineer that ran it for `agent-org#7` would claim the wrong row. The claim-side readers of a non-primary key are child 3b (#2617),
 * and until they exist this says so rather than handing over a command that does the wrong thing. The NAMES the claim must produce are
 * ADR 0040 decision 2's, and are given here so 3b's command and this order cannot disagree about them.
 * @param {{ number: number, repoKey?: string, repo?: string }} row
 */
function claimSentence(row) {
  if (row.repoKey === undefined || row.repoKey === "") {
    return "Claim it with "
      + `\`node packages/agent-org/src/row-claim.mjs claim ${row.number} --session=<you> `
      + `--branch=agent/<slug>-${row.number} --worktree=../wt-${row.number}\` and build it there.`;
  }
  return `It is row ${row.number} of \`${row.repo}\` (key \`${row.repoKey}\`), and \`row-claim.mjs claim ${row.number}\` would claim the PRIMARY's row ${row.number}, `
    + "so do NOT run it: the claim for a non-primary tracker is child 3b (#2617) of #69. When it exists the names are "
    + `\`agent/<slug>-${row.repoKey}-${row.number}\`, \`../wt-${row.repoKey}-${row.number}\` and \`${SESSION_PREFIX}<you>\`.`;
}

/**
 * One order per unclaimed Ready row, priority rows first then oldest first, capped.
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
  for (const row of offerOrder(unclaimed).slice(0, MAX_ROW_ORDERS_PER_TICK)) {
    // NO SESSION NAMED. Which engineer takes it depends on who is idle RIGHT NOW, which only
    // `herdr agent list` knows -- so the order names the lane and `wake.mjs` picks the body.
    // ROUTED BY LANE. Every ready row went to `engineers` regardless of its lane, so a `lane:ceo` row
    // would have been offered to an engineer who may not act on it -- and 18 of the 49 open rows carry
    // that lane. `lane:any` and no lane are the pool, which is what "engineers" means here.
    const owner = laneOwnerOf(row);
    orders.push({
      session: owner ?? "engineers",
      cause: "ready-row-unclaimed",
      subject: `row-${subjectRef(row.repoKey, row.number)}`,
      // The spawner names the branch and the instance's first message from it (#2405).
      title: row.title ?? "",
      // THE ROW IS THE DISCRIMINATOR NOW, not the queue depth. Keyed on the count, every claim rewrote
      // every remaining order's key and re-woke someone for rows already being offered.
      discriminator: subjectRef(row.repoKey, row.number),
      prompt: `Ready row ${subjectMention(row)} is unclaimed${row.title ? `: ${row.title}` : ""}. ${claimSentence(row)}\n`
        // BOTH FLAGS OR NEITHER, and the primary refuses the work entirely: `row-claim` creates the
        // worktree from `--branch` AND `--worktree` together and refuses when given only one, and the
        // tooling will not run from the primary checkout at all. The first engineer woken by this
        // system (2026-09-17) stopped and asked a human for both facts, because the order named
        // neither -- so they are named here rather than left to a role brief the session may not have
        // read yet. `../wt-<n>` is the sibling convention every live worktree on the host follows.
        // THE LAUNCH DIRECTORY IS NAMED, AND IT IS NOT THE PRIMARY (#2237) -- BUT NAMED AT DELIVERY, NOT HERE (#2405).
        // This sentence named `/home/agent/repos/role-<you>` for nine days after `launchGate` (#1352) began
        // refusing the primary, and `role-<you>` did not exist for six of the eight engineer addresses; the
        // fallback it offered instead (whichever linked worktree `git worktree list` named) let an engineer BORROW one a peer was working in.
        // The gate cannot know who takes a pool order, and so cannot know whether that address has a
        // worktree, so `wake.mjs` fills `LAUNCH_PLACEHOLDER` in when it knows the recipient (`addressed`).
        + `The claim creates that worktree for you. ${LAUNCH_PLACEHOLDER}\n`
        + "If the claim is refused because someone took it first, that is an answer: stop and say so.",
      causeKey: `${owner ?? "engineers"}/ready-row-unclaimed/${subjectRef(row.repoKey, row.number)}`,
    });
  }

  return orders;
}

// --- #2845: A READY ROW THE CLAIM REFUSES, TICK AFTER TICK -------------------------------------------------------------------
//
// MEASURED 2026-10-01 from `a11ign-work-tick.service`'s journal: #2824 was offered every tick for 7.5 hours and refused at the
// claim every time (`--worktree=../wt-2824 ALREADY EXISTS`) -- 211 `UNDELIVERED` lines, and `product-manager` was never
// woken, because `ready-queue-empty` fires only on an EMPTY pool and the pool held that one row. A refusal that only logs
// is read by nobody. THE GATE CANNOT SEE THE SPAWNER'S REFUSAL (a derived cause is not in the ledger and `wake.mjs` prints
// it to stderr), so it asks the claim's own question itself and keeps its own streak: not a new "everyone is idle" probe, which
// would have fired on a legitimately empty org too.

/**
 * N, THE TICKS A REFUSAL MUST REPEAT BEFORE IT IS REPORTED: 15, which is about 30 minutes at the tick's 2-minute cadence (the
 * 211 lines over 7.5 hours above are ~28 a tick-hour). Long enough that the ordinary transient -- a claim that has just
 * been declined and whose tree is on its way out, a release whose kept tree is about to be adopted -- clears first; short
 * enough that a stuck row costs half an hour rather than the 7.5 it did.
 */
export const UNCLAIMABLE_AFTER_TICKS = 15;

/** The streak memory, beside `claim-stalls.json` and the wake ledger: `{ "<row>": { reason, ticks } }`. */
export const CLAIM_REFUSALS_FILE = "claim-refusals.json";

/**
 * The refusal the claim would give this row for a reason that does NOT depend on who claims: its target worktree already
 * exists. The words are `row-claim.mjs`'s `worktreeTargetReason`, which this file cannot import (`row-claim` imports
 * `wake`, which imports this), so a test pins the two to the same text. WHAT IT DOES NOT PREDICT: the exact-branch and
 * origin-branch refusals (the second is `rowBranchOrders`' already) -- a row refused for one of those is not reported
 * here, and says so by being offered without ever being reported.
 *
 * A TREE A RELEASE KEPT FOR THIS ROW IS NOT A REFUSAL: the spawner adopts it (`--adopt`, #2470), so the claim lands.
 *
 * @param {{ number: number }} row
 * @param {{ worktreesDir: string, kept?: Record<string, { worktree?: string }>, exists?: (path: string) => boolean,
 *   owner?: typeof worktreeOwner }} deps
 * @returns {string | null}
 */
export function claimRefusalOf(row, { worktreesDir, kept = {}, exists = existsSync, owner = worktreeOwner }) {
  const keptTree = kept[String(row.number)]?.worktree;
  if (keptTree !== undefined && exists(keptTree)) return null;
  const path = join(worktreesDir, `wt-${row.number}`);
  if (!exists(path)) return null;
  const who = owner(path);
  return `--worktree=../wt-${row.number} ALREADY EXISTS, ${who ? `stamped by \`${who}\`` : "UNSTAMPED (nobody recorded an owner, which is not the same as free)"}. `
    + "Refusing before any write: a claim that went on would act inside a tree it did not create.";
}

/**
 * The streaks after one more tick. KEYED ON THE ROW AND THE REFUSAL TEXT: the same refusal extends the streak, a CHANGED
 * one starts it again at 1, and a row with no refusal this tick (claimed, withdrawn, or its tree gone) is simply not carried.
 * @param {Record<string, { reason: string, ticks: number }>} before
 * @param {Record<string, string | null>} readings row -> this tick's refusal, or `null` for none
 * @returns {Record<string, { reason: string, ticks: number }>}
 */
export function nextRefusalStreaks(before, readings) {
  /** @type {Record<string, { reason: string, ticks: number }>} */
  const after = {};
  for (const [row, reason] of Object.entries(readings)) {
    if (reason === null) continue;
    after[row] = { reason, ticks: before[row]?.reason === reason ? before[row].ticks + 1 : 1 };
  }
  return after;
}

/**
 * THE WHOLE OF THIS CAUSE'S MEMORY FOR ONE TICK: read each offered row's refusal, advance the streaks on disk, and return them.
 * NEVER THROWS, and says so on stderr: a broken detector must not stop the orders behind it, and it returns NO streaks rather
 * than stale ones, so nothing is reported on a tick that could not be read.
 * @param {any[]} offerable the rows `partitionUnclaimed` judged offerable this tick
 * @param {{ stateDir?: string, worktreesDir?: string, log?: (line: string) => void, exists?: (path: string) => boolean,
 *   owner?: typeof worktreeOwner }} [host] every one a seam
 * @returns {Record<string, { reason: string, ticks: number }>}
 */
export function claimRefusalStreaksNow(offerable, { stateDir = REVIEWER_STATE_DIR, worktreesDir = dirname(REPO_CHECKOUT),
  log = (line) => process.stderr.write(line), ...seams } = {}) {
  try {
    const path = `${stateDir}/${CLAIM_REFUSALS_FILE}`;
    const before = readJsonObject(path);
    const kept = readJsonObject(`${stateDir}/${KEPT_CLAIMS_FILE}`);
    /** @type {Record<string, string | null>} */
    const readings = {};
    for (const row of offerable) readings[subjectRef(row.repoKey, row.number)] = claimRefusalOf(row, { worktreesDir, kept, ...seams });
    const after = nextRefusalStreaks(before, readings);
    if (JSON.stringify(after) !== JSON.stringify(before)) writeJsonObject(path, after);
    return after;
  } catch (/** @type {any} */ err) {
    log(`claim-refusals: could not run (${String(err?.message ?? err).split("\n")[0]}) -- no ready-row-unclaimable order this tick.\n`);
    return {};
  }
}

/**
 * `claimRefusalStreaksNow` over the rows `decide` will OFFER -- the same `partitionUnclaimed` reading, so the streaks advance on
 * those rows and on no others (a row shelved for B4 or a branch on `origin` is not being refused by the claim, it is not offered).
 * @param {Parameters<typeof partitionUnclaimed>[0]} rows @param {Parameters<typeof partitionUnclaimed>[1]} prFiles
 * @param {Parameters<typeof partitionUnclaimed>[2]} options
 */
function offeredRefusalStreaks(rows, prFiles, options) {
  return claimRefusalStreaksNow(partitionUnclaimed(rows, prFiles, options).offerable);
}

/**
 * One order to `product-manager` per offered row whose claim has been refused `UNCLAIMABLE_AFTER_TICKS` ticks running, QUOTING
 * the refusal. THE DISCRIMINATOR CARRIES THE REFUSAL'S DIGEST, which is what `emptyShelfOrder`'s count is for it: the order
 * stops repeating while the answer is unchanged, and a refusal that changes (a different owner stamped the tree) is a new
 * question and re-fires. It stops altogether when the row is claimed or leaves the shelf, because `offerable` no longer holds it.
 * `streaks` ABSENT MEANS NOT ASKED and carries no default here, for `rowBranches`'s reason: `decide` sits on its complexity limit.
 *
 * @param {any[]} offerable @param {Record<string, { reason: string, ticks: number }> | undefined} streaks
 * @returns {{session: string, cause: string, subject: string, discriminator: string, prompt: string, causeKey: string}[]}
 */
export function unclaimableRowOrders(offerable, streaks) {
  return offerable.flatMap((row) => {
    const ref = subjectRef(row.repoKey, row.number);
    const seen = streaks?.[ref];
    if (seen === undefined || seen.ticks < UNCLAIMABLE_AFTER_TICKS) return [];
    const discriminator = `${ref}-${digestOf(seen.reason)}`;
    return [{
      session: "product-manager",
      cause: "ready-row-unclaimable",
      subject: `row-${ref}`,
      discriminator,
      prompt: `Ready row ${subjectMention(row)} CANNOT BE CLAIMED: the gate has offered it to the engineers and the claim has `
        + `refused it on ${seen.ticks} consecutive ticks. The refusal, quoted:\n\n> ${seen.reason}\n\n`
        + "Nobody can act on this but whoever stocks the queue, and nothing else will tell you: an offer the claim refuses is "
        + "logged and retried, and `ready-queue-empty` stays silent while the row sits in the pool.\n"
        + "Find out whose tree it is (`pnpm run worktree:whose <path>`) and whether that session still holds the row. A "
        + "live holder whose row lost its claim label needs the label back; a leftover tree whose work is merged and clean "
        + "goes with `pnpm run worktrees:prune` (never `rm -rf`), which names and leaves any dirty one; a tree with unpushed "
        + "work is that session's to finish. If none of that fits, take the row off the shelf (`" + BLOCKED_LABEL + "`, with what would "
        + "clear it) so the engineers stop being offered it.",
      causeKey: `product-manager/ready-row-unclaimable/${discriminator}`,
    }];
  }).slice(0, MAX_ROW_ORDERS_PER_TICK);
}

/**
 * A READY ROW WHOSE WORK IS ALREADY ON `origin`, SAID OUT LOUD -- #2031.
 *
 * #2014 bought the interception at CLAIM time: a session that tries to claim such a row is refused and
 * told where the work is. IT SAYS NOTHING TO ANYONE WHO NEVER ATTEMPTS A CLAIM, and this gate -- which is
 * what actually offers rows to the org -- was one of those readers. Measured 2026-09-22 on #2000: the
 * branch was pushed at 21:02:36Z, the row read `ready` with no `session:` label until 21:22Z, and
 * `gh pr list --head <branch> --state all` returned `[]` throughout. The gate offered it as
 * `ready-row-unclaimed` every two minutes, because `ready` with no `session:` label was the entire
 * question it asked.
 *
 * IT NAMES THE BRANCH AND ITS SHA AND CONCLUDES NOTHING ELSE. A branch on `origin` whose name ends in
 * this row's number means the work EXISTS; it cannot tell finished work from abandoned work, and #2031's
 * own "what this will NOT fix" says so rather than leaving it implied. So the prompt sends the reader to
 * the branch with two commands that spend no pool, and names the three exits rather than asserting one.
 *
 * ROUTED TO THE LANE OWNER, ELSE `product-manager`. This is a QUEUE-STATE fact -- a row the board
 * advertises as startable that is not -- and `product-manager` is this org's first reader for rows, the
 * queue and holds (the chairman's 2026-09-14 routing direction). It is deliberately NOT routed to
 * `engineers`: the pool's answer to a row is to CLAIM it, which is the one action #2014 already refuses.
 *
 * A JUDGMENT CAUSE (`JUDGMENT_CAUSES`), because its answer is durable. "This branch is abandoned, leave
 * it" does not change the row, the branch or the sha, so an ACTION cause's twenty-minute expiry would
 * re-offer the identical question until the STUCK cap stopped it -- the cost `lane-backlog-unpromoted`
 * paid on #1564. The key carries the sha, so a PUSH to that branch is a new question and reaches the
 * owner immediately.
 *
 * @param {any[]} readyRows the `ready` rows (`readReadyRows`)
 * @param {{ branch: string, head: string, row: number }[] | null} [rowBranches]
 *        `readRowBranches`'s answer. `null` (the default) is "not asked or refused" and emits NOTHING:
 *        a tick that could not reach `origin` must not invent this condition, and must not report a
 *        false all-clear either -- it simply says nothing new, which is what it did before #2031.
 * @param {{ number: number, headRefName?: string, labels?: any[] }[]} [openPrs] the open pull requests the tick already
 *        read (#3010). A branch one of them is on is NOT unshipped, so its order names the PR and `--adopt` instead of
 *        advising "open its pull request". Absent is none, and the order is exactly what #2031 wrote.
 * @returns {{session: string, cause: string, subject: string, discriminator: string,
 *            prompt: string, causeKey: string}[]}
 */
export function rowBranchOrders(readyRows, rowBranches = null, openPrs = []) {
  if (!Array.isArray(rowBranches)) return [];
  const byRow = branchIndex(rowBranches);
  const orders = [];
  // OLDEST FIRST AND CAPPED, `rowOrders`'s shape: a queue that hands out its newest rows first starves
  // its oldest, and the number is a row number, so ascending IS oldest.
  const oldestFirst = [...readyRows].sort((a, b) => Number(a.number) - Number(b.number));
  for (const row of oldestFirst) {
    // UNCLAIMED IS THE POPULATION, and `session:` is the label the done-when names. A claimed row
    // already has a session that knows about its own branch, and `claimed-row-amended` is the cause
    // that speaks to a holder. `CLAIM_LABEL` goes with it because the two are written together by
    // `row-claim.mjs` and a row carrying either is not a fresh start.
    if (sessionOf(row) || labelsOf(row).includes(CLAIM_LABEL)) continue;
    const pushed = byRow.get(Number(row.number)) ?? [];
    if (pushed.length === 0) continue;
    orders.push(unshippedOrder({ row, pushed, openPr: openPrOnBranch(pushed, openPrs) }));
    if (orders.length >= MAX_ROW_ORDERS_PER_TICK) break;
  }
  return orders;
}

/**
 * #3010: THE OPEN PULL REQUEST, IF ANY, THAT ONE OF THESE BRANCHES IS ON. Read off the `pr list` the tick already made,
 * so it spends no pool -- `readRowBranches` is API-free on purpose and a per-row `gh pr list --head` would undo that.
 * @param {{ branch: string, head: string }[]} pushed
 * @param {{ number: number, headRefName?: string, labels?: any[] }[] | null | undefined} openPrs
 * @returns {{ number: number, branch: string, holder: string | null } | null}
 */
function openPrOnBranch(pushed, openPrs) {
  for (const pr of Array.isArray(openPrs) ? openPrs : []) {
    const found = pushed.find(({ branch }) => branch === pr.headRefName);
    if (found) return { number: pr.number, branch: found.branch, holder: sessionOf(pr) };
  }
  return null;
}

/**
 * The order itself, split out so `rowBranchOrders` stays a walk over rows (the Stepdown Rule, and the
 * same seam `claimedRowAmendedOrders`/`amendedOrder` already use).
 *
 * INCIDENT BEHIND THE ORDER'S TEXT (moved out of it, #3444: the agent reading the order cannot use it):
 * measured 2026-09-22 on #2000: its branch sat pushed for 20 minutes while the row read `ready`, and a second session was routed into the
 * same three Region paths.
 *
 * @param {{ row: any, pushed: { branch: string, head: string }[], openPr: { number: number, branch: string, holder: string | null } | null }} found
 */
function unshippedOrder({ row, pushed, openPr }) {
  const owner = laneOwnerOf(row) ?? "product-manager";
  // THE PR IS PART OF THE KEY: an order already spent for the bare branch must not suppress the one that says a PR exists.
  const key = pushed.map(({ branch, head }) => `${branch}@${head}`).sort().join("+") + (openPr ? `#pr${openPr.number}` : "");
  const first = pushed[0].branch;
  return {
    session: owner,
    cause: "row-branch-unshipped",
    subject: `row-${subjectRef(row.repoKey, row.number)}`,
    discriminator: key,
    prompt: `Row ${subjectMention(row)} reads \`${READY_LABEL}\` and unclaimed, but ${branchesText(pushed)}.\n`
      + "THE BOARD IS SAYING SOMETHING THAT IS NOT TRUE, and until this is settled the gate has STOPPED "
      + `offering ${subjectMention(row)} as a fresh start -- so nobody will be routed into work that may already exist.\n`
      + (openPr ? openPrSentence({ row, openPr }) : unpushedSentence(first))
      + "IF IT NEEDS A WAIT INSTEAD, that goes in a FIELD and not a comment: `Not-before: YYYY-MM-DD` in "
      + `the body, \`gh issue edit ${row.number} --add-blocked-by <n>\`, or \`${ANSWER_PREFIX}<session>\`. `
      + "Each clears itself.",
    causeKey: `${owner}/row-branch-unshipped/row-${subjectRef(row.repoKey, row.number)}/${key}`,
  };
}

/** The #2031 body of the order, for a branch with NO pull request: read it, then one of three exits. @param {string} first */
function unpushedSentence(first) {
  return "READ THE BRANCH FIRST. Both of these spend NO API pool: "
    + `\`git fetch origin && git log --oneline origin/main..origin/${first}\` and `
    + `\`git diff origin/main...origin/${first}\`.\n`
    + "THEN ONE OF THREE, and this gate deliberately does not guess which: if the work is FINISHED, "
    + "open its pull request (that is the act that makes the row look claimed, and it is what was "
    + "missing); if it is ABANDONED, delete the branch on `origin` and the row goes back on offer "
    + "unchanged; if the trailing number is a COINCIDENCE rather than this row's work, rename or "
    + "delete that branch -- the match is on the name, which is all `ls-remote` can see.\n";
}

/**
 * #3010: the body of the order when the branch ALREADY HAS an open pull request. "Open its pull request" is wrong advice
 * there and "delete the branch" is worse -- it closes the PR. Measured on #2981: PR #2987 was open for 4h while the row
 * was re-offered the three exits above, and the only way to finish it, `claim --adopt`, was named nowhere.
 * `claim`'s own refusal (#2014) is unchanged: it still refuses a row whose branch is on `origin`, and `--adopt` is the exit it leaves.
 * @param {{ row: any, openPr: { number: number, branch: string, holder: string | null } }} found
 */
function openPrSentence({ row, openPr }) {
  const holder = openPr.holder ?? `<the session on the PR's \`${SESSION_PREFIX}\` label>`;
  return `THE WORK IS NOT UNSHIPPED: \`${openPr.branch}\` already has OPEN pull request #${openPr.number}. `
    + "DO NOT delete the branch (that closes the PR) and do not open another.\n"
    + `TO FINISH IT, take the previous holder's worktree in place, from inside it: \`pnpm run row-claim claim ${row.number} `
    + `--session=<you> --branch=${openPr.branch} --worktree=<that worktree> --adopt=${holder}\`. `
    + "A plain claim is refused for as long as the branch is on `origin` (#2014), and that refusal is right: `--adopt` is the one "
    + "claim that resumes a tree and its pull request rather than starting over.\n";
}

/**
 * One order per unclaimed Ready row whose body lacks a required template section (#2791) -- the SPOKEN half of
 * what `partitionUnclaimed` withholds, so a shelved row is never a silent one.
 *
 * THE ROW IS THE STATE. The key carries the missing sections, so the order stops the moment the section is
 * added and a second one appears if a different section is later removed. Routed to the lane owner, else
 * `product-manager`, who owns filing, amendments and promotion: the remedy is one `## <Field>` heading
 * with real content under it, and the claim refuses until it exists.
 *
 * A JUDGMENT CAUSE for `row-branch-unshipped`'s reason -- the answer is durable, so an action cause's expiry
 * would re-ask an unchanged row.
 *
 * INCIDENT BEHIND THE ORDER'S TEXT (moved out of it, #3444: the agent reading the order cannot use it):
 * measured 2026-09-30 on #2729 and #2730: both sat `ready` for ~38h behind exactly that refusal while the queue read as stocked and
 * `ready-queue-empty` never fired.
 *
 * @param {any[]} readyRows the `ready` rows (`readReadyRows`)
 * @returns {{session: string, cause: string, subject: string, discriminator: string,
 *            prompt: string, causeKey: string}[]}
 */
export function incompleteRowOrders(readyRows) {
  const orders = [];
  const oldestFirst = [...readyRows].sort((a, b) => Number(a.number) - Number(b.number));
  for (const row of oldestFirst) {
    if (sessionOf(row) || labelsOf(row).includes(CLAIM_LABEL)) continue;
    const missing = missingFieldsOf(row);
    if (missing.length === 0) continue;
    const owner = laneOwnerOf(row) ?? "product-manager";
    const subject = `row-${subjectRef(row.repoKey, row.number)}`;
    orders.push({
      session: owner,
      cause: "ready-row-incomplete",
      subject,
      discriminator: missing.join("+"),
      prompt: `Row ${subjectMention(row)} reads \`${READY_LABEL}\` and unclaimed, but ${templateGapText(missing)}, `
        + "so `row-claim` REFUSES every claim on it (`NOT CLAIMED: ... is missing <section>`). The gate has "
        + "STOPPED offering it and no longer counts it as Ready stock, so a row stuck behind this "
        + "refusal cannot make the queue read as stocked.\n"
        + "ADD THE SECTION, or take the label off: a `## <Field>` heading with real content under it "
        + "(`Region`, `Acceptance`, `Open-check`). This order stops by itself once the body is complete.",
      causeKey: `${owner}/ready-row-incomplete/${subject}/${missing.join("+")}`,
    });
    if (orders.length >= MAX_ROW_ORDERS_PER_TICK) break;
  }
  return orders;
}

/**
 * The open pull requests that declare a `Closes` number and that GitHub resolved NOTHING for -- but only while that is
 * REPO-WIDE, by `isRepoWideResolutionFault`'s own three-sibling rule (#2823). `[]` when the condition does not hold,
 * and a PR whose `closingIssuesReferences` was not read (a fixture, a refused field) is neither declared-and-unresolved
 * nor a sibling: an absent field is "not asked", never "resolved nothing".
 * @param {any[] | null} prs @returns {any[]}
 */
export function closesUnresolvedPrs(prs) {
  const candidates = (prs ?? [])
    .filter((pr) => Array.isArray(pr.closingIssuesReferences) && typeof pr.body === "string")
    .map((pr) => ({ pr, declaration: extractClosesDeclaration(pr.body) }))
    .flatMap(({ pr, declaration }) => declaration.kind === "closes" && declaration.numbers.length > 0
      ? [{ pr, declared: declaration.numbers,
        resolved: pr.closingIssuesReferences.map((/** @type {{number: number}} */ issue) => Number(issue.number)) }]
      : []);
  const newestFirst = [...candidates].sort((a, b) => Number(b.pr.number) - Number(a.pr.number));
  const asLookup = newestFirst.map(({ pr, resolved }) => ({ number: Number(pr.number), body: pr.body, resolved }));
  const held = newestFirst.filter(({ pr, declared, resolved }) =>
    isRepoWideResolutionFault({ declared, resolved }, recentClosesSiblings(asLookup, Number(pr.number))));
  return held.map(({ pr }) => pr).sort((a, b) => Number(a.number) - Number(b.number));
}

/** @param {number} ms @returns {string} */
const standingText = (ms) => (ms >= 2 * 3_600_000 ? `${Math.floor(ms / 3_600_000)}h` : `${Math.max(1, Math.round(ms / 60_000))} min`);

/**
 * ONE order, to `product-manager`, while GitHub resolves no closing reference for the open pull requests that declare one
 * (#2823). `closes-mismatch-check.mjs` used to print "Tell `product-manager`" into a CI log for this and nothing reads a
 * CI log for an instruction: all 8 open PRs failed `gate` for ~2h on 2026-09-30 before the chairman noticed idle agents.
 * It now PASSES with a warning (#2822), which is quieter still, so the gate says it. NOT `pr-checks-failing`: that tells an
 * AUTHOR to fix a branch, and this fault is on no branch.
 *
 * KEYED ON THE SET OF PULL REQUESTS, so it is asked once per condition and stops the moment a PR resolves (the rule then
 * no longer holds). JUDGMENT: the answer is durable, and an action cause's expiry would re-ask an unchanged set.
 *
 * @param {any[] | null} prs
 * @param {number} [now]
 * @returns {{session: string, cause: string, subject: string, discriminator: string,
 *            prompt: string, causeKey: string}[]}
 */
export function closesUnresolvedOrders(prs, now = Date.now()) {
  const held = closesUnresolvedPrs(prs);
  if (held.length === 0) return [];
  const numbers = held.map((pr) => Number(pr.number)).sort((a, b) => a - b);
  const oldestMs = Math.min(...held.map((pr) => Date.parse(pr.createdAt)).filter((t) => Number.isFinite(t)));
  const standing = Number.isFinite(oldestMs) ? `, the oldest open ${standingText(now - oldestMs)}` : "";
  const discriminator = numbers.join("+");
  return [{
    session: "product-manager",
    cause: "closes-unresolved-repo-wide",
    subject: "closes-resolution",
    discriminator,
    prompt: `GitHub resolves NO closing reference for ${numbers.length} open pull requests that each declare a \`Closes\` `
      + `row (${held.map((pr) => subjectMention(pr)).join(", ")}${standing}). `
      + "GitHub resolved nothing for these, nor for the three newest siblings of each, so the fault is GitHub's or the "
      + "repo's and is on no branch -- do NOT send their authors to fix a body.\n"
      + "`closes-mismatch-check.mjs` PASSES them with a warning and the post-merge closer closes the declared rows from "
      + "the body, so nothing is blocked; the reader is needed for the rest: check whether GitHub is degraded, that the "
      + "closer ran for each merge since, and file a row if it persists. This order stops by itself when any of them "
      + "resolves.",
    causeKey: `product-manager/closes-unresolved-repo-wide/${discriminator}`,
  }];
}

/** How long a promotable `backlog` row may sit with no promotion decision before `product-manager` is asked (#2848). */
export const AGED_BACKLOG_MS = 24 * 60 * 60 * 1000;

/**
 * BACKLOG ROWS OLDER THAN 24 HOURS WITH NO PROMOTION DECISION, to `product-manager` (#2848, the second question beside the
 * repeating-line one: both are a thing that stays true and that nobody reads).
 *
 * "NO DECISION" IS READ OFF THE ROW, NEVER GUESSED: `promotableRows` already dropped every row that carries a decision in a
 * FIELD -- a `blockedBy` edge, `Not-before:`, `answer:<session>`, `parked`, `needs:chairman`, and every `NOT_STARTABLE` label
 * (blocked, epic, decision, meta, ...) -- so what is left is a row somebody could promote and nobody has, and its age is
 * the time that has been true. The row's age is its `createdAt`: GitHub gives no date for when `backlog` was applied without a
 * timeline call per row, and a row demoted again by a declined claim (`was-ready`) reads old, which errs toward asking.
 *
 * ONE ORDER PER ROW AND THE SET IN EVERY PROMPT, `laneBacklogOrders`' discipline (#1799): the key follows the row, so one row's
 * answer is not re-litigated when another is filed, and a session is delivered one order per tick, so the prompt carries the
 * rest. Oldest first, capped at `MAX_ROW_ORDERS_PER_TICK`.
 *
 * @param {any[]} promotableRows
 * @param {number} [now]
 * @returns {{session: string, cause: string, subject: string, discriminator: string, prompt: string, causeKey: string}[]}
 */
export function agedBacklogOrders(promotableRows, now = Date.now()) {
  const aged = promotableRows
    .map((row) => ({ row, ageMs: now - Date.parse(row?.createdAt) }))
    .filter(({ ageMs }) => Number.isFinite(ageMs) && ageMs > AGED_BACKLOG_MS)
    .sort((a, b) => b.ageMs - a.ageMs);
  const named = aged.map(({ row, ageMs }) => `${subjectMention(row)} (${standingText(ageMs)}${row.title ? `, ${row.title}` : ""})`);
  return aged.slice(0, MAX_ROW_ORDERS_PER_TICK).map(({ row, ageMs }, i) => ({
    session: "product-manager",
    cause: "backlog-aged-unpromoted",
    subject: `row-${subjectRef(row.repoKey, row.number)}`,
    discriminator: "aged",
    prompt: `${subjectMention(row)}${row.title ? ` (${row.title})` : ""} HAS BEEN IN BACKLOG ${standingText(ageMs)} WITH NO PROMOTION DECISION. `
      + `It carries no wait -- no \`blockedBy\` edge, \`Not-before:\`, \`${ANSWER_PREFIX}<session>\`, \`${PARKED_LABEL}\` or \`${CHAIRMAN_LABEL}\` -- and no unpickable `
      + `label, so nothing says why it is not \`${READY_LABEL}\` and nothing else will ask: \`lane-backlog-unpromoted\` fires only when a lane `
      + "owner has nothing Ready, and `ready-queue-empty` only on an empty shelf.\n"
      + `PROMOTE IT, OR RECORD WHY NOT AS DATA: a \`${READY_LABEL}\` label is the promotion; a wait goes in a FIELD (\`--add-blocked-by <n>\`, `
      + `\`Not-before: YYYY-MM-DDTHH:MM:SSZ\`, \`${ANSWER_PREFIX}<session>\`), which clears itself and stops this being asked.`
      + (named.length > 1 ? `\nALSO AGED (${named.length - 1}): ${named.filter((_, j) => j !== i).slice(0, MAX_ROW_ORDERS_PER_TICK).join("; ")}.` : ""),
    causeKey: `product-manager/backlog-aged-unpromoted/row-${subjectRef(row.repoKey, row.number)}`,
  }));
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
    .map((/** @type {any} */ r) => subjectMention(r)).join(", ");
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
    subject: `row-${subjectRef(r.repoKey, r.number)}`,
    discriminator: subjectRef(r.repoKey, r.number),
    prompt: `${subjectMention(r)} is an open backlog row you own and there is NOTHING Ready among your rows.`
      + (laneOwnerOf(r) === name
        ? " It carries your lane: nobody else may promote it."
        : " It carries `fleet-gated`, which ROUTES rather than blocks -- the acceptance needs the fleet"
          + " or the lab, which you run. Check the fleet is up (`pnpm run fleet:status`) first; this row"
          + " is not waiting on hardware being broken.")
      + "\nPromote it if it is genuinely ready (a Region, an Acceptance, a done-when), answer it if it "
      + "waits on a decision, or say on the row why it should stay put -- leaving it and recording why "
      + "is a valid answer.\n"
      + "READ ITS OWN RECENT COMMENTS FIRST: a durable reason recorded there stands until something "
      + "about THIS row changes, not until an unrelated row moves (#1799).\n"
      + "RECORD THE ANSWER ON THE ROW, whatever it is. A decision that exists only in your terminal is "
      + "one the org cannot see: the next reader finds an untouched row and re-derives it from scratch.\n"
      + alsoOwned(mine, r),
    causeKey: `${name}/lane-backlog-unpromoted/row-${subjectRef(r.repoKey, r.number)}`,
  })));
}

/** The chairman reminder's grid: one window opens at each multiple of this since the epoch (the UTC day). */
export const CHAIRMAN_REMINDER_PERIOD_MS = 24 * HOUR_MS;

/**
 * PURE. The UTC day the chairman reminder is open in at `nowMs`, or `null` outside its window -- #2989.
 *
 * WHY THE KEY IS THE CALENDAR DAY AND NOT AN AGE READ OFF THE ROWS. The order used to key on
 * `daysSince(oldest updatedAt)`, and `ceo` answers it by COMMENTING on the rows, which writes `updatedAt`: the
 * age read 0 for ever, the key never moved, `wake` re-delivered it every `JUDGMENT_TTL_MS` until
 * `MAX_DELIVERIES`, and then the tick printed `STUCK ceo/chairman-blocked/0` on every run (31 ticks in an hour;
 * 89 by the time an engineer picked the row up). A discriminator derived from a field the ANSWER writes cannot
 * advance, so the cap was reached by the answerer's own diligence. The label's own time would fix that but costs
 * a timeline read per row; the grid costs nothing and is not written by anybody.
 *
 * A DAILY KEY ALONE WOULD NOT HAVE BEEN ENOUGH: `wake` re-delivers an unchanged key every two hours, so one day's
 * key reaches the cap of six in ten hours and is `STUCK` for the other fourteen. So the order is emitted only
 * inside a window exactly `PROMOTION_ASK_WINDOW_MS` (= `JUDGMENT_TTL_MS`) long at the start of each day --
 * `promotionAskWindow`'s mechanism (#2286): one delivery per window with no state kept, and the cause going
 * unemitted between windows is what lets the ledger write its `RESET`. A window whose order was never
 * delivered is retried every tick until it closes, then not until tomorrow: the stated cost.
 *
 * @param {number} nowMs @returns {{day: number} | null} `day` is whole days since the epoch
 */
export function chairmanReminderWindow(nowMs) {
  const day = Math.floor(Math.max(0, nowMs) / CHAIRMAN_REMINDER_PERIOD_MS);
  const opened = day * CHAIRMAN_REMINDER_PERIOD_MS;
  return nowMs - opened >= PROMOTION_ASK_WINDOW_MS ? null : { day };
}

/**
 * The one order for work only the chairman can do, or none.
 *
 * SPLIT OUT OF `decide` because it took that function past 90 physical lines and the pre-push gate
 * refused it -- the fourth such split, and the seam is the same each time: `decide` asks what the
 * queue needs, each helper asks one narrower question.
 *
 * @param {any[]} chairmanBlocked rows waiting on the chairman, oldest first
 * @param {number} [nowMs] injectable so a test is not wall-clock dependent
 */
function chairmanOrders(chairmanBlocked, nowMs = Date.now()) {
  // THE ORG CANNOT WAKE A HUMAN, so this wakes the session whose brief says it briefs one. `ceo` is the
  // only onward route the escalation path has, and until now that route was a sentence rather than a
  // mechanism -- #63 sat four days blocking eight publish-gated rows because nothing carried it.
  //
  // A STANDING DAILY REMINDER, keyed on the UTC day and emitted only in that day's window
  // (`chairmanReminderWindow`). Keyed on the row set it would fire once and fall silent for ever -- the
  // permanent-ledger bug again; keyed on the rows' `updatedAt` it never advanced (#2989).
  const open = chairmanBlocked.length === 0 ? null : chairmanReminderWindow(nowMs);
  if (!open) return [];
  const rows = chairmanBlocked.slice(0, 6).map((/** @type {any} */ r) => subjectMention(r)).join(", ");
  const date = new Date(open.day * CHAIRMAN_REMINDER_PERIOD_MS).toISOString().slice(0, 10);
  return [{
    session: "ceo",
    cause: "chairman-blocked",
    subject: "chairman",
    discriminator: `day-${open.day}`,
    prompt: `${chairmanBlocked.length} row(s) are labelled \`${CHAIRMAN_LABEL}\` and can only move by the `
      + `chairman's own hands: ${rows}${chairmanBlocked.length > 6 ? ", ..." : ""}.\n`
      + `This is the STANDING DAILY REMINDER for ${date} (UTC), sent once a day for as long as the label `
      + "stands: it does not say anything new happened, and it is NOT keyed on the rows' activity -- your own "
      + "comments on them do not silence or repeat it. Read each row for when the chairman was last "
      + "actually asked.\n"
      + "Brief the chairman: what is waiting, what it blocks downstream, and the single next action in "
      + "their hands. If a row no longer needs them, take the label off -- a stale one here makes the "
      + "count meaningless, which is how the last escalation went four days unread.",
    causeKey: `ceo/chairman-blocked/day-${open.day}`,
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
 * INCIDENT BEHIND THE ORDER'S TEXT (moved out of it, #3444: the agent reading the order cannot use it):
 * measured 2026-09-21: this cause's own audit examined #1731, concluded correctly that it had no Region, no Acceptance and no done-when, and
 * declined to promote it -- while the defect it describes had been fixed 17 HOURS EARLIER by #1764, with 30 sweep runs since and zero
 * failures. It was the only row between the queue and empty, and it was already done.
 *
 * @param {{ offerable: any[], blocked: { number: number, owner: string | null, reason: string }[],
 *           promotable: number, key?: string }} state `key` is the tracker's key, so two trackers' counts are two ledger keys
 */
function emptyShelfOrder({ offerable, blocked, promotable, key }) {
  const pool = offerable.filter((r) => laneOwnerOf(r) === null);
  if (pool.length > 0 || promotable === 0) return null;
  const poolBlocked = blocked.filter((b) => b.owner === null);
  const laned = offerable.length - pool.length;
  const why = [
    laned > 0 ? `${laned} unclaimed row(s) belong to a lane` : "",
    poolBlocked.length > 0
      ? `${poolBlocked.length} unlaned row(s) blocked (`
        + poolBlocked.map((b) => `${subjectMention(b)}: ${b.reason}`).join("; ")
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
    discriminator: subjectRef(key, promotable),
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
          + "date, a missing template section -- not necessarily a pull request. Promoting a row whose Region overlaps another open "
          + "PR only moves that particular refusal.\n"
        : "")
      + "ASK OF EACH ROW: IS IT STILL TRUE? -- before asking whether it is promotable. A row can fail "
      + "every promotion test and still be FINISHED, and nothing else in this org checks.\n"
      + "Promote what is genuinely ready -- a row with a Region, an Acceptance and a done-when -- and "
      + "leave the rest. This is deliberately NOT a request to reach a count: #ready:audit records "
      + "`dispatcher` labelling two rows ready to hit a floor, one disputed and one with neither field, "
      + "and a floor met by a label you control is not a measurement. Promoting nothing and saying why "
      + "is a valid answer.\n"
      + "RECORD WHAT YOU FOUND, ON THE ROWS YOU EXAMINED. An audit whose conclusion exists only in your "
      + "terminal is one the next audit must derive again from scratch -- and this one did: the 07:19Z "
      + "sweep reached a complete, well-argued verdict on #1731 and left no trace on it, so the same "
      + "reasoning was due to be repeated every two hours indefinitely.",
    causeKey: `product-manager/ready-queue-empty/${subjectRef(key, promotable)}`,
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
      + `stops it -- \`${BLOCKED_LABEL}\`, \`fleet-gated\`, \`epic\`, a lane, a claim -- and no cause can see past it.\n`
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
 * AND THE ROLE DOC ALREADY SAID SO. `.agent-org/roles/reviewer.md` line 129: "a provisional
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
      // A pull request in another repository is ready-flipped THERE: `repo` rides on the action only when it is not the primary's.
      run(["pr", "ready", String(action.pr), ...(action.repo === undefined ? [] : ["--repo", action.repo])]);
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
 * @param {{ prs: any[], readyRows: any[], promotableRows?: any[], chairmanBlocked?: any[], nowMs?: number,
 *           prFiles?: { number: number, files: string[], changedFiles: number }[],
 *           drain?: boolean, required?: string[] | null, epics?: any[], answerOwed?: any[],
 *           key?: string, repo?: string, openRows?: any[], unarmed?: number[] | null,
 *           claimedComments?: {number?: number, comments?: {body?: string, id?: string}[]}[],
 *           rowBranches?: {branch: string, head: string, row: number}[] | null,
 *           hostDrift?: {unit: string, problem: string, detail: string}[] | null,
 *           primaryDrift?: import("./update-primary.mjs").PrimaryDrift | null,
 *           closings?: Map<number, number> | null, claimFacts?: import("./work-gate/claim-stall-tick.mjs").ClaimFactsOfTick | null, trunkRed?: ReturnType<typeof readTrunkRed>,
 *           baseTip?: {sha: string, date: string} | null,
 *           claimStalls?: import("./claim-stall.mjs").StallOrder[], offBoard?: BoardFacts[] | null,
 *           callCountSignals?: { row: number, session: string, calls: number }[],
 *           bareAnswerLabels?: ReturnType<typeof bareAnswerLabelOrders>,
 *           labJobs?: import("./work-gate/lab-job-orders.mjs").LabJobRecord[] | null,
 *           claimRefusals?: Record<string, { reason: string, ticks: number }> }} state
 *        `claimStalls` is `claimStallTick`'s orders (#2470): a nudge to a holder whose claim has not moved, or a release
 *        `wake.mjs` performs. OMITTED MEANS NONE.
 *        `required` is the checks that can block a merge (`requiredCheckNames`), or `null` for
 *        "could not be read", which counts EVERY check as before this existed.
 *        `epics` are the open `epic` rows with their `subIssuesSummary` (`readEpics`); `[]` when
 *        refused or when the shelf was not empty enough to ask.
 *        `promotableRows` are the backlog rows carrying no unpickable label; `chairmanBlocked` are
 *        the rows waiting on the chairman, oldest first. `[]` for either when refused or empty.
 *        `prFiles` is `comparablePrFiles(prs)` -- the open PRs B4 may be asked about. It DEFAULTS TO
 *        `[]`, which means "no overlap is knowable", so every row is offered: the same behaviour as
 *        before B4 shelving existed, and the reason a caller that cannot read files is never worse off.
 *        `claimedComments` is `readClaimedRowComments()` -- the comments on the claimed rows only. It
 *        DEFAULTS TO `[]`, which is "not asked or refused": the comment marker is not evaluated and the
 *        body/`blockedBy` markers still are, so a caller that cannot make that read is never worse off
 *        than before this cause existed and never invents a constraint it did not see.
 *        `rowBranches` is `readRowBranches()` -- every branch on `origin` whose name ends `-<digits>`.
 *        OMITTED AND `null` MEAN THE SAME THING -- "not asked or refused": no row is shelved for it and
 *        no order is emitted, so a caller that cannot reach `origin` behaves exactly as it did before
 *        #2031. It carries no `= null` default deliberately: a default parameter is a branch `complexity`
 *        counts, and `decide` sits exactly on its limit of 15. Both readers below already treat a missing
 *        listing and a `null` one identically (`Array.isArray`, `?? []`), so the default would buy
 *        nothing but the sixteenth branch.
 *        Spending no API pool is the POINT rather than a saving -- see `readRowBranches`.
 *        `hostDrift` is `readHostDrift()` -- `host-units.mjs --json`'s findings, or `null`. OMITTED
 *        AND `null` MEAN THE SAME THING, "not asked or refused": no order is emitted, so a caller
 *        that cannot reach the host behaves exactly as it did before #2174. It carries no `= null`
 *        default for `rowBranches`'s reason -- a default parameter is a branch `complexity` counts,
 *        and `decide` sits exactly on its limit of 15.
 *        It spends NO API pool: see `readHostDrift`.
 *        `primaryDrift` is `readPrimaryDriftNow()` (#2781): where the primary stands against `origin/main`, or `null` for
 *        "not asked". OMITTED AND `null` MEAN THE SAME, and it carries no default for the same `complexity` reason.
 *        `trunkRed` is `readTrunkRed()` -- the facts about a red `main`, or `null` when it is green or the
 *        read was refused. OMITTED AND `null` MEAN THE SAME THING and it carries no `= null` default, for
 *        `rowBranches`'s reason: `decide` sits exactly on its limit of 15.
 *        `baseTip` is `readBaseTip()` -- `main`'s tip commit, read only on a red tick (#2117). It carries no
 *        `= null` default for `rowBranches`'s reason, and OMITTED AND `null` MEAN THE SAME THING: the
 *        `pr-checks-failing` prompt says whether `main` moved is UNKNOWN. IT CHANGES ONLY THOSE WORDS.
 *        `unarmed` is `readUnarmed(shouldBeMerging(prs, required))` -- the green, unheld pull requests
 *        the API says nothing has armed. It DEFAULTS TO `null`, which is "not asked or refused" and
 *        emits no order: a caller that cannot make that read must never produce a false all-clear, and
 *        must never produce a false alarm either.
 *        `offBoard` is `readRowsOffBoard()` -- every open row's Project 1 membership, or `null` (#2075). OMITTED AND `null` MEAN
 *        THE SAME THING, "not asked or refused": no order is emitted. It carries no `= null` default for `rowBranches`'s
 *        reason: `decide` sits exactly on its limit of 15.
 *        `callCountSignals` is `rowCallCountSignals(openRows, turns, claimedComments)` (#2691, windowed
 *        per row's own claim record since #2710) -- split candidates past the threshold on calls made
 *        while holding their row. OMITTED MEANS NONE, and `rowCallCountOrders` carries its own `= []`
 *        default rather than this signature carrying one, for `rowBranches`'s reason.
 *        `labJobs` is `labJobRecordsOrSay()` (#2729) -- the lab jobs that ended for a row, or `null` for a read that was
 *        refused. OMITTED AND `null` MEAN THE SAME THING and it carries no `= []` default for `rowBranches`'s reason.
 *        `bareAnswerLabels` is `bareAnswerLabelOrders(...)` (#2711) -- already-built orders, because
 *        building them means a per-row timeline call `decide` itself must not make. OMITTED MEANS NONE,
 *        and it carries no `= []` default for `rowBranches`'s reason: `decide` sits exactly on its limit
 *        of 15, and `bareAnswerOrdersOrNone` carries the `?? []` instead.
 *        `claimRefusals` is `claimRefusalStreaksNow(offerable)` (#2845) -- each offered row's consecutive-refusal streak. OMITTED MEANS
 *        NOT ASKED, so no `ready-row-unclaimable` order, and `unclaimableRowOrders` carries the absence handling for `rowBranches`'s reason.
 *        `nowMs` is the clock `chairmanOrders` windows on (#2989); omitted is `Date.now()`, so only a test passes it.
 *        `claimFacts` is the claim-stall tick's reading of every claimed row (#3451) -- what `blockerClearedOrders` drops an order on. OMITTED MEANS NOT ASKED, so no drop;
 *        `null` is a tick that read no claim. It carries no `= undefined` default for `rowBranches`'s reason.
 * @returns {{session: string, cause: string, subject: string, discriminator: string,
 *            prompt: string, causeKey: string}[]}
 */
export function decide({ prs, readyRows, promotableRows = [], chairmanBlocked = [], prFiles = [],
  drain = false, required = null, epics = [], answerOwed = [], openRows = [], unarmed = null,
  claimedComments = [], rowBranches, hostDrift, primaryDrift, closings, claimFacts, trunkRed, baseTip, claimStalls, offBoard, key, repo, callCountSignals, bareAnswerLabels, labJobs, claimRefusals, nowMs }) {
  // FIRST, BEFORE EVERY OTHER CAUSE (#2356): a red `main` outranks even `answer-owed` -- see `trunkRedOrders`.
  // `answer-owed` says another session is ALREADY STOPPED waiting on them, which outranks any standing question.
  const orders = [...trunkRedOrders(trunkRed), ...primaryStaleOrders(primaryDrift), ...answerOrders(answerOwed)]; // #2781: a stale primary next, every order below is given from its code
  // SECOND, AND AHEAD OF `blocker-cleared` DELIBERATELY (#2110). Both address a session that already
  // holds a row, so both outrank every cause that offers new work -- but between the two, a constraint
  // the holder has not read is worse than a row they have not resumed. `blocker-cleared` says work can
  // START again and loses nothing by waiting a tick; an unread constraint means work already in progress
  // is being done against a rule nobody applied, and every minute of it is a minute that may have to be
  // thrown away. #2099's ruling arrived 6 minutes after the build was finished.
  orders.push(...claimedRowAmendedOrders(openRows, claimedComments));
  // SECOND, AND FOR THE SAME REASON ONE LEVEL IN (#2027). A session holding a row whose last blocker just
  // closed is not waiting on a decision -- it is stopped on work it can resume this minute, with whatever
  // is queued behind that row stopped with it. Ahead of every cause that offers NEW work: a row already
  // claimed and now runnable beats a row nobody has picked up.
  orders.push(...blockerClearedOrders(openRows, todayIso(), Date.now(), { openPrs: prs, closings, claimFacts })); // #2741 backoff; #3451 the drops
  // #2470/#2711/#2729: A CLAIM THAT DOES NOT MOVE, A BARE `answer:` LABEL ON IT, OR A LAB JOB IT DISPATCHED THAT HAS ENDED -- all address the row's own holder, so all outrank every cause offering NEW work.
  orders.push(...stallOrdersOrNone(claimStalls), ...bareAnswerOrdersOrNone(bareAnswerLabels), ...labJobFinishedOrders(openRows, labJobs, Date.now()));

  orders.push(...perPullRequestOrders(prs, required, baseTip, nowMs), ...closesUnresolvedOrders(prs)); // #2823 beside them; #3092 the checkless
  // #2031: AHEAD OF THE OFFER, AND IT IS THE SAME READING THAT WITHHELD IT. `partitionUnclaimed` shelves
  // the row on `rowBranches` and this emits the cause that names the branch -- one condition, one read,
  // said once as a withholding and once as a question. Ahead of `rowOrders` for the ordering reason the
  // causes above use: work that already EXISTS outranks work nobody has started.
  const { offerable, blocked } = partitionUnclaimed(readyRows, prFiles, { rowBranches, openRows });
  orders.push(...rowBranchOrders(readyRows, rowBranches, prs), ...incompleteRowOrders(readyRows)); // #2791, #3010
  orders.push(...rowOrders(offerable), ...unclaimableRowOrders(offerable, claimRefusals)); // #2845: the offer, and its refusal

  // #2139: AHEAD OF BOTH BACKLOG SURVEYS AND BEHIND EVERY OFFER, because it is neither. It names ONE row
  // and the exact set that cleared, which outranks `ready-queue-empty` and `lane-backlog-unpromoted`
  // asking somebody to go and LOOK at a backlog -- and it is deliberately not gated on the shelf being
  // empty, which is what kept both of those silent while six rows sat runnable for up to 16h09m behind a
  // four-row Ready queue. It sits behind `rowOrders` for the ordering the causes above use: a row already
  // on the shelf can be claimed this minute, while this one still needs promoting first.
  // #2286: `closings` LETS IT BACK OFF. Absent, it asks at the unstaged key on every TTL, as before.
  orders.push(...unclaimedBlockerClearedOrders(openRows, undefined, { closings }));

  // The backlog is counted the same way, or the order would report rows the pool equally cannot take.
  // `ownerOf`, not `laneOwnerOf`: routed rows reach `decide` now, and the POOL's count must be exactly
  // what it was -- an engineer offered a `fleet-gated` row would be queueing for a worker box.
  const poolPromotable = promotableRows.filter((r) => ownerOf(r) === null);
  const shelf = emptyShelfOrder({ offerable, blocked, promotable: poolPromotable.length, key });
  if (shelf) orders.push(shelf);

  orders.push(...laneBacklogOrders(promotableRows, readyRows), ...agedBacklogOrders(promotableRows)); // #2848: the same stock, aged


  // AFTER the lane orders and BEFORE the chairman's: an unfiled epic is a supply problem, which only
  // matters once the queue and the lanes have nothing left to offer.
  orders.push(...epicOrders(epics, readyRows));
  // AFTER the unfiled epics. An epic with NO children is work nobody has filed at all; one whose children
  // are all closed may only need closing. The more likely supply of real work goes first.
  orders.push(...finishedEpicOrders(epics, readyRows));
  orders.push(...blockedReferentOrders(openRows, readyRows), ...rowCallCountOrders(callCountSignals)); // #2691 beside it: also a JUDGMENT over a row already claimed
  // THE BATCH THAT USED TO BE A 01:00 TIMER. Placed here rather than first: a named row to fix
  // outranks a standing sweep, and `orchestrator` gets one order per tick either way.
  orders.push(...fleetBatchOrders(openRows));

  // #1969: AFTER the per-PR and per-row causes and BEFORE the chairman's. A green unarmed PR is finished
  // work that cannot land -- more urgent than a supply question, less urgent than a named red build,
  // and never withheld by a drain: a window stops the org TAKING ON work, not finishing what is in flight.
  orders.push(...greenUnarmedOrders(unarmed, { key: key ?? "", repo: repo ?? REPO }));

  // #2084: BESIDE `pr-green-unarmed` AND FOR ITS REASON, ONE SURFACE OVER. Both name finished work that
  // cannot land; that one is about the ARMING not having happened and this one about GitHub refusing to
  // complete it. Same population (`mergeCandidates`), same audience, same placement -- more urgent than a
  // supply question, less urgent than a named red build, and never withheld by a drain, because a drain
  // stops the org TAKING ON work rather than finishing what is in flight.
  orders.push(...reviewBlockedOrders(reviewBlocked(prs, required)));
  // #2209: a conflicting PR is in no other cause's population, so it is told to its author here; a drain keeps it.
  // #2968: FED BY THE TOTAL CLASSIFIER, NOT BY "GREEN AND UNHELD": #2950, a conflicted draft, sat 7.5 h unheard.
  orders.push(...stalledPrOrders(prs, { required, reasons: STALL_REASONS_WITHOUT_A_CAUSE, nowMs }));
  orders.push(...pipelineCodeownerReviewOrders(pipelineCodeownerReviewMissing(prs, prFiles))); // #1959: beside the two above

  // #2174: AFTER the per-PR and per-row causes and BEFORE the chairman's, for `pr-green-unarmed`'s
  // reason applied to the machine rather than to a pull request. A stale host is finished work that has
  // not taken effect -- more urgent than a supply question, less urgent than a named red build. It is
  // deliberately NOT withheld by a drain: see `START_CAUSES`.
  orders.push(...hostDriftOrders(hostDrift), ...rowOffBoardOrders(offBoard)); // #2075: beside it; see `rowOffBoardOrders`

  orders.push(...chairmanOrders(chairmanBlocked, nowMs), ...chairmanAnsweredOrders(chairmanBlocked)); // #3390: beside it, and a row the reminder names may be named here too


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
 * @param {{ drain: boolean, blocked: { number: number, repoKey?: string, reason: string }[] }} withheld
 */
function reportWithheld({ drain, blocked }) {
  if (drain) {
    process.stderr.write(`DRAINING (${DRAIN_MARKER} exists): finishing work in flight, starting none. `
      + `Withheld: ${START_CAUSES.join(", ")}. Remove that file to reopen the queue.\n`);
  }
  for (const row of blocked) {
    process.stderr.write(`SHELVED row ${subjectMention(row)}: ${row.reason}\n`);
  }
}

// --- #2401: A REVIEWER WHOSE CODEX FAILED TO AUTHENTICATE ---------------------------------------------------

/** Where the org's runtime state lives -- beside `wake.mjs`'s ledger, which defaults to the same directory. */
export const REVIEWER_STATE_DIR = stateEntryPath("");

/** The instances `wake.mjs` STARTED and has not ended: `{ "reviewer-<n>": { spawnedAt } }`. `wake` writes, this reads. */
export const REVIEWER_REGISTRY_FILE = "reviewer-instances.json";

/** Every change of the credential's `last_refresh`, one JSON line each -- the reading ruling 2 asked for. */
export const REVIEWER_REFRESH_LEDGER_FILE = "reviewer-refreshes";

/** The reviewers' codex credential. Only `last_refresh` is ever read from it: the tokens beside it are secrets. */
export const CODEX_AUTH_FILE = `${process.env.HOME}/.codex/auth.json`;

/**
 * CODEX'S OWN AUTH-FAILURE TEXT (signal a), READ FROM CODEX AND NOT INVENTED.
 *
 * Measured 2026-09-24 by scanning the printable strings of the installed `codex-cli 0.156.1` binary
 * (`~/.codex/packages/standalone/releases/0.156.1-x86_64-unknown-linux-musl/bin/codex`), no refresh forced.
 * These are the user-facing messages of its auth-recovery path, each verbatim:
 *   - "Your access token could not be refreshed. Please log out and sign in again."
 *   - "Your access token could not be refreshed because you have since logged out or signed in to another
 *      account. Please sign in again."
 *   - "Your authentication session could not be refreshed automatically. Please log out and sign in again."
 *   - "OAuth refresh token was rejected: " and "Failed to refresh token: " (the error prefixes)
 * WHAT THIS DOES NOT PROVE: that any of them RENDERS in a pane as written. No live failure was available -- forcing one
 * could log out live reviewers, which ruling 2 excluded -- so the match is a needle into a pane's recent
 * output, and the first real refresh either finds it or is caught by signal (b). A new codex may reword
 * these; `docs/known-gaps.md` says so.
 */
export const CODEX_AUTH_FAILURE_TEXT = Object.freeze([
  "Your access token could not be refreshed",
  "Your authentication session could not be refreshed automatically",
  "OAuth refresh token was rejected",
  "Failed to refresh token",
]);

/**
 * THE LOGGED-OUT STARTUP SCREEN (signal a, second form): what codex 0.157.0's TUI showed at startup on a REJECTED
 * credential (a deliberately expired, structurally valid fake in a private `CODEX_HOME`, 401), 2026-09-25, read in
 * tmux. It dropped to onboarding and rendered none of the four phrases above:
 *   Welcome to Codex, OpenAI's command-line coding agent / Sign in with ChatGPT / or connect an API key
 * WHAT THIS DOES NOT ESTABLISH: what a pane that loses its login MID-SESSION renders -- the case a running reviewer
 * meets. It is the startup path only, and `docs/known-gaps.md` §49's refresh race stays unmeasured.
 * `anchor` is the welcome line and `alsoShows` must be in the same text: "Sign in with ChatGPT" alone is a phrase a
 * reviewer QUOTES in a review, so neither half fires on its own. A separate list so the four above, whose provenance
 * test reads the installed binary, are unchanged.
 */
export const CODEX_LOGGED_OUT_SCREEN = Object.freeze({
  anchor: "Welcome to Codex, OpenAI's command-line coding agent",
  alsoShows: "Sign in with ChatGPT",
});

export const MS_PER_MINUTE = 60_000;

/**
 * How long a reviewer may go without a verdict after the credential refreshed before that is called a failure.
 * A review is minutes of reading, not an hour, and a healthy reviewer that refreshed mid-review still answers
 * inside this; a number, not a measurement, and the refresh ledger is where the first real one is read.
 */
export const REVIEWER_SILENCE_MS = 30 * MS_PER_MINUTE;

/** The two causes whose recipient is a reviewer that owes a verdict. */
const REVIEWER_VERDICT_CAUSES = Object.freeze(["draft-awaiting-verdict", "verdict-comment-unreviewed"]);

/**
 * `credential.last_refresh` as epoch milliseconds, or `null` when the file cannot be read or carries none.
 * `null` is "could not ask" and signal (b) says nothing for it; it is never a time.
 * @param {string} [path] @param {(path: string, enc: "utf8") => string} [read]
 * @returns {number | null}
 */
export function readLastRefresh(path = CODEX_AUTH_FILE, read = readFileSync) {
  try {
    const at = Date.parse(String(JSON.parse(read(path, "utf8"))?.last_refresh ?? ""));
    return Number.isNaN(at) ? null : at;
  } catch {
    return null;
  }
}

/**
 * The instances `wake.mjs` started, from the registry file. `{}` for a missing file (nothing was started) AND for
 * one that will not parse -- the second is a lost reading, so it is never confused with an instance that FAILED.
 * @param {string} path @param {(path: string, enc: "utf8") => string} [read]
 * @returns {Record<string, {spawnedAt: number}>}
 */
export function readReviewerRegistry(path, read = readFileSync) {
  try {
    const parsed = JSON.parse(read(path, "utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The phrase of codex's own auth-failure text a pane shows, or `null`. The logged-out startup screen answers with
 * its welcome line.
 * @param {string | null | undefined} text
 * @returns {string | null}
 */
export function authFailureShownIn(text) {
  const shown = String(text ?? "");
  const { anchor, alsoShows } = CODEX_LOGGED_OUT_SCREEN;
  const loggedOut = shown.includes(anchor) && shown.includes(alsoShows) ? anchor : null;
  return CODEX_AUTH_FAILURE_TEXT.find((phrase) => shown.includes(phrase)) ?? loggedOut;
}

/**
 * The reviewer sessions this tick's orders say still OWE a verdict: an order addressed to `reviewer-<n>` for one
 * of the two verdict causes. The gate derives those from GitHub each tick, so "still emitted" is "still owed".
 * @param {{session: string, cause?: string}[]} orders
 * @returns {Set<string>}
 */
export function sessionsOwingVerdict(orders) {
  return new Set(orders
    .filter((o) => REVIEWER_VERDICT_CAUSES.includes(String(o.cause)) && reviewerInstance(o.session) !== null)
    .map((o) => o.session));
}

/**
 * WHICH LIVE REVIEWER INSTANCES HAVE FAILED TO AUTHENTICATE -- two signals, each named on the failure it yields.
 *
 *   pane            (a) the instance's pane shows codex's own auth-failure text. Asked of EVERY registered instance,
 *                   because the text is the failure itself and needs no bound.
 *   refresh-silence (b) `last_refresh` is later than the instance's start, it still owes a verdict, and the refresh is
 *                   older than `silenceMs`. A healthy reviewer that refreshed answers inside the bound; one that
 *                   lost its login sits at the prompt and never does.
 *
 * (b) NEEDS THE VERDICT STILL OWED, and that is what keeps an idle instance -- verdict posted, PR waiting to
 * merge -- from reading as failed the moment the credential moves. A `paneText` that cannot be read is `null`,
 * which says nothing for (a) and leaves (b) to stand alone.
 *
 * @param {{instances: Record<string, {spawnedAt: number}>, owing: Set<string>, lastRefresh: number | null,
 *   paneText: (session: string) => string | null, now: number, silenceMs?: number}} facts
 * @returns {{session: string, signals: string[]}[]}
 */
export function reviewerAuthFailures({ instances, owing, lastRefresh, paneText, now, silenceMs = REVIEWER_SILENCE_MS }) {
  return Object.entries(instances).flatMap(([session, { spawnedAt }]) => {
    const signals = [];
    if (authFailureShownIn(paneText(session)) !== null) signals.push("pane");
    const refreshedSinceStart = lastRefresh !== null && lastRefresh > spawnedAt;
    if (refreshedSinceStart && owing.has(session) && now - lastRefresh > silenceMs) signals.push("refresh-silence");
    return signals.length > 0 ? [{ session, signals }] : [];
  });
}

/**
 * The incident order to `ceo`, or none. `ceo` because the remedy is a re-login of the reviewer's codex account, an
 * interactive step only the chairman can take (ruling 2). JUDGMENT-keyed on the failed set and the refresh it
 * followed, so the same failure is not re-asked every twenty minutes and a NEW one is a new question.
 * @param {{session: string, signals: string[]}[]} failures @param {number | null} lastRefresh
 * @returns {{session: string, cause: string, subject: string, discriminator: string, prompt: string, causeKey: string}[]}
 */
export function reviewerAuthOrders(failures, lastRefresh) {
  if (failures.length === 0) return [];
  const key = `${failures.map((f) => f.session).sort().join(".")}/${lastRefresh === null ? "no-refresh" : new Date(lastRefresh).toISOString()}`;
  return [{
    session: "ceo",
    cause: "reviewer-auth-failed",
    subject: "reviewer-auth",
    discriminator: key,
    prompt: `${failures.length} reviewer instance(s) have FAILED TO AUTHENTICATE with codex:\n`
      + failures.map((f) => `  ${f.session}  (${f.signals.join(" + ")})`).join("\n") + "\n"
      + "`pane` is codex's own auth-failure text in the instance's pane; `refresh-silence` is the credential's "
      + "`last_refresh` moving after the instance started while it still owes a verdict for more than "
      + `${REVIEWER_SILENCE_MS / MS_PER_MINUTE} minutes.\n`
      + "THE REMEDY IS A RE-LOGIN OF THE REVIEWER'S CODEX ACCOUNT, and only the chairman can do it (`codex "
      + "login`, interactive). Afterwards close each failed workspace (`herdr --session org workspace close "
      + "<id>`): the gate starts a fresh instance for a pull request that still needs a verdict on its next tick. "
      + "The reading is `reviewer-refreshes`, beside the wake ledger (every refresh, with the live-instance count).",
    causeKey: `ceo/reviewer-auth-failed/${key}`,
  }];
}

/**
 * The ledger lines to append for this tick: a `refresh` line when `last_refresh` differs from the newest recorded
 * one, and a `failure` line for each instance found failed on a refresh not yet recorded as failing.
 *
 * EVERY REFRESH IS A READING (ruling 2): how many instances were live when it moved, and whether any then
 * failed, so "the first real refresh is the measurement" is a file someone can read. A failure is detected up to
 * `REVIEWER_SILENCE_MS` AFTER the refresh, so it is its own line naming the refresh it followed, never a
 * rewrite of the `refresh` line.
 *
 * @param {{ledger: {type: string, lastRefresh: string | null, session?: string}[], lastRefresh: number | null,
 *   live: string[], failures: {session: string, signals: string[]}[], now: number}} facts
 * @returns {object[]}
 */
export function refreshLedgerLines({ ledger, lastRefresh, live, failures, now }) {
  if (lastRefresh === null) return [];
  const iso = new Date(lastRefresh).toISOString();
  const at = new Date(now).toISOString();
  const lines = [];
  const known = ledger.some((l) => l.type === "refresh" && l.lastRefresh === iso);
  const hadOtherRefresh = ledger.some((l) => l.type === "refresh");
  if (!known) lines.push({ type: "refresh", at, lastRefresh: iso, live: live.length, liveSessions: live,
    firstRecorded: !hadOtherRefresh });
  for (const f of failures) {
    if (ledger.some((l) => l.type === "failure" && l.lastRefresh === iso && l.session === f.session)) continue;
    lines.push({ type: "failure", at, lastRefresh: iso, session: f.session, signals: f.signals });
  }
  return lines;
}

/** @param {string} path @param {(path: string, enc: "utf8") => string} [read] */
function readRefreshLedger(path, read = readFileSync) {
  try {
    return String(read(path, "utf8")).split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/**
 * The live reviewer instances' panes as text, through herdr: workspace list, the pane of the one labelled
 * `session`, and that pane's recent output. `null` for anything herdr will not say -- never `""`, which would
 * read as "a pane that shows no failure".
 *
 * A HERDR CALL FROM THE GATE, AND THE ONE EXCEPTION to its header (which keeps herdr to `wake.mjs` so this file
 * stays testable): the seam is `run`, INJECTED, and it is reached only for an instance in the registry, so a tick
 * with no reviewer instance makes no call at all.
 * @param {(args: string[]) => string} run
 * @returns {(session: string) => string | null}
 */
export function herdrPaneReader(run) {
  return (session) => {
    try {
      const workspaces = JSON.parse(run(["--session", "org", "workspace", "list"]))?.result?.workspaces ?? [];
      const workspace = workspaces.find((/** @type {any} */ w) => w.label === session)?.workspace_id;
      if (typeof workspace !== "string") return null;
      const panes = JSON.parse(run(["--session", "org", "pane", "list", "--workspace", workspace]))?.result?.panes ?? [];
      const pane = panes[0]?.pane_id;
      return typeof pane === "string" ? run(["--session", "org", "pane", "read", pane, "--lines", "60"]) : null;
    } catch {
      return null;
    }
  };
}

/**
 * The detector's whole tick: read the registry, the credential and the panes; append the refresh ledger; return
 * the incident order. Reads the SAME state directory `wake.mjs` writes its registry into.
 *
 * NEVER THROWS -- a detector that can crash the gate would stop every order behind it. A failure to append the
 * ledger is said on stderr and the order is still returned.
 *
 * @param {{orders: {session: string, cause?: string}[], dir?: string, authFile?: string, now?: number,
 *   run?: (args: string[]) => string, log?: (line: string) => void}} args
 */
export function reviewerAuthTick({ orders, dir = REVIEWER_STATE_DIR, authFile = CODEX_AUTH_FILE, now = Date.now(),
  run = herdrRun, log = (line) => process.stderr.write(line) }) {
  const instances = readReviewerRegistry(`${dir}/${REVIEWER_REGISTRY_FILE}`);
  const lastRefresh = readLastRefresh(authFile);
  const failures = reviewerAuthFailures({ instances, owing: sessionsOwingVerdict(orders), lastRefresh,
    paneText: Object.keys(instances).length > 0 ? herdrPaneReader(run) : () => null, now });
  const ledgerPath = `${dir}/${REVIEWER_REFRESH_LEDGER_FILE}`;
  const lines = refreshLedgerLines({ ledger: readRefreshLedger(ledgerPath), lastRefresh,
    live: Object.keys(instances), failures, now });
  try {
    if (lines.length > 0) {
      mkdirSync(dirname(ledgerPath), { recursive: true });
      appendFileSync(ledgerPath, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
    }
  } catch (err) {
    log(`reviewer-auth: could not append ${ledgerPath} (${String(/** @type {any} */ (err)?.message ?? err).split("\n")[0]}) -- the order below is unaffected.\n`);
  }
  return reviewerAuthOrders(failures, lastRefresh);
}

const BYTES_PER_GIB = 1_073_741_824;

/**
 * `/` and `/tmp` -> `root+tmp`: a mount as a word a causeKey can carry. `/` is `root`, any other loses its leading
 * slash and turns the rest into `-`.
 * @param {string[]} mounts
 */
function mountsLabel(mounts) {
  return mounts.map((m) => (m === "/" ? "root" : m.replace(/^\//, "").replaceAll("/", "-"))).join("+");
}

/** @param {import("./disk-headroom.mjs").LowFinding} f */
function describeLow(f) {
  const amount = f.resource === "bytes"
    ? `${(f.free / BYTES_PER_GIB).toFixed(1)} GiB of ${(f.total / BYTES_PER_GIB).toFixed(1)} GiB`
    : `${f.free.toLocaleString("en-US")} of ${f.total.toLocaleString("en-US")}`;
  return `${f.mounts.join(" + ")}  FREE ${f.resource.toUpperCase()}: ${amount} (${(f.fraction * 100).toFixed(1)}%)`;
}

/**
 * The incident order to `ceo`, or none (#2163). `ceo` because a full disk is the one fault every session shares and
 * no session owns, and the remedy (what to delete, whether to schedule the prune) is theirs to rule on.
 *
 * JUDGMENT-KEYED ON WHICH RESOURCE OF WHICH FILESYSTEM IS LOW, and on nothing else -- so a condition that persists
 * is asked again on the judgment window and not on every tick, and a SECOND resource going low is a new question
 * that reaches `ceo` at once. The cost, stated: 9% and 0% free are the same key, so a disk getting worse does not
 * re-page inside the window; the stderr line below is written every tick and does.
 *
 * INCIDENT BEHIND THE ORDER'S TEXT (moved out of it, #3444: the agent reading the order cannot use it):
 * on 2026-09-25 `/tmp` ran out of INODES at 73% of its bytes and every session failed with ENOSPC for about six hours.
 *
 * @param {import("./disk-headroom.mjs").LowFinding[]} low
 * @returns {{session: string, cause: string, subject: string, discriminator: string, prompt: string, causeKey: string}[]}
 */
export function diskHeadroomOrders(low) {
  if (low.length === 0) return [];
  const key = low.map((f) => `${mountsLabel(f.mounts)}:${f.resource}`).sort().join(".");
  return [{
    session: "ceo",
    cause: "disk-headroom-low",
    subject: "disk-headroom",
    discriminator: key,
    prompt: `DISK HEADROOM IS LOW on this host (a resource is low below ${MIN_FREE_FRACTION * 100}% free):\n`
      + low.map((f) => `  ${describeLow(f)}`).join("\n") + "\n"
      + "BYTES AND INODES ARE JUDGED SEPARATELY, and `df -h` shows only bytes. A filesystem can run out of "
      + "INODES with bytes to spare, and every session then fails with ENOSPC. Read both: "
      + "`df -h / /tmp` and `df -i / /tmp`.\n"
      + "What has filled it before: `/tmp/rv-*` review clones, `/tmp/claude-1000` session scratchpads, "
      + "`~/repos/wt-*` worktrees (each with a `node_modules`), and npm caches. `node "
      + "packages/agent-org/src/prune-tmp.mjs` classifies `/tmp` and removes NOTHING without `--apply`, and "
      + "`--apply` waits for a named list one cycle first (#2243). `pnpm run worktrees:prune` is the worktree half.\n"
      + "IF YOUR OWN SHELL IS FAILING WITH ENOSPC you cannot fix this from here: label a row `" + CHAIRMAN_LABEL + "` and "
      + "@-mention `@DanBeckDev` in its brief (a GitHub write, and the label is what the gate reads). "
      + "The same reading is written on the tick's stderr before `wake` runs (`journalctl --user -u "
      + "a11ign-work-tick.service | grep 'DISK LOW'`), though that journal sits on this same filesystem.",
    causeKey: `ceo/disk-headroom-low/${key}`,
  }];
}

/**
 * The detector's whole tick: read `/` and `/tmp`, say on stderr what is low, return the incident order.
 *
 * NEVER THROWS, for `reviewerAuthTick`'s reason -- a detector that can crash the gate stops every order behind it.
 * A mount that cannot be READ is said on stderr and is neither reported low nor counted healthy: `statfs` failing
 * is not the disk being full, and silence about it would read as a clean bill.
 *
 * THE STDERR LINE IS THE CHANNEL THAT DOES NOT NEED THE DISK (#2163 done-when 4). `work-tick` relays the gate's
 * stderr BEFORE it runs `wake`, and `wake`'s writes (`wake-emitted`, the ledger) are what a full disk breaks: a
 * throwing write to `wake-emitted` ends `wake` with an uncaught exception, exit 1, BEFORE any delivery, and one to
 * the ledger ends it AFTER the first delivery and before the rest (both measured -- `disk-headroom.test.ts`). The
 * line is written whether or not the order is ever delivered. THE JOURNAL IT LANDS IN IS ON THE SAME FILESYSTEM
 * (`/var/log/journal`, persistent), so this is a channel that does not depend on a write BY THE ORG, not one proven
 * to survive an exhausted disk: journald's own free-space rules decide that, and nothing here has run it to zero.
 *
 * @param {{ read?: typeof diskHeadroom, log?: (line: string) => void }} [io]
 */
export function diskHeadroomTick({ read = diskHeadroom, log = (line) => process.stderr.write(line) } = {}) {
  try {
    const { low, unreadable } = read();
    for (const u of unreadable) {
      log(`disk-headroom: could not read ${u.mount} (${u.reason}) -- neither reported low nor counted healthy.\n`);
    }
    for (const f of low) log(`DISK LOW: ${describeLow(f)}\n`);
    return diskHeadroomOrders(low);
  } catch (err) {
    log(`disk-headroom: could not run (${String(/** @type {any} */ (err)?.message ?? err).split("\n")[0]}) -- no order this tick.\n`);
    return [];
  }
}

/** @param {string[]} args */
const herdrRun = (args) => execFileSync("herdr", args, { encoding: "utf8", timeout: 10_000 });

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
 * A DEAD POOL BOUGHT ONLY THE RESET, NOT THE LOGIN, because no one call buys both and "how long is the org
 * deaf" was the question the 2026-09-22 outage left unanswered -- so the account used to read `UNREADABLE
 * (user ID ...)` on exactly that path. #1984 closes that gap AT NO EXTRA CALL: `identity.login` is the
 * DECLARED account `gh-identity.mjs` reads off disk (which config `gh` is routed to), and it fills in
 * whenever the probe's own response names none, which is precisely the dead-pool case. When the probe DOES
 * name one (a live pool), that response wins -- it is a confirmed account fact and `identity.login` is
 * left unused, per `accountPhrase`'s own header in `api-pool.mjs`. `identity` is REQUIRED rather than
 * defaulted, for the same reason `run` is (#1405): a defaulted read of `.agent-org/host.json` and a
 * `hosts.yml` is still a real filesystem read, and a test reaching this function would make it against
 * whatever this host happens to have installed.
 *
 * @param {{run: (args: string[]) => string, identity: import("./gh-identity.mjs").DeclaredAccount}} deps
 * @returns {string}
 */
export function cannotAskReport({ run, identity }) {
  const diagnosis = poolDiagnosis({ run });
  return "CANNOT ASK: neither the pull-request list nor the Ready rows could be read. "
    + "Nothing was examined -- this is NOT a quiet queue, and no session has been woken.\n"
    + `${refusalPoolLine({ ...diagnosis, login: diagnosis.login ?? identity.login })}\n`;
}

/**
 * The agent host's drift, or `null` when the read could not be made -- #2174.
 *
 * SPAWNED, NOT IMPORTED, AND THE CHOICE IS MEASURED RATHER THAN STYLISTIC. The row offered three routes:
 * import `hostUnitDrift`, split it into a leaf module, or spawn `host:check`. A direct import is free at
 * LOAD -- `host-units.mjs` adds one file to a closure of 21, and 39.3ms against the gate's own 39.4ms,
 * five runs each -- so the row's constraint 1, which feared the import WEIGHT, is satisfied by it and
 * would have ended the question.
 *
 * WHAT THE WEIGHT MEASUREMENT MISSES IS THE CAPABILITY CLOSURE, and that is what decided this.
 * `host-units.mjs` calls `git log --all` (`addedOnSomeRef`), so importing it here puts a `history`
 * requirement into `work-gate.mjs` -- and this file is reached by `row-claim/runner-rule.mjs`, which most
 * of the packaging suite imports. MEASURED with `deriveClosureRequirements` over
 * `packages/lab/src/packaging/*.test.ts`, at `518de0e32` and again with the import added: **4 files
 * derive a `history` requirement, and 28 do with it.** Twenty-four test files that will never call this
 * code would owe a `History: full` declaration, paid by whoever next opens a PR whose Acceptance happens
 * to name one of them. A process boundary costs one node startup per tick and leaves the closure at 4.
 *
 * AND IT BUYS A PROPERTY THE IMPORT CANNOT. The session this cause wakes is told to run
 * `pnpm run host:check`; this spawns THE SAME FILE IN THE SAME TREE, so the gate and the human can never
 * disagree about what drifted. Two readers of one question is the defect this repository keeps
 * re-finding one level up, and here there is exactly one.
 *
 * `null` FOR EVERY UNREADABLE CASE AND NEVER `[]`, which is `readPrs`'s rule for its reason: a spawn
 * that failed, a non-zero exit, unparseable output and `asked: false` are all "not asked", while `[]` is
 * a host that was looked at and is correct. Both produce silence here and they are NOT the same claim --
 * `hostDriftOrders` keeps them apart, and `driftReport` keeps them apart for the CLI's reader.
 * @returns {{unit: string, problem: string, detail: string}[] | null}
 */
function readHostDrift() {
  const run = spawnSync(process.execPath, [hostUnitsEntry(), "--json"], { encoding: "utf8" });
  if (run.status !== 0 || typeof run.stdout !== "string") return null;
  try {
    const parsed = JSON.parse(run.stdout);
    return parsed?.asked === true && Array.isArray(parsed.findings) ? parsed.findings : null;
  } catch {
    // UNPARSEABLE IS NOT CLEAN. A future `host:check` that prints a warning before its JSON lands here,
    // and the only safe reading of output this function does not understand is that it did not ask.
    return null;
  }
}

/** `host-units.mjs` beside this file -- RESOLVED, never imported. See `readHostDrift` for why. */
function hostUnitsEntry() {
  return fileURLToPath(new URL("./host-units.mjs", import.meta.url));
}

/**
 * The lab jobs that ended for a row (#2729), or `null` when the directory exists and cannot be read -- SAID on stderr, and
 * emitting nothing, since "could not look" is not "nothing ended". A local disk read: it adds nothing to `GH_READS`.
 * @param {typeof readLabJobRecords} [read]
 */
export function labJobRecordsOrSay(read = readLabJobRecords) {
  try {
    return read({ skipped: (file) => process.stderr.write(`SKIPPED lab job record ${file}: unreadable or not schema 1\n`) });
  } catch (err) {
    process.stderr.write(`COULD NOT READ lab job records: ${String(/** @type {any} */ (err)?.message ?? err).split("\n")[0]}\n`);
    return null;
  }
}

/**
 * The lab jobs dispatched and not yet ended (#3007), or `null` when the read was refused -- SAID on stderr, and `null`, never `[]`: an
 * empty list reads as "nothing waits". A local `ps`: it adds nothing to `GH_READS`.
 * @param {typeof readDispatchedLabJobs} [read]
 */
export function dispatchedLabJobsOrSay(read = readDispatchedLabJobs) {
  try {
    return read();
  } catch (err) {
    process.stderr.write(`COULD NOT READ dispatched lab jobs: ${String(/** @type {any} */ (err)?.message ?? err).split("\n")[0]}\n`);
    return null;
  }
}

/**
 * `readRowsOffBoard`, saying on stderr when it could not ask (split out of `main`, which sits on `complexity`'s limit).
 * A refused read emits no order and MUST NOT read as a clean board, so the difference is written where the tick log reads.
 * @param {(line: string) => void} [log] @param {import("./org-health.mjs").PoolReading[]} [pools] where the read leaves the GraphQL pool it saw (#3448)
 */
export function rowsOffBoardOrSay(log = (line) => process.stderr.write(line), pools = []) {
  const facts = readRowsOffBoard(defaultRun, pools);
  if (facts === null) {
    log("CANNOT ASK which open rows are off Project 1: the read was refused. row-off-board was NOT evaluated "
      + "this tick, and that silence is not a clean board.\n");
  }
  return facts;
}

/**
 * A CLAIMED row `blockerClearedOrders` would ask about -- the same conditions that function screens
 * with EXCEPT `resumed`, which needs `openPrs` that this gate site does not carry (`main`/`trackerReadings`
 * read `closings` before `code.prs` exists in a split-repo scope, #2618). Ignoring it makes this a
 * SUPERSET of `blockerClearedOrders`' own population, never a narrower one: an already-resumed row pays
 * for a `closings` read it turns out not to need, exactly as `unstaged first ask` already tolerates for a
 * refused one.
 *
 * @param {any[]} rows @param {string} [today] @param {number} [nowMs]
 * @returns {boolean}
 */
export function anyBlockerClearingCandidate(rows, today = todayIso(), nowMs = Date.now()) {
  return (rows ?? []).some((row) => sessionOf(row) && labelsOf(row).includes(CLAIM_LABEL)
    && declaredBlockers(row) !== null && !holderWaitingOn(row, today, nowMs));
}

/**
 * The closing times `blockerClearedOrders` and `unclaimedBlockerClearedOrders` back off on, read ONLY when
 * some row -- claimed or not -- has a cleared blocker to ask about (#2286, widened by #2741). `openRows`
 * is already in hand, so the condition costs no call, and a quiet tracker pays nothing
 * (`GH_READS.conditionalOnClearedRows`). `null` when there is nothing to ask about OR the read was
 * refused -- in both cases the caller's fallback is the unstaged first ask.
 *
 * @param {any[]} openRows
 */
function closingsWhenRowsCleared(openRows) {
  return (unclaimedClearings(openRows).length > 0 || anyBlockerClearingCandidate(openRows))
    ? readRecentlyClosed() : null;
}

// --- #2618 (child 3c of #69): EVERY REPOSITORY THE PROJECT DECLARES, NOT ONE ---------------------------------------------

/**
 * @typedef {{ repo: string }} ScopeRepository
 * @typedef {{ key: string, code: ScopeRepository | null, tracker: ScopeRepository | null }} Scope
 */

/**
 * THE SCOPES OF A TICK: one per KEY across every declaration handed in, the primary project's (the empty key) FIRST.
 *
 * A scope pairs the code repository and the tracker that share a key, either of which may be absent (a layer repository
 * has code and no tracker of its own). Inside one scope a pull request or row number is unambiguous, which is why `decide`
 * is run PER SCOPE rather than over one merged list: every map in it is keyed by number, and PR 7 in two repositories
 * would be one entry. Names are made distinct at the OUTPUT (`subjectRef`, `reviewerSeat`), not by renumbering the input.
 *
 * A key declared twice REFUSES, naming it: `project-config.mjs` refuses a duplicate within one declaration, and this is the
 * same rule across the host (ADR 0040, decision 2: the key is "unique across the host"), which no single declaration can see.
 * @param {readonly { tracker: readonly { key: string, repo: string }[], code: readonly { key: string, repo: string }[] }[]} declarations
 * @returns {Scope[]}
 */
export function scopesOf(declarations) {
  /** @type {Map<string, Scope>} */
  const byKey = new Map();
  /** @param {string} key @param {"code" | "tracker"} part @param {string} repo */
  const declare = (key, part, repo) => {
    const scope = byKey.get(key) ?? { key, code: null, tracker: null };
    if (scope[part] !== null) throw new Error(`key ${key === "" ? "(empty)" : `\`${key}\``} declares a ${part} repository twice (${scope[part].repo} and ${repo}); a key is unique across the host`);
    scope[part] = { repo };
    byKey.set(key, scope);
  };
  for (const declaration of declarations) {
    for (const entry of declaration.tracker) declare(entry.key, "tracker", entry.repo);
    for (const entry of declaration.code) declare(entry.key, "code", entry.repo);
  }
  return [...byKey.values()].sort((a, b) => Number(b.key === "") - Number(a.key === "") || a.key.localeCompare(b.key));
}

/**
 * The repository a scope's read is AIMED at, or `undefined` for the primary project's own: its reads are made exactly as
 * they were before a second repository existed, with nothing added to the call.
 * @param {Scope} scope @param {ScopeRepository | null} part @returns {string | undefined}
 */
const aimOf = (scope, part) => (scope.key === "" || part === null ? undefined : part.repo);

/**
 * A list a reader returned, its members marked with the repository they came from -- and `null` (a refusal) left as `null`.
 * The primary project's members are returned UNTOUCHED, so its records stay byte-identical to what they were.
 * @param {any[] | null} list @param {string} key @param {string | undefined} repo @returns {any[] | null}
 */
function tagged(list, key, repo) {
  return list === null || key === "" ? list : list.map((item) => ({ ...item, repoKey: key, repo }));
}

/**
 * THE ENUMERATION: what one scope's two lanes answered. `readPrs` and `readOpenRows` (and the Ready, backlog and chairman
 * reads beside them) were the reads that assumed one repository; here each is asked of the scope's own, through `run`, which
 * is handed the repository as a second argument. EACH LANE IS `null` WHEN ITS READ WAS REFUSED and `[]` when the scope has no
 * such repository, so "could not ask" and "nothing there" never share a value (#1286), and a refusal in one scope
 * is visible beside another scope's answer instead of taking it down.
 * @param {Scope} scope @param {(args: string[], repo?: string) => string} [run]
 */
export function readLanes(scope, run = defaultRun) {
  const codeRepo = aimOf(scope, scope.code);
  const trackerRepo = aimOf(scope, scope.tracker);
  /** @param {string | undefined} repo @returns {(args: string[]) => string} */
  const aimed = (repo) => (args) => run(args, repo);
  /** @param {ScopeRepository | null} part @param {(run: (args: string[]) => string) => any[] | null} read */
  const lane = (part, read) => (part === null ? [] : tagged(read(aimed(aimOf(scope, part))), scope.key, aimOf(scope, part)));
  return {
    prs: lane(scope.code, (aim) => readPrs(aim)),
    readyRows: lane(scope.tracker, (aim) => readReadyRows(aim)),
    promotableRows: lane(scope.tracker, (aim) => readPromotableRows(aim)),
    chairmanBlocked: lane(scope.tracker, (aim) => readChairmanBlocked(aim)),
    openRows: lane(scope.tracker, (aim) => readOpenRows(aim)),
    codeRepo, trackerRepo,
  };
}

/**
 * The words that tell an agent WHICH repository a keyed order is about, appended to its prompt. A prompt names `gh` commands with
 * a bare number (`gh issue edit 7 ...`), and the session that runs one in the primary's checkout would edit the PRIMARY's row 7.
 * @param {Scope} scope
 */
function repositoryNote(scope) {
  const repos = [scope.code && `code \`${scope.code.repo}\``, scope.tracker && `rows \`${scope.tracker.repo}\``].filter(Boolean).join(", ");
  return `\n\nREPOSITORY \`${scope.key}\` (${repos}). A number in this order belongs to THAT repository, not the primary's: put `
    + "`--repo <owner/name>` on every `gh` command that names one, and read its name as `<key>#<n>`.";
}

/**
 * The orders and readings of ONE NON-PRIMARY SCOPE, made from its own lanes. The primary project's tick is `main`'s own, and
 * stays where it is, so one declared project makes the calls it made before and the orders it made before.
 *
 * WHAT IT DOES NOT ASK, and why (each is the primary project's, or a later row's): the local git reads (`rowBranches`, claim
 * stalls) look at THIS checkout and its worktrees; `hostDrift`, the disk and the reviewer's credentials are
 * facts about the host; the scope's OWN `main` is asked (`codeReadings`' `trunkRed`, #3079) and the primary's is not; and Project-1 membership names a board, which 3d and 3f make a
 * declaration's. Each is passed as `undefined`, which `decide` reads as "not asked", so nothing here invents a reading.
 * @param {Scope} scope @param {boolean} drain
 * @param {ReturnType<typeof readLanes> & { siblingPrs?: any[] }} [read] the lanes, when the caller has already asked. #3095: `siblingPrs` are the
 *   open pull requests of the OTHER declared code repositories (already read, so the comparison costs no call), which B4 compares a row with too
 * @param {{ code: typeof codeReadings, tracker: typeof trackerReadings }} [readings] the per-tick reads beyond the lanes; a test hands stubs, so no `gh` is spawned
 * @returns {{ orders: any[], blocked: any[], refused: string[] }}
 */
export function scopeTick(scope, drain, read = readLanes(scope), readings = { code: codeReadings, tracker: trackerReadings }) {
  const { prs, readyRows, promotableRows, chairmanBlocked, openRows } = read;
  const refused = [
    ...(prs === null ? [`the pull-request list of ${scope.code?.repo}`] : []),
    ...(readyRows === null ? [`the Ready rows of ${scope.tracker?.repo}`] : []),
  ];
  const openPrs = prs ?? [];
  const rows = readyRows ?? [];
  const allOpen = openRows ?? [];
  const code = inRepo(read.codeRepo, () => readings.code(openPrs, scope));
  const tracker = scope.tracker === null ? NO_TRACKER_READINGS : inRepo(read.trackerRepo, () => readings.tracker({ rows, allOpen }));
  const prFiles = comparablePrFiles([...openPrs, ...(read.siblingPrs ?? [])], { trackerRepo: scope.tracker?.repo });
  // WHAT THE TRACKER READINGS RETURN IS TAGGED HERE, not inside them: an epic or a closed row that carried no key would make `epic-7` and
  // `answer-owed/row-7` the primary's, whatever the reading that produced it.
  const mark = (/** @type {any[] | null} */ list) => tagged(list, scope.key, read.trackerRepo) ?? [];
  const orders = decide({ prs: code.prs, readyRows: rows, promotableRows: promotableRows ?? [],
    chairmanBlocked: chairmanBlocked ?? [], prFiles, drain, required: code.required, baseTip: code.baseTip,
    epics: mark(tracker.epics), answerOwed: rowsOwingAnswers({ openRows: allOpen, openPrs, closedRows: mark(tracker.closedRows) }),
    openRows: allOpen, claimedComments: tracker.claimedComments, unarmed: code.unarmed, closings: tracker.closings, trunkRed: code.trunkRed,
    key: scope.key, repo: scope.code?.repo ?? scope.tracker?.repo });
  return { orders: orders.map((order) => ({ ...order, prompt: `${order.prompt}${repositoryNote(scope)}` })),
    blocked: partitionUnclaimed(rows, prFiles, { rowBranches: null, openRows: allOpen }).blocked, refused };
}

/**
 * The reads about a scope's PULL REQUESTS that are made per tick beyond the list itself, and about its `main` (#3079). Run inside `inRepo` for the code repository.
 * `trunkRed` is `undefined` for a scope with no code repository, and `null` for a green or an unreadable `main`: neither emits an order.
 * @param {any[]} openPrs @param {Scope} scope
 */
function codeReadings(openPrs, scope) {
  const required = requiredWhenNeeded(openPrs);
  const split = readEjections(readUnarmed(shouldBeMerging(openPrs, required)));
  return { prs: withVerifyStamps(withEjections(withEvidenceLabelAges(withPatchIds(openPrs)), split?.ejections), { checkout: verifyCheckoutOf(scope.key) }), required, baseTip: baseTipWhenRed(openPrs),
    unarmed: split === null ? null : split.unarmed,
    trunkRed: readScopeTrunkRed(scope) };
}

/**
 * Whether a scope's own `main` is red, as `readTrunkRed` says it -- `undefined` for a scope with no code repository, which has no `main` to ask.
 * @param {Scope} scope @param {(args: string[]) => string} [run]
 */
export function readScopeTrunkRed(scope, run) {
  return scope.code === null ? undefined : readTrunkRed(run, trunkOfCodeRepository(scope.key, scope.code.repo));
}

/**
 * #3019: STAMP `ejection` ON THE PULL REQUESTS THE QUEUE EJECTED, so `stallReasonOf` -- which reads only the pull request --
 * can classify them. Absent is not `null`: a pull request nobody read stays unstamped and is never accused.
 * @param {any[]} prs @param {Map<number, unknown> | undefined} ejections
 */
function withEjections(prs, ejections) {
  if (!ejections || ejections.size === 0) return prs;
  return prs.map((pr) => (ejections.has(Number(pr?.number)) ? { ...pr, ejection: ejections.get(Number(pr.number)) } : pr));
}

/**
 * What a scope with NO tracker of its own reads from a tracker: nothing, in the shapes an empty tracker returns. `inRepo(undefined)` means the
 * AMBIENT repository, which is the primary's, so asking would hand the primary's closed rows to a scope that has no such rows, and each would
 * come back as an `answer-owed` order naming a repository where the row does not exist (#3493).
 */
const NO_TRACKER_READINGS = { claimedComments: [], epics: [], closedRows: [], closings: null };

/**
 * The reads about a scope's ROWS that are made per tick beyond the lists themselves. Run inside `inRepo` for the tracker repository.
 * @param {{ rows: any[], allOpen: any[] }} lists
 */
function trackerReadings({ rows, allOpen }) {
  return { claimedComments: claimedRowCommentsWhenHeld(allOpen) ?? [], epics: epicsWhenShelfEmpty(rows),
    closedRows: closedAnswerRows(), closings: closingsWhenRowsCleared(allOpen) };
}

/**
 * Every NON-PRIMARY scope the declaration lists, with its lanes read ONCE. Empty for one project, which is what keeps one project's orders
 * identical to what they were. #3095: read BEFORE the primary's own B4 comparison, because that comparison needs these pull requests too,
 * and handed on to `otherScopeTicks` so it is not a second read.
 * @param {(args: string[], repo?: string) => string} [run]
 * @returns {{ scope: Scope, read: ReturnType<typeof readLanes> }[]}
 */
export function readOtherScopes(run = defaultRun) {
  return scopesOf([homeProjectDeclaration()]).filter((scope) => scope.key !== "").map((scope) => ({ scope, read: readLanes(scope, run) }));
}

/**
 * #3095: THE OPEN PULL REQUESTS OF EVERY DECLARED CODE REPOSITORY BUT ONE -- the one `skip` names (the primary's own, `undefined`, or a
 * scope's key) -- each tagged with the repository it came from. B4 at the claim compares a row with ALL of them (`lookupOpenPrFiles`, #2617),
 * so a gate that compares with fewer offers every tick what the claim refuses every tick. A lane that could not be read contributes nothing:
 * THE GATE FAILS OPEN and the claim stays the authority, and `scopeTick`'s `refused` names the repository (`unreadLanes`).
 * @param {{ scope: Scope, read: ReturnType<typeof readLanes> }[]} others @param {string} [skip] the key of the scope whose own list is not a sibling
 * @returns {any[]}
 */
export function pullRequestsOfOthers(others, skip) {
  return others.filter(({ scope }) => scope.key !== skip).flatMap(({ read }) => read.prs ?? []);
}

/**
 * Every NON-PRIMARY scope, ticked from lanes already read. Each is told the pull requests of every OTHER declared code repository -- the
 * primary's (`primaryPrs`) and its peers' -- for B4 (#3095).
 * @param {boolean} drain @param {{ scope: Scope, read: ReturnType<typeof readLanes> }[]} others @param {any[]} primaryPrs
 */
function otherScopeTicks(drain, others, primaryPrs) {
  return others.map(({ scope, read }) => scopeTick(scope, drain, { ...read, siblingPrs: [...primaryPrs, ...pullRequestsOfOthers(others, scope.key)] }));
}

/**
 * Every lane this tick could not read, named -- the primary's own two and each other scope's. A refusal in one repository is
 * REPORTED beside the orders the others produced and never drops them (#2618).
 * @param {{ prs: any[] | null, readyRows: any[] | null, others: { refused: string[] }[] }} reads
 * @returns {string[]}
 */
export function unreadLanes({ prs, readyRows, others }) {
  return [...(prs === null ? ["the pull-request list"] : []), ...(readyRows === null ? ["the Ready rows"] : []),
    ...others.flatMap((tick) => tick.refused)];
}

/**
 * How many of THIS TICK's OWN reads GitHub refused. `readPrs`, `readReadyRows`, `readPromotableRows`,
 * `readChairmanBlocked`, `readOpenRows`, the claimed-row comments and the board read each make their OWN
 * call, sharing no socket and no endpoint with the others -- so one going quiet is that endpoint's own
 * trouble, needing no shared story. Counted here rather than asked per read, because the question this
 * answers is not "was THIS read refused" (every read already fails open at its own site: `promotableRows
 * ?? []`, `offBoard`'s "emits nothing") but "how many were, in the SAME tick" (#2685).
 * @param {(any[] | null)[]} reads
 * @returns {number}
 */
export function refusedReadCount(reads) {
  return reads.filter((read) => read === null).length;
}

/**
 * TWO, chosen and not measured, and deliberately no higher. `deliver`'s own shared-resource shape
 * (#2256) put ELEVEN causes at the cap over ONE session's unavailability -- the session was the only
 * thing all eleven had in common, and nothing waited for a third before treating it as one outage. A bar
 * set any higher here would miss the same shape for this shared resource.
 */
export const SHARED_OUTAGE_READS = 2;

/**
 * Did GitHub itself refuse THIS TICK's reads -- as opposed to one lane's own trouble? Neither `outageOf`
 * (a causeKey's own addressed SESSION being unavailable, #2256) nor #2031's pool-exhaustion guard asks
 * this: both ask about a SESSION or a POOL, never about the reads a tick itself just made.
 * @param {number} refusedCount @returns {boolean}
 */
export function sharedReadOutage(refusedCount) {
  return refusedCount >= SHARED_OUTAGE_READS;
}

/**
 * Mark every order this tick emits with `outageNow` when this tick's own reads carry the shared-outage
 * shape (`sharedReadOutage`) -- ONE fact, attached beside every order, so `wake.mjs`'s `deliver` can tell
 * several causes reaching `MAX_DELIVERIES` in the SAME run for ONE shared reason apart from N causes each
 * independently and truly stuck (#2685). Untouched when there is no outage, so an ordinary order stays
 * byte-identical to what it always was.
 * @param {any[]} orders @param {boolean} outage
 * @returns {any[]}
 */
export function markOutageReads(orders, outage) {
  return outage ? orders.map((order) => ({ ...order, outageNow: true })) : orders;
}

/**
 * THIS TICK'S OWN SHARED-OUTAGE READING (#2685): every read whose refusal is distinguishable from "found
 * nothing", from the primary scope and every other declared one (`others`' own `refused` already counts
 * each of ITS unread lanes by name, the same way `unreadLanes` reports them).
 * @param {{ prs: any[] | null, readyRows: any[] | null, promotableRows: any[] | null, chairmanBlocked: any[] | null,
 *   openRows: any[] | null, claimedComments: any[] | null, offBoard: any[] | null, others: { refused: string[] }[] }} reads
 * @returns {boolean}
 */
function outageThisTick({ prs, readyRows, promotableRows, chairmanBlocked, openRows, claimedComments, offBoard, others }) {
  return sharedReadOutage(refusedReadCount([prs, readyRows, promotableRows, chairmanBlocked, openRows, claimedComments, offBoard])
    + others.reduce((n, tick) => n + tick.refused.length, 0));
}

/**
 * SAY WHICH LANES WENT UNREAD AND END THE TICK `PARTIAL` -- the orders already printed stay real, and none is dropped.
 * @param {string[]} unread @param {number} delivered @returns {never}
 */
function exitPartial(unread, delivered) {
  process.stderr.write(`PARTIAL: could not read ${unread.join(" and ")}. `
    + `The ${delivered} order(s) above are real; ${unread.length === 1 ? "that lane was" : "those lanes were"} NOT examined and may hold work.\n`);
  process.exit(EXIT.PARTIAL);
}

/**
 * #2849: `decide`, with the call RECORDED for the shadow-window runner (#2846): the arguments it was given and its RAW return, before
 * `withStalePrimaryNotice`. A helper rather than three lines in `main`, which is at its physical-line limit. DORMANT unless
 * `<stateDir>/shadow-window-open` exists, and a failed write is a stderr line, never a different tick (`shadow-reads.mjs`).
 * @param {Parameters<typeof decide>[0]} args @returns {ReturnType<typeof decide>}
 */
function decideAndTap(args) {
  const orders = decide(args);
  tapShadowReads({ args, orders, stateDir: REVIEWER_STATE_DIR });
  reportClearingDrops(args);
  return orders;
}

/**
 * #3451: what `decide`'s `blocker-cleared` cause did NOT order, said on the tick's log the way `SHELVED row #n:` says a shelved row, so a row that stopped being asked is
 * findable. A second pure reading of the same arguments (no read, no write) rather than a side channel out of `decide`, which returns orders and nothing else.
 * @param {Parameters<typeof decide>[0]} args
 */
function reportClearingDrops({ openRows, prs, closings, claimFacts }) {
  process.stderr.write(blockerClearedReading(openRows, todayIso(), Date.now(), { openPrs: prs, closings, claimFacts }).log.join(""));
}

/**
 * `claimStallsNow`'s orders beside the facts it built them from, as the two arguments `decide` takes: the facts reach `blockerClearedOrders` and the orders reach
 * `claim-stalled`. `claimFacts` stays `undefined` when the tick never reported one, which `blockerClearedReading` reads as "not asked".
 * @param {Parameters<typeof claimStallsNow>[0]} rows @param {Parameters<typeof claimStallsNow>[1]} claimedComments @param {Parameters<typeof claimStallsNow>[2]} prs
 * @returns {{ claimStalls: ReturnType<typeof claimStallsNow>, claimFacts: import("./work-gate/claim-stall-tick.mjs").ClaimFactsOfTick | null | undefined }}
 */
function claimStallsWithFacts(rows, claimedComments, prs) {
  /** @type {import("./work-gate/claim-stall-tick.mjs").ClaimFactsOfTick | null | undefined} */
  let claimFacts;
  const claimStalls = claimStallsNow(rows, claimedComments, prs, { onFacts: (facts) => { claimFacts = facts; } });
  return { claimStalls, claimFacts };
}

/**
 * The open pull requests whose required check has settled red AND which `pr-checks-failing` is already ordering this tick, as
 * `org-health.mjs` reads them. THE ORDERS ARE CONSUMED RATHER THAN THE PREDICATE REPEATED: `failingChecksOrder` also excuses a
 * red made only of a superseded run, and a second copy of those exclusions is how a PR is called red by one cause and healthy by
 * another (`mergeCandidates`' argument). BUT THE HOLD'S EXCUSE IS THE ORDER'S AND IS ADDRESSEE-RELATIVE (#2400), so a PR a worker owns
 * and `ceo` holds is still ordered; WHETHER IT IS RED AT ALL is `red-pr.mjs`'s `isBrokenRed`, asked here too (#2956), and `redSince`
 * is the EARLIEST BROKEN check's finish (`redSinceOf`), which is when its breakage began.
 *
 * #2996: `holdStands` IS WHETHER A HOLD STILL EXCUSES (`holdExcused`), so a PR whose hold has outlived its reason is red for ITS
 * OWN jobs and is read here even though `failingChecksOrder` excused it: the order excuses the addressee's own hold, which is the
 * label trusted, and a freeze that ended is the case this exists for. A PR with a hold and no order is read only when the hold lapsed.
 * @param {any[]} prs @param {{ cause: string, subject: string }[]} decided @param {{ holdStands?: (pr: any) => boolean }} [options]
 */
export function redPrFacts(prs, decided, options = {}) {
  const ordered = new Set(decided.filter((order) => order.cause === "pr-checks-failing").map((order) => order.subject));
  const asked = (/** @type {any} */ pr) => ordered.has(`pr-${subjectRef(pr.repoKey, pr.number)}`) || holdersOf(labelsOf(pr)).length > 0;
  return prs.filter((pr) => asked(pr) && isBrokenRed(pr, options)).map((pr) => {
    const owner = ownerOfPr(pr);
    const login = pr.author?.login;
    return { number: pr.number, owner: owner.source === "ceo" ? null : owner.session,
      redSince: redSinceOf(pr, options),
      // The shared account opens every PR, so "its owner's comment" is a comment by the account that opened it.
      ownerCommentAts: (pr.comments ?? []).filter((/** @type {any} */ c) => login && c?.author?.login === login).map((/** @type {any} */ c) => Date.parse(c?.createdAt)).filter(Number.isFinite) };
  });
}

function main() {
  refuseUnknownFlags([], { entry: import.meta.url, command: "node packages/agent-org/src/work-gate.mjs" });
  // READ BEFORE ANY GITHUB CALL (#2163), because it is the one reading a `CANNOT_ASK` exit must not hide: a tick
  // that cannot reach GitHub delivers nothing, so on that path the stderr line is the only thing that says the
  // disk is full. Its ORDER is put in front of the others further down.
  const diskOrders = diskHeadroomTick();
  const prs = readPrs();
  const readyRows = readReadyRows();

  // BOTH LANES REFUSED IS `CANNOT_ASK`; ONE IS `PARTIAL`. Nothing here may report a refused read as quiet.
  if (prs === null && readyRows === null) {
    process.stderr.write(cannotAskReport({ run: defaultRun, identity: declaredGhAccount() }));
    process.exit(EXIT.CANNOT_ASK);
  }

  // The third read is only needed to size the refill, and a refused one must not read as an empty shelf.
  const promotableRows = readPromotableRows();
  const chairmanBlocked = readChairmanBlocked();
  const unreadChairmanRows = chairmanReadsRefused(chairmanBlocked ?? []); // #3390: said, not skipped -- an unread row is not an unanswered one
  if (unreadChairmanRows.length > 0) process.stderr.write(`chairman-answered: could not read the timeline of ${unreadChairmanRows.map((n) => `#${n}`).join(", ")}; those rows are NOT checked this tick\n`);
  // ONE COALESCE PER REFUSED LANE, NAMED. `prs ?? []` was written three times and `readyRows ?? []` twice;
  // each repetition is a branch `complexity` counts, and the names say what an empty list MEANS here --
  // a lane that could not be read, already reported as PARTIAL below, never a lane that is empty.
  const openPrs = prs ?? [];
  const rows = readyRows ?? [];
  const otherScopes = readOtherScopes(); // #3095: read here, once -- B4 below compares with their pull requests, and `otherScopeTicks` ticks them
  const prFiles = comparablePrFiles([...openPrs, ...pullRequestsOfOthers(otherScopes)]);
  const drain = draining();
  // ONE READ, THREE CAUSES -- and the refusal is kept BESIDE the coalesced list rather than instead of
  // it. `decide`'s label-derived causes want a list to filter, and an empty one is the right degradation
  // there; the dead man's switch needs to tell "refused" from "empty", so it is handed the raw result.
  // Both names exist so neither reader has to infer which of the two it was given (#1938).
  const openRowsRead = readOpenRows();
  const allOpen = openRowsRead ?? [];
  const claimedComments = claimedRowCommentsWhenHeld(allOpen);
  // #2031: A LOCAL git CALL, NOT AN API ONE -- it adds nothing to `GH_READS` and cannot be refused by an
  // exhausted pool, which is the whole reason the detection can exist. `GIT_READS` counts it.
  const rowBranches = readRowBranches();
  const pools = []; // #3448: the GraphQL budget the off-board read names, handed to the org-health tick
  const offBoard = rowsOffBoardOrSay(undefined, pools), primaryDrift = readPrimaryDriftNow(); // #2781: local git, once; it feeds `decide` and banners its orders
  // #1969: NAMED RATHER THAN CALLED TWICE. `shouldBeMerging` needs the same answer `decide` does, and
  // `requiredWhenNeeded` makes a `gh` call when anything is red -- calling it inline in both places would
  // pay for it twice on exactly the red tick this row is about.
  const required = requiredWhenNeeded(openPrs);
  const baseTip = baseTipWhenRed(openPrs), armingSplit = readEjections(readUnarmed(shouldBeMerging(openPrs, required))); // #3019: BEFORE the arguments -- ejected PRs are stamped onto `prs` and leave `unarmed`
  const decideArgs = { primaryDrift, prs: withVerifyStamps(withEjections(withPrOwners(withEvidenceLabelAges(withPatchIds(openPrs)), allOpen, stampLookup(), { agents: liveWorkspaceLabels, ended: endedSessionLabels }), armingSplit?.ejections), { checkout: verifyCheckoutOf("") }), readyRows: rows, promotableRows: promotableRows ?? [],
    chairmanBlocked: chairmanBlocked ?? [], prFiles, drain, required, baseTip,
    epics: epicsWhenShelfEmpty(rows),
    answerOwed: rowsOwingAnswers({ openRows: allOpen, openPrs, closedRows: closedAnswerRows() }),
    openRows: allOpen,
    // #2110: CONDITIONAL, and the condition is answered for free from the list already in hand --
    // `readOpenRows` fetched the labels, so "is anything claimed at all" costs no call. A quiet org with
    // nothing in progress pays nothing; a busy one pays exactly one, whatever the size of the queue.
    claimedComments: claimedComments ?? [],
    // #2470: the SAME comments, read once, and the raw `null` kept for the reader that must tell "refused" from "none".
    ...claimStallsWithFacts(openRowsRead, claimedComments, prs), // #3451: the orders AND the facts they were built from
    // #1969: CONDITIONAL, and the condition is answered for free from the list already in hand.
    // `shouldBeMerging` reads `openPrs`; only if it finds a green, unheld, non-draft PR is the
    // merge-queue call made at all.
    unarmed: armingSplit === null ? null : armingSplit.unarmed, rowBranches, claimRefusals: offeredRefusalStreaks(rows, prFiles, { rowBranches, openRows: allOpen }),
    // #2174: A LOCAL READ, NOT AN API ONE -- a `readdir`, some `readFileSync` and one `systemctl` spawn
    // per shipped timer. It adds nothing to `GH_READS` and cannot be refused by an exhausted pool, which
    // is what lets the detection exist at all.
    hostDrift: readHostDrift(),
    // #2286: CONDITIONAL, and the condition is answered for free from the list already in hand.
    closings: closingsWhenRowsCleared(allOpen),
    // #2356: `null` for a refused read or a green `main`, and the two need no telling apart HERE -- both
    // emit nothing, and a refused read is not reported as health because nothing else reads "trunk is fine".
    trunkRed: readTrunkRed(),
    // #2075: ONE GRAPHQL CALL, READ PER ISSUE. `null` (refused) emits nothing and is said on stderr below.
    // #2691's `callCountSignals` is beside it, costing no `GH_READS`; `claimedComments` (#2710's window anchor) is the SAME read made above.
    offBoard, callCountSignals: rowCallCountSignals(allOpen, liveClaudeTurns(), claimedComments, { waitClearedAt: readWaitClearedAt }), bareAnswerLabels: bareAnswerLabelOrders(withAnswerLabel([...allOpen, ...openPrs])), labJobs: labJobRecordsOrSay() }; const decided = withStalePrimaryNotice(decideAndTap(decideArgs), primaryDrift); // #2711, #2729; `main` is at its 90-line limit
  const others = otherScopeTicks(drain, otherScopes, openPrs); // #2618: the OTHER declared repositories -- none for one project, whose orders are what they were
  const outageNow = outageThisTick({ prs, readyRows, promotableRows, chairmanBlocked, openRows: openRowsRead, claimedComments, offBoard, others });
  const { delivered: orders, performed } = performActions(markOutageReads([...decided, ...others.flatMap((tick) => tick.orders)], outageNow));
  orders.push(...reviewerAuthTick({ orders }), ...repeatingLinesTick(), ...orgHealthNow({ prsRead: prs, readyRead: readyRows, openRowsRead, claimedComments: claimedCommentsForClock(allOpen, claimedComments), decideArgs, decided, pools }, { readToolAgreement }),
    ...rulingOrdersNow({ prsRead: prs, openRowsRead, now: Date.now() })); // #2848, #2936, #2997: before the dead man's switch -- a repeating line, a stuck org: something found
  // FIRST OF ALL, AND ON PURPOSE (#2163): `wake` delivers in this order and records each delivery with a write, so
  // on a full disk the tick can end partway. The order that says the disk is full must not be the one behind it.
  orders.unshift(...diskOrders);
  orders.push(...deadMansSwitch({ orders, drain, performed, openRows: openRowsRead }), ...retrospectiveTick()); // #2938: AFTER the switch, which reads `orders` -- a once-a-day offer must not mask a stall
  for (const order of orders) process.stdout.write(`${JSON.stringify(order)}\n`);

  // BOTH SHELVES ON ONE LINE-SHAPE. The engineer pool's B4/declared-wait shelvings and the fleet batch's
  // (#2027) are the same fact -- work the gate can see and is deliberately not offering -- and a row that
  // leaves a set silently is the defect both filters exist to fix.
  reportWithheld({ drain, blocked: [...partitionUnclaimed(rows, prFiles, { rowBranches, openRows: allOpen }).blocked,
    ...partitionFleetBatch(allOpen).waiting, ...others.flatMap((tick) => tick.blocked)] });

  const unread = unreadLanes({ prs, readyRows, others });
  if (unread.length > 0) exitPartial(unread, orders.length);
  // PERFORMED COUNTS AS WORK. A tick that marked a draft ready did something, and exiting QUIET would
  // report it as an idle org to every reader of this exit code.
  process.exit(orders.length > 0 || performed > 0 ? EXIT.WORK : EXIT.QUIET);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();

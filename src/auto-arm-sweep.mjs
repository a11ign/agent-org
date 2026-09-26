#!/usr/bin/env node
// @ts-check
// command: arm auto-merge on open PRs that predate auto-arm.yml and were never armed
// ARM THE PRs `auto-arm.yml` STRUCTURALLY CANNOT SEE -- the ones that were already open. #344.
//
// `auto-arm.yml` triggers on `pull_request: [opened, ready_for_review]`. A PR that was already open when
// that workflow shipped (10:38Z, 2026-09-07) has no such event left to fire, so nothing ever armed it and
// nothing ever would. Measured at 11:35Z, four hours later:
//
//   [276, 183, 181, 172]   open, base main, not draft, autoMergeRequest = null
//
// #183 and #181 had been GREEN ON `gate` and unarmed since 01:39 and 01:27. `synchronize` would not have
// fixed it: a PR nobody pushes to produces no `synchronize` event any more than a second `opened`.
//
// ## Why this is not a scheduled sweep
//
// `board-liveness.test.ts` pins the measurement: GitHub disables scheduled workflows repository-wide after
// 60 days of inactivity, and `board-schedule-liveness.test.ts` records `board-report.yml` firing ZERO
// scheduled runs the day after it was added. An arming sweep on a cron fails by STOPPING SILENTLY, and its
// symptom -- PRs quietly not merging -- reads as workers being slow rather than as a dead trigger. Riding
// the `pull_request` trigger cannot have that fault: the event it needs is another PR being opened, which
// in this repo is the most frequent event there is (11 in the hour this was measured).
//
// ## The predicate is STRICTER than the `arm` job's, deliberately
//
// The `arm` job's population is a PR opened seconds ago: its head is current by construction and nobody is
// inside it yet, so "open, base main, not draft" is the whole question. This job's population is the
// opposite -- a PR that has been STANDING, long enough that what was true when it opened may not be now.
// Three of the four it was built for must not be armed on sight, each for a reason a machine can check:
//
//   NO CHECK RUNS (#172)   `merge-guard.mjs`'s own headline: a required context that never ran is not a
//                          failing check, it is the ABSENCE of one, and it reads as CLEAN. Arming it is
//                          harmless (GitHub withholds), and REPORTING it is the useful act -- a PR nothing
//                          has ever tested is STRANDED, not slow, and needs a push, not patience.
//   HELD (#183)            it carries `session:worker-capture`. #266/#268's rule: on a PR the `session:`
//                          label IS the hold, and arming a PR somebody is working inside is the collision
//                          that rule was measured into existence by (#258, and #197's three
//                          double-dispatches before it).
//   BLOCKED (#181)         a 1,337-line move refused on its move-check by a person, and a green `gate`
//                          says nothing about that. There is no machine-checkable form of "somebody
//                          refused this", so it carries `blocked` -- ON THE PR, where its author can see
//                          the refusal, and NOT as a PR number hard-coded in a workflow. A number in a
//                          file is a fact stated twice with nothing comparing the copies, and it outlives
//                          its reason silently.
//
// Everything else is armed, on the same argument `auto-arm.yml` makes for arming at all: GitHub cannot
// complete a merge this arms without `gate`, and therefore `mergeSafety`, reporting green for the real,
// current head.
//
// ## It reports every PR it did NOT arm, and why
//
// A sweep that silently skips is a queue-drainer reporting success having drained nothing -- this
// repository's most-recorded defect, arriving in the one place whose whole job is to notice a stalled
// queue. Every skip prints its reason, and an arming FAILURE does not end the loop: failures are collected
// and the run exits non-zero naming them, so one unarmable PR cannot strand the rest.
//
// IT TAKES NO ARGUMENTS, AND THAT IS PRECISELY WHY IT IS GUARDED RATHER THAN SKIPPED.
//
// The first version of this comment said the opposite -- "no flag to mistype, so it is not an argv-reading
// module" -- and `cli-flags.test.ts` refused it: #164 widened that census to top-level `scripts/`, and a
// command with NO flags is exactly where a mistyped one is discarded in silence and the default reported
// as success. `check-preregistered-verdict.mjs` and `build-packages.mjs` both call it with an empty list
// for the same reason. An argument handed to this sweep means the caller wanted something other than
// "arm the standing queue", and running the sweep anyway would answer a question nobody asked.
//
// THE IMPORT IS RELATIVE, never `@a11ign/worker-fleet/cli-flags`. The package specifier resolves to
// `dist/cli-flags.mjs`, so it needs `npm ci` AND a build to have happened -- and this job deliberately has
// neither, only `actions/checkout`. #330 and #331 are what that circular bootstrap costs: a top-level
// workspace import in `build-packages.mjs` took `main` down, and every worktree symlinking `node_modules`
// to a sibling's inherited a stale `dist` and never saw it fail locally. `cli-flags.mjs` itself imports
// only `node:path`, `node:fs` and `node:url`, so the relative form needs nothing installed.
//
// Exit codes are the contract:
//   0  the queue is drained -- everything armable was armed, and every skip was reported with its reason
//   1  at least one PR could not be armed. NAMED, never counted.
//   2  a lookup failed. INCONCLUSIVE, never "fine".
import { execFileSync } from "node:child_process";
import { refuseUnknownFlags } from "./lib/cli-flags.mjs";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { armabilityOf, HOLD_PREFIX } from "./pr-hold-state.mjs";
// A LEAF (no imports), so this job's `actions/checkout`-only bootstrap still resolves it.
import { PARITY } from "./review-attribution.mjs";
// #2046: ONE PLACE DECIDES WHETHER A PR IS ARMED, the way `pr-hold-state.mjs` above owns whether it is
// held. The rule was written here and `arm-pr.mjs`'s refusal path did not call it, which is the third
// row of the same shape (#1729, #2004, #2046) -- so it moved out to a module with no imports, and this
// file is now one of its readers rather than its owner.
import { armedFromApi, armedQueryArgs } from "./pr-armed-state.mjs";

// RE-EXPORTED, NOT REDEFINED. `work-gate.mjs` imports `armedFromApi` from this file and its own header
// reasons about the shape of that import graph -- `pr-armed-state.mjs` is leaf-shaped, so the property
// the gate states about itself still holds through this line.
export { armedFromApi };

export const EXIT = { DRAINED: 0, COULD_NOT_ARM: 1, CANNOT_ASK: 2 };

/**
 * #1595: LABELS THAT LOOK LIKE A HOLD AND ARE NOT ONE.
 *
 * On 2026-09-14 #1592 carried a hand-added `pr:hold` and auto-merge switched off; this sweep armed it at 12:33:24Z
 * and it merged eleven seconds later. The sweep was right -- `pr:hold` is the NAME of the command that writes a
 * hold, not a hold -- and silent, so the person who added it believed the PR was held until it merged. `session:`
 * is on the list because it was the hold label until 2026-09-09 and is ownership now. Warning only: the ONE hold
 * spelling is `HOLD_PREFIX`, and a second spelling that also refused would be the fact stated twice again.
 *
 * @param {string[]} labels
 * @returns {string[]} the lookalikes, in the PR's own label order
 */
export function holdLookalikes(labels) {
  return labels.filter((label) => !label.startsWith(HOLD_PREFIX)
    && (["pr:hold", "hold", "held"].includes(label.toLowerCase()) || label.startsWith("session:")));
}

/**
 * #1595: the decision for one PR, with a warning printed for each hold lookalike FIRST. The warnings never change
 * the answer: this returns `sweepDecision`'s own result, so a lookalike on a green, unheld PR still arms.
 *
 * @param {{ number: string | number, labels: string[], checkRunCount: number }} pr
 * @param {{ log?: (line: string) => void }} [io]
 * @returns {{ arm: boolean, reason: string }}
 */
export function decideAndWarn({ number, labels, checkRunCount }, { log = console.log } = {}) {
  for (const label of holdLookalikes(labels)) {
    const why = label.startsWith("session:")
      ? "a `session:` label is OWNERSHIP, not a hold, since 2026-09-09"
      : "no code reads it";
    log(`SWEEP: #${number} carries \`${label}\`, which looks like a hold but is not one (${why}) -- a hold is `
      + `\`npm run pr:hold -- ${number} --session=<name>\` (\`${HOLD_PREFIX}<name>\`)`);
  }
  return sweepDecision({ labels, checkRunCount });
}

/**
 * MAY AN UNATTENDED SWEEP ARM THIS PR? -- the whole decision, as one pure function.
 *
 * Separated from the `gh` calls so it can be driven with real shapes rather than asserted against the
 * text of a shell script. A guard whose expectations are scraped out of the source it is testing is this
 * repository's own recorded defect (`SIGNAL_TYPES`, the `sweepLog` regex) -- both passed having examined
 * nothing.
 *
 * `parity` is `review-attribution.mjs`'s own answer for the review that would arm this PR (#2195), and ONLY
 * `violation` refuses. `correct`, absent and `unobservable` all arm: `unobservable` is deliberate, because it
 * was every review's answer before attribution recorded and refusing on it would stop the queue rather than
 * the defect. #2079 was armed on an off-parity approval and the parity owner's refusal landed 61s later.
 * `parityOwner` and `reviewedBy` only make the refusal say WHO -- the author needs both to re-prompt.
 *
 * @param {{ labels: string[], checkRunCount: number, holdReason?: string | null, parity?: string,
 *           parityOwner?: string, reviewedBy?: string[] }} pr
 * @returns {{ arm: boolean, reason: string }}
 */
export function sweepDecision({ labels, checkRunCount, holdReason = null, parity, parityOwner, reviewedBy = [] }) {
  if (labels.includes("blocked")) {
    return { arm: false, reason: "labelled `blocked` -- a person refused this one, and a green `gate` does not answer that" };
  }
  // ONE PLACE DECIDES WHETHER A PR IS HELD (#645). This was written here and NOT in `auto-arm.yml`'s
  // per-PR `arm` job, so a held PR was refused by the sweep and re-armed by its own next event -- the
  // fact-stated-twice shape, with only one copy correct. Both callers now read `pr-hold-state.mjs`.
  const held = armabilityOf({ labels, holdReason });
  if (!held.arm) return held;
  if (parity === PARITY.violation) return { arm: false, reason: parityViolationReason({ parityOwner, reviewedBy }) };
  if (checkRunCount === 0) {
    return {
      arm: false,
      reason: "NO CHECK RUNS EXIST for its head -- not one, ever. Nothing has tested this code; push to the "
        + "branch to trigger `ci.yml`. This is STRANDED, not slow",
    };
  }
  return { arm: true, reason: `${checkRunCount} check run(s) on its head` };
}

/**
 * WHY AN OFF-PARITY REVIEW DOES NOT ARM, saying by whom and who should have (#2195). A bare "refused" costs the
 * author the re-prompt this refusal exists to make possible. Names are optional so a caller that knows only
 * the verdict still gets a reason that says what rule was broken.
 * @param {{ parityOwner?: string, reviewedBy: string[] }} who
 */
function parityViolationReason({ parityOwner, reviewedBy }) {
  const by = reviewedBy.length > 0 ? reviewedBy.map((s) => `\`${s}\``).join(", ") : "a session other than its parity owner";
  const owner = parityOwner ? `\`${parityOwner}\`` : "its parity owner";
  return `reviewed off parity -- by ${by}, and the parity rule gives this PR to ${owner}. Arming now would queue it before `
    + `${owner}'s verdict can stop it (#2079); prompt ${owner} for a verdict at this head`;
}

/**
 * DID THIS PR MERGE BETWEEN THE CANDIDATE READ AND THE ARM? Asked of the API, never inferred from the
 * failure's message: `gh pr merge --auto` exits non-zero for a merged PR, an unmergeable one and a
 * network fault alike.
 *
 * ASKED MORE THAN ONCE (#1306). The race it answers is the `arm` job merging the very PR this sweep listed,
 * and ONE read at that instant got the pre-merge answer: 3 of 3 `pull_request` failures of `auto-arm` on
 * 2026-09-13 (#1289, #1291, #1295) printed FAILED TO ARM in the same second as the PR's `merged_at`, or one
 * second after it. So a `false` is re-read, a bounded number of times with a named wait between, before it
 * is believed.
 *
 * UNREADABLE IS NOT MERGED. A lookup that fails counts as `false`, so the caller reports FAILED TO ARM --
 * which is the honest answer, because not knowing why an arm failed is not the same as knowing it was
 * harmless. This is `armabilityOf`'s "Unreadable is not unheld" pointed at a different question. But the
 * failure is PRINTED WITH ITS CAUSE: a bare `catch` made "the lookup failed" and "not merged yet" the same
 * FAILED TO ARM line, which is why #1306 could not say which of the two its third case was.
 *
 * @param {string} number @param {string} repo
 * @param {{ read?: (number: string, repo: string) => boolean, sleep?: (ms: number) => void,
 *           log?: (line: string) => void }} [deps]
 * @returns {boolean}
 */
export function mergedMeanwhile(number, repo, { read = readMerged, sleep = sleepSync, log = console.log } = {}) {
  return retryRead({ number, repo, label: "merged-meanwhile", reads: MERGED_MEANWHILE_READS,
    waitMs: MERGED_MEANWHILE_WAIT_MS, read, sleep, log });
}

/**
 * THE BOUNDED, WAITED RE-READ ITSELF, shared by `mergedMeanwhile` (#1306) and `confirmArmed` (#1729) --
 * same race, asked of a different field. Believes the first `true`; a throw is logged WITH ITS CAUSE and
 * counts as `false` for that attempt, never short-circuiting the loop, because not knowing why a read
 * failed is not the same as knowing the thing it was asking about is false.
 * @param {{ number: string, repo: string, label: string, reads: number, waitMs: number,
 *           read: (number: string, repo: string) => boolean, sleep: (ms: number) => void,
 *           log: (line: string) => void }} args
 * @returns {boolean}
 */
function retryRead({ number, repo, label, reads, waitMs, read, sleep, log }) {
  for (let attempt = 1; attempt <= reads; attempt += 1) {
    try {
      if (read(number, repo)) return true;
    } catch (cause) {
      log(`SWEEP: #${number} ${label} read ${attempt}/${reads} FAILED -- `
        + `${cause instanceof Error ? cause.message : cause}`);
    }
    if (attempt < reads) sleep(waitMs);
  }
  return false;
}

/**
 * THE BOUND ON THAT RE-READ (#1306), named because neither number explains itself. The measured failures sat
 * within about a second of `merged_at`, so three waits of two seconds give the API six seconds to catch up,
 * and a genuinely failed arm costs the sweep at most that long before it reports FAILED TO ARM.
 */
export const MERGED_MEANWHILE_READS = 4;
export const MERGED_MEANWHILE_WAIT_MS = 2_000;

/** One read of whether the PR merged, from the API. @param {string} number @param {string} repo */
function readMerged(number, repo) {
  const pr = JSON.parse(gh(["api", `repos/${repo}/pulls/${number}`, "--jq", "{merged: .merged}"]));
  return pr?.merged === true;
}

/**
 * DID THE ARM ACTUALLY TAKE? Asked of the API, never inferred from `gh pr merge --auto` not throwing
 * (#1729). `gh` printed "already queued to merge" to STDERR while exiting 0 for #1727 -- the success
 * path ran, `ARMED` was logged, and `autoMergeRequest` stayed `null` for 6+ minutes across two sweeps.
 * The shell call not throwing is evidence the command was accepted, not evidence the mutation landed.
 *
 * Read as `auto_merge != null` OR already merged -- a fast main can land the PR between the arm call
 * and this read, same race `mergedMeanwhile` answers for the mirror case, so a landed PR counts as
 * confirmed rather than forcing a read of a field that a merged PR may no longer carry.
 *
 * @param {string} number @param {string} repo
 * @param {{ read?: (number: string, repo: string) => boolean, sleep?: (ms: number) => void,
 *           log?: (line: string) => void }} [deps]
 * @returns {boolean}
 */
export function confirmArmed(number, repo, { read = readArmed, sleep = sleepSync, log = console.log } = {}) {
  return retryRead({ number, repo, label: "confirm-armed", reads: CONFIRM_ARMED_READS,
    waitMs: CONFIRM_ARMED_WAIT_MS, read, sleep, log });
}

/** Same bound as `MERGED_MEANWHILE_READS`/`_WAIT_MS` (#1306) -- the race is the same shape either direction. */
export const CONFIRM_ARMED_READS = 4;
export const CONFIRM_ARMED_WAIT_MS = 2_000;

/** One read of whether the arm took, from the API. @param {string} number @param {string} repo */
function readArmed(number, repo) {
  return armedFromApi(JSON.parse(gh(armedQueryArgs({ number, repo }))));
}

/**
 * THE CANDIDATE READ ASKS THE SAME QUESTION `armedFromApi` ANSWERS (#2004), and until this it did not.
 *
 * `armedFromApi` above knows three armed states and its own comment says why the third needs GraphQL --
 * and the candidate list was a `gh pr list ... --json number,isDraft,autoMergeRequest` with a second
 * `--jq` predicate inside a shell argument, which is exactly the REST read that comment says structurally
 * cannot see the merge queue. So a pull request SITTING IN THE QUEUE was swept as unarmed on every run:
 * the arm was refused, and `sweep` exited 1 with FAILED TO ARM on a correctly armed PR. Measured
 * 2026-09-22 against #1999, both reads in the same minute -- GraphQL said
 * `mergeQueueEntry: {position: 1, state: "AWAITING_CHECKS"}`, the candidate read said `1999`. Deterministic,
 * not a race: it repeated on every sweep for as long as the PR sat in the queue, and run 35781830875
 * reddened #1999's own head for it.
 *
 * #1729's fix went into `confirmArmed` and `mergedMeanwhile` and never into the path that decides WHO IS
 * SWEPT AT ALL -- the second-copy-of-a-predicate shape, where the right rule exists, is exported, is
 * tested, and the deciding read does not call it.
 *
 * `merged` is queried although `states: OPEN` makes it always false here: the field is part of
 * `armedFromApi`'s contract, and a candidate read that dropped it would be a third place deciding which
 * states count.
 */
const CANDIDATES_QUERY = "query($o:String!,$r:String!,$b:String!,$limit:Int!){repository(owner:$o,name:$r)"
  + "{pullRequests(states:OPEN,baseRefName:$b,first:$limit)"
  + "{nodes{number isDraft merged autoMergeRequest{enabledAt} mergeQueueEntry{state}}}}}";

/** The population this sweep has always had: open, against `main`, and the same 100 the old `--limit` read. */
const CANDIDATE_BASE = "main";
const CANDIDATE_LIMIT = 100;

/**
 * PURE. Which of these open pull requests does the sweep still have to arm?
 *
 * Split from the read for the same reason `armedFromApi` is -- so the rule is testable without a network,
 * and so a fourth armed state is added in ONE place. A draft is excluded here rather than in the query
 * because `isDraft` is the sweep's own precondition (`gh pr merge --auto` refuses a draft), not part of
 * what "armed" means.
 *
 * @param {Array<{ number: number | string, isDraft?: boolean } & Parameters<typeof armedFromApi>[0]> | null} nodes
 * @returns {string[]} PR numbers as strings, in the order the API returned them
 */
export function unarmedCandidates(nodes) {
  return (nodes ?? [])
    .filter((pr) => pr && pr.isDraft !== true && !armedFromApi(pr))
    .map((pr) => String(pr.number));
}

/**
 * The `gh` ARGUMENTS for one read of the open pull requests against main, with every field
 * `armedFromApi` decides on.
 *
 * SPLIT FROM THE CALL FOR #1969, so a second reader can make this exact read with its own `run` without
 * a second copy of the QUERY. The field list is not decoration: drop `mergeQueueEntry` from a copy and
 * `armedFromApi` silently answers `false` for every pull request sitting in the merge queue, which is
 * precisely the defect #2004 measured against #1999. `armedFromApi`'s own comment says a fourth armed
 * state must be added in ONE place; this keeps the read that feeds it in one place too.
 *
 * `work-gate.mjs` is that second reader. It cannot import the CALL -- it injects its own `run` and must
 * keep working before any `npm ci` -- but it must not ask a different question either.
 *
 * @param {string} repo `owner/name`
 * @returns {string[]}
 */
export function openPullRequestsQueryArgs(repo) {
  const [owner, name] = String(repo).split("/");
  return ["api", "graphql", "-f", `query=${CANDIDATES_QUERY}`,
    "-f", `o=${owner}`, "-f", `r=${name}`, "-f", `b=${CANDIDATE_BASE}`, "-F", `limit=${CANDIDATE_LIMIT}`,
    "--jq", ".data.repository.pullRequests.nodes"];
}

/** One read of the open pull requests against main, with every field `armedFromApi` decides on. @param {string} repo */
function readOpenPullRequests(repo) {
  return JSON.parse(gh(openPullRequestsQueryArgs(repo)));
}

/**
 * THE ARM CALL THREW -- AND THE STATE IS READ, NEVER THE EXIT CODE. `gh` exits non-zero for a merged PR,
 * an already-queued one, an unmergeable one and a network fault alike, so the message text cannot tell
 * them apart; this asks the API, the same rule `disarmVerdict` follows for the mirror case.
 *
 * MERGED MEANWHILE IS THE ORDINARY CASE ON A FAST MAIN (#845 at 17:25:53Z): the candidate list is read at
 * the top of a run, and on a main taking eight merges in half an hour a PR can go green, arm itself and
 * land before this line.
 *
 * ARMED MEANWHILE IS THE SAME RACE ONE STEP EARLIER (#2004), and it is what the candidate read's own fix
 * cannot close: a PR that arms between the list and the arm is still queued rather than merged, so
 * `mergedMeanwhile` answers `false` for it and the run went red on a PR that did exactly what it should.
 * Fixing only the candidate read leaves that race; fixing only this leaves the sweep spending an arm call
 * per queued PR per run. Both, or neither is finished.
 *
 * THE COST IS PAID BY THE FAILING PATH ONLY. A genuine failure now costs two bounded re-reads rather than
 * one -- both answers must be `false` before FAILED TO ARM is believed -- and a PR that merged or armed
 * meanwhile short-circuits on the first `true`.
 *
 * @param {{ number: string, repo: string, cause: unknown }} attempt
 * @param {{ merged?: (n: string, r: string) => boolean, armed?: (n: string, r: string) => boolean }} [deps]
 * @returns {{ failed: boolean, line: string }}
 */
export function armFailureVerdict({ number, repo, cause }, { merged = mergedMeanwhile, armed = confirmArmed } = {}) {
  if (merged(number, repo)) {
    return { failed: false, line: `SWEEP: #${number} SKIPPED -- merged meanwhile, between this run's `
      + "candidate read and its arm. Nothing to arm and nothing wrong." };
  }
  if (armed(number, repo)) {
    return { failed: false, line: `SWEEP: #${number} SKIPPED -- armed meanwhile: the API reports it `
      + "auto-merging or in the merge queue, between this run's candidate read and its arm. The arm this "
      + "run attempted was already unnecessary, and `gh`'s non-zero exit is that, not a failure." };
  }
  return { failed: true,
    line: `SWEEP: #${number} FAILED TO ARM -- ${cause instanceof Error ? cause.message : cause}` };
}

/** Blocks for `ms`. `main()` is synchronous end to end, like every `gh` call it makes. @param {number} ms */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0, ms);
}

/** @param {string[]} args */
const gh = (args) => execFileSync("gh", args, { encoding: "utf8" }).trim();

function main() {
  refuseUnknownFlags([], { entry: import.meta.url, command: "node packages/agent-org/src/auto-arm-sweep.mjs" });

  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    console.error("CANNOT ASK: GITHUB_REPOSITORY is unset, so there is no repo to sweep.");
    process.exit(EXIT.CANNOT_ASK);
  }

  let candidates;
  try {
    candidates = unarmedCandidates(readOpenPullRequests(repo));
  } catch (cause) {
    console.error(`CANNOT ASK: listing open PRs failed -- ${cause instanceof Error ? cause.message : cause}`);
    process.exit(EXIT.CANNOT_ASK);
  }

  if (candidates.length === 0) {
    console.log("SWEEP: every open non-draft PR against main is already armed.");
    process.exit(EXIT.DRAINED);
  }
  console.log(`SWEEP: ${candidates.length} unarmed: ${candidates.join(" ")}`);

  const failed = [];
  for (const number of candidates) {
    let labels, head, checkRunCount;
    try {
      labels = JSON.parse(gh(["pr", "view", number, "--repo", repo, "--json", "labels", "-q", "[.labels[].name]"]));
      head = gh(["pr", "view", number, "--repo", repo, "--json", "headRefOid", "-q", ".headRefOid"]);
      checkRunCount = Number(gh(["api", `repos/${repo}/commits/${head}/check-runs`, "--jq", ".total_count"]));
    } catch (cause) {
      // A PR we could not ASK about is not a PR we may arm, and it is not a clean skip either.
      console.log(`SWEEP: #${number} COULD NOT ASK -- ${cause instanceof Error ? cause.message : cause}`);
      failed.push(number);
      continue;
    }

    const { arm, reason } = decideAndWarn({ number, labels, checkRunCount });
    if (!arm) {
      console.log(`SWEEP: #${number} SKIPPED -- ${reason}`);
      continue;
    }

    try {
      gh(["pr", "merge", "--auto", "--merge", number, "--repo", repo]);
      // NOT THROWING IS NOT ARMED (#1729). `gh` can print "already queued to merge" to stderr and still
      // exit 0 without the mutation landing -- read `autoMergeRequest` back before believing it.
      if (confirmArmed(number, repo)) {
        console.log(`SWEEP: #${number} ARMED -- ${reason}`);
      } else {
        console.log(`SWEEP: #${number} ARM CLAIMED BUT NOT CONFIRMED -- gh pr merge --auto did not throw, `
          + `but autoMergeRequest is still null and the PR is not merged after ${CONFIRM_ARMED_READS} reads`);
        failed.push(number);
      }
    } catch (cause) {
      // WHY IT THREW IS ASKED OF THE API, never inferred from the exit code -- see `armFailureVerdict`.
      const verdict = armFailureVerdict({ number, repo, cause });
      console.log(verdict.line);
      if (verdict.failed) failed.push(number);
    }
  }

  if (failed.length > 0) {
    console.error(`SWEEP: could not arm ${failed.length}: ${failed.join(" ")}`);
    process.exit(EXIT.COULD_NOT_ARM);
  }
  process.exit(EXIT.DRAINED);
}

// The same entry guard `merge-guard.mjs` uses: a bare `file://` + argv[1] comparison misreads a path
// with a space in it and a symlinked checkout, and reports the module as "imported, not run".
if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();

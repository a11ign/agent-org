#!/usr/bin/env node
// @ts-check
// command: name the armed, green PRs that can never merge because they are behind and conflicting
// #361: AN ARMED, GREEN, CONFLICTING PR SITS FOREVER, AND NOTHING SAYS WHY.
//
// Measured 2026-09-07 12:40Z, two of the eight open PRs:
//
//   #232  armed, gate=SUCCESS, standing since 04:45 (8 hours)    -- 6 files CONFLICT against origin/main
//   #281  armed, gate=SUCCESS, standing since 08:00 (4.5 hours)  -- 2 files CONFLICT against origin/main
//
// Twelve and a half PR-hours of two workers' finished work, invisible -- neither author was told, both
// found by hand. This is the gap `auto-arm-sweep.mjs` (#344) closed at the OTHER end: that sweep reports
// every PR it will not arm, with a reason. It says nothing about a PR it DID arm, because from its side
// arming succeeded -- GitHub then declines to complete the merge and tells nobody. Same hole, one step
// further along the queue.
//
// ## `mergeable` is not the instrument -- `git merge-tree` is
//
// GitHub computes `mergeable` LAZILY and it read `UNKNOWN` on both PRs at the moment of measurement, so a
// check keyed on `mergeable == "CONFLICTING"` would have reported neither. `git merge-tree --write-tree
// --name-only <base> <head>` answers directly and locally: exit 0 with a single tree-oid line on stdout
// means a clean merge is possible; exit 1 means real content conflicts, and stdout's first paragraph (up
// to the first blank line, after the tree-oid line) names exactly the conflicting paths. Verified against
// the real queue before writing this: PRs #232/#281/#181/#172 conflicted, #367/#371/#381 (this session's
// own, clean against `origin/main`) did not -- exit 0, stdout one line, no trailer.
//
// ## Three things this must get right, each with a wrong answer that looks correct
//
// 1. REPORT, NEVER ACT. No rebase, no branch update, no close. #258's collision -- `gh pr update-branch`
//    run on a PR its author was mid-rebase inside, reverted real work, and only `--force-with-lease`
//    stopped it -- is exactly the failure mode of "helpfully" resolving a conflict this script only names.
// 2. "WAITING FOR A CHECK" AND "CANNOT EVER MERGE" MUST NEVER PRINT THE SAME THING. A PR armed ten seconds
//    ago with `gate` still running is healthy. The signal is a conflict on an ALREADY-GREEN PR, not the
//    mere absence of a completed merge -- `stalledVerdict` below refuses to call anything stalled until
//    `gate` has actually concluded SUCCESS.
// 3. REACHABLE WITHOUT A SCHEDULE. GitHub disables scheduled workflows after 60 days of inactivity
//    (`board-liveness.test.ts`), and a stall reporter that fails by going quiet has the disease it
//    watches for. Rides the same `pull_request` trigger `auto-arm-sweep.mjs` does.
//
// A THRESHOLD, NOT AN INSTANT REPORT, on the conflict itself too: a PR whose `gate` concluded seconds ago
// may not yet reflect a `main` that just moved underneath it, and a conflict computed against a stale
// local view of `origin/main` is a false alarm waiting to happen. `DEFAULT_STALL_THRESHOLD_MS` (30
// minutes) is the same shape as `auto-arm-sweep.mjs`'s own "REPORT, never silently skip" -- except here
// the risk runs the other way, so the guard is against reporting TOO EARLY rather than not at all.
//
// Exit codes are the contract:
//   0  the queue was examined -- zero or more stalled PRs were named (STALLED alone is not a failure;
//      see the workflow step for what treats it as one)
//   2  a lookup failed. INCONCLUSIVE, never "fine".
import { execFileSync } from "node:child_process";
import { refuseUnknownFlags } from "../../worker-fleet/src/cli-flags.mjs";
import { sandboxGitEnv } from "../../guards/src/git-env.mjs";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { newestConclusion, newestRun, headQuietSeconds, normaliseConclusion, SUCCESS }
  from "./update-branch-sweep.mjs";
import { workflowRunIdOf } from "./newest-check-run.mjs";
// #1100: SUCCESS IS IMPORTED, NOT SPELLED. `newestConclusion` normalises every conclusion to one
// vocabulary at its own edge (`gh` spells the same verdict `SUCCESS` on `statusCheckRollup` and `success`
// on the REST check-runs API), so a literal here is a copy of a fact this file learns from that one --
// and it read `"SUCCESS"` in three places while the function had started returning `"success"`, which
// made every green armed pull request report as "has not concluded SUCCESS" and the watchdog find 0 of 2.

export const EXIT = { EXAMINED: 0, CANNOT_ASK: 2 };
export const DEFAULT_STALL_THRESHOLD_MS = 30 * 60 * 1000;

// C5a, #509 -- FILED AFTER #500 AND #517, WHICH FIXED THE MECHANISM THAT KEEPS AN ARMED PR CURRENT.
// THIS IS THE WATCHDOG THAT WOULD HAVE SAID SO WHILE THE MECHANISM WAS STILL BROKEN.
//
// #500 was #498's own defect surviving its own fix (`newestConclusion` reading the FIRST `gate` run
// rather than the newest by timestamp): every armed, green PR sat behind main, invisible, because the
// sweep's own skip line named the AUTHOR as the person who must act -- "a failing PR needs a fix, not a
// stale-main push" -- when nothing was wrong with either PR. #500 and #485 sat at 14 and 30 commits
// behind for hours, found by a person reading `behind_by` by hand, because nothing else was watching.
//
// This does not fix anything -- `update-branch-sweep.mjs` already does, and re-implementing that here
// would be the shape #498/#500 already cost this repo once (a fact re-derived instead of read). It
// REPORTS: if the mechanism that keeps a PR current breaks again, this is what says so before an hour of
// hand-reading `behind_by` does.
export const DEFAULT_BEHIND_STALL_THRESHOLD_SECONDS = 15 * 60;

/**
 * PURE. Is this PR armed, green and stuck behind `main` long enough to be a watchdog concern?
 *
 * Reuses `update-branch-sweep.mjs`'s own `newestConclusion`/`headQuietSeconds` rather than a second
 * reading of the same rollup -- the "fact stated twice, and the copies drifted" shape this repo has paid
 * for repeatedly, most recently in the mechanism this row watches.
 *
 * @param {{ armed: boolean, gateConclusion: string | null, behindBy: number, quietSeconds: number | null,
 *   thresholdSeconds?: number }} input
 * @returns {{ stalled: boolean, code: string, reason: string }}
 */
export function armedBehindVerdict({
  armed, gateConclusion: rawConclusion, behindBy, quietSeconds,
  thresholdSeconds = DEFAULT_BEHIND_STALL_THRESHOLD_SECONDS,
}) {
  // NORMALISED AT THIS BOUNDARY, for the reason the sibling predicate in `update-branch-sweep.mjs` is:
  // this is exported and reachable with either of `gh`'s two spellings, and a predicate correct only for
  // the one its usual caller happens to supply is the defect that reached this file in the first place.
  const gateConclusion = normaliseConclusion(rawConclusion);
  if (!armed) {
    return { stalled: false, code: "NOT_ARMED", reason: "not armed for auto-merge -- not this check's concern" };
  }
  if (gateConclusion !== SUCCESS) {
    return {
      stalled: false, code: "WAITING",
      reason: `gate has not concluded SUCCESS (${gateConclusion ?? "no conclusion yet"}) -- healthy, still `
        + "running or not yet checked",
    };
  }
  if (behindBy === 0) {
    return { stalled: false, code: "HEALTHY", reason: "armed, green, current with main -- waiting its turn" };
  }
  if (quietSeconds === null) {
    // REFUSE RATHER THAN PRINT ZERO. A behind, armed, green PR with no timed check run on its head is
    // not "healthy" -- it is a case this watchdog cannot ask about, and reporting nothing here must not
    // read the same as reporting nothing because there was genuinely nothing to report.
    return {
      stalled: false, code: "UNRESOLVABLE",
      reason: `${behindBy} commit(s) behind main, but no timed check run on this head -- cannot tell how `
        + "long it has been stuck",
    };
  }
  if (quietSeconds < thresholdSeconds) {
    return {
      stalled: false, code: "TOO_RECENT",
      reason: `${behindBy} commit(s) behind, but the head is only ${Math.round(quietSeconds / 60)}m quiet -- `
        + `below the ${Math.round(thresholdSeconds / 60)}m floor, update-branch-sweep.mjs may not have run yet`,
    };
  }
  return {
    stalled: true, code: "BEHIND",
    reason: `armed and green, ${behindBy} commit(s) behind main, head quiet for `
      + `${Math.round(quietSeconds / 60)}m -- past the ${Math.round(thresholdSeconds / 60)}m floor`,
  };
}

/**
 * PURE. The one-line watchdog summary for C5a/#509, printed in the dispatcher's hourly table and the
 * daily document's conflict metrics.
 *
 * EVERY NUMBER STATES ITS WINDOW. `examinedCount` says how many open, armed, green PRs this line's
 * silence actually covers -- "0 stalled" over 40 PRs and "0 stalled" over 2 read as the same word and
 * are not the same claim. And REFUSE RATHER THAN PRINT ZERO: an `unresolvable` PR (behind, but no timed
 * check run to say for how long) is named on its own line, never folded into "0 stalled" -- "nothing is
 * stalled" and "I could not ask about one of them" must never be the same output, #518's own distinction
 * applied to this row.
 *
 * @param {{ number: number, behindBy?: number, reason: string }[]} stalledList
 * @param {{ number: number, reason: string }[]} unresolvableList
 * @param {number} examinedCount
 * @param {number} thresholdSeconds
 * @returns {string}
 */
export function formatBehindWatchdogLine(stalledList, unresolvableList, examinedCount, thresholdSeconds) {
  const thresholdMin = Math.round(thresholdSeconds / 60);
  const lines = [];
  if (stalledList.length === 0) {
    lines.push(`WATCHDOG: 0 of ${examinedCount} armed, green PR(s) behind main for more than `
      + `${thresholdMin}m.`);
  } else {
    const names = stalledList.map((s) => `#${s.number}`).join(", ");
    lines.push(`WATCHDOG: ${stalledList.length} of ${examinedCount} armed, green PR(s) behind main for `
      + `more than ${thresholdMin}m: ${names}`);
    for (const s of stalledList) lines.push(`  #${s.number}: ${s.reason}`);
  }
  if (unresolvableList.length > 0) {
    const names = unresolvableList.map((u) => `#${u.number}`).join(", ");
    lines.push(`WATCHDOG: ${unresolvableList.length} UNRESOLVABLE (behind main, no timed check run to `
      + `say for how long) -- not counted above, not counted as healthy: ${names}`);
  }
  return lines.join("\n");
}

/**
 * PURE-ish (injectable git). Exactly how many commits on `base` are not yet on `headSha` -- the real
 * count `gh pr list` does not expose, computed locally the same way `mergeTreeConflict` computes
 * conflicts rather than trusting GitHub's lazily-computed `mergeable`/`mergeStateStatus`.
 *
 * @param {string} base
 * @param {string} headSha
 * @param {(args: string[]) => { status: number, stdout: string }} runGit
 * @returns {number}
 */
export function behindByCount(base, headSha, runGit) {
  const { status, stdout } = runGit(["rev-list", "--count", `${headSha}..${base}`]);
  if (status !== 0) return 0;
  const n = Number.parseInt(stdout.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * PURE. Does this PR need reporting, and why? Never decides to act -- only to speak.
 *
 * @param {{ armed: boolean, gateConclusion: string | null, conflict: boolean, ageMs: number,
 *   thresholdMs?: number }} input
 * @returns {{ stalled: boolean, code: string, reason: string }}
 */
export function stalledVerdict({ armed, gateConclusion: rawConclusion, conflict, ageMs,
  thresholdMs = DEFAULT_STALL_THRESHOLD_MS }) {
  const gateConclusion = normaliseConclusion(rawConclusion);
  if (!armed) {
    return { stalled: false, code: "NOT_ARMED", reason: "not armed for auto-merge -- not this check's concern" };
  }
  if (gateConclusion !== SUCCESS) {
    return {
      stalled: false, code: "WAITING",
      reason: `gate has not concluded SUCCESS (${gateConclusion ?? "no conclusion yet"}) -- healthy, still `
        + "running or not yet checked",
    };
  }
  if (!conflict) {
    return { stalled: false, code: "HEALTHY", reason: "armed, green, no conflict -- waiting its turn" };
  }
  if (ageMs < thresholdMs) {
    return {
      stalled: false, code: "TOO_RECENT",
      reason: `conflict detected but only armed ${Math.round(ageMs / 60000)}m ago -- below the `
        + `${Math.round(thresholdMs / 60000)}m floor against a stale local view of origin/main`,
    };
  }
  return {
    stalled: true, code: "CONFLICTING",
    reason: "armed and green, but cannot ever merge as-is -- content conflicts against origin/main",
  };
}

/**
 * Runs the real `git merge-tree`, never re-implements its logic. `runGit` is injectable so the parsing
 * below is tested against captured, real output rather than a guessed shape.
 *
 * @param {string} base
 * @param {string} headSha
 * @param {(args: string[]) => { status: number, stdout: string }} runGit
 * @returns {{ conflict: boolean, files: string[] }}
 */
export function mergeTreeConflict(base, headSha, runGit) {
  const { status, stdout } = runGit(["merge-tree", "--write-tree", "--name-only", base, headSha]);
  if (status === 0) return { conflict: false, files: [] };
  // stdout's first paragraph is the tree-oid line followed by one conflicting path per line; the second
  // paragraph (Auto-merging.../CONFLICT (content): ... trailer) is not parsed -- the file list already
  // names what matters, and the trailer's wording is not a contract git makes.
  const [fileSection = ""] = stdout.split("\n\n");
  const files = fileSection.split("\n").slice(1).filter(Boolean);
  return { conflict: true, files };
}

/** @param {string[]} args */
function runGitForReal(args) {
  try {
    const stdout = execFileSync("git", args,
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: sandboxGitEnv() });
    return { status: 0, stdout };
  } catch (cause) {
    const err = /** @type {{ status?: number, stdout?: string }} */ (cause);
    return { status: err.status ?? 1, stdout: err.stdout ?? "" };
  }
}

/** @param {string[]} args */
const gh = (args) => execFileSync("gh", args, { encoding: "utf8" }).trim();

/**
 * @typedef {{ name?: string, conclusion?: string | null, completedAt?: string | null,
 *   startedAt?: string | null, detailsUrl?: string | null }} CheckRun
 * @typedef {{ number: number, headRefOid: string, autoMergeRequest?: { enabledAt: string } | null,
 *   statusCheckRollup?: CheckRun[] }} QueuedPr
 */

/**
 * #1623: AN ARMED PR HELD BY A SUPERSEDING GATE THAT DID NOT SUCCEED, while an older run's gate at its head did.
 *
 * #1617, 2026-09-14: green, reviewed and armed at `84f684dd`, and BLOCKED with nothing for its author to fix. Two
 * `ci` runs started at that head within 2 s. The OLDER one's `gate` succeeded; the NEWER one was cancelled 6 s after
 * it was created, and GitHub held the PR on it. Nothing re-runs a cancelled run, and the sweep acts only on a PR
 * that is behind, so the PR was unstuck only because main moved.
 *
 * "Newest" is the sweep's own `newestRun`, which orders by WORKFLOW RUN when the entries name one (#1623's comparator in
 * newest-check-run.mjs). Every entry in a PR's rollup is on its current head, so "the same head" is the rollup itself.
 *
 * REPORTS, NEVER ACTS: it names both runs and the one action that clears it. A still-running newest gate is not this
 * (the run may yet succeed), and a red gate with no success anywhere on the head is an ordinary red, not this shape.
 *
 * ONLY WORKFLOW-RUN ORDER CAN SAY IT (#1631's review). Without two DISTINCT run ids -- both entries id-free, one
 * missing, or one run holding both -- "newest" is `newestRun`'s completion-time fallback, the very guess that read
 * #1617 backwards. Such a pair is UNORDERED: not reported, and never a re-run instruction naming a run nobody can name.
 *
 * @param {{ armed: boolean, runs: CheckRun[] | null | undefined }} input
 * @returns {{ code: "NOT_ARMED" | "NO_GATE" | "RUNNING" | "GREEN" | "RED" | "UNORDERED" | "SUPERSEDED", reason: string }}
 */
export function supersedingGateVerdict({ armed, runs }) {
  if (!armed) return { code: "NOT_ARMED", reason: "not armed -- not this check's concern" };
  const newest = newestRun(runs, "gate");
  if (!newest) return { code: "NO_GATE", reason: "no gate run on this head" };
  const conclusion = normaliseConclusion(newest.conclusion);
  if (conclusion === null) return { code: "RUNNING", reason: "the newest gate has not concluded -- it may yet succeed" };
  if (conclusion === SUCCESS) return { code: "GREEN", reason: "the newest gate succeeded" };
  const succeeded = (runs ?? []).find((run) => run !== newest && run?.name === "gate"
    && normaliseConclusion(run.conclusion) === SUCCESS);
  if (!succeeded) {
    return { code: "RED", reason: `the newest gate concluded ${conclusion} and no gate on this head succeeded -- an `
      + "ordinary red, not a superseded one" };
  }
  const [newestId, succeededId] = [workflowRunIdOf(newest), workflowRunIdOf(succeeded)];
  if (newestId === null || succeededId === null || newestId <= succeededId) {
    return { code: "UNORDERED", reason: `the newest gate by time concluded ${conclusion} after a gate on this head `
      + "succeeded, but the two do not carry distinct workflow run ids, so which attempt GitHub counts cannot be read "
      + "-- not reported" };
  }
  return { code: "SUPERSEDED", reason: `blocked by a superseding ${conclusion} gate: workflow run ${newestId}'s gate `
    + `${conclusion} after run ${succeededId}'s gate succeeded at this head -- re-run workflow run ${newestId} to clear it` };
}

/**
 * The one summary line for #1623's check, stated whether or not anything was found.
 * @param {number[]} blocked PR numbers
 * @returns {string}
 */
export function supersededLine(blocked) {
  return blocked.length === 0
    ? "QUEUE: nothing blocked by a superseding gate -- no armed PR's newest gate failed after an older one succeeded."
    : `QUEUE: ${blocked.length} blocked by a superseding gate: ${blocked.join(" ")}`;
}

/**
 * C5a, #509's per-PR behind check, pulled out of `main()`'s loop to keep complexity within this repo's
 * own ESLint ceiling.
 *
 * @param {QueuedPr} pr
 * @param {string | null} gateConclusion
 * @param {Date} now
 * @returns {{ stalled?: { number: number, behindBy: number, reason: string },
 *   unresolvable?: { number: number, reason: string } }}
 */
function checkArmedBehind(pr, gateConclusion, now) {
  const behindBy = behindByCount("origin/main", pr.headRefOid, runGitForReal);
  const quietSeconds = headQuietSeconds(pr.statusCheckRollup, now);
  const verdict = armedBehindVerdict({ armed: true, gateConclusion, behindBy, quietSeconds });
  if (verdict.stalled) return { stalled: { number: pr.number, behindBy, reason: verdict.reason } };
  if (verdict.code === "UNRESOLVABLE") return { unresolvable: { number: pr.number, reason: verdict.reason } };
  return {};
}

/**
 * The whole per-PR examination `main()`'s loop used to inline -- both the #361 conflict check and the
 * #509 behind check share the same armed/gate-green precondition, so pulling the pair out together (not
 * behind check alone) is what brings the caller's complexity back under this repo's ceiling.
 *
 * @param {QueuedPr} pr
 * @param {number} now
 * @returns {{ conflicting?: { number: number, reason: string, files: string[] },
 *   superseded?: { number: number, reason: string },
 *   behind?: { stalled?: { number: number, behindBy: number, reason: string },
 *     unresolvable?: { number: number, reason: string } }, examined: boolean }}
 */
export function examinePr(pr, now) {
  const armed = pr.autoMergeRequest != null;
  // #498's own bug: the FIRST matching run in the rollup, not the newest by timestamp. Fixed here the
  // same way `update-branch-sweep.mjs` fixed it for its own read of the identical field -- one function,
  // imported, not a second hand-rolled `.find()` that can drift from the first.
  const gateConclusion = newestConclusion(pr.statusCheckRollup, "gate");
  const ageMs = armed && pr.autoMergeRequest ? now - Date.parse(pr.autoMergeRequest.enabledAt) : 0;
  const green = armed && normaliseConclusion(gateConclusion) === SUCCESS;
  // #1623: a PR that is not green can still be one nothing will ever unstick -- reported by name, never acted on.
  // eslint-disable-next-line local/bounded-window-reads -- #1623: the superseded-gate verdict must see the older runs; the newest is still chosen by newestRun
  const blocking = supersedingGateVerdict({ armed, runs: pr.statusCheckRollup });
  const superseded = blocking.code === "SUPERSEDED" ? { number: pr.number, reason: blocking.reason } : undefined;

  if (!green) return { superseded, examined: false };

  const { conflict, files } = mergeTreeConflict("origin/main", pr.headRefOid, runGitForReal);
  const verdict = stalledVerdict({ armed, gateConclusion, conflict, ageMs });
  const conflicting = verdict.stalled ? { number: pr.number, reason: verdict.reason, files } : undefined;

  // C5a, #509: armed, green, and stuck behind main -- the signal #500/#517's fix protects, watched
  // independently so a regression in THAT mechanism is visible here rather than found by hand again.
  const behind = checkArmedBehind(pr, gateConclusion, new Date(now));

  return { conflicting, behind, examined: true };
}

function main() {
  refuseUnknownFlags([], { entry: import.meta.url, command: "node packages/agent-org/src/queue-stalled.mjs" });

  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    console.error("CANNOT ASK: GITHUB_REPOSITORY is unset, so there is no repo to examine.");
    process.exit(EXIT.CANNOT_ASK);
  }

  let prs;
  try {
    prs = JSON.parse(gh(["pr", "list", "--repo", repo, "--state", "open", "--base", "main", "--limit", "100",
      "--json", "number,headRefOid,autoMergeRequest,statusCheckRollup"]));
  } catch (cause) {
    console.error(`CANNOT ASK: listing open PRs failed -- ${cause instanceof Error ? cause.message : cause}`);
    process.exit(EXIT.CANNOT_ASK);
  }

  // Fetch every branch tip once, up front -- `actions/checkout@v4` only brings the triggering PR's own
  // head, and `git merge-tree` needs every OTHER open PR's head object present locally too.
  try {
    execFileSync("git", ["fetch", "origin", "--quiet", "+refs/heads/*:refs/remotes/origin/*"],
      { stdio: "pipe", env: sandboxGitEnv() });
  } catch (cause) {
    console.error(`CANNOT ASK: fetching branch tips failed -- ${cause instanceof Error ? cause.message : cause}`);
    process.exit(EXIT.CANNOT_ASK);
  }

  const now = Date.now();
  const stalled = [];
  const superseded = [];
  const behindStalled = [];
  const behindUnresolvable = [];
  let behindExamined = 0;
  for (const pr of prs) {
    const result = examinePr(pr, now);
    if (result.superseded) {
      console.log(`#${result.superseded.number} BLOCKED -- ${result.superseded.reason}`);
      superseded.push(result.superseded.number);
    }
    if (result.conflicting) {
      console.log(`#${result.conflicting.number} STALLED -- ${result.conflicting.reason}`);
      console.log(`  conflicting: ${result.conflicting.files.join(", ")}`);
      stalled.push(result.conflicting.number);
    }
    if (result.examined) behindExamined += 1;
    if (result.behind?.stalled) behindStalled.push(result.behind.stalled);
    if (result.behind?.unresolvable) behindUnresolvable.push(result.behind.unresolvable);
  }

  if (stalled.length === 0) {
    console.log("QUEUE: nothing stalled -- every armed, green PR merges cleanly against origin/main.");
  } else {
    console.log(`QUEUE: ${stalled.length} stalled: ${stalled.join(" ")}`);
  }
  console.log(supersededLine(superseded));
  console.log(formatBehindWatchdogLine(behindStalled, behindUnresolvable, behindExamined,
    DEFAULT_BEHIND_STALL_THRESHOLD_SECONDS));
  process.exit(EXIT.EXAMINED);
}

// The same entry guard `merge-guard.mjs`/`auto-arm-sweep.mjs` use: a bare `file://` + argv[1] comparison
// misreads a path with a space in it and a symlinked checkout, and reports the module as "imported, not
// run".
if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();

#!/usr/bin/env node
// @ts-check
// command: sweep main for a gate failure while GITHUB_TOKEN-authored merges suppress every triggering event
// #417: THE INTERIM COVER WHILE THE TRUNK IS UNGUARDED AFTER EVERY PIPELINE MERGE.
//
// GITHUB_TOKEN events trigger no workflows (#394's overnight measurement, 37 data points, no exceptions):
// a merge completed by `github-actions[bot]` -- every merge `auto-arm.yml` completes -- fires neither
// `pull_request: closed` nor `push`, so `trunk.yml`'s own trigger never runs. Measured 2026-09-08:
// `main`'s tip after one such merge carried ZERO check runs. Unit 3's whole revert mechanism (#316) is
// silent for exactly the merges the pipeline itself performs.
//
// The permanent fix is #416 (arm with a token whose events actually fire) and needs the chairman's hands.
// This is what covers the gap until then, and stays useful afterward as a net: if `main`'s tip is ever
// left with zero check runs for ANY reason, this notices and drives a real gate run.
//
// ## What this checks, and what it does about it
//
// `needsGateSweep` is the whole decision: does `main`'s tip have zero check runs? If so, trigger
// `trunk.yml` directly via `workflow_dispatch` (added to that workflow in this same PR) -- no `ref`
// needed, since a dispatch with none given runs against the repository's default branch, which is `main`.
// `trunkRecheck`'s own `if: needs.trunkGate.result == 'failure'` then fires exactly as it would for a
// real push, and the gate's `trunk-red` cause reads the same run -- nothing new to build there.
//
// ## Why this is a SCHEDULE, when this repository deliberately avoids one everywhere else
//
// `board-liveness.yml` and its siblings are push-triggered on purpose: GitHub disables a scheduled
// workflow after 60 days with NO repository activity at all, and a scheduled watchdog therefore dies in
// the same breath as the jobs it guards. That rule needs 60 days of total silence, which a repository
// merging a dozen PRs an hour will not have -- recorded here so nobody re-derives the objection.
//
// The circularity that would otherwise apply is real and this is the answer to it: every watchdog here
// is push-triggered, and push is suppressed for exactly the merges that matter, so a push-triggered
// liveness check ON this sweep would be dead in the identical way. The liveness signal for THIS workflow
// therefore leaves the event system entirely -- the daily board edition prints when the schedule's own
// run list says this last ran, and the PM's summary check flags it stale. That is not this script's job;
// it is stated here so the next reader knows where the answer lives.
//
// Exit codes are the contract:
//   0  main's tip already has check runs -- nothing to do, or the sweep was successfully triggered
//   1  the trigger call failed
//   2  a lookup failed. INCONCLUSIVE, never "fine".
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { refuseUnknownFlags } from "./lib/cli-flags.ts";
import type { RowsRun } from "./plugins/contracts/code-host-rows.ts";
import { rows } from "./plugins/rows.ts";

export const EXIT = { DONE: 0, COULD_NOT_TRIGGER: 1, CANNOT_ASK: 2 };

/**
 * PURE. Does main's tip need a gate run triggered for it?
 * @param {number} checkRunCount
 * @returns {boolean}
 */
export function needsGateSweep(checkRunCount: number): boolean {
  return checkRunCount === 0;
}

/** The code host's own runner (A11-160, step 9): `gh` as this process's account, with what it prints on stderr let through, as `execFileSync` let it. */
const run: RowsRun = (args) => rows().runnerWith({})(args);

/** Where the sweep says what it did and what it could not: the process's own stdout and stderr, and a test's lines. */
export type SweepSay = { out: (line: string) => void; err: (line: string) => void };

/**
 * One sweep of `repo`'s trunk, and the exit code it ends with: read the tip of `main` and its check runs, and dispatch `trunk.yml` when the tip carries none. Exported so the two actors of #1577 (the project's own
 * clock and the outside home's) can be driven against one world; `main` is this over the process.
 */
export function sweepTrunk(repo: string, say: SweepSay): number {
  let sha, count;
  try {
    sha = rows().mainShaOf({ repo, run });
    count = rows().checkRunTotalOf({ repo, sha, run });
  } catch (cause) {
    say.err(`CANNOT ASK: reading main's tip or its check runs failed -- `
      + `${cause instanceof Error ? cause.message : cause}`);
    return EXIT.CANNOT_ASK;
  }

  if (!needsGateSweep(count)) {
    say.out(`TRUNK-SWEEP: main's tip (${sha}) already carries ${count} check run(s) -- nothing to do.`);
    return EXIT.DONE;
  }

  say.out(`TRUNK-SWEEP: main's tip (${sha}) carries ZERO check runs -- triggering trunk.yml.`);
  try {
    rows().dispatchWorkflow({ repo, workflow: "trunk.yml", run });
  } catch (cause) {
    say.err(`TRUNK-SWEEP: could not trigger trunk.yml -- `
      + `${cause instanceof Error ? cause.message : cause}`);
    return EXIT.COULD_NOT_TRIGGER;
  }
  say.out("TRUNK-SWEEP: triggered.");
  return EXIT.DONE;
}

function main() {
  refuseUnknownFlags([], { entry: import.meta.url, command: "node packages/agent-org/src/trunk-sweep.ts" });

  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    console.error("CANNOT ASK: GITHUB_REPOSITORY is unset, so there is no repo to sweep.");
    process.exit(EXIT.CANNOT_ASK);
  }

  process.exit(sweepTrunk(repo, { out: (line) => console.log(line), err: (line) => console.error(line) }));
}

// The entry guard `merge-guard.ts`/`auto-arm-sweep.ts` use.
if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();

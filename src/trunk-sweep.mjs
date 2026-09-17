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
// `decideRevert`'s own `if: needs.trunkGate.result == 'failure'` then fires exactly as it would for a
// real push, driving the SAME revert machinery -- nothing new to build there.
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
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { refuseUnknownFlags } from "../../worker-fleet/src/cli-flags.mjs";

export const EXIT = { DONE: 0, COULD_NOT_TRIGGER: 1, CANNOT_ASK: 2 };

/**
 * PURE. Does main's tip need a gate run triggered for it?
 * @param {number} checkRunCount
 * @returns {boolean}
 */
export function needsGateSweep(checkRunCount) {
  return checkRunCount === 0;
}

/** @param {string[]} args */
const gh = (args) => execFileSync("gh", args, { encoding: "utf8" }).trim();

function main() {
  refuseUnknownFlags([], { entry: import.meta.url, command: "node packages/agent-org/src/trunk-sweep.mjs" });

  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    console.error("CANNOT ASK: GITHUB_REPOSITORY is unset, so there is no repo to sweep.");
    process.exit(EXIT.CANNOT_ASK);
  }

  let sha, count;
  try {
    sha = gh(["api", `repos/${repo}/commits/main`, "--jq", ".sha"]);
    count = Number(gh(["api", `repos/${repo}/commits/${sha}/check-runs`, "--jq", ".total_count"]));
  } catch (cause) {
    console.error(`CANNOT ASK: reading main's tip or its check runs failed -- `
      + `${cause instanceof Error ? cause.message : cause}`);
    process.exit(EXIT.CANNOT_ASK);
  }

  if (!needsGateSweep(count)) {
    console.log(`TRUNK-SWEEP: main's tip (${sha}) already carries ${count} check run(s) -- nothing to do.`);
    process.exit(EXIT.DONE);
  }

  console.log(`TRUNK-SWEEP: main's tip (${sha}) carries ZERO check runs -- triggering trunk.yml.`);
  try {
    gh(["workflow", "run", "trunk.yml", "--repo", repo]);
  } catch (cause) {
    console.error(`TRUNK-SWEEP: could not trigger trunk.yml -- `
      + `${cause instanceof Error ? cause.message : cause}`);
    process.exit(EXIT.COULD_NOT_TRIGGER);
  }
  console.log("TRUNK-SWEEP: triggered.");
  process.exit(EXIT.DONE);
}

// The entry guard `merge-guard.mjs`/`auto-arm-sweep.mjs` use.
if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();

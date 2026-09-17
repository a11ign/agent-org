#!/usr/bin/env node
// command: watchdog: did CI actually run before this commit reached main, checked automatically
// DID CI ACTUALLY RUN BEFORE THIS COMMIT REACHED MAIN? -- #118, generalising `merge-guard.mjs`'s
// per-PR, on-demand check into an AUTOMATIC watchdog for every commit that lands.
//
// Three guards already prove CI is CONFIGURED -- `board-schedule.test.ts` (the crons exist),
// `workflow-path-coverage.test.ts` (#70: every source directory is reachable by some filter), and
// `npm test` (the code that decides is right). None of them asks whether a run any of that machinery
// expected actually HAPPENED. On 2026-09-06 that gap was silent and real: two commits reached `main`
// outside their PR, `ci.yml` arrived and `lint.yml` (retired the same day) went, and the local gate was
// green throughout every one of the three guards above.
//
// `merge-guard.mjs` (#161) already answers the run-half of this question, correctly, for one PR given
// its number -- it reads check RUNS for a head sha rather than `mergeStateStatus`, which reports CLEAN
// for a PR nothing has ever tested (#148: base was another open PR's branch, so `ci.yml`'s
// `pull_request: branches: [main]` trigger never fired at all, and the check-run list was empty against
// a merge state that read CLEAN). Nothing asked that question AUTOMATICALLY, for every commit that
// actually reaches `main` -- which is exactly the shape #118 is filed against.
//
// ## Why this runs on PUSH to main, never on a schedule
//
// `board-schedule-liveness.mjs` and `npm-token-liveness.mjs` are this repo's two existing instances of
// the same rule, stated once so a third copy does not restate it and drift: a watchdog that is itself
// scheduled has the disease it is watching for, because GitHub disables a scheduled workflow after 60
// days without repository activity, silently, with no run and no red mark. `push` cannot be disabled by
// inactivity, because a push IS the activity -- and a push to `main` is exactly the moment a commit that
// might have bypassed its PR's checks has just landed.
//
// ## Three outcomes, never two -- the same discipline `merge-guard.mjs` already established
//
//   TESTED       -- a pull request produced this commit, and every required context ran and concluded
//   NOT TESTED   -- no pull request is associated with this commit, OR its required checks never ran
//   CANNOT TELL  -- a lookup failed. Never reported as healthy: a rate limit or a network failure must
//                   not read as "nothing to see here", which is this repo's most-recorded defect arriving
//                   in the one place it would be most expensive -- the record of what actually shipped.
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
// RELATIVE, NOT the `@a11ign/worker-fleet/cli-flags` package specifier: that export map
// points at `dist/`, so it needs both `node_modules` AND a completed build. This file is reachable
// from a pre-install entry (see `pre-install-import-graph.test.ts`, which derives that population
// rather than naming it), and there it dies on startup with ERR_MODULE_NOT_FOUND.
import { refuseUnknownFlags, flagValue } from "../../worker-fleet/src/cli-flags.mjs";
import { REPO } from "../../../scripts/repo-identity.mjs";
import { gh, lookup, lookupRequiredContexts, lookupCheckRuns, checkReasons } from "./merge-guard.mjs";

export const EXIT = { TESTED: 0, NOT_TESTED: 1, CANNOT_TELL: 2 };

/**
 * A commit CAN be attributed to more than one pull request (a revert re-lands an earlier PR's diff, for
 * one) -- the most recently OPENED one is the one that actually produced this specific push, so it is the
 * one whose checks matter.
 * @param {{number: number, headRefOid: string}[]} pulls
 */
function latestPull(pulls) {
  return pulls.reduce((latest, candidate) => (candidate.number > latest.number ? candidate : latest));
}

/**
 * THE VERDICT, PURE -- so every state (including "no PR at all", which cannot be produced on demand
 * against a live repo without actually pushing straight to `main`) is exercisable without a network.
 *
 * @param {{sha: string,
 *          pulls: {number: number, headRefOid: string}[] | null,
 *          required: string[] | null,
 *          runs: {name: string, status: string, conclusion: string | null, completedAt: string | null}[] | null}} facts
 * @returns {{code: number, reasons: string[], pr: number | null}}
 */
export function commitLiveness({ sha, pulls, required, runs }) {
  const short = sha.slice(0, 10);
  if (pulls === null) {
    return { code: EXIT.CANNOT_TELL, pr: null,
      reasons: [`CANNOT SAY whether ${short} was tested: could not read which pull request produced it.\n`
        + "  This is INCONCLUSIVE, not clear. Re-run with a network and a `gh` credential."] };
  }
  if (pulls.length === 0) {
    return { code: EXIT.NOT_TESTED, pr: null,
      reasons: [`${short} HAS NO ASSOCIATED PULL REQUEST -- it reached main outside the PR flow, so\n`
        + "  branch protection's required checks never had a PR to run against. This is the exact shape\n"
        + "  #118 was filed against: a commit landing on main with no CI having examined it."] };
  }
  const pr = latestPull(pulls);
  if (required === null || runs === null) {
    const missing = [required === null && "the required status checks for `main` (branch protection)",
      runs === null && `the check runs for pull request #${pr.number}`].filter(Boolean);
    return { code: EXIT.CANNOT_TELL, pr: pr.number,
      reasons: [`CANNOT SAY whether ${short} (#${pr.number}) was tested: could not read ${missing.join("; ")}.\n`
        + "  This is INCONCLUSIVE, not clear. Re-run with a network and a `gh` credential."] };
  }
  // REUSED, NOT RE-DERIVED: `checkReasons` already tells "no runs at all" from "a required context
  // missing" from "still running" from "failing" -- the exact taxonomy this row asks for, built for
  // `merge-guard.mjs`'s on-demand case and unchanged here. `pr.headRefOid` is not read by `checkReasons`
  // for anything but the sha it prints, so passing the MERGE COMMIT's own sha (not the PR head's) still
  // names the right commit in the message while `runs` itself was looked up correctly, by the PR's head.
  const reasons = checkReasons({ headRefOid: sha }, required, runs)
    .map((reason) => `${reason} (pull request #${pr.number})`);
  return { code: reasons.length > 0 ? EXIT.NOT_TESTED : EXIT.TESTED, pr: pr.number, reasons };
}

/** Every pull request GitHub associates with a commit, or `null` if the lookup failed. */
function lookupAssociatedPulls(sha) {
  return lookup(() => JSON.parse(gh(["api", `repos/${REPO}/commits/${sha}/pulls`]))
    .map((/** @type {{number: number, head: {sha: string}}} */ p) => ({ number: p.number, headRefOid: p.head.sha })));
}

function facts(sha) {
  const pulls = lookupAssociatedPulls(sha);
  const required = lookupRequiredContexts();
  // The PR's own HEAD sha is what actually ran checks -- the merge/squash commit that landed on `main`
  // is a NEW sha `ci.yml` never triggers on directly (it is `pull_request`/`merge_group` only, by design:
  // "a check that runs after a merge cannot stop it"). Looking up runs for `sha` itself would report
  // NOT_TESTED for every commit that ever reaches `main` through this repo's own intended flow.
  const runs = pulls && pulls.length > 0 ? lookupCheckRuns(latestPull(pulls).headRefOid) : null;
  return { sha, pulls, required, runs };
}

function main() {
  const KNOWN_FLAGS = ["--sha"];
  refuseUnknownFlags(KNOWN_FLAGS, { entry: import.meta.url, command: "node packages/agent-org/src/workflow-run-liveness.mjs" });
  const sha = flagValue(process.argv, "sha") ?? process.env.GITHUB_SHA;
  if (!sha) {
    console.error("Usage: node packages/agent-org/src/workflow-run-liveness.mjs --sha=<commit>\n"
      + "Answers whether the pull request that produced this commit was actually tested before it reached\n"
      + "main, by reading its check RUNS rather than `mergeStateStatus`. Defaults to $GITHUB_SHA.");
    process.exit(EXIT.CANNOT_TELL);
  }

  const verdict = commitLiveness(facts(sha));
  const short = sha.slice(0, 10);
  if (verdict.code === EXIT.TESTED) {
    console.log(`${short} (#${verdict.pr}) is tested: every required context present and concluded before `
      + "it reached main.");
  } else {
    console.error(`${verdict.code === EXIT.NOT_TESTED ? "NOT TESTED" : "CANNOT TELL"} — ${short}:\n`
      + verdict.reasons.map((r) => `- ${r}`).join("\n"));
  }
  process.exit(verdict.code);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();

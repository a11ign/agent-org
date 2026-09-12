/**
 * A COMMIT REACHED main OUTSIDE ITS PR, AND THE LOCAL GATE WAS GREEN THROUGHOUT (#118).
 *
 * Three guards prove CI is correctly CONFIGURED — `board-schedule.test.ts` (the crons exist),
 * `workflow-path-coverage.test.ts` (#70: every source directory is reachable by some filter), and
 * `npm test` (the code that decides is right). Measured 2026-09-06: none of them can see that a
 * workflow's expected run never happened. Two commits reached `main` outside their PR; `ci.yml` arrived
 * and `lint.yml` (retired the same day) went, and every one of those three guards stayed green.
 *
 * `merge-guard.mjs` (#161) already answers the run-half of this correctly, for one PR given its number.
 * This generalises it into a check runnable for any commit that has already reached `main` — the shape
 * that actually failed silently — reusing `lookupRequiredContexts`/`lookupCheckRuns`/`checkReasons`
 * rather than re-deriving them, since a second copy of "how do I know a check actually ran" is exactly
 * this repo's own most-repeated defect.
 *
 * THREE OUTCOMES, never two: TESTED, NOT TESTED, and CANNOT TELL — the last one is not a comfortable
 * default. A lookup failure read as "fine" is how "verified" comes to mean "unexamined", in the one
 * place recording what actually shipped.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { commitLiveness, EXIT } from "../../../../scripts/workflow-run-liveness.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

const SHA = "a1b2c3d4e5f6789012345678901234567890abcd";
const REQUIRED = ["changed", "ts", "python", "ansible", "docs", "changeset"];
const green = () => REQUIRED.map((name) => ({
  name, status: "completed", conclusion: name === "ts" ? "success" : "skipped", completedAt: "2026-09-07T01:00:00Z",
}));

test("THE #118 CASE: a commit with no associated pull request at all is NOT TESTED", () => {
  // The exact incident this row was filed against — a commit reaching main outside the PR flow, so
  // branch protection's required checks never had anything to run against.
  const v = commitLiveness({ sha: SHA, pulls: [], required: REQUIRED, runs: null });
  assert.equal(v.code, EXIT.NOT_TESTED);
  assert.equal(v.pr, null);
  assert.match(v.reasons[0], /NO ASSOCIATED PULL REQUEST/);
  assert.match(v.reasons[0], /outside the PR flow/);
});

test("a commit whose PR ran every required context is TESTED", () => {
  const v = commitLiveness({
    sha: SHA, pulls: [{ number: 200, headRefOid: "deadbeef00" }], required: REQUIRED, runs: green(),
  });
  assert.equal(v.code, EXIT.TESTED, `expected TESTED, got: ${v.reasons.join(" | ")}`);
  assert.equal(v.pr, 200);
  assert.deepEqual(v.reasons, []);
});

test("a commit whose PR has ZERO check runs is NOT TESTED — #148's shape, generalised", () => {
  // `runs: []`, not `null` — the PR exists and GitHub was successfully asked, and the answer was
  // "nothing, ever". This is the state that reads as CLEAN in `mergeStateStatus`.
  const v = commitLiveness({
    sha: SHA, pulls: [{ number: 148, headRefOid: "d5c2436601abcdef" }], required: REQUIRED, runs: [],
  });
  assert.equal(v.code, EXIT.NOT_TESTED);
  assert.equal(v.pr, 148);
  assert.match(v.reasons[0], /NO CHECK RUNS EXIST/);
  assert.match(v.reasons[0], /pull request #148/, "the finding must name which PR to go and look at");
});

test("a commit whose PR is missing one required context is NOT TESTED, and names it", () => {
  const runs = green().filter((r) => r.name !== "changeset");
  const v = commitLiveness({
    sha: SHA, pulls: [{ number: 210, headRefOid: "cafefeed01" }], required: REQUIRED, runs,
  });
  assert.equal(v.code, EXIT.NOT_TESTED);
  assert.match(v.reasons[0], /REQUIRED CONTEXT NEVER RAN: changeset/);
});

test("more than one associated pull request: the most recently opened one decides", () => {
  // A revert can re-land an earlier PR's diff and get associated with both. The one that actually
  // produced THIS push is the higher-numbered one -- an older PR's stale, possibly-empty run list must
  // not be read as this commit's own testedness.
  const v = commitLiveness({
    sha: SHA,
    pulls: [{ number: 90, headRefOid: "old00000" }, { number: 205, headRefOid: "new00000" }],
    required: REQUIRED, runs: green(),
  });
  assert.equal(v.code, EXIT.TESTED, `expected TESTED (PR #205's runs), got: ${v.reasons.join(" | ")}`);
  assert.equal(v.pr, 205, "the higher PR number is the one that produced this push");
});

test("`[]` AND `null` ARE DIFFERENT ANSWERS for pulls, exactly as they are for runs in merge-guard", () => {
  // "no PR produced this commit" and "I could not ask which PR did" demand opposite responses. Collapsing
  // a failed lookup into an empty array would report the least-examined commit as the clearest finding.
  const noPr = commitLiveness({ sha: SHA, pulls: [], required: REQUIRED, runs: null });
  assert.equal(noPr.code, EXIT.NOT_TESTED, "an empty pulls list is a FINDING");

  const couldNotAsk = commitLiveness({ sha: SHA, pulls: null, required: REQUIRED, runs: null });
  assert.equal(couldNotAsk.code, EXIT.CANNOT_TELL, "a failed lookup is INCONCLUSIVE, never 0 or 1");
  assert.match(couldNotAsk.reasons[0], /CANNOT SAY/);
});

test("a failed required-contexts or check-runs lookup is CANNOT TELL, and names which", () => {
  const pulls = [{ number: 148, headRefOid: "d5c2436601abcdef" }];
  const v1 = commitLiveness({ sha: SHA, pulls, required: null, runs: green() });
  assert.equal(v1.code, EXIT.CANNOT_TELL);
  assert.match(v1.reasons[0], /required status checks/);

  const v2 = commitLiveness({ sha: SHA, pulls, required: REQUIRED, runs: null });
  assert.equal(v2.code, EXIT.CANNOT_TELL);
  assert.match(v2.reasons[0], /check runs for pull request #148/);
});

test("the workflow that runs this has no schedule key -- it must fire on push, never on a cron", () => {
  // The exact reason `board-liveness.test.ts` and `npm-token-liveness.test.ts` pin the same thing: a
  // watchdog that is itself scheduled is disabled by the same 60-day inactivity rule it exists to catch.
  // #901: a step in trunk-guard.yml's watchdogs job since 2026-09-10, not a workflow of its own.
  const workflow = readFileSync(path.join(REPO_ROOT, ".github/workflows/trunk-guard.yml"), "utf8");
  assert.doesNotMatch(workflow, /^\s*schedule:/m,
    "trunk-guard.yml must never gain a `schedule:` trigger -- see its own header for why a watchdog "
    + "cannot be a cron");
  assert.match(workflow, /^\s*push:/m, "it must trigger on push, which cannot be disabled by inactivity");
  const step = /- name: Was the pull request that produced this commit actually tested\?[^]*?run: node scripts\/workflow-run-liveness\.mjs --sha=/.exec(workflow);
  assert.ok(step, "the workflow-run watchdog step must still be in trunk-guard.yml");
  assert.match(step![0], /continue-on-error:\s*true/,
    "this step's finding is about a commit that already merged -- it must never fail the push that "
    + "happens to trigger it, which would blame an unrelated author for a gap that opened earlier");
});

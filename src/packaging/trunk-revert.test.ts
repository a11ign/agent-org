/**
 * A PUSH TO `main` THAT FAILS ITS OWN GATE IS REVERTED, UNATTENDED -- unless the failure is INHERITED, or
 * `main` has already moved on. #316 (pipeline unit 3).
 *
 * Two real near-misses, both measured live by `dispatcher` against the actual PR queue the morning this
 * was built, and both are what these tests pin as SHAPES rather than one-off cases:
 *
 *   - 13 of 19 PRs read red on one bad commit and none was at fault -- their own push-to-main gate run
 *     failed for a reason that already existed before they landed. A revert must refuse unless the
 *     commit BEFORE this push was itself verified green.
 *   - `main` was red for 90 minutes; the real fix was a follow-up commit, not a revert. A revert firing
 *     after that follow-up landed would have reverted the FIX. The bound here is not a clock: it is
 *     whether the failing push is STILL `main`'s tip when the decision is made.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { revertVerdict, revertPrBody, revertTriggerJobs, newestRunFor, conclusionOf, EXIT }
  from "../../../../scripts/trunk-revert.mjs";

const PUSH = "a1b2c3d4e5f6789012345678901234567890abcd";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const WORKFLOW = readFileSync(path.join(REPO_ROOT, ".github/workflows/trunk-guard.yml"), "utf8");

/** Every trigger job at one conclusion -- what the pre-#582 single-value argument used to mean. */
const bothAt = (conclusion: string | null): Record<string, string | null> =>
  Object.fromEntries(revertTriggerJobs(WORKFLOW).map((job) => [job, conclusion]));
const GREEN = bothAt("success");

test("READY: the push's own gate failed, the commit before it was green, and main has not moved on", () => {
  const v = revertVerdict({ beforeConclusions: GREEN, currentMainSha: PUSH, pushSha: PUSH });
  assert.equal(v.code, EXIT.READY, v.reason);
});

test("THE #316 INHERITED-FAILURE CASE: the commit before this push was already red -- refuse, never revert", () => {
  const v = revertVerdict({ beforeConclusions: bothAt("failure"), currentMainSha: PUSH, pushSha: PUSH });
  assert.equal(v.code, EXIT.REFUSED);
  assert.match(v.reason, /INHERITED/);
  assert.match(v.reason, /remove innocent work/);
});

test("a before-conclusion of anything other than success is treated the same as failure -- cancelled, timed_out, etc.", () => {
  for (const conclusion of ["cancelled", "timed_out", "action_required", "neutral"]) {
    const v = revertVerdict({ beforeConclusions: bothAt(conclusion), currentMainSha: PUSH, pushSha: PUSH });
    assert.equal(v.code, EXIT.REFUSED, `conclusion=${conclusion} must refuse, not just "failure" literally`);
  }
});

test("MUTATION target: beforeConclusions === null is CANNOT_ASK, never coerced into READY or REFUSED", () => {
  const v = revertVerdict({ beforeConclusions: null, currentMainSha: PUSH, pushSha: PUSH });
  assert.equal(v.code, EXIT.CANNOT_ASK);
  assert.match(v.reason, /CANNOT SAY/);
});

test("null before-conclusion covers the FIRST PUSH this workflow has ever seen, and says so", () => {
  const v = revertVerdict({ beforeConclusions: null, currentMainSha: PUSH, pushSha: PUSH });
  assert.match(v.reason, /first push/);
});

test("THE #316 STALE-ACTION CASE: main has moved on since this push -- refuse rather than revert a possible fix", () => {
  const laterSha = "9988776655443322110099887766554433221100";
  const v = revertVerdict({ beforeConclusions: GREEN, currentMainSha: laterSha, pushSha: PUSH });
  assert.equal(v.code, EXIT.REFUSED);
  assert.match(v.reason, /moved on/);
  assert.match(v.reason, /already have/);
});

test("currentMainSha === pushSha (the exact-match case) is what makes READY possible at all", () => {
  const v = revertVerdict({ beforeConclusions: GREEN, currentMainSha: PUSH, pushSha: PUSH });
  assert.equal(v.code, EXIT.READY);
});

test("a failed lookup of main's current tip is CANNOT_ASK, never treated as \"still the tip\"", () => {
  const v = revertVerdict({ beforeConclusions: GREEN, currentMainSha: null, pushSha: PUSH });
  assert.equal(v.code, EXIT.CANNOT_ASK);
});

test("the inherited-failure check is asked BEFORE the staleness check -- a stale AND inherited push reads as inherited, the more specific fault", () => {
  const laterSha = "9988776655443322110099887766554433221100";
  const v = revertVerdict({ beforeConclusions: bothAt("failure"), currentMainSha: laterSha, pushSha: PUSH });
  assert.match(v.reason, /INHERITED/);
});

/**
 * `revertPrBody` names everything `ceo` asked for: the original PR and its author, the failure, and the
 * reverted sha -- because `git revert -m 1` is itself revertible and somebody will need that sha.
 */

test("revertPrBody names the original PR, its author, the reverted sha and the run URL", () => {
  const body = revertPrBody({
    pushSha: PUSH,
    originPr: { number: 309, author: "worker-config", title: "feat(#298): CI/CD pipeline unit 1" },
    runUrl: "https://github.com/a11ign/a11ign/actions/runs/123",
  });
  assert.match(body, /#309/);
  assert.match(body, /@worker-config/);
  assert.match(body, new RegExp(PUSH));
  assert.match(body, /actions\/runs\/123/);
  assert.match(body, new RegExp(`Reverts commit ${PUSH}`), "the exact marker lookupExistingRevertPr searches for");
});

test("revertPrBody degrades honestly when the original PR could not be identified, rather than inventing one", () => {
  const body = revertPrBody({ pushSha: PUSH, originPr: null, runUrl: "https://example.test/run" });
  assert.match(body, /could not be identified/);
  assert.doesNotMatch(body, /#undefined/);
  assert.match(body, new RegExp(`Reverts commit ${PUSH}`));
});

test("revertPrBody always carries its own idempotency marker, so a re-run can find it and skip a duplicate", () => {
  const withOrigin = revertPrBody({
    pushSha: PUSH, originPr: { number: 1, author: "a", title: "t" }, runUrl: "https://example.test",
  });
  const withoutOrigin = revertPrBody({ pushSha: PUSH, originPr: null, runUrl: "https://example.test" });
  const marker = `Reverts commit ${PUSH}.`;
  assert.ok(withOrigin.includes(marker));
  assert.ok(withoutOrigin.includes(marker));
});

// ---------------------------------------------------------------------------------------------------
// #582: THE "BEFORE" QUESTION IS ASKED OF EVERY JOB THAT CAN MAKE MAIN RED, NOT OF ONE OF THEM.
//
// A1 widened `decideRevert`'s trigger to `needs.trunkGate.result == 'failure' ||
// needs.trunkBuildTest.result == 'failure'` and left the before-lookup reading `trunkGate` alone. So an
// inherited `trunkBuildTest` failure read as this push's own. Measured on `f4c8ff9c`, whose parent
// `1684c17d` carried `trunkGate: success` with `trunkBuildTest / run: failure`: the verdict printed "the
// commit before it was green" and reached READY on a merge that had broken nothing. It was not reverted
// only because the repository forbids Actions from opening PRs (#575) -- a credential gap protecting the
// pipeline by accident, which is not a guard.
// ---------------------------------------------------------------------------------------------------

test("#582 THE REAL CASE, REPLAYED: trunkGate green and trunkBuildTest red is NOT a green parent", () => {
  const v = revertVerdict({
    beforeConclusions: { trunkGate: "success", trunkBuildTest: "failure" },
    currentMainSha: PUSH, pushSha: PUSH,
  });
  assert.equal(v.code, EXIT.REFUSED, v.reason);
  assert.match(v.reason, /INHERITED/);
  assert.match(v.reason, /trunkBuildTest/, "and it must NAME the job that was red, not merely refuse");
});

test("#582 the other order too -- neither job is the privileged one", () => {
  const v = revertVerdict({
    beforeConclusions: { trunkGate: "failure", trunkBuildTest: "success" },
    currentMainSha: PUSH, pushSha: PUSH,
  });
  assert.equal(v.code, EXIT.REFUSED);
  assert.match(v.reason, /trunkGate/);
});

test("#582 ANTI-VACUITY: an empty job map is CANNOT_ASK, never a vacuous READY", () => {
  // Every check is "no job is red", which an empty map satisfies trivially -- so a broken derivation
  // would turn the whole verdict into an unconditional READY. This is the failure mode a derived list
  // has and a hand-written one does not, so it must be refused rather than believed.
  const v = revertVerdict({ beforeConclusions: {}, currentMainSha: PUSH, pushSha: PUSH });
  assert.equal(v.code, EXIT.CANNOT_ASK, v.reason);
  assert.match(v.reason, /broken derivation/);
});

test("#582 one job with no completed record is CANNOT_ASK -- 'not yet known to be green' is not 'green', "
  + "and it is not 'red' either", () => {
  const v = revertVerdict({
    beforeConclusions: { trunkGate: "success", trunkBuildTest: null },
    currentMainSha: PUSH, pushSha: PUSH,
  });
  assert.equal(v.code, EXIT.CANNOT_ASK, v.reason);
  assert.match(v.reason, /trunkBuildTest/);
  assert.notEqual(v.code, EXIT.REFUSED, "an unknown job must not be silently counted as a red one");
});

test("#582 DERIVED, NEVER LISTED: the job set comes from trunk-guard.yml's own if:, and contains both", () => {
  const jobs = revertTriggerJobs(WORKFLOW);
  assert.deepEqual([...jobs].sort(), ["trunkBuildTest", "trunkGate"],
    "if this fails because a job was added to decideRevert's if:, that is the guard working -- add it to "
    + "this expectation deliberately rather than widening the assertion");
  const condition = /^\s{4}if:\s*(.+)$/m.exec(WORKFLOW.split(/^ {2}decideRevert:$/m)[1] ?? "");
  assert.ok(condition, "decideRevert must still carry an if: -- an unconditional job reverts every push");
  for (const job of jobs) assert.match(condition[1], new RegExp(`needs\\.${job}\\.result`));
});

test("#582 MUTATION TARGET: a job named in the if: but absent from the map cannot reach READY", () => {
  // The mutation this is pointed at is narrowing the lookup back to one job. With `trunkBuildTest`
  // dropped from the map, its red conclusion is unreachable and the verdict returns to READY -- the
  // exact defect. Asserting on the map's KEYS rather than on the verdict alone, because the verdict is
  // correct for the map it is handed; what was wrong was the map.
  const jobs = revertTriggerJobs(WORKFLOW);
  const partial = { [jobs[0]]: "success" };
  assert.equal(Object.keys(partial).length < jobs.length, true, "fixture premise: this map is short one job");
  assert.equal(revertVerdict({ beforeConclusions: partial, currentMainSha: PUSH, pushSha: PUSH }).code,
    EXIT.READY, "a short map reads READY -- which is why the map must be built from the derived list");
});

test("#582 newestRunFor takes the NEWEST of several runs of one name, never the first (#498/#500/#517)", () => {
  const runs = [
    { name: "trunkGate", status: "completed", conclusion: "failure", completedAt: "2026-09-08T20:30:00Z" },
    { name: "trunkGate", status: "completed", conclusion: "success", completedAt: "2026-09-08T20:40:00Z" },
  ];
  assert.equal(newestRunFor(runs, "trunkGate")?.conclusion, "success");
  assert.equal(newestRunFor([...runs].reverse(), "trunkGate")?.conclusion, "success",
    "and the answer must not depend on the order the API happened to return them in");
});

test("#582 a reusable-workflow job is published as `<job> / <inner>` and must still be found", () => {
  // `trunkBuildTest` calls reusable-build-test.yml, whose own job is `run`, so the check-run is named
  // `trunkBuildTest / run`. An exact-name match finds nothing, returns null, and the whole verdict reads
  // CANNOT_ASK -- a wrong answer that presents as an API problem rather than as this bug.
  const runs = [
    { name: "trunkBuildTest / run", status: "completed", conclusion: "failure", completedAt: "2026-09-08T20:41:00Z" },
  ];
  assert.equal(newestRunFor(runs, "trunkBuildTest")?.conclusion, "failure");
  assert.equal(newestRunFor(runs, "trunkBuild"), null,
    "and the prefix must be a whole job name plus the separator, never any string that starts the same");
});

test("#582 an in-flight run reports the ZERO DATE, so it never outranks a real completion", () => {
  const runs = [
    { name: "trunkGate", status: "completed", conclusion: "success", completedAt: "2026-09-08T20:40:00Z" },
    { name: "trunkGate", status: "in_progress", conclusion: "", completedAt: "0001-01-01T00:00:00Z" },
  ];
  assert.equal(newestRunFor(runs, "trunkGate")?.status, "completed");
});

test("#582 conclusionOf: an unfinished run's empty-string conclusion is null, never a verdict", () => {
  // `|| null`, not `??` -- one operator wide, and the difference between CANNOT_ASK and REFUSED.
  assert.equal(conclusionOf({ status: "in_progress", conclusion: "" }), null);
  assert.equal(conclusionOf({ status: "completed", conclusion: "" }), null);
  assert.equal(conclusionOf({ status: "completed", conclusion: "success" }), "success");
  assert.equal(conclusionOf({ status: "completed", conclusion: "failure" }), "failure");
  assert.equal(conclusionOf(null), null);
});

test("#582 the READY sentence NAMES the jobs it checked, so a future narrowing is visible in the log", () => {
  const v = revertVerdict({ beforeConclusions: GREEN, currentMainSha: PUSH, pushSha: PUSH });
  assert.equal(v.code, EXIT.READY);
  for (const job of revertTriggerJobs(WORKFLOW)) assert.match(v.reason, new RegExp(job));
});

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
import { revertVerdict, revertPrBody, revertTriggerJobs, newestRunFor, conclusionOf,
  prCreateArgs, pushedNoPrMessage, EXIT }
  from "../../../../scripts/trunk-revert.mjs";

const PUSH = "a1b2c3d4e5f6789012345678901234567890abcd";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const WORKFLOW = readFileSync(path.join(REPO_ROOT, ".github/workflows/trunk.yml"), "utf8");

/** Every trigger job at one conclusion -- what the pre-#582 single-value argument used to mean. */
const bothAt = (conclusion: string | null): Record<string, string | null> =>
  Object.fromEntries(revertTriggerJobs(WORKFLOW).map((job) => [job, conclusion]));
const GREEN = bothAt("success");

test("READY: the push's own gate failed, the commit before it was green, and main has not moved on", () => {
  const v = revertVerdict({ beforeConclusions: GREEN, currentMainSha: PUSH, pushSha: PUSH, parentRecheck: "pass" });
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
  const v = revertVerdict({ beforeConclusions: GREEN, currentMainSha: laterSha, pushSha: PUSH, parentRecheck: "pass" });
  assert.equal(v.code, EXIT.REFUSED);
  assert.match(v.reason, /moved on/);
  assert.match(v.reason, /already have/);
});

test("currentMainSha === pushSha (the exact-match case) is what makes READY possible at all", () => {
  const v = revertVerdict({ beforeConclusions: GREEN, currentMainSha: PUSH, pushSha: PUSH, parentRecheck: "pass" });
  assert.equal(v.code, EXIT.READY);
});

test("a failed lookup of main's current tip is CANNOT_ASK, never treated as \"still the tip\"", () => {
  const v = revertVerdict({ beforeConclusions: GREEN, currentMainSha: null, pushSha: PUSH, parentRecheck: "pass" });
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

test("#582 DERIVED, NEVER LISTED: the job set comes from trunk.yml's own if:, and contains both", () => {
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
  assert.equal(revertVerdict({ beforeConclusions: partial, currentMainSha: PUSH, pushSha: PUSH,
    parentRecheck: "pass" }).code,
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
  const v = revertVerdict({ beforeConclusions: GREEN, currentMainSha: PUSH, pushSha: PUSH, parentRecheck: "pass" });
  assert.equal(v.code, EXIT.READY);
  for (const job of revertTriggerJobs(WORKFLOW)) assert.match(v.reason, new RegExp(job));
});

// ---------------------------------------------------------------------------------------------------
// #616: A REVERT PR OPENS AS A DRAFT, BECAUSE THIS DECISION CANNOT YET TELL A BROKEN PUSH FROM A CLOCK.
// ---------------------------------------------------------------------------------------------------

test("#616 the revert PR is opened as a DRAFT -- the one flag standing between a wrong verdict and a "
  + "merged revert", () => {
  // 2026-09-09, this decision's first end-to-end execution: main went red on a WALL-CLOCK assertion ("the
  // summary states WHEN it was written, and that time is within 60 minutes of the render"). The previous
  // commit was green, verifiably, in its own run sixty-one minutes earlier -- so the verdict was true of
  // its inputs and false of the world, and #615 was opened, ARMED, against a merge that touched only the
  // merge-guard rules. #582 taught this to recognise a failure that ALREADY EXISTED; it still cannot
  // recognise one that DID NOT EXIST when the parent was measured. Both print "the commit before was
  // green" and only one means it.
  //
  // Asserted on the argv rather than on `performRevert`, which spawns git and `gh` and has no unit test.
  // A one-flag decision is exactly what a refactor loses silently.
  const args = prCreateArgs({ title: "revert: x broke main", body: "b", branch: "revert/abc-316" });
  assert.ok(args.includes("--draft"),
    "without --draft the revert PR is mergeable the moment its own gate is green, and the verdict that "
    + "opened it has not been read by anyone");
  assert.deepEqual(args.slice(0, 2), ["pr", "create"]);
  assert.ok(args.includes("--head") && args.includes("revert/abc-316"));
});

// --- #578: PUSHED, PR NOT OPENED is its own distinct, named outcome ---

test("#578 ACCEPTANCE: EXIT.PUSHED_NO_PR is distinct from every other exit code", () => {
  const codes = Object.values(EXIT);
  assert.equal(new Set(codes).size, codes.length, "every EXIT code must be unique");
  assert.equal(typeof EXIT.PUSHED_NO_PR, "number");
});

test("#578 ACCEPTANCE, MUTATION TARGET: the message names the branch, the real gh error, and how to "
  + "finish by hand -- measured on run 34275102543's exact failure ('GraphQL: GitHub Actions is not "
  + "permitted to create or approve pull requests')", () => {
  const message = pushedNoPrMessage({
    branch: "revert/4e87c87565-316",
    pushSha: "4e87c87565aabbccddeeff00112233445566778",
    cause: new Error("GraphQL: GitHub Actions is not permitted to create or approve pull requests "
      + "(createPullRequest)"),
  });
  assert.match(message, /revert\/4e87c87565-316/, "the branch name must be in the message, not implied");
  assert.match(message, /GraphQL: GitHub Actions is not permitted/, "the real cause, not a generic label");
  assert.match(message, /gh pr create/, "the exact command to finish this by hand");
  assert.match(message, /git push origin --delete/, "the exact command to clean up, if the revert was wrong");
});

test("#578: the message is built from a plain Error OR a non-Error throw -- gh's own execFileSync "
  + "failures are not guaranteed to be Error instances", () => {
  const message = pushedNoPrMessage({ branch: "revert/x-316", pushSha: "x".repeat(40), cause: "raw string" });
  assert.match(message, /raw string/);
});

test("#616 MUTATION TARGET: nothing in the revert path arms the PR", () => {
  // The old code armed it directly, because a PR created with GITHUB_TOKEN fires no `pull_request` event
  // and `auto-arm.yml` would therefore never see it. That fact is unchanged and is now load-bearing in
  // the other direction: un-drafting alone does not arm it either, so whoever confirms the attribution
  // must arm it by hand. That is the right amount of friction for an action that deletes merged work.
  const source = readFileSync(path.join(REPO_ROOT, "scripts/trunk-revert.mjs"), "utf8");
  const armCall = /gh\(\[\s*"pr",\s*"merge"[\s\S]{0,120}?"--auto"/.exec(source);
  assert.equal(armCall, null,
    "trunk-revert.mjs must not arm its own revert PR: a draft that arms itself is not a hold");
});

// ---------------------------------------------------------------------------------------------------
// #616: WAS THE PARENT GREEN BECAUSE IT WAS CORRECT, OR BECAUSE IT WAS MEASURED EARLIER?
//
// Every other input to this decision is a RECORDED conclusion, and a recorded conclusion is true as of
// the moment it was taken. On 2026-09-09 main went red on a wall-clock assertion; the parent was green,
// verifiably, in its own run sixty-one minutes earlier; every check passed and a revert PR was opened
// against a merge that had broken nothing. product-manager's statement of it: the input silently encoded
// the time it was read, so the revert's own freshness check inherited the staleness it was measuring.
// ---------------------------------------------------------------------------------------------------

test("#616 a parent that was recorded green and FAILS THE SAME CHECK NOW cannot be attributed", () => {
  const v = revertVerdict({ beforeConclusions: GREEN, currentMainSha: PUSH, pushSha: PUSH,
    parentRecheck: "fail" });
  assert.equal(v.code, EXIT.REFUSED);
  assert.match(v.reason, /COULD NOT ATTRIBUTE/);
  assert.match(v.reason, /the world's rather than this push's/);
});

test("#616 THE TEST ceo NAMED: the two sentences never print the same words", () => {
  // "this push's own" and "could not attribute" need OPPOSITE responses -- revert the merge, or go and
  // find what moved in the world. Before #616 they printed the same sentence, which is why a decision
  // that was wrong about the world still read as confident. Any overlap here is the defect returning.
  const inherited = revertVerdict({
    beforeConclusions: { trunkGate: "success", trunkBuildTest: "failure" },
    currentMainSha: PUSH, pushSha: PUSH, parentRecheck: "pass" });
  const unattributable = revertVerdict({ beforeConclusions: GREEN, currentMainSha: PUSH, pushSha: PUSH,
    parentRecheck: "fail" });
  const ready = revertVerdict({ beforeConclusions: GREEN, currentMainSha: PUSH, pushSha: PUSH,
    parentRecheck: "pass" });

  assert.equal(inherited.code, EXIT.REFUSED);
  assert.equal(unattributable.code, EXIT.REFUSED);   // same code, and that is fine
  assert.notEqual(inherited.reason, unattributable.reason);
  assert.match(inherited.reason, /ALREADY RED/);
  assert.match(unattributable.reason, /COULD NOT ATTRIBUTE/);
  assert.doesNotMatch(inherited.reason, /COULD NOT ATTRIBUTE/);
  assert.doesNotMatch(unattributable.reason, /ALREADY RED/);
  // And the unattributable refusal SAYS how it differs from the inherited one, in the message itself --
  // a reader meeting it once should not have to find this test to know which of the two they have.
  assert.match(unattributable.reason, /NOT the inherited-failure refusal/);
  assert.notEqual(ready.reason, unattributable.reason);
});

test("#616 MUTATION TARGET: a re-check that did not happen is CANNOT_ASK, never READY", () => {
  // The one function where an open question must not resolve toward acting. `null` is the default, so a
  // caller that forgets to pass it gets a refusal rather than a revert.
  const v = revertVerdict({ beforeConclusions: GREEN, currentMainSha: PUSH, pushSha: PUSH });
  assert.equal(v.code, EXIT.CANNOT_ASK);
  assert.match(v.reason, /was not re-run/);
  assert.match(v.reason, /true as of the moment it was taken/);
});

test("#616 the inherited check still comes FIRST -- a parent already red is not a re-check question", () => {
  // Ordering matters for the message rather than the code: a parent that was red when measured needs no
  // re-run to explain it, and reporting it as unattributable would send the reader looking for a change
  // in the world that is not there.
  const v = revertVerdict({
    beforeConclusions: { trunkGate: "success", trunkBuildTest: "failure" },
    currentMainSha: PUSH, pushSha: PUSH, parentRecheck: "fail" });
  assert.match(v.reason, /ALREADY RED/, "the more specific fault wins, as it does for staleness");
});

test("#616 READY now asserts BOTH facts, so the log says which question was asked", () => {
  const v = revertVerdict({ beforeConclusions: GREEN, currentMainSha: PUSH, pushSha: PUSH,
    parentRecheck: "pass" });
  assert.equal(v.code, EXIT.READY);
  assert.match(v.reason, /still passes that check when re-run now/);
});

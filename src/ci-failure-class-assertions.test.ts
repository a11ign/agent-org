// #1166: a red check's class is read from its FAILING ASSERTIONS, and a same-head re-fail reaches the owner. The fake code host and a fake decision state only: no network, no real key, no corpus.
// no-token: gh -- every `redCheck` here seeds the fake code host with the red check `readCiFailure` reads (A11-160, step 9); nothing reaches the real `gh`
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { CI_CLASS, classifyCiFailure, readCiFailure, rateLimitOrLostRunner, routeFor } from "./ci-failure-class.ts";
import { forgetActivation, substituteCodeHost } from "./plugins/active.ts";
import { createFakeCodeHost } from "./plugins/fakes/code-host.ts";

afterEach(() => forgetActivation());

const SHA = "abcdef12".padEnd(40, "0");
const NOW = Date.parse("2026-10-12T12:00:00Z");
const PR = { repo: "o/r", number: 77, head8: "abcdef12" };
const ON = { assertionsOnly: true };
const OFF = { assertionsOnly: false };
// no provider declared: the class is the rule's, and nothing is asked or printed
const NO_PROVIDER = { host: {}, switches: {}, diagnostic: () => {} };

/**
 * The fake code host in place with one red check, #77 of o/r at `SHA`, whose job log is `log` and whose workflow run is on `attempt`. What `readCiFailure` reads of GitHub is this. The runner it is handed is the one
 * the live tool hands the code host: the fake acts on its world and never calls it.
 */
function redCheck(log: string, attempt = 1) {
  const host = createFakeCodeHost();
  host.rowsWorld.tail.classes.failingChecksOf.set("o/r#77", { headSha: SHA, read: { branch: "agent/x-77", workflow: "CI", runAttempt: attempt, log } });
  substituteCodeHost(host);
  return (): string => { throw new Error("the fake code host runs nothing"); };
}

// A passing test that prints rate-limit and 502 text, and one assertion that fails in the same job.
const PASSING_PRINTS = "ok 1 - the backoff\n# API rate limit exceeded for user\n# 502 Bad Gateway from the mock host\n";
const FAILING_ASSERTION = "not ok 2 - THE CONTROL: A REAL TICK OVER A QUIET QUEUE SAYS NOTHING ABOUT A BACKLOG\n  AssertionError [ERR_ASSERTION]: expected 'quiet', got 'backlog'\n";
const RED_TEST_LOG = PASSING_PRINTS + FAILING_ASSERTION;
// A runner lost before any assertion ran: no failing assertion line, only the runner's own `##[error]` messages.
const LOST_RUNNER_LOG = "Current runner version: '2.329.0'\n##[error]The runner has received a shutdown signal. This can happen when the runner service is stopped.\n##[error]The hosted runner: lost communication with the server. Anything in your workflow may have run.\n";

test("the flag is shipped ON, so the failing assertions are read by default and the explicit OFF is today's whole-log read", () => {
  assert.equal(CI_CLASS.assertionsOnly, true);
  assert.equal(readCiFailure(PR, redCheck(RED_TEST_LOG), NOW)!.rateLimitOrRunnerLost, false, "no flag passed: the printed rate limit is the passing test's output, not the cause");
  assert.equal(readCiFailure(PR, redCheck(RED_TEST_LOG), NOW, OFF)!.rateLimitOrRunnerLost, true, "the explicit OFF reads the whole log, as before");
});

test("a passing test's rate-limit text beside a failing assertion is the test's output: infrastructure before the flag, own-defect after it, routed to the owner", async () => {
  const before = readCiFailure(PR, redCheck(RED_TEST_LOG), NOW, OFF)!;
  assert.equal(before.rateLimitOrRunnerLost, true, "OFF reads the whole log: the printed rate limit is read as the runner's");
  const wrong = await classifyCiFailure(before, NO_PROVIDER);
  assert.deepEqual([wrong.klass, wrong.route], ["infrastructure", "rerun-after-reset"]);

  const after = readCiFailure(PR, redCheck(RED_TEST_LOG), NOW, ON)!;
  assert.equal(after.rateLimitOrRunnerLost, false, "ON reads only the failing assertion lines, which name no rate limit");
  const decision = await classifyCiFailure(after, NO_PROVIDER);
  assert.deepEqual([decision.klass, decision.route, decision.via], ["own-defect", "owner", "none"]);
});

test("a same-head re-fail that fails the same way reaches the owner with the assertion, on its first run and its second", async () => {
  for (const attempt of [1, 2]) {
    const failure = readCiFailure(PR, redCheck(RED_TEST_LOG, attempt), NOW, ON)!;
    assert.equal(failure.rerunAlready, attempt > 1);
    assert.ok(failure.errorLines.some((line) => line.includes("AssertionError [ERR_ASSERTION]: expected 'quiet', got 'backlog'")), "the assertion is what the owner is sent");
    const decision = await classifyCiFailure(failure, NO_PROVIDER);
    assert.deepEqual([decision.klass, decision.route], ["own-defect", "owner"], `attempt ${attempt}`);
  }
  assert.equal(routeFor("own-defect", { rerunAlready: true }), "owner");
});

test("a runner lost before any assertion ran is still infrastructure, with the flag ON", async () => {
  const failure = readCiFailure(PR, redCheck(LOST_RUNNER_LOG), NOW, ON)!;
  assert.equal(failure.rateLimitOrRunnerLost, true);
  const decision = await classifyCiFailure(failure, NO_PROVIDER);
  assert.deepEqual([decision.klass, decision.route], ["infrastructure", "rerun-after-reset"]);
});

test("a rate limit that a failing assertion itself names is still the cause, with the flag ON", () => {
  assert.equal(rateLimitOrLostRunner("AssertionError: expected the rate limit to reset\n", ON), true);
  assert.equal(rateLimitOrLostRunner("not ok 1 - the thing\nAssertionError: expected 1 to equal 2\n", ON), false);
});

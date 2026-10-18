// #1166: a red check's class is read from its FAILING ASSERTIONS, and a same-head re-fail reaches the owner. A fake `gh` stub and a fake decision state only: no network, no real key, no corpus.
// no-token: gh -- every `fakeGh` here is a stub that answers the reads `readCiFailure` makes; nothing reaches the real `gh`
import assert from "node:assert/strict";
import { test } from "node:test";
import { CI_CLASS, classifyCiFailure, readCiFailure, rateLimitOrLostRunner, routeFor } from "./ci-failure-class.ts";

const SHA = "abcdef12".padEnd(40, "0");
const NOW = Date.parse("2026-10-12T12:00:00Z");
const PR = { repo: "o/r", number: 77, head8: "abcdef12" };
const ON = { assertionsOnly: true };
const OFF = { assertionsOnly: false };
// no provider declared: the class is the rule's, and nothing is asked or printed
const NO_PROVIDER = { host: {}, switches: {}, diagnostic: () => {} };

/** A `fakeGh` that answers the reads `readCiFailure` makes for one red check whose job log is `log`, on run attempt `attempt`. */
function fakeGh(log: string, attempt = 1) {
  return (args: string[]): string => {
    const path = args[1];
    if (path.endsWith("/pulls/77")) return JSON.stringify({ head: { sha: SHA, ref: "agent/x-77" } });
    if (path.includes(`/commits/${SHA}/check-runs`)) {
      return JSON.stringify({ check_runs: [{ name: "ts", conclusion: "failure", details_url: "https://github.com/o/r/actions/runs/555/job/666" }] });
    }
    if (path.endsWith("/actions/runs/555")) return JSON.stringify({ name: "CI", run_attempt: attempt });
    if (path.endsWith("/actions/jobs/666/logs")) return log;
    if (path.includes("/actions/runs?")) return JSON.stringify({ workflow_runs: [] });
    throw new Error(`unexpected fakeGh ${args.join(" ")}`);
  };
}

// A passing test that prints rate-limit and 502 text, and one assertion that fails in the same job.
const PASSING_PRINTS = "ok 1 - the backoff\n# API rate limit exceeded for user\n# 502 Bad Gateway from the mock host\n";
const FAILING_ASSERTION = "not ok 2 - THE CONTROL: A REAL TICK OVER A QUIET QUEUE SAYS NOTHING ABOUT A BACKLOG\n  AssertionError [ERR_ASSERTION]: expected 'quiet', got 'backlog'\n";
const RED_TEST_LOG = PASSING_PRINTS + FAILING_ASSERTION;
// A runner lost before any assertion ran: no failing assertion line, only the runner's own `##[error]` messages.
const LOST_RUNNER_LOG = "Current runner version: '2.329.0'\n##[error]The runner has received a shutdown signal. This can happen when the runner service is stopped.\n##[error]The hosted runner: lost communication with the server. Anything in your workflow may have run.\n";

test("the flag is shipped ON, so the failing assertions are read by default and the explicit OFF is today's whole-log read", () => {
  assert.equal(CI_CLASS.assertionsOnly, true);
  assert.equal(readCiFailure(PR, fakeGh(RED_TEST_LOG), NOW)!.rateLimitOrRunnerLost, false, "no flag passed: the printed rate limit is the passing test's output, not the cause");
  assert.equal(readCiFailure(PR, fakeGh(RED_TEST_LOG), NOW, OFF)!.rateLimitOrRunnerLost, true, "the explicit OFF reads the whole log, as before");
});

test("a passing test's rate-limit text beside a failing assertion is the test's output: infrastructure before the flag, own-defect after it, routed to the owner", async () => {
  const before = readCiFailure(PR, fakeGh(RED_TEST_LOG), NOW, OFF)!;
  assert.equal(before.rateLimitOrRunnerLost, true, "OFF reads the whole log: the printed rate limit is read as the runner's");
  const wrong = await classifyCiFailure(before, NO_PROVIDER);
  assert.deepEqual([wrong.klass, wrong.route], ["infrastructure", "rerun-after-reset"]);

  const after = readCiFailure(PR, fakeGh(RED_TEST_LOG), NOW, ON)!;
  assert.equal(after.rateLimitOrRunnerLost, false, "ON reads only the failing assertion lines, which name no rate limit");
  const decision = await classifyCiFailure(after, NO_PROVIDER);
  assert.deepEqual([decision.klass, decision.route, decision.via], ["own-defect", "owner", "none"]);
});

test("a same-head re-fail that fails the same way reaches the owner with the assertion, on its first run and its second", async () => {
  for (const attempt of [1, 2]) {
    const failure = readCiFailure(PR, fakeGh(RED_TEST_LOG, attempt), NOW, ON)!;
    assert.equal(failure.rerunAlready, attempt > 1);
    assert.ok(failure.errorLines.some((line) => line.includes("AssertionError [ERR_ASSERTION]: expected 'quiet', got 'backlog'")), "the assertion is what the owner is sent");
    const decision = await classifyCiFailure(failure, NO_PROVIDER);
    assert.deepEqual([decision.klass, decision.route], ["own-defect", "owner"], `attempt ${attempt}`);
  }
  assert.equal(routeFor("own-defect", { rerunAlready: true }), "owner");
});

test("a runner lost before any assertion ran is still infrastructure, with the flag ON", async () => {
  const failure = readCiFailure(PR, fakeGh(LOST_RUNNER_LOG), NOW, ON)!;
  assert.equal(failure.rateLimitOrRunnerLost, true);
  const decision = await classifyCiFailure(failure, NO_PROVIDER);
  assert.deepEqual([decision.klass, decision.route], ["infrastructure", "rerun-after-reset"]);
});

test("a rate limit that a failing assertion itself names is still the cause, with the flag ON", () => {
  assert.equal(rateLimitOrLostRunner("AssertionError: expected the rate limit to reset\n", ON), true);
  assert.equal(rateLimitOrLostRunner("not ok 1 - the thing\nAssertionError: expected 1 to equal 2\n", ON), false);
});

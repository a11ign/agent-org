// no-token: none -- the unit tests drive `readWithRetry` with a counting read; nothing reaches GitHub (the end-to-end cases are `plugins/github/rows/close-rows-sweep-retry-process.test.ts`)
// a11ign/agent-org#1175 (class `main-red`; a11ign/a11ign run 38246775013): close-rows-sweep read the merged-PR list ONCE, so a GitHub 502 on that read exited
// `CANNOT ASK` (2) and `trunk`'s `closeRows` job went red, and `readTrunkRed` counted a red `main` where `main` was fine. The read is retried on a transient 5xx,
// behind `sweep.retryTransient`, shipped OFF. This file pins the three done-when clauses: the retry (1), the attempt cap and the 4xx (2), and the switch OFF (3).
//
// NO NETWORK: the unit tests drive `readWithRetry` with a counting read and a no-op pause, so the suite does not wait. The sweep's own exit code, with a fake `gh` first on PATH of the real program, is held by
// `plugins/github/rows/close-rows-sweep-retry-process.test.ts` (A11-160, step 9: it is the plugin's end-to-end test, as the other process tests there are).
import { test } from "node:test";
import assert from "node:assert/strict";
import { MERGED_READ_ATTEMPTS, readWithRetry, retryTransientOn } from "./close-rows-sweep.ts";

// ---- done-when 2 and the 4xx clause, unit: the retry itself ------------------------------------------------------------------------------------

/** A read that answers `answers` in order (an Error throws, anything else returns); the last answer repeats. Counts its calls. */
function sequenced(answers: (unknown | Error)[]) {
  let calls = 0;
  const read = () => {
    const answer = answers[Math.min(calls, answers.length - 1)];
    calls += 1;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { read, calls: () => calls };
}

test("done-when 1, unit: a 502 on the first read and a list on the second returns the list, after one wait", () => {
  const { read, calls } = sequenced([new Error("Command failed: gh api graphql\ngh: HTTP 502"), ["PR 5214"]]);
  const pauses: number[] = [];
  assert.deepEqual(readWithRetry(read, (ms) => pauses.push(ms)), ["PR 5214"]);
  assert.equal(calls(), 2, "read again once");
  assert.deepEqual(pauses, [1000], "one wait, before the second attempt");
});

test("done-when 2, unit: a read that answers 502 on every attempt is tried MERGED_READ_ATTEMPTS times and no more, and the throw names the attempts", () => {
  assert.equal(MERGED_READ_ATTEMPTS, 3, "the cap the row names");
  const { read, calls } = sequenced([new Error("gh: HTTP 502")]);
  const pauses: number[] = [];
  assert.throws(() => readWithRetry(read, (ms) => pauses.push(ms)), (error: Error) => {
    assert.match(error.message, /^all 3 attempts failed, the last with: gh: HTTP 502$/);
    return true;
  });
  assert.equal(calls(), 3, "three attempts in all");
  assert.deepEqual(pauses, [1000, 2000], "a wait before the second and the third attempt, none after the last");
});

test("the 4xx clause, unit: a 404 is thrown on its first attempt, unchanged, and is not asked again", () => {
  const refusal = new Error("Command failed: gh api graphql\ngh: HTTP 404 (Not Found)");
  const { read, calls } = sequenced([refusal, ["never reached"]]);
  const pauses: number[] = [];
  assert.throws(() => readWithRetry(read, (ms) => pauses.push(ms)), (error: unknown) => error === refusal);
  assert.equal(calls(), 1, "one attempt");
  assert.deepEqual(pauses, [], "no wait");
});

test("a failure that carries no HTTP status is not a transient 5xx and is not retried", () => {
  const { read, calls } = sequenced([new Error("getaddrinfo ENOTFOUND api.github.com")]);
  assert.throws(() => readWithRetry(read, () => {}), /ENOTFOUND/);
  assert.equal(calls(), 1);
});

// ---- done-when 3: the switch, shipped OFF ---------------------------------------------------------------------------------------------------

test("done-when 3, the switch: `sweep.retryTransient` is OFF unless the CI environment says `1`", () => {
  assert.equal(retryTransientOn({}), false, "unset is OFF");
  assert.equal(retryTransientOn({ SWEEP_RETRY_TRANSIENT: "0" }), false);
  assert.equal(retryTransientOn({ SWEEP_RETRY_TRANSIENT: "true" }), false, "only `1` is on");
  assert.equal(retryTransientOn({ SWEEP_RETRY_TRANSIENT: "1" }), true);
});

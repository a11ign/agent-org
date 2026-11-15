// no-token: none -- every scenario runs on a fixture instance of in-memory fakes; fetch is replaced so a call that tried to leave would be counted
import { test } from "node:test";
import assert from "node:assert/strict";
import { faultInjection } from "./command.ts";
import { KEYS, runScenario, SCENARIOS, type Scenario } from "./scenarios.ts";
import { stuckOf } from "./stuck-runs.ts";

const scenarioNamed = (name: string): Scenario => SCENARIOS.find((scenario) => scenario.name === name)!;

/** `run`, with `globalThis.fetch` replaced by one that counts its calls and refuses them; it is put back however `run` ends. */
async function countingFetch<T>(run: () => Promise<T>): Promise<Readonly<{ value: T; fetches: number }>> {
  const real = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => { fetches += 1; throw new Error("the fault-injection fixture made a network call"); }) as typeof fetch;
  try {
    return { value: await run(), fetches };
  } finally {
    globalThis.fetch = real;
  }
}

/** The command's report and exit code, checked against the code it should end with and the lines its report should hold. */
function assertReport({ stdout, code }: Readonly<{ stdout: string; code: number }>, expected: number, lines: readonly RegExp[]): void {
  assert.equal(code, expected);
  for (const line of lines) assert.match(stdout, line);
}

test("the command runs the Linear 5xx and herdr-killed scenarios, both runs of each recover, it reports no stuck runs and exits 0, and no call reaches the network", async () => {
  assert.deepEqual(SCENARIOS.map(({ name }) => name), ["linear-5xx", "herdr-killed"]);
  const { value, fetches } = await countingFetch(() => faultInjection(undefined));
  assert.equal(fetches, 0, "every fake is in memory");
  assertReport(value, 0, [/^linear-5xx \(.+\): no stuck runs$/m, /^herdr-killed \(.+\): no stuck runs$/m, /^No run was left stuck with no reason shown\.$/m]);
});

test("Linear 5xx: the fault reaches the board, which says the tracker could not answer, and both runs end on their workers' outcomes once it is over", async () => {
  const result = await runScenario(scenarioNamed("linear-5xx"));
  assert.ok(result.journal.some((line) => line.includes("Linear answered 503")), "the board met the 5xx");
  assert.deepEqual(result.runs.map(({ key, status }) => [key, status]), KEYS.map((key) => [key, "checked"]));
  assert.deepEqual(stuckOf(result), []);
});

test("herdr killed: the board meets the dead server, sees the restart, starts each run again with its environment, and both end on their workers' outcomes", async () => {
  const result = await runScenario(scenarioNamed("herdr-killed"));
  assert.ok(result.journal.some((line) => line.includes("the herdr server is not running")), "the board met the dead server");
  assert.ok(KEYS.every((key) => result.journal.some((line) => line.includes(`${key} was started again`))), "each run was started again after the restart");
  assert.deepEqual(result.runs.map(({ key, status }) => [key, status]), KEYS.map((key) => [key, "checked"]));
  assert.deepEqual(stuckOf(result), []);
});

test("a run whose agent wedges after herdr's restart is listed as stuck with no reason shown, with its run log, and the command exits 1", async () => {
  const herdrKilled = scenarioNamed("herdr-killed");
  // The board's own handling is the herdr-killed scenario's; the one change is that FIX-1's worker never moves again once it is at work, and herdr goes on listing it working.
  const wedged: Scenario = {
    name: "wedged",
    faults: "FIX-1's agent wedges at work",
    inject: async (fixture, crew) => {
      await herdrKilled.inject(fixture, crew);
      // The board starts FIX-1 again in a new pane after the restart; that pane's worker wedges at once, and FIX-2's carries on.
      for (let pass = 0; pass < 6 && fixture.entry("FIX-1")?.pane === "w1:p1"; pass += 1) await fixture.pass(30_000);
      assert.notEqual(fixture.entry("FIX-1")?.pane, "w1:p1", "the board started FIX-1 again in a pane of its own");
      crew.wedge("FIX-1");
      fixture.working("FIX-1");
      crew.step();
    },
  };
  // The stuck run's log is listed from its first event.
  assertReport(await faultInjection(["wedged"], [wedged]), 1, [
    /^wedged \(FIX-1's agent wedges at work\): 1 stuck with no reason shown$/m, /^ {2}FIX-1: working, no reason shown$/m, /^ {2}FIX-2: checked: /m,
    /^ {2}run log of FIX-1:\n {4}\S+ queued/m, /^ {4}\S+ started /m, /^1 run left stuck with no reason shown\.$/m,
  ]);
});

test("a scenario the command does not know is refused by name, with the ones it knows, and nothing runs", async () => {
  const { stdout, stderr, code } = await faultInjection(["linear-5xx", "nope"]);
  assert.equal(code, 2);
  assert.equal(stdout, "");
  assert.equal(stderr, "fault-injection: no scenario named nope; the scenarios are linear-5xx, herdr-killed\n");
});

test("one scenario named runs only that one", async () => {
  const { stdout } = await faultInjection(["herdr-killed"]);
  assert.doesNotMatch(stdout, /linear-5xx/);
  assert.match(stdout, /^herdr-killed /m);
});

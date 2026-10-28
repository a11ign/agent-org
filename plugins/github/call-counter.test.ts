// no-token: none -- the counter is handed a clock and an `exec` that spawns nothing
// A11-365: the plugin counts every call it makes to GitHub, and logs the count per sweep and per minute
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakePluginDeps } from "../../src/plugins/fakes/deps.ts";
import { countingDeps, createCallCounter, kindOf, MINUTE_MS, SWEEP_MS } from "./call-counter.ts";

const START = Date.parse("2026-10-28T00:00:00Z");

/** A counter on a clock the test moves, and the lines it logs. */
function counter() {
  let now = START;
  const lines: string[] = [];
  const made = createCallCounter({ now: () => now, log: (line) => lines.push(line) });
  return { made, lines, at: (ms: number) => { now = START + ms; } };
}

test("a call is graphql, rest or cli by its arguments", () => {
  assert.equal(kindOf(["api", "graphql", "-f", "query=query { viewer { login } }"]), "graphql");
  assert.equal(kindOf(["api", "repos/a/b/pulls/3"]), "rest");
  assert.equal(kindOf(["api", "-H", "If-None-Match: \"x\"", "-i", "repos/a/b/actions/runs"]), "rest");
  assert.equal(kindOf(["pr", "list", "--repo", "a/b"]), "cli");
  assert.equal(kindOf(["run", "rerun", "5"]), "cli");
});

test("the counts are the total, the last minute's, by kind, and how many a conditional read answered as unchanged", () => {
  const { made, at } = counter();
  made.record(["api", "graphql"]);
  at(30_000);
  made.record(["api", "repos/a/b/actions/runs"]);
  made.notModified();
  made.record(["pr", "view", "3"]);
  at(70_000);
  const read = made.read();
  assert.equal(read.total, 3);
  assert.equal(read.perMinute, 2, "the first call is more than a minute old");
  assert.deepEqual(read.byKind, { graphql: 1, rest: 1, cli: 1 });
  assert.equal(read.notModified, 1);
  assert.equal(read.since, "2026-10-28T00:00:00.000Z");
});

test("a sweep is one window of calls: its count is read while it is open, kept when it closes, and logged when the next call arrives", () => {
  const { made, lines, at } = counter();
  made.record(["api", "graphql"]);
  made.record(["api", "graphql"]);
  assert.deepEqual(made.read().currentSweep, { at: "2026-10-28T00:00:00.000Z", calls: 2 });
  assert.equal(made.read().lastSweep, null);
  at(SWEEP_MS + 1);
  made.record(["api", "graphql"]);
  assert.deepEqual(made.read().lastSweep, { at: "2026-10-28T00:00:00.000Z", calls: 2 });
  assert.deepEqual(made.read().currentSweep, { at: "2026-10-28T00:00:30.001Z", calls: 1 });
  assert.deepEqual(lines, ["github: sweep of 2026-10-28T00:00:00.000Z made 2 calls"]);
});

test("a minute that passes is logged with its count when the next call arrives, and a quiet plugin logs nothing", () => {
  const { made, lines, at } = counter();
  at(10_000);
  made.record(["api", "graphql"]);
  at(MINUTE_MS + 5_000);
  assert.equal(lines.length, 0, "no timer: nothing is written until a call arrives");
  at(MINUTE_MS + 20_000);
  made.record(["api", "graphql"]);
  assert.deepEqual(lines.filter((line) => line.includes("in the last minute")), ["github: 0 calls in the last minute (1 since start, 0 answered 304)"], "the call 70 seconds ago is out of the minute that closed");
  at(MINUTE_MS + 40_000);
  made.record(["api", "graphql"]);
  at(2 * MINUTE_MS + 25_000);
  made.record(["api", "graphql"]);
  assert.deepEqual(lines.filter((line) => line.includes("in the last minute")).at(-1), "github: 1 call in the last minute (3 since start, 0 answered 304)", "the next line is a minute after the last, and counts the call 45 seconds ago and no older");
});

test("deps whose gh is counted: every gh the plugin starts is one call, sync or async, and no other program is", async () => {
  const { made } = counter();
  const seen: string[] = [];
  const base = fakePluginDeps({ exec: (file, args) => { seen.push(`${file} ${args[0]}`); return { status: 0, stdout: "", stderr: "" }; }, execAsync: (file, args) => { seen.push(`${file} ${args[0]}`); return Promise.resolve({ status: 0, stdout: "", stderr: "" }); } });
  const deps = countingDeps(base, made);
  deps.exec("gh", ["pr", "view"]);
  deps.exec("git", ["status"]);
  await deps.execAsync("gh", ["api", "graphql"]);
  await deps.execAsync("herdr", ["list"]);
  assert.deepEqual(seen, ["gh pr", "git status", "gh api", "herdr list"], "the calls reach the program as before");
  assert.deepEqual([made.read().total, made.read().byKind], [2, { graphql: 1, rest: 0, cli: 1 }]);
});

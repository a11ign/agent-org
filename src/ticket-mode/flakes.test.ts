// no-token: gh -- A11-300: the flake log in the board's state, and the tests it lists as needing a fix
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Flake, FLAKE_LIMIT, flakesPath, flakesView, flakesViewOf, readFlakes, recordFlakes } from "./flakes.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-26T12:00:00Z");
const flake = (test: string, daysAgo: number, run = `https://github.com/a11ign/agent-org/actions/runs/${daysAgo}/job/1`): Flake =>
  ({ test, check: "suite (2)", run, head: "fc707690".padEnd(40, "0"), pull: "https://github.com/a11ign/agent-org/pull/1946", at: NOW - daysAgo * DAY });

/** The flakes the log at `path` holds; a log that cannot be read fails the test. */
function held(path: string): readonly Flake[] {
  const read = readFlakes(path);
  if ("unreadable" in read) throw new Error(read.unreadable);
  return read.flakes;
}

function inState<T>(use: (path: string) => T): T {
  const stateDir = mkdtempSync(join(tmpdir(), "flakes-"));
  try {
    return use(flakesPath(stateDir));
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

test("A11-300: the flake log is flakes.json in the board's state: what is recorded is read back, and the same run, head and test is recorded once", () => {
  inState((path) => {
    assert.match(path, /\/tickets\/flakes\.json$/);
    assert.deepEqual(readFlakes(path), { flakes: [] }, "no file: no flakes");
    recordFlakes(path, [flake("a.test.ts > one", 1)], NOW);
    recordFlakes(path, [flake("a.test.ts > one", 1), flake("a.test.ts > two", 1)], NOW);
    assert.deepEqual(held(path).map(({ test }) => test), ["a.test.ts > one", "a.test.ts > two"]);
    recordFlakes(path, [flake("b.test.ts > same", 0), flake("b.test.ts > same", 0)], NOW);
    assert.equal(held(path).filter(({ test }) => test === "b.test.ts > same").length, 1, "twice in one batch is once");
  });
});

test("A11-300: a flake older than 30 days is dropped as the log is written", () => {
  inState((path) => {
    recordFlakes(path, [flake("old", 40)], NOW - 40 * DAY);
    recordFlakes(path, [flake("new", 0)], NOW);
    assert.deepEqual(held(path).map(({ test }) => test), ["new"]);
  });
});

test("A11-300: a log that is there and cannot be read is not an empty one: it is reported, nothing is written over it, and the list says why", () => {
  const unreadable: [string, () => string][] = [
    ["not JSON", () => "{ not a list"],
    ["not a list", () => JSON.stringify({ test: "a" })],
    ["a list with an entry that is no flake", () => JSON.stringify([flake("kept", 1), { test: "no run, head or time" }])],
  ];
  for (const [why, text] of unreadable) {
    inState((path) => {
      recordFlakes(path, [flake("seed", 1)], NOW);
      writeFileSync(path, text());
      const before = readFileSync(path, "utf8");
      assert.ok("unreadable" in readFlakes(path), why);
      assert.throws(() => recordFlakes(path, [flake("new", 0)], NOW), new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${why}: a new flake is refused`);
      assert.equal(readFileSync(path, "utf8"), before, `${why}: and the file is as it was, for a person to mend`);
      const view = flakesViewOf(path, NOW);
      assert.deepEqual([view.tests, typeof view.unreadable], [[], "string"], `${why}: the view says it is unreadable, not that nothing flaked`);
    });
  }
  inState((path) => {
    mkdirSync(path, { recursive: true });
    assert.match(String((readFlakes(path) as { unreadable: string }).unreadable), /cannot be read/, "a path that is no file is unreadable too, and only a missing file is empty");
    assert.equal(flakesViewOf(join(path, "absent"), NOW).unreadable, undefined, "a missing log is a log with no flakes");
  });
});

test("A11-300: a test that flakes three times in seven days is listed as needing a fix, the one that flakes most first; fewer, or older, is not", () => {
  const view = flakesView([
    flake("a.test.ts > three", 1), flake("a.test.ts > three", 3), flake("a.test.ts > three", 6),
    flake("b.test.ts > four", 0), flake("b.test.ts > four", 1), flake("b.test.ts > four", 2), flake("b.test.ts > four", 5),
    flake("c.test.ts > two", 0), flake("c.test.ts > two", 1),
    flake("d.test.ts > old", 1), flake("d.test.ts > old", 2), flake("d.test.ts > old", 8),
  ], NOW);
  assert.deepEqual([view.limit, view.days], [FLAKE_LIMIT, 7]);
  assert.deepEqual(view.tests.map(({ test, count }) => [test, count]), [["b.test.ts > four", 4], ["a.test.ts > three", 3]]);
  assert.deepEqual([view.tests[1].check, view.tests[1].last, view.tests[1].runs.length], ["suite (2)", NOW - DAY, 3]);
  assert.deepEqual(flakesView([], NOW).tests, [], "nothing recorded: nothing to fix");
});

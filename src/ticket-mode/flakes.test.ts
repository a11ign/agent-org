// no-token: gh -- A11-300: the flake log in the board's state, and the tests it lists as needing a fix
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Flake, FLAKE_LIMIT, flakesPath, flakesView, readFlakes, recordFlakes } from "./flakes.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-26T12:00:00Z");
const flake = (test: string, daysAgo: number, run = `https://github.com/a11ign/agent-org/actions/runs/${daysAgo}/job/1`): Flake =>
  ({ test, check: "suite (2)", run, head: "fc707690".padEnd(40, "0"), pull: "https://github.com/a11ign/agent-org/pull/1946", at: NOW - daysAgo * DAY });

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
    assert.deepEqual(readFlakes(path), [], "no file: no flakes");
    recordFlakes(path, [flake("a.test.ts > one", 1)], NOW);
    recordFlakes(path, [flake("a.test.ts > one", 1), flake("a.test.ts > two", 1)], NOW);
    assert.deepEqual(readFlakes(path).map(({ test }) => test), ["a.test.ts > one", "a.test.ts > two"]);
    recordFlakes(path, [flake("b.test.ts > same", 0), flake("b.test.ts > same", 0)], NOW);
    assert.equal(readFlakes(path).filter(({ test }) => test === "b.test.ts > same").length, 1, "twice in one batch is once");
  });
});

test("A11-300: a flake older than 30 days is dropped as the log is written, and a file that is not a list of flakes reads as none and is replaced", () => {
  inState((path) => {
    recordFlakes(path, [flake("old", 40)], NOW - 40 * DAY);
    recordFlakes(path, [flake("new", 0)], NOW);
    assert.deepEqual(readFlakes(path).map(({ test }) => test), ["new"]);
    writeFileSync(path, "{ not a list");
    assert.deepEqual(readFlakes(path), []);
    recordFlakes(path, [flake("again", 0)], NOW);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).map(({ test }: Flake) => test), ["again"]);
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

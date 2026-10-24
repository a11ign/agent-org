// no-token: gh -- every read here is the fake code host's, seeded from a fixture (A11-160, step 9); `org-watch`'s default `gh` is never reached
/**
 * A11-160 (step 9): THE CHAIRMAN-FACING ORG WATCH READS `main`'S COLOUR THROUGH THE CODE HOST. The watch asks three named things of it -- the page of runs of the trunk workflow on `main`, when `main`'s tip was committed, and the
 * failing log of the run a red streak began at -- and DECIDES from them: an unreadable `main`, an empty list and a list that stopped are none of them green (#912, #1154), a red streak is measured from the first failure after the
 * last success, and the first failing assertion comes from that run's own log. The argument lists those reads send are `plugins/github/rows/queue-rows.test.ts`'s.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mainColour, watchReport } from "../org-watch.ts";
import { forgetActivation, substituteCodeHost } from "../plugins/active.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";

afterEach(() => forgetActivation());

const NOW = new Date("2026-10-20T12:00:00Z");
const NO_RUN = (): string => {
  throw new Error("the fake code host acts on its own state: no run is made");
};
const REPO = "a11ign/a11ign";
/** `main`'s colour over the world, with `over` laid on the usual arguments. */
const colourOf = (over: Partial<Parameters<typeof mainColour>[0]> = {}) => mainColour({ repo: REPO, now: NOW, run: NO_RUN, ...over });
/** A colour that could not be read says so and says why: it is never the green shape. */
function assertUnread(colour: ReturnType<typeof mainColour>, why: RegExp) {
  assert.equal(colour.readable, false);
  assert.match(colour.why ?? "", why);
}
const run = (id: number, conclusion: string | null, createdAt: string) => ({ id, conclusion, created_at: createdAt, status: conclusion === null ? "in_progress" : "completed" });
/** The trunk's runs, newest first, as the code host lists them, and when `main`'s tip was committed. */
function trunkWorld(runs: ReturnType<typeof run>[], tipCommittedAt: string | null = "2026-10-20T10:30:00Z") {
  const host = createFakeCodeHost();
  host.rowsWorld.trunkRuns = runs;
  host.rowsWorld.mainTip = tipCommittedAt;
  substituteCodeHost(host);
  return host.rowsWorld;
}

test("a red streak is measured from the FIRST failure after the last success, and names the first failing assertion of that run's own log", () => {
  const world = trunkWorld([run(3, "failure", "2026-10-20T10:00:00Z"), run(2, "failure", "2026-10-20T09:00:00Z"), run(1, "success", "2026-10-20T08:00:00Z")]);
  world.ci.logs.set("2", "gate\tstep\t2026-10-20T09:00:01Z not ok 7 - the quickstart is one a stranger can paste\n");
  const colour = colourOf();
  assert.equal(colour.readable, true);
  assert.equal(colour.red, true);
  assert.equal(colour.since, "2026-10-20T09:00:00Z", "the older failure began the streak, not the newest");
  assert.equal(colour.hours, 3);
  assert.equal(colour.firstFailing, "not ok 7 - the quickstart is one a stranger can paste", "the log is the run the streak began at");
  assert.match(watchReport({ colour }).join("\n"), /MAIN IS RED for 3h since 2026-10-20T09:00:00Z -- not ok 7 - the quickstart/);
});

test("a log that cannot be read leaves the assertion unnamed, and the report says so rather than naming the job", () => {
  const world = trunkWorld([run(2, "failure", "2026-10-20T09:00:00Z"), run(1, "success", "2026-10-20T08:00:00Z")]);
  world.failures.set("failedLogOfRun", new Error("HTTP 502"));
  const colour = colourOf();
  assert.equal(colour.red, true, "POSITIVE CONTROL: the streak is still read");
  assert.equal(colour.firstFailing, null);
  assert.match(watchReport({ colour }).join("\n"), /the failing log named no assertion/);
});

test("a green main is read and silent: the newest completed run decides, and a run still going is reported beside it, not instead of it", () => {
  trunkWorld([run(3, null, "2026-10-20T11:00:00Z"), run(2, "success", "2026-10-20T10:00:00Z"), run(1, "failure", "2026-10-20T09:00:00Z")]);
  const colour = colourOf();
  assert.deepEqual([colour.readable, colour.red, colour.inFlight], [true, false, 1]);
  assert.deepEqual(watchReport({ colour }), [], "silent when clean");
});

test("#912 an unreadable main is NOT a green one, and says why", () => {
  const world = trunkWorld([run(2, "success", "2026-10-20T09:00:00Z")]);
  world.failures.set("workflowRunsOnMain", new Error("gh: HTTP 502"));
  const colour = colourOf();
  assertUnread(colour, /could not read trunk's runs: gh: HTTP 502/);
  assert.match(watchReport({ colour })[0], /^CANNOT ASK: main's colour is unknown/);
});

test("#912 an EMPTY run list is not a green main either", () => {
  trunkWorld([]);
  assertUnread(colourOf(), /trunk reports no runs on main at all/);
});

test("#1154 a run list that STOPPED -- main's tip is more than two hours past the newest run -- is not a green main, and a tip that cannot be read does not make it one", () => {
  const world = trunkWorld([run(1, "success", "2026-10-20T06:00:00Z")], "2026-10-20T10:00:00Z");
  assertUnread(colourOf(), /older than main's own tip commit/);
  world.failures.set("mainTipDateOf", new Error("HTTP 502"));
  const { readable, red } = colourOf();
  assert.deepEqual([readable, red], [true, false], "no tip to compare with: the guard declines to speak and the run list is used as it stands");
});

test("a workflow other than `trunk` is read by its own file name", () => {
  const world = trunkWorld([]);
  world.tail.queue.runsOnMain.set("ci.yml", [run(1, "failure", "2026-10-20T09:00:00Z")]);
  assert.equal(colourOf({ workflow: "ci" }).red, true);
  assert.equal(colourOf().readable, false, "the trunk workflow has no runs: the world is not one list for every workflow");
});

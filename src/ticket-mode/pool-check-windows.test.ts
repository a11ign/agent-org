// no-token: gh -- herdr, git, the tracker, the clock and the restart reads are all injected; nothing is spawned
// A11-361: a check about a delay after release is not run before its window ends, a check this host cannot run is parked and its missing capability filed once; A11-302: the board starts a verifier run for an `agent` check once its change is installed, closes the check with the run's result and files a failure's follow-up, and a one-time pass gives the checks a session ran a runner of the org's
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterMergeChecksPath, loadChecks, saveChecks } from "./after-merge/store.ts";
import type { CheckRecord } from "./after-merge/checks.ts";
import { CHECK_RUNNERS, parkCheck } from "./after-merge/capability.ts";
import { MAX_BOARD_CHECK_RUNS, MAX_RUN_TRIES, MIGRATION_BATCH } from "./after-merge/verify.ts";
import { herdrName } from "./pool.ts";
import { poolFixture } from "./pool-fixture.ts";
import { writersViewOf } from "./read-routes.ts";
import { writerDir } from "./ticket-paths.ts";
import type { Queue } from "./queue/queue-entries-and-outcomes.ts";
import type { RunEvent } from "./queue/run-log.ts";

const HOUR = 60 * 60_000;
const LINE = "On the agents host after the release, the doctor shows one version.";
const EVIDENCE = "run the doctor on the host and quote the version line";

const settledAll = async (): Promise<void> => { for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

const check = (id: string, over: Partial<CheckRecord> = {}): CheckRecord => ({
  id, key: id.split("#")[0], url: `https://linear.app/a11ign/issue/${id.split("#")[0]}`, line: LINE, owner: null, runner: "agent", evidence: EVIDENCE, listedAt: 1_000, state: "open", ...over,
});

/** A pool over fakes whose clock `clock.at` the test moves, whose host names a ticket writer, and whose checks file holds `checks`; the queue's run log says which pull requests merged. */
function world(checks: readonly CheckRecord[], { writer = true, merged = {} }: { writer?: boolean; merged?: Record<string, readonly RunEvent[]> } = {}) {
  const clock = { at: 10 * HOUR };
  const made = poolFixture({ keys: [], max: 3, now: () => clock.at, tickets: writer ? { writer: { run: "Run the a11ign:create-ticket skill for this request: {request}, in {dir}." } } : {} });
  const path = afterMergeChecksPath(made.settings.stateDir);
  saveChecks(path, { checks: Object.fromEntries(checks.map((one) => [one.id, one])) });
  made.store.set({ ...made.store.get(), runLog: merged });
  const writers = () => made.store.get().writers ?? [];
  const run = (id: string) => writers().find((one) => one.id === id)!;
  const sweep = async () => { await made.pool.refreshTracker(); await settledAll(); };
  const tick = async () => { await made.pool.tick(); await settledAll(); };
  const dirOf = (id: string) => writerDir(made.settings, id);
  /** The agent of run `id` writes `outcome` and goes idle, and the pool reads it. */
  const answers = async (id: string, outcome: Record<string, unknown>) => {
    writeFileSync(join(dirOf(id), "outcome.json"), JSON.stringify(outcome));
    made.status.set(herdrName(`writer-${id}`), "working");
    await tick();
    made.status.set(herdrName(`writer-${id}`), "idle");
    await tick();
  };
  return { ...made, clock, path, writers, run, sweep, tick, dirOf, answers, checks: () => loadChecks(path).checks };
}

/** A sweep and a tick on a world holding one installed agent check: the id of the verifier run that started for it. */
async function startVerifier(board: ReturnType<typeof world>): Promise<string> {
  await board.sweep();
  await board.tick();
  return board.writers()[0].id;
}

/** A sweep and a tick on a world with several installed agent checks: the runs the board started for them. */
async function startedRuns(board: ReturnType<typeof world>) {
  await board.sweep();
  await board.tick();
  return board.writers();
}

const MERGED_AT = 10 * HOUR - 2 * HOUR;
const mergedOther = (key: string): Record<string, readonly RunEvent[]> => ({ [key]: [{ kind: "merged", url: "https://github.com/a11ign/control/pull/9", at: MERGED_AT }] });
const DAY = 24 * HOUR;
const WEEK_LINE = "Runner: board. Observe: the run log's stale-block notes. Pass: no stale-block note over 7 days.";

const quickRequests = (board: ReturnType<typeof world>) => board.writers().filter((one) => one.mode === "quick");

test("A11-361: a check that waits 7 days after release is scheduled for release + 7 days and is given to no verifier run before then, so it never files a re-run chore", async () => {
  const board = world([check("A11-352#1", { line: WEEK_LINE })], { merged: mergedOther("A11-352") });
  await board.sweep();
  const due = board.checks()["A11-352#1"].dueAt;
  assert.equal(due, 10 * HOUR + 7 * DAY, "installed now (its change merged 2 hours ago), so due 7 days from now");
  assert.deepEqual(board.writers(), [], "no verifier run starts on the day it closed");
  board.clock.at = due! - 1;
  await board.sweep();
  assert.deepEqual(board.writers(), [], "nor a minute before day 7");
  assert.equal(board.checks()["A11-352#1"].state, "open", "waiting is not failing");
  board.clock.at = due!;
  await board.sweep();
  assert.deepEqual(board.writers().map(({ mode, checks }) => [mode, checks]), [["verify", ["A11-352#1"]]], "at day 7 the run starts");
  assert.deepEqual(quickRequests(board), []);
});

test("A11-361: a check whose change is not installed has no due time, and its window begins when it is installed", async () => {
  const board = world([check("A11-352#1", { line: WEEK_LINE })], { merged: { "A11-352": [{ kind: "merged", url: "https://github.com/a11ign/control/pull/9", at: 10 * HOUR - 5 * 60_000 }] } });
  await board.sweep();
  assert.equal(board.checks()["A11-352#1"].dueAt, undefined);
  board.clock.at += 2 * HOUR;
  await board.sweep();
  assert.equal(board.checks()["A11-352#1"].dueAt, 12 * HOUR + 7 * DAY);
});

test("A11-361: a check the plan gives a Window is held for it, whatever its line says", async () => {
  const board = world([check("A11-310#1", { windowMs: 3 * DAY })], { merged: mergedOther("A11-310") });
  await board.sweep();
  assert.deepEqual([board.checks()["A11-310#1"].dueAt, board.writers().length], [10 * HOUR + 3 * DAY, 0]);
});

test("A11-361: a check that failed on 2026-10-27 only because its week had not passed is opened again, scheduled, and its follow-up is not filed", async () => {
  const closed = check("A11-352#1", { line: WEEK_LINE, listedAt: 9 * HOUR, state: "failed", result: "Cannot be observed yet: the 7-day window has not elapsed", closedBy: "agent", closedAt: 9 * HOUR + 17 * 60_000, posted: true, verifier: { run: "c1", tries: 1 } });
  const board = world([closed], { merged: mergedOther("A11-352") });
  await board.sweep();
  const after = board.checks()["A11-352#1"];
  assert.deepEqual([after.state, after.dueAt, after.result, after.closedBy, after.posted, after.verifier], ["open", 9 * HOUR + 17 * 60_000 + 7 * DAY, undefined, undefined, undefined, undefined]);
  assert.deepEqual(board.writers(), [], "no follow-up is filed for it and no run starts");
});

test("A11-361: a board check handed to an agent after its own week is not held another week by its line", async () => {
  const watched = { spec: { kind: "run-log" as const, event: "finished" as const, pass: "present" as const, windowMs: 7 * DAY }, from: 0, began: 0 };
  const board = world([check("A11-294#1", { line: "For a week, a run finishes.", observe: watched, handedOff: "the window of 7 d closed and the board did not see it" })], { merged: mergedOther("A11-294") });
  await board.sweep();
  assert.deepEqual([board.checks()["A11-294#1"].dueAt, board.writers().map(({ mode }) => mode)], [undefined, ["verify"]]);
});

test("A11-361: a failure after its window stays failed", async () => {
  const closed = check("A11-352#1", { line: WEEK_LINE, listedAt: 0, state: "failed", result: "a stale-block note on A11-9", closedBy: "agent", closedAt: 8 * DAY, followUp: "f1" });
  const board = world([closed]);
  board.clock.at = 9 * DAY;
  await board.sweep();
  assert.equal(board.checks()["A11-352#1"].state, "failed");
});

test("A11-361: a verifier run that cannot run the check here parks it open, fails nothing and files no ticket for the check", async () => {
  const board = world([check("A11-314#1")], { merged: mergedOther("A11-314") });
  await board.answers(await startVerifier(board), { kind: "cannot-run-here", needs: "Chairman Mac", evidence: "the check opens the app on the chairman's Mac, which this host lacks" });
  const parked = board.checks()["A11-314#1"];
  assert.deepEqual([parked.state, parked.result, parked.needs?.capability, parked.verifier?.run], ["open", undefined, "chairman-mac", null]);
  await board.sweep();
  const requests = quickRequests(board);
  assert.equal(requests.length, 1, "one ticket, for the missing capability");
  assert.match(requests[0].request, /^Runner needed: chairman-mac\./);
  assert.doesNotMatch(requests[0].request, /Follow-up to/);
  assert.equal(board.checks()["A11-314#1"].needs?.request, requests[0].id);
  assert.deepEqual(board.writers().filter((one) => one.mode === "verify" && one.phase !== "finished"), [], "and it is not given to another run");
});

test("A11-361: six checks that need two missing capabilities file two tickets, not six, and a later check for a filed capability files none", async () => {
  const ids = ["A11-314", "A11-320", "A11-325", "A11-327", "A11-329", "A11-308"];
  const board = world(ids.map((key) => check(`${key}#1`)), { merged: Object.assign({}, ...ids.map(mergedOther)) });
  const parked = { run: null, tries: 1 };
  const needs = (capability: string) => ({ capability, why: "this host lacks it" });
  saveChecks(board.path, { checks: Object.fromEntries(ids.map((key, at) => [`${key}#1`, check(`${key}#1`, { verifier: parked, needs: needs(at < 4 ? "chairman-mac" : "board-key") })])) });
  await board.sweep();
  assert.deepEqual(quickRequests(board).map(({ request }) => request.split("\n")[0]).sort(), ["Runner needed: board-key.", "Runner needed: chairman-mac."]);
  await board.sweep();
  assert.equal(quickRequests(board).length, 2, "filed once");
  saveChecks(board.path, parkCheck({ checks: { ...board.checks(), "A11-340#1": check("A11-340#1", { verifier: { run: "c9", tries: 1 } }) } }, "A11-340#1", "board-key", "this host lacks it"));
  await board.sweep();
  assert.equal(quickRequests(board).length, 2, "a later check for the same capability files none");
  assert.ok(Object.values(board.checks()).every((one) => one.state === "open" && one.needs?.request !== undefined));
});

/** Run `body` with a runner that has `chairman-mac` registered, and take it away again. */
async function withMacRunner(body: () => Promise<void>): Promise<void> {
  CHECK_RUNNERS.push({ name: "mac-runner", has: ["chairman-mac"] });
  try {
    await body();
  } finally {
    CHECK_RUNNERS.length = 0;
  }
}

test("A11-361: a parked check whose capability a runner now has is routed to it and given to a verifier run, and files no ticket", async () => {
  await withMacRunner(async () => {
    const board = world([check("A11-314#1", { verifier: { run: null, tries: 1 }, needs: { capability: "chairman-mac", why: "opens the app" } })], { merged: mergedOther("A11-314") });
    await board.sweep();
    assert.equal(board.checks()["A11-314#1"].needs?.routedTo, "mac-runner");
    assert.deepEqual(board.writers().map(({ mode, checks }) => [mode, checks]), [["verify", ["A11-314#1"]]], "the routed check is queued, not left parked");
    assert.equal(board.checks()["A11-314#1"].verifier?.tries, 2);
    await board.tick();
    assert.match(readFileSync(join(board.dirOf(board.writers()[0].id), "brief.md"), "utf8"), /Routed to you:.*chairman-mac.*mac-runner/);
  });
});

test("A11-361: a routed check whose run cannot run it either is not queued again once its tries are spent", async () => {
  await withMacRunner(async () => {
    const board = world([check("A11-314#1", { verifier: { run: null, tries: 2 }, needs: { capability: "chairman-mac", why: "opens the app" } })], { merged: mergedOther("A11-314") });
    await board.sweep();
    assert.deepEqual([board.writers(), board.checks()["A11-314#1"].state], [[], "open"]);
  });
});

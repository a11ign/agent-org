// no-token: none -- pure transitions over a queue a test writes out
// A11-261: what the board keeps of each ticket's CI: a completed run is settled and never read again, a re-run is read afresh, and the record outlives the entry it was read for.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { BranchCiRun } from "../../plugins/contracts/code-host.ts";
import { enqueue, type Queue } from "../queue/queue-entries-and-outcomes.ts";
import { emptyQueue, loadQueue, saveQueue } from "../queue.ts";
import type { Ticket } from "../source.ts";
import { mergedRuns, GONE_TICKETS_MAX, recordBudgetStep, recordRuns, runsOf, settledIds } from "./store.ts";
import { tmpDir } from "../../lib/tmp-fixture.ts";
import { join } from "node:path";

const ticket = (key: string) => ({ key, title: key, description: "", url: `https://linear.app/x/${key}`, branch: key.toLowerCase(), status: "Backlog", statusOrder: 0, team: "NBF", project: null, priority: 0 }) as Ticket;
const job = { labels: ["ubuntu-latest"], startedAt: "2026-10-25T10:00:00Z", completedAt: "2026-10-25T10:01:00Z" };
const run = (id: number, status: BranchCiRun["status"], jobs: BranchCiRun["jobs"] = [job]): BranchCiRun => ({ id, headSha: `sha-${id}`, createdAt: "2026-10-25T10:00:00Z", status, jobs });
const queued = (...keys: string[]) => enqueue(emptyQueue(3), keys.map(ticket), { model: "sonnet", effort: "high" }, 0, null);

test("A11-261: runs read are recorded by ticket, and only a completed run is settled", () => {
  const queue = recordRuns(queued("NBF-1"), "NBF-1", [run(2, "in_progress"), run(1, "completed")], 10);
  assert.deepEqual(runsOf(queue, "NBF-1").map(({ id }) => id).sort(), [1, 2]);
  assert.deepEqual([...settledIds(queue, "NBF-1")], [1]);
  assert.deepEqual([...settledIds(queue, "NBF-2")], [], "a ticket nothing was read for has none");
  assert.deepEqual(runsOf(queue, "NBF-2"), []);
});

test("A11-261: a run read as settled (no jobs) keeps the jobs the board holds; one read with jobs replaces what it held", () => {
  const held = { 1: run(1, "completed"), 2: run(2, "in_progress", []) };
  const merged = mergedRuns(held, [run(1, "completed", []), run(2, "completed", [job, job])]);
  assert.equal(merged[1]!.jobs.length, 1, "the settled run's jobs are kept");
  assert.equal(merged[2]!.jobs.length, 2, "the run that finished since is read afresh");
});

test("A11-261: a settled run that is running again (a re-run) keeps its old jobs but is no longer settled, so its new attempt is read next time", () => {
  const queue = recordRuns(recordRuns(queued("NBF-1"), "NBF-1", [run(1, "completed")], 10), "NBF-1", [run(1, "in_progress", [])], 20);
  assert.equal(runsOf(queue, "NBF-1")[0]!.jobs.length, 1);
  assert.equal(runsOf(queue, "NBF-1")[0]!.status, "in_progress");
  assert.deepEqual([...settledIds(queue, "NBF-1")], []);
});

test("A11-261: a run the read no longer lists stays: the ticket's total never falls because the host's list was cut", () => {
  const queue = recordRuns(recordRuns(queued("NBF-1"), "NBF-1", [run(1, "completed"), run(2, "completed")], 10), "NBF-1", [run(2, "completed", [])], 20);
  assert.deepEqual(runsOf(queue, "NBF-1").map(({ id }) => id).sort(), [1, 2]);
});

test("A11-261: the warning and the hold are recorded on the ticket; the warning is kept when the hold is recorded after it", () => {
  const read = recordRuns(queued("NBF-1"), "NBF-1", [run(1, "completed")], 10);
  const warned = recordBudgetStep(read, "NBF-1", { warned: 310 });
  assert.deepEqual([warned.ciSpend!["NBF-1"]!.warned, warned.ciSpend!["NBF-1"]!.held], [310, undefined]);
  const held = recordBudgetStep(warned, "NBF-1", { warned: 640, held: 2 });
  assert.deepEqual([held.ciSpend!["NBF-1"]!.warned, held.ciSpend!["NBF-1"]!.held], [310, 2], "the first warning stands");
  assert.equal(recordBudgetStep(queued("NBF-1"), "NBF-1", { warned: 1 }).ciSpend, undefined, "a ticket nothing was read for records nothing");
});

test("A11-261: a ticket's record outlives its entry, and the records of tickets no longer on the queue are cut to the most recently read", () => {
  let queue = queued("NBF-1");
  queue = recordRuns(queue, "NBF-1", [run(1, "completed")], 1);
  const dismissed: Queue = { ...queue, entries: [] };
  assert.equal(runsOf(dismissed, "NBF-1").length, 1, "dismissing the entry keeps the ticket's CI");
  let gone: Queue = dismissed;
  for (let n = 0; n < GONE_TICKETS_MAX + 5; n++) gone = recordRuns(gone, `OLD-${n}`, [run(n, "completed")], 100 + n);
  assert.equal(Object.keys(gone.ciSpend!).length, GONE_TICKETS_MAX);
  assert.ok(!("NBF-1" in gone.ciSpend!), "the least recently read is dropped");
  assert.ok(`OLD-${GONE_TICKETS_MAX + 4}` in gone.ciSpend!, "the most recent is kept");
  const onQueue = recordRuns(queued("NBF-1"), "NBF-1", [run(1, "completed")], 1);
  const still = Object.keys(recordRuns({ ...onQueue, ciSpend: Object.fromEntries(Array.from({ length: GONE_TICKETS_MAX + 5 }, (_, n) => [`OLD-${n}`, { runs: {}, readAt: n }])) }, "NBF-1", [], 2).ciSpend!);
  assert.ok(still.includes("NBF-1"), "a ticket still on the queue is never cut");
});

test("A11-261: the record is saved with the queue and read back from it", () => {
  const path = join(tmpDir("ci-store-"), "queue.json");
  saveQueue(path, recordBudgetStep(recordRuns(queued("NBF-1"), "NBF-1", [run(1, "completed")], 10), "NBF-1", { warned: 5, held: 2 }));
  const loaded = loadQueue(path, 3);
  assert.deepEqual(runsOf(loaded, "NBF-1").map(({ id }) => id), [1]);
  assert.deepEqual([loaded.ciSpend!["NBF-1"]!.warned, loaded.ciSpend!["NBF-1"]!.held], [5, 2]);
});

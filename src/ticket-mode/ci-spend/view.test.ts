// no-token: none -- pure view over a queue a test writes out
// A11-261: a run's CI as the page is sent it.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { BranchCiRun } from "../../plugins/contracts/code-host.ts";
import { enqueue, find } from "../queue/queue-entries-and-outcomes.ts";
import { emptyQueue } from "../queue.ts";
import type { Ticket } from "../source.ts";
import { recordRuns } from "./store.ts";
import { ciSinceOf, ciViewOf } from "./view.ts";

const ticket = (key: string) => ({ key, title: key, description: "", url: `https://linear.app/x/${key}`, branch: key.toLowerCase(), status: "Backlog", statusOrder: 0, team: "NBF", project: null, priority: 0 }) as Ticket;
const job = (labels: string[], minutes: number) => ({ labels, startedAt: "2026-10-25T10:00:00Z", completedAt: new Date(Date.parse("2026-10-25T10:00:00Z") + minutes * 60_000).toISOString() });
const run = (id: number, createdAt: string, jobs: BranchCiRun["jobs"]): BranchCiRun => ({ id, headSha: `head-${id}`, createdAt, status: "completed", jobs });
const SINCE = Date.parse("2026-10-25T11:00:00Z");

const queue = recordRuns(enqueue(emptyQueue(3), [ticket("NBF-1")], { model: "sonnet", effort: "high" }, 0, null), "NBF-1",
  [run(1, "2026-10-25T09:00:00Z", [job(["macos-14"], 2)]), run(2, "2026-10-25T11:30:00Z", [job(["ubuntu-latest"], 4)])], 1);

test("A11-261: the run's figures count from its first start and the ticket's count every push, against the budget", () => {
  const entry = { ...find(queue, "NBF-1")!, ciSince: SINCE };
  assert.deepEqual(ciViewOf(queue, entry, 300), { run: { pushes: 1, jobs: 1, weighted: 4 }, ticket: { pushes: 2, jobs: 2, weighted: 24 }, budget: 300, state: "ok" });
  assert.deepEqual([ciViewOf(queue, entry, 20)?.state, ciViewOf(queue, entry, 12)?.state, ciViewOf(queue, entry, 0)?.state], ["over", "held", "ok"], "24 against 20, against 12, and against none");
});

test("A11-261: a ticket the board has read no workflow run of has no figures", () => {
  assert.equal(ciViewOf(emptyQueue(3), { ...find(queue, "NBF-1")! }, 300), undefined);
});

test("A11-261: a run that started before the board recorded its first start is counted from its latest start", () => {
  const entry = find(queue, "NBF-1")!;
  assert.equal(ciSinceOf({ ...entry, ciSince: undefined, startedAt: 7 }), 7);
  assert.equal(ciSinceOf({ ...entry, ciSince: 3, startedAt: 7 }), 3);
  assert.equal(ciSinceOf({ ...entry, ciSince: undefined, startedAt: undefined }), Number.POSITIVE_INFINITY, "a run that has not started counts nothing as its own yet");
  assert.deepEqual(ciViewOf(queue, { ...entry, ciSince: undefined, startedAt: undefined }, 300)?.run, { pushes: 0, jobs: 0, weighted: 0 });
});

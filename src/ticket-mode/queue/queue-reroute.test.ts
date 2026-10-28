// no-token: gh -- pure transitions over an in-memory queue
// A11-355: a run that ended `wrong-repo` naming a repository of the organisation is queued again there, and Retry says why it cannot act
import { test } from "node:test";
import assert from "node:assert/strict";
import { enqueue, retry, type Entry, type Outcome, type Queue } from "./queue-entries-and-outcomes.ts";
import { reroute } from "./queue-reroute.ts";
import { retryRefusal } from "./queue-retry-refusal.ts";
import { finish, markRunning, markStarting, park, resumeQueue } from "./queue-transitions.ts";
import { logOf } from "./run-log.ts";
import { emptyQueue } from "../queue.ts";
import type { Ticket } from "../source.ts";

const ticket = (key: string) => ({ key, title: key, description: "", url: "", branch: key.toLowerCase(), status: "Backlog", statusOrder: 0, team: "NBF", project: null, priority: 0 }) as Ticket;
const choice = { model: "opus", effort: "high" };
const wrong: Outcome = { kind: "wrong-repo", where: "acme/corpus: the code lives there" };
const runningA = () => markRunning(markStarting(resumeQueue(enqueue(emptyQueue(2), [ticket("A")], choice, 1)), "A", 2), "A", "w1", "w1:p1");
const entry = (queue: Queue, key = "A"): Entry => queue.entries.find((e) => e.ticket.key === key)!;

test("a run moved to the repository its worker named is queued again at once, planned for it, with its ending and its move on the log and no Needs-you event", () => {
  const queue = reroute(runningA(), "A", { outcome: wrong, repo: "corpus" }, 9);
  assert.deepEqual([entry(queue).phase, entry(queue).plannedRepo, entry(queue).outcome, entry(queue).workspace, entry(queue).queuedAt], ["queued", "corpus", undefined, undefined, 9]);
  assert.deepEqual(logOf(queue, "A").filter((event) => event.kind === "finished" || event.kind === "requeued" || event.kind === "needs-you").map((event) => event.kind === "requeued" ? `requeued ${event.why}` : event.kind === "finished" ? `finished ${event.outcome}` : event.kind),
    ["finished wrong-repo", "requeued rerouted"]);
});

test("retryRefusal names why a run cannot be retried, and null for one that can", () => {
  const queued = resumeQueue(enqueue(emptyQueue(2), [ticket("A")], choice, 1));
  assert.equal(retryRefusal(entry(queued)), "A is queued, not finished");
  assert.equal(retryRefusal(entry(runningA())), "A is still running, not finished");
  assert.equal(retryRefusal(entry(finish(runningA(), "A", { kind: "ready-pr", prs: [{ repo: "r", url: "u" }] }, 5))), "A ended with its result, ready-pr: retried, it would only make its pull requests again");
  assert.equal(retryRefusal(entry(finish(runningA(), "A", { kind: "checked", reason: "x" }, 5))), "A concluded (checked) with nothing more to do");
  assert.equal(retryRefusal(entry(park(runningA(), "A", wrong, 5))), "A still holds its workspace: close it first", "a wrong-repo run keeps its workspace until it is closed");
  assert.equal(retryRefusal(entry(finish(runningA(), "A", wrong, 5))), null);
  assert.equal(retryRefusal(entry(finish(runningA(), "A", { kind: "crashed", reason: "x" }, 5))), null);
});

test("retry still changes nothing for the runs retryRefusal refuses", () => {
  for (const queue of [runningA(), park(runningA(), "A", wrong, 5), finish(runningA(), "A", { kind: "checked", reason: "x" }, 5)]) assert.equal(retry(queue, "A", 9), queue);
});

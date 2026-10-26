// no-token: none -- queues built with the board's own transitions
// A11-298: the board records which ticket a queued run waits on and since when, and writes it only when that changes
import { test } from "node:test";
import assert from "node:assert/strict";
import { ticketOf } from "../kept-pulls-fixture.ts";
import { emptyQueue } from "../queue.ts";
import { enqueue, find, replace, type Queue } from "./queue-entries-and-outcomes.ts";
import { recordWaits } from "./queue-long-waits.ts";
import { markRunning, markStarting, recordPaths, resumeQueue } from "./queue-transitions.ts";

const FILES = ["lab:middleware/package.json"];

/** A11-196 running on the middleware files and A11-200 queued behind them. */
function holderAndWaiter(): Queue {
  const queued = recordPaths(resumeQueue(enqueue(emptyQueue(3), [ticketOf("A11-196"), ticketOf("A11-200")], { model: "sonnet", effort: "high" }, 1)), new Map([["A11-196", FILES], ["A11-200", FILES]]));
  return markRunning(markStarting(queued, "A11-196", 2), "A11-196", "w1", "w1:p1");
}

test("A11-298: a queued run that waits on a ticket keeps the time it began to wait on that one, and nothing is written when nothing changed", () => {
  const first = recordWaits(holderAndWaiter(), 1000);
  assert.deepEqual(find(first, "A11-200")?.waitSince, { on: "A11-196", since: 1000 });
  assert.equal(find(first, "A11-196")?.waitSince, undefined, "a running run waits on nothing");
  assert.equal(recordWaits(first, 9000), first, "the same queue back: the pass writes nothing");
});

test("A11-298: a run that now waits on another ticket begins again, and one that waits on nothing has no record", () => {
  const first = recordWaits(holderAndWaiter(), 1000);
  const moved = replace(first, "A11-200", (entry) => ({ ...entry, waitSince: { on: "A11-999", since: 1 } }));
  assert.deepEqual(find(recordWaits(moved, 5000), "A11-200")?.waitSince, { on: "A11-196", since: 5000 });
  const freed = replace(first, "A11-196", (entry) => ({ ...entry, phase: "finished" as const, outcome: { kind: "checked" as const, reason: "x" } }));
  assert.equal(find(recordWaits(freed, 6000), "A11-200")?.waitSince, undefined);
});

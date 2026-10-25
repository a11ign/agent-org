// no-token: gh -- pure queue transition
// A11-272, step 3: the queue's record of the blockers a plan named.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeTicket } from "../../plugins/fakes/tracker.ts";
import { emptyQueue } from "../queue.ts";
import { enqueue } from "./queue-entries-and-outcomes.ts";
import { recordPlanBlockers } from "./queue-plan-blockers.ts";
import { resumeQueue } from "./queue-transitions.ts";

const queue = resumeQueue(enqueue(emptyQueue(1), [fakeTicket("NBF-1")], { model: "sonnet", effort: "high" }, 0));

test("A11-272: recording a plan's blockers drops the entry's read blockers and sets its waitMerged; no keys change nothing", () => {
  assert.equal(recordPlanBlockers(queue, "NBF-1", []), queue);
  const read = { ...queue, entries: queue.entries.map((entry) => ({ ...entry, blockers: [] })) };
  const [after] = recordPlanBlockers(read, "NBF-1", ["NBF-2", "NBF-9"]).entries;
  assert.equal(after.blockers, undefined);
  assert.deepEqual(after.waitMerged, ["NBF-2", "NBF-9"]);
});
